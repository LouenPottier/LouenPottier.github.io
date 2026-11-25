/* gh-stars.js — bulle « ★ N » à côté des boutons « Code » (style.css : a.code-btn).
 *
 * Usage : <a class="code-btn" data-gh-stars="Owner/Repo" href="https://github.com/Owner/Repo">
 *           <span class="c"><span data-en="Code" data-fr="Code">Code</span></span></a>
 * Le texte traduit est dans un <span> à part (lang.js réécrit l'innerHTML des éléments data-en).
 * Règle : la bulle n'apparaît que si le dépôt a au moins MIN étoiles (10) ; en dessous, le bouton
 * reste seul. Nombre lu sur l'API GitHub (60 req/h/IP sans jeton), cache localStorage 6 h ;
 * en cas d'échec, dernière valeur en cache, sinon pas de bulle.
 */
(function () {
  const TTL = 6 * 3600 * 1000, MIN = 10;
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function show(links, n) {
    links.forEach(a => {
      let s = a.querySelector('.n');
      if (n < MIN) { if (s) s.remove(); return; }
      if (!s) { s = document.createElement('span'); s.className = 'n'; a.appendChild(s); }
      s.innerHTML = '<i aria-hidden="true"></i>' + fmt(n);
      s.title = n + ' GitHub stars';
    });
  }
  const byRepo = {};
  document.querySelectorAll('a[data-gh-stars]').forEach(a => {
    (byRepo[a.dataset.ghStars] = byRepo[a.dataset.ghStars] || []).push(a);
  });
  Object.keys(byRepo).forEach(repo => {
    const key = 'gh-stars:' + repo, links = byRepo[repo], c = read(key);
    if (c && typeof c.n === 'number') show(links, c.n);
    if (c && Date.now() - c.t < TTL) return;
    fetch('https://api.github.com/repos/' + repo)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        if (typeof d.stargazers_count !== 'number') return;
        write(key, { n: d.stargazers_count, t: Date.now() });
        show(links, d.stargazers_count);
      })
      .catch(() => {});
  });
})();
