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
en ~27 s. ⚠️ L'étiquette du curseur suit les DEUX régimes (`×0.74` sous la mi-course,
`×1.00 + c₀ 0.010` au-dessus) : afficher le seul rapport `v/50` sur toute la course
faisait lire « ×1,24 » là où le `C(q)` appris est en réalité intact.

**Le rendu se fait EN DIRECT, plus par un atlas.** L'onglet lisait sa reconstruction dans
une mosaïque 19×19 de tuiles pré-décodées (`sac_frames.png`, 11 Mo, 128×128 par tuile,
mélangées bilinéairement). Il rasterise maintenant les 15 000 gaussiennes à chaque image
en WebGL2, par `demo/gs_splat.js` — le même module que l'onglet d=4, générique en `d`.
C'est plus léger (1,4 Mo de blocs de Schur en base64 contre 11 Mo de PNG) et EXACT : la
coupe est calculée à l'état courant au lieu d'être interpolée entre quatre tuiles. Toute
la recette de rendu (flou `eps2d`, terme « pancake », ordre d'INDEX) est celle décrite
dans la section SCR souple ci-dessous — mesurée, pas devinée : PSNR 43,7 dB contre gsplat,
**15,8 en ordre inversé**.

Le décodeur est du même coup `decoder2dpt_15k.pt`, celui de `fig_sac_rollout.pdf`, que
l'atlas ne pouvait pas se payer (`--decoder decoder2dpt_ae_2048.pt` pour l'ancien rendu
doux). Les deux partagent `encoder_ae.pt`, donc le même espace latent que `lnn.pt` :
changer de décodeur ne touche QUE l'image, jamais la dynamique.

La prise interactive passe aussi par le module, en **ancrage MATÉRIEL** : `select()` fige
le paquet de gaussiennes au clic, `pointOf()` rend sa position courante — le point
d'application suit donc l'objet et la force se contracte quand il rejoint la souris.
(L'onglet d=4 utilise l'autre variante, un point d'écran fixe.) L'amplitude est modulée
par la **présence**, pour la raison expliquée dans la section SCR souple.

**Deux espaces, à ne jamais mélanger** : le LNN intègre dans l'espace BLANCHI `u`
(std 1) ; les gaussiennes du décodeur et le plan de phase vivent dans l'espace latent
BRUT `z`. `st.u`/`st.ud` portent l'état, `st.q` en est le miroir en `z`.
**Unité de temps** : le LNN a été entraîné à `dt = 1 frame` (30 fps), pas en secondes.

Régénération, dans le dépôt LaGS (`demo_Lags/`) — l'ordre compte :

```
py ../code_new_3D/pipeline2_updated/make_z_enc.py --config ../sac/config.py --stride 1
py extract_sac_live.py --ref   # sac_splat.js + sac_splat_meta.js (+ références gsplat)
py export_sac_lnn.py           # sac_lnn.js
py check_sac_lnn.py            # portage de la dynamique vs PyTorch (pip install py-mini-racer)
py check_krauss2_splat.py --case sac   # recette de rendu vs gsplat + indexation du .bin
```

puis copier `sac_splat.js`, `sac_splat_meta.js`, `sac_lnn.js` dans `demo/`.
`extract_sac.py` (atlas) n'est plus utilisé par le site.

## Onglet « rocking chair » de lagsplat.html — d=1, rendu en direct

C'était le dernier onglet sur ATLAS (`rocking_frames.png`, 3,5 Mo, 128 tuiles de 128×128
mélangées linéairement). Il rasterise maintenant 15 000 gaussiennes à chaque image par
`demo/gs_splat.js`, comme le sac et le SCR souple. Le flou venait de là : la tuile faisait
128 px et la page l'étirait jusqu'à ~900.

⚠️ **Deux espaces latents, et c'est le piège propre à cet onglet.** Le décodeur direct est
`decoder2dpt_15k.pt` du cas `rainbow` (μ_z ∈ [−1,54, +1,58]) ; l'atlas qu'il remplace
venait d'un autre entraînement, dans un espace où μ_z ∈ [30, 59]. Ce ne sont PAS deux vues
du même espace. Rien ne casse parce que la page ne transporte jamais un z d'un espace à
l'autre : `zToFrac`/`fracToZ` réduisent l'état à une fraction NORMALISÉE `frac` de la plage
entraînée, et `qLive()` la reconvertit dans l'espace du décodeur — seul endroit du fichier
qui touche à cet espace.

⚠️ **Le SENS de cette conversion (`orient`) est MESURÉ, pas deviné.** Rien ne garantit
qu'un z croissant penche le fauteuil du même côté d'un entraînement à l'autre, et
l'inverser ne lèverait aucune erreur : le fauteuil oscillerait simplement en opposition
de phase avec sa dynamique, et la prise pousserait à l'envers.
`demo_Lags/check_rocking_live.py` corrèle les deux bouts de plage des deux décodeurs :
**0,94 dans le sens direct contre 0,53 à l'envers** → `orient = +1`, gravé dans le meta.
⚠️ Chaque décodeur doit y être rendu sous la recette de SON entraînement — l'atlas sous le
rasteriseur normalisé de `models_2pt`, le 15k sous la recette gsplat de
`check_krauss2_splat.render`. Rendre le 15k sous le rasteriseur normalisé donne une
**bouillie**, et la corrélation tombe à 0,68 / 0,45 : de quoi conclure juste par accident.

**Le décodeur `decoder2dpt_15k.pt` est le meilleur disponible** — vérifié, pas supposé :
les quatre checkpoints de même architecture du cas (`_15k`, `_all`, `_ae_2048`,
`decoder2dpt`) rendus au même état sous la même recette, les trois variantes à 2048
gaussiennes sont nettement plus floues. Les `decoder2dmlp_*` sont d'une autre architecture
(μ conditionné par un MLP, pas affine en q) : ils ne se conditionnent pas en forme close et
`gs_splat.js` ne peut pas les rendre. Changer de décodeur n'est donc PAS un levier ici ;
le levier est `maxSide`.

**La DYNAMIQUE ne change pas.** Elle reste celle de `rocking_dynamics.js` (même équation
que le viewer 3D `demo/3d.html`), et la **prise** reste calculée sur `ROCKING_DATA`
(`rockJac`, 2048 gaussiennes) : changer de décodeur ne touche QUE l'image. Les deux
décodeurs rendent la même scène dans le même `[0,1]²`, donc le point cliqué désigne la
même matière. `rocking_gaussians.js` sert toujours au panneau 3D « volume espace-état »
et à la prise ; `rocking_frames.png` n'est plus lu par personne.

⚠️ **Le rendu est PLAFONNÉ (`maxSide = 512`)** via `GSSplat.create(..., {maxSide})` ; le
CSS agrandit ensuite le canevas. C'est un compromis entre deux défauts opposés : à la
résolution du canevas (~900) la structure des gaussiennes devient visible, à 256 — la
résolution d'entraînement — l'image est fidèle mais molle une fois étirée. Rendre au-delà
de l'entraînement n'ajoute aucun détail : `eps2d` vaut 0,3 px² à TOUTE résolution, donc à 768 px les
gaussiennes reçoivent 3× moins de flou *relatif* que celui avec lequel elles ont été
ajustées, et leur structure devient visible. Le rendu paraît alors « trop net » — ce qui se
lit comme un défaut de rasterisation alors que c'est une sur-résolution. Mettre `eps2d` à
l'échelle ne suffit pas (mesuré : les deux images sont presque superposables) ; c'est bien
la résolution de rendu qu'il faut borner. `maxSide` reste **optionnel et désactivé par
défaut dans `gs_splat.js`**, mais `lagsplat.html` le passe désormais aux **trois**
décodeurs (512 px) — voir la section « Coût d'affichage » ci-dessous.

La flèche de force est passée sur un canevas d'**overlay** (`#cRockOverlay`) : `#cRockRecon`
est désormais WebGL2 et ne peut plus donner de contexte 2D. Même montage que le sac et le
SCR souple.

Régénération, dans le dépôt LaGS (`demo_Lags/`) — l'ordre compte :

```
py extract_rocking_live.py     # rocking_splat.js + rocking_splat_meta.js (+ .bin)
py check_rocking_live.py       # mesure `orient` + contrôle l'indexation du .bin
py extract_rocking_live.py     # re-grave l'orient mesuré dans le meta
py check_krauss2_splat.py --case rock   # recette de rendu (nécessite gsplat + les
                                        #   références --ref)
```

puis copier `rocking_splat.js`, `rocking_splat_meta.js` dans `demo/`.
`extract_rocking.py` ne sert plus qu'au panneau 3D (`rocking_gaussians.js`).

## Onglet « SCR souple » de lagsplat.html — d=4, actionné, décodeur en direct

Quatrième expérience : le robot continuum souple 2-segments de Krauss et al. 2026, sur
leurs NPZ et leur découpe (cas `krauss2026_2seg_npz` du dépôt LaGS). Deux ruptures avec
les trois onglets précédents.

**1. Pas d'atlas — le décodeur GS tourne dans le navigateur.** Plus aucun onglet ne lit
sa reconstruction dans une mosaïque pré-décodée : le rocking chair (d=1) a été le dernier
à basculer. En d=4 il en faudrait de toute façon 19⁴ = 130 321 tuiles : impossible. `demo/gs_splat.js` re-rasterise donc les 15 000
gaussiennes à chaque image en WebGL2 : conditionner la gaussienne jointe sur `q` est une
formule fermée valable en toute dimension (moyenne affine, `Σ_cond` indépendante de `q`,
poids `w_z`) — d'où un module **générique en `d`**, que l'onglet sac (d=2) utilise aussi
depuis qu'il a laissé tomber son atlas. C'est EXACT et non interpolé, et **plus léger que
l'atlas** : 1,8 Mo de blocs de Schur contre 11 Mo de PNG.

⚠️ **L'accumulation se fait en RGBA16F, pas dans le framebuffer du canevas.** Celui-ci est
RGBA8 : en compositing front-to-back, `dst.rgb` et `dst.a` sont ré-arrondis à 8 bits après
CHAQUE gaussienne. Sur 15 000 gaussiennes dont beaucoup ne portent qu'une opacité infime,
les contributions faibles sont arrondies à zéro et la transmittance devient grossière —
image plus dure, aplats plus francs, ce qui se lit comme un défaut de rasterisation.
Mesuré sur le rocking chair à 256 px contre une accumulation float64 : **27,6 dB en RGBA8
contre 70,5 en RGBA16F**. `gs_splat.js` accumule donc dans une texture RGBA16F recopiée
ensuite sur le canevas (repli sur le chemin direct si l'extension de rendu flottant
manque). Cela vaut pour les TROIS onglets rendus en direct, pas seulement le d=1 : c'est
simplement invisible sur une scène simple.

⚠️ **Le chemin WebGL a sa propre vérification, `demo/_rock_check.html`** (à servir en HTTP).
`check_krauss2_splat.py` compare la référence numpy à gsplat — il ne dit RIEN du portage
WebGL, qui n'avait jamais été mesuré contre quoi que ce soit avant. La page rasterise dans
le navigateur, charge les références numpy de `demo/_rock_ref/` (regénérables depuis
`check_krauss2_splat.render` à 256 px) et affiche le PSNR par état plus la carte d'écart.
⚠️ Le canevas de test doit être DANS le document : `resize()` lit `clientWidth`, nul sur un
élément détaché — le rendu part alors dans un tampon 1×1 et la colonne « navigateur » reste
noire, ce qui ressemble à un décodeur muet.

⚠️ **La recette de rendu est mesurée, pas devinée.** Le décodeur a été entraîné sous
`gsplat.rasterization` : il ne suffit pas de dessiner « une gaussienne 2D ». Il faut le
flou d'anticrénelage `eps2d = 0.3 px²`, le terme radial de la gaussienne 3D « pancake »
(`eps_z = 1e-5`, projetée par une caméra fictive de focales (W,H) à Z = 1), l'opacité
`clamp(α·w_z, 0, 0.99)`, et le compositing front-to-back **dans l'ordre d'INDEX** —
possible parce que `models_2pt.py` pose toutes les gaussiennes à `Z = 1.0` exactement, ce
qui fait du tri par profondeur une égalité parfaite. PSNR contre gsplat :
**46,5 dB** pour cette recette · 38,2 sans `eps2d` · 43,7 sans le terme pancake ·
**15,2 en ordre inversé**. Ces 31 dB d'écart sont ce qui établit l'hypothèse d'ordre — ne
pas y toucher sans rejouer `check_krauss2_splat.py`. Côté WebGL l'ordre s'obtient sans
aucun tri, par le blending `(ONE_MINUS_DST_ALPHA, ONE)` : `1 − dst.a` porte la
transmittance.

Le rendu utilise un **viewport carré centré** (le décodeur rend en `[0,1]²`) ; les
coordonnées du canevas ne sont donc pas celles de l'image — `toImage()` / `imgVec()`
font la conversion avant tout calcul de force, sinon la prise serait anisotrope.

**2. Le système est ACTIONNÉ.** 4 chambres de pression entrent au second membre
d'Euler-Lagrange comme force généralisée `b(q)ᵀP`, avec `ν_φ = −(ICNN convexe ∘ difféo)`
CONCAVE (mode `'invex'`, `models.InvexVolume`) — le signe est essentiel : une `ν` convexe
rendrait l'équilibre chargé instable. `demo/krauss2_lnn_dyn.js` est le pendant générique
en `d` de `sac_lnn_dyn.js` (qui déroulait des 2×2 à la main), plus ce chemin de pression.
(La DYNAMIQUE reste donc en deux portages ; seul le RENDU est unifié, dans `gs_splat.js`.)

⚠️ **Unité de pression** : le LNN attend `p[Pa]/101325`. Les curseurs sont en kPa →
passer par `Krauss2LNN.kpaToP()`. **Ne PAS** utiliser `config.PRESSURE_NORM`, qui vaut
1.0 sur la source NPZ (Krauss a déjà normalisé) et enverrait 25 000 au lieu de 0,247.

⚠️ **`c₀` fait partie du checkpoint sans y être stocké.** Le plancher SPD de la
dissipation (`C(q) = L(q)L(q)ᵀ + c₀·I`) est une constante de config lue à la construction
du LNN, absente du `state_dict`. `lnn_2seg_lr1e-3_c1_s1_500ep.pt` chargé sous le
`config.py` du cas (`c₀ = 5e-3`) donnerait une dissipation **200× trop faible sans lever
d'erreur** — d'où `config_live.py`, qui porte `LNN_RAYLEIGH_CQ_EPS = 1.0`. L'export le
vérifie par `assert`.

**Unité de temps** : `dt = 1 frame` à 59,94 fps (`DT = 1001/60000`), pas des secondes.
Vitesse ×1 = temps réel. Modes propres : 0,70 / 1,03 / 1,51 / 2,79 Hz.

**Prise interactive : point d'application FIXE.** Le point d'application est celui du clic
et n'en bouge plus ; à chaque frame `Krauss2Splat.select()` reprend les gaussiennes qui
passent à cet endroit de l'écran, et leur `J̄` transporte la force. `J = ∂μ/∂z` est constant
par gaussienne (le décodeur est affine en z) ; ce qui varie, c'est QUELLES gaussiennes sont
là — attraper le bout du bras ne tire donc pas comme attraper sa base, sans seuil ad hoc.
La variante à ancrage MATÉRIEL (figer le paquet au clic et suivre sa position) existe dans
le module — `pointOf()` / `presence()`, testées par `anchor_check.py` — mais **n'est pas
câblée** dans la page.

L'amplitude est modulée par la **présence** de la matière au point d'application,
rapportée à celle du clic et plafonnée à 1. ⚠️ Sans ce facteur elle n'en dépendrait PAS :
`J̄` est une moyenne NORMALISÉE (division par `Σw`), donc `Σw` se simplifie et un filament
quasi transparent tirerait aussi fort que de la matière franche (la référence serveur
`latent_force` a le même angle mort). Le facteur est RELATIF parce que la présence absolue
ne vaut jamais ~1 même sur de la matière franche — 0,33 mesuré sur une prise typique, les
gaussiennes d'un patch ayant des `μ_z` différents — et l'utiliser telle quelle diviserait
toutes les forces par ~3. Pour une sélection prise à l'état courant, `wsum/kernsum` EST sa
présence. La flèche garde une opacité PLEINE quoi qu'il arrive ; l'atténuation se lit sur
son épaisseur.

**Curseurs de moyennage de la prise — MASQUÉS (outil de développement).** Le bloc HTML est
commenté ; les valeurs effectives sont celles de `selOpt` dans le script (`SEL_DEFAULTS`
côté module). Tout le câblage tolère l'absence des éléments (`setTxt` / `onSlider`), donc
**dé-commenter le bloc suffit à réactiver les curseurs, sans toucher au JS**. Ils décident
SUR QUOI la force s'applique, jamais de la physique. Mesuré par `anchor_check.py`, clic sur
le bras (N gaussiennes retenues / ‖J̄‖) :

| réglage | effet |
|---|---|
| `radius` 0,02 / 0,05 / 0,12 | 22 / 125 / 690 gaussiennes |
| `sharp` 1 / 3 / 8 (σ = radius/sharp) | N constant, ‖J̄‖ 0,080 / 0,096 / 0,066 |
| `wzMin` 1e-4 / 1e-2 / 0,3 | 126 / 122 / 60, présence 0,33 → 0,61 |
| `jmin` 0 / 0,2 / 0,5 | 125 / 60 / 13, ‖J̄‖ 0,096 → **0,31** |

`jmin` (mobilité minimale, en fraction du max local de ‖∂μ/∂z‖) est le filtre que la
référence serveur juge décisif : le décor immobile a J ≈ 0 et est majoritaire en nombre.
Il est à **0 par défaut** ici parce que la pondération par ‖J̄‖ suffit déjà — un clic sur le
fond donne ‖J̄‖ = 0,0087 contre 0,0955 sur le bras, soit 11× moins de prise sans aucun
filtre.

⚠️ Les défauts de `SEL_DEFAULTS` sont ceux que reproduit `check_krauss2_splat.py` (contrôle
d'indexation du `.bin`, sur les deux cas) : les changer demande de rejouer ce test.

**Ordre d'affichage et visibilité (`P.display`, AFFICHAGE UNIQUEMENT).** `LatentWhiten.fit`
range les valeurs propres par ordre CROISSANT : `u₁` est la direction la moins chargée,
`u₄` la plus. Le plan d'état applique donc `perm = [3,2,1,0]` — le `--perm 4,3,2,1` de la
figure `fig_krauss_npz_rollout` du preprint. `st.u` reste dans la base du MODÈLE de bout en
bout : la permutation ne touche aucun calcul. Chaque piste porte sa **visibilité**, part de
la trace de `Ḡ = E[(∂I/∂u)ᵀ(∂I/∂u)]` (`checkpoints/visibility_metric.pt`, produit par
`compute_visibility_metric.py`) : 92,2 / 6,0 / 1,2 / 0,6 % dans l'ordre affiché, soit 98 %
pour les deux premières. C'est ce chiffre qui explique qu'un rendu reste juste alors qu'une
coordonnée est mal suivie — même définition et même libellé (« % vis. ») que l'article.

**État de départ** : le repos appris `u_eq` (minimum du potentiel, `∇V = 0`) sur toutes les
coordonnées SAUF la plus visible, écartée à 2 (soit ~2 σ, `u` étant blanchi ; bien à
l'intérieur des percentiles 1–99 de cette coordonnée, −2,5 à +2,6). Un seul degré de liberté
part hors équilibre, et c'est celui qui porte 92 % du mouvement à l'écran : la relaxation se
voit sans transitoire parasite sur les trois autres. Vérifié sur 30 s sous les 45 kPa des
4 chambres (`p_init_kpa`, exporté et repris par les curseurs comme par le bouton *Reset
pressure*) : `q₁` oscille 2 → −1,42 → −0,64 → −0,03, `‖u‖` borné à 3,63, tout reste fini.

**Deux espaces** : le LNN intègre en `u` BLANCHI ; les gaussiennes vivent en `z` BRUT.
`Krauss2LNN.toZ()` avant tout rendu. ⚠️ `rollout_full_zenc.npy` porte « zenc » dans son
nom mais est en `u` (std ≈ 1, contre ≈ 0,2 pour `μ_z`) — même piège que le `z_enc.npy` du
sac ; les scripts le vérifient par `assert`.

Régénération, dans le dépôt LaGS (`demo_Lags/`) :

```
py extract_krauss2.py --ref     # krauss2_gaussians.bin + krauss2_meta.js + références gsplat
py export_krauss2_lnn.py        # krauss2_lnn.js (+ .json avec les points de référence)
py check_krauss2_lnn.py         # portage de la dynamique vs PyTorch (pip install py-mini-racer)
py check_krauss2_splat.py       # recette de rendu vs gsplat + indexation du .bin (--case sac
                                #   pour l'autre cas : même script, même recette)
```

puis copier `krauss2_gaussians.js`, `krauss2_meta.js`, `krauss2_lnn.js`,
`krauss2_lnn_dyn.js`, `gs_splat.js` dans `demo/`.

⚠️ **La disposition du `.bin` diffère d'un cas à l'autre** : elle est TASSÉE pour sa
dimension (18 float32 par gaussienne en d=2, 31 en d=4). Aucun offset n'est écrit en dur —
`meta.layout` fait foi, et le module JS comme les scripts de vérification le lisent.

⚠️ **Les gaussiennes se chargent par `<script src>`, pas par `fetch`.** L'extraction écrit
les deux (`krauss2_gaussians.bin` pour les scripts de vérification, `krauss2_gaussians.js`
en base64 pour la page) ; c'est le `.js` que charge `lagsplat.html`. Un `fetch` du `.bin`
est bloqué en `file://`, où la page doit s'ouvrir comme les autres démos du site — et
l'échec se manifestait par un **panneau simplement noir**, sans rien dans la console.
Le surcoût base64 (+33 %) est annulé par gzip. Si le décodeur échoue malgré tout (WebGL2
absent), l'onglet le dit maintenant dans la console ET sur le canevas, et le reste (la
physique, le plan d'état) continue de tourner.

## Coût d'affichage de lagsplat.html — ce qui tourne, et quand

⚠️ **`lagsplat.html` n'a PAS d'onglets**, malgré le vocabulaire employé plus haut dans ce
fichier (« onglet sac », « onglet rocking chair »…). Ce sont **quatre sections empilées
dans une seule page qui défile**. Aucun mécanisme ne les masque l'une l'autre — d'où le
piège : leurs quatre boucles `requestAnimationFrame` tournaient toutes **simultanément et
en permanence**, y compris pour des panneaux hors écran, soit jusqu'à **45 000 gaussiennes
rasterisées par frame** (K = 15 000 × 3 décodeurs en direct) plus trois scènes Three.js.
Lire « onglet » comme « section » partout dans ce document.

Trois gardes tiennent ce coût, toutes dans `lagsplat.html` :

- **Visibilité** — `watchVisible(ids)` / `visActive(g)` (helpers globaux déclarés en tête du
  premier bloc `<script>`). Chaque boucle sort avant tout travail — physique *et* rendu — si
  aucun de ses canevas n'est à l'écran, ou si l'onglet navigateur est en arrière-plan
  (`document.hidden`). Les expériences n'ayant pas de conteneur HTML propre, ce sont leurs
  **canevas** qui sont observés. ⚠️ À la reprise, le drapeau `resumed` fait **réarmer
  l'horloge** de la boucle (`last = now`, accumulateur remis à zéro) : sans lui, le premier
  `now - last` vaudrait toute la durée passée hors écran.
- **Cadence** — les quatre boucles plafonnent à 40 Hz. ⚠️ Celle du SCR souple ne l'a pas
  toujours fait : elle tournait au plein taux écran (120/144 Hz), soit 3× le travail des
  autres, décodeur GS **et** RK4 du LNN (jusqu'à 8 pas, 4 évaluations de `accel` chacun).
- **Rendu inutile** — `armed` est un drapeau « redessiner une fois ». En pause, hors prise et
  hors glisse, la boucle **ne redessine pas** : l'image serait identique. Chaque curseur,
  bouton et fin d'interaction pose `armed = true` pour que le panneau se rafraîchisse quand
  même. ⚠️ **Tout nouveau contrôle doit poser `armed`**, sinon son effet ne s'affichera qu'au
  prochain mouvement.

Deux caches ôtent des boucles CPU par frame :

- `applyCaps` (2048 matrices d'instance reconstruites **et re-téléversées au GPU**) n'est
  rejoué que si la coupe `zpos` a bougé, ou si la caméra tourne, ou sur une prise.
- Le fond du plan de phase du sac — cadre, étiquettes et la trajectoire de référence
  `TRAJ_U` (**2280 points**), tous **statiques** — est rendu une fois dans un canevas hors
  écran et blitté ; seuls la traînée et le point mobile sont redessinés.

**Résolution** : les trois décodeurs GS sont plafonnés à `maxSide: 512`. `gs_splat.js:517`
dimensionne sinon au `devicePixelRatio` **sans borne** — sur un écran 2×, un panneau de
900 px rendait 1800 px, soit 4× les fragments, pour **aucun détail supplémentaire** : le
décodeur est ajusté à `meta.img_size` = 256 px (cf. `gs_splat.js:373-383`).

⚠️ **Le poids au chargement n'est PAS traité** : les ~6,4 Mo de poids en base64
(`:1047-1051`, `:1406-1409`, `:1723-1726`, ~4,8 Mo après gzip) restent chargés en
`<script src>` **synchrones et bloquants**, comme Three.js depuis son CDN. Les rendre
paresseux — en réutilisant l'`IntersectionObserver` déjà en place — reste à faire ; chaque
IIFE gère déjà l'absence de ses poids (`throw new Error('…absent')`), ce qui en est le point
d'accroche naturel.

## Démos demo/

Chaque HTML est standalone et lisible. Les poids du réseau de neurones sont chargés via `<script src>` avant le bloc inline.

| HTML | Sujet | Poids (var globale) | Statut |
|------|-------|---------------------|--------|
| `prehenseur.html` | Pneumatic gripper simulé par LEBNN | `prehenseur-weights.js` · `W` (~2,2 Mo) | ✅ **Actif** — lié depuis publications.html + projects.html |
| `lebnn.html` | LEBNN · poutre cantilever 20-DOF | `lebnn-weights.js` · `LEBNN_RAW` (~2,6 Mo) | ⚠️ **Obsolète** — non lié, archive |
| `4dgs.html` + `3d.html` | 4DGS — scène Gaussian Splatting pilotée par la physique latente. `4dgs.html` est la page hôte (texte + curseurs), `3d.html` le viewer WebGL embarqué en iframe, pilotable aussi en plein écran. Pont par `postMessage`. | scène inlinée dans `3d.html` : `__SCENE_META` + `__SCENE_BIN_B64` (~3,8 Mo) | ⚠️ **Non liée** — pas encore référencée depuis publications/projects |
| `../lagsplat.html` (à la **racine**, pas dans `demo/`) | LaGS — Gaussian Splatting indexé par état (4 onglets : pendule synthétique, rocking chair d=1, sac d=2, SCR souple Krauss d=4 actionné en pression). Ses assets restent dans `demo/` (`lags_architecture.png`, `rocking_*`, `sac_*`, `krauss2_*`, `gs_splat.js`, iframe `demo/3d.html`) → chemins préfixés `./demo/`, y compris l'atlas du rocking chair chargé en JS (`sheet.src = './demo/' + D.sheet`). `demo/lags_demo.html` n'est plus qu'une page de redirection vers l'ancienne URL. | **rendu commun** : `gs_splat.js` (décodeur GS en direct, WebGL2, générique en `d` — lisible) · rocking chair : `rocking_splat.js` · `ROCKING_SPLAT` (~1,0 Mo, 15000 gaussiennes) + `rocking_splat_meta.js` · `ROCKING_SPLAT_META` + `rocking_gaussians.js` · `ROCKING_DATA` (~450 Ko, panneau 3D + prise uniquement) — `rocking_frames.png` (atlas, 3,5 Mo) n'est plus lu, supprimable · sac : `sac_splat.js` · `SAC_SPLAT` (~1,4 Mo, 15000 gaussiennes float32 en base64) + `sac_splat_meta.js` · `SAC_SPLAT_META` (~43 Ko) + `sac_lnn.js` · `SAC_LNN` (~290 Ko, poids du LNN) + `sac_lnn_dyn.js` (portage lisible) · SCR souple : `krauss2_gaussians.js` · `KRAUSS2_GAUSSIANS` (~2,4 Mo) + `krauss2_meta.js` · `KRAUSS2_META` (~65 Ko) + `krauss2_lnn.js` · `KRAUSS2_LNN` (~380 Ko) + `krauss2_lnn_dyn.js` (portage lisible) | ✅ **Actif** — lié depuis publications.html (carte « Learning Physics from Video ») |

> ⚠️ **Ne jamais lire** les fichiers de poids ci-dessus ni `rocking_frames.png`, `rocking_splat.js`, `rocking_splat_meta.js`, `sac_splat.js`, `sac_splat_meta.js`, `sac_lnn.js`, `krauss2_lnn.js`, `krauss2_meta.js`, `krauss2_gaussians.js` : JSON sur **une seule ligne géante** (centaines de Ko à plusieurs Mo) ou binaire → des dizaines de milliers de tokens pour rien. Idem pour les **lignes 260–261 de `3d.html`** (`__SCENE_META`, `__SCENE_BIN_B64`) : lire ce fichier par plages de lignes en les évitant.
