/*
 * deform_splat.js : COPIE de gs_splat.js (site, demo/gs_splat.js) pour le decodeur a champ
 * de deformation (`DeformSplatDecoder`, code_new_3D/pipeline2_updated/models_deform.py).
 * Repris tels quels : quad instancie, fragment shader, blending « under » front-to-back,
 * cible d'accumulation RGBA16F, resize/box/toImage/fromImage, API create/render/select.
 * Ce qui change :
 *   - les gaussiennes ne sont plus une coupe affine en q : un MLP commun
 *     (position canonique, u) -> deformation leur donne centre, demi-axes et orientation.
 *     Le MLP est evalue sur la carte (une passe par couche, textures RGBA32F) et le vertex
 *     shader lit son resultat par gl_InstanceID ;
 *   - l'ordre des instances est celui de la profondeur (fixe, non deformee), trie a
 *     l'export : avant (bras) puis arriere (fond) ;
 *   - la prise lit les centres courants sur la carte et calcule la jacobienne
 *     d mu / d z des gaussiennes saisies par derivation directe (JVP) du MLP sur CPU.
 * `render(z)` et `select(z, ...)` gardent l'etat BRUT z : le module blanchit lui-meme
 * (u = (z - mean) W, `opts.whiten`), l'entree du champ etant l'espace u du LNN.
 * Assets : demo_Lags/extract_krauss2_deform.py. Verification : check_deform.html.
 *
 * ── en-tete d'origine de gs_splat.js ──────────────────────────────────────────────
 */
/*
 * gs_splat.js — décodeur Gaussian Splatting (2+d)GS évalué EN DIRECT dans le navigateur,
 * générique en la dimension latente d.
 *
 * Utilisé par lagsplat.html pour l'onglet « sac » (d=2, 15 000 gaussiennes) et l'onglet
 * « SCR souple » (d=4, 15 000 gaussiennes). C'était à l'origine krauss2_splat.js, écrit
 * pour d=4 seulement ; le sac lisait alors sa reconstruction dans un ATLAS de 19×19
 * tuiles pré-décodées (sac_frames.png, 11 Mo). Rendre en direct est à la fois plus léger
 * (1,1 Mo de blocs de Schur) et EXACT — la coupe est calculée à l'état courant au lieu
 * d'être interpolée entre les quatre tuiles voisines. En d=4 l'atlas était de toute
 * façon hors de portée : il aurait fallu 19⁴ = 130 321 tuiles.
 *
 * Conditionner la gaussienne jointe (x, y, q) ∈ ℝ^{2+d} sur l'état q donne une
 * gaussienne 2D en forme close, valable en toute dimension d :
 *
 *     μ(q)   = μ_xy + Σ_xz Σ_zz⁻¹ (q − μ_z)          (AFFINE en q)
 *     Σ_cond = Σ_xx − Σ_xz Σ_zz⁻¹ Σ_zxᵀ              (INDÉPENDANTE de q)
 *     w_z(q) = exp(−½ (q−μ_z)ᵀ Σ_zz⁻¹ (q−μ_z))       (poids d'opacité)
 *
 * Tout cela tient dans le VERTEX SHADER, `q` étant un uniform : le CPU n'a rien à
 * recalculer par frame, la carte fait les 15000 gaussiennes d'un trait. Le shader est
 * ENGENDRÉ à partir de d et de la disposition binaire (`meta.layout`) : aucun offset
 * n'est écrit en dur, ni ici ni dans les scripts d'extraction/vérification.
 *
 * ── Fidélité au décodeur entraîné ────────────────────────────────────────────────
 * Le décodeur a été entraîné sous `gsplat.rasterization` : reproduire « une gaussienne
 * 2D » ne suffit pas, il faut sa recette exacte. Elle a été fixée par MESURE contre des
 * rendus gsplat de référence (demo_Lags/check_krauss2_splat.py, 8 états latents par cas) :
 *
 *   - covariance en pixels : gsplat projette une gaussienne 3D « pancake »
 *     block_diag(Σ_cond + 1e-5·I, ε_z) par une caméra fictive de focales (W, H) placée à
 *     Z = 1, d'où un terme radial ε_z·(W·x)(H·y) en plus de W²Σ_cond ; puis ajoute son
 *     flou d'anticrénelage EPS2D = 0.3 px² sur la diagonale ;
 *   - opacité : clamp(α · w_z, 0, 0.99) ;
 *   - compositing : front-to-back « over », dans l'ordre d'INDEX. Toutes les gaussiennes
 *     sont posées à Z = 1.0 EXACTEMENT (models_2pt.py) ⟹ le tri par profondeur de gsplat
 *     est une égalité parfaite et l'ordre effectif est celui du tableau.
 *
 *   Mesures (PSNR contre gsplat, cas d=4) : recette ci-dessus 46.5 dB · sans EPS2D
 *   38.2 dB · sans le terme pancake 43.7 dB · en ORDRE INVERSÉ 15.2 dB. Les 31 dB
 *   d'écart entre ordre direct et ordre inverse sont ce qui établit l'hypothèse d'ordre.
 *
 * Le compositing « over » front-to-back s'obtient sans aucun tri, par le blending
 * `(ONE_MINUS_DST_ALPHA, ONE)` : le canal alpha de destination accumule 1 − T, donc
 * (1 − dst.a) EST la transmittance restante. OpenGL garantit l'ordre des primitives
 * dans le blending, et les instances sont traitées dans l'ordre — rien à trier.
 *
 * ⚠️ ESPACE : `render(z)` attend l'état latent BRUT z (celui de μ_z), PAS le u blanchi
 * du LNN. Passer par <Cas>LNN.toZ().
 *
 * API :
 *   const S = GSSplat.create(canvas, buffer, meta);   // buffer = ArrayBuffer du .bin
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

  // ── disposition binaire ────────────────────────────────────────────────────
  /** Table des offsets (en float32) d'une gaussienne. `meta.layout` fait foi ; à défaut
   *  on la reconstruit pour d — c'est la même que celle des scripts d'extraction. */
  function layoutOf(meta) {
    const d = meta.d;
    if (meta.layout) return meta.layout;
    const lay = {}; let off = 0;
    for (const [name, n] of [['mu_xy', 2], ['mz', d], ['sxz_szzi', 2 * d],
                             ['szzi', d * (d + 1) / 2], ['scond_inv', 3],
                             ['alpha', 1], ['color', 3]]) {
      lay[name] = [off, off + n]; off += n;
    }
    return lay;
  }

  /** Découpe n float consécutifs en attributs de vertex de 4 composantes au plus
   *  (une seule contrainte GLSL) et rend de quoi les déclarer ET les lire :
   *  `chunks` pour vertexAttribPointer, `comp(i)` pour le i-ième float dans le shader. */
  function group(name, base, n, loc0) {
    const chunks = [];
    for (let o = 0; o < n; o += 4) {
      chunks.push({ loc: loc0 + chunks.length, size: Math.min(4, n - o),
                    off: base + o, name: name + chunks.length });
    }
    const decl = chunks.map(c => `  layout(location=${c.loc}) in ` +
      (c.size === 1 ? 'float' : 'vec' + c.size) + ` a_${c.name};`).join('\n');
    const comp = i => chunks[i >> 2].size === 1
      ? `a_${chunks[i >> 2].name}`
      : `a_${chunks[i >> 2].name}.${'xyzw'[i & 3]}`;
    return { chunks, decl, comp };
  }

  /* ── Decodeur a champ de deformation : MLP sur la carte ─────────────────────────
   * Activations : NCH = hidden/4 texels RGBA32F par gaussienne, G gaussiennes par ligne.
   * Un fragment calcule 4 neurones d'une gaussienne. La part position de la premiere
   * couche ne depend pas de l'etat : calculee une fois au chargement. La part etat est la
   * meme pour toutes les gaussiennes : un uniform. La derniere passe (une gaussienne par
   * fragment) applique la tete, les bornes tanh et les parametres canoniques, et ecrit
   * centre et covariance IMAGE normalisee (R diag(s^2) R^T). */
  const G = 64;   // gaussiennes par ligne de texture

  function shaders(meta) {
    const NCH = meta.hidden / 4;
    const LAYER = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D uIn, uW, uB;
  uniform int uFirst;
  uniform vec4 uHc[${NCH}];
  out vec4 frag;
  vec4 silu(vec4 x) { return x / (1.0 + exp(-x)); }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    int gx = p.x / ${NCH};
    int c = p.x - gx * ${NCH};
    int base = gx * ${NCH};
    vec4 acc = texelFetch(uB, ivec2(c, 0), 0);
    for (int i = 0; i < ${NCH}; i++) {
      vec4 a = texelFetch(uIn, ivec2(base + i, p.y), 0);
      if (uFirst == 1) a = silu(a + uHc[i]);
      acc.x += dot(a, texelFetch(uW, ivec2(i, 4*c), 0));
      acc.y += dot(a, texelFetch(uW, ivec2(i, 4*c + 1), 0));
      acc.z += dot(a, texelFetch(uW, ivec2(i, 4*c + 2), 0));
      acc.w += dot(a, texelFetch(uW, ivec2(i, 4*c + 3), 0));
    }
    frag = silu(acc);
  }`;

    // Sorties du champ : [dmu (2), dprof (1, ignoree), dlogs (2), dtheta (1)]
    const HEAD = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  uniform sampler2D uIn, uW, uCanon, uCanon2;
  uniform vec4 uHb0;
  uniform vec2 uHb1;
  uniform float uMaxDmu, uMaxDlogs, uMaxDth, uSmin;
  layout(location=0) out vec4 oA;
  layout(location=1) out vec4 oB;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 o = uHb0;
    vec2 o2 = uHb1;
    for (int i = 0; i < ${NCH}; i++) {
      vec4 a = texelFetch(uIn, ivec2(p.x * ${NCH} + i, p.y), 0);
      o.x += dot(a, texelFetch(uW, ivec2(i, 0), 0));
      o.y += dot(a, texelFetch(uW, ivec2(i, 1), 0));
      o.z += dot(a, texelFetch(uW, ivec2(i, 2), 0));
      o.w += dot(a, texelFetch(uW, ivec2(i, 3), 0));
      o2.x += dot(a, texelFetch(uW, ivec2(i, 4), 0));
      o2.y += dot(a, texelFetch(uW, ivec2(i, 5), 0));
    }
    vec4 c0 = texelFetch(uCanon, p, 0);    // mu0.xy, logs0.xy
    vec4 c2 = texelFetch(uCanon2, p, 0);   // theta0, Z, alpha, -
    vec2 mu = c0.xy + tanh(o.xy) * uMaxDmu;
    vec2 ls = c0.zw + tanh(vec2(o.w, o2.x)) * uMaxDlogs;
    vec2 s = uSmin + max(ls, 0.0) + log(1.0 + exp(-abs(ls)));    // softplus
    float th = c2.x + tanh(o2.y) * uMaxDth;
    float cs = cos(th), sn = sin(th);
    vec2 s2 = s * s;
    oA = vec4(mu, cs*cs*s2.x + sn*sn*s2.y, cs*sn*(s2.x - s2.y));
    oB = vec4(sn*sn*s2.x + cs*cs*s2.y, 0.0, 0.0, 1.0);
  }`;

    // Rendu : meme recette que gs_splat.js, avec la camera fictive de
    // models_deform.forward. Placement a perspective compensee : le centre projete vaut
    // W mu et la covariance xy W^2 Sigma, quelle que soit Z ; seule l'epaisseur eps_z de
    // la gaussienne « pancake » ajoute un terme radial eps_z^2 (W t / Z)^2, t = mu - 1/2
    // borne a 1.3 tan(fov/2) = 0.65 comme dans gsplat.
    const VERT = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  layout(location=0) in vec2 aCorner;      // coin du quad, ∈ {−1,+1}²
  uniform sampler2D uSA, uSB, uCanon2, uColor;
  uniform vec2 uSize;      // (W, H) en pixels de rendu
  uniform float uEpsZ2;

  out vec3 vColor;
  out float vOpacity;
  out vec3 vConic;
  out vec2 vDelta;

  void main() {
    ivec2 t = ivec2(gl_InstanceID % ${G}, gl_InstanceID / ${G});
    vec4 A = texelFetch(uSA, t, 0);
    float c11 = texelFetch(uSB, t, 0).x;
    vec4 c2 = texelFetch(uCanon2, t, 0);
    vec2 mu = A.xy;
    float op = c2.z;
    vec2 tt = clamp(mu - 0.5, -0.65, 0.65) / c2.y;

    float s00 = uSize.x*uSize.x*(A.z + uEpsZ2*tt.x*tt.x) + ${EPS2D.toFixed(4)};
    float s01 = uSize.x*uSize.y*(A.w + uEpsZ2*tt.x*tt.y);
    float s11 = uSize.y*uSize.y*(c11 + uEpsZ2*tt.y*tt.y) + ${EPS2D.toFixed(4)};

    float det = s00*s11 - s01*s01;
    if (op < 0.0039 || det <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vOpacity = 0.0; vColor = vec3(0.0); vConic = vec3(1.0, 0.0, 1.0); vDelta = vec2(0.0);
      return;
    }
    vConic = vec3(s11/det, -s01/det, s00/det);

    float mid = 0.5*(s00 + s11);
    float rad = sqrt(max(mid*mid - det, 0.0));
    float r = ${CUTOFF.toFixed(1)} * sqrt(max(mid + rad, 1e-12));

    vDelta = aCorner * r;
    vColor = texelFetch(uColor, t, 0).rgb;
    vOpacity = op;

    vec2 px = vec2(mu.x*uSize.x - 0.5, mu.y*uSize.y - 0.5) + vDelta;
    gl_Position = vec4(2.0*(px.x + 0.5)/uSize.x - 1.0,
                       1.0 - 2.0*(px.y + 0.5)/uSize.y, 0.0, 1.0);
  }`;

    // Fragment de gs_splat.js ; seule difference, l'opacite par pixel est bornee a 0.999
    // (gsplat) au lieu de l'opacite par gaussienne a 0.99 (models_2pt).
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
    float a = min(0.999, vOpacity * exp(-0.5*q));
    if (a < 0.0039) discard;
    fragColor = vec4(vColor * a, a);      // prémultiplié : cf. le blending « under »
  }`;

    return { VERT, FRAG, LAYER, HEAD };
  }


  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader : ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  // ── prise ─────────────────────────────────────────────────────────────────────
  // Meme contrat que gs_splat.js : select(z, x, y, opts) -> {idx, w, wsum, kern, kernsum,
  // J}, J = d mu / d z moyen (2 x d, ligne x puis ligne y). Differences :
  //   - les centres courants sont relus sur la carte (passe de tete) ;
  //   - seules les gaussiennes du plan AVANT (le bras) sont saisissables ;
  //   - la jacobienne n'est plus une constante par gaussienne : elle est calculee a l'etat
  //     courant, par derivation directe du MLP, sur les NJ gaussiennes de plus fort poids ;
  //   - aucune gaussienne ne s'efface (opacite constante) : presence = 1.
  const SEL_DEFAULTS = { radius: 0.05, sharp: 3.0, wzMin: 1e-3, jmin: 0.0 };
  const NJ = 48;

  const silu = x => x / (1 + Math.exp(-x));
  const dsilu = x => { const s = 1 / (1 + Math.exp(-x)); return s * (1 + x * (1 - s)); };

  /** Encodage de Fourier de models_deform._fourier : [x, sin(2^k pi x), cos(2^k pi x)],
   *  index (dim, freq) aplati dim-majeur. Avec `dx` : derivees par rapport a chaque x_j. */
  function fourier(x, nf, dx) {
    const D = x.length, n = D * (1 + 2 * nf), f = new Float64Array(n);
    for (let i = 0; i < D; i++) f[i] = x[i];
    for (let i = 0; i < D; i++) {
      for (let k = 0; k < nf; k++) {
        const w = Math.pow(2, k) * Math.PI, a = x[i] * w;
        f[D + i * nf + k] = Math.sin(a);
        f[D + D * nf + i * nf + k] = Math.cos(a);
        if (dx) {
          dx[i][D + i * nf + k] = w * Math.cos(a);
          dx[i][D + D * nf + i * nf + k] = -w * Math.sin(a);
        }
      }
    }
    if (dx) for (let i = 0; i < D; i++) dx[i][i] = 1;
    return f;
  }

  /** y = W x (+ b), W (nout, nin) row-major */
  function matvec(W, b, x, nout, nin, out) {
    for (let o = 0; o < nout; o++) {
      let s = b ? b[o] : 0;
      const r = o * nin;
      for (let i = 0; i < nin; i++) s += W[r + i] * x[i];
      out[o] = s;
    }
    return out;
  }

  /** u = (z - mean) W */
  function whitenZ(wh, z) {
    const d = z.length, u = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let s = 0;
      for (let i = 0; i < d; i++) s += (z[i] - wh.mean[i]) * wh.W[i][j];
      u[j] = s;
    }
    return u;
  }

  /** @param opts.maxSide  Plafond, en pixels, du COTE du viewport carre.
   *
   *  Le decodeur a ete ajuste a `meta.img_size` (256 px) : au-dela, on n'obtient
   *  aucun detail de plus, on expose la structure des gaussiennes elles-memes.
   *  L'anticrenelage `eps2d` vaut 0.3 px^2 quelle que soit la resolution, donc
   *  rendre a 768 px donne aux gaussiennes 3x moins de flou RELATIF que celui
   *  avec lequel elles ont ete ajustees — d'ou un rendu « trop net », qui a l'air
   *  d'un defaut de rasterisation alors que c'est une sur-resolution.
   *  Plafonner le backing store et laisser le CSS agrandir le canevas rend
   *  exactement la reconstruction entrainee, affichee plus grand.
   *  Absent ou 0 : aucun plafond (comportement d'origine). */
  // Recopie de la cible d'accumulation vers le canevas. Aucun melange : la texture
  // porte deja des couleurs PREMULTIPLIEES, comme le canevas (premultipliedAlpha).
  const BLIT_VERT = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aCorner;
  out vec2 vUV;
  void main(){ vUV = aCorner*0.5 + 0.5; gl_Position = vec4(aCorner, 0.0, 1.0); }`;
  const BLIT_FRAG = `#version 300 es
  precision highp float;
  uniform sampler2D uTex;
  in vec2 vUV;
  out vec4 frag;
  void main(){ frag = texture(uTex, vUV); }`;

  function create(canvas, buffer, meta, opts) {
    const MAX_SIDE = (opts && opts.maxSide) || 0;
    /* Rapport L/H du viewport. 1 (defaut) = le carre historique.
       Le decodeur rend dans [0,1]^2 : ce rapport dit comment ce carre
       d'IMAGE s'etale a l'ecran. Il vaut 1 quand la source est carree (sac,
       SCR souple) et 16/9 pour le rocking chair, dont les images
       d'entrainement sont un 1280x720 ecrase dans un 256x256 : les afficher
       carrees conserve l'ecrasement. */
    const ASPECT = (opts && opts.aspect > 0) ? opts.aspect : 1;
    const gl = canvas.getContext('webgl2', {
      alpha: true, antialias: false, premultipliedAlpha: true,
    });
    if (!gl) throw new Error('WebGL2 indisponible');

    const d = meta.d, K = meta.K, H = meta.hidden, NCH = H / 4;
    const ROWS = Math.ceil(K / G), AW = G * NCH;
    const WH = opts && opts.whiten;
    if (!WH) throw new Error('opts.whiten requis (blanchiment du LNN)');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float requis');
    const src = shaders(meta);
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('link : ' + gl.getProgramInfoLog(p));
      }
      return p;
    }
    const prog = program(src.VERT, src.FRAG);
    const progL = program(BLIT_VERT, src.LAYER);
    const progH = program(BLIT_VERT, src.HEAD);
    const U = (p, n) => gl.getUniformLocation(p, n);
    const uSize = U(prog, 'uSize');

    // ── tableaux exportes (extract_krauss2_deform.py), deja tries par profondeur ──
    const data = new Float32Array(buffer);
    const arr = name => {
      const [o, sh] = meta.arrays[name];
      return data.subarray(o, o + sh.reduce((a, b) => a * b, 1));
    };
    const nBody = meta.layers - 1;
    const Wc = arr('lin_cond_w'), Wb = [], Bb = [];
    for (let l = 0; l < nBody; l++) { Wb.push(arr('body' + l + '_w')); Bb.push(arr('body' + l + '_b')); }
    const Wh = arr('head_w'), Bh = arr('head_b');
    const mu0 = arr('mu0'), logs0 = arr('logs0'), th0 = arr('theta0');
    const Zd = arr('Z'), alpha = arr('alpha'), color = arr('color');
    const nfc = d * (1 + 2 * meta.pe_cond);

    // Part position de la premiere couche, une fois pour toutes : Hpos[k] = Wp f(mu0_k) + bp
    const Hpos = new Float32Array(AW * ROWS * 4);
    {
      const Wp = arr('lin_pos_w'), Bp = arr('lin_pos_b'), nfp = 2 * (1 + 2 * meta.pe_pos);
      const tmp = new Float64Array(H);
      for (let k = 0; k < K; k++) {
        const f = fourier([mu0[2 * k], mu0[2 * k + 1]], meta.pe_pos);
        matvec(Wp, Bp, f, H, nfp, tmp);
        Hpos.set(tmp, k * H);     // texel (gx*NCH + c, row) : la gaussienne k est contigue
      }
    }

    function ftex(w, h, src) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    function perG(fill) {             // texture G x ROWS, un texel par gaussienne
      const a = new Float32Array(G * ROWS * 4);
      for (let k = 0; k < K; k++) fill(a, 4 * k, k);
      return ftex(G, ROWS, a);
    }
    const tHpos = ftex(AW, ROWS, Hpos);
    const tW = Wb.map(w => ftex(NCH, H, w)), tB = Bb.map(b => ftex(NCH, 1, b));
    const tHead = ftex(NCH, 6, Wh);
    const tCanon = perG((a, o, k) => { a[o] = mu0[2*k]; a[o+1] = mu0[2*k+1];
                                       a[o+2] = logs0[2*k]; a[o+3] = logs0[2*k+1]; });
    const tCanon2 = perG((a, o, k) => { a[o] = th0[k]; a[o+1] = Zd[k]; a[o+2] = alpha[k]; });
    const tColor = perG((a, o, k) => { a[o] = color[3*k]; a[o+1] = color[3*k+1]; a[o+2] = color[3*k+2]; });
    function target(texs) {
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i,
                                                     gl.TEXTURE_2D, t, 0));
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('framebuffer flottant incomplet');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return f;
    }
    const tAct = [ftex(AW, ROWS, null), ftex(AW, ROWS, null)];
    const fAct = tAct.map(t => target([t]));
    const tSA = ftex(G, ROWS, null), tSB = ftex(G, ROWS, null);
    const fState = target([tSA, tSB]);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // quad unité, partagé par toutes les instances (et par les passes plein écran)
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    function bindTex(p, name, unit, t) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(U(p, name), unit);
    }

    // ── evaluation du champ a l'etat z ──
    let lastZ = null, muBuf = null;
    const hc = new Float64Array(H), hc32 = new Float32Array(H);
    function runField(z) {
      if (lastZ && lastZ.every((v, i) => v === z[i])) return;
      lastZ = Array.from(z); muBuf = null;
      const u = whitenZ(WH, z);
      matvec(Wc, null, fourier(u, meta.pe_cond), H, nfc, hc);
      hc32.set(hc);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      gl.useProgram(progL);
      gl.uniform4fv(U(progL, 'uHc[0]') || U(progL, 'uHc'), hc32);
      gl.viewport(0, 0, AW, ROWS);
      let inp = tHpos;
      for (let l = 0; l < nBody; l++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fAct[l % 2]);
        gl.uniform1i(U(progL, 'uFirst'), l === 0 ? 1 : 0);
        bindTex(progL, 'uIn', 0, inp);
        bindTex(progL, 'uW', 1, tW[l]);
        bindTex(progL, 'uB', 2, tB[l]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        inp = tAct[l % 2];
      }
      gl.useProgram(progH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fState);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, G, ROWS);
      bindTex(progH, 'uIn', 0, inp);
      bindTex(progH, 'uW', 1, tHead);
      bindTex(progH, 'uCanon', 2, tCanon);
      bindTex(progH, 'uCanon2', 3, tCanon2);
      gl.uniform4f(U(progH, 'uHb0'), Bh[0], Bh[1], Bh[2], Bh[3]);
      gl.uniform2f(U(progH, 'uHb1'), Bh[4], Bh[5]);
      gl.uniform1f(U(progH, 'uMaxDmu'), meta.max_dmu);
      gl.uniform1f(U(progH, 'uMaxDlogs'), meta.max_dlogs);
      gl.uniform1f(U(progH, 'uMaxDth'), meta.max_dtheta);
      gl.uniform1f(U(progH, 'uSmin'), meta.scale_min);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(null);
    }

    /** Etat deforme relu sur la carte : attachement 0 (mu, c00, c01) ou 1 (c11, ...) */
    function readState(z, which) {
      runField(z);
      const out = new Float32Array(G * ROWS * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fState);
      gl.readBuffer(which ? gl.COLOR_ATTACHMENT1 : gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, G, ROWS, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    }
    function centers(z) {
      runField(z);
      if (!muBuf) muBuf = readState(z, 0);
      return muBuf;
    }

    /** d mu_k / d u (2 x d) a l'etat z, par derivation directe du MLP (CPU, float64). */
    function jacU(z, k) {
      const u = whitenZ(WH, z);
      const dfd = Array.from({ length: d }, () => new Float64Array(nfc));
      const f = fourier(u, meta.pe_cond, dfd);
      const a = matvec(Wc, null, f, H, nfc, new Float64Array(H));
      const t = dfd.map(df => matvec(Wc, null, df, H, nfc, new Float64Array(H)));
      for (let i = 0; i < H; i++) a[i] += Hpos[k * H + i];
      let h = new Float64Array(H);
      for (let i = 0; i < H; i++) {
        const g = dsilu(a[i]);
        h[i] = silu(a[i]);
        for (let j = 0; j < d; j++) t[j][i] *= g;
      }
      for (let l = 0; l < nBody; l++) {
        const a2 = matvec(Wb[l], Bb[l], h, H, H, new Float64Array(H));
        for (let j = 0; j < d; j++) {
          const tj = matvec(Wb[l], null, t[j], H, H, new Float64Array(H));
          for (let i = 0; i < H; i++) tj[i] *= dsilu(a2[i]);
          t[j] = tj;
        }
        for (let i = 0; i < H; i++) a2[i] = silu(a2[i]);
        h = a2;
      }
      const o = matvec(Wh, Bh, h, 2, H, new Float64Array(2));
      const J = new Float64Array(2 * d);
      for (let r = 0; r < 2; r++) {
        const th = Math.tanh(o[r]), g = (1 - th * th) * meta.max_dmu;
        for (let j = 0; j < d; j++) {
          let s = 0;
          for (let i = 0; i < H; i++) s += Wh[r * H + i] * t[j][i];
          J[r * d + j] = g * s;
        }
      }
      return J;
    }
    /** d mu_k / d z = (d mu_k / d u) W^T, puisque u = (z - mean) W */
    function jacZ(z, k) {
      const Ju = jacU(z, k), J = new Float64Array(2 * d);
      for (let r = 0; r < 2; r++) for (let i = 0; i < d; i++) {
        let s = 0;
        for (let j = 0; j < d; j++) s += Ju[r * d + j] * WH.W[i][j];
        J[r * d + i] = s;
      }
      return J;
    }

    function select(z, x, y, o_) {
      o_ = (typeof o_ === 'number') ? { radius: o_ } : (o_ || {});
      const radius = o_.radius > 0 ? o_.radius : SEL_DEFAULTS.radius;
      const sharp = o_.sharp > 0 ? o_.sharp : SEL_DEFAULTS.sharp;
      const r2 = radius * radius, sig2 = (radius / sharp) * (radius / sharp);
      const M = centers(z);
      const cand = [];
      for (let k = 0; k < meta.n_front; k++) {
        const dx = M[4 * k] - x, dy = M[4 * k + 1] - y, dd = dx * dx + dy * dy;
        if (dd > r2) continue;
        cand.push([k, alpha[k] * Math.exp(-0.5 * dd / sig2)]);
      }
      if (!cand.length) return null;
      cand.sort((p, q) => q[1] - p[1]);
      const keep = cand.slice(0, NJ);
      const J = new Float64Array(2 * d);
      let wsum = 0;
      for (const [k, w] of keep) {
        const Jk = jacZ(z, k);
        for (let i = 0; i < 2 * d; i++) J[i] += w * Jk[i];
        wsum += w;
      }
      if (wsum <= 0) return null;
      for (let i = 0; i < 2 * d; i++) J[i] /= wsum;
      const ws = Float64Array.from(keep.map(p => p[1]));
      return { idx: Int32Array.from(keep.map(p => p[0])), w: ws, wsum,
               kern: ws, kernsum: wsum, J };
    }
    function pointOf(z, sel) {
      const M = centers(z);
      let px = 0, py = 0;
      for (let n = 0; n < sel.idx.length; n++) {
        px += sel.w[n] * M[4 * sel.idx[n]]; py += sel.w[n] * M[4 * sel.idx[n] + 1];
      }
      return [px / sel.wsum, py / sel.wsum];
    }
    /** Jacobienne moyenne d mu / d z d'une selection FIGEE, a l'etat z (effort suiveur :
     *  memes gaussiennes, memes poids, jacobienne recalculee la ou elles sont). */
    function jacobianOf(z, sel) {
      const J = new Float64Array(2 * d);
      for (let n = 0; n < sel.idx.length; n++) {
        const Jk = jacZ(z, sel.idx[n]);
        for (let i = 0; i < 2 * d; i++) J[i] += sel.w[n] * Jk[i];
      }
      for (let i = 0; i < 2 * d; i++) J[i] /= sel.wsum;
      return J;
    }


    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // « under » : dst.rgb += (1−dst.a)·src.rgb ; dst.a += (1−dst.a)·src.a.
    // (1−dst.a) est la transmittance restante ⟹ compositing front-to-back exact, sans tri.
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE,
                         gl.ONE_MINUS_DST_ALPHA, gl.ONE);

    /* ── Cible d'accumulation en flottant 16 bits ────────────────────────────
     * Le framebuffer par defaut d'un canevas est RGBA8 : en compositing
     * front-to-back, `dst.rgb` ET `dst.a` sont donc RE-ARRONDIS a 8 bits apres
     * CHAQUE gaussienne composee. Sur 15 000 gaussiennes dont beaucoup ne
     * portent qu'une opacite infime — une scene photographique entiere, fond et
     * tapis compris —, les contributions de poids faible sont arrondies a zero
     * et la transmittance 1 - dst.a devient grossiere. Resultat : une image plus
     * dure, aux aplats plus francs, qui se lit comme un defaut de rasterisation.
     *
     * Mesure (rocking chair d=1, 256 px, contre une accumulation float64) :
     *   RGBA8   27.6 dB      <- ce que faisait ce module
     *   RGBA16F 70.5 dB      <- invisible
     * et le portage complet mesure dans le navigateur passe de 25.4 dB a la
     * conformite (cf. demo/_rock_check.html).
     *
     * On accumule donc dans une texture RGBA16F, recopiee ensuite sur le
     * canevas. Sans l'extension de rendu flottant (WebGL2 ancien), on retombe
     * sur le chemin direct : degrade, pas casse. */
    const canFloat = gl.getExtension('EXT_color_buffer_half_float')
                  || gl.getExtension('EXT_color_buffer_float');
    let fbo = null, tex = null, texW = 0, texH = 0, blit = null, uTex = null;
    if (canFloat) {
      blit = gl.createProgram();
      gl.attachShader(blit, compile(gl, gl.VERTEX_SHADER, BLIT_VERT));
      gl.attachShader(blit, compile(gl, gl.FRAGMENT_SHADER, BLIT_FRAG));
      gl.linkProgram(blit);
      if (!gl.getProgramParameter(blit, gl.LINK_STATUS)) { blit = null; }
      else {
        uTex = gl.getUniformLocation(blit, 'uTex');
        fbo = gl.createFramebuffer();
        tex = gl.createTexture();
      }
    }

    /** (Re)dimensionne la cible d'accumulation. Renvoie false si elle est
     *  inutilisable — on rend alors directement sur le canevas. */
    function ensureTarget(w, h) {
      if (!fbo) return false;
      if (w === texW && h === texH) return true;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) { fbo = null; return false; }
      texW = w; texH = h;
      return true;
    }

    function resize() {
      let w = Math.max(1, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
      let h = Math.max(1, Math.round(canvas.clientHeight * (window.devicePixelRatio || 1)));
      // Plafond homothetique : c'est le COTE du viewport carre (min(w,h)) qui compte,
      // et le rapport w/h doit survivre sinon la bande noire se decalerait.
      if (MAX_SIDE > 0) {
        const m = Math.min(w, h);
        if (m > MAX_SIDE) {
          const k = MAX_SIDE / m;
          w = Math.max(1, Math.round(w * k));
          h = Math.max(1, Math.round(h * k));
        }
      }
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }

    /** Viewport CARRÉ centré : le décodeur rend en coordonnées normalisées [0,1]², donc
     *  une image carrée. Étirer ce carré sur un panneau large déformerait l'objet. Le
     *  reste du canevas est laissé au noir — la couleur de fond sur laquelle le décodeur
     *  a été entraîné, donc la bande n'introduit aucune discontinuité visible. */
    function box() {
      // Plus grand rectangle de rapport ASPECT tenant dans le canevas, centre.
      let w = canvas.width, h = Math.round(w / ASPECT);
      if (h > canvas.height) { h = canvas.height; w = Math.round(h * ASPECT); }
      return { w, h, side: Math.min(w, h),
               x: Math.round((canvas.width - w) / 2),
               y: Math.round((canvas.height - h) / 2) };
    }

    /** Point du canevas en fraction [0,1]² → point de l'IMAGE en [0,1]² (défait la
     *  bande noire). Renvoie null hors de l'image, SAUF si `outside` : attraper la bande
     *  ne saisit rien, mais une fois la prise faite le curseur a le droit d'en sortir. */
    function toImage(cx, cy, outside) {
      const b = box();
      const x = (cx * canvas.width - b.x) / b.w;
      const y = (cy * canvas.height - b.y) / b.h;
      if (!outside && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
      return [x, y];
    }

    /** Inverse de `toImage` : point de l'IMAGE → fraction du canevas (pour dessiner). */
    function fromImage(ix, iy) {
      const b = box();
      return [(b.x + ix * b.w) / canvas.width, (b.y + iy * b.h) / canvas.height];
    }

    function render(z) {
      resize();
      const b = box();
      runField(z);     // passes du MLP AVANT de lier la cible d'accumulation
      // Alpha = 0 au départ : c'est dst.a qui porte 1 − T pendant l'accumulation. Le
      // canevas est posé sur un fond noir en CSS (celui du décodeur entraîné).
      const off = ensureTarget(b.w, b.h);   // cible 16F, exactement le viewport

      gl.bindFramebuffer(gl.FRAMEBUFFER, off ? fbo : null);
      gl.clearColor(0, 0, 0, 0);
      if (off) {
        gl.viewport(0, 0, b.w, b.h);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(b.x, b.y, b.w, b.h);
      }
      gl.enable(gl.BLEND);
      gl.useProgram(prog);
      bindTex(prog, 'uSA', 0, tSA);
      bindTex(prog, 'uSB', 1, tSB);
      bindTex(prog, 'uCanon2', 2, tCanon2);
      bindTex(prog, 'uColor', 3, tColor);
      gl.uniform1f(U(prog, 'uEpsZ2'), meta.eps_z * meta.eps_z);
      gl.uniform2f(uSize, b.w, b.h);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, K);
      gl.bindVertexArray(null);
      if (!off) return;

      // Recopie sur le canevas, dans le carré centré. Melange DESACTIVE : la
      // texture porte le resultat fini, en couleurs premultipliees.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(b.x, b.y, b.w, b.h);
      gl.useProgram(blit);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uTex, 0);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }

    /** Rendu a la taille d'entrainement (side x side) relu en float, pour la verification.
     *  Ligne 0 = BAS de l'image (convention readPixels). */
    function renderPixels(z, side) {
      runField(z);
      ensureTarget(side, side);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, side, side);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.useProgram(prog);
      bindTex(prog, 'uSA', 0, tSA);
      bindTex(prog, 'uSB', 1, tSB);
      bindTex(prog, 'uCanon2', 2, tCanon2);
      bindTex(prog, 'uColor', 3, tColor);
      gl.uniform1f(U(prog, 'uEpsZ2'), meta.eps_z * meta.eps_z);
      gl.uniform2f(uSize, side, side);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, K);
      gl.bindVertexArray(null);
      const out = new Float32Array(side * side * 4);
      gl.readPixels(0, 0, side, side, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    }

    return { gl, render, resize, toImage, fromImage, box, K, data,
             select, pointOf, jacobianOf,
             presence: () => 1,
             jacobianAt: (z, x, y, o) => { const s = select(z, x, y, o); return s ? s.J : null; },
             debug: { readState, jacU, jacZ, renderPixels } };
  }

  root.DeformSplat = { create, shaders, SEL_DEFAULTS, EPS2D, EPS_Z, CUTOFF };
})(typeof window !== 'undefined' ? window : globalThis);
