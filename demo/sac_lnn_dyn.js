/*
 * sac_lnn_dyn.js — portage JS du Lagrangien appris (cas sac, d=2).
 *
 * Évalue la MÊME dynamique que `models.py::LNN.accel` du dépôt LaGS, à partir des poids
 * exportés dans `sac_lnn.js` (window.SAC_LNN, produit par demo_Lags/export_sac_lnn.py
 * depuis lnn.pt — le checkpoint de la figure fig_sac_rollout.pdf de l'article).
 *
 *     M̃(q) q̈ = ∂T/∂q − ∇V(q) − (∂(M̂q̇)/∂q)q̇ − C(q)q̇ + F_ext ,   M̃ = m·M̂,  m = 1
 *
 * où V est INVEXE (Bregman d'un ICNN composé à un difféomorphisme i-ResNet Φ), M̂(q) et
 * C(q) sont SPD via des facteurs de Cholesky produits par des MLP ELU.
 *
 * PyTorch obtient ∂T/∂q et ∂(M̂q̇)/∂q par autograd ; ici tout est calculé en MODE DIRECT
 * (on propage la valeur ET sa jacobienne 2×2 le long du réseau). En d=2 c'est exact,
 * sans graphe, et ~3× le coût d'un forward — négligeable à 60 fps.
 *
 * ⚠️ Unité de temps : le LNN a été entraîné avec dt = 1 FRAME (cf. simulate_rk4(dt=1.0)
 * dans plot_rollout_full.py), à 30 fps. `step()` avance donc d'UNE frame.
 *
 * ⚠️ Espaces : le LNN vit dans l'espace BLANCHI u = (z − mean)·W. L'atlas de sprites et
 * les gaussiennes vivent dans l'espace latent BRUT z. Utiliser toZ()/toU()/forceToU()
 * pour passer de l'un à l'autre — jamais mélanger les deux.
 *
 * Fidélité vérifiée contre PyTorch par demo_Lags/check_sac_lnn.mjs (jeu de référence
 * embarqué dans SAC_LNN.ref).
 */
(function (root) {
  'use strict';

  // ── petites primitives 2×2 / vecteurs ──────────────────────────────────────
  const softplus = x => x > 30 ? x : Math.log1p(Math.exp(x));
  const sigmoid = x => 1 / (1 + Math.exp(-x));

  /** y = W·x + b, avec W (n×m) en tableau de lignes. */
  function matVec(W, x, b) {
    const n = W.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const row = W[i];
      let s = b ? b[i] : 0;
      for (let j = 0; j < row.length; j++) s += row[j] * x[j];
      out[i] = s;
    }
    return out;
  }

  /** J_out = W·J, J étant (m×2) aplati en Float64Array de longueur 2m. */
  function matJac(W, J) {
    const n = W.length, out = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const row = W[i];
      let a = 0, b = 0;
      for (let j = 0; j < row.length; j++) { const w = row[j]; a += w * J[2 * j]; b += w * J[2 * j + 1]; }
      out[2 * i] = a; out[2 * i + 1] = b;
    }
    return out;
  }

  /** Résout A·x = b pour A (2×2) donnée en [a00,a01,a10,a11]. */
  function solve2(A, b) {
    const det = A[0] * A[3] - A[1] * A[2];
    // det ne peut pas s'annuler : A = M̂ + ridge·I est SPD (Cholesky + plancher ε).
    return [(A[3] * b[0] - A[1] * b[1]) / det, (-A[2] * b[0] + A[0] * b[1]) / det];
  }

  // ── Φ : difféomorphisme i-ResNet, valeur + jacobienne ─────────────────────
  // Φ = (I + α_K r_K) ∘ … ∘ (I + α_1 r_1), r = Linear∘tanh∘Linear (spectralement
  // normalisés à l'export ⟹ ici de simples matrices denses).
  function diffeo(blocks, q) {
    let x = [q[0], q[1]];
    let Jx = new Float64Array([1, 0, 0, 1]);          // ∂x/∂q, ligne-major (2×2)
    for (const B of blocks) {
      const t = matVec(B.W1, x, B.b1);                 // (H,)
      const Jt = matJac(B.W1, Jx);                     // (H×2)
      const H = t.length;
      const s = new Float64Array(H), Js = new Float64Array(2 * H);
      for (let i = 0; i < H; i++) {
        const th = Math.tanh(t[i]);
        const d = 1 - th * th;                         // tanh'
        s[i] = th; Js[2 * i] = d * Jt[2 * i]; Js[2 * i + 1] = d * Jt[2 * i + 1];
      }
      const y = matVec(B.W2, s, B.b2);                 // (2,)
      const Jy = matJac(B.W2, Js);                     // (2×2)
      const a = B.alpha;
      x = [x[0] + a * y[0], x[1] + a * y[1]];
      for (let k = 0; k < 4; k++) Jx[k] += a * Jy[k];
    }
    return { x, J: Jx };
  }

  // ── ICNN scalaire g : valeur + gradient (mode direct, cf. _icnn_grad) ─────
  function icnn(layers, wOut, x) {
    let h = null, J = null;
    for (const L of layers) {
      let out = matVec(L.Wz, x, L.b);                  // passthrough libre en x
      let dout = matJac(L.Wz, new Float64Array([1, 0, 0, 1]));
      if (L.Wh && h) {                                  // récurrence W_h ≥ 0 (softplus à l'export)
        const rec = matVec(L.Wh, h, null), dr = matJac(L.Wh, J);
        for (let i = 0; i < out.length; i++) {
          out[i] += rec[i]; dout[2 * i] += dr[2 * i]; dout[2 * i + 1] += dr[2 * i + 1];
        }
      }
      const n = out.length;
      const hn = new Float64Array(n), Jn = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const sg = sigmoid(out[i]);                     // softplus'
        hn[i] = softplus(out[i]);
        Jn[2 * i] = sg * dout[2 * i]; Jn[2 * i + 1] = sg * dout[2 * i + 1];
      }
      h = hn; J = Jn;
    }
    let g = 0, g0 = 0, g1 = 0;
    for (let i = 0; i < h.length; i++) {
      const w = wOut[i];
      g += w * h[i]; g0 += w * J[2 * i]; g1 += w * J[2 * i + 1];
    }
    return { g, grad: [g0, g1] };
  }

  // ── Potentiel invexe V et son gradient ────────────────────────────────────
  // V(q) = g(Φ(q)) − g(u_r) − ∇g(u_r)ᵀ(Φ(q) − u_r) + ½ε‖Φ(q) − u_r‖²   (Bregman)
  // ∇V(q) = JΦ(q)ᵀ · [ ∇g(Φ(q)) − ∇g(u_r) + ε(Φ(q) − u_r) ]
  function potential(E, q) {
    const P = diffeo(E.diffeo, q);
    const G = icnn(E.icnn, E.w_out, P.x);
    const du = [P.x[0] - E.u_rest[0], P.x[1] - E.u_rest[1]];
    const eps = E.eps_strong;
    const gu = [G.grad[0] - E.grad_rest[0] + eps * du[0],
                G.grad[1] - E.grad_rest[1] + eps * du[1]];
    const V = G.g - E.g_rest - (E.grad_rest[0] * du[0] + E.grad_rest[1] * du[1])
              + 0.5 * eps * (du[0] * du[0] + du[1] * du[1]);
    // chaîne par la transposée de la jacobienne du difféo
    return { V, grad: [P.J[0] * gu[0] + P.J[2] * gu[1], P.J[1] * gu[0] + P.J[3] * gu[1]] };
  }

  // ── Facteur de Cholesky SPD : S(q) = L(q)L(q)ᵀ + εI, plus ∂S/∂q ───────────
  // Sert deux fois : masse M̂(q) (ε=2.0) et dissipation C(q) (ε=1e-4).
  function cholSPD(spec, q, wantGrad) {
    const net = spec.net;
    let h = [q[0], q[1]];
    let Jh = new Float64Array([1, 0, 0, 1]);
    for (let li = 0; li < net.length; li++) {
      const L = net[li];
      const z = matVec(L.W, h, L.b);
      const Jz = matJac(L.W, Jh);
      if (li === net.length - 1) { h = z; Jh = Jz; break; }   // dernière couche : linéaire nue
      const n = z.length;
      const hn = new Float64Array(n), Jn = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const v = z[i];
        const e = v > 0 ? v : Math.exp(v) - 1;                // ELU
        const d = v > 0 ? 1 : e + 1;                          // ELU'
        hn[i] = e; Jn[2 * i] = d * Jz[2 * i]; Jn[2 * i + 1] = d * Jz[2 * i + 1];
      }
      h = hn; Jh = Jn;
    }
    // vecteur triangulaire inférieur → L (diagonale passée au softplus)
    const Lm = [[0, 0], [0, 0]];
    const dLm = [[[0, 0], [0, 0]], [[0, 0], [0, 0]]];         // dLm[k] = ∂L/∂q_k
    for (let t = 0; t < spec.tril_i.length; t++) {
      const i = spec.tril_i[t], j = spec.tril_j[t];
      const raw = h[t];
      const isDiag = spec.diag[t];
      Lm[i][j] = isDiag ? softplus(raw) : raw;
      if (wantGrad) {
        const d = isDiag ? sigmoid(raw) : 1;
        dLm[0][i][j] = d * Jh[2 * t];
        dLm[1][i][j] = d * Jh[2 * t + 1];
      }
    }
    const eps = spec.eps;
    // S = L·Lᵀ + εI
    const S = [Lm[0][0] * Lm[0][0] + eps,
               Lm[0][0] * Lm[1][0],
               Lm[0][0] * Lm[1][0],
               Lm[1][0] * Lm[1][0] + Lm[1][1] * Lm[1][1] + eps];
    if (!wantGrad) return { S, dS: null };
    // ∂S/∂q_k = (∂L/∂q_k)Lᵀ + L(∂L/∂q_k)ᵀ
    const dS = [];
    for (let k = 0; k < 2; k++) {
      const dL = dLm[k];
      const a = dL[0][0] * Lm[0][0] + Lm[0][0] * dL[0][0];
      const b = dL[0][0] * Lm[1][0] + Lm[0][0] * dL[1][0];
      const c = b;
      const d = 2 * (dL[1][0] * Lm[1][0] + dL[1][1] * Lm[1][1]);
      dS.push([a, b, c, d]);
    }
    return { S, dS };
  }

  /**
   * Accélération q̈ dans l'espace BLANCHI u, en unités « par frame² ».
   * @param {number[]} q   état latent blanchi (2)
   * @param {number[]} v   vitesse latente blanchie (2), par frame
   * @param {number[]} [F] force généralisée externe en espace u (2) — prise interactive
   * @param {number} [ds] facteur d'échelle sur la dissipation apprise (1 = appris tel quel).
   *        Équivalent du knob de diagnostic `LNN_DISS_SCALE` côté Python : C(q) reste SPD
   *        pour tout ds > 0, donc la dissipation reste physiquement admissible.
   * @param {number} [c0] plancher d'amortissement ADDITIF, en Rayleigh proportionnel à la
   *        masse : C_eff = ds·C(q) + c0·M̃(q). C'est le mode de dissipation par défaut du
   *        pipeline Python (`α·M̃`, cf. _rayleigh_diss_raw), donc SPD par construction et
   *        cohérent avec la métrique apprise. Utile parce que le C(q) appris est quasi
   *        rang 1 partout et s'effondre au plancher SPD (1e-4) dans un îlot centré sur
   *        l'équilibre : le mettre à l'échelle ne comble pas ce trou, seul un terme
   *        additif le fait. c0 = 0 ⟹ dynamique strictement celle de lnn.pt.
   */
  function accel(P, q, v, F, ds, c0) {
    const m = Math.exp(P.metric.log_m);
    const Mh = cholSPD(P.metric, q, true);             // M̂(q) et ∂M̂/∂q
    const M = Mh.S, dM = Mh.dS;

    // ∂T/∂q_k = ½ q̇ᵀ (∂M̂/∂q_k) q̇
    const dT = [0, 0];
    for (let k = 0; k < 2; k++) {
      const D = dM[k];
      dT[k] = 0.5 * (v[0] * (D[0] * v[0] + D[1] * v[1]) + v[1] * (D[2] * v[0] + D[3] * v[1]));
    }
    // Coriolis : (∂(M̂q̇)/∂q)q̇ — colonne j = (∂M̂/∂q_j)q̇, contractée avec q̇
    const pq = [0, 0];
    for (let j = 0; j < 2; j++) {
      const D = dM[j];
      pq[0] += (D[0] * v[0] + D[1] * v[1]) * v[j];
      pq[1] += (D[2] * v[0] + D[3] * v[1]) * v[j];
    }
    const gV = potential(P.energy, q).grad;
    const C = cholSPD(P.rayleigh, q, false).S;          // C(q), valeur seule
    const sd = ds === undefined ? 1 : ds;
    const cf = c0 ? c0 * m : 0;                         // plancher c0·M̃ = c0·m·M̂
    const diss = [sd * (C[0] * v[0] + C[1] * v[1]) + cf * (M[0] * v[0] + M[1] * v[1]),
                  sd * (C[2] * v[0] + C[3] * v[1]) + cf * (M[2] * v[0] + M[3] * v[1])];

    const force = [m * dT[0] - gV[0] - m * pq[0] - diss[0] + (F ? F[0] : 0),
                   m * dT[1] - gV[1] - m * pq[1] - diss[1] + (F ? F[1] : 0)];
    const r = P.ridge;
    return solve2([m * M[0] + r, m * M[1], m * M[2], m * M[3] + r], force);
  }

  /** Un pas de RK4 d'UNE frame (l'unité de temps du LNN). F est constante sur le pas. */
  function step(P, q, v, F, dt, ds, c0) {
    const h = dt === undefined ? P.dt_frames : dt;
    const f = (qq, vv) => [vv, accel(P, qq, vv, F, ds, c0)];
    const add = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1]];
    const k1 = f(q, v);
    const k2 = f(add(q, k1[0], h / 2), add(v, k1[1], h / 2));
    const k3 = f(add(q, k2[0], h / 2), add(v, k2[1], h / 2));
    const k4 = f(add(q, k3[0], h), add(v, k3[1], h));
    const cmb = (a, b, c, d, x) => x + (h / 6) * (a + 2 * b + 2 * c + d);
    return {
      q: [cmb(k1[0][0], k2[0][0], k3[0][0], k4[0][0], q[0]),
          cmb(k1[0][1], k2[0][1], k3[0][1], k4[0][1], q[1])],
      v: [cmb(k1[1][0], k2[1][0], k3[1][0], k4[1][0], v[0]),
          cmb(k1[1][1], k2[1][1], k3[1][1], k4[1][1], v[1])],
    };
  }

  // ── conversions espace blanchi u ↔ espace latent brut z ───────────────────
  // u = (z − mean)·W    (vecteurs LIGNE, cf. LatentWhiten)
  const toU = (P, z) => {
    const W = P.whiten.W, m = P.whiten.mean;
    const a = z[0] - m[0], b = z[1] - m[1];
    return [a * W[0][0] + b * W[1][0], a * W[0][1] + b * W[1][1]];
  };
  // z = mean + u·W⁻¹
  const toZ = (P, u) => {
    const Wi = P.whiten.W_inv, m = P.whiten.mean;
    return [m[0] + u[0] * Wi[0][0] + u[1] * Wi[1][0],
            m[1] + u[0] * Wi[0][1] + u[1] * Wi[1][1]];
  };
  // Une force est un COVECTEUR : F_u = W⁻¹ · F_z  (car ∂z_j/∂u_i = W⁻¹_ij).
  const forceToU = (P, Fz) => {
    const Wi = P.whiten.W_inv;
    return [Wi[0][0] * Fz[0] + Wi[0][1] * Fz[1], Wi[1][0] * Fz[0] + Wi[1][1] * Fz[1]];
  };

  root.SacLNN = { accel, step, potential, cholSPD, toU, toZ, forceToU };
})(typeof window !== 'undefined' ? window : globalThis);
