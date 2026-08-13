/**
 * meguru — 描画
 *
 * ecosystem.js の状態を読むだけ。書き換えない。
 * 色と密度の初期値は design.md §11（ムードボードからの実測値）に対応する。
 *
 * 【iPad 置きっぱなしのための方針】
 * - 実行中にメモリを確保しない（バッファは起動時に1回だけ確保して使い回す）
 * - ポストプロセスを使わない（TBDR では全画面パスが高くつく）
 * - オーバードローを予算にする（§6.2）。粒は「小さく・暗く・多く」（§11.3）
 */

import * as THREE from '../vendor/three.module.min.js';
import { glowFalloff, MEASURED_CORE } from './falloff.js';

// 色を素通しにする（入力の sRGB→リニア変換も、出力のリニア→sRGB 変換もしない）。
//
// この作品の色は「ムードボードの画面上の実測値」として決めてある（design.md §11）。
// 既定の色管理を有効にすると、書いた #000915 が画面では rgb(0,1,2) になり、
// 目標の 1/10 の暗さになった（実測）。カスタムシェーダは自動の出力変換を受けないため。
// 素通しにすれば「書いた hex ＝ 画面のバイト値」になり、実測値と直接突き合わせられる。
THREE.ColorManagement.enabled = false;

/** 色は1か所にまとめる。ムードボード実測値（design.md §11.1 / §11.2）。 */
export const PALETTE = {
  bgTop: 0x000915,     // 上端
  bgMid: 0x011D31,     // 中央（最も明るい）
  bgCanopy: 0x041F2B,  // 樹冠の高さ（画面の下から 1/3）
  bgBottom: 0x01040C,  // 下端（海底。地面は描かず黒に沈める）
  warm: 0xFFF1B4,      // 暖色：花に蓄えられた光・魚が運ぶ光（色相 49°）
  cool: 0x8FE6FF,      // 寒色：漂う光（色相 193°）
  fish: 0x010A14,      // 魚のシルエット（光らない）
  fog: 0x011D31,
};

const CONF = {
  // カメラ（design.md §5 / §11.4）
  camDistance: 48,
  camHeight: 14.0,
  camTargetY: 6.5,
  camFov: 42,
  camSwingDeg: 8,      // ±8°
  camPeriodSec: 120,
  focusPeriodSec: 47,  // ピント面の往復周期。120 と揃えないことで長時間反復しない

  /**
   * 点の大きさは「基準距離での画素数」で指定する。
   * gl_PointSize = basePx * scale * pixelRatio * (refDist / depth)
   * 以前は素の定数を深度で割っていたため、実距離では 0.76px になり
   * サブピクセルで消えていた（実測）。基準距離を明示すると見積もりを間違えない。
   */
  refDist: 48,

  // 擬似被写界深度（ポストプロセスなし。点シェーダ内で処理する）
  focusNear: 30,
  focusFar: 66,
  focusRange: 18,      // これだけ焦点から離れると最大にボケる
  // 接写ムードボードでは、ボケ玉は半値直径 80px（鋭い粒の約20倍）まで広がるのに
  // 芯の輝度は 174〜192（鋭い粒 201）でほとんど落ちない。
  // ＝「大きく広がるが、あまり暗くならない」。旧値（2.2 / 3.4）は逆に寄っていた。
  blurSizeGain: 3.2,
  blurDimGain: 1.9,

  /**
   * 意味のある光（保存量 300 個）。
   *
   * ローレンツ型はべき乗カーブに比べて1粒あたりの総エネルギーが 16% しかない
   * （面積分で 0.082 対 0.524）。同じ明るさを出すにはスプライトを大きく取り、
   * その中のごく小さな芯だけが明るい、という構成にする必要がある。
   * これは実測どおりでもある（半値半径 1.91px に対しスプライト半径 24px）。
   */
  lightSize: 42.0,
  lightWarmBoost: 1.30,  // 暖色は少しだけ大きく。明るさは「芯が密に重なること」で作る
  /**
   * 1粒あたりの明るさ。1.0 だと芯が白飛びする。
   *
   * 暖色 #FFF1B4 は R が既に 255 なので、芯が2つ重なるだけで G/B も 255 に達し、
   * 金色のはずの花の中心が真っ白に飛ぶ。実測では完全な白飛びが 0.082% あり、
   * ムードボード（接写 0.002% / ワイド 0.001%）の 40〜80 倍だった。
   * 実測の芯は輝度の中央値 201・最大 252 で、255 に張り付いていない。
   */
  /**
   * 値の決め方（1粒だけで輝度 200 を超えるように取る）。
   *
   * 暖色 #FFF1B4 の素の輝度は 239.6。gain 0.92 だと霧の減衰込みで芯が 198〜220 になり、
   * §11.3 の「輝度200以上」の閾値が**粒1つの芯の高さを横切って**しまう。
   * こうなると 200 以上の画素数は「芯がいくつ重なったか」だけで決まり、
   * 光が花に溜まっているか魚が運んでいるかで 3.5 倍も振れる（実測 0.089〜0.373%）。
   * 実際 t=840s で下限 0.1% を割った。
   *
   * gain 1.02 なら孤立した芯でも 220〜244 で、閾値を安定して超える。
   * 以後「輝度200以上の量」は暖色の粒の**個数**に追従する ＝ 保存量に追従する。
   * これ以上（1.10）上げると霧の薄い手前で 255 を超えて白飛びする。
   */
  lightGain: 1.02,

  // 環境の微粒子（保存則の外。空気を作るためだけに在る）: 基準距離で 1.8px
  moteCount: 12000,
  moteSize: 2.4,
  moteOpacity: 1.0,

  // 花：小さく・薄く。主役は花そのものではなく、花が抱えている光
  flowerScale: 1.15,
  flowerOpacity: 0.40,      // 膜の実測（水より +20〜26 輝度）から逆算した値。§11.8
  // 蓄えた光は等方に散らさず、椀の底から放射状に伸びる糸の先に載せる（§11.8）
  flowerLightSpread: 2.45,  // 糸の最大の長さ（花の大きさに比例させる）
  flowerLightBase: 0.30,    // 椀の底からの立ち上がり
  flowerLightArc: 0.28,     // 外へ行くほど持ち上がる量（糸の反り）

  /**
   * 魚が運ぶ光の散らばり。
   *
   * 以前は 0.6/0.4/0.6 と広く、運ばれている間だけ光が薄く伸びて芯を作らなかった。
   * その結果、積載が多い時刻（＝光が花ではなく魚にある時刻）に画面全体の
   * 明るい芯の量が落ち、20分の掃引で t=900s だけ予算の下限を割った（0.086%）。
   * 保存量は同じなのに見え方が変わるのは、循環を主題にする以上まずい。
   * 狭めて、どこにあっても同じ「粒」として見えるようにする。
   */
  fishCargoSpread: 0.34,

  fishScale: 0.85,

  fogDensity: 0.016,
};

/**
 * canvas に放射状の減衰を描いてスプライトにする（外部画像を使わない）。
 * カーブは src/falloff.js（接写ムードボードの実測に合わせたローレンツ型）。
 *
 * @param {number} size   テクスチャの一辺
 * @param {number} coreRatio 芯の細さ。小さいほど「鋭い芯＋弱く長い裾」になる
 */
function makeGlowTexture(size, coreRatio) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const a = glowFalloff(Math.sqrt(dx * dx + dy * dy), coreRatio);
      const o = (y * size + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  // ミップマップを作らせない。芯は実測どおり半径の 8% しかないので、
  // 縮小時にミップで平均されると芯そのものが消えて元の「綿」に戻る。
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 花弁のテクスチャ。uv(0,0)=根元の左、uv(1,1)=先端の右。
 *
 * 接写ムードボードの実測（design.md §11.8）から作り直したもの。以前は
 * 「うっすら均一に明るい膜＋ごく弱い筋7本」だったが、実測はその逆だった：
 *
 *   膜   … 水より +20〜26 輝度・色相 197°・**R 成分がほぼゼロ**（漂う光と同じ寒色）
 *   葉脈 … 膜の中の輝度の振れ幅が 12〜25。膜の中央値 26〜32 と**同等以上**
 *   リム … 膜の 3〜4 倍（膜側 41 → 縁 107）。ただし**全周ではなく光を受けた側だけ**
 *
 * つまり「ごく暗い膜 ＋ はっきり明るい葉脈 ＋ 片側だけ強い縁」。
 * 以前の実装は膜が明るすぎ・葉脈が弱すぎで、遠目に「薄い弧」に見えていた。
 */
function makePetalTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;

  // 花弁の輪郭（下＝根元、上＝先端）。縁を波打たせて膜らしさを出す
  const petal = new Path2D();
  petal.moveTo(cx, size * 0.99);
  petal.bezierCurveTo(cx - size * 0.30, size * 0.74, cx - size * 0.36, size * 0.34, cx - size * 0.06, size * 0.03);
  petal.bezierCurveTo(cx + size * 0.16, size * 0.10, cx + size * 0.36, size * 0.36, cx + size * 0.30, size * 0.72);
  petal.closePath();

  // --- 膜：暗い寒色。R をほぼ持たせない（実測 rgb 差 (0〜6, 24〜32, 33〜48)） ---
  const g = ctx.createLinearGradient(0, size, 0, 0);
  g.addColorStop(0.00, 'rgba(18,148,220,0.42)');
  g.addColorStop(0.35, 'rgba(18,148,220,0.30)');
  g.addColorStop(0.78, 'rgba(16,140,214,0.15)');
  g.addColorStop(1.00, 'rgba(16,140,214,0.00)');
  ctx.fillStyle = g;
  ctx.fill(petal);

  ctx.save();
  ctx.clip(petal);
  // ここから先は加算で重ねる。実際の描画も加算合成なので、テクスチャ内でも
  // 同じ足し方にしておくと「膜の何倍」という実測比をそのまま作れる。
  ctx.globalCompositeOperation = 'lighter';

  // --- 葉脈：根元から扇状に広がる細い筋 ---
  //
  // 実測のコントラストは膜と同等以上だったが、**その値をそのまま使うと破綻する**。
  // 実測は花が画面いっぱいに写った接写のもので、こちらは 1 輪が 30px 程度しかない。
  // 葉脈を先端まで直線で通すと、遠目には花ではなく「放射状の光条」に見えた
  // （実際に一度そうなった）。筋は先端まで届かせず、中ほどで消す。
  const veins = 15;
  ctx.lineCap = 'round';
  for (let i = 0; i < veins; i++) {
    const t = (i / (veins - 1)) * 2 - 1;             // -1..1
    const spread = t * 0.26;
    const tipY = size * (0.40 + Math.abs(t) * 0.22); // 先端まで届かせない
    const a = 0.17 * (1 - Math.abs(t) * 0.6);
    ctx.strokeStyle = `rgba(120,205,255,${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.8, size / 170) * (1 - Math.abs(t) * 0.35);
    ctx.beginPath();
    ctx.moveTo(cx, size * 0.95);
    ctx.quadraticCurveTo(cx + spread * size * 0.5, size * 0.68, cx + spread * size * 0.82, tipY);
    ctx.stroke();
  }

  // --- 縁のリム：片側だけ。strokeStyle に勾配を入れて安く済ませる ---
  // 接写の実測は膜の 3〜4 倍だが、ここでもそのままは使えない。
  // 花弁の輪郭を明るくなぞると、遠目には輪郭線だけが残って板に見える。
  const rim = ctx.createLinearGradient(0, size, size, 0);
  rim.addColorStop(0.00, 'rgba(205,238,255,0.00)');
  rim.addColorStop(0.50, 'rgba(215,242,255,0.10)');
  rim.addColorStop(0.85, 'rgba(228,248,255,0.26)');
  rim.addColorStop(1.00, 'rgba(235,250,255,0.32)');
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1.4, size / 80);
  ctx.stroke(petal);
  ctx.restore();

  // --- 輪郭をぼかす ---
  // clip で切ると縁がぴたりと立ち、8 枚の板が「羽根」に見えてしまう。
  // アルファに放射状の減衰を掛けて、外へ行くほど溶けるようにする。
  ctx.globalCompositeOperation = 'destination-in';
  const soft = ctx.createRadialGradient(cx, size * 0.66, size * 0.06, cx, size * 0.66, size * 0.56);
  soft.addColorStop(0.00, 'rgba(0,0,0,1)');
  soft.addColorStop(0.55, 'rgba(0,0,0,0.88)');
  soft.addColorStop(0.82, 'rgba(0,0,0,0.42)');
  soft.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = soft;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------
// 花の個体差。位置から決めるので毎フレーム安定し、インデックスが
// 入れ替わっても（swap-remove で起きる）同じ花は同じ姿のままになる。
// 光の位置と花弁の位置がずれないよう、両方でこの1か所を使う。
// ---------------------------------------------------------------
const FLOWER_BASE_DY = -0.4;   // 花の根元の高さ（ecosystem の y からの差）
const FLOWER_DY_JITTER = 2.6;  // 高さの個体差の幅。0 だと横一列の生垣に見える

function hash2(x, z, ax, az, k) {
  return (Math.abs(Math.sin(x * ax + z * az)) * k) % 1;
}

/** 割り当てを起こさないよう、結果は使い回しのオブジェクトに書く。 */
const _ft = { h1: 0, h2: 0, h3: 0, baseY: 0, scale: 0 };
function flowerTransform(f, out) {
  out.h1 = hash2(f.x, f.z, 12.9898, 78.233, 43758.5453);
  out.h2 = hash2(f.x, f.z, 39.3468, 11.1350, 24634.6345);
  out.h3 = hash2(f.x, f.z, 7.1234, 53.7891, 15731.7430);
  const grow = Math.min(1, f.age / 6);
  out.scale = CONF.flowerScale * (0.72 + out.h1 * 0.75) * (0.55 + grow * 0.45);
  out.baseY = f.y + FLOWER_BASE_DY + (out.h1 - 0.5) * FLOWER_DY_JITTER;
  return out;
}

export class Renderer {
  constructor(canvas, eco) {
    this.eco = eco;
    this.time = 0;
    this.pointer = { x: 0, y: 0, active: 0 };

    const p = eco.params;
    this.world = { x: p.worldX, y: p.worldY, z: p.worldZ };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,     // 輪郭が無い絵なので効かない。TBDR では純粋な損
      alpha: false,
      powerPreference: 'low-power', // 発熱が敵（§6.1）
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 出力変換もしない（上のコメント参照）
    // §6.3 解像度を落とすのが最大の節約。輪郭が無いので劣化がほぼ見えない
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.setClearColor(PALETTE.bgBottom, 1);
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(PALETTE.fog, CONF.fogDensity);

    this.camera = new THREE.PerspectiveCamera(CONF.camFov, 1, 0.5, 160);
    this.target = new THREE.Vector3(0, CONF.camTargetY, 0);

    this._buildBackground();
    this._buildLights();
    this._buildMotes();
    this._buildFlowers();
    this._buildFish();

    this.resize();
  }

  // ---------------------------------------------------------------
  // 背景：画面空間の縦グラデーション。海底の地面は描かない（§11.1）
  // ---------------------------------------------------------------
  _buildBackground() {
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const mat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(PALETTE.bgTop) },
        uMid: { value: new THREE.Color(PALETTE.bgMid) },
        uCanopy: { value: new THREE.Color(PALETTE.bgCanopy) },
        uBottom: { value: new THREE.Color(PALETTE.bgBottom) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform vec3 uTop, uMid, uCanopy, uBottom;
        void main() {
          // uv.y = 0 が画面下端。実測は上からの割合なので読み替えている：
          //   上端 1.00 / 中央 0.50 / 樹冠 0.33（＝上から67%）/ 下端 0.00
          float y = vUv.y;
          vec3 c;
          if (y > 0.5)       c = mix(uMid,    uTop,   smoothstep(0.5, 1.0, y));
          else if (y > 0.33) c = mix(uCanopy, uMid,   smoothstep(0.33, 0.5, y));
          else               c = mix(uBottom, uCanopy, smoothstep(0.0, 0.33, y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  // ---------------------------------------------------------------
  // 意味のある光：保存量 300 個。漂う光・花の蓄え・魚の積載を1つの Points で描く
  // ---------------------------------------------------------------
  _buildLights() {
    const N = this.eco.params.totalLight;
    this.lightN = N;

    // 実行中に確保しない。起動時の1回だけ（④ ヒープを増やさないため）
    this._lightPos = new Float32Array(N * 3);
    this._lightWarm = new Float32Array(N);
    this._lightScale = new Float32Array(N);

    // 花・魚が抱える光を中心のまわりに散らすための固定オフセット表。
    // 毎フレーム乱数を引くとチラつくので、あらかじめ作って使い回す。
    this._offsets = new Float32Array(N * 3);
    let s = 20260813;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      // 球内に一様に近い分布
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(rnd() * 2 - 1);
      const r = Math.cbrt(rnd());
      this._offsets[i * 3] = Math.sin(ph) * Math.cos(th) * r;
      this._offsets[i * 3 + 1] = Math.cos(ph) * r;
      this._offsets[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
    }

    // 花が抱える光の置き方（§11.8）。等方に散らすのではなく、椀の底から
    // 放射状に伸びる糸の先に載せる。接写では中心に強く密で、外へ行くほど疎だった
    // （重心からの距離が 50%=206px / 95%=563px。一様なら 50% は 398px のはず）。
    // 分位から求めた分布は d = R * u^1.56。u^1.56 は起動時に計算しておく。
    this._filament = new Float32Array(N * 3); // [cosθ, sinθ, u^1.56]
    for (let i = 0; i < N; i++) {
      const th = rnd() * Math.PI * 2;
      this._filament[i * 3] = Math.cos(th);
      this._filament[i * 3 + 1] = Math.sin(th);
      this._filament[i * 3 + 2] = Math.pow(rnd(), 1.56);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._lightPos, 3));
    geo.setAttribute('aWarm', new THREE.BufferAttribute(this._lightWarm, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this._lightScale, 1));
    geo.setDrawRange(0, N);

    this.lightMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        // 実測どおりの鋭い芯（半径の 8%）。テクスチャは芯が潰れない程度に大きく取る
        uMap: { value: makeGlowTexture(96, MEASURED_CORE) },
        uWarm: { value: new THREE.Color(PALETTE.warm) },
        uCool: { value: new THREE.Color(PALETTE.cool) },
        uSize: { value: CONF.lightSize },
        uRefDist: { value: CONF.refDist },
        uFocus: { value: 30 },
        uFocusRange: { value: CONF.focusRange },
        uBlurSize: { value: CONF.blurSizeGain },
        uBlurDim: { value: CONF.blurDimGain },
        uFogDensity: { value: CONF.fogDensity },
        uPixelRatio: { value: 1 },
        uGain: { value: CONF.lightGain },
      },
      vertexShader: `
        attribute float aWarm;
        attribute float aScale;
        uniform float uSize, uRefDist, uFocus, uFocusRange, uBlurSize, uBlurDim, uPixelRatio, uFogDensity;
        varying float vWarm;
        varying float vDim;
        void main() {
          vWarm = aWarm;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = -mv.z;

          // 擬似被写界深度：ポストプロセスを使わずここで済ませる。
          // 全画面のぼかしパスは TBDR（iPad）で最も高くつくので、
          // 「焦点から遠い粒ほど大きく・暗く」描いてボケに見せる。
          // 大きくするぶん明るさが増えてしまうので、必ず同時に暗くする。
          float blur = clamp(abs(depth - uFocus) / uFocusRange, 0.0, 1.0);

          // 「基準距離での画素数」で指定する（CONF.refDist のコメント参照）
          gl_PointSize = uSize * aScale * uPixelRatio * (1.0 + blur * uBlurSize) * uRefDist / max(depth, 1.0);

          float fog = exp(-uFogDensity * uFogDensity * depth * depth);
          vDim = fog / (1.0 + blur * uBlurDim);

          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec3 uWarm, uCool;
        uniform float uGain;
        varying float vWarm;
        varying float vDim;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.004) discard;
          vec3 c = mix(uCool, uWarm, vWarm);
          // uGain は白飛び対策（CONF.lightGain のコメント参照）
          gl_FragColor = vec4(c * a * vDim * uGain, 1.0);
        }`,
    });

    this.lightPoints = new THREE.Points(geo, this.lightMat);
    this.lightPoints.frustumCulled = false;
    this.scene.add(this.lightPoints);
  }

  // ---------------------------------------------------------------
  // 環境の微粒子：保存則の外。1〜2px・低アルファでオーバードローを食わない
  // 位置は起動時に決め、動きは頂点シェーダ内だけで作る（CPU 負荷ゼロ）
  // ---------------------------------------------------------------
  _buildMotes() {
    const n = CONF.moteCount;
    const pos = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const scale = new Float32Array(n);
    const W = this.world;

    let s = 7717;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rnd() * 2 - 1) * W.x * 0.62;
      // 下ほど密。樹冠のあたりに空気の密度を作る
      pos[i * 3 + 1] = Math.pow(rnd(), 1.7) * W.y * 0.85 + 0.2;
      pos[i * 3 + 2] = (rnd() * 2 - 1) * W.z * 0.62;
      phase[i] = rnd() * Math.PI * 2;
      scale[i] = 0.55 + rnd() * 0.75;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));

    this.moteMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        // 微粒子はわざと芯を広くする（0.080 ではなく 0.18）。
        // 微粒子は 2px 前後でしか描かれないので、実測どおりの鋭い芯にすると
        // 芯がサブピクセルに落ちて何も見えなくなる。役目は空気を作ることなので、
        // 「見える柔らかい点」であることを優先する。
        uMap: { value: makeGlowTexture(32, 0.18) },
        uCool: { value: new THREE.Color(PALETTE.cool) },
        uWarm: { value: new THREE.Color(PALETTE.warm) },
        uTime: { value: 0 },
        uSize: { value: CONF.moteSize },
        uRefDist: { value: CONF.refDist },
        uOpacity: { value: CONF.moteOpacity },
        uPixelRatio: { value: 1 },
        uFogDensity: { value: CONF.fogDensity },
        uPointer: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `
        attribute float aPhase;
        attribute float aScale;
        uniform float uTime, uSize, uRefDist, uPixelRatio, uFogDensity;
        uniform vec2 uPointer;
        varying float vDim;
        varying float vWarm;
        void main() {
          vec3 p = position;
          // ごく緩やかな漂い。CPU では何も計算しない
          p.x += sin(uTime * 0.11 + aPhase) * 0.7;
          p.y += sin(uTime * 0.07 + aPhase * 1.7) * 0.45;
          p.z += cos(uTime * 0.09 + aPhase * 0.6) * 0.7;

          // 鑑賞者の気配（§3）。命令ではないので、ごく弱く
          p.x += uPointer.x * 0.55;
          p.z += uPointer.y * 0.55;

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float depth = -mv.z;
          gl_PointSize = uSize * aScale * uPixelRatio * uRefDist / max(depth, 1.0);
          float fog = exp(-uFogDensity * uFogDensity * depth * depth);
          vDim = fog;
          vWarm = step(0.72, fract(aPhase * 3.17));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec3 uCool, uWarm;
        uniform float uOpacity;
        varying float vDim;
        varying float vWarm;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.01) discard;
          vec3 c = mix(uCool, uWarm, vWarm);
          gl_FragColor = vec4(c * a * vDim * uOpacity, 1.0);
        }`,
    });

    this.motes = new THREE.Points(geo, this.moteMat);
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  // ---------------------------------------------------------------
  // 花：花弁6枚のクアッドを1つに束ね、InstancedMesh で24本を1ドローコールに
  // ---------------------------------------------------------------
  _buildFlowers() {
    const max = this.eco.params.flowerMax;
    const petals = 8;
    // 幅を広く・丈を短くして、8 枚が重なって「椀」になるようにする。
    // 細長いと隣と重ならず、遠目に放射状の光条（レンズフレア）に見える。
    const w = 2.6, h = 2.7, tilt = 1.18; // 外へ倒す角度（rad）。立てるとワイングラスに見える

    const vtx = [];
    const uvs = [];
    const idx = [];
    for (let k = 0; k < petals; k++) {
      const a = (k / petals) * Math.PI * 2;
      const base = vtx.length / 3;
      // ローカル：根元 y=0、先端 y=h。外へ tilt だけ倒してから y 軸まわりに回す
      const quad = [
        [-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h],
      ];
      for (const [qx, qy] of quad) {
        const ty = Math.cos(tilt) * qy;
        const tr = Math.sin(tilt) * qy; // 外向きの距離
        const x = qx * Math.cos(a) - 0 * Math.sin(a) + Math.cos(a) * tr;
        const z = qx * Math.sin(a) + 0 * Math.cos(a) + Math.sin(a) * tr;
        vtx.push(x, ty, z);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vtx, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);

    const mat = new THREE.MeshBasicMaterial({
      map: makePetalTexture(128),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      opacity: CONF.flowerOpacity,
    });

    this.flowerMesh = new THREE.InstancedMesh(geo, mat, max);
    this.flowerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flowerMesh.frustumCulled = false;
    this.flowerMesh.count = max;
    // 蓄えに応じて明るくするため、インスタンスごとの色を持たせる
    this.flowerMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.flowerMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.flowerMesh);

    // 描画ループ用の使い回し（実行中に確保しないため。§6.4 / 完成の定義④）
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._v3 = new THREE.Vector3();
    this._v3b = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  // ---------------------------------------------------------------
  // 魚：光らない暗いシルエット。板1枚を進行方向へ向ける
  // ---------------------------------------------------------------
  _buildFish() {
    const shape = new THREE.Shape();
    shape.moveTo(-1.15, 0.0);      // 尾の先
    shape.lineTo(-0.72, 0.34);
    shape.quadraticCurveTo(-0.2, 0.44, 0.42, 0.2);
    shape.quadraticCurveTo(0.86, 0.06, 0.95, 0.0);
    shape.quadraticCurveTo(0.86, -0.06, 0.42, -0.2);
    shape.quadraticCurveTo(-0.2, -0.44, -0.72, -0.34);
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape, 8);
    geo.rotateY(-Math.PI / 2); // ローカル +X（進行方向）を +Z に合わせ、lookAt を使えるようにする
    geo.scale(CONF.fishScale, CONF.fishScale, CONF.fishScale);

    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.fish,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      fog: true,          // 遠い魚は水に溶ける
      depthWrite: true,   // 光を遮ってシルエットになる
    });

    this.fishMeshes = [];
    for (let i = 0; i < this.eco.fishes.length; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      this.scene.add(m);
      this.fishMeshes.push(m);
    }
  }

  // ---------------------------------------------------------------

  setPointer(nx, ny) {
    // -1..1 で受け取る。§3 のとおり「気配」に留めるため増幅しない
    this.pointer.x = nx;
    this.pointer.y = ny;
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.lightMat.uniforms.uPixelRatio.value = pr;
    this.moteMat.uniforms.uPixelRatio.value = pr;
  }

  /** ecosystem を1ステップ進めたあとに呼ぶ。dt は固定 1/30。 */
  update(dt) {
    this.time += dt;
    const eco = this.eco;

    // --- カメラ：±8°/120秒の緩やかな周回（§5） ---
    const ang = Math.sin((this.time / CONF.camPeriodSec) * Math.PI * 2) * (CONF.camSwingDeg * Math.PI / 180);
    this.camera.position.set(
      Math.sin(ang) * CONF.camDistance,
      CONF.camHeight,
      Math.cos(ang) * CONF.camDistance
    );
    this.camera.lookAt(this.target);

    // --- ピント面：47秒周期で前後（§5） ---
    const f = (Math.sin((this.time / CONF.focusPeriodSec) * Math.PI * 2) + 1) * 0.5;
    this.lightMat.uniforms.uFocus.value = CONF.focusNear + (CONF.focusFar - CONF.focusNear) * f;

    this.moteMat.uniforms.uTime.value = this.time;
    this.moteMat.uniforms.uPointer.value.set(this.pointer.x, this.pointer.y);

    this._updateLights();
    this._updateFlowers();
    this._updateFish(dt);
  }

  /** 保存量 300 個を1本の配列に詰める。漂う光 → 花の蓄え → 魚の積載 の順。 */
  _updateLights() {
    const eco = this.eco;
    const pos = this._lightPos;
    const warm = this._lightWarm;
    const scale = this._lightScale;
    const off = this._offsets;
    const src = eco.driftPositions;
    let n = 0;

    // 漂う光（寒色）
    for (let i = 0; i < eco.driftCount; i++) {
      const o = i * 3, d = n * 3;
      pos[d] = src[o];
      pos[d + 1] = src[o + 1];
      pos[d + 2] = src[o + 2];
      warm[n] = 0;
      scale[n] = 1;
      n++;
    }

    // 花の蓄え（暖色）。椀の底から放射状に伸びる糸の先に載せる（§11.8）
    // eco.flowers は毎回 slice するので描画ループでは使わない（確保を避ける）
    const fil = this._filament;
    const flowers = eco._flowers;
    for (let i = 0; i < eco.flowerCount; i++) {
      const f = flowers[i];
      // 花弁と同じ個体差を使う。ここを別に計算すると光の塊が椀から浮く
      const ft = flowerTransform(f, _ft);
      const spread = CONF.flowerLightSpread * ft.scale;
      for (let k = 0; k < f.charge && n < this.lightN; k++) {
        const d = n * 3, ob = ((i * 31 + k) % this.lightN) * 3;
        const r = spread * fil[ob + 2];     // u^1.56（中心に密）
        pos[d] = f.x + fil[ob] * r;
        pos[d + 1] = ft.baseY + CONF.flowerLightBase * ft.scale + r * CONF.flowerLightArc;
        pos[d + 2] = f.z + fil[ob + 1] * r;
        warm[n] = 1;
        scale[n] = CONF.lightWarmBoost;
        n++;
      }
    }

    // 魚の積載（暖色）
    const fishes = eco.fishes;
    for (let i = 0; i < fishes.length; i++) {
      const fi = fishes[i];
      for (let k = 0; k < fi.cargo && n < this.lightN; k++) {
        const d = n * 3, ob = ((i * 97 + k) % this.lightN) * 3;
        const cs = CONF.fishCargoSpread;
        pos[d] = fi.x + off[ob] * cs;
        pos[d + 1] = fi.y + off[ob + 1] * cs * 0.7;
        pos[d + 2] = fi.z + off[ob + 2] * cs;
        warm[n] = 1;
        scale[n] = CONF.lightWarmBoost;
        n++;
      }
    }

    this.lightPoints.geometry.setDrawRange(0, n);
    this.lightPoints.geometry.attributes.position.needsUpdate = true;
    this.lightPoints.geometry.attributes.aWarm.needsUpdate = true;
    this.lightPoints.geometry.attributes.aScale.needsUpdate = true;
    this.visibleLights = n;
  }

  _updateFlowers() {
    const eco = this.eco;
    const flowers = eco._flowers;
    const max = eco.params.flowerMax;
    const cap = eco.params.flowerCapacity;

    for (let i = 0; i < max; i++) {
      if (i < eco.flowerCount) {
        const f = flowers[i];
        // 大きさ・高さの個体差（光の位置と共有する。flowerTransform 参照）
        const ft = flowerTransform(f, _ft);
        const s = ft.scale;
        this._v3.set(f.x, ft.baseY, f.z);
        // 向きにも個体差を付ける。大きさと高さだけでは、正面から見たとき
        // 同じ形が並んで「横一列の帯」に見えてしまう。
        // 回転はインデックスではなく位置から決める（swap-remove で index が
        // 入れ替わったときに花が突然回るのを避けるため）。
        this._euler.set(
          (ft.h2 - 0.5) * 0.42,          // 前後の傾き
          ft.h2 * Math.PI * 2,           // Y 軸まわり
          (ft.h3 - 0.5) * 0.42           // 左右の傾き
        );
        this._q.setFromEuler(this._euler);
        this._v3b.set(s, s, s);
        this._m4.compose(this._v3, this._q, this._v3b);
        // 蓄えが多いほど明るい。色相はテクスチャ側が持つので、ここは明度だけ
        const lit = 0.55 + Math.min(1, f.charge / cap) * 0.85;
        this._color.setRGB(lit, lit, lit);
      } else {
        this._m4.makeScale(0, 0, 0);
        this._color.setRGB(0, 0, 0);
      }
      this.flowerMesh.setMatrixAt(i, this._m4);
      this.flowerMesh.setColorAt(i, this._color);
    }
    this.flowerMesh.instanceMatrix.needsUpdate = true;
    this.flowerMesh.instanceColor.needsUpdate = true;
  }

  _updateFish() {
    const fishes = this.eco.fishes;
    for (let i = 0; i < fishes.length; i++) {
      const fi = fishes[i];
      const m = this.fishMeshes[i];
      m.position.set(fi.x, fi.y, fi.z);
      const sp = Math.hypot(fi.vx, fi.vy, fi.vz);
      if (sp > 0.01) {
        this._v3.set(fi.x + fi.vx / sp, fi.y + fi.vy / sp, fi.z + fi.vz / sp);
        m.lookAt(this._v3);
      }
    }
  }

  render() {
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }
}

export default Renderer;
