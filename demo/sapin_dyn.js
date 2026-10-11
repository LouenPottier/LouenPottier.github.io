/*
 * sapin_dyn.js — cas « sapin » de tree.html (page non indexée, d = 12).
 *
 * Chaîne : encodeur SVD figé (scores des keypoints, hors navigateur), LNN LINÉAIRE
 * q̈ = −K q − C q̇ + b ajusté sur le rollout de 29 prises webcam, décodeur (2+12)D Gaussian
 * Splatting à covariance pleine entraîné sur CPU (LaGS : code_new_3D/keypoints_cpu/
 * train_svd_decoder_cpu.py). Ce fichier porte en JS :
 *
 *   SapinSplat.create(canvas, meta, b64, mask)   rastériseur CPU reproduisant `splat2d` du dépôt :
 *       pour chaque gaussienne, centre μ(q) = μ_xy + A (q − μ_q), poids α·exp(−½ (q−μ_q)ᵀ Σ_qq⁻¹ (q−μ_q)),
 *       empreinte exp(−½ dᵀ Σ_cond⁻¹ d) sur une fenêtre W×W autour du centre arrondi,
 *       compositing par SOMME NORMALISÉE (couleur = Σ cᵢ wᵢ Gᵢ / max(Σ wᵢ Gᵢ, 1)). Ce n'est pas
 *       le « over » de gs_splat.js : le décodeur a été entraîné avec cette règle, on la garde.
 *       Unités : pixels de meta.img_size, q BLANCHI (q − mean)/std.
 *     .render(qw)                 dessine l'état (qw blanchi, longueur d), exposition meta.expo (gain, biais)
 *     .select(qw, x, y, opt)      saisie : gaussiennes mobiles pesant au point image (x, y) en px ;
 *                                 opt.radius (px), opt.mobMin (filtre de mobilité), opt.uniform
 *                                 (poids égaux dans le disque : force « globale »)
 *     .pointOf(qw, sel)           position courante (px) du point matériel saisi
 *     .jacobian(sel)              J = Σ ŵᵢ Aᵢ (2×d, px par unité de q blanchi)
 *     .opts.freeze                gel des gaussiennes du fond (masque sapin_mask.js), .setRest(qw) requis
 *     .drawMask(ctx, w, h, rgba)  dessine le masque du fond sur un contexte 2D
 *
 *   SapinDyn.create(lnn)          intégrateur velocity-Verlet du LNN linéaire en q BRUT, avec
 *                                 force généralisée extérieure F (Jᵀf rapatrié en unités brutes).
 */
(function (root) {
  'use strict';

  function decodeB64(b64) {
    const bin = atob(b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
  }

  const SapinSplat = {
    create(canvas, meta, b64, mask) {
      const data = decodeB64(b64);
      const K = meta.K, d = meta.d, st = meta.stride, L = meta.layout;
      const [W, H] = meta.img_size, win = meta.window, hw = win >> 1;
      const oMu = L.mu_xy[0], oMz = L.mz[0], oA = L.sxz_szzi[0], oS = L.szzi[0], oC = L.scond_inv[0], oAl = L.alpha[0], oCol = L.color[0];
      // Σ_qq⁻¹ (triangle supérieur) -> matrice pleine par gaussienne pour la porte
      const Sfull = new Float32Array(K * d * d);
      for (let k = 0; k < K; k++) {
        let p = k * st + oS;
        for (let i = 0; i < d; i++) for (let j = i; j < d; j++) {
          const v = data[p++];
          Sfull[k * d * d + i * d + j] = v; Sfull[k * d * d + j * d + i] = v;
        }
      }
      // mobilité (norme de Frobenius de A) pour le filtre de saisie
      const mob = new Float32Array(K);
      for (let k = 0; k < K; k++) { let s = 0; for (let i = 0; i < 2 * d; i++) { const v = data[k * st + oA + i]; s += v * v; } mob[k] = Math.sqrt(s); }
      const off = canvas.ownerDocument.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d');
      const img = octx.createImageData(W, H);
      const num = new Float32Array(W * H * 3), den = new Float32Array(W * H);
      const dq = new Float64Array(d), uv = new Float64Array(K * 2), wgt = new Float64Array(K);

      // Masque du fond immobile (sapin_mask.js) : une gaussienne dont le centre de repos tombe
      // dans le masque est GELÉE quand freeze est actif : ni décalage A(q − μ_q), ni variation
      // de porte (poids figé à sa valeur au repos q = qRest).
      let isStatic = null, wRest = null;
      const opts = { freeze: false };
      if (mask && mask.data) {
        const m = Uint8Array.from(atob(mask.data), ch => ch.charCodeAt(0));
        isStatic = new Uint8Array(K);
        for (let k = 0; k < K; k++) {
          const x = Math.round(data[k * st + oMu]), y = Math.round(data[k * st + oMu + 1]);
          isStatic[k] = (x >= 0 && x < mask.W && y >= 0 && y < mask.H && m[y * mask.W + x] > 127) ? 1 : 0;
        }
        opts.mask = m;
      }
      function setRest(qRest) {                      // poids de repos des gaussiennes (pour le gel)
        wRest = new Float64Array(K);
        for (let k = 0; k < K; k++) {
          const b = k * st; let quad = 0;
          for (let i = 0; i < d; i++) dq[i] = qRest[i] - data[b + oMz + i];
          const sb = k * d * d;
          for (let i = 0; i < d; i++) { let acc = 0; for (let j = 0; j < d; j++) acc += Sfull[sb + i * d + j] * dq[j]; quad += dq[i] * acc; }
          wRest[k] = data[b + oAl] * Math.exp(-0.5 * quad);
        }
      }

      function evalState(qw) {                       // centres et poids de toutes les gaussiennes
        const frz = opts.freeze && isStatic && wRest;
        for (let k = 0; k < K; k++) {
          const b = k * st;
          if (frz && isStatic[k]) { wgt[k] = wRest[k]; uv[2 * k] = data[b + oMu]; uv[2 * k + 1] = data[b + oMu + 1]; continue; }
          let quad = 0;
          for (let i = 0; i < d; i++) dq[i] = qw[i] - data[b + oMz + i];
          const sb = k * d * d;
          for (let i = 0; i < d; i++) { let acc = 0; for (let j = 0; j < d; j++) acc += Sfull[sb + i * d + j] * dq[j]; quad += dq[i] * acc; }
          wgt[k] = data[b + oAl] * Math.exp(-0.5 * quad);
          let ux = data[b + oMu], uy = data[b + oMu + 1];
          for (let j = 0; j < d; j++) { ux += data[b + oA + j] * dq[j]; uy += data[b + oA + d + j] * dq[j]; }
          uv[2 * k] = ux; uv[2 * k + 1] = uy;
        }
      }

      function render(qw) {
        evalState(qw);
        num.fill(0); den.fill(0);
        for (let k = 0; k < K; k++) {
          const w = wgt[k];
          if (w < 1e-4) continue;
          const b = k * st, ux = uv[2 * k], uy = uv[2 * k + 1];
          const cx = Math.round(ux), cy = Math.round(uy);
          if (cx < -hw || cx >= W + hw || cy < -hw || cy >= H + hw) continue;
          const sa = data[b + oC], sbb = data[b + oC + 1], sc = data[b + oC + 2];
          const r = data[b + oCol], g = data[b + oCol + 1], bl = data[b + oCol + 2];
          for (let oy = -hw; oy <= hw; oy++) {
            const py = cy + oy; if (py < 0 || py >= H) continue;
            const dy = py - uy;
            for (let ox = -hw; ox <= hw; ox++) {
              const px = cx + ox; if (px < 0 || px >= W) continue;
              const dx = px - ux;
              const ww = w * Math.exp(-0.5 * (sa * dx * dx + 2 * sbb * dx * dy + sc * dy * dy));
              const p = py * W + px;
              num[3 * p] += ww * r; num[3 * p + 1] += ww * g; num[3 * p + 2] += ww * bl; den[p] += ww;
            }
          }
        }
        // exposition : gain et biais de meta.expo (estimés sur la première frame de la prise held-out
        // par make_sapin_compare_video.py), les mêmes que la vidéo de comparaison ; sinon (1, 0)
        const px = img.data, eg = (meta.expo ? meta.expo.gain : 1) * 255, eb = (meta.expo ? meta.expo.bias : 0) * 255;
        for (let p = 0; p < W * H; p++) {
          const dn = den[p] > 1 ? den[p] : 1;
          px[4 * p] = Math.max(0, Math.min(255, num[3 * p] / dn * eg + eb)); px[4 * p + 1] = Math.max(0, Math.min(255, num[3 * p + 1] / dn * eg + eb));
          px[4 * p + 2] = Math.max(0, Math.min(255, num[3 * p + 2] / dn * eg + eb)); px[4 * p + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        const cw = canvas.clientWidth, ch = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
        if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
        const x = canvas.getContext('2d');
        x.imageSmoothingEnabled = true;
        x.drawImage(off, 0, 0, canvas.width, canvas.height);
      }

      function select(qw, x, y, opt) {
        opt = opt || {};
        const radius = opt.radius || 6, mobMin = (opt.mobMin != null) ? opt.mobMin : 0.25, uniform = !!opt.uniform;
        evalState(qw);
        const cand = [];
        let mobMax = 0;
        const frz = opts.freeze && isStatic && wRest;
        for (let k = 0; k < K; k++) {
          if (wgt[k] < 1e-3 || (frz && isStatic[k])) continue;      // le fond gelé ne se saisit pas
          const dx = uv[2 * k] - x, dy = uv[2 * k + 1] - y, r2 = dx * dx + dy * dy;
          if (r2 > radius * radius) continue;
          const b = k * st, sa = data[b + oC], sbb = data[b + oC + 1], sc = data[b + oC + 2];
          // local : empreinte de la gaussienne au point × décroissance en σ = rayon/2 ;
          // global (uniform) : chaque gaussienne mobile du disque pèse pareil (porte seule)
          const ww = uniform ? wgt[k]
                             : wgt[k] * Math.exp(-0.5 * (sa * dx * dx + 2 * sbb * dx * dy + sc * dy * dy)) * Math.exp(-0.5 * r2 / (radius * radius / 4));
          if (ww < 1e-4) continue;
          cand.push([k, ww]); if (mob[k] > mobMax) mobMax = mob[k];
        }
        const sel = cand.filter(([k]) => mob[k] >= mobMin * mobMax);
        const tot = sel.reduce((s, [, w]) => s + w, 0);
        if (!sel.length || tot <= 0) return null;
        return sel.map(([k, w]) => [k, w / tot]);
      }
      function pointOf(qw, sel) {
        evalState(qw);
        let x = 0, y = 0;
        for (const [k, w] of sel) { x += w * uv[2 * k]; y += w * uv[2 * k + 1]; }
        return [x, y];
      }
      function jacobian(sel) {                       // (2, d) en px par unité de q blanchi
        const J = [new Float64Array(d), new Float64Array(d)];
        for (const [k, w] of sel) for (let j = 0; j < d; j++) { J[0][j] += w * data[k * st + oA + j]; J[1][j] += w * data[k * st + oA + d + j]; }
        return J;
      }
      function drawMask(ctx, w, h, rgba) {          // superposition du masque (zone immobile teintée)
        if (!opts.mask) return;
        if (!drawMask.img) {
          const c = canvas.ownerDocument.createElement('canvas'); c.width = mask.W; c.height = mask.H;
          const x = c.getContext('2d'), im = x.createImageData(mask.W, mask.H);
          for (let p = 0; p < mask.W * mask.H; p++) { const on = opts.mask[p] > 127; im.data[4 * p] = rgba[0]; im.data[4 * p + 1] = rgba[1]; im.data[4 * p + 2] = rgba[2]; im.data[4 * p + 3] = on ? rgba[3] : 0; }
          x.putImageData(im, 0, 0); drawMask.img = c;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(drawMask.img, 0, 0, w, h);
      }
      return { render, select, pointOf, jacobian, setRest, drawMask, opts, isStatic, K, d, W, H, mob };
    }
  };

  const SapinDyn = {
    create(P) {
      const d = P.d, K = P.K, C = P.C, b = P.b, dt = 1 / P.fps;
      const q = new Float64Array(d), v = new Float64Array(d), acc = new Float64Array(d), F = new Float64Array(d);
      const self = { cscale: 1.0 };                  // facteur sur la dissipation C (curseur)
      function accel(out) {
        const cs = self.cscale;
        for (let i = 0; i < d; i++) {
          let s = b[i] + F[i];
          for (let j = 0; j < d; j++) s -= K[i][j] * q[j] + cs * C[i][j] * v[j];
          out[i] = s;
        }
      }
      function step(nsub) {                          // velocity-Verlet, nsub sous-pas par frame
        const h = dt / (nsub || 4);
        accel(acc);
        for (let s = 0; s < (nsub || 4); s++) {
          for (let i = 0; i < d; i++) { v[i] += 0.5 * h * acc[i]; q[i] += h * v[i]; }
          accel(acc);
          for (let i = 0; i < d; i++) v[i] += 0.5 * h * acc[i];
        }
      }
      function set(q0, v0) { for (let i = 0; i < d; i++) { q[i] = q0 ? q0[i] : 0; v[i] = v0 ? v0[i] : 0; } }
      function whitened(out) { for (let i = 0; i < d; i++) out[i] = (q[i] - P.q_mean[i]) / P.q_std[i]; return out; }
      Object.assign(self, { q, v, F, step, set, whitened, dt, d });
      return self;
    }
  };

  root.SapinSplat = SapinSplat;
  root.SapinDyn = SapinDyn;
})(window);
