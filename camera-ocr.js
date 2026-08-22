/* ============================================================
   CAMERA
   ============================================================ */
const cameraView = document.getElementById('cameraView');
const camVideo = document.getElementById('camVideo');
const camCanvas = document.getElementById('camCanvas');

async function openCamera(){
  capturedImages = [];
  renderCapsStrip();
  cameraView.classList.add('open');
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1600}, height:{ideal:2000} }, audio:false });
    camVideo.srcObject = mediaStream;
  }catch(err){
    // Fallback: no camera access (common in sandboxed/desktop testing) — use file input with capture attribute
    cameraView.classList.remove('open');
    document.getElementById('fileInputCameraFallback').click();
  }
}

function closeCamera(){
  cameraView.classList.remove('open');
  if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
}

document.getElementById('btnCamera').onclick = openCamera;
document.getElementById('camClose').onclick = closeCamera;

document.getElementById('multiToggleRow').addEventListener('click', (e)=>{
  // avoid double-toggling if the tap landed directly on the checkbox input itself
  if(e.target.id==='multiToggle') return;
  const cb = document.getElementById('multiToggle');
  cb.checked = !cb.checked;
});

document.getElementById('shutterBtn').onclick = ()=>{
  const w = camVideo.videoWidth, h = camVideo.videoHeight;
  if(!w || !h) return;
  // cap the stored resolution — full camera resolution (often 3000px+) is overkill for
  // OCR and receipt viewing, and needlessly bloats IndexedDB storage and exports
  const maxDim = 1600;
  let targetW = w, targetH = h;
  if(w > maxDim || h > maxDim){
    const scale = maxDim / Math.max(w, h);
    targetW = Math.round(w * scale);
    targetH = Math.round(h * scale);
  }
  camCanvas.width = targetW; camCanvas.height = targetH;
  const ctx = camCanvas.getContext('2d');
  ctx.drawImage(camVideo, 0, 0, targetW, targetH);
  const dataUrl = camCanvas.toDataURL('image/jpeg', 0.75);
  capturedImages.push(dataUrl);
  renderCapsStrip();

  multiPageMode = document.getElementById('multiToggle').checked;
  document.getElementById('shutterLabel').innerText = multiPageMode ? 'Page captured — keep going' : 'Tap to capture another';
  flashShutter();
};

function flashShutter(){
  cameraView.style.background = '#fff';
  setTimeout(()=>{ cameraView.style.background = '#0D120E'; }, 90);
}

function renderCapsStrip(){
  const strip = document.getElementById('camCapsStrip');
  strip.innerHTML='';
  capturedImages.forEach((img,i)=>{
    const el = document.createElement('img');
    el.src = img; el.className='cap-thumb';
    strip.appendChild(el);
  });
  document.getElementById('camDone').classList.toggle('active', capturedImages.length>0);
  document.getElementById('camDone').innerText = capturedImages.length>1 ? `Process (${capturedImages.length})` : 'Process';
}

document.getElementById('camRetake').onclick = ()=>{
  capturedImages = [];
  renderCapsStrip();
  document.getElementById('shutterLabel').innerText = 'Tap to capture';
};

document.getElementById('camDone').onclick = ()=>{
  if(capturedImages.length===0) return;
  const multi = document.getElementById('multiToggle').checked;
  closeCamera();
  if(multi){
    // treat all captured images as ONE multi-page receipt
    queueReceiptForOCR([...capturedImages]);
  } else {
    // treat each captured image as its OWN receipt (bulk single-page capture)
    capturedImages.forEach(img=> queueReceiptForOCR([img]));
  }
  capturedImages = [];
  processQueue();
};

/* ---- Library upload ---- */
// Renders every page of a PDF to a compressed JPEG data URL, so a PDF receipt can be
// treated identically to a photographed one from this point on — same OCR call, same
// thumbnail/lightbox display, same storage. Multi-page PDFs become a multi-page receipt,
// same as the existing multi-page camera capture flow.
async function pdfArrayBufferToImages(arrayBuffer, maxDimension=1600, quality=0.75){
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  const images = [];
  for(let pageNum=1; pageNum<=pdf.numPages; pageNum++){
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({scale:1});
    const scale = Math.min(maxDimension / baseViewport.width, maxDimension / baseViewport.height, 3);
    const viewport = page.getViewport({scale: Math.max(scale, 1)});
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', quality));
  }
  return images;
}
async function pdfFileToImages(file, maxDimension=1600, quality=0.75){
  return pdfArrayBufferToImages(await file.arrayBuffer(), maxDimension, quality);
}

document.getElementById('btnLibrary').onclick = ()=> document.getElementById('fileInputLibrary').click();

document.getElementById('fileInputLibrary').addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files);
  if(files.length===0) return;
  for(const f of files){
    try{
      if(f.type==='application/pdf' || /\.pdf$/i.test(f.name)){
        const pageImages = await pdfFileToImages(f);
        queueReceiptForOCR(pageImages); // all pages of one PDF = one multi-page receipt
      } else {
        const rawDataUrl = await fileToDataUrl(f);
        // photo library images can be much larger than camera captures (e.g. iPhone HEIC->JPEG
        // conversions at full sensor resolution) — compress on the way in to keep storage/export sane
        const dataUrl = await compressImage(rawDataUrl, 1600, 0.75);
        queueReceiptForOCR([dataUrl]); // each uploaded file = its own receipt for bulk processing
      }
    }catch(err){
      console.error('Failed to process uploaded file', f.name, err);
      showToast(`Couldn't read "${f.name}" — skipped`);
    }
  }
  e.target.value = '';
  processQueue();
});

document.getElementById('fileInputCameraFallback').addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files);
  if(files.length===0) return;
  const rawDataUrl = await fileToDataUrl(files[0]);
  const dataUrl = await compressImage(rawDataUrl, 1600, 0.75);
  queueReceiptForOCR([dataUrl]);
  e.target.value='';
  processQueue();
});

function fileToDataUrl(file){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

/* ============================================================
   OCR QUEUE + PROCESSING
   ============================================================ */
let ocrQueue = []; // array of {images:[...]}
let isProcessing = false;

function queueReceiptForOCR(images){
  ocrQueue.push({images});
}

async function processQueue(){
  if(isProcessing || ocrQueue.length===0) return;
  isProcessing = true;
  const total = ocrQueue.length;
  const processingView = document.getElementById('processingView');
  processingView.classList.add('open');

  const results = [];
  let idx = 0;
  while(ocrQueue.length){
    idx++;
    const item = ocrQueue.shift();
    document.getElementById('procFileName').innerText = item.images.length>1 ? `Multi-page receipt (${item.images.length} pages)` : `Receipt ${idx} of ${total}`;
    document.getElementById('procCount').innerText = `Processing ${idx} of ${total}`;
    document.getElementById('procFill').style.width = `${Math.round(((idx-1)/total)*100)}%`;

    const extracted = await runOCROnImages(item.images, (p)=>{
      document.getElementById('procFill').style.width = `${Math.round((((idx-1)+p)/total)*100)}%`;
    });

    results.push({
      images: item.images,
      ...extracted
    });
  }

  document.getElementById('procFill').style.width = '100%';
  processingView.classList.remove('open');
  isProcessing = false;

  // load results into the review queue
  reviewQueue = results;
  currentReviewIndex = 0;
  editingExistingId = null;
  if(reviewQueue.length){
    openReviewSheetForIndex(0);
  }
}

function getApiKey(){
  return (localStorage.getItem('ocrspace_key') || '').trim() || 'helloworld';
}

// Convert a dataURL (e.g. from canvas.toDataURL or FileReader) to a Blob for upload
function dataUrlToBlob(dataUrl){
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/data:(.*?);base64/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], {type:mime});
}

async function ocrSpaceRecognize(dataUrl, attempt=1){
  const blob = dataUrlToBlob(dataUrl);
  const form = new FormData();
  form.append('apikey', getApiKey());
  form.append('file', blob, 'receipt.jpg');
  form.append('language', 'eng');
  form.append('OCREngine', '2');      // engine 2 is better for receipts/mixed layouts
  form.append('scale', 'true');
  form.append('isTable', 'true');     // helps line-item / column alignment on receipts

  let res;
  try{
    res = await fetch('https://api.ocr.space/parse/image', { method:'POST', body: form });
  }catch(networkErr){
    throw new Error('NETWORK: Could not reach OCR.space. Check your internet connection.');
  }

  if(!res.ok){
    if(res.status===403 || res.status===401){
      throw new Error('AUTH: API key was rejected. Check the key in Storage settings.');
    }
    if((res.status===429 || res.status===503) && attempt<3){
      await new Promise(r=>setTimeout(r, 1200*attempt));
      return ocrSpaceRecognize(dataUrl, attempt+1);
    }
    throw new Error(`HTTP_${res.status}: OCR service returned an error.`);
  }

  const json = await res.json();

  if(json.IsErroredOnProcessing){
    const msg = (json.ErrorMessage && json.ErrorMessage.join(', ')) || json.ErrorDetails || 'Unknown OCR error';
    // Rate-limit on the shared demo key often comes back as a processing error, not an HTTP error
    if(/rate|limit|timed? ?out/i.test(msg) && attempt<3){
      await new Promise(r=>setTimeout(r, 1500*attempt));
      return ocrSpaceRecognize(dataUrl, attempt+1);
    }
    throw new Error(`OCR_ENGINE: ${msg}`);
  }

  const parsedText = (json.ParsedResults || []).map(r=>r.ParsedText).join('\n');
  return parsedText;
}

/* ============================================================
   CATEGORY USAGE (tracks how often each category is used, so the
   pop-out grid can surface your most-used categories first)
   ============================================================ */
function getCategoryUsage(){
  try{
    return JSON.parse(localStorage.getItem(userKey('category_usage')) || '{}');
  }catch(e){ return {}; }
}
function recordCategoryUsage(category){
  if(!category) return;
  const usage = getCategoryUsage();
  usage[category] = (usage[category]||0) + 1;
  localStorage.setItem(userKey('category_usage'), JSON.stringify(usage));
}
function getCategoriesSortedByUsage(){
  const usage = getCategoryUsage();
  return [...CATEGORIES].sort((a,b)=> (usage[b]||0) - (usage[a]||0));
}

/* ============================================================
   KNOWN MERCHANTS (learns from your corrections over time)
   ============================================================ */
function getKnownMerchants(){
  try{
    return JSON.parse(localStorage.getItem(userKey('known_merchants')) || '[]');
  }catch(e){ return []; }
}
function saveKnownMerchants(list){
  localStorage.setItem(userKey('known_merchants'), JSON.stringify(list.slice(0, 200))); // cap list size
}
// call this whenever a receipt is verified & saved, so the app "learns" the merchant
function rememberMerchant(establishment, category){
  if(!establishment || establishment.trim().length<2) return;
  const list = getKnownMerchants();
  const key = establishment.trim().toLowerCase();
  const existing = list.find(m=> m.key===key);
  if(existing){
    existing.name = establishment.trim(); // keep most recent casing/spelling
    existing.category = category || existing.category;
    existing.count = (existing.count||1) + 1;
  } else {
    list.unshift({ key, name: establishment.trim(), category: category||'Misc', count:1 });
  }
  saveKnownMerchants(list);
}
// look for any known merchant name appearing anywhere in the OCR text
function matchKnownMerchant(fullText){
  const list = getKnownMerchants();
  if(!list.length) return null;
  const lowerText = fullText.toLowerCase().replace(/[^a-z0-9 ]/g,' ');
  // sort longest name first so more specific matches win over short/ambiguous ones
  const sorted = [...list].sort((a,b)=> b.key.length - a.key.length);
  for(const m of sorted){
    const cleanKey = m.key.replace(/[^a-z0-9 ]/g,' ').trim();
    if(cleanKey.length>=3 && lowerText.includes(cleanKey)){
      return m;
    }
  }
  return null;
}

async function runOCROnImages(images, onProgress){
  let fullText = '';
  let lastError = null;
  let successCount = 0;

  for(let i=0;i<images.length;i++){
    try{
      const text = await ocrSpaceRecognize(images[i]);
      fullText += '\n' + text;
      successCount++;
    }catch(err){
      console.error('OCR error on image', i, err);
      lastError = err;
    }
    if(onProgress) onProgress((i+1)/images.length);
  }

  const result = parseReceiptText(fullText);
  result.rawOcrText = fullText.trim();

  // known-merchant override: if this text mentions a merchant you've corrected before,
  // trust that over the generic heuristics — it's a much stronger signal
  const knownMatch = matchKnownMerchant(fullText);
  if(knownMatch){
    result.establishment = knownMatch.name;
    result.category = knownMatch.category;
    result.confidences.establishment = 'high';
    result.matchedKnownMerchant = true;
  }

  if(successCount===0 && lastError){
    // total failure — surface this clearly rather than silently returning empty fields
    result.ocrFailed = true;
    result.ocrErrorMessage = friendlyOcrError(lastError.message);
    result.needsCheck = true;
  } else if(lastError){
    // partial failure across a multi-page receipt
    result.ocrPartialError = friendlyOcrError(lastError.message);
  }

  return result;
}

function friendlyOcrError(raw){
  if(/NETWORK/.test(raw)) return "Couldn't reach the OCR service — check your connection and try again.";
  if(/AUTH/.test(raw)) return "The API key was rejected — check it in the Storage panel.";
  if(/rate|limit/i.test(raw)) return "The shared demo key is rate-limited right now — try again in a minute, or add your own free key in Storage settings.";
  if(/HTTP_5/.test(raw)) return "The OCR service is temporarily unavailable — try again shortly.";
  return "OCR couldn't read this image clearly — you can still fill the form in manually.";
}

/* ---- Naive-but-useful receipt text parser ---- */
function parseReceiptText(text){
  // OCR.space frequently merges visually-separate text (headers, side-by-side columns)
  // onto one "line" separated by large whitespace gaps. Split on 3+ spaces as well as
  // newlines so each logical fragment can be scored independently — but ALSO keep each
  // original un-split line as its own candidate, since store name headers are sometimes
  // themselves spaced out (e.g. "POSH   OPP   SHOPPE") and splitting them would shred
  // the name into single words.
  const rawLines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const lines = [];
  rawLines.forEach(rl=>{
    lines.push(rl); // always keep the full original line as its own candidate too

    // split on large gaps (2+ spaces) or tabs into rough column fragments
    const fragments = rl.split(/ {2,}|\t+/).map(p=>p.trim()).filter(Boolean);
    fragments.forEach(f=>{ if(f !== rl) lines.push(f); });

    // separately: scan word-by-word and merge consecutive short ALL-CAPS words
    // into a heading candidate (handles "POSH   OPP        SHOPPE  Posh Opp..." style lines
    // where a caps header is glued to a mixed-case repeat with inconsistent gaps)
    const words = rl.split(/\s+/).filter(Boolean);
    let buffer = [];
    words.forEach(w=>{
      const core = w.replace(/[^A-Za-z]/g,'');
      const isShortCapsWord = /^[A-Z]{2,14}$/.test(core) && core.length===w.replace(/[().,]/g,'').length;
      if(isShortCapsWord){
        buffer.push(core);
      } else {
        if(buffer.length>=2) lines.push(buffer.join(' '));
        buffer = [];
      }
    });
    if(buffer.length>=2) lines.push(buffer.join(' '));
  });
  const confidences = {};

  // --- Amount: look for the largest currency-like number, prefer lines with TOTAL ---
  let amount = '';
  const excludeTotalPattern = /sub ?total|saved|savings|points|balance|change|item count|qty/i;
  // money can appear as: $8.00 / A$8.00 / AU$8.00 / AUD 8.00 / 8.00
  const moneyRegex = /(?:[A-Z]{0,3}\$|\$)?\s?(\d{1,4}(?:[.,]\d{2}))\b/;
  const totalLines = lines.filter(l=> /\btotal\b/i.test(l) && !excludeTotalPattern.test(l));
  if(totalLines.length){
    // scan every total line, collect all money matches, take the largest
    // (grand total is usually the largest value among total/subtotal/amount-tendered lines)
    let totalCandidates = [];
    totalLines.forEach(l=>{
      const matches = l.match(/(?:[A-Z]{0,3}\$)\s?\d{1,4}[.,]\d{2}\b/g);
      if(matches) totalCandidates.push(...matches.map(m=> parseFloat(m.replace(/[A-Z$]/g,'').replace(',','.'))));
    });
    if(totalCandidates.length){
      amount = Math.max(...totalCandidates).toFixed(2);
      confidences.amount='high';
    }
  }
  if(!amount){
    // fallback: grab the largest currency-looking number anywhere in the text (with $ sign preferred)
    let candidates = [];
    lines.forEach(l=>{
      if(excludeTotalPattern.test(l)) return;
      const matches = l.match(/(?:[A-Z]{0,3}\$)\s?\d{1,4}[.,]\d{2}\b/g);
      if(matches) candidates.push(...matches.map(m=>parseFloat(m.replace(/[A-Z$]/g,'').replace(',','.'))));
    });
    if(candidates.length){
      amount = Math.max(...candidates).toFixed(2);
      confidences.amount = 'medium';
    } else {
      // last resort: any bare decimal number even without a currency symbol
      let bareCandidates = [];
      lines.forEach(l=>{
        if(excludeTotalPattern.test(l)) return;
        const matches = l.match(/\b\d{1,4}[.,]\d{2}\b/g);
        if(matches) bareCandidates.push(...matches.map(m=>parseFloat(m.replace(',','.'))));
      });
      if(bareCandidates.length){
        amount = Math.max(...bareCandidates).toFixed(2);
        confidences.amount = 'low';
      } else {
        confidences.amount = 'low';
      }
    }
  }

  // --- Date: look for common date patterns (handles a trailing time stamp on the same line, e.g. "05/07/2026 15:15:14") ---
  let date = '';
  const slashDateRegex = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/;
  const isoDateRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const monthNames = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
  const monthNamePattern = new RegExp('\\b(' + Object.keys(monthNames).join('|') + ')[a-z]*\\b', 'i');
  // handles "JUL 02, 26", "02 Jul 2026", "Jul 2, 2026" etc.
  const monthFirstRegex = new RegExp('\\b(' + Object.keys(monthNames).join('|') + ')[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{2,4})\\b', 'i');
  const dayFirstRegex = new RegExp('\\b(\\d{1,2})\\s+(' + Object.keys(monthNames).join('|') + ')[a-z]*\\.?,?\\s+(\\d{2,4})\\b', 'i');

  for(const l of lines){
    let m = l.match(isoDateRegex);
    if(m){ date = `${m[1]}-${m[2]}-${m[3]}`; confidences.date='high'; break; }
    m = l.match(slashDateRegex);
    if(m){
      let [_, a, b, y] = m;
      if(y.length===2) y = '20'+y;
      // AU convention is DD/MM/YYYY; swap only if the first number can't be a valid day
      let dd = a.padStart(2,'0'), mm = b.padStart(2,'0');
      if(parseInt(dd,10)>31 || parseInt(mm,10)>12){ [dd,mm] = [mm,dd]; }
      // sanity check the resulting date is real before accepting it
      if(parseInt(dd,10)>=1 && parseInt(dd,10)<=31 && parseInt(mm,10)>=1 && parseInt(mm,10)<=12){
        date = `${y}-${mm}-${dd}`;
        confidences.date = 'high';
        break;
      }
    }
    // month-name formats — common on payment terminal slips (e.g. "JUL 02, 26")
    m = l.match(monthFirstRegex);
    if(m){
      const mm = monthNames[m[1].toLowerCase()];
      let dd = parseInt(m[2],10);
      let y = m[3].length===2 ? '20'+m[3] : m[3];
      if(mm && dd>=1 && dd<=31){
        date = `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
        confidences.date = 'high';
        break;
      }
    }
    m = l.match(dayFirstRegex);
    if(m){
      let dd = parseInt(m[1],10);
      const mm = monthNames[m[2].toLowerCase()];
      let y = m[3].length===2 ? '20'+m[3] : m[3];
      if(mm && dd>=1 && dd<=31){
        date = `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
        confidences.date = 'high';
        break;
      }
    }
  }
  if(!date){
    date = new Date().toISOString().slice(0,10);
    confidences.date = 'low';
  }

  // --- Establishment: try explicit field labels FIRST (most reliable), then fall back to scoring ---
  let establishment = '';

  // Strategy 1: many receipts (especially digital order confirmations / delivery apps)
  // explicitly label the business, e.g. "Venue: Samsam Chicken", "Merchant - X", or
  // "Venue    Samsam Chicken" (colon-free, column-style layout — common when OCR.space
  // renders a two-column receipt template as label + big whitespace gap + value)
  const labelPatterns = [
    /\bvenue\s*[:\-]?\s+(.+)/i,
    /\bmerchant\s*(?:name)?\s*[:\-]?\s+(.+)/i,
    /\bbusiness\s*name\s*[:\-]?\s+(.+)/i,
    /\bstore\s*name\s*[:\-]?\s+(.+)/i,
    /\bsold\s*by\s*[:\-]?\s+(.+)/i,
    /\bsupplier\s*[:\-]?\s+(.+)/i,
    /\brestaurant\s*[:\-]?\s+(.+)/i,
  ];
  for(const l of lines){
    for(const pattern of labelPatterns){
      const m = l.match(pattern);
      if(m && m[1]){
        let val = m[1].trim().replace(/[^a-zA-Z0-9 &'.,\-]/g, '').trim();
        // strip trailing junk that sometimes rides along on the same OCR line (e.g. an address)
        val = val.split(/\s{2,}/)[0].trim();
        if(val.length>=3 && val.length<=45){
          establishment = val;
          confidences.establishment = 'high';
          break;
        }
      }
    }
    if(establishment) break;
  }

  // Strategy 2: score candidate lines (fallback when no explicit label was found)
  if(!establishment){
  const junkPattern = /^(tax invoice|invoice|receipt|abn|acn|gst|thank you|thanks for|www\.|http|tel:|phone|ph:|customer (copy|details|information|name)|loyalty|card|eftpos|change|balance|cashier|operator|store\s?#|reg(ister)?\s?\d|welcome to|have a|see you|survey|feedback|your (receipt|opinion|order)|receipt of purchase|recept of purchase|venue|order (date|number|status)|table\s?(number)?|email|phone:|view order|start new|continue$)/i;
  // common single/multi-word receipt boilerplate — column headers, transaction metadata —
  // that is often printed prominently near the top but is NEVER the business name.
  // Must be excluded outright, not just down-weighted, since these can otherwise out-score
  // the real name (e.g. "PRICE QTY" is short, title-case, and appears early).
  const boilerplatePhrases = new Set([
    'TOTAL','SUBTOTAL','AMOUNT','TAX','GST','VAT','QTY','PRICE','PRODUCT','ITEM','ITEMS',
    'CASH','CARD','CHANGE','BALANCE','TENDER','PAYMENT','STAFF','DEVICE','CASHIER','OPERATOR',
    'REGISTER','TILL','RECEIPT','INVOICE','DATE','TIME','THANK','THANKS','THANKYOU','WELCOME',
    'PRICE QTY','QTY PRICE','PRICE QTY TOTAL','QTY TOTAL','ITEM QTY','DESCRIPTION QTY',
    'YOUR RECEIPT','YOUR ORDER','TAX INVOICE','ORDER DATE','TABLE NUMBER','ORDER NUMBER',
    // app-screenshot UI chrome — page titles, section headers, buttons on delivery/ordering apps
    'ORDER STATUS','CUSTOMER INFORMATION','CUSTOMER NAME','CUSTOMER','PHONE NUMBER','TABLE',
    'VIEW ORDER DETAILS','ORDER DETAILS','CONTINUE','START NEW ORDER','PLACE ORDER',
    'CHECKOUT','CART','MENU','HOME','BACK','NEXT','CONFIRM','DONE'
  ].map(w=>w.toUpperCase()));
  const addressPattern = /\b(street|st\.|road|rd\.|avenue|ave\.|drive|dr\.|highway|hwy|suite|unit|level|shop\s?\d|nsw|vic|qld|wa|sa|tas|act|nt)\b/i;
  const looksLikeDate = /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/;
  const looksLikeTime = /\d{1,2}:\d{2}/;
  const looksLikePhone = /\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/;
  const looksLikeEmail = /@/;
  // EFTPOS terminal / payment-processor headers — these appear on card payment slips
  // (as opposed to itemised store receipts) and are NEVER the merchant, just the bank/network
  // that processed the payment. The real merchant is almost always the line right below this.
  const paymentProcessorPattern = /\b(nab|anz|cba|commonwealth bank|westpac|bendigo|suncorp|bankwest|tyro|square|zeller|smartpay|verifone|ingenico|worldline|pin ?pad)\b.*\b(eftpos|terminal|pos)\b|\beftpos\b.*\b(nab|anz|cba|westpac|bendigo|suncorp|bankwest|tyro|square|zeller)\b/i;

  const personNameLabelPattern = /\b(customer\s*name|card\s*holder|cardholder|attn|attention|contact\s*name|guest\s*name|billed\s*to|ordered\s*by)\b/i;

  const candidates = [];
  // widen window since splitting on whitespace-gaps produces more, shorter fragments per original line
  lines.slice(0, 20).forEach((l, idx)=>{
    // skip this whole line if IT is a person-name label ("Customer Name: John Smith")
    if(personNameLabelPattern.test(l)) return;
    // also skip if the line immediately before it (in the flattened candidate list) was a
    // bare person-name label with no value attached — whitespace-splitting often separates
    // "Customer Name" and "DJ Chan" into two adjacent array entries
    if(idx>0 && personNameLabelPattern.test(lines[idx-1]) && lines[idx-1].trim().split(/\s+/).length<=3) return;
    const clean = l.replace(/[^a-zA-Z0-9 &'.,\-]/g, '').trim();
    if(clean.length<3 || clean.length>40) return;
    if(junkPattern.test(clean)) return;
    if(paymentProcessorPattern.test(clean)) return; // e.g. "NAB EFTPOS" — bank/terminal name, not the merchant
    if(addressPattern.test(clean)) return;
    if(looksLikeDate.test(clean) || looksLikeTime.test(clean) || looksLikePhone.test(clean)) return;
    if(looksLikeEmail.test(l)) return; // check original (unstripped) line for @ since clean strips it
    if(/^\d+$/.test(clean)) return;
    if(/^[\d\s.,$-]+$/.test(clean)) return; // pure numbers/money, not a name
    const letterCount = (clean.match(/[a-zA-Z]/g)||[]).length;
    if(letterCount < clean.length * 0.5) return; // too many symbols/digits to be a name
    if(boilerplatePhrases.has(clean.toUpperCase())) return; // exact-match boilerplate phrase, any word count

    const wordCount = clean.split(/\s+/).filter(Boolean).length;
    // a lone single word that's pure receipt boilerplate is never the establishment name
    if(wordCount===1 && boilerplatePhrases.has(clean.toUpperCase())) return;

    let score = 0;
    score += Math.max(0, 6 - idx);              // earlier lines score higher
    if(clean === clean.toUpperCase()) score += 4; // store names often printed in caps
    if(/^[A-Z]/.test(clean)) score += 1;
    if(wordCount>=2 && wordCount<=5) score += 4;  // multi-word phrases are much more likely to be a real name
    if(wordCount===1) score -= 3;                 // single bare words are risky/ambiguous — de-prioritise
    if(/pty ltd|pty\.? ltd\.?|limited|inc\.?/i.test(clean)) score += 1;

    candidates.push({ text: clean, score, idx });
  });

  candidates.sort((a,b)=> b.score - a.score);

  // if the same (or near-same) name-like phrase appears more than once near the top,
  // that repetition itself is a strong signal it's the store name (receipts often
  // print the name once in a large header and again in a smaller confirmation line).
  // Use substring containment (not exact match) since one occurrence may have trailing
  // text like "(Elsternwick)" appended that the other doesn't.
  candidates.forEach(c=>{
    const key = c.text.toLowerCase().replace(/[^a-z0-9]/g,'');
    if(key.length<4) return;
    const repeats = candidates.filter(o=>{
      const okey = o.text.toLowerCase().replace(/[^a-z0-9]/g,'');
      return okey.length>=4 && o!==c && (okey.includes(key) || key.includes(okey));
    }).length;
    if(repeats>0) c.score += 3;
  });
  candidates.sort((a,b)=> b.score - a.score);

  if(candidates.length){
    establishment = candidates[0].text;
    confidences.establishment = candidates[0].score >= 6 ? 'high' : (candidates[0].score >= 3 ? 'medium' : 'low');
  } else {
    establishment = '';
    confidences.establishment = 'low';
  }
  } // end fallback scoring block

  // --- Category guess based on keywords, scored across whole receipt text (not first match wins) ---
  let category = 'Misc';
  const catMap = {
    Meals:['cafe','restaurant','kitchen','coffee','bar ','eatery','food','grill','bakery','pizzeria','sushi','diner','bistro','pub','takeaway','chicken','burger','noodle','kebab','thai','chinese restaurant','indian restaurant','laksa','pho ','dumpling'],
    Fuel:['fuel','bp ',' bp','shell','caltex','ampol','petrol','7-eleven','united petroleum'],
    Materials:['bunnings','hardware','timber','steel','trade','mitre 10','tools warehouse'],
    Software:['software','subscription','saas','adobe','microsoft','google','apple.com/bill','app store','openai','anthropic'],
    Travel:['uber','taxi','airline','airport','hotel','qantas','jetstar','virgin australia','airbnb','booking.com','car rental','avis','hertz'],
    Office:['officeworks','office national','stationery'],
    Tools:['tool', 'toolstop', 'sydney tools', 'total tools'],
    Parking:['parking','secure park','wilson parking','care park'],
    Subscriptions:['netflix','spotify','subscription','membership renewal'],
    Health:['pharmacy','chemist','medical','clinic','physio','dental'],
    Groceries:['woolworths','coles','aldi','iga','foodworks','supermarket'],
  };
  const lowerText = text.toLowerCase();
  let bestCat = {name:'Misc', hits:0};
  for(const [cat, keywords] of Object.entries(catMap)){
    let hits = 0;
    keywords.forEach(k=>{ if(lowerText.includes(k)) hits++; });
    if(hits > bestCat.hits) bestCat = {name:cat, hits};
  }
  // fallback: no brand/keyword match at all — look for generic structural signals that
  // strongly imply a dine-in/takeaway food order even when the venue name itself is unknown
  // (e.g. "Khaosan Lane", a restaurant this app has never seen keywords for)
  if(bestCat.hits===0){
    const mealSignals = ['table number','table\t','order number','order status','your order','dine in','dine-in','entree','main course','side dish','waiter','server','tip','gratuity'];
    let mealHits = 0;
    mealSignals.forEach(sig=>{ if(lowerText.includes(sig)) mealHits++; });
    if(mealHits>0) bestCat = {name:'Meals', hits:mealHits};
  }
  category = bestCat.hits > 0 ? bestCat.name : 'Misc';
  // add Groceries to the pill palette set used elsewhere if not already categorised
  if(!CATEGORIES.includes(category)) CATEGORIES.push(category);

  const overallLow = confidences.amount==='low' || confidences.date==='low' || confidences.establishment==='low';

  return {
    date, establishment, amount, currency:'AUD', category, notes:'',
    confidences, needsCheck: overallLow
  };
}

