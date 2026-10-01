/*
 * zoned3d.js : decodeur 3D par zones (train_dec3d_zoned.py, --exact 1) evalue dans le
 * navigateur, et son rendu Gaussian Splatting en WebGL2, sans gsplat.
 *
 * Etat z = (s, q0, q1). Les gaussiennes arrivent rangees par export_web_3d.py :
 *   [0, n_q)            zone q : deformees par field_q(s*, q), ponderees par q_gate
 *   [n_q, n_q + n_s)    zone s : deformees par field_s(s), taille fixe
 *   [.., n_move)        porteur seul
 *   [n_move, n)         statiques
 * Toutes celles de carrier_w > 0 sont translatees par carrier_w (c(s) - c(s*)).
 * Seules les n_move premieres sont recalculees a chaque etat : la texture de donnees n'est
 * re-ecrite que sur ces lignes.
 *
 * Rendu : recette de gsplat.rasterization (projection perspective EWA, bornes du champ a
 * 1.3 x le demi-champ, eps2d = 0.3 px^2, opacite bornee a 0.99, 3 sigma, plan near 0.2),
 * compositing front-to-back par profondeur camera croissante, fond noir.
 *
 * API :
 *   const M = Zoned3D.load(window.MPOV_DEC3D);
 *   M.update(z)                         -> met a jour les gaussiennes mobiles
 *   const R = Zoned3D.renderer(canvas, M); R.draw(cam)   cam = {E (4x4, monde -> camera,
 *                                         convention OpenCV), K (3x3), W, H, color (option)}
 *   M.select(cam, x, y, radius, uniform) -> selection (px ecran)
 *   M.jacobian(z, cam, sel)             -> {pt, J (2x2 px par unite de q), neff, coh}
 */
(function (root) {
  'use strict';

  function b64ToBytes(b64) {
    const bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const H2F = (() => {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      t[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024)
           : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return t;
  })();

  function load(pack) {
    const meta = pack.meta, buf = b64ToBytes(pack.b64).buffer, P = {};
    for (const p of meta.parts) {
      const n = p.shape.reduce((a, b) => a * b, 1);
      if (p.dtype === 'f32') P[p.name] = new Float32Array(buf, p.off, n);
      else if (p.dtype === 'i8') P[p.name] = new Int8Array(buf, p.off, n);
      else if (p.dtype === 'f16') {
        const h = new Uint16Array(buf, p.off, n), f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = H2F[h[i]];
        P[p.name] = f;
      }
    }
    const N = meta.n, NQ = meta.n_q, NS = meta.n_s, NM = meta.n_move, HID = meta.hidden;
    const MX = meta.max_dxyz;

    // ── MLP a une couche cachee : cond -> SiLU(W0 cond + b0) -> tete int8 ──
    function field(name, cond) {
      const w0 = P[name + '.b0.w'], b0 = P[name + '.b0.b'], d = cond.length;
      const h = new Float32Array(HID);
      for (let r = 0; r < HID; r++) {
        let a = b0[r];
        for (let c = 0; c < d; c++) a += w0[r * d + c] * cond[c];
        h[r] = a / (1 + Math.exp(-a));
      }
      return h;
    }
    function head(name, h, rows, out) {
      // rows : nombre de lignes de sorties (n_gauss * 12), ou liste de gaussiennes
      const hw = P[name + '.hw'], hs = P[name + '.hs'], hb = P[name + '.hb'];
      const list = Array.isArray(rows) || ArrayBuffer.isView(rows);
      const ng = list ? rows.length : rows / 12;
      out = out || new Float32Array(ng * 12);
      for (let j = 0; j < ng; j++) {
        const g = list ? rows[j] : j;
        for (let p = 0; p < 12; p++) {
          const r = g * 12 + p, o = r * HID;
          let a = 0;
          for (let c = 0; c < HID; c++) a += hw[o + c] * h[c];
          out[j * 12 + p] = a * hs[r] + hb[r];
        }
      }
      return out;
    }
    // split(r) : (dx (3), dl (3), dr (3), dc (3)) bornes
    function split(raw, o, dst, d0) {
      for (let k = 0; k < 3; k++) {
        dst[d0 + k] = Math.tanh(raw[o + k]) * MX;
        dst[d0 + 3 + k] = Math.tanh(raw[o + 3 + k]);
        dst[d0 + 6 + k] = Math.tanh(raw[o + 6 + k]) * Math.PI;
        dst[d0 + 9 + k] = Math.tanh(raw[o + 9 + k]) * 0.5;
      }
    }
    const zs = meta.z_star;
    function splitAll(name, cond, n) {
      const raw = head(name, field(name, cond), n * 12), o = new Float32Array(n * 12);
      for (let g = 0; g < n; g++) split(raw, g * 12, o, g * 12);
      return o;
    }
    const refS = splitAll('field_s', [zs[0]], NS);
    const refQ = splitAll('field_q', zs, NQ);

    function carrier(s) {
      const c = meta.carrier_coef, lo = meta.carrier_rng[0], hi = meta.carrier_rng[1];
      s = Math.max(lo, Math.min(hi, s));
      const out = [0, 0, 0];
      for (let k = 0; k < c[0].length; k++)
        for (let i = 0; i < 3; i++) out[i] = out[i] * s + c[i][k];
      return out;
    }
    const c0 = carrier(zs[0]);

    // ── etat : position, quaternion, log-demi-axes effectifs, couleur, de chaque gaussienne
    const xyz = new Float32Array(3 * N), quat = new Float32Array(4 * N);
    const logs = new Float32Array(3 * N), col = new Float32Array(3 * N), alpha = new Float32Array(N);
    const sg = x => 1 / (1 + Math.exp(-x));
    function eff(ls, fl) { return 0.5 * Math.log(Math.exp(2 * ls) + fl * fl); }
    for (let g = 0; g < N; g++) {
      for (let k = 0; k < 3; k++) {
        xyz[3 * g + k] = P.xyz[3 * g + k];
        logs[3 * g + k] = eff(P.logs[3 * g + k], P.floor[g]);
        col[3 * g + k] = sg(P.col[3 * g + k]);
      }
      for (let k = 0; k < 4; k++) quat[4 * g + k] = P.quat[4 * g + k];
      alpha[g] = Math.min(0.99, P.alpha[g]);
    }
    const dS = new Float32Array(NS * 12), dQ = new Float32Array(NQ * 12);
    let lastS = NaN, lastQ = [NaN, NaN];

    function compose(g, d, d0, scaleQ) {
      // applique la deformation d[d0 .. d0+12) a la gaussienne g (etat canonique + porteur)
      const b = 4 * g;
      const v = [d[d0 + 6], d[d0 + 7], d[d0 + 8]];
      const th = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + 1e-12);
      const sh = Math.sin(0.5 * th) / th;
      const aw = Math.cos(0.5 * th), ax = v[0] * sh, ay = v[1] * sh, az = v[2] * sh;
      const bw = P.quat[b], bx = P.quat[b + 1], by = P.quat[b + 2], bz = P.quat[b + 3];
      let w = aw * bw - ax * bx - ay * by - az * bz, x = aw * bx + ax * bw + ay * bz - az * by;
      let y = aw * by - ax * bz + ay * bw + az * bx, z = aw * bz + ax * by - ay * bx + az * bw;
      const n = Math.hypot(w, x, y, z) || 1;
      quat[b] = w / n; quat[b + 1] = x / n; quat[b + 2] = y / n; quat[b + 3] = z / n;
      for (let k = 0; k < 3; k++) {
        xyz[3 * g + k] += d[d0 + k];
        const dl = scaleQ ? d[d0 + 3 + k] : 0;           // zone s : taille fixe en s
        logs[3 * g + k] = eff(P.logs[3 * g + k] + dl, P.floor[g]);
        col[3 * g + k] = sg(P.col[3 * g + k] + 4 * d[d0 + 9 + k]);
      }
    }

    // met a jour les n_move premieres gaussiennes a l'etat z = (s, q0, q1)
    function update(z) {
      if (z[0] !== lastS) {
        const o = splitAll('field_s', [z[0]], NS);
        for (let i = 0; i < NS * 12; i++) dS[i] = o[i] - refS[i];
        lastS = z[0];
      }
      if (z[1] !== lastQ[0] || z[2] !== lastQ[1]) {
        // delta = g * full, full = split(field_q(s*, q)) - split(field_q(z*)), dont la part
        // log-demi-axes passe par 0.5 x^2 (contrainte exacte : jamais sous la taille a q = 0).
        // La reference sans q de la porte vaut z*, donc sa contribution est nulle.
        const o = splitAll('field_q', [zs[0], z[1], z[2]], NQ), gt = P.q_gate;
        for (let g = 0; g < NQ; g++)
          for (let p = 0; p < 12; p++) {
            const v = o[g * 12 + p] - refQ[g * 12 + p];
            dQ[g * 12 + p] = gt[g] * (p >= 3 && p < 6 ? 0.5 * v * v : v);
          }
        lastQ = [z[1], z[2]];
      }
      const cs = carrier(z[0]), tr = [cs[0] - c0[0], cs[1] - c0[1], cs[2] - c0[2]];
      for (let g = 0; g < NM; g++) {
        for (let k = 0; k < 3; k++) xyz[3 * g + k] = P.xyz[3 * g + k] + P.carrier_w[g] * tr[k];
        if (g < NQ) compose(g, dQ, g * 12, true);
        else if (g < NQ + NS) compose(g, dS, (g - NQ) * 12, false);
      }
      M.z = z.slice();
    }

    // position monde des gaussiennes de zone q `ids` (< n_q) a l'etat z (pour J)
    function qPositions(z, ids) {
      const raw = head('field_q', field('field_q', [zs[0], z[1], z[2]]), ids);
      const cs = carrier(z[0]), out = new Float64Array(3 * ids.length), tmp = new Float32Array(12);
      for (let j = 0; j < ids.length; j++) {
        const g = ids[j];
        split(raw, j * 12, tmp, 0);
        for (let k = 0; k < 3; k++)
          out[3 * j + k] = P.xyz[3 * g + k] + P.carrier_w[g] * (cs[k] - c0[k])
                         + P.q_gate[g] * (tmp[k] - refQ[g * 12 + k]);
      }
      return out;
    }

    function project(cam, X) {
      const E = cam.E, K = cam.K;
      const xc = E[0][0] * X[0] + E[0][1] * X[1] + E[0][2] * X[2] + E[0][3];
      const yc = E[1][0] * X[0] + E[1][1] * X[1] + E[1][2] * X[2] + E[1][3];
      const zc = E[2][0] * X[0] + E[2][1] * X[1] + E[2][2] * X[2] + E[2][3];
      return [K[0][0] * xc / zc + K[0][2], K[1][1] * yc / zc + K[1][2], zc];
    }

    // saisie : gaussiennes du disque, les plus proches de la camera seulement (cf. demo3d.py)
    function select(cam, x, y, radius, uniform) {
      const cand = [];
      for (let g = 0; g < N; g++) {
        const p = project(cam, [xyz[3 * g], xyz[3 * g + 1], xyz[3 * g + 2]]);
        if (p[2] < 0.05) continue;
        const dx = p[0] - x, dy = p[1] - y, r2 = dx * dx + dy * dy;
        if (r2 <= radius * radius) cand.push([g, r2, p[2]]);
      }
      if (!cand.length) return null;
      let zref = Infinity;
      for (const c of cand) if (alpha[c[0]] > 0.2) zref = Math.min(zref, c[2]);
      if (!isFinite(zref)) zref = Math.min(...cand.map(c => c[2]));
      const sel = cand.filter(c => c[2] < zref * 1.15);
      const f = cam.K[0][0];
      const idx = [], w = [], ws = [];
      for (const [g, r2, dep] of sel) {
        let wi = alpha[g];
        if (!uniform) {
          const s = Math.exp((logs[3 * g] + logs[3 * g + 1] + logs[3 * g + 2]) / 3) * f / dep;
          wi *= (Math.exp(-0.5 * r2 / Math.max(s, 0.5) ** 2) + 1e-3)
                * Math.exp(-0.5 * r2 / (radius * radius / 4));
        }
        idx.push(g); w.push(wi > 1e-6 ? wi : 0); ws.push(alpha[g]);
      }
      const sw = w.reduce((a, b) => a + b, 0), sws = ws.reduce((a, b) => a + b, 0);
      if (sw <= 0) return null;
      return {idx: Int32Array.from(idx), w: Float64Array.from(w, v => v / sw),
              ws: Float64Array.from(ws, v => v / sws)};
    }

    // point saisi (px) et J = d(point)/dq (px par unite de q), differences centrees
    function jacobian(z, cam, sel, h) {
      h = h || 0.05;
      const n = sel.idx.length, pt = [0, 0], J = [[0, 0], [0, 0]], Ji = new Float64Array(4 * n);
      const qi = [], qj = [];
      for (let j = 0; j < n; j++) {
        const g = sel.idx[j];
        const p = project(cam, [xyz[3 * g], xyz[3 * g + 1], xyz[3 * g + 2]]);
        pt[0] += sel.w[j] * p[0]; pt[1] += sel.w[j] * p[1];
        if (g < NQ) { qi.push(g); qj.push(j); }
      }
      if (qi.length) {
        for (let k = 0; k < 2; k++) {
          const zp = z.slice(), zm = z.slice();
          zp[1 + k] += h; zm[1 + k] -= h;
          const Xp = qPositions(zp, qi), Xm = qPositions(zm, qi);
          for (let m = 0; m < qi.length; m++) {
            const a = project(cam, [Xp[3 * m], Xp[3 * m + 1], Xp[3 * m + 2]]);
            const b = project(cam, [Xm[3 * m], Xm[3 * m + 1], Xm[3 * m + 2]]);
            const j = qj[m], gx = (a[0] - b[0]) / (2 * h), gy = (a[1] - b[1]) / (2 * h);
            J[0][k] += sel.w[j] * gx; J[1][k] += sel.w[j] * gy;
            Ji[4 * j + k] = gx; Ji[4 * j + 2 + k] = gy;
          }
        }
      }
      const mean = [0, 0, 0, 0];
      let den = 0, s2 = 0;
      for (let j = 0; j < n; j++) {
        let nr = 0;
        for (let k = 0; k < 4; k++) { mean[k] += sel.ws[j] * Ji[4 * j + k]; nr += Ji[4 * j + k] ** 2; }
        den += sel.ws[j] * Math.sqrt(nr); s2 += sel.ws[j] * sel.ws[j];
      }
      return {pt, J, neff: 1 / s2, coh: Math.hypot(...mean) / Math.max(den, 1e-12), n};
    }

    const M = {meta, N, NM, xyz, quat, logs, col, alpha, update, select, jacobian, project,
               z: null};
    return M;
  }

  // ── rendu WebGL2 ─────────────────────────────────────────────────────────────
  const VS = `#version 300 es
  precision highp float; precision highp int;
  layout(location=0) in vec2 corner;
  layout(location=1) in uint gid;
  uniform highp sampler2D data;
  uniform mat4 view;              // monde -> camera (colonnes)
  uniform vec4 intr;              // fx, fy, cx, cy
  uniform vec2 size;
  uniform vec2 nf;                // near, far
  out vec2 vD; flat out vec3 vCon; flat out float vA; flat out vec3 vC;
  void main(){
    int i = int(gid);
    ivec2 b = ivec2((i & 1023) * 4, i >> 10);
    vec4 t0 = texelFetch(data, b, 0), t1 = texelFetch(data, b + ivec2(1, 0), 0);
    vec4 t2 = texelFetch(data, b + ivec2(2, 0), 0), t3 = texelFetch(data, b + ivec2(3, 0), 0);
    vec4 pc = view * vec4(t0.xyz, 1.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    if (pc.z < nf.x || pc.z > nf.y) return;
    float fx = intr.x, fy = intr.y, cx = intr.z, cy = intr.w;
    float tfx = 0.5 * size.x / fx, tfy = 0.5 * size.y / fy;
    float lxp = (size.x - cx) / fx + 0.3 * tfx, lxn = cx / fx + 0.3 * tfx;
    float lyp = (size.y - cy) / fy + 0.3 * tfy, lyn = cy / fy + 0.3 * tfy;
    float tx = pc.z * clamp(pc.x / pc.z, -lxn, lxp), ty = pc.z * clamp(pc.y / pc.z, -lyn, lyp);
    float iz = 1.0 / pc.z;
    mat3 Jm = mat3(fx * iz, 0.0, 0.0,  0.0, fy * iz, 0.0,  -fx * tx * iz * iz, -fy * ty * iz * iz, 0.0);
    mat3 S = mat3(t1.x, t1.y, t1.z,  t1.y, t1.w, t2.x,  t1.z, t2.x, t2.y);
    mat3 R = mat3(view);
    mat3 C = Jm * R * S * transpose(R) * transpose(Jm);
    float a = C[0][0] + 0.3, bb = C[0][1], d = C[1][1] + 0.3;
    float det = a * d - bb * bb;
    if (det <= 0.0) return;
    float mid = 0.5 * (a + d), lmax = mid + sqrt(max(0.1, mid * mid - det));
    float rad = ceil(3.0 * sqrt(lmax));
    vec2 m = vec2(fx * pc.x * iz + cx, fy * pc.y * iz + cy);
    vec2 dd = corner * rad;
    vD = dd; vCon = vec3(d / det, -bb / det, a / det); vA = t0.w; vC = t3.xyz;
    vec2 p = m + dd;
    gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  }`;
  const FS = `#version 300 es
  precision highp float;
  in vec2 vD; flat in vec3 vCon; flat in float vA; flat in vec3 vC;
  out vec4 o;
  void main(){
    float sig = 0.5 * (vCon.x * vD.x * vD.x + vCon.z * vD.y * vD.y) + vCon.y * vD.x * vD.y;
    if (sig < 0.0) discard;
    float a = min(0.99, vA * exp(-sig));
    if (a < 1.0 / 255.0) discard;
    o = vec4(vC * a, a);
  }`;
  const VS2 = `#version 300 es
  layout(location=0) in vec2 p; out vec2 uv;
  void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS2 = `#version 300 es
  precision highp float; in vec2 uv; uniform sampler2D t; uniform vec3 bg;
  uniform mat3 cA; uniform vec3 cb; out vec4 o;
  // correction de couleur de la camera (train_dec3d_zoned.py, color1) : clamp(A rgb + b) sur
  // l'image composee sur fond noir, comme a l'entrainement ; le fond est ajoute apres
  void main(){ vec4 c = texture(t, uv); o = vec4(clamp(cA * c.rgb + cb, 0.0, 1.0) + (1.0 - c.a) * bg, 1.0); }`;

  function prog(gl, vs, fs) {
    const mk = (t, s) => { const h = gl.createShader(t); gl.shaderSource(h, s); gl.compileShader(h);
      if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function renderer(canvas, M) {
    const gl = canvas.getContext('webgl2', {antialias: false, premultipliedAlpha: false,
                                            preserveDrawingBuffer: true});
    if (!gl) throw new Error('WebGL2 indisponible');
    const pS = prog(gl, VS, FS), pB = prog(gl, VS2, FS2);
    const fl = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    const N = M.N, rows = Math.ceil(N / 1024), TW = 4096;
    const tdata = new Float32Array(TW * rows * 4);
    const dtex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dtex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TW, rows, 0, gl.RGBA, gl.FLOAT, null);

    function packOne(g) {
      const o = ((g >> 10) * TW + (g & 1023) * 4) * 4;
      const q = M.quat, w = q[4 * g], x = q[4 * g + 1], y = q[4 * g + 2], z = q[4 * g + 3];
      const R = [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
                 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
                 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
      const s = [Math.exp(2 * M.logs[3 * g]), Math.exp(2 * M.logs[3 * g + 1]), Math.exp(2 * M.logs[3 * g + 2])];
      const S = (i, j) => R[3 * i] * s[0] * R[3 * j] + R[3 * i + 1] * s[1] * R[3 * j + 1] + R[3 * i + 2] * s[2] * R[3 * j + 2];
      tdata[o] = M.xyz[3 * g]; tdata[o + 1] = M.xyz[3 * g + 1]; tdata[o + 2] = M.xyz[3 * g + 2]; tdata[o + 3] = M.alpha[g];
      tdata[o + 4] = S(0, 0); tdata[o + 5] = S(0, 1); tdata[o + 6] = S(0, 2); tdata[o + 7] = S(1, 1);
      tdata[o + 8] = S(1, 2); tdata[o + 9] = S(2, 2);
      tdata[o + 12] = M.col[3 * g]; tdata[o + 13] = M.col[3 * g + 1]; tdata[o + 14] = M.col[3 * g + 2];
    }
    for (let g = 0; g < N; g++) packOne(g);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, rows, gl.RGBA, gl.FLOAT, tdata);
    const mrows = Math.ceil(M.NM / 1024);

    let ttex = null, fb = null, tw = 0, th = 0;
    function target(w, h) {
      if (w === tw && h === th) return;
      tw = w; th = h;
      ttex = ttex || gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, ttex);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
      if (fl) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      fb = fb || gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ttex, 0);
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ob = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ob);
    gl.bufferData(gl.ARRAY_BUFFER, N * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    const vb = gl.createVertexArray();
    gl.bindVertexArray(vb);
    const tb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // tri par profondeur camera : comptage sur 16 bits (O(N))
    const depth = new Float32Array(N), key = new Uint16Array(N), order = new Uint32Array(N);
    const cnt = new Uint32Array(65537);
    function sortByDepth(E) {
      let lo = Infinity, hi = -Infinity;
      for (let g = 0; g < N; g++) {
        const d = E[2][0] * M.xyz[3 * g] + E[2][1] * M.xyz[3 * g + 1] + E[2][2] * M.xyz[3 * g + 2] + E[2][3];
        depth[g] = d;
        if (d > 0) { if (d < lo) lo = d; if (d > hi) hi = d; }
      }
      const sc = 65535 / Math.max(hi - lo, 1e-9);
      cnt.fill(0);
      for (let g = 0; g < N; g++) {
        const k = depth[g] > 0 ? Math.min(65535, Math.max(0, ((depth[g] - lo) * sc) | 0)) : 65535;
        key[g] = k; cnt[k + 1]++;
      }
      for (let k = 0; k < 65536; k++) cnt[k + 1] += cnt[k];
      for (let g = 0; g < N; g++) order[cnt[key[g]]++] = g;
    }

    let dirty = true;
    function refresh() {
      // re-ecrit les lignes des gaussiennes mobiles (apres M.update)
      for (let g = 0; g < M.NM; g++) packOne(g);
      gl.bindTexture(gl.TEXTURE_2D, dtex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, mrows, gl.RGBA, gl.FLOAT, tdata.subarray(0, TW * mrows * 4));
      dirty = true;
    }

    function draw(cam, bg) {
      const W = cam.W, H = cam.H;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      target(W, H);
      sortByDepth(cam.E);
      gl.bindBuffer(gl.ARRAY_BUFFER, ob);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, order);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pS);
      const E = cam.E, K = cam.K;
      gl.uniformMatrix4fv(gl.getUniformLocation(pS, 'view'), false, new Float32Array([
        E[0][0], E[1][0], E[2][0], 0, E[0][1], E[1][1], E[2][1], 0,
        E[0][2], E[1][2], E[2][2], 0, E[0][3], E[1][3], E[2][3], 1]));
      gl.uniform4f(gl.getUniformLocation(pS, 'intr'), K[0][0], K[1][1], K[0][2], K[1][2]);
      gl.uniform2f(gl.getUniformLocation(pS, 'size'), W, H);
      gl.uniform2f(gl.getUniformLocation(pS, 'nf'), M.meta.near, M.meta.far);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dtex);
      gl.uniform1i(gl.getUniformLocation(pS, 'data'), 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, N);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pB);
      gl.bindVertexArray(vb);
      gl.bindTexture(gl.TEXTURE_2D, ttex);
      gl.uniform1i(gl.getUniformLocation(pB, 't'), 0);
      const b = bg || [0, 0, 0];
      gl.uniform3f(gl.getUniformLocation(pB, 'bg'), b[0], b[1], b[2]);
      const A = cam.color ? cam.color.A : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const cb = cam.color ? cam.color.b : [0, 0, 0];
      gl.uniformMatrix3fv(gl.getUniformLocation(pB, 'cA'), false, new Float32Array([
        A[0][0], A[1][0], A[2][0], A[0][1], A[1][1], A[2][1], A[0][2], A[1][2], A[2][2]]));
      gl.uniform3f(gl.getUniformLocation(pB, 'cb'), cb[0], cb[1], cb[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      dirty = false;
    }
    return {draw, refresh, gl, floatTarget: !!fl};
  }

  root.Zoned3D = {load, renderer};
})(typeof window !== 'undefined' ? window : this);
