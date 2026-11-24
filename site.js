/* ── LIGHTBOX (image + vidéo) ── */

function openLightboxImg(src, alt) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const vid = document.getElementById('lightbox-video');
  img.src = src; img.alt = alt;
  img.style.display = 'block';
  vid.style.display = 'none';
  vid.pause();
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}

// Alias utilisé dans projects.html (doit être sur window pour les onclick HTML)
window.openLightbox = openLightboxImg;

function openLightboxVideo(src) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const vid = document.getElementById('lightbox-video');
  img.style.display = 'none';
  vid.src = src;
  vid.style.display = 'block';
  vid.play();
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  const vid = document.getElementById('lightbox-video');
  lb.classList.remove('active');
  vid.pause();
  vid.src = '';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

/* ── COMPORTEMENT MOBILE ── */

// Seuil mobile synchronisé avec le breakpoint CSS (style.css @media max-width: 720px)
const MOBILE_BREAKPOINT = 720;

// Déplace .card-links hors du .card-body sur mobile, pour l'afficher sous
// l'image. Le « Cited by » est rangé DANS .card-links, à côté des liens.
function setupMobileLinks() {
  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  document.querySelectorAll('.card').forEach(card => {
    const body = card.querySelector('.card-body');
    const links = card.querySelector('.card-links');
    if (!body || !links) return;
    const cited = card.querySelector('.cited-by');
    if (isMobile) {
      if (!card.querySelector(':scope > .card-links')) {
        card.appendChild(links);
        if (cited) links.appendChild(cited);   // sur la même ligne que arXiv / PDF
      }
    } else {
      if (card.querySelector(':scope > .card-links')) {
        body.appendChild(links);
        if (cited) body.appendChild(cited);
      }
    }
  });
}

// Autoplay robuste sur mobile : relance play() une fois les métadonnées
// chargées. Si le navigateur refuse (économie d'énergie…), le poster reste.
function setupAutoplayVideos() {
  document.querySelectorAll('.card-video video[autoplay]').forEach(v => {
    v.muted = true;
    const tryPlay = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
    if (v.readyState >= 1) tryPlay(); else v.addEventListener('loadedmetadata', tryPlay, { once: true });
  });
}
setupAutoplayVideos();

// Clone les logos de .card-logo-col dans .tech-pills sur mobile (projects.html)
function setupMobileLogos() {
  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  document.querySelectorAll('.card-with-logo').forEach(card => {
    const pills = card.querySelector('.tech-pills');
    const logoCol = card.querySelector('.card-logo-col');
    if (!pills || !logoCol) return;
    pills.querySelectorAll('.mobile-logo').forEach(el => el.remove());
    if (isMobile) {
      const wrapper = document.createElement('li');
      wrapper.className = 'mobile-logo';
      logoCol.querySelectorAll('img').forEach(img => {
        wrapper.appendChild(img.cloneNode());
      });
      pills.appendChild(wrapper);
    }
  });
}

setupMobileLinks();
setupMobileLogos();
window.addEventListener('resize', () => { setupMobileLinks(); setupMobileLogos(); });

// « Cited by » (publications.html) : déplier la liste ne doit pas déplacer l'image.
// La colonne image est centrée verticalement (align-self: center) ; on fige sa
// position au moment du dépliement, puis on rend le centrage à la fermeture.
function setupCitedBy() {
  document.querySelectorAll('.card .cited-by').forEach(details => {
    const card = details.closest('.card');
    const imgCol = card && card.querySelector(':scope > .card-image-col');
    const summary = details.querySelector('summary');
    if (!imgCol || !summary) return;
    summary.addEventListener('click', () => {
      if (details.open || window.innerWidth <= MOBILE_BREAKPOINT) return;
      const anyOpen = card.querySelector('.cited-by[open]');
      if (anyOpen) return;
      const offset = imgCol.getBoundingClientRect().top - card.getBoundingClientRect().top
        - parseFloat(getComputedStyle(card).paddingTop);
      imgCol.style.alignSelf = 'start';
      imgCol.style.marginTop = offset + 'px';
    });
    details.addEventListener('toggle', () => {
      if (!details.open) {
        imgCol.style.alignSelf = '';
        imgCol.style.marginTop = '';
      }
    });
  });
}
setupCitedBy();
