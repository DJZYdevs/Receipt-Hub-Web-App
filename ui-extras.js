/* ============================================================
   IMAGE LIGHTBOX
   ============================================================ */
const lightbox = document.getElementById('lightbox');
let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(images, startIndex=0){
  if(!images || images.length===0) return;
  lightboxImages = images;
  lightboxIndex = startIndex;
  renderLightbox();
  lightbox.classList.add('open');
}
function renderLightbox(){
  document.getElementById('lightboxImg').src = lightboxImages[lightboxIndex];
  document.getElementById('lightboxCount').innerText = `${lightboxIndex+1} / ${lightboxImages.length}`;
  document.getElementById('lightboxNav').style.display = lightboxImages.length>1 ? 'flex':'none';
  document.getElementById('lightboxPrev').disabled = lightboxIndex===0;
  document.getElementById('lightboxNext').disabled = lightboxIndex===lightboxImages.length-1;
}
function closeLightbox(){ lightbox.classList.remove('open'); }

document.getElementById('lightboxClose').onclick = closeLightbox;
document.getElementById('lightboxPrev').onclick = ()=>{ if(lightboxIndex>0){ lightboxIndex--; renderLightbox(); } };
document.getElementById('lightboxNext').onclick = ()=>{ if(lightboxIndex<lightboxImages.length-1){ lightboxIndex++; renderLightbox(); } };
// tap the dark backdrop area (not the image itself) to close
document.getElementById('lightboxStage').addEventListener('click', (e)=>{
  if(e.target.id==='lightboxStage') closeLightbox();
});

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 2600);
}
