/* gh-stars.js — bulles de compteur à côté des boutons (style.css : a.code-btn).
 *
 * GitHub (étoiles) :
 *   <a class="code-btn" data-gh-stars="Owner/Repo" href="https://github.com/Owner/Repo">
 *     <span class="c"><span data-en="Code" data-fr="Code">Code</span></span></a>
 *   → bulle « ☆ N » seulement si N ≥ 10.
 * Hugging Face (téléchargements, total depuis la mise en ligne) :
 *   <a class="code-btn hf" data-hf-downloads="datasets/owner/name" href="https://huggingface.co/datasets/owner/name">
 *     <span class="c"><span data-en="Hugging Face" data-fr="Hugging Face">Hugging Face</span></span></a>
 *   → bulle « ⤓ N » seulement si N ≥ 100. (« models/… » ou « spaces/… » marchent aussi.)
 *
 * Le texte traduit est dans un <span> à part (lang.js réécrit l'innerHTML des éléments data-en).
 * Nombres lus sur les API publiques, cache localStorage 6 h ; en cas d'échec, dernière valeur
 * en cache, sinon pas de bulle.
 */
(function () {
  const TTL = 6 * 3600 * 1000;
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
  function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  const SOURCES = [
    { attr: 'ghStars', sel: 'a[data-gh-stars]', key: 'gh-stars:', min: 10, cls: 'n', title: 'GitHub stars',
      url: id => 'https://api.github.com/repos/' + id, pick: d => d.stargazers_count },
    { attr: 'hfDownloads', sel: 'a[data-hf-downloads]', key: 'hf-dl:', min: 100, cls: 'n dl', title: 'Hugging Face downloads',
      url: id => 'https://huggingface.co/api/' + id + '?expand[]=downloadsAllTime', pick: d => d.downloadsAllTime },
  ];

  SOURCES.forEach(src => {
    function show(links, n) {
      links.forEach(a => {
        let s = a.querySelector('.n');
        if (n < src.min) { if (s) s.remove(); return; }
        if (!s) { s = document.createElement('span'); s.className = src.cls; a.appendChild(s); }
        s.innerHTML = '<i aria-hidden="true"></i>' + fmt(n);
        s.title = n + ' ' + src.title;
      });
    }
    const byId = {};
    document.querySelectorAll(src.sel).forEach(a => {
      const id = a.dataset[src.attr];
      (byId[id] = byId[id] || []).push(a);
    });
    Object.keys(byId).forEach(id => {
      const key = src.key + id, links = byId[id], c = read(key);
      if (c && typeof c.n === 'number') show(links, c.n);
      if (c && Date.now() - c.t < TTL) return;
      fetch(src.url(id))
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(d => {
          const n = src.pick(d);
          if (typeof n !== 'number') return;
          write(key, { n: n, t: Date.now() });
          show(links, n);
        })
        .catch(() => {});
    });
  });
})();
