/* ============================================================
   RENDER: FOLDER TABS
   ============================================================ */
function allFolders(){ return [...FOLDERS, ...customFolders]; }

function renderFolderTabs(){
  const el = document.getElementById('folderTabs');
  el.innerHTML = '';
  allFolders().forEach(f=>{
    const btn = document.createElement('button');
    btn.className = 'folder-btn' + (f.id===activeFolderId ? ' active':'');
    btn.innerHTML = `<span class="dot" style="background:${f.color}"></span>${f.icon} ${f.label}`;
    btn.onclick = ()=>{ activeFolderId = f.id; renderAll(); };
    el.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'folder-btn add';
  addBtn.innerText = '+ New folder';
  addBtn.onclick = ()=>{
    const name = prompt('Name your custom folder (e.g. "Renovation", "Rental Property")');
    if(name && name.trim()){
      const id = 'custom_'+Date.now();
      customFolders.push({id, label:name.trim(), icon:'🗃️', color:'#8C7AA9'});
      activeFolderId = id;
      renderAll();
    }
  };
  el.appendChild(addBtn);

  const folderMeta = allFolders().find(f=>f.id===activeFolderId);
  document.getElementById('activeFolderChip').innerText = `${folderMeta.icon} ${folderMeta.label}`;
}

/* ============================================================
   RENDER: RECEIPT LIST
   ============================================================ */
function receiptMatchesMonth(r){
  if(!r.date) return false;
  const d = new Date(r.date + 'T00:00:00');
  return d.getMonth()===viewedMonth && d.getFullYear()===viewedYear;
}

function receiptMatchesFilters(r){
  if(activeFilters.category && r.category !== activeFilters.category) return false;
  if(activeFilters.query){
    const q = activeFilters.query.toLowerCase();
    const haystack = `${r.establishment||''} ${r.notes||''} ${r.category||''}`.toLowerCase();
    if(!haystack.includes(q)) return false;
  }
  if(activeFilters.dateFrom && (!r.date || r.date < activeFilters.dateFrom)) return false;
  if(activeFilters.dateTo && (!r.date || r.date > activeFilters.dateTo)) return false;
  return true;
}

function hasActiveFilters(){
  return !!(activeFilters.query || activeFilters.category || activeFilters.dateFrom || activeFilters.dateTo);
}

/* ============================================================
   DUPLICATE DETECTION — flags likely duplicates (same date + amount
   + establishment) for the user to confirm or dismiss. Never silently
   blocks a save, since a genuine same-day repeat purchase is real.
   ============================================================ */
function normalizeEstablishmentForMatch(name){
  return (name||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
}
function isLikelyDuplicatePair(a, b){
  if(!a.date || !b.date || a.date !== b.date) return false;
  const amtA = parseFloat(a.amount)||0, amtB = parseFloat(b.amount)||0;
  if(Math.abs(amtA-amtB) > 0.01) return false;
  const estA = normalizeEstablishmentForMatch(a.establishment);
  const estB = normalizeEstablishmentForMatch(b.establishment);
  if(!estA || !estB) return false; // blank names are too unreliable to compare
  return estA === estB;
}
// checks a candidate {date, amount, establishment, folderId} against every saved
// receipt in that same folder — returns the matching receipt, or null
function findDuplicateReceipt(candidate, excludeId){
  return receipts.find(r=> r.folderId===candidate.folderId && r.id!==excludeId && isLikelyDuplicatePair(r, candidate)) || null;
}

/* ============================================================
   BULK SELECT MODE
   ============================================================ */
function enterSelectMode(){
  selectMode = true;
  selectedReceiptIds = new Set();
  document.getElementById('sectionLabelNormalControls').style.display = 'none';
  document.getElementById('sectionLabelSelectControls').style.display = 'flex';
  document.getElementById('captureBar').style.display = 'none';
  document.getElementById('bulkActionBar').style.display = 'flex';
  renderReceiptList();
}
function exitSelectMode(){
  selectMode = false;
  selectedReceiptIds = new Set();
  document.getElementById('sectionLabelNormalControls').style.display = 'flex';
  document.getElementById('sectionLabelSelectControls').style.display = 'none';
  document.getElementById('captureBar').style.display = 'flex';
  document.getElementById('bulkActionBar').style.display = 'none';
  renderAll(); // not just renderReceiptList — called after bulk mutations, must persist them
}
function toggleReceiptSelection(id){
  if(selectedReceiptIds.has(id)) selectedReceiptIds.delete(id);
  else selectedReceiptIds.add(id);
  renderReceiptList();
}
function updateBulkActionBar(){
  const count = selectedReceiptIds.size;
  document.getElementById('bulkSelectedCount').innerText = `${count} selected`;
  const disabled = count===0;
  ['btnBulkCategory','btnBulkFolder','btnBulkDelete'].forEach(id=>{
    document.getElementById(id).style.opacity = disabled ? '0.4' : '1';
    document.getElementById(id).style.pointerEvents = disabled ? 'none' : 'auto';
  });
}
document.getElementById('btnEnterSelectMode').onclick = enterSelectMode;
document.getElementById('btnExitSelectMode').onclick = exitSelectMode;
document.getElementById('btnSelectAll').onclick = ()=>{
  // selects every receipt currently visible in the list (respects the active month
  // scope or search/filter, whichever is driving the list right now) — this is what
  // makes "delete this whole month" or "delete this whole category" a one-tap setup
  const visibleIds = getVisibleReceiptIds();
  const allSelected = visibleIds.every(id=> selectedReceiptIds.has(id));
  if(allSelected){
    visibleIds.forEach(id=> selectedReceiptIds.delete(id));
  } else {
    visibleIds.forEach(id=> selectedReceiptIds.add(id));
  }
  renderReceiptList();
};
document.getElementById('btnBulkDelete').onclick = ()=>{
  const count = selectedReceiptIds.size;
  if(count===0) return;
  if(!confirm(`Delete ${count} receipt${count===1?'':'s'}? This cannot be undone.`)) return;
  receipts = receipts.filter(r=> !selectedReceiptIds.has(r.id));
  exitSelectMode();
  showToast(`Deleted ${count} receipt${count===1?'':'s'}`);
};
function openBulkCategoryPicker(){
  if(selectedReceiptIds.size===0) return;
  document.getElementById('bulkCategoryTitle').innerText = `Set category for ${selectedReceiptIds.size} receipt${selectedReceiptIds.size===1?'':'s'}`;
  const grid = document.getElementById('bulkCategoryGrid');
  grid.innerHTML = '';
  CATEGORIES.forEach(cat=>{
    const btn = document.createElement('div');
    btn.className = 'cat-opt';
    btn.innerText = cat;
    btn.onclick = ()=>{
      const count = selectedReceiptIds.size;
      receipts.forEach(r=>{ if(selectedReceiptIds.has(r.id)) r.category = cat; });
      closeBulkCategoryPicker();
      exitSelectMode();
      showToast(`Set ${count} receipt${count===1?'':'s'} to "${cat}"`);
    };
    grid.appendChild(btn);
  });
  document.getElementById('bulkCategoryBackdrop').classList.add('open');
  document.getElementById('bulkCategorySheet').classList.add('open');
}
function closeBulkCategoryPicker(){
  document.getElementById('bulkCategoryBackdrop').classList.remove('open');
  document.getElementById('bulkCategorySheet').classList.remove('open');
}
document.getElementById('btnBulkCategory').onclick = openBulkCategoryPicker;
document.getElementById('bulkCategoryCloseBtn').onclick = closeBulkCategoryPicker;
document.getElementById('bulkCategoryBackdrop').onclick = closeBulkCategoryPicker;
function openBulkFolderPicker(){
  if(selectedReceiptIds.size===0) return;
  document.getElementById('bulkFolderTitle').innerText = `Move ${selectedReceiptIds.size} receipt${selectedReceiptIds.size===1?'':'s'} to`;
  const grid = document.getElementById('bulkFolderGrid');
  grid.innerHTML = '';
  allFolders().forEach(f=>{
    const btn = document.createElement('div');
    btn.className = 'folder-opt';
    btn.innerText = `${f.icon} ${f.label}`;
    btn.onclick = ()=>{
      const count = selectedReceiptIds.size;
      receipts.forEach(r=>{ if(selectedReceiptIds.has(r.id)) r.folderId = f.id; });
      closeBulkFolderPicker();
      exitSelectMode();
      showToast(`Moved ${count} receipt${count===1?'':'s'} to ${f.label}`);
    };
    grid.appendChild(btn);
  });
  document.getElementById('bulkFolderBackdrop').classList.add('open');
  document.getElementById('bulkFolderSheet').classList.add('open');
}
function closeBulkFolderPicker(){
  document.getElementById('bulkFolderBackdrop').classList.remove('open');
  document.getElementById('bulkFolderSheet').classList.remove('open');
}
document.getElementById('btnBulkFolder').onclick = openBulkFolderPicker;
document.getElementById('bulkFolderCloseBtn').onclick = closeBulkFolderPicker;
document.getElementById('bulkFolderBackdrop').onclick = closeBulkFolderPicker;

// shared by rendering and "select all" — keeps both using the exact same scoping rules
// (active folder + either the viewed month, or the active search/filter across all months)
function getVisibleReceipts(){
  const filtering = hasActiveFilters();
  let list = receipts.filter(r=>r.folderId===activeFolderId);
  list = filtering ? list.filter(receiptMatchesFilters) : list.filter(receiptMatchesMonth);
  return list.sort((a,b)=> (b.date||'').localeCompare(a.date||''));
}
function getVisibleReceiptIds(){
  return getVisibleReceipts().map(r=>r.id);
}

let lastRenderedScopeKey = null; // tracks folder+month or folder+filters, so we only
// scroll to top when the actual visible SET changes (new month, new/cleared filters,
// folder switch) — not on every re-render (e.g. editing a receipt in place shouldn't
// jerk the page back to the top).
function renderReceiptList(){
  const list = getVisibleReceipts();
  const filtering = hasActiveFilters();

  const scopeKey = `${activeFolderId}::${filtering ? 'filter:'+JSON.stringify(activeFilters) : 'month:'+viewedYear+'-'+viewedMonth}`;
  const scopeChanged = scopeKey !== lastRenderedScopeKey;
  lastRenderedScopeKey = scopeKey;

  const el = document.getElementById('receiptList');
  const empty = document.getElementById('emptyState');
  el.innerHTML = '';
  document.getElementById('receiptCount').innerText = list.length;

  if(scopeChanged){
    // cover both possible scroll containers without needing to know which one
    // this layout actually uses — harmless no-op on whichever doesn't apply
    window.scrollTo(0, 0);
    if(document.scrollingElement) document.scrollingElement.scrollTop = 0;
    el.scrollTop = 0;
  }

  const sectionLabel = document.getElementById('sectionLabelText');
  if(sectionLabel){
    sectionLabel.innerText = filtering ? 'Filtered results' : monthYearLabel(viewedMonth, viewedYear);
  }
  document.getElementById('filterActiveDot').style.display = filtering ? 'block' : 'none';

  if(list.length===0){
    empty.style.display='block';
    const emptyTitle = empty.querySelector('h3');
    const emptyText = empty.querySelector('p');
    if(filtering){
      if(emptyTitle) emptyTitle.innerText = 'No matches';
      if(emptyText) emptyText.innerText = 'Nothing matches your current search or filters. Try adjusting them.';
    } else {
      if(emptyTitle) emptyTitle.innerText = 'No receipts here yet';
      if(emptyText) emptyText.innerText = 'Capture or upload a receipt below to get started. Extracted data will be pre-filled for you to verify.';
    }
  }
  else{ empty.style.display='none'; }

  let total = 0;
  let pending = 0;
  list.forEach(r=>{
    const amt = parseFloat(r.amount)||0;
    if(r.currency==='AUD') total += amt;
    if(r.needsCheck || !r.verified) pending++;

    const card = document.createElement('div');
    card.className = 'receipt-card' + (selectMode && selectedReceiptIds.has(r.id) ? ' selected' : '');
    const folderMeta = allFolders().find(f=>f.id===r.folderId) || FOLDERS[0];
    const checkboxHtml = selectMode ? `<input type="checkbox" class="receipt-card-checkbox" ${selectedReceiptIds.has(r.id) ? 'checked':''}>` : '';
    card.innerHTML = `
      <div class="accent" style="background:${folderMeta.color}"></div>
      ${checkboxHtml}
      <div class="thumb">${r.images && r.images[0] ? `<img src="${r.images[0]}">` : '🧾'}</div>
      <div class="r-info">
        <div class="r-name">${escapeHtml(r.establishment || 'Unnamed receipt')}</div>
        <div class="r-meta">
          <span>${formatDate(r.date)}</span>
          <span class="cat-pill" style="background:${categoryColor(r.category)}22; color:${categoryColor(r.category)}">${r.category||'Uncategorised'}</span>
        </div>
      </div>
      <div class="r-amount">
        ${r.currency||'AUD'} ${parseFloat(r.amount||0).toFixed(2)}
        <span class="status ${r.needsCheck ? 'pending':'verified'}">${r.needsCheck ? '⚠ Review' : '✓ Verified'}</span>
      </div>
    `;
    card.onclick = selectMode ? (()=> toggleReceiptSelection(r.id)) : (()=> openReviewForExisting(r.id));
    el.appendChild(card);

    // wire up thumbnail tap -> lightbox preview (stopPropagation so it doesn't also open the edit sheet)
    if(!selectMode && r.images && r.images.length){
      const thumbImg = card.querySelector('.thumb img');
      if(thumbImg){
        thumbImg.addEventListener('click', (e)=>{
          e.stopPropagation();
          openLightbox(r.images, 0);
        });
      }
    }
  });

  document.getElementById('totalAmount').innerText = total.toFixed(2);
  document.getElementById('pendingSummary').innerText = `${pending} pending review`;

  renderMonthNav();
  renderSpendBars();
  if(selectMode) updateBulkActionBar();
}

function monthYearLabel(month, year){
  return new Date(year, month, 1).toLocaleDateString('en-AU', {month:'long', year:'numeric'});
}

function renderMonthNav(){
  document.getElementById('monthNavLabel').innerText = monthYearLabel(viewedMonth, viewedYear);
  document.getElementById('monthPickerInput').value = `${viewedYear}-${String(viewedMonth+1).padStart(2,'0')}`;
}

/* ============================================================
   YEAR GRID — jump to any month in a chosen year at a glance
   ============================================================ */
let yearGridYear = new Date().getFullYear();
const YEAR_GRID_MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function openYearGrid(){
  yearGridYear = viewedYear;
  renderYearGrid();
  document.getElementById('yearGridBackdrop').classList.add('open');
  document.getElementById('yearGridSheet').classList.add('open');
}
function closeYearGrid(){
  document.getElementById('yearGridBackdrop').classList.remove('open');
  document.getElementById('yearGridSheet').classList.remove('open');
}
function renderYearGrid(){
  document.getElementById('yearGridYearLabel').innerText = yearGridYear;
  const folderReceipts = receipts.filter(r=> r.folderId===activeFolderId && r.currency==='AUD');
  const now = new Date();
  const grid = document.getElementById('yearGridMonths');
  grid.innerHTML = '';
  YEAR_GRID_MONTH_ABBR.forEach((label, i)=>{
    const total = folderReceipts
      .filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===yearGridYear && d.getMonth()===i; })
      .reduce((s,r)=> s+(parseFloat(r.amount)||0), 0);
    const isCurrent = i===viewedMonth && yearGridYear===viewedYear;
    const isFuture = yearGridYear > now.getFullYear() || (yearGridYear===now.getFullYear() && i > now.getMonth());
    const cell = document.createElement('div');
    cell.className = 'ygrid-cell' + (isCurrent ? ' current':'') + (total===0 ? ' empty':'');
    cell.innerHTML = `<div class="ygrid-month">${label}</div><div class="ygrid-amount">${total>0 ? '$'+total.toFixed(0) : (isFuture ? '—' : '$0')}</div>`;
    cell.onclick = ()=>{
      viewedMonth = i;
      viewedYear = yearGridYear;
      closeYearGrid();
      renderReceiptList();
    };
    grid.appendChild(cell);
  });
}
document.getElementById('btnOpenYearGrid').onclick = openYearGrid;
document.getElementById('yearGridCloseBtn').onclick = closeYearGrid;
document.getElementById('yearGridBackdrop').onclick = closeYearGrid;
document.getElementById('yearGridPrevBtn').onclick = ()=>{ yearGridYear--; renderYearGrid(); };
document.getElementById('yearGridNextBtn').onclick = ()=>{ yearGridYear++; renderYearGrid(); };

// swipe left/right on the receipt list to move between months — skipped while a
// search/filter is active, since the list isn't scoped to a single month then
(function(){
  const listEl = document.getElementById('receiptList');
  let touchStartX = 0, touchStartY = 0;
  listEl.addEventListener('touchstart', (e)=>{
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, {passive:true});
  listEl.addEventListener('touchend', (e)=>{
    if(hasActiveFilters()) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if(Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)*1.5){
      changeMonth(dx < 0 ? 1 : -1);
    }
  }, {passive:true});
})();

function changeMonth(delta){
  viewedMonth += delta;
  if(viewedMonth > 11){ viewedMonth = 0; viewedYear++; }
  if(viewedMonth < 0){ viewedMonth = 11; viewedYear--; }
  renderReceiptList();
}

function renderSpendBars(){
  const folderReceipts = receipts.filter(r=>r.folderId===activeFolderId && r.currency==='AUD');

  const currentTotal = folderReceipts
    .filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getMonth()===viewedMonth && d.getFullYear()===viewedYear; })
    .reduce((sum,r)=> sum + (parseFloat(r.amount)||0), 0);

  let prevMonth = viewedMonth - 1, prevYear = viewedYear;
  if(prevMonth < 0){ prevMonth = 11; prevYear--; }
  const prevTotal = folderReceipts
    .filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getMonth()===prevMonth && d.getFullYear()===prevYear; })
    .reduce((sum,r)=> sum + (parseFloat(r.amount)||0), 0);

  const maxVal = Math.max(currentTotal, prevTotal, 1); // avoid divide-by-zero when both are 0

  document.getElementById('currentMonthLabel').innerText = monthYearLabel(viewedMonth, viewedYear);
  document.getElementById('currentMonthAmount').innerText = `$${currentTotal.toFixed(2)}`;
  document.getElementById('currentMonthFill').style.width = `${(currentTotal/maxVal)*100}%`;

  document.getElementById('prevMonthLabel').innerText = monthYearLabel(prevMonth, prevYear);
  document.getElementById('prevMonthAmount').innerText = `$${prevTotal.toFixed(2)}`;
  document.getElementById('prevMonthFill').style.width = `${(prevTotal/maxVal)*100}%`;

  document.getElementById('prevMonthRow').onclick = ()=>{
    viewedMonth = prevMonth;
    viewedYear = prevYear;
    renderReceiptList(); // recomputes both bars relative to the newly-selected month
  };
}

/* ============================================================
   ANALYSIS PAGE
   ============================================================ */
let analysisPeriod = 'monthly'; // monthly | quarterly | halfyear | yearly
let analysisYear = new Date().getFullYear();
let analysisFolder = '__all__';

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function openAnalysisPage(){
  // populate folder dropdown fresh (custom folders may have been added since last open)
  const sel = document.getElementById('analysisFolderSelect');
  const prevVal = analysisFolder;
  sel.innerHTML = '<option value="__all__">All folders</option>';
  allFolders().forEach(f=>{
    const opt = document.createElement('option');
    opt.value = f.id; opt.innerText = f.label;
    sel.appendChild(opt);
  });
  sel.value = prevVal;
  renderAnalysisPage();
  document.getElementById('analysisView').classList.add('open');
}
function closeAnalysisPage(){
  document.getElementById('analysisView').classList.remove('open');
}

function getAnalysisReceipts(){
  let list = receipts.filter(r=> r.currency==='AUD');
  if(analysisFolder !== '__all__') list = list.filter(r=> r.folderId===analysisFolder);
  return list;
}

function renderAnalysisPage(){
  document.getElementById('analysisYearLabel').innerText = analysisYear;
  // the year nav is meaningless for the "yearly" comparison view (which spans multiple
  // years by design), so hide it there and only show it for single-year-scoped views
  document.getElementById('analysisYearNav').style.display = analysisPeriod==='yearly' ? 'none' : 'flex';

  const list = getAnalysisReceipts();
  const chart = document.getElementById('analysisChart');
  chart.innerHTML = '';

  let buckets = []; // [{label, total, targetMonth, targetYear}]

  if(analysisPeriod==='monthly'){
    buckets = MONTH_ABBR.map((label, i)=>({
      label,
      total: list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===analysisYear && d.getMonth()===i; })
                  .reduce((s,r)=> s+(parseFloat(r.amount)||0), 0),
      targetMonth: i, targetYear: analysisYear
    }));
  } else if(analysisPeriod==='quarterly'){
    buckets = [0,1,2,3].map(q=>({
      label: `Q${q+1}`,
      total: list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===analysisYear && Math.floor(d.getMonth()/3)===q; })
                  .reduce((s,r)=> s+(parseFloat(r.amount)||0), 0),
      targetMonth: q*3, targetYear: analysisYear
    }));
  } else if(analysisPeriod==='halfyear'){
    buckets = [0,1].map(h=>({
      label: h===0 ? 'H1 (Jan–Jun)' : 'H2 (Jul–Dec)',
      total: list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===analysisYear && Math.floor(d.getMonth()/6)===h; })
                  .reduce((s,r)=> s+(parseFloat(r.amount)||0), 0),
      targetMonth: h*6, targetYear: analysisYear
    }));
  } else if(analysisPeriod==='yearly'){
    // compare the 5 years ending at analysisYear, so "year nav" (hidden here) isn't
    // needed — instead this view always shows a trailing 5-year window anchored to today
    const endYear = new Date().getFullYear();
    const startYear = endYear - 4;
    buckets = [];
    for(let y=startYear; y<=endYear; y++){
      buckets.push({
        label: String(y),
        total: list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===y; })
                    .reduce((s,r)=> s+(parseFloat(r.amount)||0), 0),
        targetMonth: 0, targetYear: y
      });
    }
  }

  const maxVal = Math.max(...buckets.map(b=>b.total), 1);
  const rangeTotal = buckets.reduce((s,b)=> s+b.total, 0);
  document.getElementById('analysisTotalAmount').innerText = rangeTotal.toFixed(2);

  buckets.forEach(b=>{
    const row = document.createElement('div');
    row.className = 'achart-row';
    row.style.cursor = 'pointer';
    row.innerHTML = `
      <div class="achart-label">${b.label}</div>
      <div class="achart-track"><div class="achart-fill" style="width:${(b.total/maxVal)*100}%"></div></div>
      <div class="achart-value">$${b.total.toFixed(0)}</div>
    `;
    row.onclick = ()=>{
      // leaving Analysis is a bigger jump than the dashboard's own month bars, so this
      // asks first — an accidental tap here shouldn't unexpectedly dump you out of the
      // page you were just analysing
      const periodLabel = monthYearLabel(b.targetMonth, b.targetYear);
      if(!confirm(`View receipts for ${periodLabel}? This will leave the Analysis page.`)) return;
      viewedMonth = b.targetMonth;
      viewedYear = b.targetYear;
      closeAnalysisPage();
      renderReceiptList();
    };
    chart.appendChild(row);
  });

  // category breakdown across whatever date range the buckets above cover
  let rangeReceipts;
  if(analysisPeriod==='yearly'){
    const endYear = new Date().getFullYear(), startYear = endYear-4;
    rangeReceipts = list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()>=startYear && d.getFullYear()<=endYear; });
  } else {
    rangeReceipts = list.filter(r=>{ const d=new Date((r.date||'')+'T00:00:00'); return d.getFullYear()===analysisYear; });
  }
  const catTotals = {};
  rangeReceipts.forEach(r=>{
    const cat = r.category || 'Misc';
    catTotals[cat] = (catTotals[cat]||0) + (parseFloat(r.amount)||0);
  });
  const sortedCats = Object.entries(catTotals).sort((a,b)=> b[1]-a[1]);
  const catContainer = document.getElementById('analysisCatBreakdown');
  catContainer.innerHTML = '';
  if(sortedCats.length===0){
    catContainer.innerHTML = '<p style="font-size:12.5px; color:var(--ink-soft);">No receipts in this range yet.</p>';
  } else {
    const catRangeTotal = sortedCats.reduce((s,[,amt])=> s+amt, 0);
    // "yearly" tab spans a trailing 5-year window (60 months); every other tab is
    // scoped to a single calendar year (12 months) regardless of which sub-period
    // (monthly/quarterly/halfyear) is selected, since the category totals above are
    // always computed across the full year, not just the visible buckets.
    const monthsInRange = analysisPeriod==='yearly' ? 60 : 12;
    sortedCats.forEach(([cat, amt])=>{
      const pct = catRangeTotal>0 ? Math.round((amt/catRangeTotal)*100) : 0;
      const avgPerMonth = Math.round(amt / monthsInRange);
      const row = document.createElement('div');
      row.className = 'acat-row';
      row.style.cursor = 'pointer';
      row.innerHTML = `
        <div class="acat-name"><span class="acat-dot" style="background:${categoryColor(cat)}"></span>${escapeHtml(cat)}</div>
        <div class="acat-amount">$${amt.toFixed(2)} <span style="color:var(--ink-soft); font-weight:400;">(${pct}% · ~$${avgPerMonth}/mo)</span></div>
      `;
      row.onclick = ()=>{
        // jump into the filtered receipt list for this category — also switch the
        // active folder tab to match whatever this analysis was scoped to, so the
        // filtered results aren't silently narrower/wider than what was just shown
        if(analysisFolder !== '__all__') activeFolderId = analysisFolder;
        activeFilters = { query:'', category:cat, dateFrom:'', dateTo:'' };
        closeAnalysisPage();
        renderAll();
        showToast(`Showing ${cat} receipts`);
      };
      catContainer.appendChild(row);
    });
  }
}

document.getElementById('btnOpenAnalysis').onclick = openAnalysisPage;
document.getElementById('analysisCloseBtn').onclick = closeAnalysisPage;

document.querySelectorAll('.period-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.period-tab').forEach(t=> t.classList.remove('active'));
    tab.classList.add('active');
    analysisPeriod = tab.dataset.period;
    renderAnalysisPage();
  });
});

document.getElementById('analysisYearPrev').onclick = ()=>{ analysisYear--; renderAnalysisPage(); };
document.getElementById('analysisYearNext').onclick = ()=>{ analysisYear++; renderAnalysisPage(); };
document.getElementById('analysisFolderSelect').addEventListener('change', (e)=>{
  analysisFolder = e.target.value;
  renderAnalysisPage();
});

function categoryColor(cat){
  const palette = {Meals:'#C48A3F', Fuel:'#4E6B58', Materials:'#7A9482', Software:'#5B7FA6', Travel:'#8C7AA9', Utilities:'#B0503F', Office:'#4E6B58', Tools:'#7A9482', Parking:'#C48A3F', Subscriptions:'#5B7FA6', Health:'#B0503F', Misc:'#5B6B60'};
  return palette[cat] || '#5B6B60';
}
function formatDate(d){
  if(!d) return '—';
  const dt = new Date(d+'T00:00:00');
  return dt.toLocaleDateString('en-AU', {day:'numeric', month:'short', year:'numeric'});
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderAll(){ renderFolderTabs(); renderReceiptList(); persistState(); updateStickyOffset(); }

// the topbar's height isn't fixed (folder chip width, pending-review text length can
// wrap differently), so the filter row's sticky offset is measured dynamically rather
// than hardcoded — re-measured after every render in case content height changed
let stickyObserver = null;
function updateStickyOffset(){
  const topbar = document.querySelector('.topbar');
  const sectionLabel = document.getElementById('sectionLabelRow');
  if(!topbar || !sectionLabel) return;
  const h = topbar.offsetHeight;
  sectionLabel.style.top = h + 'px';

  // adds a subtle border/shadow to the filter row only once it's actually stuck in
  // place — rootMargin is shifted by the topbar height so "pinned" triggers exactly
  // when the sticky point is reached, not just when scrolled past the raw viewport top
  if(stickyObserver) stickyObserver.disconnect();
  stickyObserver = new IntersectionObserver((entries)=>{
    entries.forEach(entry=>{
      sectionLabel.classList.toggle('pinned', !entry.isIntersecting);
    });
  }, { threshold:0, rootMargin: `-${h}px 0px 0px 0px` });
  stickyObserver.observe(document.getElementById('stickySentinel'));
}
window.addEventListener('resize', updateStickyOffset);
document.getElementById('versionBadge').innerText = 'v' + APP_VERSION;

document.getElementById('monthPrevBtn').onclick = ()=> changeMonth(-1);
document.getElementById('monthNextBtn').onclick = ()=> changeMonth(1);
document.getElementById('monthTodayBtn').onclick = ()=>{
  viewedMonth = new Date().getMonth();
  viewedYear = new Date().getFullYear();
  renderReceiptList();
};
// native month/year wheel picker overlays the label — tap to open, no typing required
document.getElementById('monthPickerInput').addEventListener('change', (e)=>{
  const m = e.target.value.match(/^(\d{4})-(\d{2})$/);
  if(m){
    viewedYear = parseInt(m[1],10);
    viewedMonth = parseInt(m[2],10) - 1;
    renderReceiptList();
  }
});

// on startup: check for a remembered session (so closing/reopening the app doesn't
// force re-login every time — logout is what clears this, same as most real apps)
async function completeLogin(username){
  currentUser = username;
  localStorage.setItem('ledger_session_user', username);
  await loadPersistedState();
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appRoot').style.display = 'block';
  document.getElementById('currentUserIndicator').innerText = `👤 ${username}`;
  renderAll();
  if(typeof renderBackupStatus === 'function') renderBackupStatus();
  if(typeof maybeAutoBackup === 'function') maybeAutoBackup('login');
  if(typeof maybeShowAutoRestoreBanner === 'function') maybeShowAutoRestoreBanner();
}

function attemptLogin(){
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  const match = USERS.find(u=> u.username===username && u.password===password);
  if(!match){
    errorEl.innerText = 'Incorrect username or password.';
    errorEl.style.display = 'block';
    return;
  }
  errorEl.style.display = 'none';
  completeLogin(match.username);
}

document.getElementById('btnLogin').onclick = attemptLogin;
document.getElementById('loginPassword').addEventListener('keydown', (e)=>{
  if(e.key==='Enter') attemptLogin();
});
document.getElementById('loginVersionBadge').innerText = 'v' + APP_VERSION;

(async function initApp(){
  const rememberedUser = localStorage.getItem('ledger_session_user');
  if(rememberedUser && USERS.some(u=>u.username===rememberedUser)){
    await completeLogin(rememberedUser);
  }
  // otherwise the login screen (visible by default) just waits for input
})();

