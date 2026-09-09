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
   PINCH-TO-ZOOM (lightbox image only)
   Page-level pinch/double-tap zoom is disabled globally (see the
   viewport meta tag + touch-action rule in index.html), since it
   was causing accidental zoom on menu taps and month-nav double-taps.
   This recreates pinch-zoom scoped to just the receipt photo, and
   resets back to normal size automatically the moment both fingers
   lift — no separate "un-zoom" action needed.
   ============================================================ */
(function(){
  const img = document.getElementById('lightboxImg');
  if(!img) return;

  let startDist = 0;
  let currentScale = 1;

  function getDistance(touches){
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  img.addEventListener('touchstart', (e)=>{
    if(e.touches.length === 2){
      startDist = getDistance(e.touches);
      const rect = img.getBoundingClientRect();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const originX = ((midX - rect.left) / rect.width) * 100;
      const originY = ((midY - rect.top) / rect.height) * 100;
      img.style.transformOrigin = `${originX}% ${originY}%`;
      img.style.transition = 'none';
    }
  }, { passive: true });

  img.addEventListener('touchmove', (e)=>{
    if(e.touches.length === 2 && startDist > 0){
      e.preventDefault(); // stop anything underneath from trying to scroll while pinching
      const dist = getDistance(e.touches);
      currentScale = Math.min(Math.max(dist / startDist, 1), 4); // clamp between 1x and 4x
      img.style.transform = `scale(${currentScale})`;
    }
  }, { passive: false });

  function resetZoom(){
    startDist = 0;
    currentScale = 1;
    img.style.transition = 'transform 0.2s ease';
    img.style.transform = 'scale(1)';
  }
  img.addEventListener('touchend', resetZoom);
  img.addEventListener('touchcancel', resetZoom);
})();

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
