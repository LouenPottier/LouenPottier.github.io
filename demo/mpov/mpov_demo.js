/*
 * mpov_demo.js : demo interactive de lagsplat-robot.html.
 *
 * Un seul etat (s, q) pilote trois decodeurs :
 *   - 2D, fenetre suiveuse (deform_splat.js, mpov_crop.js)
 *   - 2D, camera fixe       (deform_splat.js, mpov_fixed.js)
 *   - 3D par zones          (zoned3d.js, mpov_3d.js), vu au depart depuis l'iphone1 (meme
 *     focale, meme axe optique, champ elargi a un carre), avec la correction de couleur apprise
 *     de cette camera (memes couleurs que le 2D)
 *
 * Deux jeux de decodeurs, choisis par l'interrupteur « haute resolution » (basse par defaut) :
 *   basse : 2D 5 000 gaussiennes, 3D 20 000 gaussiennes rendue en 640 px
 *   haute : 2D 20 000 gaussiennes, 3D 85 000 gaussiennes rendue en 960 px
 * Le jeu haute resolution n'est telecharge qu'au premier passage ; chaque jeu reste en memoire.
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
 */
(function () {
  'use strict';
  const P = window.MPOV_PHYS, dt = P.dt, dq = 2;
  const root = document.getElementById('lags-demo');
  const $ = id => document.getElementById(id);
  const lang = () => (document.documentElement.lang === 'fr' ? 'fr' : 'en');

  // ── reglages de la saisie (defauts de serve_deform_demo.py) ──
  const KREF = 0.5 * (Math.abs(P.K[0][0]) + Math.abs(P.K[1][1]));
  const FMAX = (() => { const a = P.K[0][0], b = P.K[0][1], c = P.K[1][0], d = P.K[1][1];
    const s = a * a + b * b + c * c + d * d, t = a * d - b * c;
    return Math.sqrt(0.5 * (s + Math.sqrt(Math.max(0, s * s - 4 * t * t)))); })() * P.q_disk.r;
  const G = {kc: Math.pow(10, -0.5), cc: Math.pow(10, 0.3), nmin: Math.pow(10, 0.7), cmin: 0.5,
             barrier: 8, margin: 0.02};

  const S = {q: new Float64Array(dq), v: new Float64Array(dq),
             s: P.s_rest, sd: 0, sdd: 0, target: P.s_rest,
             running: true, replay: false, k: 0, grab: null, cursor: null, gate: 0, Fq: 0};

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
  function gateOf(neff, coh) {
    const cl = x => Math.max(0, Math.min(1, x));
    if (!(neff >= 0) || !(coh >= 0)) return 0;
    return cl((neff - 0.5 * G.nmin) / (0.5 * G.nmin)) * cl((coh - (G.cmin - 0.1)) / 0.1);
  }
  function coupling() {
    const g0 = S.grab;
    if (!g0 || !S.cursor || !g0.J) return null;
    const g = gateOf(g0.neff, g0.coh); S.gate = g;
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
    const Fb = barrierForce(Array.from(S.q), Array.from(S.v)), a = [0, 0];
    for (let i = 0; i < dq; i++) {
      a[i] = P.b[i] + Fb[i] + P.G[i] * S.sdd;
      for (let j = 0; j < dq; j++) a[i] += -P.K[i][j] * S.q[j] - P.C[i][j] * S.v[j];
    }
    const cp = coupling();
    if (!cp) { S.Fq = 0; for (let i = 0; i < dq; i++) S.v[i] += dt * a[i]; }
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
      S.Fq = Math.min(nF, FMAX);
      if (nF <= FMAX) { S.v[0] = v1[0]; S.v[1] = v1[1]; }
      else for (let i = 0; i < 2; i++) S.v[i] += dt * (a[i] + F[i] * FMAX / nF);
    }
    for (let i = 0; i < dq; i++) S.q[i] += dt * S.v[i];
    wallProject();
  }

  // ── vues ──────────────────────────────────────────────────────────────────
  const views = [];
  function overlayFit(v) {
    const c = v.canvas, o = v.ovl, dpr = window.devicePixelRatio || 1;
    // canevas ajuste a la scene en gardant le rapport d'aspect de l'image
    const st = c.parentElement, k = Math.min(st.clientWidth / v.W(), st.clientHeight / v.H());
    const cw = Math.floor(v.W() * k) + 'px', ch = Math.floor(v.H() * k) + 'px';
    if (c.style.width !== cw || c.style.height !== ch) { c.style.width = cw; c.style.height = ch; }
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
    c.addEventListener('pointerdown', e => {
      if (!v.ready) return;
      if (e.button === 2 && v.orbit) { v.orbit.start(e); c.setPointerCapture(e.pointerId); return; }
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
      if (v.orbit && v.orbit.active) { v.orbit.move(e); return; }
      if (S.grab && S.grab.view === v) S.cursor = toImg(v, e);
    });
    for (const ev of ['pointerup', 'pointercancel']) c.addEventListener(ev, () => {
      if (v.orbit) v.orbit.active = false;
      if (S.grab && S.grab.view === v) { S.grab = null; S.cursor = null; }
      c.classList.remove('grabbing');
    });
    if (v.orbit) c.addEventListener('wheel', e => { e.preventDefault(); v.orbit.zoom(e.deltaY); }, {passive: false});
  }

  function view2D(name, cvId, ovId, radius) {
    const v = {canvas: $(cvId), ovl: $(ovId), radius, ready: false, visible: true, st: null, byQ: {}};
    v.init = (pack, q) => {
      if (!v.byQ[q]) { const D = DeformSplat.load(pack); v.byQ[q] = {D, R: DeformSplat.renderer(v.canvas, D)}; }
      v.D = v.byQ[q].D; v.R = v.byQ[q].R; v.st = null;
      v.canvas.width = v.D.W; v.canvas.height = v.D.H;
      v.W = () => v.D.W; v.H = () => v.D.H;
      v.ready = true;
    };
    v.draw = z => { v.st = v.D.state([z[0], z[1], z[2]]); v.R.draw(v.st); };
    v.select = (x, y) => v.st ? v.D.select(v.st, x, y, v.radius, false) : null;
    v.jac = (z, sel) => v.D.jacobian([z[0], z[1], z[2]], sel);
    attachGrab(v);
    return v;
  }

  function view3D(cvId, ovId, radius640) {
    const v = {canvas: $(cvId), ovl: $(ovId), radius: radius640, ready: false, visible: true,
               lastZ: null, byQ: {}};
    v.init = (pack, q, side) => {
      if (!v.byQ[q]) { const M = Zoned3D.load(pack); v.byQ[q] = {M, R: Zoned3D.renderer(v.canvas, M)}; }
      v.M = v.byQ[q].M; v.R = v.byQ[q].R; v.lastZ = null;
      // fenetre CARREE de cote `side` : focale et axe optique de l'iphone1 (mis a l'echelle
      // side / H) ; le champ horizontal est elargi au lieu de deformer l'image. Au changement
      // de qualite, la pose courante de la camera est conservee.
      const c0 = v.M.meta.cams.iphone1, k = side / c0.H;
      const E = v.cam ? v.cam.E : c0.E.map(r => r.slice());
      v.cam = {E, K: [[c0.K[0][0] * k, 0, side / 2 + (c0.K[0][2] - c0.W / 2) * k],
                      [0, c0.K[1][1] * k, c0.K[1][2] * k], [0, 0, 1]],
               W: side, H: side, color: c0.color};
      v.cam0 = JSON.parse(JSON.stringify(Object.assign({}, v.cam, {E: c0.E})));
      v.radius = radius640 * side / 640;
      v.W = () => v.cam.W; v.H = () => v.cam.H;
      // pivot de l'orbite : barycentre de la zone q (la languette) a l'etat de repos
      v.M.update([P.s_rest, 0, 0]);
      const p = [0, 0, 0], nq = v.M.meta.n_q;
      for (let g = 0; g < nq; g++) for (let k = 0; k < 3; k++) p[k] += v.M.xyz[3 * g + k] / nq;
      v.pivot = p;
      v.ready = true;
    };
    v.draw = z => {
      const z3 = [z[2], z[0], z[1]];
      if (!v.lastZ || z3.some((x, i) => x !== v.lastZ[i])) { v.M.update(z3); v.R.refresh(); v.lastZ = z3; }
      v.R.draw(v.cam);
    };
    v.select = (x, y) => v.M.select(v.cam, x, y, v.radius, false);
    v.jac = (z, sel) => v.M.jacobian([z[2], z[0], z[1]], v.cam, sel);
    // ── orbite autour du pivot, axes de la camera ──
    const rot = (ax, th) => {
      const c = Math.cos(th), s = Math.sin(th);
      return ax === 'y' ? [[c, 0, s], [0, 1, 0], [-s, 0, c]] : [[1, 0, 0], [0, c, -s], [0, s, c]];
    };
    function applyCam(Q, dz) {
      const E = v.cam.E, p = v.pivot;
      const cp = [0, 1, 2].map(i => E[i][0] * p[0] + E[i][1] * p[1] + E[i][2] * p[2] + E[i][3]);
      const R = [0, 1, 2].map(i => [0, 1, 2].map(j => Q[i][0] * E[0][j] + Q[i][1] * E[1][j] + Q[i][2] * E[2][j]));
      const tmc = [0, 1, 2].map(i => E[i][3] - cp[i]);
      const t = [0, 1, 2].map(i => Q[i][0] * tmc[0] + Q[i][1] * tmc[1] + Q[i][2] * tmc[2] + cp[i]);
      t[2] += dz * cp[2];
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) E[i][j] = R[i][j]; E[i][3] = t[i]; }
    }
    v.orbit = {active: false, x: 0, y: 0,
      start(e) { this.active = true; this.x = e.clientX; this.y = e.clientY; },
      move(e) {
        const dx = e.clientX - this.x, dy = e.clientY - this.y; this.x = e.clientX; this.y = e.clientY;
        const Qy = rot('y', -dx * 0.006), Qx = rot('x', dy * 0.006);
        const Q = [0, 1, 2].map(i => [0, 1, 2].map(j => Qx[i][0] * Qy[0][j] + Qx[i][1] * Qy[1][j] + Qx[i][2] * Qy[2][j]));
        applyCam(Q, 0);
      },
      zoom(dy) { applyCam([[1, 0, 0], [0, 1, 0], [0, 0, 1]], Math.max(-0.3, Math.min(0.3, dy * 0.0012))); }};
    attachGrab(v);
    v.canvas.addEventListener('dblclick', () => { v.cam = JSON.parse(JSON.stringify(v.cam0)); });
    return v;
  }

  const vCrop = view2D('crop', 'cvCrop', 'ovCrop', 18);
  const vFixed = view2D('fixed', 'cvFixed', 'ovFixed', 14);
  const v3 = view3D('cv3d', 'ov3d', 22);
  views.push(vCrop, vFixed, v3);

  // ── qualites : fichiers, cote du rendu 3D (agrandi par le navigateur) et etiquettes ──
  const QUAL = {
    low: {crop: ['./demo/mpov/mpov_crop.js', 'crop'], fixed: ['./demo/mpov/mpov_fixed.js', 'fixed'],
          d3: './demo/mpov/mpov_3d.js', side: 640, n2: '5 000', n3: '20 000'},
    high: {crop: ['./demo/mpov/mpov_crop_hi.js', 'crop_hi'], fixed: ['./demo/mpov/mpov_fixed_hi.js', 'fixed_hi'],
           d3: './demo/mpov/mpov_3d_hi.js', side: 960, n2: '20 000', n3: '85 000'}};
  const packs3d = {};
  let quality = 'low', switching = false;
  function setLabel(el, en, fr) {
    el.dataset.en = en; el.dataset.fr = fr;
    el.textContent = lang() === 'fr' ? fr : en;
  }
  function labels(q) {
    const Q = QUAL[q];
    for (const id of ['tagCrop', 'tagFixed'])
      setLabel($(id), '2D decoder · ' + Q.n2 + ' Gaussians', 'décodeur 2D · ' + Q.n2 + ' gaussiennes');
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
    for (const [v, [src, key]] of [[vCrop, Q.crop], [vFixed, Q.fixed]]) {
      if (!v.byQ[q]) {
        loadingShow(v, true);
        try { if (!(window.MPOV_DEC2D && window.MPOV_DEC2D[key])) await loadScript(src); }
        catch (e) { console.error(e); loadingShow(v, false); continue; }
      }
      v.init(window.MPOV_DEC2D[key], q);
      loadingShow(v, false);
    }
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
      while (S.acc >= dt) { stepOnce(); S.acc -= dt; }
    }
    const z = zNow();
    for (const v of views) {
      if (!v.ready || !v.visible) continue;
      const t0 = performance.now();
      v.draw(z);
      ms[v.canvas.id] = 0.9 * (ms[v.canvas.id] || 0) + 0.1 * (performance.now() - t0);
      drawOverlay(v);
    }
    $('mpQ').textContent = S.q[0].toFixed(2) + ', ' + S.q[1].toFixed(2);
    if (!S.replay && document.activeElement !== $('mpS')) $('mpS').value = S.target;
    $('mpStats').textContent = (quality === 'high' ? 'high' : 'low') + ' resolution · ' + fps.toFixed(0) + ' fps · ' + Object.entries(ms)
      .map(([k, v]) => k.replace('cv', '') + ' ' + v.toFixed(1) + ' ms').join(' · ')
      + (distAt(Array.from(S.q)) > 0 ? ' · edge of the explored domain' : '');
    requestAnimationFrame(loop);
  }

  // ── commandes ───────────────────────────────────────────────────────────
  function setRunning(r) { S.running = r; $('mpPlay').textContent = r ? '❚❚' : '▶'; }
  $('mpPlay').onclick = () => setRunning(!S.running);
  const sl = $('mpS');
  sl.min = P.s_lo; sl.max = P.s_hi; sl.value = S.target;
  sl.addEventListener('input', () => {
    S.target = +sl.value;
    if (S.replay) { S.replay = false; $('mpReplay').classList.remove('on'); }
  });
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
    await useQuality('low');
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
      if (q === 'high') await useQuality('high');
      out.push('== ' + q + ' : ' + views.map(v => v.canvas.id + ' ' + v.W() + 'x' + v.H()).join(', '));
      for (const v of views) {
        let best = null;
        const z = zNow();
        for (let y = 0.1; y < 1; y += 0.1) for (let x = 0.1; x < 1; x += 0.1) {
          const p = [x * v.W(), y * v.H()], sel = v.select(p[0], p[1]);
          if (!sel) continue;
          const j = v.jac(z, sel), g = gateOf(j.neff, j.coh);
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
          + S.cursor.map(x => x.toFixed(1)) + ' px, effort ' + (100 * S.Fq / FMAX).toFixed(0) + ' % du plafond');
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
})();
