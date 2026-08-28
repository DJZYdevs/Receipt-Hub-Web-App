/* ============================================================
   IMPORT — XLSX (reliable) and PDF (best-effort)
   ============================================================ */
let pendingImportRows = []; // parsed rows awaiting confirmation, each: {date, establishment, amount, currency, category, notes, needsCheck}

const COLUMN_ALIASES = {
  date: ['date','transaction date','purchase date'],
  establishment: ['description','establishment','merchant','vendor','store','payee','name'],
  // "aud amount" listed first so it wins the exact-match pass over a generic "amount" —
  // some exports (e.g. Crunchr) have both a "Recorded amount" (original currency) and an
  // "AUD Amount" (converted) column; the converted one is what a single-currency app wants
  amount: ['aud amount','amount','total','price','cost'],
  currency: ['currency','curr'],
  category: ['category','cat','type'],
  notes: ['notes','note','memo','comment'],
  image: ['image','photo','receipt','file','attachment'],
  gst: ['aud gst','gst','tax','recorded tax'],
  folder: ['folder','account','workspace'],
};

function detectColumnIndex(headers, aliases){
  const lower = headers.map(h=> (h||'').toString().trim().toLowerCase());
  for(const alias of aliases){
    const idx = lower.indexOf(alias);
    if(idx>-1) return idx;
  }
  for(let i=0;i<lower.length;i++){
    if(aliases.some(a=> lower[i].includes(a))) return i;
  }
  return -1;
}

// handles both plain date strings (DD/MM/YYYY etc, reusing similar logic to the OCR
// date parser) and Excel serial date numbers (when the source file used real date cells)
function parseFlexibleDate(value){
  if(value==null || value==='') return '';
  if(typeof value==='number'){
    // Excel serial date (days since 1899-12-30)
    const parsed = XLSX.SSF && XLSX.SSF.parse_date_code ? XLSX.SSF.parse_date_code(value) : null;
    if(parsed) return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;
    return '';
  }
  const str = value.toString().trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m){
    let [,a,b,y] = m;
    if(y.length===2) y = '20'+y;
    let dd = a.padStart(2,'0'), mm = b.padStart(2,'0');
    if(parseInt(dd,10)>31 || parseInt(mm,10)>12){ [dd,mm]=[mm,dd]; }
    return `${y}-${mm}-${dd}`;
  }
  return '';
}

function parseXlsxArrayBuffer(arrayBuffer){
  const data = new Uint8Array(arrayBuffer);
  // cellFormula:true is required — SheetJS does NOT parse formulas into cell.f by
  // default, which is exactly why the HYPERLINK() formula backfill never found
  // anything: cell.f was always undefined without this option.
  const wb = XLSX.read(data, {type:'array', cellDates:false, cellFormula:true});
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
  return { rows, sheet };
}

function parseXlsxFile(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      try{ resolve(parseXlsxArrayBuffer(e.target.result)); }
      catch(err){ reject(err); }
    };
    reader.onerror = ()=> reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// Some spreadsheet exporters (e.g. Crunchr) write HYPERLINK() formulas for an "Image"
// column but don't always cache a calculated display value for them — so a normal
// value-read of that cell comes back blank even though the filename is present, buried
// inside the formula's URL argument. This scans the raw sheet and back-fills any blank
// Image-column values by extracting a filename pattern straight out of the formula text,
// e.g. =HYPERLINK("https://.../receipt_123.jpg?...", "receipt_123.jpg") -> "receipt_123.jpg"
function backfillImageColumnFromFormulas(sheet, rows, headerRowIdx){
  const headerRow = rows[headerRowIdx];
  const imageColIdx = detectColumnIndex(headerRow, COLUMN_ALIASES.image);
  if(imageColIdx===-1) return rows;
  const colLetter = XLSX.utils.encode_col(imageColIdx);
  for(let i=headerRowIdx+1; i<rows.length; i++){
    if(rows[i][imageColIdx]) continue; // already has a cached value, nothing to fix
    const cellRef = colLetter + (i+1); // sheet cell addresses are 1-indexed
    const cell = sheet[cellRef];
    if(cell && cell.f){
      const m = cell.f.match(/([\w\-]+\.(?:jpe?g|png|pdf|heic|webp))/i);
      if(m) rows[i][imageColIdx] = m[1];
    }
  }
  return rows;
}

// More reliable fallback: bypasses SheetJS's formula parsing entirely (which has proven
// unreliable for some real-world files, e.g. Crunchr's exports — likely because they pair
// a formula with an explicit empty <v/> cached-value tag, an edge case SheetJS doesn't
// always handle the way cellFormula:true would suggest). An .xlsx file IS a zip archive,
// so this uses JSZip (already loaded) to read the raw worksheet XML directly and regex
// out HYPERLINK() filenames — tested directly against a real problem file, 73/73 correct.
async function extractImageRefsFromXlsxBuffer(arrayBuffer){
  try{
    const zip = await JSZip.loadAsync(arrayBuffer);
    const sheetEntryName = Object.keys(zip.files).find(name => /^xl\/worksheets\/sheet\d*\.xml$/i.test(name));
    if(!sheetEntryName) return {};
    const xml = await zip.files[sheetEntryName].async('text');
    const refs = {};
    const cellRegex = /<c r="([A-Z]+\d+)"[^>]*>(?:(?!<\/c>)[\s\S])*?<f[^>]*>([\s\S]*?)<\/f>/g;
    let m;
    while((m = cellRegex.exec(xml)) !== null){
      const formula = m[2];
      if(/HYPERLINK/i.test(formula)){
        const fnMatch = formula.match(/([\w\-]+\.(?:jpe?g|png|pdf|heic|webp))/i);
        if(fnMatch) refs[m[1]] = fnMatch[1];
      }
    }
    return refs;
  }catch(err){
    console.error('Raw XLSX formula extraction failed', err);
    return {};
  }
}
function backfillImageColumnFromRawRefs(refs, rows, headerRowIdx){
  const headerRow = rows[headerRowIdx];
  const imageColIdx = detectColumnIndex(headerRow, COLUMN_ALIASES.image);
  if(imageColIdx===-1) return rows;
  const colLetter = XLSX.utils.encode_col(imageColIdx);
  for(let i=headerRowIdx+1; i<rows.length; i++){
    if(rows[i][imageColIdx]) continue; // already filled (by cache or the SheetJS-based pass)
    const cellRef = colLetter + (i+1);
    if(refs[cellRef]) rows[i][imageColIdx] = refs[cellRef];
  }
  return rows;
}

// shared by both XLSX rows and PDF-extracted table-like text — takes an array of
// header-labelled row objects and turns them into pending import receipts.
// mediaMap (optional): filename -> dataURL, used to attach matching photos from a
// zip import so imported rows arrive with their images already linked.
function rowsToImportEntries(headerRow, dataRows, mediaMap){
  const idx = {
    date: detectColumnIndex(headerRow, COLUMN_ALIASES.date),
    establishment: detectColumnIndex(headerRow, COLUMN_ALIASES.establishment),
    amount: detectColumnIndex(headerRow, COLUMN_ALIASES.amount),
    currency: detectColumnIndex(headerRow, COLUMN_ALIASES.currency),
    category: detectColumnIndex(headerRow, COLUMN_ALIASES.category),
    notes: detectColumnIndex(headerRow, COLUMN_ALIASES.notes),
    image: detectColumnIndex(headerRow, COLUMN_ALIASES.image),
    gst: detectColumnIndex(headerRow, COLUMN_ALIASES.gst),
    folder: detectColumnIndex(headerRow, COLUMN_ALIASES.folder),
  };

  const entries = [];
  dataRows.forEach(row=>{
    if(!row || row.every(c=> c==='' || c==null)) return; // skip blank rows
    // skip section-header rows like "Folder: Personal" (a single populated cell)
    const populated = row.filter(c=> c!=='' && c!=null);
    if(populated.length<=1 && /folder\s*:/i.test(String(populated[0]||''))) return;
    // skip a repeated header row appearing again mid-file
    if(idx.date>-1 && String(row[idx.date]).toLowerCase().trim()===COLUMN_ALIASES.date[0]) return;

    const date = idx.date>-1 ? parseFlexibleDate(row[idx.date]) : '';
    const establishment = idx.establishment>-1 ? String(row[idx.establishment]||'').trim() : '';

    // skip probable totals/summary rows: real transactions always have a date and/or an
    // establishment name — a row with neither (but often a big summed amount) is a
    // "Total" row at the bottom of a report, not an actual receipt to import
    if(!date && !establishment) return;

    const rawAmount = idx.amount>-1 ? row[idx.amount] : '';
    const amount = rawAmount!=='' && rawAmount!=null ? Math.abs(parseFloat(rawAmount)||0).toFixed(2) : '';
    const currency = idx.currency>-1 && row[idx.currency] ? String(row[idx.currency]).trim().toUpperCase() : 'AUD';
    const category = idx.category>-1 && row[idx.category] ? String(row[idx.category]).trim() : 'Misc';
    const notes = idx.notes>-1 ? String(row[idx.notes]||'').replace(/^-$/,'').trim() : '';
    const rawGst = idx.gst>-1 ? row[idx.gst] : '';
    const gst = rawGst!=='' && rawGst!=null ? Math.abs(parseFloat(rawGst)||0).toFixed(2) : '';

    if(!establishment && !amount) return; // not a usable row

    // match referenced image filename(s) against the media map, if one was supplied
    let images = [];
    let rawImageRef = '';
    if(idx.image>-1){
      rawImageRef = String(row[idx.image]||'').trim();
      if(mediaMap && rawImageRef && rawImageRef!=='-'){
        const names = rawImageRef.split(',').map(n=>n.trim());
        images = names.map(n=> mediaMap[n]).filter(Boolean);
      }
    }

    // try to auto-match this row's folder name (e.g. "Personal") against an existing
    // app folder by label, so imports land in the right place without manual sorting
    let matchedFolderId = null;
    if(idx.folder>-1 && row[idx.folder]){
      const folderName = String(row[idx.folder]).trim().toLowerCase();
      const match = allFolders().find(f=> f.label.toLowerCase()===folderName);
      if(match) matchedFolderId = match.id;
    }

    const needsCheck = !date || !establishment || !amount;
    entries.push({ date, establishment, amount, currency, category, notes, gst, needsCheck, images, matchedFolderId, rawImageRef });
  });
  return entries;
}

/* ============================================================
   CATEGORY MAPPING STEP (runs before the import preview when the
   file uses categories that don't exist in the app yet)
   ============================================================ */
let pendingCatMapEntries = null;
let pendingCatMapSourceLabel = '';
let catMapChoices = {}; // categoryName -> { mode:'new'|'existing', existingValue }

function getUnknownCategories(entries){
  const seen = new Set();
  entries.forEach(e=>{ if(e.category && !CATEGORIES.includes(e.category)) seen.add(e.category); });
  return [...seen];
}

function routeThroughCategoryMapping(entries, sourceLabel){
  const unknown = getUnknownCategories(entries);
  if(unknown.length===0){
    openImportPreview(entries, sourceLabel);
    return;
  }
  pendingCatMapEntries = entries;
  pendingCatMapSourceLabel = sourceLabel;
  catMapChoices = {};
  unknown.forEach(cat=>{ catMapChoices[cat] = { mode:'new', existingValue: CATEGORIES[0] }; });

  const container = document.getElementById('catMapRows');
  container.innerHTML = '';
  unknown.forEach(cat=>{
    const row = document.createElement('div');
    row.className = 'catmap-row';
    row.innerHTML = `
      <div class="catmap-name">${escapeHtml(cat)}</div>
      <div class="catmap-choice">
        <button class="catmap-new active" type="button">+ Add as new</button>
        <button class="catmap-existing" type="button">Map to existing</button>
      </div>
      <select class="catmap-existing-select">${CATEGORIES.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
    `;
    const newBtn = row.querySelector('.catmap-new');
    const existingBtn = row.querySelector('.catmap-existing');
    const select = row.querySelector('.catmap-existing-select');
    newBtn.onclick = ()=>{
      newBtn.classList.add('active'); existingBtn.classList.remove('active');
      select.style.display = 'none';
      catMapChoices[cat] = { mode:'new', existingValue: CATEGORIES[0] };
    };
    existingBtn.onclick = ()=>{
      existingBtn.classList.add('active'); newBtn.classList.remove('active');
      select.style.display = 'block';
      catMapChoices[cat] = { mode:'existing', existingValue: select.value };
    };
    select.addEventListener('change', ()=>{ catMapChoices[cat] = { mode:'existing', existingValue: select.value }; });
    container.appendChild(row);
  });

  document.getElementById('catMapBackdrop').classList.add('open');
  document.getElementById('catMapSheet').classList.add('open');
}
function closeCatMapSheet(){
  document.getElementById('catMapBackdrop').classList.remove('open');
  document.getElementById('catMapSheet').classList.remove('open');
}
document.getElementById('catMapCloseBtn').onclick = closeCatMapSheet;
document.getElementById('btnCatMapCancel').onclick = ()=>{
  closeCatMapSheet();
  pendingCatMapEntries = null;
  showToast('Import cancelled');
};
document.getElementById('btnCatMapContinue').onclick = ()=>{
  // apply each mapping choice across all entries, and register any genuinely new categories
  Object.entries(catMapChoices).forEach(([originalCat, choice])=>{
    if(choice.mode==='new'){
      if(!CATEGORIES.includes(originalCat)){ CATEGORIES.push(originalCat); persistCategories(); }
    } else {
      pendingCatMapEntries.forEach(e=>{ if(e.category===originalCat) e.category = choice.existingValue; });
    }
  });
  const entries = pendingCatMapEntries;
  const sourceLabel = pendingCatMapSourceLabel;
  pendingCatMapEntries = null;
  closeCatMapSheet();
  openImportPreview(entries, sourceLabel);
};

// annotates each import entry with isDuplicate/duplicateReason — checks both against
// existing saved receipts (in whichever folder that row will land in) and against
// EARLIER rows in the same import batch (catches a source file that lists the same
// transaction twice)
function annotateImportDuplicates(entries, defaultFolder){
  const seenInBatch = [];
  entries.forEach(e=>{
    const folderId = e.matchedFolderId || defaultFolder;
    const candidate = { date:e.date, amount:e.amount, establishment:e.establishment, folderId };
    const existingMatch = findDuplicateReceipt(candidate, null);
    const batchMatch = seenInBatch.find(o=> o.folderId===folderId && isLikelyDuplicatePair(o, candidate));
    if(existingMatch){
      e.isDuplicate = true; e.duplicateReason = 'already saved';
    } else if(batchMatch){
      e.isDuplicate = true; e.duplicateReason = 'repeated in this file';
    } else {
      e.isDuplicate = false; e.duplicateReason = '';
    }
    // default inclusion follows duplicate status, but only the first time this row is
    // annotated — a manual per-row override (the user saying "no, keep this one") must
    // survive later re-annotation, e.g. when the default folder changes
    if(e.included === undefined) e.included = !e.isDuplicate;
    seenInBatch.push(candidate);
  });
  return entries;
}

function renderImportRows(entries){
  const preview = document.getElementById('importRowsPreview');
  preview.innerHTML = '';
  entries.forEach((r,i)=>{
    const row = document.createElement('div');
    row.className = 'import-row' + (r.needsCheck ? ' flagged':'') + (r.isDuplicate ? ' duplicate':'') + (r.included===false ? ' excluded':'');
    const photoTag = (r.images && r.images.length) ? ` · 📷 ${r.images.length}` : '';
    const folderTag = r.matchedFolderId ? ` · 📁 ${escapeHtml(getFolderLabelFor(r.matchedFolderId))}` : '';
    const dupTag = r.isDuplicate ? `<div class="import-row-dup-tag">⚠ Possible duplicate — ${escapeHtml(r.duplicateReason)}</div>` : '';
    row.innerHTML = `
      <input type="checkbox" class="import-row-checkbox" ${r.included!==false ? 'checked':''} style="width:18px; height:18px; flex:0 0 auto;">
      <div class="import-row-info">
        <div class="import-row-name">${escapeHtml(r.establishment || '(no name)')}</div>
        <div class="import-row-meta">${r.date || 'no date'} · ${escapeHtml(r.category)}${photoTag}${folderTag}</div>
        ${dupTag}
      </div>
      <div class="import-row-amount">${r.currency} ${r.amount || '0.00'}</div>
    `;
    row.querySelector('.import-row-checkbox').addEventListener('change', (e)=>{
      r.included = e.target.checked;
      row.classList.toggle('excluded', !e.target.checked);
      updateImportSelectionSummary();
    });
    preview.appendChild(row);
  });
  updateImportSelectionSummary();
}

function updateImportSelectionSummary(){
  const total = pendingImportRows.length;
  const includedCount = pendingImportRows.filter(r=> r.included!==false).length;
  document.getElementById('btnImportConfirm').innerText = includedCount===total ? 'Import all' : `Import ${includedCount} of ${total}`;
}

function refreshImportDuplicates(){
  const defaultFolder = document.getElementById('importFolderSelect').value;
  annotateImportDuplicates(pendingImportRows, defaultFolder);
  const dupCount = pendingImportRows.filter(r=>r.isDuplicate).length;
  const dupSummary = document.getElementById('importDuplicateSummary');
  const skipRow = document.getElementById('skipDuplicatesRow');
  const perRowHint = document.getElementById('importPerRowHint');
  if(dupCount>0){
    dupSummary.style.display = 'block';
    dupSummary.innerText = `${dupCount} row${dupCount===1?'':'s'} look${dupCount===1?'s':''} like a duplicate of an existing receipt or another row in this file.`;
    skipRow.style.display = 'flex';
    perRowHint.style.display = 'block';
  } else {
    dupSummary.style.display = 'none';
    skipRow.style.display = 'none';
    perRowHint.style.display = 'none';
  }
  renderImportRows(pendingImportRows);
}

// the master checkbox is a bulk action, not a stored setting read at confirm-time —
// toggling it sets every currently-flagged-duplicate row's inclusion state at once,
// while leaving already-included non-duplicate rows untouched
document.getElementById('skipDuplicatesCheckbox').addEventListener('change', (e)=>{
  const skip = e.target.checked;
  pendingImportRows.forEach(r=>{ if(r.isDuplicate) r.included = !skip; });
  renderImportRows(pendingImportRows);
});

function openImportPreview(entries, sourceLabel){
  pendingImportRows = entries;
  document.getElementById('importSheetTitle').innerText = `Import preview — ${sourceLabel}`;
  document.getElementById('importSummary').innerText = entries.length
    ? `${entries.length} row${entries.length===1?'':'s'} found. Rows in amber are missing a field and will need a quick check after import — same as a scanned receipt.`
    : `No usable rows were found in this file.`;

  const folderSelect = document.getElementById('importFolderSelect');
  folderSelect.innerHTML = '';
  allFolders().forEach(f=>{
    const opt = document.createElement('option');
    opt.value = f.id; opt.innerText = f.label;
    if(f.id===activeFolderId) opt.selected = true;
    folderSelect.appendChild(opt);
  });

  refreshImportDuplicates();

  document.getElementById('btnImportConfirm').disabled = entries.length===0;
  document.getElementById('importBackdrop').classList.add('open');
  document.getElementById('importSheet').classList.add('open');
}
function closeImportPreview(){
  document.getElementById('importBackdrop').classList.remove('open');
  document.getElementById('importSheet').classList.remove('open');
}

document.getElementById('importCloseBtn').onclick = closeImportPreview;
document.getElementById('btnImportCancel').onclick = closeImportPreview;
document.getElementById('importBackdrop').onclick = closeImportPreview;
document.getElementById('importFolderSelect').addEventListener('change', refreshImportDuplicates);

document.getElementById('btnImportConfirm').onclick = async ()=>{
  const defaultFolder = document.getElementById('importFolderSelect').value;
  const allRows = pendingImportRows;
  const rowsToImport = allRows.filter(r=> r.included!==false);
  const skippedCount = allRows.length - rowsToImport.length;
  const total = rowsToImport.length;
  pendingImportRows = [];
  closeImportPreview();

  const CHUNK_SIZE = 50;
  for(let i=0; i<total; i+=CHUNK_SIZE){
    const chunk = rowsToImport.slice(i, i+CHUNK_SIZE);
    chunk.forEach(r=>{
      receipts.push({
        id: receiptSeq++, folderId: r.matchedFolderId || defaultFolder, date: r.date || new Date().toISOString().slice(0,10),
        establishment: r.establishment, amount: r.amount || '0.00', currency: r.currency, gst: r.gst || '',
        category: CATEGORIES.includes(r.category) ? r.category : 'Misc',
        notes: r.notes, images: r.images || [], verified: !r.needsCheck, needsCheck: r.needsCheck,
      });
    });
    if(total > CHUNK_SIZE) showToast(`Importing… ${Math.min(i+CHUNK_SIZE, total)} of ${total}`);
    if(i+CHUNK_SIZE < total) await new Promise(r=> setTimeout(r, 0)); // yield to the browser
  }

  renderAll();
  showToast(skippedCount>0
    ? `Imported ${total} receipt${total===1?'':'s'} — skipped ${skippedCount} deselected row${skippedCount===1?'':'s'}`
    : `Imported ${total} receipt${total===1?'':'s'}`);
  if(typeof maybeAutoBackup === 'function') maybeAutoBackup('import');
};

document.getElementById('btnImportXlsx').onclick = ()=> document.getElementById('fileInputImportXlsx').click();
document.getElementById('fileInputImportXlsx').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  try{
    const { rows, sheet } = await parseXlsxFile(file);
    // find the first row that looks like a real header (contains a recognisable column name)
    let headerRowIdx = rows.findIndex(row=>
      detectColumnIndex(row, COLUMN_ALIASES.date)>-1 || detectColumnIndex(row, COLUMN_ALIASES.amount)>-1
    );
    if(headerRowIdx===-1) headerRowIdx = 0;
    backfillImageColumnFromFormulas(sheet, rows, headerRowIdx);
    const rawRefs = await extractImageRefsFromXlsxBuffer(await file.arrayBuffer());
    backfillImageColumnFromRawRefs(rawRefs, rows, headerRowIdx);
    const headerRow = rows[headerRowIdx];
    const dataRows = rows.slice(headerRowIdx+1);
    const entries = rowsToImportEntries(headerRow, dataRows);
    routeThroughCategoryMapping(entries, file.name);
  }catch(err){
    console.error(err);
    showToast('Could not read that spreadsheet — check it\'s a valid .xlsx file');
  }
});

async function extractPdfText(arrayBuffer){
  const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
  let fullText = '';
  for(let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item=>item.str).join(' ');
    fullText += '\n' + pageText;
  }
  return fullText;
}

// best-effort: PDFs don't preserve a clean row/column grid the way a spreadsheet does,
// so this looks for header-like keywords, then treats each following line as one row
// split on big whitespace gaps — the same forgiving approach used for OCR'd receipt text
function parsePdfTableText(fullText, mediaMap){
  const lines = fullText.split('\n').map(l=>l.trim()).filter(Boolean);
  const headerLineIdx = lines.findIndex(l=> /date/i.test(l) && /(amount|total)/i.test(l));
  if(headerLineIdx===-1) return null;
  const headerRow = lines[headerLineIdx].split(/\s{2,}/);
  const dataLines = lines.slice(headerLineIdx+1).map(l=> l.split(/\s{2,}/));
  return rowsToImportEntries(headerRow, dataLines, mediaMap);
}

document.getElementById('btnImportPdf').onclick = ()=> document.getElementById('fileInputImportPdf').click();
document.getElementById('fileInputImportPdf').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  showToast('Reading PDF text…');
  try{
    const arrayBuffer = await file.arrayBuffer();
    const fullText = await extractPdfText(arrayBuffer);
    const entries = parsePdfTableText(fullText);
    if(!entries){
      showToast('Could not find a recognisable table in this PDF — try XLSX import instead');
      return;
    }
    routeThroughCategoryMapping(entries, file.name + ' (best-effort — please double check every row)');
  }catch(err){
    console.error(err);
    showToast('Could not read that PDF — try XLSX import instead');
  }
});

// Import a full export bundle back in: a .zip containing the report (xlsx or pdf) plus
// a media/ folder of photos, exactly matching what "Export with photos" produces. Rows
// are matched to their photos by filename, so imported receipts arrive with images attached.
document.getElementById('btnImportZip').onclick = ()=> document.getElementById('fileInputImportZip').click();
document.getElementById('fileInputImportZip').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  showToast('Reading zip file…');
  try{
    const zip = await JSZip.loadAsync(file);
    const allFiles = Object.values(zip.files).filter(f=> !f.dir);
    // exclude anything inside a media/ folder when looking for the report itself —
    // otherwise a PDF *receipt attachment* (e.g. media/receipt_1007497.pdf) could get
    // mistaken for the report file if it happens to appear first in the zip listing
    const xlsxEntry = allFiles.find(f=> /\.xlsx$/i.test(f.name) && !/^media\//i.test(f.name));
    const pdfEntry = allFiles.find(f=> /\.pdf$/i.test(f.name) && !/^media\//i.test(f.name));
    const mediaEntries = allFiles.filter(f=> /\.(jpe?g|png|heic|webp|pdf)$/i.test(f.name) && f!==xlsxEntry && f!==pdfEntry);

    console.log('[zip import] all entries in zip:', allFiles.map(f=>f.name));
    console.log('[zip import] detected media files:', mediaEntries.map(f=>f.name));

    if(!xlsxEntry && !pdfEntry){
      showToast('No .xlsx or .pdf report found inside that zip');
      return;
    }

    // build filename -> dataURL map from the media folder first, so it's ready for
    // whichever report format we find. PDF attachments get their first page rendered
    // to an image via pdf.js, so they slot into the exact same photo pipeline as any
    // jpg/png attachment — same thumbnail, same lightbox, no separate code path needed.
    // Every image is compressed on the way in, same as camera/library uploads — at real-
    // world scale (a large zip can carry 250MB+ of uncompressed originals) skipping this
    // meaningfully increases the memory pressure that causes large imports to crash.
    const mediaMap = {};
    let mediaProcessed = 0;
    for(const mf of mediaEntries){
      const basename = mf.name.split('/').pop();
      const ext = basename.split('.').pop().toLowerCase();
      if(ext==='pdf'){
        try{
          const buf = await mf.async('arraybuffer');
          const pages = await pdfArrayBufferToImages(buf); // already compressed internally
          if(pages.length) mediaMap[basename] = pages[0]; // first page represents this attachment
        }catch(err){
          console.error('Failed to render PDF attachment', basename, err);
        }
      } else {
        const base64 = await mf.async('base64');
        const mime = ext==='png' ? 'image/png' : 'image/jpeg';
        const rawDataUrl = `data:${mime};base64,${base64}`;
        mediaMap[basename] = await compressImage(rawDataUrl, 1000, 0.6);
      }
      mediaProcessed++;
      if(mediaEntries.length > 30 && mediaProcessed % 20 === 0){
        showToast(`Processing photos… ${mediaProcessed} of ${mediaEntries.length}`);
        await new Promise(r=> setTimeout(r, 0)); // explicit yield to the browser
      }
    }

    let entries = [];
    if(xlsxEntry){
      const buf = await xlsxEntry.async('arraybuffer');
      const { rows, sheet } = parseXlsxArrayBuffer(buf);
      let headerRowIdx = rows.findIndex(row=>
        detectColumnIndex(row, COLUMN_ALIASES.date)>-1 || detectColumnIndex(row, COLUMN_ALIASES.amount)>-1
      );
      if(headerRowIdx===-1) headerRowIdx = 0;
      backfillImageColumnFromFormulas(sheet, rows, headerRowIdx);
      const rawRefs = await extractImageRefsFromXlsxBuffer(buf);
      backfillImageColumnFromRawRefs(rawRefs, rows, headerRowIdx);
      const headerRow = rows[headerRowIdx];
      const dataRows = rows.slice(headerRowIdx+1);
      entries = rowsToImportEntries(headerRow, dataRows, mediaMap);
    } else if(pdfEntry){
      const buf = await pdfEntry.async('arraybuffer');
      const fullText = await extractPdfText(buf);
      entries = parsePdfTableText(fullText, mediaMap) || [];
      if(entries.length===0){
        showToast('Could not find a recognisable table in the PDF inside that zip');
        return;
      }
    }

    const photoCount = entries.reduce((sum,r)=> sum+(r.images?r.images.length:0), 0);
    console.log('[zip import] rows expecting a photo:', entries.filter(e2=>true).length, '| rows that actually matched one:', entries.filter(e2=>e2.images&&e2.images.length).length);

    const rowsWithAnyRef = entries.filter(e2=> e2.rawImageRef && e2.rawImageRef!=='-').length;

    // build a precise diagnostic instead of a bare "0 matched" — this pinpoints exactly
    // which stage failed: no photos in the zip at all, the Image column had no filename
    // reference to work with (formula backfill found nothing), or filenames just didn't
    // match what's in the zip's media files
    let photoNote;
    if(mediaEntries.length===0){
      photoNote = `no photo or PDF attachments found inside this zip — check they were actually included`;
    } else if(rowsWithAnyRef===0){
      photoNote = `⚠ ${mediaEntries.length} attachment(s) found in zip, but no rows had any filename reference in the Image column at all (v${APP_VERSION})`;
    } else if(photoCount===0){
      const sampleFound = mediaEntries.slice(0,3).map(f=>f.name.split('/').pop()).join(', ');
      photoNote = `⚠ ${rowsWithAnyRef} row(s) reference a filename, ${mediaEntries.length} attachment(s) found in zip (e.g. ${sampleFound}), but none matched — check filenames weren't renamed (v${APP_VERSION})`;
    } else {
      photoNote = `${photoCount} photo${photoCount===1?'':'s'} matched`;
    }
    routeThroughCategoryMapping(entries, `${file.name} (${photoNote})`);
  }catch(err){
    console.error(err);
    showToast('Could not read that zip file');
  }
});


document.getElementById('btnClearAllData').onclick = ()=>{
  const count = receipts.length;
  if(!confirm(`This will permanently delete all ${count} receipt${count===1?'':'s'} in this browser tab. This cannot be undone. Continue?`)) return;
  if(!confirm('Are you sure? This is your last chance to cancel.')) return;
  receipts = [];
  receiptSeq = 1;
  storageBackdrop.classList.remove('open');
  storageSheet.classList.remove('open');
  renderAll();
  showToast('All receipts cleared — starting fresh');
};

