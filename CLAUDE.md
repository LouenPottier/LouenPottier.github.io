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
lang.js             — Switcher EN/FR (chargé sur toutes les pages)
site.js             — Lightbox + comportement mobile (chargé sur publications et projects)

logos/              — Logos institutions (PNG fond transparent)
img/                — Images de cartes et publications
videos/             — Vidéos MP4 (simulation, démos)
pdf/                — CV, articles, posters

demo/               — Démos interactives standalone (voir avertissement ci-dessous)
```

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

## ⚠️ Fichiers demo/ — Avertissement tokens

Les poids d'un réseau de neurones sont sérialisés en JSON sur **une seule ligne géante** (**plusieurs centaines de kilooctets, voire plusieurs Mo**). Ne **jamais** lire ces lignes — cela consommerait des dizaines de milliers de tokens inutilement.

Les poids ont été **extraits** dans des fichiers JS dédiés (juin 2026), chargés via `<script src="...">` avant le bloc inline de chaque démo. **Ne jamais lire ces fichiers** (une seule ligne, plusieurs Mo) :
- `demo/prehenseur-weights.js` : `const W = {...}`, ~2,2 Mo
- `demo/lebnn-weights.js` : `const LEBNN_RAW = {...}`, ~2,6 Mo (référencé dans `loadWeights()` via `const raw = LEBNN_RAW;`)

Les deux HTML (`demo/prehenseur.html`, `demo/lebnn.html`) sont désormais **entièrement lisibles** (plus aucune ligne lourde).
