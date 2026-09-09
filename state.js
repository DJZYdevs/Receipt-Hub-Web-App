/* ============================================================
   STATE
   ============================================================ */
const FOLDERS = [
  {id:'personal', label:'Personal', icon:'📁', color:'#7A9482'},
  {id:'work', label:'Work', icon:'💼', color:'#4E6B58'},
  {id:'investments', label:'Investments', icon:'📈', color:'#C48A3F'},
  {id:'other', label:'Other', icon:'🗂️', color:'#8C7AA9'},
];
const APP_VERSION = '1.18.1'; // bump this each time meaningful changes ship — shown next to "Ledgr" in the header

// configure pdf.js worker (needed for PDF import/text-extraction)
if(window['pdfjsLib']){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
// NOTE: DEFAULT_CATEGORIES is declared in review-search.js (as a Set — categories.js
// relies on its .has() method). Do NOT redeclare it here: state.js loads first, before
// review-search.js, and a second top-level `const DEFAULT_CATEGORIES` in this shared
// global scope throws a SyntaxError in whichever script declares it second, silently
// killing every binding in that file. loadPersistedState() below references
// DEFAULT_CATEGORIES only inside a function body, which is fine — by the time it
// actually runs (after login), every script tag has already loaded.
const CATEGORIES = ['Meals','Groceries','Fuel','Materials','Software','Travel','Utilities','Rent','Office','Tools','Parking','Subscriptions','Health','Misc'];

// ⚠️ TESTING-ONLY USER GATE — NOT REAL SECURITY.
// These credentials live in plain text in this file, visible to anyone who opens it in
// a text editor or views page source. This only keeps each username's receipt data
// separated in local browser storage on ONE device for demo/testing purposes. It is not
// authentication, and this file must never be used for real users' private data as-is —
// that would require a real backend.
const USERS = [
  { username: 'admin', password: 'DJZYdevs' },
  { username: 'admin2', password: 'test' },
];
let currentUser = null;

let customFolders = [];
let activeFolderId = 'personal';
let receipts = []; // {id, folderId, date, establishment, amount, currency, category, notes, images:[dataURL], verified, needsCheck, confidences:{}}
let receiptSeq = 1;

// dashboard month being viewed — defaults to the current real-world month
let viewedMonth = new Date().getMonth(); // 0-11
let viewedYear = new Date().getFullYear();

// search/filter panel state
let activeFilters = { query:'', category:'', dateFrom:'', dateTo:'' };

// bulk-select mode — lets the user select multiple receipts in the existing list view
// (rather than a separate screen) to reassign category/folder or delete in one action
let selectMode = false;
let selectedReceiptIds = new Set();

// capture session state
let mediaStream = null;
let capturedImages = []; // dataURLs for current camera session
let multiPageMode = false;

// review session state
let reviewQueue = []; // array of {images:[dataURL,...]} pending OCR+review, processed one at a time
let currentReviewIndex = 0;
let currentReviewDraft = null; // the receipt object being edited in the sheet
let editingExistingId = null; // if reviewing an already-saved receipt

/* ============================================================
   PERSISTENCE (IndexedDB — handles receipt photos without the
   ~5-10MB ceiling that localStorage would hit after a few dozen
   photographed receipts)
   ============================================================ */
const DB_NAME = 'ledger_receipts_db';
const DB_VERSION = 1;
const STORE_NAME = 'app_state';
let dbInstance = null;

function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE_NAME)){
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function getDB(){
  if(!dbInstance) dbInstance = await openDB();
  return dbInstance;
}

async function idbSet(key, value){
  const db = await getDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}

async function idbGet(key){
  const db = await getDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

function userKey(key){
  return `${currentUser}:${key}`;
}

// --- Per-receipt storage (replaces storing the whole receipts array as one giant
// IndexedDB value). Each receipt — including its embedded photo(s) — is its own record,
// keyed by id, plus a small index listing which ids belong to this user. This matters
// at scale: serializing hundreds of receipts with embedded images in ONE operation can
// spike memory enough to crash the tab on mobile Safari during a large import. Writing
// one small record at a time keeps each individual operation cheap regardless of how
// many receipts exist in total.
function receiptRecordKey(id){ return `${currentUser}:receipt:${id}`; }

async function persistReceiptsIncremental(){
  if(!currentUser) return;
  const db = await getDB();
  const CHUNK_SIZE = 25; // yield to the browser between chunks on large imports
  for(let i=0; i<receipts.length; i+=CHUNK_SIZE){
    const chunk = receipts.slice(i, i+CHUNK_SIZE);
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      chunk.forEach(r=> store.put(r, receiptRecordKey(r.id)));
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
    if(i+CHUNK_SIZE < receipts.length) await new Promise(r=> setTimeout(r, 0));
  }
  await idbSet(userKey('receiptIndex'), receipts.map(r=>r.id));
}

// deletes any per-receipt records whose id is no longer in the in-memory receipts array
// (covers deletes/discards) — compares against the previously-saved index
async function pruneDeletedReceiptRecords(previousIds){
  const currentIds = new Set(receipts.map(r=>r.id));
  const toDelete = previousIds.filter(id=> !currentIds.has(id));
  if(toDelete.length===0) return;
  const db = await getDB();
  await new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    toDelete.forEach(id=> store.delete(receiptRecordKey(id)));
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}

async function loadReceiptsIncremental(){
  const index = await idbGet(userKey('receiptIndex'));
  if(!index) return null; // signals "no new-format data yet — caller should check for legacy format"
  const loaded = await Promise.all(index.map(id=> idbGet(receiptRecordKey(id))));
  return loaded.filter(Boolean);
}

// one-time migration from the old "whole array in one key" format to per-receipt
// records, so upgrading to this storage format never loses anyone's existing data
async function migrateReceiptsToIncrementalFormat(){
  const legacyArray = await idbGet(userKey('receipts'));
  if(!legacyArray || !legacyArray.length) return;
  const savedIndex = await idbGet(userKey('receiptIndex'));
  if(savedIndex) return; // already migrated
  receipts = legacyArray;
  await persistReceiptsIncremental();
}

// debounced save so rapid successive changes (e.g. typing in a field) don't
// trigger a disk write on every keystroke
let saveTimer = null;
let lastPersistedReceiptIds = [];
function persistState(){
  if(!currentUser) return; // never write before a user is logged in
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{
      const previousIds = lastPersistedReceiptIds;
      await persistReceiptsIncremental(); // chunked, one small record per receipt
      await pruneDeletedReceiptRecords(previousIds);
      lastPersistedReceiptIds = receipts.map(r=>r.id);
      await idbSet(userKey('customFolders'), customFolders);
      await idbSet(userKey('receiptSeq'), receiptSeq);
      await idbSet(userKey('activeFolderId'), activeFolderId);
      await idbSet(userKey('categories'), CATEGORIES);
    }catch(err){
      console.error('Failed to save to IndexedDB', err);
      showToast('⚠ Could not save — storage may be full');
    }
  }, 250);
}
// separate lightweight helper for saving just the category list (e.g. right after
// adding a new one, without waiting on the debounced full-state save)
function persistCategories(){
  if(!currentUser) return;
  idbSet(userKey('categories'), CATEGORIES).catch(err=> console.error('Failed to save categories', err));
}

// one-time migration: data saved before multi-user support existed lived under plain
// keys ('receipts', not 'admin:receipts'). The first time 'admin' logs in, adopt that
// legacy data as admin's own so nothing already scanned appears to vanish.
async function migrateLegacyDataToAdmin(){
  try{
    const legacyReceipts = await idbGet('receipts');
    const alreadyMigrated = await idbGet('admin:migrated');
    if(legacyReceipts && !alreadyMigrated){
      const [legacyFolders, legacySeq, legacyActiveFolder, legacyCategories] = await Promise.all([
        idbGet('customFolders'), idbGet('receiptSeq'), idbGet('activeFolderId'), idbGet('categories')
      ]);
      await idbSet('admin:receipts', legacyReceipts);
      if(legacyFolders) await idbSet('admin:customFolders', legacyFolders);
      if(legacySeq) await idbSet('admin:receiptSeq', legacySeq);
      if(legacyActiveFolder) await idbSet('admin:activeFolderId', legacyActiveFolder);
      if(legacyCategories) await idbSet('admin:categories', legacyCategories);
      await idbSet('admin:migrated', true);
    }
  }catch(err){
    console.error('Legacy data migration failed', err);
  }

  // separate migration, added after the fact: known merchants and category usage
  // used to live under un-namespaced localStorage keys before per-user separation
  // existed. This never got carried over when that separation was added, so it's
  // handled here on its own flag (independent of the receipts migration above,
  // which may have already completed and shouldn't block this one from running).
  try{
    const alreadyMigratedMerchants = localStorage.getItem('admin:merchants_migrated');
    if(!alreadyMigratedMerchants){
      const legacyMerchants = localStorage.getItem('known_merchants');
      const legacyCategoryUsage = localStorage.getItem('category_usage');
      if(legacyMerchants) localStorage.setItem('admin:known_merchants', legacyMerchants);
      if(legacyCategoryUsage) localStorage.setItem('admin:category_usage', legacyCategoryUsage);
      localStorage.setItem('admin:merchants_migrated', 'true');
    }
  }catch(err){
    console.error('Legacy merchant data migration failed', err);
  }
}

async function loadPersistedState(){
  try{
    if(currentUser==='admin') await migrateLegacyDataToAdmin();
    await migrateReceiptsToIncrementalFormat(); // old single-array format -> per-receipt records, if needed

    const [loadedReceipts, savedFolders, savedSeq, savedActiveFolder, savedCategories] = await Promise.all([
      loadReceiptsIncremental(), idbGet(userKey('customFolders')), idbGet(userKey('receiptSeq')),
      idbGet(userKey('activeFolderId')), idbGet(userKey('categories'))
    ]);
    receipts = loadedReceipts || [];
    lastPersistedReceiptIds = receipts.map(r=>r.id);
    customFolders = savedFolders || [];
    receiptSeq = savedSeq || 1;
    activeFolderId = savedActiveFolder || 'personal';
    // Reset CATEGORIES for this user, so switching users doesn't leak one user's
    // custom categories into another's list. New user (nothing saved yet) -> start
    // from the defaults. Returning user -> use exactly what they last saved, as-is —
    // do NOT re-merge in the defaults, or a category they deliberately removed would
    // silently reappear every time the app loads.
    CATEGORIES.length = 0;
    if(savedCategories && savedCategories.length){
      savedCategories.forEach(c=> CATEGORIES.push(c));
    }else{
      DEFAULT_CATEGORIES.forEach(c=> CATEGORIES.push(c));
    }
    return true;
  }catch(err){
    console.error('Failed to load from IndexedDB', err);
    return false;
  }
}
