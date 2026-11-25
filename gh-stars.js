/* gh-stars.js — compteur d'étoiles GitHub accolé à un lien « Code ».
 *
 * Usage : <a class="has-stars" data-gh-stars="Owner/Repo" href="https://github.com/Owner/Repo">
 *           <span data-en="Code" data-fr="Code">Code</span></a>
 * Le texte traduit va dans un <span> (lang.js réécrit l'innerHTML des éléments data-en :
 * posé sur le <a>, il effacerait le compteur). Le script ajoute <span class="gh-stars">★ N</span>
 * DANS le même lien : un seul lien, un seul clic. Le soulignement est porté par le span texte
 * seulement (style.css), pas par le compteur.
 * Nombre lu sur l'API GitHub (60 req/h/IP sans jeton), mis en cache 6 h dans localStorage.
 * En cas d'échec : dernière valeur en cache, sinon rien (le lien « Code » reste seul).
 */
(function () {
  const TTL = 6 * 3600 * 1000;
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function show(links, n) {
    links.forEach(a => {
      let s = a.querySelector('.gh-stars');
      if (!s) { s = document.createElement('span'); s.className = 'gh-stars'; a.appendChild(s); }
      s.textContent = '★ ' + fmt(n);
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
