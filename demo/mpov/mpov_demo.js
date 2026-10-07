/*
 * mpov_demo.js : demo interactive de xrdays.html.
 *
 * L'etat (s, q) pilote le decodeur 3D par zones (zoned3d.js, mpov_3d.js), vu au depart depuis
 * une pose de l'iphone3 (t ~ 273 s, un quart de tour de l'iphone1), avec la correction de
 * couleur apprise de l'iphone1. Controle de la camera identique a demo/3d.html.
 * 2026-10-07 : les deux decodeurs 2D de la demo sont retires (les videos de comparaison de la
 * page restent). Colonne de gauche : q(t) (meme trace que l'experience 4 de lagsplat.html) et
 * plan latent (q0, q1), dont le point est l'etat partage avec la demo.
 *
 * Deux jeux de decodeurs 3D, choisis par l'interrupteur « haute resolution » (haute par defaut) :
 * 85 000 gaussiennes rendues en 640 px, ou 20 000 en 512 px (telecharge au premier passage).
 *
 * Dynamique (phys.js) : q'' = -K q - C q' + G s'' + b, identifiee sur q(t) ; B est mis a
 * zero, la position de repos ne depend pas de s. s suit le curseur avec une inertie
 * (s'' borne a la valeur maximale mesuree) ou rejoue s(t) enregistre.
 *
 * Effort a la souris : consigne de position du point saisi, ressort et amortisseur,
 *     F_q = J^T [ k (x_c - p(q)) - c J q' ]
 * J = d p / d q en px de la vue saisie par unite de q (differences centrees). Integration
 * implicite du couplage, porte contre les selections peu nombreuses ou incoherentes en q,
 * barriere de potentiel au bord du domaine couvert par les donnees. Reprise de
 * code_new_3D/demoxrdays/img5175/serve_deform_demo.py, ou ces choix sont expliques.
 * Borne de l'effort latent : valeur reglee dans la demo PC (mpov/demo3d_page.html), reprise
 * par l'application XR (xr/xr_native_zoned.py) ; raideur et dissipation : celles du pincement
 * de l'application XR. Les memes pour les trois vues.
 *
 * Coque hors des donnees (2026-10-07, bouton « coque hors des données », actif par defaut) :
 * la physique reste lineaire, mais au-dela du domaine des donnees (rayon R(theta) en q) la
 * geometrie de la semelle 3D vient d'une coque elastique (zoned3d.js, shell_ext.js,
 * code_new_3D/demoxrdays/mpov/elastic/hybrid.py). La barriere est repoussee a EXT x R(theta),
 * le plafond d'effort multiplie par SHELL_FMAX pour pouvoir y tirer la semelle ; les vues 2D,
 * sans coque, restent au bord du domaine. 2026-10-07 : EXT 2 -> 3, SHELL_FMAX 4 -> 10.
 */
(function () {
  'use strict';
  const P = window.MPOV_PHYS, dt = P.dt, dq = 2;
  const root = document.getElementById('lags-demo');
  const $ = id => document.getElementById(id);
  const lang = () => (document.documentElement.lang === 'fr' ? 'fr' : 'en');

  // ── reglages de la saisie, memes pour les trois vues : borne de l'effort de la demo PC
  // (mpov/demo3d_page.html) et de l'application XR (xr/xr_native_zoned.py, --fmax 0.40) ;
  // raideur et dissipation du PINCEMENT de l'application XR (--kc-pinch 2 --cc-pinch 1). A
  // l'equilibre le point saisi parcourt kc / (1 + kc) de l'ecart au curseur : 67 % ici, 7 %
  // seulement avec la raideur du rayon (--kc 0.071), point d'application quasi immobile. ──
  const KREF = 0.5 * (Math.abs(P.K[0][0]) + Math.abs(P.K[1][1]));
  // FREF : force de rappel maximale sur la frontiere des donnees (nuage des q mesures assimile a
  // un disque de rayon R) : sigma_max(K) R. L'effort latent de saisie est borne a 0.40 FREF.
  const FREF = (() => { const a = P.K[0][0], b = P.K[0][1], c = P.K[1][0], d = P.K[1][1];
    const s = a * a + b * b + c * c + d * d, t = a * d - b * c;
    return Math.sqrt(0.5 * (s + Math.sqrt(Math.max(0, s * s - 4 * t * t)))); })() * P.q_disk.r;
  const FMAX = Math.pow(10, -0.4) * FREF;
  // coque hors des donnees : etat (SH = Zoned3D.shell, null tant que non charge), plafond
  // d'effort multiplie par SHELL_FMAX quand elle est active
  const SHELL = {SH: null, on: true};
  const SHELL_FMAX = 10.0;
  const shellOn = () => !!(SHELL.SH && SHELL.on);
  const fmaxOf = v => ((v && v.fmax) || FMAX) * (shellOn() ? SHELL_FMAX : 1);
  // kc, cc : raideur et dissipation du couplage, en multiples de KREF et de 2 sqrt(KREF)
  // 2026-10-05 : gain divise par 2 (2.0 -> 1.0), dissipation doublee (1.0 -> 2.0)
  const G = {kc: 1.0, cc: 2.0, barrier: 8, margin: 0.02};
  // porte (n_eff, coherence) de la saisie : valeurs de la demo PC (meme decodeur 3D)
  const GATE3D = {nmin: Math.pow(10, 1.3), cmin: 0.8};

  const S = {q: new Float64Array(dq), v: new Float64Array(dq),
             s: P.s_rest, sd: 0, sdd: 0, target: P.s_rest,
             running: true, hold: false, replay: false, k: 0, grab: null, cursor: null, gate: 0, Fq: 0};

  // ── rejeu : s(t) enregistre, derivees centrees ──
  const RS = P.replay_s, NR = RS.length;
  const RSd = new Float64Array(NR), RSdd = new Float64Array(NR);
  for (let i = 1; i < NR - 1; i++) {
    RSd[i] = (RS[i + 1] - RS[i - 1]) / (2 * dt);
    RSdd[i] = (RS[i + 1] - 2 * RS[i] + RS[i - 1]) / (dt * dt);
  }

  // ── barriere (cf. serve_deform_demo.py) ──
  const BR = P.barrier;
  function distAt(q) {
    if (shellOn()) {
      // coque active : distance a la limite EXT x R(theta), et au bord de la grille de la variete
      const SM = SHELL.SH.meta, r = Math.hypot(q[0], q[1]), R = SHELL.SH.radius(q);
      let d = Math.max(0, r - SM.ext * R);
      for (let k = 0; k < 2; k++) {
        const lo = SM.lo[k], hi = SM.lo[k] + (SM.n[k] - 1) * SM.hs[k];
        d = Math.max(d, lo - q[k], q[k] - hi);
      }
      return d;
    }
    const n = BR.n;
    const t = [0, 1].map(k => Math.max(0, Math.min(n - 1, (q[k] - BR.lo[k]) / (BR.hi[k] - BR.lo[k]) * (n - 1))));
    const i = t.map(v => Math.max(0, Math.min(n - 2, Math.floor(v)))), f = t.map((v, k) => v - i[k]);
    const at = (a, b) => BR.dist[b * n + a];
    return (1 - f[0]) * (1 - f[1]) * at(i[0], i[1]) + f[0] * (1 - f[1]) * at(i[0] + 1, i[1])
         + (1 - f[0]) * f[1] * at(i[0], i[1] + 1) + f[0] * f[1] * at(i[0] + 1, i[1] + 1);
  }
  function gradDist(q) {
    const h = 2e-3, g = [0, 0];
    for (let k = 0; k < dq; k++) { const a = q.slice(), b = q.slice(); a[k] += h; b[k] -= h;
      g[k] = (distAt(a) - distAt(b)) / (2 * h); }
    const n = Math.hypot(g[0], g[1]);
    return n > 1e-9 ? [g[0] / n, g[1] / n] : [0, 0];
  }
  function barrierForce(q, v) {
    const F = [0, 0], d = distAt(q);
    if (d <= 0) return F;
    const n = gradDist(q), kb = Math.min(G.barrier * KREF, 1.5 / (dt * dt));
    const cb = Math.min(2 * Math.sqrt(kb), 0.9 / dt), vn = v[0] * n[0] + v[1] * n[1];
    for (let k = 0; k < dq; k++) { F[k] = -kb * d * n[k]; if (vn > 0) F[k] -= cb * vn * n[k]; }
    return F;
  }
  function wallProject() {
    const q = Array.from(S.q), d = distAt(q);
    if (d <= G.margin) return;
    const n = gradDist(q);
    for (let k = 0; k < dq; k++) S.q[k] -= (d - G.margin) * n[k];
    const vn = S.v[0] * n[0] + S.v[1] * n[1];
    if (vn > 0) for (let k = 0; k < dq; k++) S.v[k] -= vn * n[k];
  }

  // ── couplage de saisie ──
  function gateOf(neff, coh, gt) {
    const cl = x => Math.max(0, Math.min(1, x));
    if (!(neff >= 0) || !(coh >= 0)) return 0;
    return cl((neff - 0.5 * gt.nmin) / (0.5 * gt.nmin)) * cl((coh - (gt.cmin - 0.1)) / 0.1);
  }
  function coupling() {
    const g0 = S.grab;
    if (!g0 || !S.cursor || !g0.J) return null;
    const g = gateOf(g0.neff, g0.coh, g0.view.gate); S.gate = g;
    if (g <= 0) return null;
    const J = g0.J, pt = g0.pt, qr = g0.qref;
    const a = J[0][0] ** 2 + J[0][1] ** 2, d = J[1][0] ** 2 + J[1][1] ** 2, b = J[0][0] * J[1][0] + J[0][1] * J[1][1];
    const lmax = 0.5 * (a + d) + Math.sqrt(0.25 * (a - d) * (a - d) + b * b);
    if (!(lmax > 1e-9)) return null;
    const k = g * G.kc * KREF / lmax, c = g * G.cc * 2 * Math.sqrt(KREF) / lmax;
    const p = [0, 1].map(r => pt[r] + J[r][0] * (S.q[0] - qr[0]) + J[r][1] * (S.q[1] - qr[1]));
    const e = [S.cursor[0] - p[0], S.cursor[1] - p[1]];
    const m = J[0][0] * J[0][1] + J[1][0] * J[1][1];
    const JtJ = [[J[0][0] ** 2 + J[1][0] ** 2, m], [m, J[0][1] ** 2 + J[1][1] ** 2]];
    const F0 = [0, 1].map(j => k * (J[0][j] * e[0] + J[1][j] * e[1]));
    return {k, c, JtJ, F0, p};
  }

  function stepOnce() {
    if (S.replay) {
      const i = 1 + (S.k % (NR - 2));
      S.s = RS[i]; S.sd = RSd[i]; S.sdd = Math.max(-P.sdd_max, Math.min(P.sdd_max, RSdd[i]));
      S.k += 1;
    } else {
      const kp = 400, kd = 40;
      S.sdd = Math.max(-P.sdd_max, Math.min(P.sdd_max, kp * (S.target - S.s) - kd * S.sd));
      S.sd += dt * S.sdd; S.s += dt * S.sd;
    }
    // point du plan latent tenu : etat fixe, vitesse nulle ; le bras continue (S.hold)
    if (S.hold) { S.v[0] = 0; S.v[1] = 0; S.Fq = 0; S.F = [0, 0]; return; }
    const Fb = barrierForce(Array.from(S.q), Array.from(S.v)), a = [0, 0];
    for (let i = 0; i < dq; i++) {
      a[i] = P.b[i] + Fb[i] + P.G[i] * S.sdd;
      for (let j = 0; j < dq; j++) a[i] += -P.K[i][j] * S.q[j] - P.C[i][j] * S.v[j];
    }
    const cp = coupling();
    if (!cp) { S.Fq = 0; S.F = [0, 0]; for (let i = 0; i < dq; i++) S.v[i] += dt * a[i]; }
    else {
      const w = dt * (cp.c + dt * cp.k), A = [[0, 0], [0, 0]], r = [0, 0];
      for (let i = 0; i < 2; i++) {
        r[i] = S.v[i] + dt * (a[i] + cp.F0[i]);
        for (let j = 0; j < 2; j++) A[i][j] = (i === j ? 1 : 0) + w * cp.JtJ[i][j];
      }
      const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
      const v1 = [(A[1][1] * r[0] - A[0][1] * r[1]) / det, (-A[1][0] * r[0] + A[0][0] * r[1]) / det];
      const F = [0, 1].map(i => cp.F0[i] - (cp.c + dt * cp.k) * (cp.JtJ[i][0] * v1[0] + cp.JtJ[i][1] * v1[1]));
      const nF = Math.hypot(F[0], F[1]);
      const FMAX = fmaxOf(S.grab.view);
      S.Fq = Math.min(nF, FMAX);
      // effort latent effectivement applique (borne comprise) : fleche du plan latent
      S.F = nF <= FMAX ? F : F.map(x => x * FMAX / nF);
      if (nF <= FMAX) { S.v[0] = v1[0]; S.v[1] = v1[1]; }
      else for (let i = 0; i < 2; i++) S.v[i] += dt * (a[i] + F[i] * FMAX / nF);
    }
    for (let i = 0; i < dq; i++) S.q[i] += dt * S.v[i];
    wallProject();
  }

  // ── vues ──────────────────────────────────────────────────────────────────
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len3 = a => Math.hypot(a[0], a[1], a[2]);
  const norm3 = a => { const n = len3(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  // Rodrigues : rotation de w autour de l'axe unitaire k, angle a (main droite)
  const rot3 = (w, k, a) => {
    const c = Math.cos(a), s = Math.sin(a), kw = cross3(k, w), d = dot3(k, w) * (1 - c);
    return [w[0] * c + kw[0] * s + k[0] * d, w[1] * c + kw[1] * s + k[1] * d, w[2] * c + kw[2] * s + k[2] * d];
  };
  const views = [];
  function overlayFit(v) {
    const c = v.canvas, o = v.ovl, dpr = window.devicePixelRatio || 1;
    const st = c.parentElement;
    if (v.crop) {
      // recadrage carre : l'image entiere est rendue, la scene (carree, overflow cache) n'en
      // montre que les lignes [y0, y0 + W)
      const k = st.clientWidth / v.W(), top = Math.round(-v.crop.y0 * k) + 'px';
      const cw = st.clientWidth + 'px', ch = Math.floor(v.H() * k) + 'px';
      if (c.style.width !== cw || c.style.height !== ch || c.style.top !== top) {
        c.style.width = cw; c.style.height = ch; c.style.top = top;
      }
    } else {
      // canevas ajuste a la scene en gardant le rapport d'aspect de l'image
      const k = Math.min(st.clientWidth / v.W(), st.clientHeight / v.H());
      const cw = Math.floor(v.W() * k) + 'px', ch = Math.floor(v.H() * k) + 'px';
      if (c.style.width !== cw || c.style.height !== ch) { c.style.width = cw; c.style.height = ch; }
    }
    o.style.left = c.offsetLeft + 'px'; o.style.top = c.offsetTop + 'px';
    o.style.width = c.clientWidth + 'px'; o.style.height = c.clientHeight + 'px';
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
  }
  function toImg(v, e) {
    const r = v.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * v.W(), (e.clientY - r.top) / r.height * v.H()];
  }
  function drawOverlay(v) {
    overlayFit(v);
    const o = v.ovl, g = o.getContext('2d'), sx = o.width / v.W(), sy = o.height / v.H();
    g.clearRect(0, 0, o.width, o.height);
    if (!S.grab || S.grab.view !== v || !S.cursor) return;
    const cp = coupling(), p = cp ? cp.p : S.grab.pt, c = S.cursor;
    g.strokeStyle = 'rgba(159,211,255,0.5)'; g.lineWidth = 1;
    g.beginPath(); g.arc(c[0] * sx, c[1] * sy, v.radius * sx, 0, 6.284); g.stroke();
    if (!p) return;
    g.strokeStyle = '#ffd479'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(p[0] * sx, p[1] * sy); g.lineTo(c[0] * sx, c[1] * sy); g.stroke();
    g.fillStyle = '#ffd479'; g.beginPath(); g.arc(p[0] * sx, p[1] * sy, 4.5, 0, 6.284); g.fill();
  }

  function attachGrab(v) {
    const c = v.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    // clic milieu : pas de defilement automatique du navigateur
    c.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    // contacts tactiles en cours (vue 3D : deux doigts = camera, comme demo/3d.html)
    const touches = new Map();
    c.addEventListener('pointerdown', e => {
      if (!v.ready) return;
      if (v.orbit && e.pointerType === 'touch') {
        touches.set(e.pointerId, [e.clientX, e.clientY]);
        if (touches.size === 2) {
          // deux doigts : l'effort en cours est abandonne
          if (S.grab && S.grab.view === v) { S.grab = null; S.cursor = null; }
          c.classList.remove('grabbing');
          c.setPointerCapture(e.pointerId);
          return;
        }
        if (touches.size > 2) return;
      }
      if ((e.button === 2 || e.button === 1) && v.orbit) {
        e.preventDefault(); v.orbit.start(e); c.setPointerCapture(e.pointerId); return;
      }
      if (e.button !== 0) return;
      const p = toImg(v, e), z = zNow();
      const sel = v.select(p[0], p[1]);
      S.cursor = p;
      if (!sel) return;
      const j = v.jac(z, sel);
      S.grab = Object.assign({view: v, sel, qref: [S.q[0], S.q[1]]}, j);
      c.setPointerCapture(e.pointerId); c.classList.add('grabbing');
      if (!S.running) setRunning(true);
    });
    c.addEventListener('pointermove', e => {
      if (touches.has(e.pointerId) && touches.size === 2) {
        const [ida, idb] = Array.from(touches.keys());
        const a0 = touches.get(ida), b0 = touches.get(idb);
        touches.set(e.pointerId, [e.clientX, e.clientY]);
        v.orbit.pinch(a0, b0, touches.get(ida), touches.get(idb));
        return;
      }
      if (v.orbit && v.orbit.active) { v.orbit.move(e); return; }
      if (S.grab && S.grab.view === v) S.cursor = toImg(v, e);
    });
    for (const ev of ['pointerup', 'pointercancel']) c.addEventListener(ev, e => {
      touches.delete(e.pointerId);
      if (v.orbit) v.orbit.active = false;
      if (S.grab && S.grab.view === v) { S.grab = null; S.cursor = null; }
      c.classList.remove('grabbing');
    });
    if (v.orbit) c.addEventListener('wheel', e => { e.preventDefault(); v.orbit.wheel(e); }, {passive: false});
  }

  const DOLLY0 = 0.5;      // recul de la vue 3D de depart, x distance camera - pivot
  const FOCAL = 0.7;       // focale de la vue 3D, en multiple de celle de l'iphone3 (2026-10-07)
  function view3D(cvId, ovId, radius640) {
    const v = {canvas: $(cvId), ovl: $(ovId), radius: radius640, gate: GATE3D, ready: false, visible: true,
               lastZ: null, byQ: {}};
    v.init = (pack, q, side) => {
      if (!v.byQ[q]) { const M = Zoned3D.load(pack); v.byQ[q] = {M, R: Zoned3D.renderer(v.canvas, M)}; }
      v.M = v.byQ[q].M; v.R = v.byQ[q].R; v.lastZ = null;
      if (SHELL.SH && !v.M.nShell) v.M.setShell(SHELL.SH);
      // fenetre CARREE de cote `side` : pose, focale et axe optique de l'iphone3 a t ~ 273 s
      // (un quart de tour de l'iphone1 autour de la languette, web/add_i3_view.py), mis a
      // l'echelle side / H ; le champ horizontal est elargi au lieu de deformer l'image.
      // Correction de couleur de l'iphone1 : memes couleurs que les vues 2D. Au changement de
      // qualite, la pose courante de la camera est conservee.
      const cams = v.M.meta.cams, c0 = cams.iphone3 || cams.iphone1, k = side / c0.H;
      const E = v.cam ? v.cam.E : c0.E.map(r => r.slice());
      // focale : celle de l'iphone3 mise a l'echelle, multipliee par FOCAL (point principal
      // inchange). FOCAL < 1 elargit le champ ; la camera de depart est rapprochee d'autant (cf.
      // plus bas) pour garder le meme grossissement de la languette.
      v.f0 = [c0.K[0][0] * k, c0.K[1][1] * k];
      v.focal = FOCAL;
      v.cam = {E, K: [[v.f0[0] * v.focal, 0, side / 2 + (c0.K[0][2] - c0.W / 2) * k],
                      [0, v.f0[1] * v.focal, c0.K[1][2] * k], [0, 0, 1]],
               W: side, H: side, color: cams.iphone1.color};
      v.radius = radius640 * side / 640;
      v.W = () => v.cam.W; v.H = () => v.cam.H;
      // pivot de l'orbite et du zoom : barycentre de la zone q (la languette) a l'etat de repos.
      // Bornes du zoom comme demo/3d.html : 0.05 a 30 fois le 90e centile des distances au pivot.
      v.M.update([P.s_rest, 0, 0]);
      const p = [0, 0, 0], nq = v.M.meta.n_q, N = v.M.N, xyz = v.M.xyz;
      for (let g = 0; g < nq; g++) for (let k = 0; k < 3; k++) p[k] += xyz[3 * g + k] / nq;
      if (!v.pivot) {
        v.pivot = p;
        const st = Math.max(1, Math.floor(N / 20000)), d = [];
        for (let g = 0; g < N; g += st) d.push(Math.hypot(xyz[3 * g] - p[0], xyz[3 * g + 1] - p[1], xyz[3 * g + 2] - p[2]));
        d.sort((a, b) => a - b);
        const R = d[Math.floor(0.9 * (d.length - 1))] || 1;
        v.rMin = 0.05 * R; v.rMax = 30 * R;
        // haut du monde : la verticale de la piece (meta.up). demo/3d.html prend l'axe -Y de sa
        // camera de depart, qui y est horizontale ; ici l'iphone3 vise 17 deg vers le bas, cet
        // axe serait incline de 17 deg et l'orbite ferait basculer la scene.
        v.up = norm3(v.M.meta.up || E[1].slice(0, 3).map(x => -x));
        // camera de depart mise a niveau (roulis nul) : meme axe optique, meme position, axe x
        // horizontal. Le lacet autour de la verticale et le tangage autour de cet axe x le
        // gardent horizontal : jamais de roulis.
        const z = norm3(E[2].slice(0, 3)), x = norm3(cross3(z, v.up)), y = cross3(z, x);
        const pos = [0, 1, 2].map(j => -(E[0][j] * E[0][3] + E[1][j] * E[1][3] + E[2][j] * E[2][3]));
        // recul initial le long de l'axe optique (dollyOutFromReference de demo/3d.html), en
        // fraction de la distance au pivot
        const pull = DOLLY0 * len3(sub3(pos, p));
        for (let j = 0; j < 3; j++) pos[j] -= z[j] * pull;
        // 2026-10-05 : position par defaut rapprochee d'UN cran de molette (deltaY = -100 px,
        // meme loi que wheel() : facteur exp(-100 x 0.0015)), homothetie autour du pivot
        // 2026-10-07 : rapprochee aussi du facteur FOCAL (grossissement f / d inchange)
        const k1 = Math.exp(-100 * 0.0015) * FOCAL;
        for (let j = 0; j < 3; j++) pos[j] = p[j] + (pos[j] - p[j]) * k1;
        [x, y, z].forEach((a, i) => { for (let j = 0; j < 3; j++) E[i][j] = a[j]; E[i][3] = -dot3(a, pos); });
      }
      v.ready = true;
    };
    v.draw = z => {
      const z3 = [z[2], z[0], z[1]];
      if (!v.lastZ || z3.some((x, i) => x !== v.lastZ[i])) { v.M.update(z3); v.R.refresh(); v.lastZ = z3; }
      v.R.draw(v.cam);
    };
    v.select = (x, y) => v.M.select(v.cam, x, y, v.radius, false);
    v.jac = (z, sel) => v.M.jacobian([z[2], z[0], z[1]], v.cam, sel);
    // ── camera : meme controle que demo/3d.html (orbitAroundPivot, zoomBy, panBy) ──
    // E est monde -> camera (OpenCV : visee +Z, Y vers le bas). Les lignes de sa rotation sont
    // les axes camera exprimes dans le monde, soit les colonnes de camToWorld dans 3d.html.
    function getCam() {
      const E = v.cam.E, ax = [0, 1, 2].map(i => E[i].slice(0, 3));
      const pos = [0, 1, 2].map(j => -(ax[0][j] * E[0][3] + ax[1][j] * E[1][3] + ax[2][j] * E[2][3]));
      return {ax, pos};
    }
    function setCam(ax, pos) {
      const E = v.cam.E;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) E[i][j] = ax[i][j];
        E[i][3] = -dot3(ax[i], pos);
      }
    }
    // la camera se deplace sur une sphere centree sur le pivot ; rotation RIGIDE (orientation
    // comprise), pas de re-visee du pivot
    function orbitAroundPivot(dx, dy) {
      const {ax, pos} = getCam(), up = v.up, pv = v.pivot;
      const right = norm3(rot3(ax[0], up, dx));
      let off = rot3(sub3(pos, pv), up, dx);
      // pas de bascule par-dessus les poles
      const tilted = rot3(off, right, dy);
      let useDy = dy;
      if (Math.abs(dot3(norm3(tilted), up)) < 0.995) off = tilted; else useDy = 0;
      const spin = w => useDy ? rot3(rot3(w, up, dx), right, useDy) : rot3(w, up, dx);
      setCam(ax.map(spin), [pv[0] + off[0], pv[1] + off[1], pv[2] + off[2]]);
    }
    // homothetie de la position camera autour du pivot, orientation inchangee
    function zoomBy(f) {
      const {ax, pos} = getCam(), pv = v.pivot, off = sub3(pos, pv), r = len3(off) || 1e-6;
      const k = Math.max(v.rMin, Math.min(v.rMax, r * f)) / r;
      setCam(ax, [pv[0] + off[0] * k, pv[1] + off[1] * k, pv[2] + off[2] * k]);
    }
    // la camera glisse dans son plan image ; le pivot la suit
    function panBy(tx, ty) {
      const {ax, pos} = getCam();
      for (let i = 0; i < 3; i++) { const d = ax[0][i] * tx + ax[1][i] * ty; v.pivot[i] += d; pos[i] += d; }
      setCam(ax, pos);
    }
    const orbitSpeed = 3.0;
    v.orbit = {active: false, mode: 0, x: 0, y: 0,
      // bouton droit : orbite ; bouton milieu : zoom
      start(e) { this.active = true; this.mode = e.button; this.x = e.clientX; this.y = e.clientY; },
      move(e) {
        const dx = e.clientX - this.x, dy = e.clientY - this.y; this.x = e.clientX; this.y = e.clientY;
        if (this.mode === 2) orbitAroundPivot(-orbitSpeed * dx / v.canvas.clientWidth,
                                              -orbitSpeed * dy / v.canvas.clientHeight);
        else if (this.mode === 1) zoomBy(Math.exp(dy * 0.005));
      },
      wheel(e) {
        const scale = e.deltaMode == 1 ? 10 : e.deltaMode == 2 ? v.canvas.clientHeight : 1;
        if (e.shiftKey) {
          const ps = len3(sub3(getCam().pos, v.pivot)) * 0.0002;
          panBy(e.deltaX * scale * ps, e.deltaY * scale * ps);
        } else {
          // molette, et pincement du trackpad (ctrl+wheel, deltas bien plus petits)
          zoomBy(Math.exp(e.deltaY * scale * (e.ctrlKey || e.metaKey ? 0.01 : 0.0015)));
        }
      },
      // deux doigts : le milieu oriente l'orbite, l'ecartement pilote le zoom
      pinch(a0, b0, a1, b1) {
        const mx = (a1[0] + b1[0]) / 2, my = (a1[1] + b1[1]) / 2;
        const pmx = (a0[0] + b0[0]) / 2, pmy = (a0[1] + b0[1]) / 2;
        orbitAroundPivot(-orbitSpeed * (mx - pmx) / v.canvas.clientWidth,
                         -orbitSpeed * (my - pmy) / v.canvas.clientHeight);
        const ds = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) / Math.hypot(a1[0] - b1[0], a1[1] - b1[1]);
        if (isFinite(ds) && ds > 0) zoomBy(ds);
      }};
    attachGrab(v);
    return v;
  }

  const v3 = view3D('cv3d', 'ov3d', 22);
  views.push(v3);

  // ── qualites : fichier et cote du rendu 3D (agrandi par le navigateur) ──
  const QUAL = {
    low: {d3: './demo/mpov/mpov_3d.js', side: 512, n3: '20 000'},
    high: {d3: './demo/mpov/mpov_3d_hi.js', side: 640, n3: '85 000'}};
  const packs3d = {};
  let quality = 'low', switching = false;
  function setLabel(el, en, fr) {
    el.dataset.en = en; el.dataset.fr = fr;
    el.textContent = lang() === 'fr' ? fr : en;
  }
  function labels(q) {
    const Q = QUAL[q];
    setLabel($('tag3d'), '3D decoder · ' + Q.n3 + ' Gaussians · four views',
             'décodeur 3D · ' + Q.n3 + ' gaussiennes · quatre vues');
  }
  function loadingShow(v, on) {
    const ld = v.canvas.parentElement.querySelector('.loading');
    if (ld) ld.style.display = on ? 'flex' : 'none';
  }
  async function useQuality(q) {
    if (switching) return;
    switching = true;
    const Q = QUAL[q];
    S.grab = null; S.cursor = null;          // les selections portent des indices de gaussiennes
    if (!v3.byQ[q]) {
      loadingShow(v3, true);
      try { await loadScript(Q.d3); packs3d[q] = window.MPOV_DEC3D; }
      catch (e) { console.error(e); }
    }
    if (packs3d[q] || v3.byQ[q]) v3.init(packs3d[q], q, Q.side);
    loadingShow(v3, false);
    quality = q; labels(q);
    $('mpHi').classList.toggle('on', q === 'high');
    switching = false;
  }

  function zNow() { return [S.q[0], S.q[1], S.s]; }

  // ── convention d'AFFICHAGE (2026-10-07) : le mode dominant (q[1] de l'encodeur, une flexion)
  // est affiche q0 « flexion », le mode secondaire (q[0], une torsion) q1 « torsion ». L'etat
  // interne, la dynamique (phys.js) et les decodeurs gardent l'ordre de l'encodeur ; seuls le
  // plan latent, q(t) et la valeur affichee echangent les deux coordonnees.
  const D = q => [q[1], q[0]];
  const QNAME = () => lang() === 'fr' ? ['q₀ « flexion »', 'q₁ « torsion »'] : ['q₀ “bending”', 'q₁ “twist”'];

  // ── espace latent interpretable : nuage des q mesures (phys.js, cloud = (s, q0, q1) une
  // image sur 12) et etat PARTAGE (S) avec la demo : le point est S.q, le curseur pilote s,
  // « lecture » est celle de la demo. Tenir le point fixe l'etat (vitesse nulle) sans arreter
  // le temps : le bras et q(t) continuent d'avancer ; le lacher relance la dynamique depuis cet
  // etat, sauf si la simulation est en pause (bouton lecture, independant de la saisie). Fleche : effort latent applique F_q = J^T f (borne comprise), comme
  // le plan de phase du sac de lagsplat.html (longueur 3 F / KREF en unites de q, plafonnee).
  const EX = (() => {
    const X = {visible: false, drag: false, hover: null};
    const cv = $('exPlot'), ctx = cv.getContext('2d');
    // lo, hi, X.hover, qAt : coordonnees d'AFFICHAGE (D) ; S.q, inHull, le domaine : internes
    let lo = D(P.q_lo), hi = D(P.q_hi);
    // coque chargee : plan elargi a la limite EXT x R(theta) (contour du domaine des donnees en
    // tirets, limite en pointilles)
    function shellCurve(f) {
      const out = [];
      for (let i = 0; i <= 144; i++) {
        const th = -Math.PI + 2 * Math.PI * i / 144, u = [Math.cos(th), Math.sin(th)];
        const R = f * SHELL.SH.radius(u);
        out.push(D([R * u[0], R * u[1]]));
      }
      return out;
    }
    function relayout() {
      if (SHELL.SH) {
        const c = shellCurve(SHELL.SH.meta.ext);
        const l0 = D(P.q_lo), h0 = D(P.q_hi);
        lo = [Math.min(l0[0], ...c.map(p => p[0])), Math.min(l0[1], ...c.map(p => p[1]))];
        hi = [Math.max(h0[0], ...c.map(p => p[0])), Math.max(h0[1], ...c.map(p => p[1]))];
      }
      geo = null;
    }
    // enveloppe convexe des q mesures (chaine monotone d'Andrew), non affichee : un etat
    // hors d'elle est une extrapolation des decodeurs
    const HULL = (() => {
      const pts = P.cloud.map(c => [c[1], c[2]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower = [], upper = [];
      for (const p of pts) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i];
        while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
      return lower.slice(0, -1).concat(upper.slice(0, -1));       // sens trigonometrique
    })();
    function inHull(q) {
      for (let i = 0, n = HULL.length; i < n; i++) {
        const a = HULL[i], b = HULL[(i + 1) % n];
        if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < 0) return false;
      }
      return true;
    }
    let geo = null, cache = null;
    // style du plan de phase de lagsplat.html (experience 3) : cadre fin gris, pas de grille,
    // etiquettes q en gris, donnees en bleu --q translucide, etat en rouge a anneau blanc,
    // effort latent en orange
    const FRAME = 'rgba(154,166,180,.6)', LABEL = '#5d6b7a', DATA = 'rgba(91,143,199,.35)';
    const DOT = '#d23b3b', LAT = '#e8380d', LAT_ARROW_GAIN = 3.0;
    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return false;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (geo && geo.W === W && geo.H === H) return true;
      cv.width = W; cv.height = H;
      // cadre carre (marge 10 % du cote, comme phaseBox) ; echelle EGALE sur q0 et q1
      const side = Math.min(w, h), pad = 0.10 * side, inner = side - 2 * pad;
      const ox = (w - side) / 2 + pad, oy = (h - side) / 2 + pad;
      const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]), sc = inner / span;
      const cx = ox + inner / 2, cy = oy + inner / 2;
      const mx = 0.5 * (lo[0] + hi[0]), my = 0.5 * (lo[1] + hi[1]);
      geo = {W, H, dpr, w, h, sc, ox, oy, inner,
             px: q0 => cx + (q0 - mx) * sc, py: q1 => cy - (q1 - my) * sc,
             qx: x => mx + (x - cx) / sc, qy: y => my - (y - cy) / sc};
      // fond mis en cache : cadre, etiquettes, nuage
      cache = document.createElement('canvas'); cache.width = W; cache.height = H;
      const g = cache.getContext('2d'); g.scale(dpr, dpr);
      g.strokeStyle = FRAME; g.lineWidth = 1; g.strokeRect(ox, oy, inner, inner);
      g.fillStyle = LABEL; g.font = "600 12px 'JetBrains Mono', monospace"; g.textAlign = 'center';
      const nm = QNAME();
      g.fillText(nm[0], ox + inner / 2, oy + inner + 16);
      g.save(); g.translate(ox - 14, oy + inner / 2); g.rotate(-Math.PI / 2); g.fillText(nm[1], 0, 0); g.restore();
      g.save(); g.beginPath(); g.rect(ox, oy, inner, inner); g.clip();
      g.fillStyle = DATA;
      for (const c of P.cloud) { g.beginPath(); g.arc(geo.px(c[2]), geo.py(c[1]), 2, 0, 6.284); g.fill(); }
      if (SHELL.SH) {
        for (const [f, dash] of [[1, [5, 4]], [SHELL.SH.meta.ext, [1.5, 3]]]) {
          g.strokeStyle = LABEL; g.lineWidth = 1.2; g.setLineDash(dash); g.beginPath();
          shellCurve(f).forEach((p, i) => i ? g.lineTo(geo.px(p[0]), geo.py(p[1])) : g.moveTo(geo.px(p[0]), geo.py(p[1])));
          g.stroke();
        }
        g.setLineDash([]);
      }
      g.restore();
      return true;
    }
    // fleche d'effort de lagsplat.html (drawForceArrow) : trait 3 px, pointe, point d'origine
    function arrow(x0, y0, x1, y1, color) {
      ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const ang = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0);
      if (L > 6) {
        ctx.beginPath(); ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - 12 * Math.cos(ang - 0.4), y1 - 12 * Math.sin(ang - 0.4));
        ctx.lineTo(x1 - 12 * Math.cos(ang + 0.4), y1 - 12 * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x0, y0, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    function drawPlot() {
      if (!layout()) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, geo.W, geo.H); ctx.drawImage(cache, 0, 0);
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      // reticule au survol
      if (X.hover && !X.drag) {
        ctx.strokeStyle = 'rgba(93,107,122,.35)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        const hx = geo.px(X.hover[0]), hy = geo.py(X.hover[1]);
        ctx.beginPath(); ctx.moveTo(hx, geo.oy); ctx.lineTo(hx, geo.oy + geo.inner);
        ctx.moveTo(geo.ox, hy); ctx.lineTo(geo.ox + geo.inner, hy); ctx.stroke(); ctx.setLineDash([]);
      }
      const qd = D(S.q), sx = geo.px(qd[0]), sy = geo.py(qd[1]);
      // effort latent applique, pendant une saisie
      const F = D(S.F || [0, 0]);
      if (S.grab && (F[0] || F[1])) {
        const k = LAT_ARROW_GAIN * geo.sc / KREF;
        let vx = F[0] * k, vy = -F[1] * k;
        const vm = Math.hypot(vx, vy), VMAX = 0.40 * geo.inner;
        if (vm > VMAX) { vx *= VMAX / vm; vy *= VMAX / vm; }
        arrow(sx, sy, sx + vx, sy + vy, LAT);
      }
      // etat courant : point rouge a anneau blanc
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 6.284);
      ctx.fillStyle = DOT; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    function qAt(e) {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      return [Math.max(lo[0], Math.min(hi[0], geo.qx(x))), Math.max(lo[1], Math.min(hi[1], geo.qy(y)))];
    }
    function hoverText(d) {
      const q = D(d), sh = shellOn() && SHELL.SH.project(q).out;
      return 'q = (' + d[0].toFixed(2) + ', ' + d[1].toFixed(2) + ')'
        + (sh ? (lang() === 'fr' ? ' · géométrie de la coque' : ' · shell geometry') : inHull(q) ? '' : ' · extrapolation');
    }
    function place(d) { const q = D(d); S.q[0] = q[0]; S.q[1] = q[1]; S.v[0] = 0; S.v[1] = 0; }
    cv.addEventListener('pointerdown', e => {
      if (!geo) return;
      X.drag = true; cv.setPointerCapture(e.pointerId);
      S.grab = null; S.cursor = null;
      S.hold = true; place(qAt(e));
    });
    cv.addEventListener('pointermove', e => {
      if (!geo) return;
      const q = qAt(e); X.hover = q;
      $('exHover').textContent = hoverText(q);
      if (X.drag) place(q);
    });
    for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, () => { X.drag = false; S.hold = false; S.v[0] = 0; S.v[1] = 0; });
    cv.addEventListener('pointerleave', () => { X.hover = null; $('exHover').innerHTML = '&nbsp;'; });
    new IntersectionObserver(es => { X.visible = es.some(e => e.isIntersecting); }).observe(cv);
    // changement de langue (lang.js) : etiquettes des axes
    new MutationObserver(() => { geo = null; }).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});

    return {
      relayout,
      bounds: () => [lo, hi],
      frame() {
        if (!X.visible) return;
        drawPlot();
      }};
  })();

  // ── q(t) et s(t) : meme trace que l'experience 4 de lagsplat.html (drawState) : une piste par
  // coordonnee (s, puis q0 « flexion » et q1 « torsion » dans la convention d'affichage), bande
  // grisee = etendue de l'enregistrement (centiles 1 et 99 du nuage), historique defilant (un point
  // par pas physique, y compris quand le point du plan latent est tenu), etat courant a droite.
  // Echelle verticale de q : celle du plan latent (elargie a la limite de la coque quand elle est
  // chargee) ; de s : la course du curseur. ──
  const QT = (() => {
    const cv = $('qtPlot'), HIST = 720, hist = [], COLS = ['#118a6e', '#1b3a6b', '#d23b3b'];
    const col = [c => c[0], c => c[2], c => c[1]];                 // s, puis (q0, q1) d'affichage
    const pct = (k, f) => { const v = P.cloud.map(col[k]).sort((a, b) => a - b);
      return v[Math.round(f * (v.length - 1))]; };
    const BAND = [0, 1, 2].map(k => [pct(k, 0.01), pct(k, 0.99)]);
    let visible = false;
    new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); }).observe(cv);
    function push() { const d = D(S.q); hist.push([S.s, d[0], d[1]]); if (hist.length > HIST) hist.splice(0, hist.length - HIST); }
    function draw() {
      if (!visible) return;
      const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
      const [lo, hi] = EX.bounds(), pad = 6, lane = (h - 2 * pad) / 3;
      const rng = [[P.s_lo, P.s_hi], [lo[0], hi[0]], [lo[1], hi[1]]], names = ['s'].concat(QNAME());
      for (let k = 0; k < 3; k++) {
        const y0 = pad + k * lane, y1 = y0 + lane;
        const c = 0.5 * (rng[k][0] + rng[k][1]), sp = 0.5 * (rng[k][1] - rng[k][0]) * 1.05;
        const Y = v => y1 - 4 - (v - (c - sp)) / (2 * sp) * (lane - 8);
        x.fillStyle = 'rgba(27,58,107,0.07)';
        x.fillRect(0, Y(BAND[k][1]), w, Y(BAND[k][0]) - Y(BAND[k][1]));
        x.strokeStyle = 'rgba(0,0,0,0.10)'; x.lineWidth = 1;
        const yref = k === 0 ? P.s_rest : 0;
        x.beginPath(); x.moveTo(0, Y(yref)); x.lineTo(w, Y(yref)); x.stroke();
        if (hist.length > 1) {
          x.save(); x.beginPath(); x.rect(0, y0, w, lane); x.clip();
          x.strokeStyle = COLS[k]; x.lineWidth = 1.6; x.beginPath();
          for (let i = 0; i < hist.length; i++) {
            const px = w - (hist.length - 1 - i) / (HIST - 1) * w, py = Y(hist[i][k]);
            if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
          }
          x.stroke();
          x.fillStyle = COLS[k]; x.beginPath(); x.arc(w - 1, Y(hist[hist.length - 1][k]), 2.6, 0, 6.284); x.fill();
          x.restore();
        }
        x.fillStyle = COLS[k]; x.font = '600 11px ui-monospace,monospace';
        x.fillText(names[k], 6, y0 + 13);
      }
    }
    return {push, draw};
  })();

  // ── boucle ────────────────────────────────────────────────────────────────
  let last = performance.now(), fps = 0, ms = {};
  function loop(now) {
    const el = Math.min(0.25, (now - last) / 1000); last = now;
    fps = 0.9 * fps + 0.1 / Math.max(el, 1e-4);
    if (S.running) {
      if (S.grab && S.grab.view.ready) {
        const j = S.grab.view.jac(zNow(), S.grab.sel);
        Object.assign(S.grab, j, {qref: [S.q[0], S.q[1]]});
      }
      // accumulateur : a 144 ou 240 Hz une image dure moins qu'un pas physique, un arrondi
      // de el / dt y vaudrait 0 et la simulation resterait figee
      S.acc = Math.min((S.acc || 0) + el, 40 * dt);
      while (S.acc >= dt) { stepOnce(); QT.push(); S.acc -= dt; }
    }
    const z = zNow();
    for (const v of views) {
      if (!v.ready || !v.visible) continue;
      const t0 = performance.now();
      v.draw(z);
      ms[v.canvas.id] = 0.9 * (ms[v.canvas.id] || 0) + 0.1 * (performance.now() - t0);
      drawOverlay(v);
    }
    EX.frame();
    QT.draw();
    $('mpQ').textContent = D(S.q).map(v => v.toFixed(2)).join(', ');
    if (!S.replay && document.activeElement !== $('mpS')) $('mpS').value = S.target;
    $('mpStats').textContent = (quality === 'high' ? 'high' : 'low') + ' resolution · ' + fps.toFixed(0) + ' fps · ' + Object.entries(ms)
      .map(([k, v]) => k.replace('cv', '') + ' ' + v.toFixed(1) + ' ms').join(' · ')
      + (distAt(Array.from(S.q)) > 0 ? ' · edge of the explored domain' : '')
      + (shellOn() && v3.M && v3.M.shellOut ? ' · beyond the data, shell geometry (r/R ' + v3.M.shellRatio.toFixed(2) + ')' : '');
    requestAnimationFrame(loop);
  }

  // ── commandes ───────────────────────────────────────────────────────────
  function setRunning(r) {
    S.running = r;
    $('mpPlay').textContent = r ? '\u275a\u275a' : '\u25b6';
  }
  $('mpPlay').onclick = () => setRunning(!S.running);
  {
    const sl = $('mpS');
    sl.min = P.s_lo; sl.max = P.s_hi; sl.value = S.target;
    sl.addEventListener('input', () => {
      S.target = +sl.value;
      if (S.replay) { S.replay = false; $('mpReplay').classList.remove('on'); }
    });
  }
  setRunning(S.running);
  $('mpReplay').onclick = e => {
    S.replay = !S.replay; S.k = 0; e.currentTarget.classList.toggle('on', S.replay);
    if (!S.replay) { S.target = S.s; S.sd = 0; }
    if (!S.running) setRunning(true);
  };
  $('mpKick').onclick = () => {
    for (let i = 0; i < dq; i++) S.v[i] += (Math.random() * 2 - 1) * 12 * P.q_std[i];
    if (!S.running) setRunning(true);
  };
  $('mpRest').onclick = () => { S.q.fill(0); S.v.fill(0); };
  $('mpHi').onclick = () => { if (started) useQuality(quality === 'high' ? 'low' : 'high'); };
  $('mpShell').onclick = () => {
    if (!SHELL.SH) return;
    SHELL.on = !SHELL.on; SHELL.SH.on = SHELL.on;
    $('mpShell').classList.toggle('on', SHELL.on);
    // coque desactivee : retour dans le domaine par la barriere d'origine
    for (const r of Object.values(v3.byQ)) r.M.update(r.M.z || [P.s_rest, 0, 0]);
    v3.lastZ = null;
  };
  // variete de coque : chargee apres les decodeurs, attachee a chaque decodeur 3D
  async function loadShell() {
    try { if (!window.MPOV_SHELL) await loadScript('./demo/mpov/shell_ext.js'); }
    catch (e) { console.error(e); return; }
    SHELL.SH = Zoned3D.shell(window.MPOV_SHELL); SHELL.SH.on = SHELL.on;
    for (const r of Object.values(v3.byQ)) r.M.setShell(SHELL.SH);
    v3.lastZ = null;
    $('mpShell').classList.toggle('on', SHELL.on);
    EX.relayout();
  }

  // ── videos de comparaison : lecture quand elles sont a l'ecran ──
  const vids = Array.from(document.querySelectorAll('#lags-demo video.cmp'));
  const vio = new IntersectionObserver(es => es.forEach(en => {
    if (en.isIntersecting) en.target.play().catch(() => {}); else en.target.pause();
  }), {threshold: 0.3});
  vids.forEach(v => vio.observe(v));

  // ── chargement differe des decodeurs, quand la section arrive a l'ecran ──
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.body.appendChild(s); });
  }
  function hasGL2() { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } }
  let started = false;
  async function start() {
    if (started) return; started = true;
    if (!hasGL2()) {
      const w = $('liveWarn'); w.style.display = 'block';
      w.textContent = lang() === 'fr' ? "Ce navigateur ne fournit pas WebGL2 : la démo interactive ne peut pas s'afficher."
                                      : 'This browser does not provide WebGL2: the interactive demo cannot run.';
      return;
    }
    requestAnimationFrame(loop);
    // 2026-10-07 : haute resolution par defaut
    await useQuality('high');
    await loadShell();
  }
  // ── auto-test (?selftest) : cherche la languette dans chaque vue, saisit et tire ──
  if (/selftest/.test(location.search)) {
    window.__mpov = {S, views};
    const out = [];
    const waitReady = () => new Promise(r => { const t = setInterval(() => {
      if (views.every(v => v.ready)) { clearInterval(t); r(); } }, 50); });
    (async () => {
      await waitReady();
      await new Promise(r => setTimeout(r, 500));
      for (const q of ['low', 'high']) {
      await useQuality(q);
      out.push('== ' + q + ' : ' + views.map(v => v.canvas.id + ' ' + v.W() + 'x' + v.H()).join(', '));
      for (const v of views) {
        let best = null;
        const z = zNow();
        for (let y = 0.1; y < 1; y += 0.1) for (let x = 0.1; x < 1; x += 0.1) {
          const p = [x * v.W(), y * v.H()], sel = v.select(p[0], p[1]);
          if (!sel) continue;
          const j = v.jac(z, sel), g = gateOf(j.neff, j.coh, v.gate);
          const nJ = Math.hypot(j.J[0][0], j.J[0][1], j.J[1][0], j.J[1][1]) * g;
          if (!best || nJ > best.nJ) best = {nJ, p, sel, j, g};
        }
        if (!best) { out.push(v.canvas.id + ' : aucune saisie'); continue; }
        S.q.fill(0); S.v.fill(0);
        S.grab = Object.assign({view: v, sel: best.sel, qref: [0, 0]}, best.j);
        S.cursor = [best.p[0] + 0.12 * v.W(), best.p[1]];
        // 1.5 s de physique, pas a pas (la boucle d'affichage ne tourne pas en headless)
        for (let i = 0; i < Math.round(1.5 / dt); i++) {
          if (i % 4 === 0) Object.assign(S.grab, v.jac(zNow(), S.grab.sel), {qref: [S.q[0], S.q[1]]});
          if (v === v3 && i % 4 === 0) { v3.M.update([S.s, S.q[0], S.q[1]]); }
          stepOnce();
        }
        const cpl = coupling();
        out.push('   point saisi ' + (cpl ? cpl.p.map(x => x.toFixed(1)) : '-') + ' px, consigne '
          + S.cursor.map(x => x.toFixed(1)) + ' px, effort ' + (100 * S.Fq / fmaxOf(S.grab && S.grab.view)).toFixed(0) + ' % du plafond');
        out.push(v.canvas.id + ' : saisie en (' + best.p.map(x => x.toFixed(0)) + ') px, n ' + best.j.n
          + ', n_eff ' + best.j.neff.toFixed(1) + ', coh ' + best.j.coh.toFixed(2) + ', porte ' + best.g.toFixed(2)
          + ', |J| ' + (best.nJ / Math.max(best.g, 1e-9)).toFixed(1) + ' px/q ; apres 1.5 s de traction : q = ('
          + S.q[0].toFixed(3) + ', ' + S.q[1].toFixed(3) + ')');
        S.grab = null; S.cursor = null;
      }
      }
      const d = document.createElement('pre'); d.id = 'selftest'; d.textContent = out.join('\n');
      document.body.appendChild(d);
    })();
  }
  const lio = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { start(); lio.disconnect(); } },
                                       {rootMargin: '300px'});
  lio.observe(document.querySelector('#lags-demo .live-grid'));
  // une vue hors ecran n'est pas rendue
  const vio2 = new IntersectionObserver(es => es.forEach(en => {
    const v = views.find(x => x.canvas === en.target); if (v) v.visible = en.isIntersecting;
  }));
  views.forEach(v => vio2.observe(v.canvas));

  // ── alignement : la scene 3D (carree) a la hauteur des deux panneaux carres de gauche
  // (q(t), plan latent) empiles. Largeur a de la colonne de gauche telle que
  // (a + h1) + (a + h2) + g = (T - g - a) + hR, avec h1, h2, hR la hauteur des panneaux hors
  // image (en-tetes, legende), T la largeur totale, g l'espacement ──
  const grid = document.querySelector('#lags-demo .live-grid');
  function align() {
    if (window.matchMedia('(max-width:880px)').matches) { grid.style.gridTemplateColumns = ''; return; }
    const pan = id => $(id).closest('.panel'), stg = id => $(id).parentElement;
    const h1 = pan('qtPlot').offsetHeight - stg('qtPlot').offsetHeight;
    const h2 = pan('exPlot').offsetHeight - stg('exPlot').offsetHeight;
    const hR = pan('cv3d').offsetHeight - stg('cv3d').offsetHeight;
    const g = parseFloat(getComputedStyle(grid).columnGap) || 14, T = grid.clientWidth;
    const a = Math.round((T - 2 * g + hR - h1 - h2) / 3);
    const cols = a + 'px minmax(0,1fr)';
    if (a > 120 && grid.style.gridTemplateColumns !== cols) grid.style.gridTemplateColumns = cols;
  }
  new ResizeObserver(align).observe(grid);
  align();
})();
