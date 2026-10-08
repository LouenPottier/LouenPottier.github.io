/*
 * Boite en carton de la page xrdays.html (2026-10-08) : corps rigide dans la scene du decodeur
 * 3D par zones, rendu par lancer de rayon dans zoned3d.js (aucun maillage : une boite orientee,
 * intersectee pixel par pixel ; les gaussiennes derriere elle sont masquees).
 *
 * Unites : celles de la scene (jauge du decodeur). Le sol est a 2.19 unites sous la table
 * (couche de gaussiennes la plus dense, mesuree sur le decodeur), soit ~0.41 m par unite pour une
 * table de 0.9 m ; la gravite vaut donc 9.81 / 0.41 = 23.9 unites / s^2.
 *
 * SCENE FIXE : COLLISIONNEURS POSES A LA MAIN (setColliders) : demi-espaces (sol, mur) et paves
 * orientes (le meuble du robot). 26 points de la boite (coins, milieux d'aretes, centres de faces)
 * testes contre chacun, plus les 8 coins de chaque pave contre la boite ; ressort-amortisseur par
 * point et frottement de Coulomb regularise (mu[2]).
 *
 * GAUSSIENNES : chaque gaussienne opaque (alpha >= 0.3) est une sphere de rayon 1.5 x son plus
 * petit demi-axe (borne a rMax), a son centre de l'image courante. Trois classes, chacune avec sa
 * raideur totale K, son frottement mu et son plancher de poids : 0 languette (zone q), 1 bras
 * (zone s), 2 fixes HORS des collisionneurs (objets que les plans ne decrivent pas ; la page ecarte
 * celles qui sont dans un collisionneur ou a moins d'une marge de sa surface).
 * Enfoncement par la fonction distance signee de la boite, effort normal ressort-amortisseur le
 * long de la normale de la boite, reparti par opacite : w_i / max(sum w, W_MIN) (raideur totale
 * bornee a K quel que soit le nombre de gaussiennes touchees, donc stable). Frottement de Coulomb
 * regularise (visqueux sous le seuil) sur la vitesse relative tangentielle, vitesse des
 * gaussiennes mobiles comprise.
 *
 * Saisie en un point : ressort-amortisseur du point saisi vers la consigne, plus un
 * amortissement angulaire. Euler semi-implicite a sous-pas de ~1 ms.
 * La reaction sur la languette (effort latent J^T f, normal et tangentiel) est calculee par la
 * page (mpov_demo.js) a partir de contacts() ; le bras est pilote en position, la scene fixe ne
 * bouge pas.
 */
(function (root) {
  'use strict';
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
  // quaternion (w, x, y, z) -> matrice 3 x 3 par lignes ; colonnes = axes locaux au monde
  function qmat(q) {
    const [w, x, y, z] = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
            2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
            2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  }
  const mv = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
                        R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const mtv = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
                         R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  function matToQuat(R) {
    const t = R[0] + R[4] + R[8];
    let w, x, y, z;
    if (t > 0) { const s = 2 * Math.sqrt(t + 1); w = 0.25 * s; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s; }
    else if (R[0] > R[4] && R[0] > R[8]) { const s = 2 * Math.sqrt(1 + R[0] - R[4] - R[8]); w = (R[7] - R[5]) / s; x = 0.25 * s; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s; }
    else if (R[4] > R[8]) { const s = 2 * Math.sqrt(1 + R[4] - R[0] - R[8]); w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = 0.25 * s; z = (R[5] + R[7]) / s; }
    else { const s = 2 * Math.sqrt(1 + R[8] - R[0] - R[4]); w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = 0.25 * s; }
    const n = Math.hypot(w, x, y, z);
    return [w / n, x / n, y / n, z / n];
  }

  /*
   * o : {center (3, pose de depart), up (3, verticale de la piece, sens de la gravite oppose),
   *      dir (3, axe x local, horizontal), half [hx, hy, hz] (demi-cotes, z vertical)}
   */
  function create(o) {
    // 2026-10-08 : masse x 60 (la languette poussait la boite trop facilement, x 4, x 10, x 20 puis x 60) ;
    // raideurs du bras, des gaussiennes fixes, des collisionneurs, de la saisie, frottement visqueux
    // et amortissement angulaire x 60 avec elle (memes frequences, meme stabilite) ; la raideur de
    // la languette sur la boite reste 600 (et kDeep) : son effet est divise par 60
    const P = Object.assign({mass: 60.0, g: 23.9,
                             K: [600, 180000, 1200000],        // languette, bras, gaussiennes fixes
                             wMin: [5, 5, 30], mu: [8.0, 0.5, 1.2], cFric: 3600,   // carton / table et decor 0.5 -> 1.2 ; languette 1.2 -> 3 -> 8
                             zContact: 0.7,
                             kPt: 240000, zPt: 0.7,           // collisionneurs : par point de contact
                             kGrab: 24000, zGrab: 1.0, cAng: 90, drag: 0.3, substep: 1 / 960,
                             ellK: 1.5, rMax: 0.03, alphaMin: 0.3,
                             // aretes et coins arrondis (rayon), meme forme au rendu (zoned3d.js) ;
                             // marge de contact de la languette (contact actif avant la surface)
                             round: 0.012, skin: [0.008, 0, 0],
                             // enfoncement PROFOND (au-dela de penDeep) : raideur supplementaire kDeep par
                             // classe. La deformation q de la languette est bornee au domaine des donnees :
                             // poussee plus loin elle ne cede plus, seule la boite peut alors se degager
                             penDeep: 0.005, kDeep: [150000, 0, 0]}, o);
    const up = norm(P.up), h = P.half;
    const B = {P, up, half: h, on: false, target: null, grab: null, gauss: {}};
    const m = P.mass;
    const Ib = [m / 3 * (h[1] * h[1] + h[2] * h[2]), m / 3 * (h[0] * h[0] + h[2] * h[2]),
                m / 3 * (h[0] * h[0] + h[1] * h[1])];
    function reset() {
      const ex = norm(P.dir), ey = norm(cross(up, ex));
      const ez = cross(ex, ey);
      B.x = P.center.slice();
      B.q = matToQuat([ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]]);
      B.v = [0, 0, 0]; B.w = [0, 0, 0];
      B.R = qmat(B.q);
    }
    reset();
    B.reset = reset;

    // distance signee d'un point monde a la boite ARRONDIE (rayon P.round) et normale sortante (monde)
    const rr = Math.min(P.round, h[0], h[1], h[2]), hc = [h[0] - rr, h[1] - rr, h[2] - rr];
    function sdf(X) {
      const p = mtv(B.R, [X[0] - B.x[0], X[1] - B.x[1], X[2] - B.x[2]]);
      const qd = [Math.abs(p[0]) - hc[0], Math.abs(p[1]) - hc[1], Math.abs(p[2]) - hc[2]];
      const mx = Math.max(qd[0], qd[1], qd[2]);
      let d, nl;
      if (mx > 0) {
        const o2 = qd.map(v => Math.max(v, 0)), l = Math.hypot(o2[0], o2[1], o2[2]);
        d = l - rr;
        nl = [Math.sign(p[0]) * o2[0] / l, Math.sign(p[1]) * o2[1] / l, Math.sign(p[2]) * o2[2] / l];
      } else {
        // dedans du noyau : face la plus proche
        const k = qd[0] === mx ? 0 : (qd[1] === mx ? 1 : 2);
        d = mx - rr; nl = [0, 0, 0]; nl[k] = p[k] >= 0 ? 1 : -1;
      }
      return {d, n: mv(B.R, nl)};
    }
    B.sdf = sdf;
    // rayon de la boite qui englobe ses coins
    B.radius = Math.hypot(h[0], h[1], h[2]);

    // gaussiennes candidates de l'image : pts (3 n), rad (n), w (n, opacites), kind (n : 0
    // languette, 1 bras, 2 scene fixe), vel (3 n, vitesses), fixes pendant l'image
    B.setGaussians = G => { B.gauss = G || {}; };

    // collisionneurs de la scene fixe : {type: 'plane', n (unitaire, vers le cote libre), off
    // (n . X sur le plan)} ou {type: 'obb', c, ax (3 axes unitaires), h (demi-cotes)}
    B.colliders = [];
    B.setColliders = L => { B.colliders = L || []; };
    // points de contact de la boite (repere local) : 8 coins, 12 milieux d'aretes, 6 centres de faces
    const SAMPLES = [];
    for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const c of [-1, 0, 1]) {
      const nz = (a !== 0) + (b !== 0) + (c !== 0);
      if (nz < 1) continue;
      // point ramene sur la surface arrondie : noyau + rayon le long de la direction sortante
      const p = [a * h[0], b * h[1], c * h[2]], cc = p.map((v, k) => Math.sign(v) * Math.min(Math.abs(v), hc[k]));
      const dd = norm([p[0] - cc[0], p[1] - cc[1], p[2] - cc[2]]);
      SAMPLES.push([cc[0] + rr * dd[0], cc[1] + rr * dd[1], cc[2] + rr * dd[2]]);
    }
    // enfoncement d'un point monde dans un collisionneur : {pen, n (normale vers le cote libre)}
    function collide(X, C) {
      if (C.type === 'plane') {
        const d = dot(C.n, X) - C.off;
        return d < 0 ? {pen: -d, n: C.n} : null;
      }
      const r = [X[0] - C.c[0], X[1] - C.c[1], X[2] - C.c[2]];
      let best = null;
      for (let k = 0; k < 3; k++) {
        const pk = dot(r, C.ax[k]), pen = C.h[k] - Math.abs(pk);
        if (pen <= 0) return null;
        if (!best || pen < best.pen) best = {pen, n: C.ax[k].map(v => (pk >= 0 ? v : -v))};
      }
      return best;
    }

    const pointVel = X => { const r = [X[0] - B.x[0], X[1] - B.x[1], X[2] - B.x[2]], wr = cross(B.w, r);
                           return [B.v[0] + wr[0], B.v[1] + wr[1], B.v[2] + wr[2]]; };

    // contacts courants (pour la reaction sur la languette) : indice, normale (de la boite vers la
    // gaussienne), enfoncement (negatif : ecart, avec gapMax), vitesse de la surface de la boite au
    // point (vecteur) et normale
    B.contacts = (gapMax = 0) => {
      const G = B.gauss, out = [];
      if (!B.on || !G.pts) return out;
      for (let i = 0; i < G.rad.length; i++) {
        const X = [G.pts[3 * i], G.pts[3 * i + 1], G.pts[3 * i + 2]];
        const s = sdf(X), pen = G.rad[i] + P.skin[G.kind[i]] - s.d;
        // gapMax > 0 : paires PROCHES aussi (pen negatif = ecart), contacts anticipes de la page
        if (pen <= -gapMax) continue;
        const vb = pointVel(X);
        out.push({i, n: s.n, pen, vb, vn: dot(vb, s.n)});
      }
      return out;
    };

    function addForce(F, T, f, X) {
      F[0] += f[0]; F[1] += f[1]; F[2] += f[2];
      const r = [X[0] - B.x[0], X[1] - B.x[1], X[2] - B.x[2]], t = cross(r, f);
      T[0] += t[0]; T[1] += t[1]; T[2] += t[2];
    }

    function substep(dt) {
      const F = [-m * P.g * up[0], -m * P.g * up[1], -m * P.g * up[2]], T = [0, 0, 0];
      // scene fixe : points de la boite dans les collisionneurs, coins des paves dans la boite
      const cp = 2 * P.zPt * Math.sqrt(P.kPt * m / 9);
      const pointForce = (X, nn, pen, sgn) => {
        // nn : direction de l'effort sur la boite ; vitesse de la boite au point, le long de nn
        const vp = pointVel(X), vn = dot(vp, nn);
        const f = Math.max(0, P.kPt * pen - cp * vn);
        if (f <= 0) return;
        const vt = [vp[0] - vn * nn[0], vp[1] - vn * nn[1], vp[2] - vn * nn[2]];
        const nt = Math.hypot(vt[0], vt[1], vt[2]);
        const ft = nt > 1e-9 ? Math.min(P.mu[2] * f, P.cFric / 9 * nt) / nt : 0;
        addForce(F, T, [f * nn[0] - ft * vt[0], f * nn[1] - ft * vt[1], f * nn[2] - ft * vt[2]], X);
      };
      for (const C of B.colliders) {
        for (const pl of SAMPLES) {
          const r = mv(B.R, pl), X = [B.x[0] + r[0], B.x[1] + r[1], B.x[2] + r[2]];
          const c = collide(X, C);
          if (c) pointForce(X, c.n, c.pen);
        }
        if (C.type === 'obb') for (let k = 0; k < 8; k++) {
          const sg = [k & 1 ? 1 : -1, k & 2 ? 1 : -1, k & 4 ? 1 : -1];
          const X = [0, 1, 2].map(a => C.c[a] + sg[0] * C.h[0] * C.ax[0][a] + sg[1] * C.h[1] * C.ax[1][a] + sg[2] * C.h[2] * C.ax[2][a]);
          const sd = sdf(X);
          if (sd.d < 0) pointForce(X, sd.n.map(v => -v), -sd.d);
        }
      }
      const G = B.gauss;
      if (G.pts) {
        const n = G.rad.length, act = [], sw = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          const X = [G.pts[3 * i], G.pts[3 * i + 1], G.pts[3 * i + 2]], s = sdf(X), pen = G.rad[i] + P.skin[G.kind[i]] - s.d;
          if (pen > 0) { act.push([i, X, s.n, pen]); sw[G.kind[i]] += G.w[i]; }
        }
        for (const [i, X, nn, pen] of act) {
          const k = G.kind[i], K = P.K[k], C = 2 * P.zContact * Math.sqrt(K * m);
          const wi = G.w[i] / Math.max(sw[k], P.wMin[k]);
          // vitesse relative boite - gaussienne au point ; > 0 le long de n : la boite avance
          const vb = pointVel(X), vr = [vb[0] - G.vel[3 * i], vb[1] - G.vel[3 * i + 1], vb[2] - G.vel[3 * i + 2]];
          const vn = dot(vr, nn);
          const f = Math.max(0, wi * (K * pen + P.kDeep[k] * Math.max(0, pen - P.penDeep) + C * vn));
          if (f <= 0) continue;
          // effort normal sur la boite : -n ; frottement oppose au glissement tangentiel
          const vt = [vr[0] - vn * nn[0], vr[1] - vn * nn[1], vr[2] - vn * nn[2]];
          const nt = Math.hypot(vt[0], vt[1], vt[2]);
          const ft = nt > 1e-9 ? Math.min(P.mu[k] * f, wi * P.cFric * nt) / nt : 0;
          addForce(F, T, [-f * nn[0] - ft * vt[0], -f * nn[1] - ft * vt[1], -f * nn[2] - ft * vt[2]], X);
        }
      }
      // saisie en un point
      if (B.grab && B.target) {
        const X = B.grabPoint(), vp = pointVel(X), cg = 2 * P.zGrab * Math.sqrt(P.kGrab * m);
        addForce(F, T, [0, 1, 2].map(k => P.kGrab * (B.target[k] - X[k]) - cg * vp[k]), X);
        for (let k = 0; k < 3; k++) T[k] -= P.cAng * B.w[k];
      }
      // integration : v, w puis x, q (Euler semi-implicite) ; inertie au monde R Ib^-1 R'
      for (let k = 0; k < 3; k++) { F[k] -= P.drag * m * B.v[k]; B.v[k] += dt * F[k] / m; }
      const Tl = mtv(B.R, T), wl = [Tl[0] / Ib[0], Tl[1] / Ib[1], Tl[2] / Ib[2]], dw = mv(B.R, wl);
      for (let k = 0; k < 3; k++) { B.w[k] += dt * dw[k]; B.w[k] *= 1 - dt * P.drag; B.x[k] += dt * B.v[k]; }
      const [qw, qx, qy, qz] = B.q, [wx, wy, wz] = B.w;
      const dq = [-wx * qx - wy * qy - wz * qz, wx * qw + wy * qz - wz * qy,
                  -wx * qz + wy * qw + wz * qx, wx * qy - wy * qx + wz * qw];
      const q = [qw + 0.5 * dt * dq[0], qx + 0.5 * dt * dq[1], qy + 0.5 * dt * dq[2], qz + 0.5 * dt * dq[3]];
      const nq = Math.hypot(q[0], q[1], q[2], q[3]);
      B.q = q.map(v => v / nq);
      B.R = qmat(B.q);
    }
    B.step = dt => {
      if (!B.on) return;
      const n = Math.max(1, Math.ceil(dt / P.substep));
      for (let i = 0; i < n; i++) substep(dt / n);
    };

    // rayon monde (origine o, direction d) : distance t le long de d jusqu'a la boite, ou -1
    B.rayHit = (o, d) => {
      const ol = mtv(B.R, [o[0] - B.x[0], o[1] - B.x[1], o[2] - B.x[2]]), dl = mtv(B.R, d);
      let tn = -Infinity, tf = Infinity;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(dl[k]) < 1e-12) { if (Math.abs(ol[k]) > h[k]) return -1; continue; }
        let t1 = (-h[k] - ol[k]) / dl[k], t2 = (h[k] - ol[k]) / dl[k];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tn = Math.max(tn, t1); tf = Math.min(tf, t2);
      }
      if (tf < Math.max(tn, 0)) return -1;
      return tn > 0 ? tn : tf;
    };
    // saisie : point monde X sur la boite, garde dans le repere de la boite
    B.startGrab = X => {
      B.grab = {pl: mtv(B.R, [X[0] - B.x[0], X[1] - B.x[1], X[2] - B.x[2]])};
      B.target = X.slice();
    };
    B.grabPoint = () => { const r = mv(B.R, B.grab.pl); return [B.x[0] + r[0], B.x[1] + r[1], B.x[2] + r[2]]; };
    B.release = () => { B.grab = null; B.target = null; };

    // pour le rendu : camera (E monde -> camera, lignes [R | t]) -> repere de la boite, matrice 4 x 4
    // en colonnes (convention WebGL), demi-cotes, direction de la lumiere au repere de la boite
    B.renderInfo = E => {
      const Rc = [E[0][0], E[0][1], E[0][2], E[1][0], E[1][1], E[1][2], E[2][0], E[2][1], E[2][2]];
      const tc = [E[0][3], E[1][3], E[2][3]];
      // X_l = Rb' Rc' X_c - Rb' (Rc' t + c)
      const A = new Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += B.R[3 * k + i] * Rc[3 * j + k];
        A[3 * i + j] = s;
      }
      const ct = mtv(Rc, tc), b = mtv(B.R, [-(ct[0] + B.x[0]), -(ct[1] + B.x[1]), -(ct[2] + B.x[2])]);
      const M = new Float32Array([A[0], A[3], A[6], 0, A[1], A[4], A[7], 0, A[2], A[5], A[8], 0, b[0], b[1], b[2], 1]);
      // lumiere : du haut, un peu vers la camera
      const camPos = ct.map(v => -v), toCam = norm([camPos[0] - B.x[0], camPos[1] - B.x[1], camPos[2] - B.x[2]]);
      const L = norm(mtv(B.R, [up[0] + 0.6 * toCam[0], up[1] + 0.6 * toCam[1], up[2] + 0.6 * toCam[2]]));
      return {M, half: h, round: rr, light: L};
    };
    return B;
  }

  root.MpovBox = {create};
})(typeof window !== 'undefined' ? window : this);
