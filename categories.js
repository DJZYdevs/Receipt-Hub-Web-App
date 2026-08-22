/* ============================================================
   CATEGORY MERGE — re-points every receipt from a source category
   to a target, then removes the source. Same underlying mechanic
   as rename ("point everything at a different name"), just picking
   an existing category as the target instead of typing a new one.
   ============================================================ */
let mergeSourceCategory = null;
let mergeSelectedTarget = null;

function openMergeSheet(sourceCat){
  mergeSourceCategory = sourceCat;
  mergeSelectedTarget = null;
  const usage = getCategoryUsage();
  const sourceCount = usage[sourceCat] || 0;

  document.getElementById('mergeCategoryTitle').innerText = `Merge "${sourceCat}"`;
  document.getElementById('mergeCategorySubtext').innerText =
    `Choose a category to merge "${sourceCat}" into. ${sourceCount>0 ? `All ${sourceCount} receipt${sourceCount===1?'':'s'} currently in "${sourceCat}" will move to whichever you pick, and "${sourceCat}" will be removed.` : `"${sourceCat}" has no receipts yet — it will simply be removed.`}`;

  const list = document.getElementById('mergeCategoryTargetList');
  list.innerHTML = '';
  getCategoriesSortedByUsage().filter(c=> c!==sourceCat).forEach(cat=>{
    const count = usage[cat] || 0;
    const row = document.createElement('div');
    row.className = 'merge-target-row';
    row.innerHTML = `
      <span class="merge-target-name">${escapeHtml(cat)}</span>
      <span class="merge-target-count">${count} receipt${count===1?'':'s'}</span>
    `;
    row.onclick = ()=>{
      mergeSelectedTarget = cat;
      document.querySelectorAll('.merge-target-row').forEach(r=> r.classList.remove('selected'));
      row.classList.add('selected');
      document.getElementById('btnMergeConfirm').disabled = false;
    };
    list.appendChild(row);
  });

  document.getElementById('btnMergeConfirm').disabled = true;
  document.getElementById('mergeCategoryBackdrop').classList.add('open');
  document.getElementById('mergeCategorySheet').classList.add('open');
}
function closeMergeSheet(){
  document.getElementById('mergeCategoryBackdrop').classList.remove('open');
  document.getElementById('mergeCategorySheet').classList.remove('open');
}
document.getElementById('mergeCategoryCloseBtn').onclick = closeMergeSheet;
document.getElementById('btnMergeCancel').onclick = closeMergeSheet;
document.getElementById('mergeCategoryBackdrop').onclick = closeMergeSheet;

document.getElementById('btnMergeConfirm').onclick = ()=>{
  if(!mergeSelectedTarget) return;
  const source = mergeSourceCategory, target = mergeSelectedTarget;
  if(!confirm(`Merge "${source}" into "${target}"? This cannot be undone.`)) return;

  // re-point every receipt using the source category
  let movedCount = 0;
  receipts.forEach(r=>{ if(r.category===source){ r.category = target; movedCount++; } });

  // remove the source category from the list
  const idx = CATEGORIES.indexOf(source);
  if(idx>-1) CATEGORIES.splice(idx,1);

  // fold usage counts together under the target
  const usageMap = getCategoryUsage();
  if(usageMap[source]){ usageMap[target] = (usageMap[target]||0) + usageMap[source]; delete usageMap[source]; }
  localStorage.setItem(userKey('category_usage'), JSON.stringify(usageMap));

  // any known merchant remembered under the source category should follow it too
  const merchants = getKnownMerchants();
  merchants.forEach(m=>{ if(m.category===source) m.category = target; });
  saveKnownMerchants(merchants);

  persistCategories();
  closeMergeSheet();
  renderAll();
  renderCategoryManageList();
  renderMerchantList();
  showToast(`Merged "${source}" into "${target}" — ${movedCount} receipt${movedCount===1?'':'s'} moved`);
};

function renderCategoryManageList(){
  const container = document.getElementById('categoryManageList');
  const usage = getCategoryUsage();
  container.innerHTML = '';
  const sorted = getCategoriesSortedByUsage();
  sorted.forEach(cat=>{
    const count = usage[cat] || 0;
    const isDefault = DEFAULT_CATEGORIES.has(cat);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:9px 12px; background:var(--card); border:1px solid var(--rule); border-radius:10px; margin-bottom:6px;';
    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--ink);">${escapeHtml(cat)}</div>
        <div style="font-size:11px; color:var(--ink-soft);">${count} receipt${count===1?'':'s'}${isDefault ? ' · built-in' : ''}</div>
      </div>
      <div style="display:flex; gap:6px; flex:0 0 auto;">
        <button class="cat-merge-btn" style="background:var(--paper-dim); border:none; color:var(--ink-soft); width:28px; height:28px; border-radius:50%; font-size:12px; cursor:pointer;">⇄</button>
        <button class="cat-rename-btn" style="background:var(--paper-dim); border:none; color:var(--ink-soft); width:28px; height:28px; border-radius:50%; font-size:12px; cursor:pointer;">✎</button>
        ${isDefault ? '' : '<button class="cat-delete-btn" style="background:var(--paper-dim); border:none; color:var(--ink-soft); width:28px; height:28px; border-radius:50%; font-size:13px; cursor:pointer;">✕</button>'}
      </div>
    `;
    row.querySelector('.cat-merge-btn').addEventListener('click', ()=> openMergeSheet(cat));
    row.querySelector('.cat-rename-btn').addEventListener('click', ()=>{
      const newName = prompt(`Rename "${cat}" to:`, cat);
      if(newName && newName.trim() && newName.trim()!==cat){
        const clean = newName.trim();
        // update the category list itself
        const idx = CATEGORIES.indexOf(cat);
        if(idx>-1) CATEGORIES[idx] = clean;
        // re-point every existing receipt using the old name to the new one
        receipts.forEach(r=>{ if(r.category===cat) r.category = clean; });
        // carry over usage count under the new name
        const usageMap = getCategoryUsage();
        if(usageMap[cat]){ usageMap[clean] = (usageMap[clean]||0) + usageMap[cat]; delete usageMap[cat]; }
        localStorage.setItem(userKey('category_usage'), JSON.stringify(usageMap));
        persistCategories();
        renderAll();
        renderCategoryManageList();
        showToast(`Renamed to "${clean}"`);
      }
    });
    const deleteBtn = row.querySelector('.cat-delete-btn');
    if(deleteBtn){
      deleteBtn.addEventListener('click', ()=>{
        if(count>0){
          if(!confirm(`"${cat}" is used on ${count} receipt${count===1?'':'s'}. Deleting it will re-categorise ${count===1?'that receipt':'those receipts'} as "Misc". Continue?`)) return;
          receipts.forEach(r=>{ if(r.category===cat) r.category='Misc'; });
        }
        const idx = CATEGORIES.indexOf(cat);
        if(idx>-1) CATEGORIES.splice(idx,1);
        const usageMap = getCategoryUsage();
        delete usageMap[cat];
        localStorage.setItem(userKey('category_usage'), JSON.stringify(usageMap));
        persistCategories();
        renderAll();
        renderCategoryManageList();
        showToast(`"${cat}" removed`);
      });
    }
    container.appendChild(row);
  });
}

document.getElementById('btnMenuAddCategory').onclick = ()=>{
  promptAddCategory((clean)=>{
    renderCategoryManageList();
    showToast(`"${clean}" added`);
  });
};

function renderMerchantList(){
  const container = document.getElementById('merchantList');
  const list = getKnownMerchants();
  if(!list.length){
    container.innerHTML = '<p style="font-size:12.5px; color:var(--ink-soft);">No merchants learned yet — verify a few receipts and they\'ll show up here.</p>';
    return;
  }
  container.innerHTML = '';
  list.slice(0, 50).forEach(m=>{
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:9px 12px; background:var(--card); border:1px solid var(--rule); border-radius:10px; margin-bottom:6px;';
    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-size:13px; font-weight:700; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(m.name)}</div>
        <div style="font-size:11px; color:var(--ink-soft);">${escapeHtml(m.category)} · seen ${m.count}×</div>
      </div>
      <button data-key="${escapeHtml(m.key)}" style="flex:0 0 auto; background:var(--paper-dim); border:none; color:var(--ink-soft); width:28px; height:28px; border-radius:50%; font-size:13px; cursor:pointer;">✕</button>
    `;
    row.querySelector('button').addEventListener('click', ()=>{
      const updated = getKnownMerchants().filter(x=>x.key!==m.key);
      saveKnownMerchants(updated);
      renderMerchantList();
      showToast('Removed from known merchants');
    });
    container.appendChild(row);
  });
}

document.getElementById('inputApiKey').addEventListener('change', (e)=>{
  const val = e.target.value.trim();
  if(val) localStorage.setItem('ocrspace_key', val);
  else localStorage.removeItem('ocrspace_key');
  showToast(val ? 'API key saved to this browser' : 'Reverted to shared demo key');
});
document.getElementById('storageCloseBtn').onclick = ()=>{
  storageBackdrop.classList.remove('open');
  storageSheet.classList.remove('open');
};
storageBackdrop.onclick = ()=>{
  storageBackdrop.classList.remove('open');
  storageSheet.classList.remove('open');
};

// re-encode a dataURL image at a smaller max dimension and lower JPEG quality,
// so exports stay a reasonable size instead of carrying full-resolution camera photos
function compressImage(dataUrl, maxDimension=1000, quality=0.6){
  return new Promise((resolve)=>{
    const img = new Image();
    img.onload = ()=>{
      let { width, height } = img;
      if(width > maxDimension || height > maxDimension){
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = ()=> resolve(dataUrl); // fall back to original if it fails to load
    img.src = dataUrl;
  });
}

function buildExportRows(sourceRows, includeImages){
  return sourceRows.map(r=>({
    folder: (allFolders().find(f=>f.id===r.folderId)||{}).label || r.folderId,
    date: r.date,
    establishment: r.establishment,
    amount: r.amount,
    currency: r.currency,
    gst: r.gst || null,
    category: r.category,
    notes: r.notes,
    verified: r.verified,
    imageCount: (r.images||[]).length,
    ...(includeImages ? {} : {}) // images attached separately below when requested
  }));
}

function downloadJson(exportData, filenamePrefix){
  const blob = new Blob([JSON.stringify(exportData, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `${filenamePrefix}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

