/* ============================================================
   REVIEW SHEET
   ============================================================ */
const reviewSheet = document.getElementById('reviewSheet');
const sheetBackdrop = document.getElementById('sheetBackdrop');

function renderFolderSelectRow(selectedId){
  const row = document.getElementById('folderSelectRow');
  row.innerHTML='';
  allFolders().forEach(f=>{
    const btn = document.createElement('div');
    btn.className = 'folder-opt' + (f.id===selectedId ? ' selected':'');
    btn.innerText = `${f.icon} ${f.label}`;
    btn.onclick = ()=>{
      currentReviewDraft.folderId = f.id;
      renderFolderSelectRow(f.id);
      recheckDuplicateBanner();
    };
    row.appendChild(btn);
  });
}

function renderCatGrid(selectedCat){
  const select = document.getElementById('catSelect');
  select.innerHTML = '';
  // if this receipt's category isn't in the master list yet (e.g. a newly-learned
  // merchant category), add it so it's still selectable/visible
  const options = CATEGORIES.includes(selectedCat) ? CATEGORIES : [...CATEGORIES, selectedCat];
  options.forEach(cat=>{
    const opt = document.createElement('option');
    opt.value = cat;
    opt.innerText = cat;
    if(cat===selectedCat) opt.selected = true;
    select.appendChild(opt);
  });
  const addOpt = document.createElement('option');
  addOpt.value = '__add_new__';
  addOpt.innerText = '+ Add new category…';
  select.appendChild(addOpt);

  select.onchange = ()=>{
    if(select.value==='__add_new__'){
      const prevCategory = currentReviewDraft.category;
      promptAddCategory((clean)=>{
        currentReviewDraft.category = clean;
      });
      renderCatGrid(currentReviewDraft.category === prevCategory ? prevCategory : currentReviewDraft.category);
      return;
    }
    currentReviewDraft.category = select.value;
  };
}

// shared by both the dropdown and the pop-out grid, so adding a category behaves
// identically no matter which entry point was used
function promptAddCategory(onCreated){
  const name = prompt('Name your new category (e.g. "Rent", "Childcare")');
  if(name && name.trim()){
    const clean = name.trim();
    if(!CATEGORIES.includes(clean)){
      CATEGORIES.push(clean);
      persistCategories();
    }
    onCreated(clean);
  }
}

function openCatGridPopout(){
  renderCatPopoutGrid(currentReviewDraft.category);
  document.getElementById('catGridBackdrop').classList.add('open');
  document.getElementById('catGridSheet').classList.add('open');
}
function closeCatGridPopout(){
  document.getElementById('catGridBackdrop').classList.remove('open');
  document.getElementById('catGridSheet').classList.remove('open');
}
function renderCatPopoutGrid(selectedCat){
  const grid = document.getElementById('catPopoutGrid');
  grid.innerHTML = '';
  const sorted = getCategoriesSortedByUsage();
  const options = sorted.includes(selectedCat) ? sorted : [...sorted, selectedCat];
  options.forEach(cat=>{
    const btn = document.createElement('div');
    btn.className = 'cat-opt' + (cat===selectedCat ? ' selected':'');
    btn.innerText = cat;
    btn.onclick = ()=>{
      currentReviewDraft.category = cat;
      renderCatGrid(cat); // keep dropdown in sync
      closeCatGridPopout();
    };
    grid.appendChild(btn);
  });
}

/* ============================================================
   SEARCH / FILTER PANEL
   ============================================================ */
function openSearchPanel(){
  // populate category dropdown fresh each time in case new categories were added
  const catSelect = document.getElementById('searchCategorySelect');
  catSelect.innerHTML = '<option value="">All categories</option>';
  CATEGORIES.forEach(cat=>{
    const opt = document.createElement('option');
    opt.value = cat; opt.innerText = cat;
    if(cat===activeFilters.category) opt.selected = true;
    catSelect.appendChild(opt);
  });
  document.getElementById('searchQueryInput').value = activeFilters.query;
  document.getElementById('searchDateFrom').value = activeFilters.dateFrom;
  document.getElementById('searchDateTo').value = activeFilters.dateTo;

  document.getElementById('searchBackdrop').classList.add('open');
  document.getElementById('searchSheet').classList.add('open');
}
function closeSearchPanel(){
  document.getElementById('searchBackdrop').classList.remove('open');
  document.getElementById('searchSheet').classList.remove('open');
}

document.getElementById('btnOpenSearch').onclick = openSearchPanel;
document.getElementById('searchCloseBtn').onclick = closeSearchPanel;
document.getElementById('searchBackdrop').onclick = closeSearchPanel;

document.getElementById('btnApplyFilters').onclick = ()=>{
  activeFilters = {
    query: document.getElementById('searchQueryInput').value.trim(),
    category: document.getElementById('searchCategorySelect').value,
    dateFrom: document.getElementById('searchDateFrom').value,
    dateTo: document.getElementById('searchDateTo').value,
  };
  closeSearchPanel();
  renderReceiptList();
  if(hasActiveFilters()) showToast('Filters applied');
};

document.getElementById('btnClearFilters').onclick = ()=>{
  activeFilters = { query:'', category:'', dateFrom:'', dateTo:'' };
  document.getElementById('searchQueryInput').value = '';
  document.getElementById('searchCategorySelect').value = '';
  document.getElementById('searchDateFrom').value = '';
  document.getElementById('searchDateTo').value = '';
  closeSearchPanel();
  renderReceiptList();
  showToast('Filters cleared');
};

document.getElementById('btnCatGridOpen').onclick = openCatGridPopout;
document.getElementById('catGridCloseBtn').onclick = closeCatGridPopout;
document.getElementById('catGridBackdrop').onclick = closeCatGridPopout;
document.getElementById('btnCatGridAddNew').onclick = ()=>{
  promptAddCategory((clean)=>{
    currentReviewDraft.category = clean;
    renderCatGrid(clean);
    renderCatPopoutGrid(clean);
  });
};

function confBadge(elId, level){
  const el = document.getElementById(elId);
  if(!level || level==='high'){ el.innerText=''; return; }
  if(level==='medium'){ el.innerText='● check'; el.className='conf'; el.style.color='var(--amber)'; return; }
  el.innerText='● low confidence'; el.className='conf low';
}

function openReviewSheetForIndex(i){
  currentReviewIndex = i;
  const item = reviewQueue[i];
  currentReviewDraft = {
    folderId: activeFolderId,
    date: item.date,
    establishment: item.establishment,
    amount: item.amount,
    currency: item.currency,
    category: item.category,
    notes: item.notes,
    images: item.images,
    needsCheck: item.needsCheck,
    confidences: item.confidences || {},
    rawOcrText: item.rawOcrText || ''
  };
  populateSheet();
  document.getElementById('multiNav').style.display = reviewQueue.length>1 ? 'flex':'none';
  document.getElementById('multiNavLabel').innerText = `Receipt ${i+1} of ${reviewQueue.length}`;
  openSheet();
}

function openReviewForExisting(id){
  const r = receipts.find(x=>x.id===id);
  if(!r) return;
  editingExistingId = id;
  reviewQueue = [];
  currentReviewDraft = { ...r };
  populateSheet();
  document.getElementById('multiNav').style.display='none';
  openSheet();
}

// Australia's GST is 10%, applied so that a GST-inclusive total = pre-GST price × 1.1.
// To back out the GST component from a total that already includes it: total ÷ 11.
function recalculateGstFromAmount(){
  const amt = parseFloat(document.getElementById('inputAmount').value);
  const gstInput = document.getElementById('inputGst');
  const tag = document.getElementById('gstAutoTag');
  if(!isNaN(amt) && amt>0){
    gstInput.value = (amt/11).toFixed(2);
    tag.innerText = '(auto)';
  } else {
    gstInput.value = '';
    tag.innerText = '';
  }
}
// only auto-recalculate GST while the user hasn't manually typed their own GST value
// for THIS sheet session — once they touch the GST field directly, stop overwriting it
let gstManuallyEdited = false;
document.getElementById('inputAmount').addEventListener('input', ()=>{
  if(!gstManuallyEdited) recalculateGstFromAmount();
});
document.getElementById('inputGst').addEventListener('input', ()=>{
  gstManuallyEdited = true;
  document.getElementById('gstAutoTag').innerText = '';
});

// re-checks for a duplicate whenever the user edits the fields that matter for matching,
// so the banner reflects manual corrections too, not just the initial OCR-extracted values
function recheckDuplicateBanner(){
  const dupBanner = document.getElementById('duplicateBanner');
  const folderId = (currentReviewDraft && currentReviewDraft.folderId) || activeFolderId;
  const candidate = {
    date: document.getElementById('inputDate').value,
    amount: document.getElementById('inputAmount').value,
    establishment: document.getElementById('inputEstablishment').value,
    folderId,
  };
  const dupMatch = findDuplicateReceipt(candidate, editingExistingId);
  if(dupMatch){
    dupBanner.style.display = 'block';
    document.getElementById('duplicateBannerText').innerHTML =
      `<strong>Possible duplicate.</strong> You already have "${escapeHtml(dupMatch.establishment)}" for ${formatDate(dupMatch.date)} at ${dupMatch.currency} ${parseFloat(dupMatch.amount).toFixed(2)} in this folder. If this is a separate purchase, no action needed.`;
  } else {
    dupBanner.style.display = 'none';
  }
}
['inputDate','inputEstablishment','inputAmount'].forEach(id=>{
  document.getElementById(id).addEventListener('input', recheckDuplicateBanner);
  document.getElementById(id).addEventListener('change', recheckDuplicateBanner);
});
document.getElementById('btnDiscardAsDuplicate').onclick = ()=>{
  if(!confirm('Discard this entry as a duplicate?')) return;
  if(editingExistingId){
    receipts = receipts.filter(r=>r.id!==editingExistingId);
    editingExistingId = null;
    closeSheet();
    renderAll();
    showToast('Duplicate discarded');
  } else {
    advanceReviewQueueOrClose();
    showToast('Duplicate discarded');
  }
};

function populateSheet(){
  gstManuallyEdited = false;
  const d = currentReviewDraft;
  document.getElementById('verifyFlag').className = 'verify-flag ' + (d.needsCheck ? 'needs':'ok');
  document.getElementById('verifyFlag').innerText = d.needsCheck ? '⚠ Needs check' : '✓ Looks good';

  const banner = document.getElementById('ocrErrorBanner');
  if(d.ocrFailed){
    banner.style.display = 'block';
    banner.innerHTML = `<strong>OCR couldn't process this receipt.</strong><br>${d.ocrErrorMessage || 'Please fill in the fields manually below.'}`;
  } else if(d.ocrPartialError){
    banner.style.display = 'block';
    banner.innerHTML = `<strong>One page didn't scan properly.</strong><br>${d.ocrPartialError}`;
  } else {
    banner.style.display = 'none';
  }

  const strip = document.getElementById('previewStrip');
  const hintEl = document.getElementById('previewHint');
  strip.innerHTML='';
  (d.images||[]).forEach((img, i)=>{
    const el = document.createElement('img');
    el.src = img;
    el.title = 'Tap to view full size';
    el.addEventListener('click', ()=> openLightbox(d.images, i));
    strip.appendChild(el);
  });
  if(!d.images || d.images.length===0){
    strip.innerHTML = '<div style="font-size:12px;color:var(--ink-soft);padding:8px 0;">No image attached to this entry.</div>';
    hintEl.style.display = 'none';
  } else {
    hintEl.style.display = 'block';
  }

  renderFolderSelectRow(d.folderId);
  document.getElementById('inputDate').value = d.date || '';
  document.getElementById('knownMerchantBadge').style.display = d.matchedKnownMerchant ? 'block' : 'none';
  document.getElementById('inputEstablishment').value = d.establishment || '';
  document.getElementById('inputAmount').value = d.amount || '';
  document.getElementById('inputCurrency').value = d.currency || 'AUD';
  document.getElementById('inputNotes').value = d.notes || '';
  renderCatGrid(d.category);

  // GST: use a stored value if this receipt already had one set (e.g. re-opening an
  // existing entry), otherwise auto-calculate 10% GST-inclusive from the total
  if(d.gst !== undefined && d.gst !== null && d.gst !== ''){
    document.getElementById('inputGst').value = d.gst;
    document.getElementById('gstAutoTag').innerText = '';
  } else {
    recalculateGstFromAmount();
  }

  const c = d.confidences || {};
  confBadge('confDate', c.date);
  confBadge('confEst', c.establishment);
  confBadge('confAmount', c.amount);

  recheckDuplicateBanner();

  document.getElementById('rawOcrText').innerText = d.rawOcrText || '(no OCR text captured for this entry)';

  document.getElementById('fieldDate').classList.toggle('flagged', c.date==='low');
  document.getElementById('fieldEstablishment').classList.toggle('flagged', c.establishment==='low');
  document.getElementById('fieldAmount').classList.toggle('flagged', c.amount==='low');
}

function openSheet(){
  sheetBackdrop.classList.add('open');
  reviewSheet.classList.add('open');
}
function closeSheet(){
  sheetBackdrop.classList.remove('open');
  reviewSheet.classList.remove('open');
}

document.getElementById('sheetCloseBtn').onclick = ()=>{
  if(confirm('Discard changes and close?')) { closeSheet(); }
};
sheetBackdrop.onclick = ()=>{ closeSheet(); };

document.getElementById('btnDiscard').onclick = ()=>{
  if(!confirm('Discard this receipt entry? This cannot be undone.')) return;
  if(editingExistingId){
    receipts = receipts.filter(r=>r.id!==editingExistingId);
    editingExistingId = null;
    closeSheet();
    renderAll();
    showToast('Receipt deleted');
  } else {
    advanceReviewQueueOrClose();
    showToast('Receipt discarded');
  }
};

document.getElementById('btnConfirm').onclick = ()=>{
  // pull latest field values into draft
  currentReviewDraft.date = document.getElementById('inputDate').value;
  currentReviewDraft.establishment = document.getElementById('inputEstablishment').value.trim();
  currentReviewDraft.amount = document.getElementById('inputAmount').value;
  currentReviewDraft.gst = document.getElementById('inputGst').value;
  currentReviewDraft.currency = document.getElementById('inputCurrency').value;
  currentReviewDraft.notes = document.getElementById('inputNotes').value.trim();

  if(!currentReviewDraft.establishment){
    alert('Please add an establishment name before saving.');
    return;
  }
  if(!currentReviewDraft.amount){
    alert('Please add an amount before saving.');
    return;
  }

  // learn this merchant so future receipts from the same place are recognised instantly
  rememberMerchant(currentReviewDraft.establishment, currentReviewDraft.category);
  recordCategoryUsage(currentReviewDraft.category);

  if(editingExistingId){
    const i = receipts.findIndex(r=>r.id===editingExistingId);
    receipts[i] = { ...currentReviewDraft, id:editingExistingId, verified:true, needsCheck:false };
    editingExistingId = null;
    closeSheet();
    renderAll();
    showToast('Receipt updated ✓');
  } else {
    receipts.push({ ...currentReviewDraft, id:receiptSeq++, verified:true, needsCheck:false });
    showToast(`Saved & archived ✓ (${reviewQueue.length - currentReviewIndex - 1} remaining)`);
    advanceReviewQueueOrClose();
  }
};

function advanceReviewQueueOrClose(){
  if(currentReviewIndex < reviewQueue.length - 1){
    openReviewSheetForIndex(currentReviewIndex + 1);
  } else {
    reviewQueue = [];
    closeSheet();
    renderAll();
  }
}

/* ============================================================
   STORAGE INFO SHEET
   ============================================================ */
const storageSheet = document.getElementById('storageSheet');
const storageBackdrop = document.getElementById('storageBackdrop');
document.getElementById('btnStorageInfo').onclick = ()=>{
  document.getElementById('inputApiKey').value = localStorage.getItem('ocrspace_key') || '';
  document.getElementById('menuCurrentUser').innerText = currentUser || '';
  renderMerchantList();
  renderCategoryManageList();
  storageBackdrop.classList.add('open');
  storageSheet.classList.add('open');
};

document.getElementById('btnLogout').onclick = ()=>{
  if(!confirm('Log out? Your receipts stay saved on this device and will be here next time you log back in.')) return;
  localStorage.removeItem('ledger_session_user');
  currentUser = null;
  receipts = []; customFolders = []; receiptSeq = 1; activeFolderId = 'personal';
  storageBackdrop.classList.remove('open');
  storageSheet.classList.remove('open');
  document.getElementById('appRoot').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
};

// the original built-in set — protected from deletion so existing receipts never
// end up pointing at a category that no longer exists in the list
const DEFAULT_CATEGORIES = new Set(['Meals','Groceries','Fuel','Materials','Software','Travel','Utilities','Rent','Office','Tools','Parking','Subscriptions','Health','Misc']);

