# LouenPottier.github.io — Guide pour agents IA

Site CV statique déployé via GitHub Pages. Pas de build tool, pas de framework : HTML/CSS/JS vanilla.

## Architecture

```
index.html          — Page principale : hero, timeline, compétences
publications.html   — Publications scientifiques (cartes avec lightbox)
projects.html       — Projets industriels/recherche (cartes avec logos)
teaching.html       — Enseignements
splat-viewer.html   — Viewer 3D Gaussian Splatting (Three.js, standalone)

style.css           — Feuille de style unique (950 lignes)
lang.js             — Switcher EN/FR (chargé sur index/publications/projects/teaching, PAS sur splat-viewer)
site.js             — Lightbox + comportement mobile (chargé sur publications et projects)

logos/              — Logos institutions (PNG fond transparent)
img/                — Images de cartes et publications
videos/             — Vidéos MP4 (simulation, démos)
pdf/                — CV, articles, posters
splats/             — Fichiers .splat/.ply pour splat-viewer.html

demo/               — Démos interactives standalone (voir avertissement ci-dessous)

sitemap.xml, robots.txt  — SEO (mettre à jour sitemap.xml lastmod si pages modifiées)
```

`splat-viewer.html` est entièrement standalone (Three.js via CDN r128, pas de lang.js/site.js/style.css). C'est un mini-viewer 3D de nuages de points `.splat` (Gaussian Splatting), **embarqué en `<iframe>`** dans `projects.html` (une seule occurrence, ligne ~183) pour illustrer une carte projet. Il se pilote **par paramètres d'URL** :

```
splat-viewer.html?src=./splats/arkose.splat&fov=3&dist=4.5&bg=0x111111
```
- `src` — fichier `.splat` (format binaire 32 o/point : position float32 + couleur uint8)
- `fov` — focale caméra · `dist` — multiplicateur de distance caméra · `bg` — couleur de fond (hexa)

Rendu `THREE.Points` + shader custom, auto-rotation en boucle. **Purement décoratif, aucune interaction souris.**

## Système de design (style.css)

Les couleurs et tokens sont définis dans `:root` — **ne jamais hardcoder une valeur, toujours utiliser les variables** :

```css
--bg, --surface          /* fonds */
--border, --border-soft  /* bordures */
--navy, --navy-mid, --navy-light  /* bleu marine (accents, nav) */
--text, --text-mid, --text-muted, --text-faint  /* hiérarchie texte */
--radius: 3px
--card-shadow: ...
```

Polices :
- `Lora` — titres serif (`h1`–`h4`, `.card-title`)
- `Source Sans 3` — corps de texte et UI
- `JetBrains Mono` — tags tech (`.card-tag`, `.tech-pills`)

Breakpoint unique : `720px` (mobile). Ce seuil apparaît aussi dans `site.js`.

## Système bilingue (lang.js)

**Règle absolue** : tout texte visible doit porter `data-en="..."` et `data-fr="..."`. Ne pas écrire de texte brut dans les balises.

```html
<p data-en="English text" data-fr="Texte français">English text</p>
```

`lang.js` injecte le texte via `innerHTML` (donc les entités HTML comme `&amp;` sont supportées). La langue est persistée dans `localStorage` sous la clé `cv_lang`.

## Modèle d'une carte publication/projet

Structure HTML minimale :

```html
<article class="card">
  <div class="card-image-col">
    <!-- Image cliquable (lightbox) -->
    <div class="card-image card-image-clickable"
         onclick="openLightboxImg('./img/foo.png', 'alt text')"
         title="Cliquer pour agrandir">
      <img alt="..." src="./img/foo.png"/>
    </div>
    <!-- ou vidéo : onclick="openLightboxVideo('./videos/foo.mp4')" avec <video> -->
    <p class="card-caption" data-en="..." data-fr="...">Caption</p>
  </div>
  <div class="card-body">
    <span class="card-tag" data-en="Type · Lieu · Année" data-fr="...">...</span>
    <h2 class="card-title">Titre</h2>
    <p class="card-authors">Auteur A, <strong>Auteur principal</strong>, Auteur B</p>
    <p class="card-desc" data-en="..." data-fr="...">Description</p>
    <div class="card-links">
      <a href="..." target="_blank" data-en="Lien" data-fr="Lien">Lien</a>
      <a class="card-link-pdf" href="./pdf/foo.pdf" target="_blank"
         data-en="↓ PDF" data-fr="↓ PDF">↓ PDF</a>
    </div>
  </div>
</article>
```

Pour une carte avec logo (projects.html), ajouter `.card-with-logo` sur `<article>` et une `<div class="card-logo-col">` après `.card-body`.

## Comportement JS (site.js)

`site.js` est chargé sur `publications.html` et `projects.html`. Il fournit :

- **Lightbox image** : `openLightboxImg(src, alt)` — alias `openLightbox(src, alt)`
- **Lightbox vidéo** : `openLightboxVideo(src)`
- **Fermeture** : `closeLightbox()` + touche Escape
- **Mobile links** : `setupMobileLinks()` — déplace `.card-links` hors du `.card-body` sur mobile pour l'afficher sous l'image
- **Mobile logos** : `setupMobileLogos()` — clone les logos de `.card-logo-col` dans `.tech-pills` sur mobile

Le HTML du lightbox doit être présent dans chaque page qui charge `site.js` :

```html
<div class="lightbox" id="lightbox" onclick="closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
  <img alt="" id="lightbox-img" src="" style="display:none"/>
  <video autoplay id="lightbox-video" loop muted playsinline
         style="display:none; max-width:90vw; max-height:88vh; border-radius:3px; box-shadow:0 8px 48px rgba(0,0,0,0.5);">
  </video>
</div>
```

## Ajouter du contenu

- **Nouvelle publication** : copier le bloc `<article class="card">` dans `publications.html`, adapter textes, image, liens PDF.
- **Nouveau projet** : copier dans `projects.html`, utiliser `.card-with-logo` si logo institution dispo.
- **Nouvelle entrée timeline** : voir `index.html`, section `<!-- TIMELINE -->`, copier un bloc `.timeline-item`.
- **Nouveau logo** : déposer un PNG fond transparent dans `logos/`, taille ~200px de large.

Pour les détails exhaustifs (encoding vidéo, règles i18n, etc.) → voir `GUIDE.md`.

## Onglet « sac » de lagsplat.html — physique apprise

Contrairement aux deux autres onglets, la dynamique du sac n'est **pas** un oscillateur
linéaire ajusté : c'est le Lagrangien appris de `lnn.pt` (dépôt LaGS), celui de la figure
`fig_sac_rollout.pdf` de l'article, évalué dans le navigateur.

- `demo/sac_lnn.js` — poids exportés (`window.SAC_LNN`) : blanchiment latent, potentiel
  invexe (difféo i-ResNet + ICNN + Bregman), masse `M̂(q)` et dissipation `C(q)`.
- `demo/sac_lnn_dyn.js` — portage JS (`window.SacLNN`) : `accel`, `step` (RK4), `toU`/`toZ`/
  `forceToU`. Les dérivées que PyTorch obtient par autograd sont calculées en mode direct.

⚠️ **Le `C(q)` appris est quasi rang 1 partout**, et s'effondre au plancher SPD (1e-4) dans
un îlot centré sur l'équilibre (λ ≈ 4e-4 / 2e-3 contre jusqu'à 0,58 au bord). Conséquence :
l'oscillation libre s'amortit jusqu'à ~1/3 d'amplitude puis **stagne indéfiniment**. Ce n'est
pas un défaut du portage (vérifié contre PyTorch sur toute une grille), c'est `lnn.pt`. La
figure de l'article ne l'exposait pas : son horizon de 9 s s'arrête avant le plateau.
La démo ajoute donc un plancher ADDITIF `c₀·M̃(q)` (Rayleigh proportionnel à la masse, le
mode par défaut du pipeline Python) — mettre `C` à l'échelle ne comblerait pas le trou, c'est
multiplicatif. Curseur Dissipation : ≤ 50 met le `C(q)` appris à l'échelle sans plancher
(50 = `lnn.pt` pur), > 50 ajoute `c₀` jusqu'à 0,04. Défaut 62 → `c₀` ≈ 0,010, extinction
en ~27 s.

Le décodeur de l'atlas est indépendant de la dynamique : `decoder2dpt_ae_2048.pt` par défaut
(rendu doux, JS ~400 Ko), `--decoder decoder2dpt_15k.pt` pour la version nette (JS ~1 Mo,
c'est celui de `fig_sac_rollout.pdf`). Les deux partagent `encoder_ae.pt`, donc le même
espace latent que `lnn.pt`.

**Deux espaces, à ne jamais mélanger** : le LNN intègre dans l'espace BLANCHI `u`
(std 1) ; l'atlas de sprites, les gaussiennes et le plan de phase vivent dans l'espace
latent BRUT `z`. `st.u`/`st.ud` portent l'état, `st.q` en est le miroir en `z`.
**Unité de temps** : le LNN a été entraîné à `dt = 1 frame` (30 fps), pas en secondes.

Régénération, dans le dépôt LaGS (`demo_Lags/`) — l'ordre compte :

```
py ../code_new_3D/pipeline2_updated/make_z_enc.py --config ../sac/config.py --stride 1
py extract_sac.py        # sac_frames.png + sac_gaussians.js (--decoder pour changer)
py export_sac_lnn.py     # sac_lnn.js
py check_sac_lnn.py      # vérifie le portage JS contre PyTorch (pip install py-mini-racer)
```

puis copier `sac_frames.png`, `sac_gaussians.js`, `sac_lnn.js` dans `demo/` **et bumper le
`?v=` de `sheet.src`** dans le bloc du sac de `lagsplat.html` (sinon atlas en cache).

## Démos demo/

Chaque HTML est standalone et lisible. Les poids du réseau de neurones sont chargés via `<script src>` avant le bloc inline.

| HTML | Sujet | Poids (var globale) | Statut |
|------|-------|---------------------|--------|
| `prehenseur.html` | Pneumatic gripper simulé par LEBNN | `prehenseur-weights.js` · `W` (~2,2 Mo) | ✅ **Actif** — lié depuis publications.html + projects.html |
| `lebnn.html` | LEBNN · poutre cantilever 20-DOF | `lebnn-weights.js` · `LEBNN_RAW` (~2,6 Mo) | ⚠️ **Obsolète** — non lié, archive |
| `4dgs.html` + `3d.html` | 4DGS — scène Gaussian Splatting pilotée par la physique latente. `4dgs.html` est la page hôte (texte + curseurs), `3d.html` le viewer WebGL embarqué en iframe, pilotable aussi en plein écran. Pont par `postMessage`. | scène inlinée dans `3d.html` : `__SCENE_META` + `__SCENE_BIN_B64` (~3,8 Mo) | ⚠️ **Non liée** — pas encore référencée depuis publications/projects |
| `../lagsplat.html` (à la **racine**, pas dans `demo/`) | LaGS — Gaussian Splatting indexé par état (3 onglets : pendule synthétique, rocking chair d=1, sac d=2). Ses assets restent dans `demo/` (`lags_architecture.png`, `rocking_*`, `sac_*`, iframe `demo/3d.html`) → chemins préfixés `./demo/`, y compris l'atlas chargé en JS (`sheet.src = './demo/' + D.sheet`). `demo/lags_demo.html` n'est plus qu'une page de redirection vers l'ancienne URL. | rocking chair : `rocking_gaussians.js` · `ROCKING_DATA` (~450 Ko) + `rocking_frames.png` (~3,5 Mo, atlas binaire) · sac : `sac_gaussians.js` · `SAC_DATA` (~400 Ko) + `sac_frames.png` (~11 Mo, atlas binaire) + `sac_lnn.js` · `SAC_LNN` (~290 Ko, poids du LNN) + `sac_lnn_dyn.js` (portage lisible) | ✅ **Actif** — lié depuis publications.html (carte « Learning Physics from Video ») |

> ⚠️ **Ne jamais lire** les fichiers de poids ci-dessus ni `rocking_frames.png`, `sac_gaussians.js`, `sac_lnn.js`, `sac_frames.png` : JSON sur **une seule ligne géante** (centaines de Ko à plusieurs Mo) ou binaire → des dizaines de milliers de tokens pour rien. Idem pour les **lignes 260–261 de `3d.html`** (`__SCENE_META`, `__SCENE_BIN_B64`) : lire ce fichier par plages de lignes en les évitant.
