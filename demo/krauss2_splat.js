/*
 * krauss2_splat.js — décodeur Gaussian Splatting évalué EN DIRECT dans le navigateur
 * (cas Krauss 2-segments, latent d=4, 15000 gaussiennes).
 *
 * Les onglets d=1 (rocking chair) et d=2 (sac) de lagsplat.html reconstruisent l'image
 * en échantillonnant un atlas de reconstructions pré-décodées (19×19 tuiles pour le
 * sac). En d=4 il en faudrait 19⁴ = 130 321 : l'atlas ne passe pas à l'échelle. Ici on
 * re-rasterise donc les gaussiennes à chaque frame — ce qui coûte MOINS cher (1,8 Mo de
 * blocs de Schur contre 11 Mo de PNG pour le sac) et est EXACT, pas interpolé.
 *
 * Conditionner la gaussienne jointe (x, y, q) ∈ ℝ^{2+d} sur l'état q donne une
 * gaussienne 2D en forme close, valable en toute dimension d :
 *
 *     μ(q)   = μ_xy + Σ_xz Σ_zz⁻¹ (q − μ_z)          (AFFINE en q)
 *     Σ_cond = Σ_xx − Σ_xz Σ_zz⁻¹ Σ_zxᵀ              (INDÉPENDANTE de q)
 *     w_z(q) = exp(−½ (q−μ_z)ᵀ Σ_zz⁻¹ (q−μ_z))       (poids d'opacité)
 *
 * Tout cela tient dans le VERTEX SHADER, `q` étant un uniform : le CPU n'a rien à
 * recalculer par frame, la carte fait les 15000 gaussiennes d'un trait.
 *
 * ── Fidélité au décodeur entraîné ────────────────────────────────────────────────
 * Le décodeur a été entraîné sous `gsplat.rasterization` : reproduire « une gaussienne
 * 2D » ne suffit pas, il faut sa recette exacte. Elle a été fixée par MESURE contre des
 * rendus gsplat de référence (demo_Lags/check_krauss2_splat.py, 8 états latents) :
 *
 *   - covariance en pixels : gsplat projette une gaussienne 3D « pancake »
 *     block_diag(Σ_cond + 1e-5·I, ε_z) par une caméra fictive de focales (W, H) à Z = 1,
 *     d'où un terme radial ε_z·(W·x)(H·y) en plus de W²Σ_cond ; puis ajoute son flou
 *     d'anticrénelage EPS2D = 0.3 px² sur la diagonale ;
 *   - opacité : clamp(α · w_z, 0, 0.99) ;
 *   - compositing : front-to-back « over », dans l'ordre d'INDEX. Toutes les gaussiennes
 *     sont posées à Z = 1.0 EXACTEMENT (models_2pt.py) ⟹ le tri par profondeur de gsplat
 *     est une égalité parfaite et l'ordre effectif est celui du tableau.
 *
 *   Mesures (PSNR contre gsplat) : recette ci-dessus 46.5 dB · sans EPS2D 38.2 dB ·
 *   sans le terme pancake 43.7 dB · en ORDRE INVERSÉ 15.2 dB. Les 31 dB d'écart entre
 *   ordre direct et ordre inverse sont ce qui établit l'hypothèse d'ordre.
 *
 * Le compositing « over » front-to-back s'obtient sans aucun tri, par le blending
 * `(ONE_MINUS_DST_ALPHA, ONE)` : le canal alpha de destination accumule 1 − T, donc
 * (1 − dst.a) EST la transmittance restante. OpenGL garantit l'ordre des primitives
 * dans le blending, et les instances sont traitées dans l'ordre — rien à trier.
 *
 * ⚠️ ESPACE : `render(z)` attend l'état latent BRUT z (celui de μ_z), PAS le u blanchi
 * du LNN. Passer par Krauss2LNN.toZ().
 *
 * API :
 *   const S = Krauss2Splat.create(canvas, buffer, meta);   // buffer = ArrayBuffer du .bin
 *   S.render(z);        // z : Float64Array/Array (d)
 *   S.resize();
 *   S.select(z, x, y)       // saisie : paquet de gaussiennes figé (ancrage matériel)
 *   S.pointOf(z, sel)       // position COURANTE du point matériel saisi
 *   S.presence(z, sel)      // ∈[0,1] : ce qu'il reste de la matière saisie à cet état
 *   S.jacobianAt(z, x, y)   // Jᵀ moyen au point image (x,y) ∈ [0,1]², sans ancrage
 */
(function (root) {
  'use strict';

  // Constantes de la recette gsplat (cf. en-tête ; ne pas toucher sans reprendre
  // check_krauss2_splat.py, elles sont mesurées, pas choisies).
  const EPS2D = 0.3;      // flou d'anticrénelage de gsplat, en px²
  const EPS_Z = 1e-5;     // épaisseur de la gaussienne « pancake » selon Z
  const S_FLOOR = 1e-5;   // plancher SPD ajouté à Σ_cond avant décomposition
  const CUTOFF = 3.0;     // rayon de coupe, en σ
  const STRIDE_BYTES = 31 * 4;

  const VERT = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aCorner;      // coin du quad, ∈ {−1,+1}²
  layout(location=1) in vec2 aMu;          // μ_xy
  layout(location=2) in vec4 aMz;          // μ_z
  layout(location=3) in vec4 aSxz0;        // (Σ_xz Σ_zz⁻¹) ligne x
  layout(location=4) in vec4 aSxz1;        // (Σ_xz Σ_zz⁻¹) ligne y
  layout(location=5) in vec4 aSzziA;       // Σ_zz⁻¹ : 00,01,02,03
  layout(location=6) in vec4 aSzziB;       //          11,12,13,22
  layout(location=7) in vec2 aSzziC;       //          23,33
  layout(location=8) in vec3 aScondInv;    // Σ_cond⁻¹ : (a,b,c)
  layout(location=9) in float aAlpha;
  layout(location=10) in vec3 aColor;

  uniform vec4 uQ;        // état latent BRUT z
  uniform vec2 uSize;     // (W, H) en pixels de rendu

  out vec3 vColor;
  out float vOpacity;
  out vec3 vConic;        // Σ_2d⁻¹ : (a, b, c)
  out vec2 vDelta;        // écart au centre, en pixels

  void main() {
    vec4 dz = uQ - aMz;

    // w_z = exp(−½ dzᵀ Σ_zz⁻¹ dz)  (Σ_zz⁻¹ symétrique, stockée en triangle supérieur)
    float qf = aSzziA.x*dz.x*dz.x + aSzziB.x*dz.y*dz.y
             + aSzziB.w*dz.z*dz.z + aSzziC.y*dz.w*dz.w
             + 2.0*(aSzziA.y*dz.x*dz.y + aSzziA.z*dz.x*dz.z + aSzziA.w*dz.x*dz.w
                  + aSzziB.y*dz.y*dz.z + aSzziB.z*dz.y*dz.w + aSzziC.x*dz.z*dz.w);
    float wz = exp(-0.5 * min(qf, 20.0));
    float op = clamp(aAlpha * wz, 0.0, 0.99);

    vec2 mu = aMu + vec2(dot(aSxz0, dz), dot(aSxz1, dz));

    // Σ_cond depuis son inverse (2×2 en forme close) + plancher SPD de gsplat
    float ia = aScondInv.x, ib = aScondInv.y, ic = aScondInv.z;
    float idet = ia*ic - ib*ib;
    float c00 =  ic/idet + ${S_FLOOR.toExponential()};
    float c01 = -ib/idet;
    float c11 =  ia/idet + ${S_FLOOR.toExponential()};

    // Projection par la caméra fictive (focales (W,H), Z = 1) + flou d'anticrénelage
    float X = (mu.x - 0.5) * uSize.x;
    float Y = (mu.y - 0.5) * uSize.y;
    float s00 = uSize.x*uSize.x*c00 + ${EPS_Z.toExponential()}*X*X + ${EPS2D.toFixed(4)};
    float s01 = uSize.x*uSize.y*c01 + ${EPS_Z.toExponential()}*X*Y;
    float s11 = uSize.y*uSize.y*c11 + ${EPS_Z.toExponential()}*Y*Y + ${EPS2D.toFixed(4)};

    float det = s00*s11 - s01*s01;
    // Gaussienne évanouie ou covariance dégénérée : quad nul, rien n'est rasterisé.
    if (op < 0.0039 || det <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vOpacity = 0.0; vColor = vec3(0.0); vConic = vec3(1.0, 0.0, 1.0); vDelta = vec2(0.0);
      return;
    }
    vConic = vec3(s11/det, -s01/det, s00/det);

    // Demi-étendue du quad : ${CUTOFF}σ le long du grand axe (valeur propre max)
    float mid = 0.5*(s00 + s11);
    float rad = sqrt(max(mid*mid - det, 0.0));
    float r = ${CUTOFF.toFixed(1)} * sqrt(max(mid + rad, 1e-12));

    vDelta = aCorner * r;
    vColor = aColor;
    vOpacity = op;

    // Centre en pixels : px = μ_x·W − 0.5 (le centre du pixel i est i + 0.5)
    vec2 px = vec2(mu.x*uSize.x - 0.5, mu.y*uSize.y - 0.5) + vDelta;
    // → NDC. L'axe y de l'image descend, celui de NDC monte.
    gl_Position = vec4(2.0*(px.x + 0.5)/uSize.x - 1.0,
                       1.0 - 2.0*(px.y + 0.5)/uSize.y, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  in vec3 vColor;
  in float vOpacity;
  in vec3 vConic;
  in vec2 vDelta;
  out vec4 fragColor;
  void main() {
    float q = vConic.x*vDelta.x*vDelta.x
            + 2.0*vConic.y*vDelta.x*vDelta.y
            + vConic.z*vDelta.y*vDelta.y;
    if (q > ${(2 * CUTOFF * CUTOFF).toFixed(1)}) discard;
    float a = vOpacity * exp(-0.5*q);
    if (a < 0.0039) discard;
    fragColor = vec4(vColor * a, a);      // prémultiplié : cf. le blending « under »
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader : ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  // ── prise : sélection MATÉRIELLE et pullback d'une force image ──────────────
  // J_k = ∂μ_k/∂z = Σ_xz Σ_zz⁻¹ est CONSTANT par gaussienne (le décodeur est affine en
  // z). Saisir revient donc à choisir UNE FOIS un paquet de gaussiennes et son jacobien
  // moyen ; ce qui bouge ensuite, c'est leur position à l'écran.
  //
  // ⚠️ La sélection est FIGÉE à la prise, et les poids avec elle. Resélectionner à chaque
  // frame les gaussiennes voisines d'un pixel FIXE ferait glisser la prise d'une matière
  // à l'autre pendant que l'objet se déplace sous le curseur — on n'attraperait plus le
  // bout du bras mais « ce qui passe à cet endroit de l'écran ». Avec l'ancrage matériel,
  // `pointOf` rend la position COURANTE du morceau saisi : la flèche part de la matière,
  // et l'écart au curseur (donc la force) se contracte à mesure que l'objet arrive.
  //
  // Fonctions PURES (hors de la closure WebGL) pour être testables sans contexte GL —
  // cf. demo_Lags/check_krauss2_splat.py.

  // Réglages du moyennage, réglables depuis l'UI. Les défauts sont ceux que reproduit
  // check_krauss2_splat.py : ne pas les changer sans rejouer ce test.
  const SEL_DEFAULTS = {
    radius: 0.05,   // rayon de sélection, en fraction de l'image (coupure franche)
    sharp: 3.0,     // décroissance spatiale : σ = radius / sharp. ↑ = prise plus locale
    wzMin: 1e-3,    // présence latente minimale pour participer
    jmin: 0.0,      // mobilité minimale, en fraction du max local de ‖J‖ (0 = filtre off)
  };

  /** Gaussiennes saisies au point image (x,y) à l'état z, avec leurs poids figés.
   *  `opts` : {radius, sharp, wzMin, jmin} (un nombre est accepté comme radius, pour
   *  compatibilité). Retourne {idx, w, wsum, kern, kernsum, J} ou null.
   *
   *  `kern` = opacité × noyau spatial, c'est-à-dire la part du poids qui NE DÉPEND PAS de
   *  l'état : c'est le dénominateur de `presence()`. Le poids complet est w = kern·w_z(z),
   *  et c'est lui qui pondère J̄ et le point matériel.
   *
   *  Le filtre de MOBILITÉ (`jmin`) mérite un mot : ‖J‖ = ‖∂μ/∂z‖ mesure de combien une
   *  gaussienne bouge quand l'état bouge. Le fond de la scène (le portique, la toile
   *  noire) est immobile, donc J ≈ 0 — et il est MAJORITAIRE en nombre. Sans ce filtre, un
   *  clic sur le bras noie la sélection dans du décor, et le point d'application dérive
   *  vers le barycentre de l'image au lieu de suivre la matière qui bouge. Le seuil est
   *  relatif au max de la sélection, donc valable partout sur l'objet. */
  function select(data, meta, z, x, y, opts) {
    const d = meta.d, K = meta.K, st = meta.stride;
    const o_ = (typeof opts === 'number') ? { radius: opts } : (opts || {});
    const radius = o_.radius > 0 ? o_.radius : SEL_DEFAULTS.radius;
    const sharp = o_.sharp > 0 ? o_.sharp : SEL_DEFAULTS.sharp;
    const wzMin = o_.wzMin >= 0 ? o_.wzMin : SEL_DEFAULTS.wzMin;
    const jmin = o_.jmin >= 0 ? o_.jmin : SEL_DEFAULTS.jmin;
    const r2 = radius * radius, sig2 = (radius / sharp) * (radius / sharp);

    // 1er passage : candidats (présence latente, puis rayon image), avec leur mobilité.
    const cand = [], jn = [];
    let jmax = 0;
    for (let k = 0; k < K; k++) {
      const o = k * st;
      const dz = [];
      for (let i = 0; i < d; i++) dz.push(z[i] - data[o + 2 + i]);
      let qf = 0, t = 14;
      for (let i = 0; i < d; i++) {
        for (let j = i; j < d; j++) { qf += (i === j ? 1 : 2) * data[o + t] * dz[i] * dz[j]; t++; }
      }
      const wz = Math.exp(-0.5 * Math.min(qf, 20));
      if (wz < wzMin) continue;                 // gaussienne absente à cet état
      let mx = data[o], my = data[o + 1];
      for (let i = 0; i < d; i++) { mx += dz[i] * data[o + 6 + i]; my += dz[i] * data[o + 6 + d + i]; }
      const dd = (mx - x) * (mx - x) + (my - y) * (my - y);
      if (dd > r2) continue;
      let jj = 0;
      for (let i = 0; i < 2 * d; i++) { const v = data[o + 6 + i]; jj += v * v; }
      jj = Math.sqrt(jj);
      if (jj > jmax) jmax = jj;
      cand.push([k, wz, dd]); jn.push(jj);
    }
    if (!cand.length) return null;

    // 2e passage : filtre de mobilité (relatif), puis poids et moyennes.
    const thr = jmin * jmax;
    const idx = [], ws = [], kern = [];
    const J = new Float64Array(2 * d);
    let wsum = 0, kernsum = 0;
    for (let n = 0; n < cand.length; n++) {
      if (jmin > 0 && jn[n] <= thr) continue;
      const k = cand[n][0], wz = cand[n][1], dd = cand[n][2], o = k * st;
      // noyau de sélection : opacité × décroissance spatiale (figées) × présence w_z
      const kn = data[o + 27] * Math.exp(-0.5 * dd / sig2);
      const w = kn * wz;
      idx.push(k); ws.push(w); kern.push(kn); wsum += w; kernsum += kn;
      for (let i = 0; i < d; i++) { J[i] += w * data[o + 6 + i]; J[d + i] += w * data[o + 6 + d + i]; }
    }
    if (wsum <= 0) return null;                 // le filtre a tout mangé : rien à saisir
    for (let i = 0; i < 2 * d; i++) J[i] /= wsum;
    return { idx: Int32Array.from(idx), w: Float64Array.from(ws), wsum,
             kern: Float64Array.from(kern), kernsum, J };
  }

  /** Présence de la matière saisie à l'état z : moyenne de w_z sur la sélection, pondérée
   *  par la part figée du noyau. Vaut 1 si toutes les gaussiennes saisies sont pleinement
   *  là, tend vers 0 quand elles s'effacent.
   *
   *  ⚠️ Sans ce facteur, l'amplitude de la force NE DÉPEND PAS de la présence : J̄ est une
   *  moyenne NORMALISÉE (division par Σw), donc le Σw se simplifie et saisir un filament
   *  quasi transparent tire aussi fort que saisir de la matière franche. Et comme les
   *  poids sont figés à la prise, l'extinction ultérieure des gaussiennes saisies serait
   *  invisible pour la force. `sel.wsum/sel.kernsum` est sa valeur à l'instant de la
   *  prise, ce qui permet à l'appelant d'en faire un rapport. */
  function presence(data, meta, z, sel) {
    const d = meta.d, st = meta.stride;
    let acc = 0;
    for (let n = 0; n < sel.idx.length; n++) {
      const o = sel.idx[n] * st;
      let qf = 0, t = 14;
      const dz = [];
      for (let i = 0; i < d; i++) dz.push(z[i] - data[o + 2 + i]);
      for (let i = 0; i < d; i++) {
        for (let j = i; j < d; j++) { qf += (i === j ? 1 : 2) * data[o + t] * dz[i] * dz[j]; t++; }
      }
      acc += sel.kern[n] * Math.exp(-0.5 * Math.min(qf, 20));
    }
    return acc / sel.kernsum;
  }

  /** Position image du point matériel `sel` à l'état z : moyenne des μ_k(z) aux poids
   *  FIGÉS de la sélection. C'est elle qui suit les gaussiennes. */
  function pointOf(data, meta, z, sel) {
    const d = meta.d, st = meta.stride;
    let px = 0, py = 0;
    for (let n = 0; n < sel.idx.length; n++) {
      const o = sel.idx[n] * st, w = sel.w[n];
      let mx = data[o], my = data[o + 1];
      for (let i = 0; i < d; i++) {
        const dzi = z[i] - data[o + 2 + i];
        mx += dzi * data[o + 6 + i]; my += dzi * data[o + 6 + d + i];
      }
      px += w * mx; py += w * my;
    }
    return [px / sel.wsum, py / sel.wsum];
  }

  /** Jacobien moyen au point image (x,y) — sélection immédiate, sans ancrage. */
  function jacobianAt(data, meta, z, x, y, opts) {
    const s = select(data, meta, z, x, y, opts);
    return s ? s.J : null;
  }

  function create(canvas, buffer, meta) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, antialias: false, premultipliedAlpha: true,
    });
    if (!gl) throw new Error('WebGL2 indisponible');

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link : ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    const uQ = gl.getUniformLocation(prog, 'uQ');
    const uSize = gl.getUniformLocation(prog, 'uSize');

    const data = new Float32Array(buffer);
    const K = meta.K;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // quad unité, partagé par toutes les instances
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Les 31 float32 par gaussienne sont lus TELS QUELS depuis le .bin : la disposition
    // du fichier (cf. extract_krauss2.py LAYOUT) est déjà celle des attributs, aucun
    // ré-empaquetage CPU.
    const gbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gbuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attrs = [
      [1, 2, 0], [2, 4, 8], [3, 4, 24], [4, 4, 40], [5, 4, 56],
      [6, 4, 72], [7, 2, 88], [8, 3, 96], [9, 1, 108], [10, 3, 112],
    ];
    for (const [loc, n, off] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, STRIDE_BYTES, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // « under » : dst.rgb += (1−dst.a)·src.rgb ; dst.a += (1−dst.a)·src.a.
    // (1−dst.a) est la transmittance restante ⟹ compositing front-to-back exact, sans tri.
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE,
                         gl.ONE_MINUS_DST_ALPHA, gl.ONE);

    function resize() {
      const w = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
      const h = Math.max(1, Math.round(canvas.clientHeight * (window.devicePixelRatio || 1)));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    /** Viewport CARRÉ centré : le décodeur rend en coordonnées normalisées [0,1]², donc
     *  une image carrée. Étirer ce carré sur un panneau large déformerait le bras. Le
     *  reste du canevas est laissé au noir — la couleur de fond sur laquelle le décodeur
     *  a été entraîné, donc la bande n'introduit aucune discontinuité visible. */
    function box() {
      const side = Math.min(canvas.width, canvas.height);
      return { side, x: Math.round((canvas.width - side) / 2),
               y: Math.round((canvas.height - side) / 2) };
    }

    /** Point du canevas en fraction [0,1]² → point de l'IMAGE en [0,1]² (défait la
     *  bande noire). Renvoie null hors de l'image, SAUF si `outside` : attraper la bande
     *  ne saisit rien, mais une fois la prise faite le curseur a le droit d'en sortir. */
    function toImage(cx, cy, outside) {
      const b = box();
      const x = (cx * canvas.width - b.x) / b.side;
      const y = (cy * canvas.height - b.y) / b.side;
      if (!outside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
      return [x, y];
    }

    /** Inverse de `toImage` : point de l'IMAGE → fraction du canevas (pour dessiner). */
    function fromImage(ix, iy) {
      const b = box();
      return [(b.x + ix * b.side) / canvas.width, (b.y + iy * b.side) / canvas.height];
    }

    function render(z) {
      resize();
      const b = box();
      // Alpha = 0 au départ : c'est dst.a qui porte 1 − T pendant l'accumulation. Le
      // canevas est posé sur un fond noir en CSS (celui du décodeur entraîné).
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(b.x, b.y, b.side, b.side);
      gl.useProgram(prog);
      gl.uniform4f(uQ, z[0], z[1], z[2], z[3]);
      gl.uniform2f(uSize, b.side, b.side);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, K);
      gl.bindVertexArray(null);
    }

    return { gl, render, resize, toImage, fromImage, box, K,
             select: (z, x, y, opts) => select(data, meta, z, x, y, opts),
             pointOf: (z, sel) => pointOf(data, meta, z, sel),
             presence: (z, sel) => presence(data, meta, z, sel),
             jacobianAt: (z, x, y, opts) => jacobianAt(data, meta, z, x, y, opts) };
  }

  root.Krauss2Splat = { create, select, pointOf, presence, jacobianAt,
                        SEL_DEFAULTS, EPS2D, EPS_Z, CUTOFF };
})(typeof window !== 'undefined' ? window : globalThis);
