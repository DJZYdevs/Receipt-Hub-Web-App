/* ============================================================
   BACKUP — full-state backup to Google Drive.

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
      URL exactly, e.g. https://yourusername.github.io
      (no trailing slash, no path).
   4. Copy the generated Client ID and paste it below as
      GOOGLE_CLIENT_ID.
   5. APIs & Services → OAuth consent screen → Audience →
      add your own Google account under "Test users" (required
      since this app won't be Google-verified — test mode is fine
      for personal use, tokens just expire after 7 days and you'll
      need to reconnect via "Backup now").
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

// Gets a Drive access token. interactive=false tries silently (no popup) — used
// for the automatic daily/after-import backup, so it never interrupts you.
// interactive=true shows Google's consent screen when needed — used for the
// manual "Backup now" button and for Restore, where a visible prompt is fine.
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

// Gathers everything needed to fully restore this user's state — keep this in
// sync with anything new added to state.js/localStorage going forward, or a
// future field will silently fall out of backups the same way this one did.
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
  localStorage.setItem(userKey('last_backup_at'), new Date().toISOString());
  renderBackupStatus();
  return await res.json();
}

function todayStamp(){ return new Date().toISOString().slice(0, 10); }

// Silent, best-effort — called on login and right after an import completes.
// Never shows an error to the user on failure (most likely cause is Drive
// was never connected yet); "Backup now" is the button that surfaces real
// consent prompts / real errors.
async function maybeAutoBackup(reason){
  if(!driveConfigured()) return;
  if(reason === 'login'){
    const lastBackupDate = (localStorage.getItem(userKey('last_backup_at')) || '').slice(0, 10);
    if(lastBackupDate === todayStamp()) return; // already backed up today
  }
  try{
    await uploadBackupToDrive(false);
    if(reason === 'import') showToast('Backed up to Drive');
  }catch(err){
    console.log('Auto-backup skipped (' + reason + '):', err.message || err);
  }
}

async function runManualBackup(){
  if(!driveConfigured()){
    showToast('Drive backup not set up yet — see backup.js for setup steps');
    return;
  }
  showToast('Backing up…');
  try{
    await uploadBackupToDrive(true);
    showToast('Backup saved to Drive ✓');
  }catch(err){
    console.error(err);
    showToast('Backup failed — check console');
  }
}

function renderBackupStatus(){
  const el = document.getElementById('backupStatusText');
  if(!el) return;
  if(!driveConfigured()){
    el.innerText = 'Not set up yet — see backup.js for one-time setup steps.';
    return;
  }
  const last = localStorage.getItem(userKey('last_backup_at'));
  el.innerText = last
    ? `Last backup: ${new Date(last).toLocaleString()}`
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

  CATEGORIES.length = 0;
  DEFAULT_CATEGORIES.forEach(c=> CATEGORIES.push(c));
  (payload.categories || []).forEach(c=>{ if(!CATEGORIES.includes(c)) CATEGORIES.push(c); });

  localStorage.setItem(userKey('category_usage'), JSON.stringify(payload.categoryUsage || {}));
  saveKnownMerchants(payload.knownMerchants || []);

  persistState(); // flushes receipts/folders/seq/activeFolder/categories to IndexedDB
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

document.getElementById('btnBackupNow').onclick = runManualBackup;
document.getElementById('btnShowRestoreList').onclick = showRestoreList;
renderBackupStatus();
