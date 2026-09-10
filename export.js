/* ============================================================
   REPORT EXPORT (XLSX / PDF / JSON, with optional photo bundling)
   ============================================================ */

// sorted by folder then date, matching Crunchr's per-folder grouped report style
function getExportDateRange(){
  const preset = document.getElementById('exportRangePreset').value;
  const now = new Date();
  const pad = n=> String(n).padStart(2,'0');
  const toISO = (y,m,d)=> `${y}-${pad(m+1)}-${pad(d)}`;
  if(preset==='thisMonth'){
    const from = toISO(now.getFullYear(), now.getMonth(), 1);
    const to = toISO(now.getFullYear(), now.getMonth()+1, 0);
    return { from, to };
  }
  if(preset==='lastMonth'){
    const lm = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const from = toISO(lm.getFullYear(), lm.getMonth(), 1);
    const to = toISO(lm.getFullYear(), lm.getMonth()+1, 0);
    return { from, to };
  }
  if(preset==='thisYear'){
    return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  }
  if(preset==='custom'){
    return { from: document.getElementById('exportRangeFrom').value || null, to: document.getElementById('exportRangeTo').value || null };
  }
  return { from:null, to:null }; // "all"
}

function buildReportRows(){
  const { from, to } = getExportDateRange();
  let list = [...receipts];
  if(from) list = list.filter(r=> r.date && r.date >= from);
  if(to) list = list.filter(r=> r.date && r.date <= to);
  return list.sort((a,b)=>{
    const fa = getFolderLabelFor(a.folderId), fb = getFolderLabelFor(b.folderId);
    if(fa !== fb) return fa.localeCompare(fb);
    return (a.date||'').localeCompare(b.date||'');
  });
}
function getFolderLabelFor(folderId){
  return (allFolders().find(f=>f.id===folderId)||{}).label || folderId;
}
function formatDateForReport(d){
  if(!d) return '';
  const dt = new Date(d+'T00:00:00');
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

// Builds the media folder contents (compressed images, sequentially named) for a set
// of receipts, and returns a map from receipt id -> array of filenames used, so the
// report (XLSX/PDF) can reference the exact same names.
async function buildMediaFolder(zip, rows){
  const mediaFolder = zip.folder('media');
  const filenameMap = {};
  let counter = 1;
  const totalImages = rows.reduce((sum,r)=> sum + (r.images||[]).length, 0);
  let processed = 0;
  for(const r of rows){
    const names = [];
    for(const img of (r.images||[])){
      const filename = `receipt_${String(counter).padStart(4,'0')}.jpg`;
      counter++;
      const compressed = await compressImage(img, 1000, 0.6);
      const base64Data = compressed.split(',')[1];
      mediaFolder.file(filename, base64Data, {base64:true});
      names.push(filename);
      processed++;
      if(totalImages > 15 && processed % 10 === 0){
        showToast(`Compressing photos… ${processed} of ${totalImages}`);
        await new Promise(res=> setTimeout(res, 0));
      }
    }
    filenameMap[r.id] = names;
  }
  return filenameMap;
}

function buildXlsxWorkbook(rows, filenameMap){
  const wb = XLSX.utils.book_new();
  const sheetData = [];
  const merges = [];
  const hyperlinks = {}; // cellRef -> {Target}

  // brand wordmark, top-right of the sheet. Note: SheetJS's free/community edition
  // has limited support for WRITING cell styles (bold, color, alignment), so this is
  // plain text positioned in the rightmost columns rather than a fully styled treatment
  // matching the app's login screen — still clearly a "logo" in spirit, just unstyled.
  sheetData.push(['', '', '', '', '', 'LEDGR', 'by Engineer of Things']);
  sheetData.push([]); // spacer row before the first folder section

  let currentFolder = null;
  rows.forEach(r=>{
    const folderLabel = getFolderLabelFor(r.folderId);
    if(folderLabel !== currentFolder){
      currentFolder = folderLabel;
      const headerRowIdx = sheetData.length;
      sheetData.push([`Folder: ${folderLabel}`]);
      merges.push({ s:{r:headerRowIdx,c:0}, e:{r:headerRowIdx,c:6} });
      sheetData.push(['Date','Description','Amount','Currency','Category','Image','Notes']);
    }
    const rowIdx = sheetData.length;
    const names = filenameMap ? (filenameMap[r.id]||[]) : [];
    const imageCell = names.length ? names.join(', ') : (r.images&&r.images.length ? `${r.images.length} photo(s)` : '-');
    sheetData.push([
      formatDateForReport(r.date),
      r.establishment || '',
      parseFloat(r.amount)||0,
      r.currency || 'AUD',
      r.category || 'Misc',
      imageCell,
      r.notes || '-'
    ]);
    if(filenameMap && names.length){
      const colLetter = 'F';
      hyperlinks[`${colLetter}${rowIdx+1}`] = { Target: `media/${names[0]}` };
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  ws['!merges'] = merges;
  ws['!cols'] = [{wch:11},{wch:26},{wch:10},{wch:9},{wch:14},{wch:22},{wch:20}];
  Object.entries(hyperlinks).forEach(([ref, link])=>{
    if(ws[ref]) ws[ref].l = link;
  });
  XLSX.utils.book_append_sheet(wb, ws, 'Receipts');
  return wb;
}

function buildPdfReport(rows, filenameMap){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  let currentFolder = null;
  let body = [];
  let linkTargets = []; // parallel array to body — same row index => link target filename or null
  const sections = [];

  rows.forEach(r=>{
    const folderLabel = getFolderLabelFor(r.folderId);
    if(folderLabel !== currentFolder){
      if(body.length) sections.push({ folderLabel: currentFolder, body, linkTargets });
      currentFolder = folderLabel;
      body = [];
      linkTargets = [];
    }
    const names = filenameMap ? (filenameMap[r.id]||[]) : [];
    const imageLabel = names.length ? names.join(', ') : (r.images&&r.images.length ? `${r.images.length} photo(s)` : '-');
    body.push([
      formatDateForReport(r.date), r.establishment||'', (parseFloat(r.amount)||0).toFixed(2),
      r.currency||'AUD', r.category||'Misc', imageLabel, r.notes||'-'
    ]);
    linkTargets.push(names.length ? `media/${names[0]}` : null);
  });
  if(body.length) sections.push({ folderLabel: currentFolder, body, linkTargets });

  let firstSection = true;
  sections.forEach(section=>{
    if(!firstSection) doc.addPage();
    firstSection = false;

    // brand wordmark, top-right of the page — matches the app's login screen treatment
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(31, 42, 36); // --ink
    doc.text('LEDGR', pageWidth - 40, 32, { align:'right' });
    doc.setFontSize(7);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(78, 107, 88); // --sage-deep
    doc.text('BY ENGINEER OF THINGS', pageWidth - 40, 40, { align:'right' });
    doc.setTextColor(0, 0, 0);

    doc.setFontSize(13);
    doc.setFont(undefined,'bold');
    doc.text(`Folder: ${section.folderLabel}`, 40, 40);
    doc.autoTable({
      startY: 54,
      head: [['Date','Description','Amount','Currency','Category','Image','Notes']],
      body: section.body,
      styles: { fontSize:8, cellPadding:5 },
      headStyles: { fillColor:[122,148,130], textColor:255, fontStyle:'bold' },
      columnStyles: { 2:{halign:'right'} },
      margin:{ left:40, right:40 },
      didParseCell: (data)=>{
        // style the Image column to look like a real hyperlink when one exists
        if(data.section==='body' && data.column.index===5 && section.linkTargets[data.row.index]){
          data.cell.styles.textColor = [80,110,190];
          data.cell.styles.fontStyle = 'bold';
        }
      },
      didDrawCell: (data)=>{
        // draw the actual clickable link annotation over the Image cell
        if(data.section==='body' && data.column.index===5){
          const target = section.linkTargets[data.row.index];
          if(target){
            doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: target });
          }
        }
      },
    });
  });

  return doc;
}

async function runExport(){
  const format = document.getElementById('exportFormatSelect').value; // xlsx | pdf | json
  const includePhotos = document.getElementById('exportIncludePhotos').checked;

  if(receipts.length===0){
    showToast('No receipts to export yet');
    return;
  }

  const rows = buildReportRows();
  if(rows.length===0){
    showToast('No receipts in that date range');
    return;
  }
  const stamp = new Date().toISOString().slice(0,10);

  if(format==='json'){
    if(includePhotos){
      const totalImages = rows.reduce((sum,r)=> sum + (r.images||[]).length, 0);
      let processed = 0;
      const withImages = [];
      for(const r of rows){
        const compressedImages = [];
        for(const img of (r.images||[])){
          compressedImages.push(await compressImage(img));
          processed++;
          if(totalImages > 15 && processed % 10 === 0){
            showToast(`Compressing photos… ${processed} of ${totalImages}`);
            await new Promise(res=> setTimeout(res, 0));
          }
        }
        withImages.push({ folder:getFolderLabelFor(r.folderId), date:r.date, establishment:r.establishment, amount:r.amount, currency:r.currency, gst:r.gst||null, category:r.category, notes:r.notes, images:compressedImages });
      }
      downloadJson({ exportedAt:new Date().toISOString(), receipts:withImages }, 'receipts-with-photos');
    } else {
      downloadJson({ exportedAt:new Date().toISOString(), receipts:buildExportRows(rows, false) }, 'receipts-data');
    }
    showToast(`Exported ${rows.length} receipt${rows.length===1?'':'s'}`);
    return;
  }

  if(!includePhotos){
    // lightweight report only — no zip needed
    if(format==='xlsx'){
      const wb = buildXlsxWorkbook(rows, null);
      XLSX.writeFile(wb, `receipts-report-${stamp}.xlsx`);
    } else if(format==='pdf'){
      const doc = buildPdfReport(rows, null);
      doc.save(`receipts-report-${stamp}.pdf`);
    }
    showToast(`Exported ${rows.length} receipt${rows.length===1?'':'s'}`);
    return;
  }

  // report + photos, bundled into one zip — mirrors Crunchr's report+media folder approach
  showToast('Building report and compressing photos…');
  const zip = new JSZip();
  const filenameMap = await buildMediaFolder(zip, rows);

  if(format==='xlsx'){
    const wb = buildXlsxWorkbook(rows, filenameMap);
    const xlsxData = XLSX.write(wb, {type:'array', bookType:'xlsx'});
    zip.file(`report-${stamp}.xlsx`, xlsxData);
  } else if(format==='pdf'){
    const doc = buildPdfReport(rows, filenameMap);
    const pdfBlob = doc.output('blob');
    zip.file(`report-${stamp}.pdf`, pdfBlob);
  }

  let lastZipPercent = -1;
  const zipBlob = await zip.generateAsync({type:'blob'}, (metadata)=>{
    const pct = Math.round(metadata.percent);
    if(pct !== lastZipPercent && pct % 10 === 0){
      lastZipPercent = pct;
      showToast(`Building zip… ${pct}%`);
    }
  });
  downloadBlob(zipBlob, `receipts-export-${stamp}.zip`);
  showToast(`Exported ${rows.length} receipt${rows.length===1?'':'s'} with photos`);
}

document.getElementById('exportRangePreset').addEventListener('change', (e)=>{
  document.getElementById('exportCustomRangeRow').style.display = e.target.value==='custom' ? 'flex' : 'none';
});

document.getElementById('btnRunExport').onclick = ()=>{ runExport().catch(err=>{ console.error(err); showToast('Export failed — see console for details'); }); };

/* ============================================================
   FINANCIAL SNAPSHOT PDF — answers the same preset questions shown
   in the Analysis page (category breakdown, top establishments,
   essential vs discretionary), as one branded, shareable PDF.
   Built on computeAnalysisSnapshot() (dashboard.js) — same source
   of truth as the on-screen Analysis view, so the two can't drift.
   ============================================================ */
function buildFinancialSnapshotPdf(snapshot){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'pt', format:'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  function drawHeader(){
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(31, 42, 36);
    doc.text('LEDGR', pageWidth - 40, 32, { align:'right' });
    doc.setFontSize(7);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(78, 107, 88);
    doc.text('BY ENGINEER OF THINGS', pageWidth - 40, 40, { align:'right' });
    doc.setTextColor(0, 0, 0);
  }

  drawHeader();
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('Financial snapshot', 40, 46);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`${snapshot.rangeLabel}  ·  ${snapshot.folderLabel}`, 40, 62);
  doc.setFontSize(9);
  doc.setTextColor(90,90,90);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, 76);
  doc.setTextColor(0,0,0);

  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Total spend', 40, 102);
  doc.setFontSize(20);
  doc.text(`$${snapshot.rangeTotal.toFixed(2)}`, 40, 124);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(10);
  doc.text(`~$${Math.round(snapshot.rangeTotal/snapshot.monthsInRange)}/month average`, 40, 140);

  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.text('Essential vs discretionary', 40, 166);
  doc.autoTable({
    startY: 173,
    head: [['', 'Amount', '% of total']],
    body: [
      ['Essential (Groceries, Fuel, Utilities, Rent, Health)', `$${snapshot.essential.total.toFixed(2)}`, `${snapshot.essential.pct}%`],
      ['Discretionary (everything else)', `$${snapshot.discretionary.total.toFixed(2)}`, `${snapshot.discretionary.pct}%`],
    ],
    styles: { fontSize:9, cellPadding:5 },
    headStyles: { fillColor:[122,148,130], textColor:255, fontStyle:'bold' },
    margin:{ left:40, right:40 },
  });

  let y = doc.lastAutoTable.finalY + 24;
  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.text('By category', 40, y);
  doc.autoTable({
    startY: y+7,
    head: [['Category', 'Amount', '% of total', 'Avg/month']],
    body: snapshot.categories.map(c=> [c.category, `$${c.amount.toFixed(2)}`, `${c.pct}%`, `$${c.avgPerMonth}`]),
    styles: { fontSize:9, cellPadding:5 },
    headStyles: { fillColor:[122,148,130], textColor:255, fontStyle:'bold' },
    columnStyles: { 1:{halign:'right'}, 2:{halign:'right'}, 3:{halign:'right'} },
    margin:{ left:40, right:40 },
  });

  y = doc.lastAutoTable.finalY + 24;
  if(y > 700){ doc.addPage(); drawHeader(); y = 60; }
  doc.setFont(undefined, 'bold');
  doc.setFontSize(11);
  doc.text('Top establishments', 40, y);
  doc.autoTable({
    startY: y+7,
    head: [['Establishment', 'Visits', 'Amount']],
    body: snapshot.establishments.map(e=> [e.name, String(e.count), `$${e.amount.toFixed(2)}`]),
    styles: { fontSize:9, cellPadding:5 },
    headStyles: { fillColor:[122,148,130], textColor:255, fontStyle:'bold' },
    columnStyles: { 1:{halign:'right'}, 2:{halign:'right'} },
    margin:{ left:40, right:40 },
  });

  return doc;
}

async function runFinancialSnapshotExport(){
  if(typeof computeAnalysisSnapshot !== 'function'){
    showToast('Analysis data not available yet');
    return;
  }
  const snapshot = computeAnalysisSnapshot();
  if(snapshot.rangeReceipts.length===0){
    showToast('No receipts in this range yet');
    return;
  }
  const doc = buildFinancialSnapshotPdf(snapshot);
  const stamp = new Date().toISOString().slice(0,10);
  doc.save(`ledgr-financial-snapshot-${stamp}.pdf`);
  showToast('Snapshot PDF saved');
}

document.getElementById('btnGenerateSnapshotPdf').onclick = ()=>{
  runFinancialSnapshotExport().catch(err=>{ console.error(err); showToast('Snapshot export failed — see console for details'); });
};
