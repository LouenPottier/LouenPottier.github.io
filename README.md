# CV Site — Setup Guide

## File structure

```
cv-site/
├── index.html          ← CV / About
├── publications.html   ← Scientific papers
├── projects.html       ← Research & professional projects
├── teaching.html       ← Teaching
├── freelance.html      ← Freelance / consulting
├── style.css           ← All styles (one file, no framework)
├── lang.js             ← Bilingual EN/FR switcher
├── img/                ← Put your images here
│   ├── photo.jpg           (your portrait, ~130×160px recommended)
│   ├── paper1.png          (key figure for paper 1)
│   ├── project-eu.png      etc.
└── pdf/
    └── cv.pdf          ← Your PDF CV
```

## Filling in content

Search for all bracketed placeholders `[LIKE THIS]` and replace them.  
**Ctrl+Shift+H** in VS Code → replace across all files.

Key ones:
| Placeholder | Replace with |
|---|---|
| `[YOUR NAME]` | Your full name |
| `[YOUR@EMAIL.COM]` | Your email |
| `[YOURHANDLE]` | LinkedIn / GitHub handle |
| `[YOURID]` | Google Scholar user ID |
| `[School]` | Engineering school where you teach |
| `20XX` | Actual years |

## Bilingual system

Every piece of text that should change language has:
```html
<p data-en="English text." data-fr="Texte français.">English text.</p>
```
The default displayed text (between the tags) is what's shown before JS loads — 
keep it in English (or French, your call).

To add a new translatable element, just add `data-en` and `data-fr` attributes.

## Images

- Each card has an `<img>` tag commented out and a placeholder `<div>` shown instead.
- To add an image: uncomment the `<img>` tag, update the `src`, and delete the `<div class="img-placeholder">`.
- Recommended size: at least 400×280px. Aspect ratio doesn't matter (CSS crops to fit).
- Good image sources: a figure from the paper, a diagram, a heatmap, a screenshot of results.

## Adding more cards

Each `<article class="card">` is self-contained. Duplicate the block and update the content.

## GitHub Pages deployment (free)

1. Create a GitHub repo named `[yourusername].github.io`
2. Push all files (not the `cv-site/` folder itself — push its *contents*)
3. Go to repo **Settings → Pages → Source: main → / (root)**
4. Done. Live at `https://[yourusername].github.io` in ~60 seconds.

## Custom domain

1. Add a `CNAME` file at the root: `yourname.com`
2. Configure your DNS: CNAME record pointing `www` → `[yourusername].github.io`
3. Update the GitHub Pages settings to use your custom domain.

## Customisation

- **Colours**: edit the `:root { }` block at the top of `style.css`
- **Fonts**: swap the Google Fonts URL in each HTML `<head>` and update `font-family` in CSS
- **Add a page**: copy any `.html` file, add a `<li><a>` in the nav of *every* page
