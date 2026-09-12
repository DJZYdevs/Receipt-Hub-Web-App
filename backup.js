/* ============================================================
   BACKUP — full-state backup to Google Drive.

   v2 change (after the v1.17→1.18 silent-failure incident): a failed
   auto-backup used to only log to console — invisible to the user.
   Safari blocks the silent cross-site re-auth Google's token client
   relies on (especially in standalone/home-screen mode), so after the
   first manual connect, every silent daily/import backup was failing
   quietly. Now a failure sets a visible, sticky warning until the
   user reconnects — it never fails silently again.

   Why this exists: the app's built-in Export only ever wrote out
   `receipts` (from IndexedDB). category_usage and known_merchants
   live separately in localStorage and were never included — that
   gap is what caused the v1.16/1.17 data loss (categories reset,
   known-merchant matching cleared). This module backs up EVERYTHING
   needed to fully restore your state, not just receipts.

   ---------------------------------------------------------------
   ONE-TIME SETUP REQUIRED (you must do this — Claude can't create
   Google credentials on your behalf):
   1. Go to https://console.cloud.google.com/ → create a project
      (or use an existing one).
   2. APIs & Services → Library → enable the "Google Drive API".
   3. APIs & Services → Credentials → Create Credentials →
      OAuth client ID → Application type: "Web application".
      Under "Authorized JavaScript origins" add your GitHub Pages
      URL exactly, e.g. https://djzydevs.github.io
      (no trailing slash, no path).
   4. Copy the generated Client ID and paste it below as
      GOOGLE_CLIENT_ID.
   5. APIs & Services → OAuth consent screen → Audience →
      add your own Google account under "Test users" (required
      since this app won't be Google-verified — test mode is fine
      for personal use).
   ---------------------------------------------------------------
   Until GOOGLE_CLIENT_ID is filled in, backup/restore quietly does
   nothing — the rest of the app is unaffected.
   ============================================================ */

const GOOGLE_CLIENT_ID = '259379633108-o2p7ntpli67svraqc1p7rig6ju9o94di.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FOLDER_NAME = 'Ledgr Backups';

function driveConfigured(){
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID.indexOf('PASTE_YOUR') !== 0;
}

let driveTokenClient = null;
let driveAccessToken = null;
let driveTokenExpiry = 0;

function initDriveTokenClient(){
  if(!window.google || !google.accounts || !google.accounts.oauth2) return null;
  if(!driveTokenClient){
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: ()=>{}, // overridden per-request below
    });
  }
  return driveTokenClient;
}

function getDriveAccessToken(interactive){
  return new Promise((resolve, reject)=>{
    const client = initDriveTokenClient();
    if(!client){ reject(new Error('Google Identity Services not loaded yet')); return; }
    if(driveAccessToken && Date.now() < driveTokenExpiry - 60000){
      resolve(driveAccessToken); return;
    }
    client.callback = (resp)=>{
      if(resp.error){ reject(resp); return; }
      driveAccessToken = resp.access_token;
      driveTokenExpiry = Date.now() + (resp.expires_in*1000);
      resolve(driveAccessToken);
    };
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

async function findOrCreateBackupFolder(token){
  const cachedId = localStorage.getItem(userKey('drive_backup_folder_id'));
  if(cachedId) return cachedId;
  const q = encodeURIComponent(`name='${BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}`, {
    headers:{ Authorization:`Bearer ${token}` },
  });
  const searchData = await searchRes.json();
  if(searchData.files && searchData.files.length > 0){
    localStorage.setItem(userKey('drive_backup_folder_id'), searchData.files[0].id);
    return searchData.files[0].id;
  }
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType:'application/vnd.google-apps.folder' }),
  });
  const created = await createRes.json();
  localStorage.setItem(userKey('drive_backup_folder_id'), created.id);
  return created.id;
}

async function collectFullBackupPayload(){
  return {
    backupVersion: 1,
    appVersion: APP_VERSION,
    user: currentUser,
    exportedAt: new Date().toISOString(),
    receipts,
    customFolders,
    receiptSeq,
    activeFolderId,
    categories: CATEGORIES,
    categoryUsage: getCategoryUsage(),
    knownMerchants: getKnownMerchants(),
  };
}

async function uploadBackupToDrive(interactive){
  const token = await getDriveAccessToken(interactive);
  const folderId = await findOrCreateBackupFolder(token);
  const payload = await collectFullBackupPayload();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `ledgr-backup-${currentUser}-${stamp}.json`;

  const boundary = 'ledgr_backup_boundary';
  const metadata = { name: filename, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n` +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':`multipart/related; boundary=${boundary}` },
    body,
  });
  if(!res.ok) throw new Error('Drive upload failed: HTTP ' + res.status);

  // Success clears any prior failure warning.
  localStorage.setItem(userKey('last_backup_at'), new Date().toISOString());
  localStorage.removeItem(userKey('last_backup_failed_at'));
  localStorage.removeItem(userKey('last_backup_error'));
  renderBackupStatus();
  return await res.json();
}

function todayStamp(){ return new Date().toISOString().slice(0, 10); }

// Best-effort, but NEVER silent on failure anymore. Called on login, on app
// resume (visibilitychange), and right after import.
async function maybeAutoBackup(reason){
  if(!driveConfigured()) return;
  if(reason !== 'import'){
    const lastBackupDate = (localStorage.getItem(userKey('last_backup_at')) || '').slice(0, 10);
    if(lastBackupDate === todayStamp()) return; // already succeeded today — no need to retry
  }
  try{
    await uploadBackupToDrive(false);
    if(reason === 'import') showToast('Backed up to Drive');
  }catch(err){
    console.log('Auto-backup failed (' + reason + '):', err.message || err);
    localStorage.setItem(userKey('last_backup_failed_at'), new Date().toISOString());
    localStorage.setItem(userKey('last_backup_error'), String(err.message || err));
    renderBackupStatus();
    // Loud once per day — not on every single app open, but impossible to miss.
    const warnedToday = (localStorage.getItem(userKey('last_backup_warn_shown')) || '').slice(0, 10) === todayStamp();
    if(!warnedToday){
      localStorage.setItem(userKey('last_backup_warn_shown'), new Date().toISOString());
      showToast('⚠ Drive backup failed — open Menu to reconnect');
    }
  }
}

async function runManualBackup(){
  if(!driveConfigured()){
    showToast('Drive backup not set up yet — see backup.js for setup steps');
    return;
  }
  const btn = document.getElementById('btnBackupNow');
  const originalLabel = btn.innerText;
  btn.disabled = true;
  btn.innerText = 'Backing up…';
  try{
    await uploadBackupToDrive(true); // interactive — real consent prompt if needed
    showToast('Backup saved to Drive ✓');
  }catch(err){
    console.error(err);
    localStorage.setItem(userKey('last_backup_failed_at'), new Date().toISOString());
    localStorage.setItem(userKey('last_backup_error'), String(err.message || err));
    renderBackupStatus();
    showToast('Backup failed — check console');
  }finally{
    btn.disabled = false;
    btn.innerText = originalLabel;
  }
}

function renderBackupStatus(){
  const el = document.getElementById('backupStatusText');
  if(!el) return;
  if(!driveConfigured()){
    el.innerText = 'Not set up yet — see backup.js for one-time setup steps.';
    el.style.color = 'var(--ink-soft)';
    return;
  }
  const failedAt = localStorage.getItem(userKey('last_backup_failed_at'));
  const lastOk = localStorage.getItem(userKey('last_backup_at'));
  // A failure is only "current" if it happened more recently than the last success.
  if(failedAt && (!lastOk || new Date(failedAt) > new Date(lastOk))){
    el.innerText = `⚠ Backup failed (${new Date(failedAt).toLocaleString()}) — tap "Backup now" to reconnect.`;
    el.style.color = '#8A3A2C';
    return;
  }
  el.style.color = 'var(--ink-soft)';
  el.innerText = lastOk
    ? `Last backup: ${new Date(lastOk).toLocaleString()}`
    : 'Not backed up yet — tap "Backup now" to connect Drive.';
}

/* ---------- Restore ---------- */

async function listDriveBackups(){
  const token = await getDriveAccessToken(true);
  const folderId = await findOrCreateBackupFolder(token);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime)`, {
    headers:{ Authorization:`Bearer ${token}` },
  });
  const data = await res.json();
  return data.files || [];
}

async function restoreFromDriveBackup(fileId){
  const token = await getDriveAccessToken(true);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers:{ Authorization:`Bearer ${token}` },
  });
  const payload = await res.json();

  receipts = payload.receipts || [];
  customFolders = payload.customFolders || [];
  receiptSeq = payload.receiptSeq || 1;
  activeFolderId = payload.activeFolderId || 'personal';

  // Use exactly what the backup saved — don't re-merge defaults on top, or a
  // category the user had deliberately removed before the backup was taken
  // would silently reappear on restore. Fall back to defaults only if the
  // backup itself somehow has no categories at all.
  CATEGORIES.length = 0;
  if(payload.categories && payload.categories.length){
    payload.categories.forEach(c=> CATEGORIES.push(c));
  }else{
    DEFAULT_CATEGORIES.forEach(c=> CATEGORIES.push(c));
  }

  localStorage.setItem(userKey('category_usage'), JSON.stringify(payload.categoryUsage || {}));
  saveKnownMerchants(payload.knownMerchants || []);

  persistState();
  renderAll();
  showToast('Restored from backup ✓');
}

async function showRestoreList(){
  const listEl = document.getElementById('restoreBackupList');
  if(!driveConfigured()){
    showToast('Drive backup not set up yet');
    return;
  }
  listEl.innerHTML = '<p style="font-size:12.5px; color:var(--ink-soft);">Loading backups…</p>';
  try{
    const files = await listDriveBackups();
    if(files.length === 0){
      listEl.innerHTML = '<p style="font-size:12.5px; color:var(--ink-soft);">No backups found yet.</p>';
      return;
    }
    listEl.innerHTML = '';
    files.forEach(f=>{
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 0; border-bottom:1px solid var(--rule);';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:12.5px; color:var(--ink);';
      label.innerText = new Date(f.createdTime).toLocaleString();
      const btn = document.createElement('button');
      btn.innerText = 'Restore';
      btn.style.cssText = 'padding:8px 14px; border-radius:9px; border:1.5px solid var(--sage); background:var(--card); color:var(--sage-deep); font-size:12.5px; font-weight:700; cursor:pointer;';
      btn.onclick = async ()=>{
        if(!confirm(`Restore backup from ${label.innerText}? This replaces everything currently on this device — receipts, categories, and known merchants.`)) return;
        if(!confirm('Are you sure? This cannot be undone.')) return;
        btn.disabled = true;
        btn.innerText = 'Restoring…';
        try{
          await restoreFromDriveBackup(f.id);
          listEl.innerHTML = '';
        }catch(err){
          console.error(err);
          showToast('Restore failed — check console');
          btn.disabled = false;
          btn.innerText = 'Restore';
        }
      };
      row.appendChild(label);
      row.appendChild(btn);
      listEl.appendChild(row);
    });
  }catch(err){
    console.error(err);
    listEl.innerHTML = '<p style="font-size:12.5px; color:var(--ink-soft);">Could not load backups — check console.</p>';
  }
}

/* ---------- Auto-restore prompt for a "new" browser/device ---------- */
// If this browser has no local receipt data for the current user, offer to
// pull the latest Drive backup instead of silently starting them off with an
// empty ledger (the failure mode behind the recent data-loss incident).
// Requires a tap rather than firing automatically on load: getDriveAccessToken
// in interactive mode generally needs a direct user gesture to reliably work
// across browsers (this is the same Safari/consent constraint documented at
// the top of this file) — an unprompted auto-popup on page load risks being
// silently blocked, which is exactly the failure mode we're trying to avoid.
//
// Needs a banner element in index.html, e.g.:
//   <div id="autoRestoreBanner" style="display:none;">
//     <span>No receipts found on this browser/device.</span>
//     <button id="autoRestoreCheckBtn">Check Drive for a backup</button>
//     <button id="autoRestoreDismissBtn">Dismiss</button>
//   </div>
async function checkLocalDataEmpty(){
  const localIndex = await idbGet(userKey('receiptIndex'));
  return !(localIndex && localIndex.length > 0);
}

async function maybeShowAutoRestoreBanner(){
  if(!driveConfigured()) return; // nothing to offer if Drive isn't set up
  const isEmpty = await checkLocalDataEmpty();
  if(!isEmpty) return; // normal case — this browser already has data, nothing to do
  const banner = document.getElementById('autoRestoreBanner');
  if(!banner) return;
  banner.style.display = 'flex';
}

async function handleAutoRestoreCheck(){
  const banner = document.getElementById('autoRestoreBanner');
  const checkBtn = document.getElementById('autoRestoreCheckBtn');
  checkBtn.disabled = true;
  checkBtn.innerText = 'Checking…';
  try{
    const files = await listDriveBackups(); // newest first
    if(files.length === 0){
      showToast('No Drive backups found for this account');
      if(banner) banner.style.display = 'none';
      return;
    }
    const latest = files[0];
    const dateStr = new Date(latest.createdTime).toLocaleString();
    if(confirm(`Restore the most recent Drive backup (${dateStr})? This replaces anything currently on this device.`)){
      await restoreFromDriveBackup(latest.id);
    }
    if(banner) banner.style.display = 'none';
  }catch(err){
    console.error('Auto-restore check failed', err);
    showToast('Could not check Drive — try "Restore from backup" in Menu instead');
  }finally{
    checkBtn.disabled = false;
    checkBtn.innerText = 'Check Drive for a backup';
  }
}

const autoRestoreCheckBtn = document.getElementById('autoRestoreCheckBtn');
if(autoRestoreCheckBtn) autoRestoreCheckBtn.onclick = handleAutoRestoreCheck;
const autoRestoreDismissBtn = document.getElementById('autoRestoreDismissBtn');
if(autoRestoreDismissBtn) autoRestoreDismissBtn.onclick = ()=>{
  document.getElementById('autoRestoreBanner').style.display = 'none';
};

document.getElementById('btnBackupNow').onclick = runManualBackup;
document.getElementById('btnShowRestoreList').onclick = showRestoreList;
renderBackupStatus();

// NOTE: maybeShowAutoRestoreBanner() is NOT called here on purpose — this file
// runs at script-parse time, before login, when currentUser is still null.
// Call maybeShowAutoRestoreBanner() from wherever login success is handled
// (same place maybeAutoBackup('login') is presumably already called), after
// currentUser is set and loadPersistedState() has run.

// Retry on every app resume too (not just once/day at login) — if a prior
// silent attempt failed, this gives it another chance each time you come
// back to the app, not just once every 24 hours.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible') maybeAutoBackup('resume');
});
