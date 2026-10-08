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
 * Dynamique (2026-10-07) : LNN a masse et dissipation constantes et potentiel INVEXE (lnn.js,
 * code_new_3D/demoxrdays/mpov/fit_lnn_invex.py), M q'' = -grad V(q) - C q' + G s'', evalue ici
 * (gradient analytique du potentiel). Il remplace q'' = -K q - C q' + G s'' + b (phys.js), dont
 * K sert encore d'echelle aux reglages de la saisie (KREF, FREF). s suit le curseur avec une inertie
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
 * la physique reste celle du LNN, mais au-dela du domaine des donnees (rayon R(theta) en q) la
 * geometrie de la semelle 3D vient d'une coque elastique (zoned3d.js, shell_ext.js,
 * code_new_3D/demoxrdays/mpov/elastic/hybrid.py). La barriere est repoussee a EXT x R(theta),
 * le plafond d'effort multiplie par SHELL_FMAX pour pouvoir y tirer la semelle ; les vues 2D,
 * sans coque, restent au bord du domaine. 2026-10-07 : EXT 2 -> 3, SHELL_FMAX 4 -> 10.
 */
(function () {
  'use strict';
  const P = window.MPOV_PHYS, dt = P.dt, dq = 2;

  // ── LNN invexe (web/export_web_lnn.py) : V(q) = g(Phi(q) - Phi(q_r)), gradient analytique ──
  const LN = (() => {
    const W = window.MPOV_LNN;
    const sp = x => x > 20 ? x : Math.log1p(Math.exp(x)), sg = x => 1 / (1 + Math.exp(-x));
    const mv = (Mx, x) => Mx.map(r => r.reduce((a, w, j) => a + w * x[j], 0));
    const mtv = (Mx, x) => { const o = new Array(Mx[0].length).fill(0);
      Mx.forEach((r, i) => r.forEach((w, j) => { o[j] += w * x[i]; })); return o; };
    // Phi et son jacobien (2 x 2)
    function phi(q) {
      let z = [q[0], q[1]], J = [[1, 0], [0, 1]];
      for (const b of W.blocks) {
        const a = mv(b.W1, z).map((v, i) => v + b.b1[i]), t = a.map(Math.tanh);
        const r = mv(b.W2, t).map((v, i) => v + b.b2[i]);
        const Jr = [[0, 0], [0, 0]];
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
          let v = 0;
          for (let k = 0; k < t.length; k++) v += b.W2[i][k] * (1 - t[k] * t[k]) * b.W1[k][j];
          Jr[i][j] = (i === j ? 1 : 0) + b.alpha * v;
        }
        J = [[Jr[0][0] * J[0][0] + Jr[0][1] * J[1][0], Jr[0][0] * J[0][1] + Jr[0][1] * J[1][1]],
             [Jr[1][0] * J[0][0] + Jr[1][1] * J[1][0], Jr[1][0] * J[0][1] + Jr[1][1] * J[1][1]]];
        z = [z[0] + b.alpha * r[0], z[1] + b.alpha * r[1]];
      }
      return {z, J};
    }
    // h (ICNN) et son gradient
    function h(y) {
      const I = W.icnn, a1 = mv(I.Wy0, y).map((v, i) => v + I.by0[i]), z1 = a1.map(sp);
      const w1 = mv(I.Wy1, y);
      const a2 = mv(I.Wz, z1).map((v, i) => v + w1[i] + I.by1[i]);
      const val = a2.reduce((acc, v, i) => acc + I.out[i] * sp(v), 0);
      const da2 = a2.map((v, i) => I.out[i] * sg(v));
      const da1 = mtv(I.Wz, da2).map((v, i) => v * sg(a1[i]));
      const g0 = mtv(I.Wy0, da1), g1 = mtv(I.Wy1, da2);
      return {val, grad: [g0[0] + g1[0], g0[1] + g1[1]]};
    }
    const zr = phi(W.q_r).z, A = W.A;
    function V(q, withGrad) {
      const P_ = phi(q), y = [P_.z[0] - zr[0], P_.z[1] - zr[1]], H = h(y);
      const Ay = mv(A, y);
      const val = 0.5 * (y[0] * Ay[0] + y[1] * Ay[1]) + H.val - W.h0 - W.gh0[0] * y[0] - W.gh0[1] * y[1];
      if (!withGrad) return val;
      const gy = [Ay[0] + H.grad[0] - W.gh0[0], Ay[1] + H.grad[1] - W.gh0[1]];
      return {val, grad: mtv(P_.J, gy)};
    }
    const M = W.M, detM = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    const Minv = [[M[1][1] / detM, -M[0][1] / detM], [-M[1][0] / detM, M[0][0] / detM]];
    // acceleration sans saisie : M^-1 (-grad V - C v + G s'')
    function accel(q, v, sdd) {
      const g = V(q, true).grad, f = [0, 1].map(i => -g[i] - W.C[i][0] * v[0] - W.C[i][1] * v[1] + W.G[i] * sdd);
      return mv(Minv, f);
    }
    // controle contre les valeurs de reference de PyTorch
    function check() {
      let eV = 0, eG = 0, eA = 0;
      W.ref.q.forEach((q, i) => {
        const r = V(q, true), a = accel(q, W.ref.v[i], W.ref.sdd[i]);
        eV = Math.max(eV, Math.abs(r.val - W.ref.V[i]) / (1 + Math.abs(W.ref.V[i])));
        eG = Math.max(eG, ...[0, 1].map(k => Math.abs(r.grad[k] - W.ref.gV[i][k]) / (1 + Math.abs(W.ref.gV[i][k]))));
        eA = Math.max(eA, ...[0, 1].map(k => Math.abs(a[k] - W.ref.acc[i][k]) / (1 + Math.abs(W.ref.acc[i][k]))));
      });
      return {eV, eG, eA};
    }
    return {V, accel, M, Minv, G: W.G, q_r: W.q_r, check};
  })();
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
  // 2026-10-08 : dissipation doublee encore (2.0 -> 4.0) : le point d'application se deplace
  // avec la languette, la saisie oscillait
  const G = {kc: 1.0, cc: 4.0, barrier: 8, margin: 0.02};
  // suivi du bras : fraction de la correction ds appliquee par image (1 = correction entiere,
  // comme xr_native_zoned.py) ; avec le jacobien fige la correction est lineaire, 0.5 la lisse
  const ARM_GAIN = 0.5;

  // ── boite en carton (box3d.js, 2026-10-08), dans le repere du decodeur 3D ──
  // REPERE DE LA TABLE (runs/static_i3/zones.json, zone s, zones_static.py) : origine au centre du
  // rectangle de la table S4 S1 S1' S4' (points suivis sur les images et reconstruits), x = S3 -> S2,
  // y = S1 -> S4, z = verticale S14 -> S15. Le plateau est z = 0 et fait 2 x 1.341 par 2 x 0.929.
  const TF = {c: [-0.23598, 1.53084, 3.96277], ex: [0.8348, -0.04555, 0.54866],
              ey: [0.54957, 0.00964, -0.83539], ez: [-0.03276, -0.99892, -0.03308]};
  const tfPoint = l => [0, 1, 2].map(a => TF.c[a] + l[0] * TF.ex[a] + l[1] * TF.ey[a] + l[2] * TF.ez[a]);
  const tfVec = l => [0, 1, 2].map(a => l[0] * TF.ex[a] + l[1] * TF.ey[a] + l[2] * TF.ez[a]);
  // COLLISIONNEURS de la scene fixe, parametres dans le repere de la table (ajustes a la main avec
  // l'editeur de mpov/web/mpov_demo_planes_editor.js, non publie) :
  //   meuble du robot : pave, centre (dx, dy), plateau a z = top, bas a z = bottom, demi-cotes hx,
  //     hy, lacet yaw (deg) autour de z ;
  //   sol : plan a z = h, inclinaisons tx, ty (deg) autour de x et y ;
  //   mur du fond : normale vers la piece d'angle phi (deg) dans le plan de la table, inclinee de
  //     tilt (deg), a la distance D du centre.
  // Valeurs AJUSTEES A LA MAIN dans l'editeur (2026-10-08), parties de : le rectangle de la table
  // jusqu'au sol, la couche de gaussiennes fixes la plus dense (2.19 sous la table) et le plan
  // vertical de gaussiennes le plus peuple (RANSAC).
  const COLL_DEF = {cab: {dx: 0.05, dy: 0.065, top: 0.056, bottom: -2.19, hx: 1.54, hy: 1.185, yaw: 0},
                    floor: {h: -2.19, tx: 0, ty: 0},
                    wall: {phi: 89.69, D: 2.795, tilt: 0}};
  const deg = Math.PI / 180;
  // (aides locales : dot3 / norm3 sont definis plus bas dans le fichier, apres cet appel)
  const cDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cNorm = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  function buildColliders(C) {
    const cy = Math.cos(C.cab.yaw * deg), sy = Math.sin(C.cab.yaw * deg);
    const cab = {type: 'obb', c: tfPoint([C.cab.dx, C.cab.dy, 0.5 * (C.cab.top + C.cab.bottom)]),
                 ax: [tfVec([cy, sy, 0]), tfVec([-sy, cy, 0]), tfVec([0, 0, 1])],
                 h: [C.cab.hx, C.cab.hy, 0.5 * (C.cab.top - C.cab.bottom)]};
    const nf = tfVec(cNorm([Math.tan(C.floor.ty * deg), -Math.tan(C.floor.tx * deg), 1]));
    const pf = tfPoint([0, 0, C.floor.h]);
    const ph = C.wall.phi * deg, ct = Math.cos(C.wall.tilt * deg), st = Math.sin(C.wall.tilt * deg);
    const nw = tfVec([Math.cos(ph) * ct, Math.sin(ph) * ct, st]);
    const pw = tfPoint([-C.wall.D * Math.cos(ph), -C.wall.D * Math.sin(ph), 0]);
    return [cab, {type: 'plane', n: nf, off: cDot(nf, pf), name: 'floor'},
            {type: 'plane', n: nw, off: cDot(nw, pw), name: 'wall'}];
  }
  const COLL = COLL_DEF;
  // boite : pose de depart dans le repere de la table, a cote de la pointe de la languette au repos
  // (mesure sur le decodeur haute resolution v5_c05 : decalee le long de sa direction principale de
  // balayage en q), 0.02 au-dessus du plateau du meuble (COLL_DEF.cab.top)
  const BOX_HALF = [0.22, 0.22, 0.29];      // 2026-10-08 : hauteur 0.755 -> 0.64 -> 0.58
  const BOX = window.MpovBox ? MpovBox.create({
    center: tfPoint([-0.134, 0.70, COLL_DEF.cab.top + BOX_HALF[2] + 0.02]), up: TF.ez,
    dir: [-0.88796, 0.04672, -0.45753], half: BOX_HALF}) : null;
  // gaussiennes fixes qui comptent pour le contact : opaques et a plus de STATIC_MARGIN de tout
  // collisionneur (ni dans le meuble, ni sous le sol, ni derriere le mur, ni sur leurs surfaces :
  // celles-la sont deja representees par les plans)
  const STATIC_MARGIN = 0.05;
  if (BOX) BOX.setColliders(buildColliders(COLL));
  // reaction de la boite sur la languette : celle des mains de xr_native_zoned.py (--kcol 10,
  // --ccol 1, porte n_eff >= 5, coherence >= 0.8), contact unilateral linearise sur l'image ;
  // frottement de la languette sur la boite (mu = BOX.P.mu[0]) en visqueux borne, implicite
  // 2026-10-08 : contact plus strict (la languette traversait) : raideur x 4 (10 -> 40), dissipation
  // x 2, porte ouverte des la premiere gaussienne (n_eff >= 1 au lieu de 5, coherence >= 0.5 au lieu
  // de 0.8 : au debut du contact peu de gaussiennes touchent et la porte fermee laissait passer), et
  // plafond de l'effort latent x BOX_FMAX pendant un contact (celui de la saisie a la souris l'arretait)
  // ctMax 10 -> 50 (2026-10-08) : frottement de la languette sur la boite trop faible
  // 2026-10-08 : raideur 40 -> 150, dissipation 2 -> 4, plafond x 20 -> x 100 -> x 300 (la languette
  // traversait le carton et n'en ressortait que lentement)
  // plus strict encore (2026-10-08) : raideur 150 -> 300 -> 800, dissipation 4 -> 6. s est une
  // CONSIGNE STRICTE de l'utilisateur : la boite ne freine jamais le bras (aucun retour sur s) ;
  // c'est s qui agit sur la languette et sur la boite
  // slop : enfoncement toleré par la projection (le ressort s'en charge) ; projMax : correction de q
  // maximale par pas
  // gapNear : ecart jusqu'auquel une paire est suivie (contact anticipe) ; sous-pas : fraction de
  // l'ecart parcourue par sous-pas, ecart plancher, minimum quand une paire est enfoncee, maximum
  // frottement plus fort (2026-10-08) : mu languette 1.2 -> 3 -> 8 (box3d.js), ctMax 50 -> 200 -> 1000,
  // vEps 0.02 -> 0.008 -> 0.003
  const BOXC = {kcol: 800, ccol: 6, nmin: 1, cmin: 0.5, h: 0.05, vEps: 0.003, ctMax: 1000, slop: 0.002, projMax: 0.5,
                gapNear: 0.05, subFrac: 0.3, subGap: 0.002, subIn: 4, subMax: 24};
  const BOX_FMAX = 300;
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

  // vitesse maximale du bras pilote a la souris : celle du mouvement enregistre (2026-10-08)
  let SD_MAX = 0;
  for (let i = 1; i < NR - 1; i++) SD_MAX = Math.max(SD_MAX, Math.abs(RSd[i]));

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

  // pas de duree h (2026-10-08 : sous-pas adaptatifs pres du contact, cf. substeps())
  function stepOnce(h) {
    if (S.replay) {
      const i = 1 + (S.k % (NR - 2));
      S.s = RS[i]; S.sd = RSd[i]; S.sdd = Math.max(-P.sdd_max, Math.min(P.sdd_max, RSdd[i]));
      S.kr = (S.kr || 0) + h / dt;
      if (S.kr > 1 - 1e-9) { S.kr -= 1; S.k += 1; }
    } else if (S.grab && S.grab.arm) {
      // bras saisi au clic (2026-10-08, comme xr_native_zoned.py) : il suit la consigne sans
      // inertie ; l'acceleration qui force la languette (G s'') est bornee a 3 fois le maximum
      // vitesse plafonnee a SD_MAX (2026-10-08)
      const sd0 = S.sd, ds = Math.max(-SD_MAX * h, Math.min(SD_MAX * h, S.target - S.s));
      S.sd = ds / h;
      S.sdd = Math.max(-3 * P.sdd_max, Math.min(3 * P.sdd_max, (S.sd - sd0) / h));
      S.s += ds;
    } else {
      const kp = 400, kd = 40;
      S.sdd = Math.max(-P.sdd_max, Math.min(P.sdd_max, kp * (S.target - S.s) - kd * S.sd));
      S.sd += h * S.sdd; S.s += h * S.sd;
    }
    // point du plan latent tenu : etat fixe, vitesse nulle ; le bras continue (S.hold)
    if (S.hold) { S.v[0] = 0; S.v[1] = 0; S.Fq = 0; S.F = [0, 0]; return; }
    // LNN : a = M^-1 (-grad V - C v + G s''), plus la barriere (en acceleration)
    const Fb = barrierForce(Array.from(S.q), Array.from(S.v));
    const aL = LN.accel(S.q, S.v, S.sdd), a = [aL[0] + Fb[0], aL[1] + Fb[1]];
    // couplages lineaires F0 - Wm v : saisie (coupling) et contact de la boite (S.cdata, comme le
    // contact de la main dans xr_native_zoned.py : unilateral, reevalue a chaque pas)
    const cp = coupling(), cd = S.cdata, F0 = [0, 0], Wm = [[0, 0], [0, 0]];
    let on = false, cOn = false;
    if (cp) {
      const w = cp.c + h * cp.k;
      for (let i = 0; i < 2; i++) { F0[i] += cp.F0[i]; for (let j = 0; j < 2; j++) Wm[i][j] += w * cp.JtJ[i][j]; }
      on = true;
    }
    if (cd) {
      const dq0 = [S.q[0] - cd.q0[0], S.q[1] - cd.q0[1]];
      for (let m = 0; m < cd.pen.length; m++) {
        const J = cd.Jn[m];
        // enfoncement linearise : la boite avance de vn t, la languette recule de Jn dq et de Jsn ds
        // (deplacement du au bras)
        const pen = cd.pen[m] + cd.vn[m] * cd.t - (J[0] * dq0[0] + J[1] * dq0[1]) - cd.Jsn[m] * (S.s - cd.s0);
        const vrel = cd.vn[m] - cd.Jsn[m] * S.sd;               // vitesse d'approche hors q'
        // une paire ne fait que POUSSER : enfoncee, et effort positif le long de la normale
        if (!(pen > 0 && cd.k * pen + cd.c * (vrel - J[0] * S.v[0] - J[1] * S.v[1]) > 0)) continue;
        const f = cd.w[m] * (cd.k * pen + cd.c * vrel), ww = cd.w[m] * (cd.c + h * cd.k);
        for (let i = 0; i < 2; i++) { F0[i] += f * J[i]; for (let j = 0; j < 2; j++) Wm[i][j] += ww * J[i] * J[j]; }
        // frottement : ct Jt' (v_boite,t - Ts s' - Jt q'), implicite en q' (Ts s' : glissement du
        // au bras)
        const t = cd.Jt[m], wc = cd.w[m] * cd.ct[m], ts = cd.Ts[m];
        const vb = [0, 1, 2].map(a => cd.vbt[m][a] - ts[a] * S.sd);
        const Jtv = [t[0] * vb[0] + t[1] * vb[1] + t[2] * vb[2], t[3] * vb[0] + t[4] * vb[1] + t[5] * vb[2]];
        const T00 = t[0] * t[0] + t[1] * t[1] + t[2] * t[2], T01 = t[0] * t[3] + t[1] * t[4] + t[2] * t[5];
        const T11 = t[3] * t[3] + t[4] * t[4] + t[5] * t[5];
        F0[0] += wc * Jtv[0]; F0[1] += wc * Jtv[1];
        Wm[0][0] += wc * T00; Wm[0][1] += wc * T01; Wm[1][0] += wc * T01; Wm[1][1] += wc * T11;
        on = true; cOn = true;
      }
      cd.t += h;
    }
    if (!on) { S.Fq = 0; S.F = [0, 0]; for (let i = 0; i < dq; i++) S.v[i] += h * a[i]; }
    else {
      // implicite avec la masse du LNN : (M + h Wm) v1 = M (v + h a) + h F0
      const A = [[0, 0], [0, 0]], r = [0, 0], Mm = LN.M;
      for (let i = 0; i < 2; i++) {
        r[i] = h * F0[i];
        for (let j = 0; j < 2; j++) {
          r[i] += Mm[i][j] * (S.v[j] + h * a[j]);
          A[i][j] = Mm[i][j] + h * Wm[i][j];
        }
      }
      const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
      const v1 = [(A[1][1] * r[0] - A[0][1] * r[1]) / det, (-A[1][0] * r[0] + A[0][0] * r[1]) / det];
      const F = [0, 1].map(i => F0[i] - (Wm[i][0] * v1[0] + Wm[i][1] * v1[1]));
      const nF = Math.hypot(F[0], F[1]);
      const FMAX = fmaxOf(S.grab ? S.grab.view : v3) * (cOn ? BOX_FMAX : 1);
      S.Fq = Math.min(nF, FMAX);
      // effort latent effectivement applique (borne comprise) : fleche du plan latent
      S.F = nF <= FMAX ? F : F.map(x => x * FMAX / nF);
      if (nF <= FMAX) { S.v[0] = v1[0]; S.v[1] = v1[1]; }
      else {
        const Fc = F.map(x => x * FMAX / nF), aF = [0, 1].map(i => LN.Minv[i][0] * Fc[0] + LN.Minv[i][1] * Fc[1]);
        for (let i = 0; i < 2; i++) S.v[i] += h * (a[i] + aF[i]);
      }
    }
    for (let i = 0; i < dq; i++) S.q[i] += h * S.v[i];
    boxProject(h);
    wallProject();
  }

  // sous-pas adaptatifs (2026-10-08) : pour chaque paire de contact (S.cdata, paires proches
  // comprises), vitesse d'enfoncement a = vn - Jn q' - Jsn s' et ecart g = -pen (linearises) ;
  // n = max ceil(a dt / (BOXC.subFrac max(g, BOXC.subGap))), borne a BOXC.subMax ; paire deja
  // enfoncee : au moins BOXC.subIn sous-pas
  function substeps() {
    const cd = S.cdata;
    if (!cd) return 1;
    const dq0 = [S.q[0] - cd.q0[0], S.q[1] - cd.q0[1]];
    let n = 1;
    for (let m = 0; m < cd.pen.length; m++) {
      const J = cd.Jn[m];
      const pen = cd.pen[m] + cd.vn[m] * cd.t - (J[0] * dq0[0] + J[1] * dq0[1]) - cd.Jsn[m] * (S.s - cd.s0);
      const a = cd.vn[m] - J[0] * S.v[0] - J[1] * S.v[1] - cd.Jsn[m] * S.sd;
      if (pen > 0) n = Math.max(n, BOXC.subIn);
      if (a > 0) n = Math.max(n, Math.ceil(a * dt / (BOXC.subFrac * Math.max(-pen, BOXC.subGap))));
    }
    return Math.min(n, BOXC.subMax);
  }

  // projection de la languette hors de la boite (2026-10-08) : apres le pas, enfoncement linearise
  // des paires de contact pen_m = pen0 + vn t - Jn (q - q0) - Jsn (s - s0) ; dq minimise
  // sum w (pen_m - Jn_m dq)^2 sur les paires enfoncees (+ eps |dq|^2), applique d'un coup, et la
  // composante de la vitesse qui rentrait dans la boite est retiree. Sans elle la languette ne
  // sortait que par l'effort du ressort de contact : relachement lent et visible.
  function boxProject(h) {
    const cd = S.cdata;
    if (!cd) return;
    const dq0 = [S.q[0] - cd.q0[0], S.q[1] - cd.q0[1]];
    let A00 = 0, A01 = 0, A11 = 0, b0 = 0, b1 = 0;
    for (let m = 0; m < cd.pen.length; m++) {
      const J = cd.Jn[m];
      const pen = cd.pen[m] + cd.vn[m] * cd.t - (J[0] * dq0[0] + J[1] * dq0[1]) - cd.Jsn[m] * (S.s - cd.s0) - BOXC.slop;
      if (pen <= 0) continue;
      const w = cd.w[m];
      A00 += w * J[0] * J[0]; A01 += w * J[0] * J[1]; A11 += w * J[1] * J[1];
      b0 += w * J[0] * pen; b1 += w * J[1] * pen;
    }
    if (A00 + A11 > 0) {
      const eps = 1e-3 * (A00 + A11), a = A00 + eps, d = A11 + eps, det = a * d - A01 * A01;
      if (det > 0) {
        let x = [(d * b0 - A01 * b1) / det, (a * b1 - A01 * b0) / det];
        const nx = Math.hypot(x[0], x[1]), cap = BOXC.projMax;
        if (nx > cap) x = [x[0] * cap / nx, x[1] * cap / nx];
        S.q[0] += x[0]; S.q[1] += x[1];
        const nn = Math.hypot(x[0], x[1]);
        if (nn > 1e-12) {
          const u = [x[0] / nn, x[1] / nn], vu = S.v[0] * u[0] + S.v[1] * u[1];
          if (vu < 0) { S.v[0] -= vu * u[0]; S.v[1] -= vu * u[1]; }
        }
      }
    }
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
      if (v === v3 && BOX && BOX.on) {
        const ry = camRay(v.cam, p), tb = BOX.rayHit(ry.o, ry.d);
        let front = false;
        if (tb > 0 && sel) for (const g of sel.idx)
          if (g < v.M.NM && v.M.alpha[g] > 0.3 && v.M.project(v.cam, [v.M.xyz[3 * g], v.M.xyz[3 * g + 1], v.M.xyz[3 * g + 2]])[2] < tb) { front = true; break; }
        if (tb > 0 && !front) {
          BOX.startGrab([0, 1, 2].map(k => ry.o[k] + tb * ry.d[k]));
          S.grab = {view: v, box: true, d0: tb, pt: p};
          c.setPointerCapture(e.pointerId); c.classList.add('grabbing');
          if (!S.running) setRunning(true);
          return;
        }
      }
      if (!sel) return;
      // languette (zone q) sous le curseur : effort J^T f ; sinon bras (zone s) : il suit le curseur
      // (2026-10-08, comme le pincement de xr_native_zoned.py)
      let nq = 0;
      if (v.armJac) for (const g of sel.idx) if (g < v.M.meta.n_q && v.M.alpha[g] > 0.3) nq++;
      const arm = v.armJac && nq < 3 ? v.armJac(z, sel) : null;
      if (arm) {
        // jacobien d(point)/ds FIGE a la saisie (2026-10-08) : recalcule a chaque image, il suivait
        // un point qui bouge avec le bras et faisait osciller la saisie en certains endroits
        S.grab = {view: v, arm: true, sel: {idx: arm.idx, w: arm.w}, pt: p, pt0: arm.pt, dp: arm.dp,
                  s0: S.s, off: [p[0] - arm.pt[0], p[1] - arm.pt[1]]};
        if (S.replay) { S.replay = false; $('mpReplay').classList.remove('on'); S.target = S.s; S.sd = 0; }
      } else {
        const j = v.jac(z, sel);
        S.grab = Object.assign({view: v, sel, qref: [S.q[0], S.q[1]]}, j);
      }
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
      if (S.grab && S.grab.view === v) {
        if (S.grab.arm) { S.target = S.s; S.sd = 0; S.sdd = 0; }
        if (S.grab.box) BOX.release();
        S.grab = null; S.cursor = null;
      }
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
      if (!v.byQ[q]) {
        const M = Zoned3D.load(pack), R = Zoned3D.renderer(v.canvas, M);
        if (BOX && BOX.img) R.setBoxTexture(BOX.img);
        v.byQ[q] = {M, R};
      }
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
               // couleur : correction apprise de l'iphone3 pour la haute resolution (la vue de depart
               // EST une pose de l'iphone3 ; rapport G/B 1.035 comme l'image reelle, contre 1.076,
               // trop vert, avec celle de l'iphone1), celle de l'iphone1 pour la basse (2026-10-07)
               W: side, H: side, color: (q === 'high' && cams.iphone3 && cams.iphone3.color) || cams.iphone1.color};
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
        // 2026-10-07 : deux crans de molette au lieu d'un
        const k1 = Math.exp(-200 * 0.0015) * FOCAL;
        for (let j = 0; j < 3; j++) pos[j] = p[j] + (pos[j] - p[j]) * k1;
        [x, y, z].forEach((a, i) => { for (let j = 0; j < 3; j++) E[i][j] = a[j]; E[i][3] = -dot3(a, pos); });
      }
      v.ready = true;
    };
    v.draw = z => {
      const z3 = [z[2], z[0], z[1]];
      if (!v.lastZ || z3.some((x, i) => x !== v.lastZ[i])) { v.M.update(z3); v.R.refresh(); v.lastZ = z3; }
      v.R.draw(v.cam, null, BOX && BOX.on ? BOX.renderInfo(v.cam.E) : null);
    };
    v.select = (x, y) => v.M.select(v.cam, x, y, v.radius, false);
    v.jac = (z, sel) => v.M.jacobian([z[2], z[0], z[1]], v.cam, sel);
    // v.M n'existe qu'apres le chargement du decodeur : test a l'appel
    v.armJac = (z, sel) => v.M && v.M.armJacobian
      ? v.M.armJacobian([z[2], z[0], z[1]], v.cam, sel, 0.005 * (P.s_hi - P.s_lo)) : null;
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
    const X = {visible: false, drag: false, hover: null, cloud: true};
    // vue FIXE centree sur le domaine des donnees (cote = 1.35 x leur plus grande etendue) ; la
    // limite de la coque (EXT x R) n'est pas montree
    function view() {
      const h = 0.5 * 1.35 * Math.max(P.q_hi[0] - P.q_lo[0], P.q_hi[1] - P.q_lo[1]);
      const m = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1])];
      return [[m[0] - h, m[1] - h], [m[0] + h, m[1] + h]];
    }
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
      // cadre carre (marge 7 % du cote) ; echelle EGALE sur q0 et q1 ; vue zoomable (view)
      const side = Math.min(w, h), pad = 0.07 * side, inner = side - 2 * pad;
      const ox = (w - side) / 2 + pad, oy = (h - side) / 2 + pad;
      const [vlo, vhi] = view();
      const span = vhi[0] - vlo[0], sc = inner / span;
      const cx = ox + inner / 2, cy = oy + inner / 2;
      const mx = 0.5 * (vlo[0] + vhi[0]), my = 0.5 * (vlo[1] + vhi[1]);
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
      if (X.cloud)            // bouton « images enregistrées » (exCloud) : nuage affiche ou masque
        for (const c of P.cloud) { g.beginPath(); g.arc(geo.px(c[2]), geo.py(c[1]), 2, 0, 6.284); g.fill(); }
      if (SHELL.SH) {
        for (const [f, dash] of [[1, [5, 4]]]) {              // domaine des donnees seulement
          g.setLineDash(dash); g.beginPath();
          shellCurve(f).forEach((p, i) => i ? g.lineTo(geo.px(p[0]), geo.py(p[1])) : g.moveTo(geo.px(p[0]), geo.py(p[1])));
          g.strokeStyle = LABEL; g.lineWidth = 1.2; g.stroke();
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
      const [vlo, vhi] = view();
      return [Math.max(vlo[0], Math.min(vhi[0], geo.qx(x))), Math.max(vlo[1], Math.min(vhi[1], geo.qy(y)))];
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
    $('exCloud').addEventListener('pointerdown', e => e.stopPropagation());
    $('exCloud').onclick = () => { X.cloud = !X.cloud; $('exCloud').classList.toggle('on', X.cloud); geo = null; };
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
  // rayon camera du pixel px : origine (centre optique) et direction monde de composante z camera 1
  function camRay(cam, px) {
    const E = cam.E, K = cam.K;
    const dc = [(px[0] - K[0][2]) / K[0][0], (px[1] - K[1][2]) / K[1][1], 1];
    const o = [0, 1, 2].map(j => -(E[0][j] * E[0][3] + E[1][j] * E[1][3] + E[2][j] * E[2][3]));
    const d = [0, 1, 2].map(j => E[0][j] * dc[0] + E[1][j] * dc[1] + E[2][j] * dc[2]);
    return {o, d};
  }
  // saisie de la boite : consigne = point du rayon du curseur a la profondeur camera de la saisie
  function boxFollow() {
    const g = S.grab, v = g.view;
    if (!S.cursor) return;
    const ry = camRay(v.cam, S.cursor);
    BOX.target = [0, 1, 2].map(k => ry.o[k] + g.d0 * ry.d[k]);
    g.pt = v.M.project(v.cam, BOX.grabPoint());
  }
  // une fois par image : gaussiennes mobiles (languette, bras) proches de la boite, puis contact
  // linearise de la boite sur la languette (J = dmu/dq par differences centrees)
  function boxPrepare(el) {
    S.cdata = null;
    if (!BOX || !BOX.on || !v3.ready) { if (BOX) { BOX.setGaussians(null); BOX.prev = null; } return; }
    const M = v3.M, NQ = M.meta.n_q, NM = M.NM, N = M.N, X = M.xyz, al = M.alpha, lg = M.logs;
    // centres des mobiles : ceux du MODELE pour la languette (sans le deplacement local de contact,
    // qui n'est qu'un rendu : la dynamique et la boite voient la languette du modele)
    const Xmov = X.slice(0, 3 * NM);
    Xmov.set(M.xyzM);
    // gaussiennes opaques a portee de la boite : languette (0), bras (1), et fixes hors des
    // collisionneurs (2, liste recalculee quand le decodeur ou les collisionneurs changent)
    const R = BOX.radius + 0.1 + 0.1 * Math.hypot(BOX.v[0], BOX.v[1], BOX.v[2]), R2 = R * R;
    const prev = BOX.prev && BOX.prev.M === M ? BOX.prev.X : null;
    const pts = [], rad = [], w = [], kind = [], gid = [], vel = [];
    const am = BOX.P.alphaMin, rMax = BOX.P.rMax, ek = BOX.P.ellK;
    if (!BOX.stat || BOX.stat.M !== M || BOX.stat.coll !== BOX.colliders) {
      const ids = [];
      for (let g = NM; g < N; g++) {
        if (al[g] < am) continue;
        const Xg = [X[3 * g], X[3 * g + 1], X[3 * g + 2]];
        let far = true;
        for (const C of BOX.colliders) {
          let d;
          if (C.type === 'plane') d = dot3(C.n, Xg) - C.off;
          else {
            const r = sub3(Xg, C.c), qd = [0, 1, 2].map(k => Math.abs(dot3(r, C.ax[k])) - C.h[k]);
            const mx = Math.max(...qd);
            d = mx > 0 ? Math.hypot(...qd.map(v => Math.max(v, 0))) : mx;
          }
          if (d < STATIC_MARGIN) { far = false; break; }
        }
        if (far) ids.push(g);
      }
      BOX.stat = {M, coll: BOX.colliders, ids: Int32Array.from(ids)};
    }
    for (const g of BOX.stat.ids) {
      const x = X[3 * g], y = X[3 * g + 1], z = X[3 * g + 2];
      const dx = x - BOX.x[0], dy = y - BOX.x[1], dz = z - BOX.x[2];
      if (dx * dx + dy * dy + dz * dz > R2) continue;
      pts.push(x, y, z);
      rad.push(Math.min(rMax, ek * Math.exp(Math.min(lg[3 * g], lg[3 * g + 1], lg[3 * g + 2]))));
      w.push(al[g]); kind.push(2); gid.push(g); vel.push(0, 0, 0);
    }
    for (let g = 0; g < NM; g++) {
      if (al[g] < am) continue;
      const x = Xmov[3 * g], y = Xmov[3 * g + 1], z = Xmov[3 * g + 2];
      const dx = x - BOX.x[0], dy = y - BOX.x[1], dz = z - BOX.x[2];
      if (dx * dx + dy * dy + dz * dz > R2) continue;
      pts.push(x, y, z);
      rad.push(Math.min(rMax, ek * Math.exp(Math.min(lg[3 * g], lg[3 * g + 1], lg[3 * g + 2]))));
      w.push(al[g]); kind.push(g < NQ ? 0 : 1); gid.push(g);
      // vitesse des mobiles : difference des centres entre deux images
      if (g < NM && prev && el > 0) vel.push((x - prev[3 * g]) / el, (y - prev[3 * g + 1]) / el, (z - prev[3 * g + 2]) / el);
      else vel.push(0, 0, 0);
    }
    BOX.prev = {M, X: Xmov};
    BOX.setGaussians({pts: Float64Array.from(pts), rad, w, kind, vel: Float64Array.from(vel)});
    // reaction sur la languette
    const cs = BOX.contacts(BOXC.gapNear).filter(c => kind[c.i] === 0);
    if (!cs.length) return;
    const ids = Int32Array.from(cs, c => gid[c.i]), z = [S.s, S.q[0], S.q[1]], h = BOXC.h;
    const Xd = [];
    for (let k = 0; k < 2; k++) {
      const zp = z.slice(), zm = z.slice();
      zp[1 + k] += h; zm[1 + k] -= h;
      Xd.push([M.qPositions(zp, ids), M.qPositions(zm, ids)]);
    }
    // d mu / ds : la languette suit aussi le bras (porteur, champ q evalue a s*) ; sans ce terme le
    // glissement du au bras (recul du bras, languette posee sur la boite) echappait au frottement
    const hs = 0.005 * (P.s_hi - P.s_lo), zsp = z.slice(), zsm = z.slice();
    zsp[0] += hs; zsm[0] -= hs;
    const Xsp = M.qPositions(zsp, ids), Xsm = M.qPositions(zsm, ids);
    const n = cs.length, Jn = [], Jt = [], vbt = [], pen = [], vn = [], ww = [], mean = [0, 0, 0, 0, 0, 0];
    const Jsn = [], Ts = [];
    let sw = 0, den = 0, s2 = 0, G00 = 0, G01 = 0, G11 = 0;
    for (let m = 0; m < n; m++) sw += al[ids[m]];
    for (let m = 0; m < n; m++) {
      const c = cs[m], nn = c.n, wm = al[ids[m]] / sw, Ji = [];
      // Ji = [dX/dq0 (3), dX/dq1 (3)] ; Jn = n' J ; Jt = (I - n n') J ; vbt = (I - n n') v_boite
      for (let k = 0; k < 2; k++)
        for (let a = 0; a < 3; a++) Ji.push((Xd[k][0][3 * m + a] - Xd[k][1][3 * m + a]) / (2 * h));
      const j0 = nn[0] * Ji[0] + nn[1] * Ji[1] + nn[2] * Ji[2];
      const j1 = nn[0] * Ji[3] + nn[1] * Ji[4] + nn[2] * Ji[5];
      const t = [];
      for (let a = 0; a < 3; a++) t.push(Ji[a] - j0 * nn[a]);
      for (let a = 0; a < 3; a++) t.push(Ji[3 + a] - j1 * nn[a]);
      const vb = c.vb, vbn = vb[0] * nn[0] + vb[1] * nn[1] + vb[2] * nn[2];
      const js = [0, 1, 2].map(a => (Xsp[3 * m + a] - Xsm[3 * m + a]) / (2 * hs));
      const jsn = js[0] * nn[0] + js[1] * nn[1] + js[2] * nn[2];
      Jsn.push(jsn); Ts.push([js[0] - jsn * nn[0], js[1] - jsn * nn[1], js[2] - jsn * nn[2]]);
      Jn.push([j0, j1]); Jt.push(t); vbt.push([vb[0] - vbn * nn[0], vb[1] - vbn * nn[1], vb[2] - vbn * nn[2]]);
      pen.push(c.pen); vn.push(c.vn); ww.push(wm);
      G00 += wm * j0 * j0; G01 += wm * j0 * j1; G11 += wm * j1 * j1;
      let nr = 0;
      for (let a = 0; a < 6; a++) { mean[a] += wm * Ji[a]; nr += Ji[a] * Ji[a]; }
      den += wm * Math.sqrt(nr); s2 += wm * wm;
    }
    const lam = 0.5 * (G00 + G11) + Math.sqrt(0.25 * (G00 - G11) ** 2 + G01 * G01);
    const neff = 1 / s2, coh = Math.hypot(...mean) / Math.max(den, 1e-12);
    const cl = x => Math.min(1, Math.max(0, x));
    const gc = cl((neff - 0.5 * BOXC.nmin) / (0.5 * BOXC.nmin)) * cl((coh - (BOXC.cmin - 0.1)) / 0.1);
    // porte fermee : ni ressort ni frottement (k = c = 0), mais la projection (boxProject) agit
    if (!(lam > 1e-12)) return;
    const k = gc * BOXC.kcol * KREF / lam, c = gc * BOXC.ccol * 2 * Math.sqrt(KREF) / lam;
    // frottement : visqueux ct (vitesse relative tangentielle) borne par mu x effort normal, evalue
    // en debut d'image : ct = min(ctMax c, mu k pen / max(|v_t|, vEps))
    // effort normal pour la borne de Coulomb (2026-10-08) : la projection (boxProject) garde
    // l'enfoncement sous slop, le ressort k pen ne porte presque plus rien et le frottement s'effondrait.
    // On prend aussi la CHARGE de la languette sur la boite : effort generalise libre F = M a (LNN :
    // elasticite, gravite apprise, forcage du bras s''), ramene a un effort normal au monde par paire,
    // fn = max(0, -Jn . F / |Jn|^2) (moindres carres) ; fn = max(k pen, fn)
    const aL = LN.accel(S.q, S.v, S.sdd), Mm = LN.M;
    const Ff = [Mm[0][0] * aL[0] + Mm[0][1] * aL[1], Mm[1][0] * aL[0] + Mm[1][1] * aL[1]];
    const mu = BOX.P.mu[0], ct = [];
    for (let m = 0; m < n; m++) {
      const t = Jt[m], vt = [0, 1, 2].map(a => vbt[m][a] - t[a] * S.v[0] - t[3 + a] * S.v[1] - Ts[m][a] * S.sd);
      const J = Jn[m], j2 = J[0] * J[0] + J[1] * J[1];
      const load = j2 > 1e-12 ? Math.max(0, -(J[0] * Ff[0] + J[1] * Ff[1]) / j2) : 0;
      const fn = pen[m] > -BOXC.slop ? Math.max(k * Math.max(pen[m], 0), load) : 0;
      ct.push(Math.min(BOXC.ctMax * c, mu * fn / Math.max(Math.hypot(vt[0], vt[1], vt[2]), BOXC.vEps)));
    }
    S.cdata = {Jn, Jt, vbt, ct, pen, vn, Jsn, Ts, w: ww, k, c, q0: [S.q[0], S.q[1]], s0: S.s, t: 0};
  }


  // ── DEPLACEMENT LOCAL DE CONTACT (2026-10-08) : la languette n'a que 2 degres de liberte (q) ; elle
  // ne peut ni adherer localement au carton ni s'y arreter exactement. Un deplacement par gaussienne
  // de zone q, ajoute au rendu seulement (Zoned3D setLocal ; la dynamique, la boite et l'effort J^T f
  // voient la languette du modele) :
  //   - ADHERENCE : une gaussienne qui touche le carton (ecart < stickGap) y est ancree (point fixe
  //     dans le repere de la boite) ; son deplacement la garde sur l'ancrage tant que le modele ne s'en
  //     ecarte pas de plus de releaseGap le long de la normale ; au-dela de slipMax en tangentiel elle
  //     glisse (l'ancrage suit) ;
  //   - NON PENETRATION : une gaussienne non ancree dans le carton est ramenee a sa surface ;
  //   - continuite : deplacements des sources diffuses aux voisines par un noyau gaussien (sigma),
  //     suivi temporel (tau), puis non-penetration stricte des centres affiches.
  // sigma 0.025 -> 0.08 -> 0.15 -> 0.25 -> 0.12 -> 0.09 (2026-10-08) ; adherence renforcee (stickGap 0.008,
  // releaseGap 0.03) et DIRECTIONNELLE, comme un poil de brosse : u = direction racine -> point de la
  // languette dans le plan tangent ; le modele s'ecarte de l'ancrage de e (tangentiel) ; e . u > 0 (le
  // bras pousse vers la pointe) : adherence jusqu'a slipFwd ; e . u < 0 (le bras recule) : glissement
  // au-dela de slipBack ; transversal : glissement au-dela de slipSide
  const LOC = {stickGap: 0.008, releaseGap: 0.03, slipFwd: 0.3, slipBack: 0.005, slipSide: 0.03, sigma: 0.09, kappa: 3, tau: 0.04, rad: 0.004};
  const LOCS = {anch: new Map(), u: null, M: null};
  function localContact(el) {
    const M = v3.M, NQ = M.meta.n_q, X = M.xyzM;
    if (!LOCS.u || LOCS.M !== M) { LOCS.u = new Float32Array(3 * NQ); LOCS.anch = new Map(); LOCS.M = M; }
    const u = LOCS.u, an = LOCS.anch, a = 1 - Math.exp(-el / LOC.tau);
    if (!BOX || !BOX.on) {
      an.clear();
      let mx = 0;
      for (let i = 0; i < 3 * NQ; i++) { u[i] *= 1 - a; mx = Math.max(mx, Math.abs(u[i])); }
      M.setLocal(mx > 1e-5 ? u : null);
      return;
    }
    const Rb = BOX.R, c0 = BOX.x;
    const toL = P => [0, 1, 2].map(j => Rb[j] * (P[0] - c0[0]) + Rb[3 + j] * (P[1] - c0[1]) + Rb[6 + j] * (P[2] - c0[2]));
    const toW = L => [0, 1, 2].map(i => c0[i] + Rb[3 * i] * L[0] + Rb[3 * i + 1] * L[1] + Rb[3 * i + 2] * L[2]);
    const R = BOX.radius + 0.15 + 3 * LOC.sigma, cand = [], src = [];
    // racine de la languette : barycentre des 10 % de ses gaussiennes les plus hautes (verticale TF.ez)
    const hq = [];
    for (let g = 0; g < NQ; g++) hq.push(X[3 * g] * TF.ez[0] + X[3 * g + 1] * TF.ez[1] + X[3 * g + 2] * TF.ez[2]);
    const thr = hq.slice().sort((x, y) => y - x)[Math.max(0, Math.floor(0.1 * NQ) - 1)];
    const root = [0, 0, 0];
    let nr = 0;
    for (let g = 0; g < NQ; g++) if (hq[g] >= thr) { root[0] += X[3 * g]; root[1] += X[3 * g + 1]; root[2] += X[3 * g + 2]; nr++; }
    for (let k = 0; k < 3; k++) root[k] /= Math.max(nr, 1);
    for (let g = 0; g < NQ; g++) {
      const Xg = [X[3 * g], X[3 * g + 1], X[3 * g + 2]];
      if (Math.hypot(Xg[0] - c0[0], Xg[1] - c0[1], Xg[2] - c0[2]) > R) { an.delete(g); continue; }
      cand.push(g);
      const sd = BOX.sdf(Xg), pen = LOC.rad - sd.d, n = sd.n;
      let A = an.get(g);
      if (A && sd.d > LOC.rad + LOC.releaseGap) { an.delete(g); A = null; }
      else if (!A && pen > -LOC.stickGap) {
        const pp = Math.max(pen, 0);
        A = toL([Xg[0] + pp * n[0], Xg[1] + pp * n[1], Xg[2] + pp * n[2]]);
        an.set(g, A);
      }
      if (A) {
        const Aw = toW(A);
        // e : ecart du modele a l'ancrage, decompose en normal, le long de u (racine -> point, plan
        // tangent) et transversal ; borne directionnelle, l'ancrage suit au-dela
        const e = [Xg[0] - Aw[0], Xg[1] - Aw[1], Xg[2] - Aw[2]], en = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
        const et = [e[0] - en * n[0], e[1] - en * n[1], e[2] - en * n[2]];
        const r = [Xg[0] - root[0], Xg[1] - root[1], Xg[2] - root[2]], rn = r[0] * n[0] + r[1] * n[1] + r[2] * n[2];
        let uu = [r[0] - rn * n[0], r[1] - rn * n[1], r[2] - rn * n[2]];
        const lu = Math.hypot(uu[0], uu[1], uu[2]);
        uu = lu > 1e-9 ? uu.map(v => v / lu) : [0, 0, 0];
        const ea = et[0] * uu[0] + et[1] * uu[1] + et[2] * uu[2];
        const ep = [et[0] - ea * uu[0], et[1] - ea * uu[1], et[2] - ea * uu[2]], lp = Math.hypot(ep[0], ep[1], ep[2]);
        const ea2 = Math.max(-LOC.slipBack, Math.min(LOC.slipFwd, ea)), fp = lp > LOC.slipSide ? LOC.slipSide / lp : 1;
        const e2 = [0, 1, 2].map(k => en * n[k] + ea2 * uu[k] + fp * ep[k]);
        if (ea2 !== ea || fp < 1) an.set(g, toL([Xg[0] - e2[0], Xg[1] - e2[1], Xg[2] - e2[2]]));
        src.push([g, [-e2[0], -e2[1], -e2[2]]]);
      } else if (pen > 0) src.push([g, [pen * n[0], pen * n[1], pen * n[2]]]);
    }
    // cible : diffusion des sources aux voisines, noyau gaussien (support 4 sigma). Raccordement
    // PROGRESSIF (2026-10-08) : moyenne ponderee des deplacements des sources, multipliee par un
    // facteur qui monte doucement avec le poids cumule, b = smoothstep(1 - exp(-sum w / kappa)) ;
    // avant, max(sum w, 1) donnait un plateau a bord franc
    const tgt = new Float32Array(3 * NQ), s2 = 2 * LOC.sigma * LOC.sigma, r2 = 16 * LOC.sigma * LOC.sigma;
    if (src.length) for (const g of cand) {
      let sw = 0, ax = 0, ay = 0, az = 0;
      for (const [c, d] of src) {
        const dx = X[3 * g] - X[3 * c], dy = X[3 * g + 1] - X[3 * c + 1], dz = X[3 * g + 2] - X[3 * c + 2];
        const q2 = dx * dx + dy * dy + dz * dz;
        if (q2 > r2) continue;
        const w = Math.exp(-q2 / s2);
        sw += w; ax += w * d[0]; ay += w * d[1]; az += w * d[2];
      }
      if (sw > 0) {
        const b0 = 1 - Math.exp(-sw / LOC.kappa), b = b0 * b0 * (3 - 2 * b0), k = b / sw;
        tgt[3 * g] = ax * k; tgt[3 * g + 1] = ay * k; tgt[3 * g + 2] = az * k;
      }
    }
    // suivi temporel, puis non-penetration stricte des centres affiches
    let mx = 0;
    for (let i = 0; i < 3 * NQ; i++) u[i] += a * (tgt[i] - u[i]);
    for (const g of cand) {
      const Y = [X[3 * g] + u[3 * g], X[3 * g + 1] + u[3 * g + 1], X[3 * g + 2] + u[3 * g + 2]];
      const sd = BOX.sdf(Y), pen = LOC.rad - sd.d;
      if (pen > 0) for (let k = 0; k < 3; k++) u[3 * g + k] += pen * sd.n[k];
    }
    for (let i = 0; i < 3 * NQ; i++) mx = Math.max(mx, Math.abs(u[i]));
    M.setLocal(mx > 1e-5 ? u : null);
  }

  // saisie du bras (cf. arm_follow de xr_native_zoned.py) : s tel que le point saisi suive le
  // curseur au premier ordre, ds = (dp/ds) . (curseur - decalage - p) / |dp/ds|^2, borne a 20 %
  // de la course par image ; en pause le bras suit tout de suite (temps fige)
  function armFollow() {
    const g = S.grab;
    if (!S.cursor) return;
    // point saisi predit par le jacobien fige : p(s) = p0 + dp (s - s0)
    const ps = [g.pt0[0] + g.dp[0] * (S.s - g.s0), g.pt0[1] + g.dp[1] * (S.s - g.s0)];
    g.pt = [ps[0] + g.off[0], ps[1] + g.off[1]];
    const den = g.dp[0] * g.dp[0] + g.dp[1] * g.dp[1];
    if (!(den > 1e-12)) return;
    const R = P.s_hi - P.s_lo;
    let ds = ARM_GAIN * (g.dp[0] * (S.cursor[0] - g.pt[0]) + g.dp[1] * (S.cursor[1] - g.pt[1])) / den;
    ds = Math.max(-0.2 * R, Math.min(0.2 * R, ds));
    S.target = Math.max(P.s_lo, Math.min(P.s_hi, S.s + ds));
    if (!S.running) { S.s = S.target; S.sd = 0; S.sdd = 0; }
  }

  function loop(now) {
    const el = Math.min(0.25, (now - last) / 1000); last = now;
    fps = 0.9 * fps + 0.1 / Math.max(el, 1e-4);
    if (S.running) {
      if (BOX && BOX.grab && !(S.grab && S.grab.box)) BOX.release();
      if (S.grab && S.grab.box) boxFollow();
      else if (S.grab && S.grab.arm) armFollow();
      else if (S.grab && S.grab.view.ready) {
        const j = S.grab.view.jac(zNow(), S.grab.sel);
        Object.assign(S.grab, j, {qref: [S.q[0], S.q[1]]});
      }
      // accumulateur : a 144 ou 240 Hz une image dure moins qu'un pas physique, un arrondi
      // de el / dt y vaudrait 0 et la simulation resterait figee
      S.acc = Math.min((S.acc || 0) + el, 40 * dt);
      boxPrepare(el);
      while (S.acc >= dt) {
        const ns = substeps();
        for (let i = 0; i < ns; i++) stepOnce(dt / ns);
        if (BOX) BOX.step(dt); QT.push(); S.acc -= dt;
      }
    }
    if (!S.running && S.grab && S.grab.arm) armFollow();
    // deplacement local de contact : modele a l'etat courant, puis champ local, puis rendu
    if (v3.ready && v3.M && v3.M.setLocal && (BOX && BOX.on || v3.M.uLocalOn())) {
      v3.M.update([S.s, S.q[0], S.q[1]]);
      localContact(el);
      v3.lastZ = null;
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
  // pause : temps FIGE (ni q(t) ni s(t) n'avancent), mais le curseur deplace le bras tout de suite.
  // A la reprise, le saut de s accumule pendant la pause est applique d'un coup : avec le forcage
  // de d'Alembert M q'' = ... + G s'', p = q - M^-1 G s est continu a travers un deplacement
  // instantane du bras, donc q saute de M^-1 G (s - s_pause), vitesse inchangee (reponse a un
  // echelon) ; s(t) presente la meme discontinuite.
  function setRunning(r) {
    if (!r && S.running) S.sPause = S.s;
    if (r && !S.running && S.sPause !== undefined) {
      const ds = S.s - S.sPause;
      for (let i = 0; i < 2; i++) S.q[i] += (LN.Minv[i][0] * LN.G[0] + LN.Minv[i][1] * LN.G[1]) * ds;
      S.sd = 0; S.sdd = 0; S.sPause = undefined;
    }
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
      // en pause : le bras suit le curseur tout de suite (temps fige, pas de dynamique du bras)
      if (!S.running) { S.s = S.target; S.sd = 0; S.sdd = 0; }
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
  if (BOX && $('mpBox')) {
    if (window.MPOV_BOX_TEX) {
      const img = new Image();
      img.onload = () => { BOX.img = img; for (const r of Object.values(v3.byQ)) r.R.setBoxTexture(img); };
      img.src = window.MPOV_BOX_TEX;
    }
    // presence de la boite : remise a sa place de depart a chaque activation
    $('mpBox').onclick = () => {
      BOX.on = !BOX.on;
      if (BOX.on) BOX.reset(); else BOX.release();
      $('mpBox').classList.toggle('on', BOX.on);
      v3.lastZ = null;
    };
  }
  $('mpRest').onclick = () => { S.q[0] = LN.q_r[0]; S.q[1] = LN.q_r[1]; S.v.fill(0); };
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
          stepOnce(dt);
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
      const ck = LN.check();
      out.push('LNN JS contre PyTorch : ecart relatif max V ' + ck.eV.toExponential(1) + ', grad V '
               + ck.eG.toExponential(1) + ', acceleration ' + ck.eA.toExponential(1));
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
    const r1 = stg('qtPlot').offsetHeight / Math.max(1, stg('qtPlot').offsetWidth);
    const a = Math.round((T - 2 * g + hR - h1 - h2) / (2 + r1));
    const cols = a + 'px minmax(0,1fr)';
    if (a > 120 && grid.style.gridTemplateColumns !== cols) grid.style.gridTemplateColumns = cols;
  }
  new ResizeObserver(align).observe(grid);
  align();
})();
