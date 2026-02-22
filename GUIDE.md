# Guide complet — Personnalisation du site CV

## Table des matières

1. [Structure des fichiers](#1-structure-des-fichiers)
2. [Informations personnelles — index.html](#2-informations-personnelles)
3. [Logos dans la timeline](#3-logos-dans-la-timeline)
4. [Publications](#4-publications)
5. [Projets](#5-projets)
6. [Enseignement](#6-enseignement)
7. [Images](#7-images)
8. [Vidéos MP4](#8-vidéos-mp4)
9. [PDF](#9-pdf)
10. [Liens externes](#10-liens-externes)
11. [Bilinguisme FR/EN](#11-bilinguisme-fren)
12. [Ajouter / supprimer une carte](#12-ajouter--supprimer-une-carte)
13. [Déploiement GitHub Pages](#13-déploiement-github-pages)

---

## 1. Structure des fichiers

```
cv-site/
│
├── index.html          ← Page d'accueil : CV, timeline, compétences
├── publications.html   ← Publications scientifiques
├── projects.html       ← Tous les projets (CEA, freelance, JE…)
├── teaching.html       ← Enseignement
│
├── style.css           ← Toutes les couleurs, polices, mises en page
├── lang.js             ← Système bilingue FR/EN
│
├── logos/              ← Logos des institutions (PNG fond transparent)
│   ├── cea.png
│   ├── ens-paris-saclay.png
│   ├── school.png
│   └── prepa.png
│
├── img/                ← Images statiques pour les cartes
│   ├── paper1.png
│   ├── project-eu.png
│   └── …
│
├── videos/             ← Vidéos MP4 pour les cartes animées
│   └── structural-dynamics.mp4
│
└── pdf/
    └── cv.pdf          ← Votre CV téléchargeable
```

---

## 2. Informations personnelles

**Fichier : `index.html`**

Chercher-remplacer (Ctrl+Shift+H dans VS Code) les placeholders suivants
dans **tous les fichiers HTML** à la fois :

| Placeholder | Remplacer par |
|---|---|
| `[YOUR NAME]` | Votre prénom et nom |
| `[YOUR@EMAIL.COM]` | Votre adresse e-mail |
| `[YOURHANDLE]` | Votre identifiant LinkedIn ET GitHub (même valeur si identique, sinon remplacer séparément) |
| `[YOURID]` | Votre identifiant Google Scholar (visible dans l'URL de votre profil Scholar) |
| `20XX` | Les années réelles |
| `[School]` | Le nom de votre école d'ingénieurs |
| `[Institution]` | Le nom de votre prépa ou licence |

### Modifier le texte de présentation (bio)

Dans `index.html`, repérer le bloc :

```html
<p class="bio"
   data-en="Graduate of <strong>ENS Paris-Saclay</strong> …"
   data-fr="Diplômé de l'<strong>ENS Paris-Saclay</strong> …">
  Graduate of <strong>ENS Paris-Saclay</strong> …
</p>
```

Modifier le contenu de `data-en`, de `data-fr`, ET le texte visible entre
les balises `<p>…</p>` (ce dernier est le texte affiché par défaut avant
que le JS se charge — garder en anglais ou en français selon votre préférence).

### Modifier les entrées de la timeline

Chaque poste ou diplôme suit ce modèle :

```html
<div class="timeline-item">
  <div class="timeline-left">
    <span class="timeline-date">2021 — 2024</span>   ← dates
    <div class="timeline-logo">
      <img src="./logos/cea.png" alt="CEA" … />
      <span class="logo-fallback">CEA</span>          ← texte si logo absent
    </div>
  </div>
  <div class="timeline-content">
    <h3 data-en="Research Engineer"
        data-fr="Ingénieur Chercheur">Research Engineer</h3>
    <p data-en="…" data-fr="…">…</p>
  </div>
</div>
```

Modifier : les dates, le src du logo, le texte `logo-fallback`, le titre `<h3>`
et le paragraphe `<p>` (penser à mettre à jour `data-en` et `data-fr`).

### Modifier les compétences

Dans la section `skills-grid`, chaque bloc suit ce modèle :

```html
<div class="skill-group">
  <h4 data-en="Machine Learning &amp; AI"
      data-fr="Machine Learning &amp; IA">Machine Learning &amp; AI</h4>
  <p data-en="Deep learning, NLP, …"
     data-fr="Apprentissage profond, TAL, …">
    Deep learning, NLP, …
  </p>
</div>
```

Modifier le titre `<h4>` et la liste de compétences dans le `<p>`.
Dupliquer ou supprimer des blocs `<div class="skill-group">` selon le nombre
de catégories voulues.

---

## 3. Logos dans la timeline

**Dossier : `logos/`**

### Format recommandé

- Format : **PNG avec fond transparent**
- Largeur : entre 200 et 400 px (affiché à max 110 px de large)
- Le logo est légèrement désaturé au repos et passe en couleur au survol

### Où trouver les logos officiels

| Institution | Source |
|---|---|
| CEA | cea.fr → Presse → Logos |
| ENS Paris-Saclay | ens-paris-saclay.fr → Communication |
| Votre école | Site officiel → Presse ou Identité visuelle |

### Ajouter un logo

1. Télécharger le fichier PNG
2. Le renommer simplement : `cea.png`, `ens-paris-saclay.png`, etc.
3. Le placer dans le dossier `logos/`
4. Dans `index.html`, vérifier que le `src` correspond :

```html
<img src="./logos/cea.png" alt="CEA"
     onerror="this.style.display='none';this.nextElementSibling.style.display='block'" />
<span class="logo-fallback">CEA</span>
```

Le mécanisme `onerror` affiche automatiquement le texte `logo-fallback`
si l'image est manquante — rien ne casse.

---

## 4. Publications

**Fichier : `publications.html`**

### Structure d'une carte publication standard (image statique)

```html
<article class="card">

  <div class="card-image">
    <img src="./img/paper1.png" alt="Description de la figure" />
    <!-- Si pas d'image, remplacer la ligne ci-dessus par : -->
    <!-- <div class="img-placeholder"></div> -->
  </div>

  <div class="card-body">

    <!-- Contexte : journal, conférence, année -->
    <span class="card-tag"
          data-en="Nature Machine Intelligence · 2023"
          data-fr="Nature Machine Intelligence · 2023">
      Nature Machine Intelligence · 2023
    </span>

    <!-- Titre complet du paper -->
    <h2 class="card-title">Full Title of the Paper</h2>

    <!-- Auteurs : vous en premier, co-auteurs ensuite -->
    <p class="card-authors">Votre Nom, Co-auteur A, Co-auteur B</p>

    <!-- Résumé en 2-3 phrases, bilingue -->
    <p class="card-desc"
       data-en="Two or three sentences describing the contribution…"
       data-fr="Deux ou trois phrases décrivant la contribution…">
      Two or three sentences describing the contribution…
    </p>

    <!-- Liens vers le paper, arXiv, code, slides -->
    <div class="card-links">
      <a href="https://doi.org/…" target="_blank"
         data-en="Paper" data-fr="Article">Paper</a>
      <a href="https://arxiv.org/abs/…" target="_blank">arXiv</a>
      <!-- <a href="https://github.com/…" target="_blank">Code</a> -->
      <!-- <a href="./pdf/slides-paper1.pdf" target="_blank"
              data-en="Slides" data-fr="Slides">Slides</a> -->
    </div>

  </div>
</article>
```

### Structure d'une carte publication avec vidéo MP4

```html
<article class="card">

  <div class="card-image card-video">
    <video autoplay loop muted playsinline
           loading="lazy"
           poster="./img/paper-dynamics-poster.jpg">
      <source src="./videos/structural-dynamics.mp4" type="video/mp4" />
      <div class="img-placeholder"></div>   <!-- fallback si vidéo absente -->
    </video>
  </div>

  <div class="card-body">
    <!-- … même structure que ci-dessus … -->
  </div>

</article>
```

**Attributs importants de la vidéo :**

| Attribut | Rôle |
|---|---|
| `autoplay` | Lecture automatique |
| `loop` | Boucle infinie |
| `muted` | Obligatoire pour l'autoplay dans les navigateurs modernes |
| `playsinline` | Évite le plein écran automatique sur iOS |
| `loading="lazy"` | La vidéo ne se charge que quand elle est visible à l'écran |
| `poster="…"` | Image affichée pendant le chargement (optionnel mais recommandé) |

---

## 5. Projets

**Fichier : `projects.html`**

### Structure d'une carte projet

```html
<article class="card">

  <div class="card-image">
    <img src="./img/project-eu.png" alt="Description" />
    <!-- ou <div class="img-placeholder"></div> si pas d'image -->
    <!-- ou la balise <video>…</video> pour une vidéo -->
  </div>

  <div class="card-body">

    <!-- Format du tag : [Type] · [Contexte] · [Année] -->
    <span class="card-tag"
          data-en="Scientific ML · CEA · 2022–2023"
          data-fr="ML Scientifique · CEA · 2022–2023">
      Scientific ML · CEA · 2022–2023
    </span>

    <h2 class="card-title">Titre du projet</h2>

    <!-- Pastilles techniques : ajouter/supprimer des <li> librement -->
    <ul class="tech-pills">
      <li>Python</li>
      <li>PyTorch</li>
      <li>FEM</li>
      <li>HPC</li>
    </ul>

    <p class="card-desc"
       data-en="Description in English…"
       data-fr="Description en français…">
      Description in English…
    </p>

    <!-- Liens optionnels -->
    <div class="card-links">
      <a href="publications.html"
         data-en="Related publication →"
         data-fr="Publication associée →">Related publication →</a>
      <!-- <a href="https://…" target="_blank">Rapport</a> -->
    </div>

  </div>
</article>
```

### Tags de contexte — exemples prêts à l'emploi

```
Data Science · Freelance · 2023
Numerical Simulation · CEA · 2022
Scientific ML · CEA · European Programme · 2021–2023
NLP · JE ENS Paris-Saclay · 2020
Data Science · CEA external provider · 2022
Structural Dynamics · CEA · 2021
Video Generation · CEA · 2023
```

### Pastilles techniques — exemples

```
Python · PyTorch · TensorFlow · Scikit-learn · NumPy · Pandas
LSTM · Transformers · Diffusion Models · GAN · PINN
FEM · CFD · HPC · OpenFOAM · FreeFEM
NLP · Formal Languages · Computer Vision
Time Series · Bayesian Inference · Surrogate Modelling
R · MATLAB · Julia
```

### Réordonner les projets

Les cartes sont simplement des blocs `<article>` les uns à la suite des autres.
Pour changer l'ordre, couper-coller le bloc `<article>…</article>` entier
à la position voulue. Conserver l'ordre antéchronologique (plus récent en haut).

---

## 6. Enseignement

**Fichier : `teaching.html`**

### Structure d'une carte cours

```html
<div class="teaching-card">
  <div class="teaching-icon">∇·u = 0</div>   ← formule ou symbole illustratif
  <h3 data-en="Fluid Mechanics"
      data-fr="Mécanique des Fluides">Fluid Mechanics</h3>
  <p class="teaching-meta">[École] · 2020–2024 · L3/M1</p>
  <p data-en="Lectures and tutorials: …"
     data-fr="Cours et TD : …">
    Lectures and tutorials: …
  </p>
</div>
```

### Idées d'icônes textuelles pour d'autres matières

```
∇·u = 0     → Mécanique des fluides
ΔS ≥ 0      → Thermodynamique
∂u/∂t       → EDP
σ = Eε      → Mécanique des solides
∫∫ dA       → Analyse / Intégration
f(x) → ŷ   → Machine learning
λ₁, λ₂     → Algèbre linéaire
```

---

## 7. Images

**Dossier : `img/`**

### Formats acceptés

PNG, JPG ou WebP. PNG recommandé pour les figures scientifiques (sans perte),
JPG pour les photos.

### Taille recommandée

- Minimum : **400 × 280 px**
- Le CSS affiche les images dans un cadre 200 × 140 px et recadre automatiquement
  (objectif `cover`) — l'image originale peut donc être plus grande ou de
  proportions différentes.

### Ajouter une image à une carte

1. Placer le fichier dans `img/`
2. Dans la carte HTML, remplacer :

```html
<div class="img-placeholder"></div>
```

par :

```html
<img src="./img/nom-du-fichier.png" alt="Description courte de l'image" />
```

### Bonnes sources d'images pour les publications

- Figure clé de l'article (graphique de résultats, architecture du modèle…)
- Capture d'écran de la simulation
- Diagramme de la méthode
- Figure issue des slides de présentation

---

## 8. Vidéos MP4

**Dossier : `videos/`**

### Préparer le fichier

**Depuis un GIF :**
```bash
ffmpeg -i animation.gif -movflags faststart -pix_fmt yuv420p output.mp4
```

**Depuis un MP4 existant trop lourd :**
```bash
ffmpeg -i input.mp4 -crf 28 -movflags faststart output.mp4
```
(CRF 28 = bonne qualité / bon poids. Augmenter jusqu'à 35 pour réduire davantage.)

**Depuis une simulation Python (matplotlib) :**
```python
from matplotlib.animation import FFMpegWriter
writer = FFMpegWriter(fps=30)
anim.save("output.mp4", writer=writer)
```

L'option `-movflags faststart` est essentielle : elle place les métadonnées
en début de fichier pour que la lecture commence immédiatement sans attendre
le téléchargement complet.

### Ajouter une image poster (optionnel mais recommandé)

Le `poster` est une image JPG affichée dans la carte pendant que la vidéo
se charge. Exporter une frame représentative de votre simulation :

```bash
ffmpeg -i output.mp4 -ss 00:00:01 -vframes 1 poster.jpg
```

Puis déclarer dans le HTML :

```html
<video … poster="./img/poster.jpg">
```

### Intégrer la vidéo dans une carte

```html
<div class="card-image card-video">
  <video autoplay loop muted playsinline
         loading="lazy"
         poster="./img/mon-poster.jpg">
    <source src="./videos/ma-simulation.mp4" type="video/mp4" />
    <div class="img-placeholder"></div>
  </video>
</div>
```

---

## 9. PDF

**Dossier : `pdf/`**

### CV téléchargeable

Placer votre CV en PDF dans `pdf/cv.pdf`. Le lien dans `index.html` pointe
déjà dessus :

```html
<a href="./pdf/cv.pdf" target="_blank"
   data-en="CV (PDF)" data-fr="CV (PDF)">CV (PDF)</a>
```

### Autres PDF (slides, rapports…)

Même principe. Par exemple pour des slides de conférence :

1. Placer le fichier : `pdf/slides-paper1.pdf`
2. Ajouter un lien dans la carte de la publication :

```html
<div class="card-links">
  <a href="https://doi.org/…" target="_blank"
     data-en="Paper" data-fr="Article">Paper</a>
  <a href="./pdf/slides-paper1.pdf" target="_blank"
     data-en="Slides" data-fr="Slides">Slides</a>
</div>
```

---

## 10. Liens externes

### Liens dans les cartes

Les liens s'ajoutent dans le bloc `<div class="card-links">` :

```html
<div class="card-links">
  <a href="https://doi.org/10.xxxx/…" target="_blank"
     data-en="Paper" data-fr="Article">Paper</a>
  <a href="https://arxiv.org/abs/…" target="_blank">arXiv</a>
  <a href="https://github.com/…" target="_blank">Code</a>
  <a href="./pdf/slides.pdf" target="_blank"
     data-en="Slides" data-fr="Slides">Slides</a>
</div>
```

`target="_blank"` ouvre dans un nouvel onglet — toujours utiliser pour
les liens qui quittent le site.

### Liens de contact (index.html)

```html
<div class="contact-links">
  <a href="mailto:prenom.nom@domaine.fr">prenom.nom@domaine.fr</a>
  <a href="https://linkedin.com/in/votre-handle" target="_blank">LinkedIn</a>
  <a href="https://github.com/votre-handle" target="_blank">GitHub</a>
  <a href="https://scholar.google.com/citations?user=VOTRE_ID" target="_blank">
    Google Scholar
  </a>
  <a href="./pdf/cv.pdf" target="_blank"
     data-en="CV (PDF)" data-fr="CV (PDF)">CV (PDF)</a>
</div>
```

---

## 11. Bilinguisme FR/EN

Tout élément de texte peut être traduit en ajoutant deux attributs :

```html
<p data-en="Text in English." data-fr="Texte en français.">
  Text in English.
</p>
```

**Règles :**
- `data-en` : texte anglais
- `data-fr` : texte français
- Le texte entre les balises `<p>…</p>` est affiché avant que le JS se charge
  (environ 100 ms) — le garder en anglais par défaut
- Le JS lit la valeur de `data-en` ou `data-fr` et l'injecte via `innerHTML`,
  donc le HTML est accepté à l'intérieur (`<strong>`, `<em>`, `<a>`…)

**Exemple avec HTML dans la valeur :**

```html
<p data-en="Work at &lt;strong&gt;CEA&lt;/strong&gt; on…"
   data-fr="Travail au &lt;strong&gt;CEA&lt;/strong&gt; sur…">
  Work at <strong>CEA</strong> on…
</p>
```

Les balises `<` et `>` sont encodées en `&lt;` et `&gt;` dans les attributs
pour que le HTML reste valide. Le JS les décode automatiquement à l'affichage.

**Éléments non à traduire :**
- Les noms propres (`CEA`, `ENS Paris-Saclay`, `PyTorch`…)
- Les pastilles techniques (`<ul class="tech-pills">`)
- Les liens (`<a href="…">`)
- Les dates

---

## 12. Ajouter / supprimer une carte

### Ajouter une carte publication

Copier le bloc complet ci-dessous et le coller dans `publications.html`
à la position voulue (ordre antéchronologique recommandé) :

```html
<article class="card">
  <div class="card-image">
    <img src="./img/VOTRE-IMAGE.png" alt="Description" />
  </div>
  <div class="card-body">
    <span class="card-tag"
          data-en="Journal · Année"
          data-fr="Journal · Année">
      Journal · Année
    </span>
    <h2 class="card-title">Titre du paper</h2>
    <p class="card-authors">Votre Nom, Co-auteur</p>
    <p class="card-desc"
       data-en="Description EN."
       data-fr="Description FR.">
      Description EN.
    </p>
    <div class="card-links">
      <a href="https://doi.org/…" target="_blank"
         data-en="Paper" data-fr="Article">Paper</a>
    </div>
  </div>
</article>
```

### Ajouter une carte projet

Même principe dans `projects.html`, en ajoutant le bloc `<ul class="tech-pills">`.

### Supprimer une carte

Sélectionner et supprimer l'intégralité du bloc `<article class="card">…</article>`.
Dans VS Code : cliquer sur `<article`, puis Ctrl+Shift+K pour supprimer la ligne,
ou sélectionner manuellement de `<article` jusqu'au `</article>` fermant.

---

## 13. Déploiement GitHub Pages

### Première mise en ligne

```bash
# 1. Créer le repo sur github.com avec le nom : votre-username.github.io
# 2. Depuis le dossier cv-site/ :
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/votre-username/votre-username.github.io.git
git push -u origin main
```

Ensuite : **Settings → Pages → Source : main → / (root) → Save**

Le site est en ligne à `https://votre-username.github.io` en moins de 60 secondes.

### Mettre à jour le site

```bash
# Après chaque modification :
git add .
git commit -m "Ajout publication XXXX"
git push
```

GitHub Pages se met à jour automatiquement en 10–30 secondes.

### Domaine personnalisé (optionnel)

1. Créer un fichier `CNAME` à la racine du dossier contenant uniquement :
   ```
   votrenom.com
   ```
2. Chez votre registrar DNS, ajouter un enregistrement CNAME :
   - Nom : `www`
   - Valeur : `votre-username.github.io`
3. Dans GitHub → Settings → Pages → Custom domain : saisir `votrenom.com`

---

*Guide généré pour le site CV — dernière mise à jour : 2024*
