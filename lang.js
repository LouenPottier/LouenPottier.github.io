/**
 * Bilingual EN / FR switcher
 * Works on any element with data-en="..." and data-fr="..." attributes.
 * The chosen language is saved in localStorage so it persists across pages.
 */

function setLang(lang) {
  // Update all translatable elements
  document.querySelectorAll('[data-en]').forEach(el => {
    const text = el.getAttribute('data-' + lang);
    if (text !== null) el.innerHTML = text;
  });

  // Update <html lang>
  document.documentElement.lang = lang;

  // Update button states
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === lang);
  });

  // Persist
  try { localStorage.setItem('cv_lang', lang); } catch(e) {}
}

// On page load: restore saved language
(function () {
  let saved = 'en';
  try { saved = localStorage.getItem('cv_lang') || 'en'; } catch(e) {}
  setLang(saved);
})();
