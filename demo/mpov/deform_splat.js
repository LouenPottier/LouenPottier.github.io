/*
 * deform_splat.js : decodeur 2D a deformation PARTAGEE (models_deform.SharedDeformSplatDecoder)
 * evalue dans le navigateur, sans gsplat.
 *
 *   z = (q0, q1, s)  ->  Fourier  ->  MLP (SiLU)  ->  K x 9 sorties
 *   mu    = mu0 + tanh(o[0:2]) * dmu          centre, coordonnees normalisees
 *   prof  = prof0 + tanh(o[2]) * dprof        profondeur : ORDRE de compositing
 *   s     = scale_min + softplus(logs0 + tanh(o[3:5]) * dlogs)
 *   theta = theta0 + tanh(o[5]) * dtheta
 *   color = sigmoid(color0 + tanh(o[6:9]) * dcolor)
 *   alpha constante (canonique)
 *
 * Rendu : recette de gsplat.rasterization telle que l'appelle forward() :
 *   - caméra fictive de focales (W, H), point principal (W/2, H/2), gaussienne 3D en
 *     ((mu - 1/2) Z, Z) avec Z = 1 + prof, demi-axes monde s Z et eps_z sur l'axe optique ;
 *     le centre projete vaut donc (W mu_x, H mu_y), independant de Z ;
 *   - covariance image J Sigma J^T, J jacobien de la projection (tx, ty bornes comme gsplat),
 *     plus eps2d = 0.3 px^2 sur la diagonale ;
 *   - alpha = min(0.99, opacite * exp(-1/2 d^T Sigma^-1 d)), ignoree sous 1/255 ;
 *   - compositing front-to-back par profondeur croissante, fond noir.
 * Le MLP tourne sur le CPU (128 x 9 K multiplications pour la tete), le rendu en WebGL2.
 *
 * API :
 *   const D = DeformSplat.load(window.MPOV_DEC2D[name]);   // decodage des poids
 *   const st = D.state([q0, q1, s]);                       // etat de toutes les gaussiennes
 *   const R = DeformSplat.renderer(canvas, D);             // contexte WebGL2
 *   R.draw(st);
 *   D.select(st, x, y, radius, uniform)  -> {idx, w, ws}    // saisie (px image)
 *   D.jacobian(z, sel, h)                -> {pt, J, neff, coh}
 */
(function (root) {
  'use strict';

  function b64ToBytes(b64) {
    const bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function half2float(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  function load(pack) {
    const meta = pack.meta, bytes = b64ToBytes(pack.b64), buf = bytes.buffer;
    const P = {};
    for (const p of meta.parts) {
      const n = p.shape.reduce((a, b) => a * b, 1);
      if (p.dtype === 'f32') P[p.name] = new Float32Array(buf, p.off, n);
      else if (p.dtype === 'i8') P[p.name] = new Int8Array(buf, p.off, n);
      else if (p.dtype === 'f16') {
        const h = new Uint16Array(buf, p.off, n), f = new Float32Array(n);
        for (let i = 0; i < n; i++) f[i] = half2float(h[i]);
        P[p.name] = f;
      }
      P[p.name + '.shape'] = p.shape;
    }
    const K = meta.K, NO = meta.n_out, HID = meta.hidden;
    // tete en float32 une fois pour toutes (int8 * echelle par ligne)
    let HW = P['head.w'];
    if (meta.quant === 'int8') {
      const q = HW, s = P['head.s'], f = new Float32Array(q.length);
      for (let r = 0, o = 0; r < K * NO; r++, o += HID) {
        const sr = s[r];
        for (let c = 0; c < HID; c++) f[o + c] = q[o + c] * sr;
      }
      HW = f;
    }
    const body = [];
    for (let i = 0; P['body' + i + '.w']; i++)
      body.push({w: P['body' + i + '.w'], b: P['body' + i + '.b'],
                 out: P['body' + i + '.w.shape'][0], inp: P['body' + i + '.w.shape'][1]});
    const C = P.canon, B = meta.bounds;
    const D = {meta, K, W: meta.W, H: meta.H, body, HW, HB: P['head.b'], canon: C};

    // ── MLP : z -> couche cachee finale (HID) ──
    function hiddenOf(z) {
      const nf = meta.pe_cond, d = z.length;
      let h;
      if (nf > 0) {
        h = new Float32Array(d * (1 + 2 * nf));
        for (let i = 0; i < d; i++) h[i] = z[i];
        for (let i = 0; i < d; i++)
          for (let k = 0; k < nf; k++) {
            const a = z[i] * Math.pow(2, k) * Math.PI;
            h[d + i * nf + k] = Math.sin(a);
            h[d + d * nf + i * nf + k] = Math.cos(a);
          }
      } else h = Float32Array.from(z);
      for (const L of body) {
        const o = new Float32Array(L.out);
        for (let r = 0; r < L.out; r++) {
          let acc = L.b[r];
          const wr = r * L.inp;
          for (let c = 0; c < L.inp; c++) acc += L.w[wr + c] * h[c];
          o[r] = acc / (1 + Math.exp(-acc));          // SiLU
        }
        h = o;
      }
      return h;
    }
    D.hiddenOf = hiddenOf;

    // sorties brutes de la tete pour les gaussiennes `idx` (toutes si null)
    function headOut(h, idx, out) {
      const n = idx ? idx.length : K;
      out = out || new Float32Array(n * NO);
      for (let j = 0; j < n; j++) {
        const g = idx ? idx[j] : j;
        for (let p = 0; p < NO; p++) {
          const r = g * NO + p, wr = r * HID;
          let acc = D.HB[r];
          for (let c = 0; c < HID; c++) acc += HW[wr + c] * h[c];
          out[j * NO + p] = acc;
        }
      }
      return out;
    }
    D.headOut = headOut;

    const sp = x => (x > 20 ? x : Math.log1p(Math.exp(x)));
    const sg = x => 1 / (1 + Math.exp(-x));
    const raw = new Float32Array(K * NO);
    // etat de toutes les gaussiennes : mu (px), Z, demi-axes (normalises), theta, couleur
    D.state = function (z) {
      headOut(hiddenOf(z), null, raw);
      const st = {mu: new Float32Array(2 * K), Z: new Float32Array(K),
                  s: new Float32Array(2 * K), th: new Float32Array(K),
                  col: new Float32Array(3 * K), z: z.slice()};
      for (let g = 0; g < K; g++) {
        const c = g * 10, o = g * NO;
        st.mu[2 * g] = C[c] + Math.tanh(raw[o]) * B.dmu;
        st.mu[2 * g + 1] = C[c + 1] + Math.tanh(raw[o + 1]) * B.dmu;
        st.Z[g] = 1 + C[c + 2] + Math.tanh(raw[o + 2]) * B.dprof;
        st.s[2 * g] = meta.scale_min + sp(C[c + 3] + Math.tanh(raw[o + 3]) * B.dlogs);
        st.s[2 * g + 1] = meta.scale_min + sp(C[c + 4] + Math.tanh(raw[o + 4]) * B.dlogs);
        st.th[g] = C[c + 5] + Math.tanh(raw[o + 5]) * B.dtheta;
        for (let k = 0; k < 3; k++)
          st.col[3 * g + k] = sg(C[c + 7 + k] + Math.tanh(raw[o + 6 + k]) * B.dcolor);
      }
      return st;
    };
    D.alpha = g => C[g * 10 + 6];

    // centre (px) des gaussiennes `idx` a l'etat z, sans evaluer les autres
    D.centers = function (z, idx) {
      const o = headOut(hiddenOf(z), idx), n = idx.length, out = new Float64Array(2 * n);
      for (let j = 0; j < n; j++) {
        const c = idx[j] * 10;
        out[2 * j] = (C[c] + Math.tanh(o[j * NO]) * B.dmu) * D.W;
        out[2 * j + 1] = (C[c + 1] + Math.tanh(o[j * NO + 1]) * B.dmu) * D.H;
      }
      return out;
    };

    // ── saisie : meme ponderation que serve_deform_demo.py (empreinte x decroissance) ──
    D.select = function (st, x, y, radius, uniform) {
      const idx = [], w = [], ws = [];
      const side = 0.5 * (D.W + D.H);
      // premier plan seulement, comme zoned3d.js : profondeur < 1.15 x la plus petite profondeur
      // des gaussiennes opaques du disque. Sans ce filtre, les gaussiennes de fond (immobiles en q)
      // emportaient jusqu'a 2/3 du poids : le point d'application bougeait ~3 fois moins que la
      // languette (fenetre suiveuse, mesure).
      const r2max = radius * radius;
      let zref = Infinity, zany = Infinity;
      for (let g = 0; g < K; g++) {
        const dx = st.mu[2 * g] * D.W - x, dy = st.mu[2 * g + 1] * D.H - y;
        if (dx * dx + dy * dy > r2max) continue;
        zany = Math.min(zany, st.Z[g]);
        if (D.alpha(g) > 0.2) zref = Math.min(zref, st.Z[g]);
      }
      if (!isFinite(zref)) zref = zany;
      const zcut = zref * 1.15;
      for (let g = 0; g < K; g++) {
        const dx = st.mu[2 * g] * D.W - x, dy = st.mu[2 * g + 1] * D.H - y;
        const r2 = dx * dx + dy * dy;
        if (r2 > r2max || !(st.Z[g] < zcut)) continue;
        const a = D.alpha(g);
        let wi;
        if (uniform) wi = a;
        else {
          const c = Math.cos(st.th[g]), s = Math.sin(st.th[g]);
          const a1 = (c * dx + s * dy) / Math.max(st.s[2 * g] * side, 1e-6);
          const a2 = (-s * dx + c * dy) / Math.max(st.s[2 * g + 1] * side, 1e-6);
          wi = a * Math.exp(-0.5 * (a1 * a1 + a2 * a2))
                 * Math.exp(-0.5 * r2 / (radius * radius / 4));
        }
        idx.push(g); w.push(wi > 1e-4 ? wi : 0); ws.push(a);
      }
      const sw = w.reduce((p, v) => p + v, 0), sws = ws.reduce((p, v) => p + v, 0);
      if (!idx.length || sw <= 0) return null;
      return {idx: Int32Array.from(idx), w: Float64Array.from(w, v => v / sw),
              ws: Float64Array.from(ws, v => v / sws)};
    };

    // point materiel saisi et J = d(point)/dq (px par unite de q), differences centrees
    D.jacobian = function (z, sel, h) {
      h = h || 0.05;
      const n = sel.idx.length, base = D.centers(z, sel.idx);
      const pt = [0, 0];
      for (let j = 0; j < n; j++) { pt[0] += sel.w[j] * base[2 * j]; pt[1] += sel.w[j] * base[2 * j + 1]; }
      const J = [[0, 0], [0, 0]], Ji = new Float64Array(n * 4);
      for (let k = 0; k < 2; k++) {
        const zp = z.slice(), zm = z.slice();
        zp[k] += h; zm[k] -= h;
        const cp = D.centers(zp, sel.idx), cm = D.centers(zm, sel.idx);
        for (let j = 0; j < n; j++) {
          const gx = (cp[2 * j] - cm[2 * j]) / (2 * h), gy = (cp[2 * j + 1] - cm[2 * j + 1]) / (2 * h);
          J[0][k] += sel.w[j] * gx; J[1][k] += sel.w[j] * gy;
          Ji[4 * j + k] = gx; Ji[4 * j + 2 + k] = gy;
        }
      }
      // statistiques de porte (cf. serve_deform_demo.py) : n_eff et coherence en q
      let mean = [0, 0, 0, 0], den = 0, s2 = 0;
      for (let j = 0; j < n; j++) {
        let nr = 0;
        for (let k = 0; k < 4; k++) { mean[k] += sel.ws[j] * Ji[4 * j + k]; nr += Ji[4 * j + k] ** 2; }
        den += sel.ws[j] * Math.sqrt(nr); s2 += sel.ws[j] * sel.ws[j];
      }
      const coh = Math.hypot(...mean) / Math.max(den, 1e-12);
      return {pt, J, neff: 1 / s2, coh, n};
    };
    return D;
  }

  // ── rendu WebGL2 ─────────────────────────────────────────────────────────────
  const VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 corner;
  layout(location=1) in vec4 a0;   // centre px (x, y), conique (a, b)
  layout(location=2) in vec4 a1;   // conique c, demi-etendue px, opacite, -
  layout(location=3) in vec3 a2;   // couleur
  uniform vec2 size;
  out vec2 vD; flat out vec3 vCon; flat out float vA; flat out vec3 vC;
  void main(){
    vec2 d = corner * a1.y;
    vec2 p = a0.xy + d;                    // px image, y vers le bas
    vD = d; vCon = vec3(a0.z, a0.w, a1.x); vA = a1.z; vC = a2;
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
  // recopie de la cible flottante vers le canevas
  const VS2 = `#version 300 es
  layout(location=0) in vec2 p; out vec2 uv;
  void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS2 = `#version 300 es
  precision highp float; in vec2 uv; uniform sampler2D t; out vec4 o;
  void main(){ vec4 c = texture(t, uv); o = vec4(c.rgb, 1.0); }`;

  function prog(gl, vs, fs) {
    const mk = (t, s) => { const h = gl.createShader(t); gl.shaderSource(h, s); gl.compileShader(h);
      if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function renderer(canvas, D) {
    const W = D.W, H = D.H, K = D.K;
    canvas.width = W; canvas.height = H;
    const gl = canvas.getContext('webgl2', {antialias: false, premultipliedAlpha: false,
                                            preserveDrawingBuffer: true});
    if (!gl) throw new Error('WebGL2 indisponible');
    const pS = prog(gl, VS, FS), pB = prog(gl, VS2, FS2);
    const fl = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (fl) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    const STR = 11, inst = new Float32Array(K * STR);
    gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
    for (const [loc, n, off] of [[1, 4, 0], [2, 4, 4], [3, 3, 8]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, STR * 4, off * 4);
      gl.vertexAttribDivisor(loc, 1);
    }
    const vb = gl.createVertexArray();
    gl.bindVertexArray(vb);
    const tb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const order = new Uint32Array(K), keys = new Float32Array(K);
    const epsz2 = D.meta.eps_z * D.meta.eps_z, e2d = D.meta.eps2d;
    // bornes de gsplat sur X/Z, Y/Z : 1.3 x demi-champ (0.5 ici, fx = W, cx = W/2)
    const LIM = 0.5 + 0.3 * 0.5;

    function fill(st) {
      for (let g = 0; g < K; g++) { order[g] = g; keys[g] = st.Z[g]; }
      order.sort((a, b) => keys[a] - keys[b] || a - b);  // profondeur croissante, puis index
      let n = 0;
      for (let i = 0; i < K; i++) {
        const g = order[i], Z = st.Z[g];
        if (!(Z > 0.1 && Z < 5.0)) continue;            // plans near / far de forward()
        const mx = st.mu[2 * g], my = st.mu[2 * g + 1];
        const c = Math.cos(st.th[g]), s = Math.sin(st.th[g]);
        const sx2 = st.s[2 * g] ** 2, sy2 = st.s[2 * g + 1] ** 2;
        // R diag(s^2) R^T, puis diag(W, H) . diag(W, H)
        const r00 = c * c * sx2 + s * s * sy2, r01 = c * s * (sx2 - sy2), r11 = s * s * sx2 + c * c * sy2;
        const tx = Math.max(-LIM, Math.min(LIM, mx - 0.5)), ty = Math.max(-LIM, Math.min(LIM, my - 0.5));
        const jx = -W * tx / Z, jy = -H * ty / Z;
        let a = W * W * r00 + jx * jx * epsz2 + e2d;
        let b = W * H * r01 + jx * jy * epsz2;
        let d = H * H * r11 + jy * jy * epsz2 + e2d;
        const det = a * d - b * b;
        if (!(det > 0)) continue;
        const lmax = 0.5 * (a + d) + Math.sqrt(Math.max(0.1, 0.25 * (a - d) * (a - d) + b * b));
        const o = n * STR;
        inst[o] = mx * W; inst[o + 1] = my * H;
        inst[o + 2] = d / det; inst[o + 3] = -b / det; inst[o + 4] = a / det;
        inst[o + 5] = Math.ceil(3 * Math.sqrt(lmax));
        inst[o + 6] = D.alpha(g); inst[o + 7] = 0;
        inst[o + 8] = st.col[3 * g]; inst[o + 9] = st.col[3 * g + 1]; inst[o + 10] = st.col[3 * g + 2];
        n++;
      }
      return n;
    }

    function draw(st) {
      const n = fill(st);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pS);
      gl.uniform2f(gl.getUniformLocation(pS, 'size'), W, H);
      gl.enable(gl.BLEND);
      // front-to-back « under » : dst += (1 - dst.a) * src (src premultiplie)
      gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, n * STR);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(pB);
      gl.bindVertexArray(vb);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(pB, 't'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return n;
    }
    return {draw, gl, floatTarget: !!fl};
  }

  root.DeformSplat = {load, renderer};
})(typeof window !== 'undefined' ? window : this);
