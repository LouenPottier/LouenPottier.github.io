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

// Déplace .card-links hors du .card-body sur mobile (s'affiche sous l'image)
function setupMobileLinks() {
  const isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  document.querySelectorAll('.card').forEach(card => {
    const body = card.querySelector('.card-body');
    const links = card.querySelector('.card-links');
    if (!body || !links) return;
    if (isMobile) {
      if (!card.querySelector(':scope > .card-links')) {
        links.remove();
        card.appendChild(links);
      }
    } else {
      if (card.querySelector(':scope > .card-links')) {
        links.remove();
        body.appendChild(links);
      }
    }
  });
}

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
