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
  /**
   * 暖色：花に蓄えられた光・魚が運ぶ光（色相 39°・彩度 80%）。
   *
   * **淡い #FFF1B4（彩度 29%）から濃くした（段1）。** 描画は加算合成なので画面の値は
   * 「背景 + 光」で、背景は最も明るい行で (1,29,49) と青い。#FFF1B4 は G が R の 0.945 倍
   * しかないため、背景の G−R = 28 を打ち消すには光の R 成分が 28/(1−0.945) = **509 必要**で、
   * 255 が上限だから**到達できない**。完全に飽和した白い画素だけが金色と判定される状態で、
   * 白飛び予算（§11.3）と真っ向から衝突していた。実測でも「輝度80以上の 25,000 画素のうち
   * R が最大チャンネルなのは 48 画素だけ」。
   *
   * **光そのものは金色のまま出ていた**（背景を引くと暖色 20.7%。ムードボード 26.7% と同等）。
   * つまり原因は gain でも減衰カーブでもなく、**素の色が淡すぎて背景の青に負けていた**こと。
   * 彩度を上げると必要な R 成分は 28/(1−0.722) = 101 に下がり、芯だけでなくその周辺も金色になる。
   * 掃引の実測（`work/sweep-warm.mjs`。暖色%の最小〜最大・4画面×4時刻）:
   *   #FFF1B4 彩度29% 要509 → 0.00〜0.02%（到達不能）
   *   #FFC864 彩度61% 要130 → 4.93〜13.98%（下限10%に届かない）
   *   #FFB833 彩度80% 要101 → 13.26〜32.19%  ← 採用。ムードボードの 19.17% を挟む
   *   #FFAD1F 彩度88% 要 87 → 19.20〜43.68%（ムードボードより金が強い）
   *
   * 目標値はムードボードの雄しべの実測（色相 37〜46°・彩度 33〜49%・明度 82〜92%。
   * ただしこれは背景が乗った**画面の値**なので、素の色はこれより濃くなる）。
   */
  warm: 0xFFB833,
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
   * 点の大きさは「基準の画面で、基準距離に置いたときの画素数」で指定する。
   * gl_PointSize = basePx * scale * sizeScale * (refDist / depth)
   *   sizeScale = 描画バッファの高さ / refBufferHeight
   * 以前は素の定数を深度で割っていたため、実距離では 0.76px になり
   * サブピクセルで消えていた（実測）。基準距離を明示すると見積もりを間違えない。
   *
   * **sizeScale を pixelRatio にしていたのが iPhone の白飛びの原因だった。**
   * 花・魚・世界の見かけの大きさは「バッファの高さ」に比例して縮むのに、
   * 粒だけが pixelRatio にしか比例しないので、画面が縦に短いほど粒だけが
   * 相対的に肥大する。加算合成なので重なりが増えたぶん超線形に明るくなる。
   * 実測（基準距離の粒がバッファ高の何%か）:
   *   Mac 1536x1024   3.76%   輝度70以上  6.7〜9.8%  白飛び 0.01%
   *   iPad 1024x768@2 5.01%   〃         10.0〜15.2% 〃    0.11%
   *   iPhone 縦       5.14%   〃         11.6〜21.4% 〃    0.05%
   *   iPhone 横       12.03%  〃         16.4〜19.8% 〃    3.20%（予算の3200倍）
   * バッファ高に比例させれば、どの画面でも 3.76% で一定になる。
   */
  refDist: 48,
  // §11.3 の明るさ予算を実測した画面の高さ（描画バッファの画素）
  refBufferHeight: 1024,

  // 擬似被写界深度（ポストプロセスなし。点シェーダ内で処理する）
  focusNear: 30,
  focusFar: 66,
  // これだけ焦点から離れると最大にボケる（§11.6 の実測値）。
  // 27 に広げると明るさが増えると読んだが、実測は逆で暗くなった（0.091→0.060%）。
  // ボケの半径が小さくなるぶん、粒どうしの裾が重ならなくなるためと考えられる。
  // 推測で動かさず実測値に戻す
  focusRange: 18,
  // 接写ムードボードでは、ボケ玉は半値直径 80px（鋭い粒の約20倍）まで広がるのに
  // 芯の輝度は 174〜192（鋭い粒 201）でほとんど落ちない。
  // ＝「大きく広がるが、あまり暗くならない」。旧値（2.2 / 3.4）は逆に寄っていた。
  blurSizeGain: 3.2,
  // ボケた粒の減光。強すぎると、焦点が光の層から外れる時刻に芯が
  // §11.3 の下限（輝度200以上 0.1%）を割る（t=90s で 0.082%）。
  // 全体の明るさを上げると白飛びが増えるので、ここだけを緩める
  blurDimGain: 1.62,

  /**
   * 意味のある光（保存量 300 個）。
   *
   * ローレンツ型はべき乗カーブに比べて1粒あたりの総エネルギーが 16% しかない
   * （面積分で 0.082 対 0.524）。同じ明るさを出すにはスプライトを大きく取り、
   * その中のごく小さな芯だけが明るい、という構成にする必要がある。
   * これは実測どおりでもある（半値半径 1.91px に対しスプライト半径 24px）。
   */
  // 42.0 は接写の実測（芯の半径比 8%）から決めた値。比は falloff.js が持つので、
  // ここは裾の広さだけを決める。器に光が集まって裾が重なるようになったぶん、
  // 輝度70以上の面積が上限 10% に触れたので少し縮める
  lightSize: 38.5,
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
  // 1.02 は「芯が重なって白飛びする」時代の値。光粒を器の中で重ねずに散らしたので
  // 白飛びは 0.060% → 0.001% に下がり、上げる余裕ができた。
  // 上げる理由は、重なりが隠していた「ボケた時刻に芯が 200 を割る」が露出したため
  // （焦点周期 47 秒に同期して 0.520% ⇔ 0.053% と振れる）
  lightGain: 1.32,

  /**
   * 暖色の粒だけに掛ける追加の明るさ（段1）。
   *
   * 暖色を濃く（#FFF1B4 → #FFB833）したぶん、**1粒の輝度が 239.6 → 190.2 に落ちる**
   * （Rec.709 は G の重みが 0.7152 なので、G を削ると輝度が大きく減る）。
   * その結果「輝度200以上」＝§11.6 が「光が花に溜まっている」ことの信号として
   * 使ってきた量が下限 0.1% を割った（実測 0.001〜0.660%）。
   *
   * **`lightGain` を上げて補うと寒色まで明るくなる。** 寒色は既に画面のほとんどを占めていて、
   * iPhone の「光が強い」（§8.5）と同じ方向に効いてしまう。失った輝度は暖色の側で失ったので、
   * **暖色の側だけで返す**のが筋が通る。実測でも寒色の白飛びを増やさずに済んだ。
   */
  lightWarmGain: 1.70,

  // 環境の微粒子（保存則の外。空気を作るためだけに在る）: 基準距離で 1.8px
  moteCount: 12000,
  moteSize: 2.4,
  moteOpacity: 1.0,

  // 花：主役は花そのものではなく、花が抱えている光。
  // 膜は「光が無ければ形が辛うじて分かる」程度にとどめる（§11.8 の実測が上限）
  // 数を 24 → 13 に減らしたぶん、一輪を大きくする（仕様「巨大な生命体」）。
  // 遠景では淡い光、中景で輪郭、近景で膜と光粒、という階層を作るための土台
  flowerScale: 1.62,

  /* --- 器の形（深海の花とクラゲの中間） --- */
  flowerPetals: 7,          // 花びらの枚数
  flowerLength: 2.35,       // 中心から花びらの先までの長さ
  flowerWidth: 1.12,        // 花びらの最大の半幅。
                            // 広すぎると 7 枚が溶けて一枚の霞になり、
                            // 狭すぎると長いリボンに見える（器を大きくしたら要見直し）
  flowerDepth: 1.95,        // 器の深さ（中心の窪み。大きいほど深い器）
  flowerWaveU: 0.20,        // 長さ方向のうねり
  flowerWaveV: 0.16,        // 幅方向のうねり（膜が横に波打つ）
  flowerAsym: 0.20,         // 枚ごとの角度・長さ・幅のばらつき（左右対称にしない）
  // 分割数。少ないと折れ線になり「硬い板」に見える。
  // **照明を頂点ごとに計算しているので、ここが粗いと三角形の面が直線として出る**
  // （実際に出た。器の下側に階段状の直線が走った）
  flowerSegU: 16,
  flowerSegV: 10,

  /* --- 膜の見え方 --- */
  flowerAlpha: 0.42,        // 膜そのものの不透明度。上げると光を遮って暗くなる
  flowerBodyLit: 0.16,      // 光が無くても見える最低限の明るさ（形の輪郭）
  flowerGlowGain: 0.30,     // 光粒 1 個が膜を照らす強さ
  flowerLightFalloff: 2.6,  // 光粒からの距離の効き。大きいほど照らす範囲が狭い

  /* --- 揺らぎ（植物ではなくクラゲの膜） --- */
  flowerSwayAmp: 0.16,
  flowerSwaySpeed: 0.42,    // rad/s。非常にゆっくり

  /* --- 器の中に浮かぶ光粒（保存量の一部。新しくは作らない） --- */
  flowerLightRadius: 0.62,  // 器の内側のどこまで散らばるか（花の長さに対する比）
  // 大きいほど中心に密集する。**大きすぎると「密集」ではなく「重なり」になる。**
  // 2.0 では最初の 5 個が半径 0.15 以内に積み上がり、芯が重なって白飛びした
  // （完全な白飛び 0.060%。ムードボードは 0.001%）。
  // 0.5 が面積あたり均等。それより大きければ中心寄りになる
  flowerLightBias: 0.85,
  flowerLightLift: 0.16,    // 器の面からどれだけ浮くか
  flowerLightBob: 0.09,     // ゆっくりした上下の漂い

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
  fishLength: 2.10,   // 板の長さ（旧 ShapeGeometry の全長と同じ）
  /**
   * 魚の不透明度（段2）。
   *
   * **パラメータの値ではなく、画面で測った「実効の不透明度」で決める。**
   *   実効の不透明度 = 1 − (魚の内部の輝度中央値 ÷ 局所背景の輝度中央値)
   * ムードボードの実測は中央 0.399（`work/measure-fish.py`）。
   * 掃引の実測（`work/sweep-fish-opacity.mjs`。4時刻 × 同じ7匹）:
   *   0.78 → 0.547（＝これまでの値。ムードボードより濃い「黒い板」寄り）
   *   0.70 → 0.474
   *   0.63 → 0.448
   *   0.55 → 0.389  ← 採用。ムードボードの 0.399 と −0.010
   * 検査は `work/check-fish-density.mjs`（魚だけを白で描いたマスクで画素を固定する）。
   */
  fishOpacity: 0.55,
  /**
   * 積載光を魚からどれだけ離すか（全長に対する比。段2）。
   *
   * ムードボードでは積載光の重心が魚の**全長の 0.76〜1.47 倍だけ離れた位置**にある
   * （4匹の実測）。実装は魚の座標そのものに重ねていたため、
   * 「魚が光を運んでいる」ではなく「魚が光っている」に見え、
   * さらに**魚の黒の濃度を測ろうとすると光に埋もれて測れなかった**。
   * 進行方向の逆側（＝曳いている側）に置く。
   */
  fishCargoLead: 1.10,

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
 * 器の中に光粒が座る位置の表（花のローカル座標）。
 *
 * **CPU（粒そのものの描画）と GPU（膜がどこで明るくなるか）で同じ表を使う。**
 * 別々に計算すると、光っている場所と粒の場所がずれて「内側から照らされている」
 * ように見えなくなる。ここが一致していることが、この表現の土台になる。
 *
 * 中心ほど密（半径に指数を掛ける）。角度は黄金角で回して規則的な輪を避ける。
 */
function makeFlowerSlots(n) {
  const slots = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let k = 0; k < n; k++) {
    const q = (k + 0.5) / n;
    const r = CONF.flowerLength * CONF.flowerLightRadius * Math.pow(q, CONF.flowerLightBias);
    const th = k * golden;
    const u = Math.min(1, r / CONF.flowerLength);
    // 器の断面（_buildFlowers と同じ式）に載せ、そこから少し浮かせる。
    // 高さに個体差を付けないと、光が一枚の面に貼り付いて奥行きが消える
    const lift = CONF.flowerLightLift * (0.55 + ((k * 7) % 5) / 5);
    slots[k * 3] = Math.cos(th) * r;
    slots[k * 3 + 1] = CONF.flowerDepth * Math.pow(u, 1.7) + lift;
    slots[k * 3 + 2] = Math.sin(th) * r;
  }
  return slots;
}

/**
 * 花びら（膜）のマテリアル。
 *
 * **加算合成をやめた。** 加算は「花びら自身が光っている」ことにしかならず、
 * 仕様の「花びらそのものを発光させない」と正面から矛盾する。
 * 代わりに **プリマルチプライド合成**（`ONE, ONE_MINUS_SRC_ALPHA`）にして、
 * 1 枚の膜に 2 つの役目を同時に持たせる：
 *
 *   - `alpha` の分だけ後ろを**遮る**（膜としての厚み。器の奥は暗くなる）
 *   - `rgb` の分だけ**足す**（内部の光を膜が散乱して淡く光って見える分）
 *
 * 散乱の量は「その花が今いくつ光を抱えているか」だけで決まる。
 * 花は自分では光らず、**光粒がいなくなれば形の輪郭だけが残る**。
 */
function makePetalMaterial(slots, capacity) {
  return new THREE.ShaderMaterial({
    defines: { CAPACITY: capacity },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: new THREE.Color(PALETTE.cool).multiplyScalar(0.42) },
      uGlowCool: { value: new THREE.Color(PALETTE.cool) },
      uGlowWarm: { value: new THREE.Color(PALETTE.warm) },
      uAlpha: { value: CONF.flowerAlpha },
      uBodyLit: { value: CONF.flowerBodyLit },
      uGlowGain: { value: CONF.flowerGlowGain },
      uSlots: { value: slots },
      uLightFall: { value: CONF.flowerLightFalloff },
      uSwayAmp: { value: CONF.flowerSwayAmp },
      uSwaySpeed: { value: CONF.flowerSwaySpeed },
      uFogColor: { value: new THREE.Color(PALETTE.bgTop) },
      uFogDensity: { value: CONF.fogDensity },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      attribute float aPh;
      uniform float uTime;
      uniform float uSwayAmp;
      uniform float uSwaySpeed;
      uniform vec3 uSlots[CAPACITY];
      uniform float uLightFall;
      varying float vU;
      varying float vV;
      varying float vCharge;
      varying float vDepth;
      varying float vLit;
      varying float vNdv;

      void main() {
        vU = aU;
        vV = aV;
        // instanceColor の R に「蓄えの割合」が入っている
        #ifdef USE_INSTANCING_COLOR
          vCharge = instanceColor.r;
        #else
          vCharge = 1.0;
        #endif

        vec3 p = position;
        // 揺らぎ。根元は動かさず、先へ行くほど大きく。植物の揺れではなく
        // クラゲの傘のように、面全体がゆっくり波打つようにする
        float ph = aPh;
        #ifdef USE_INSTANCING
          ph += instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.9;
        #endif
        float s = sin(uTime * uSwaySpeed + ph + aU * 2.1);
        float s2 = sin(uTime * uSwaySpeed * 0.63 + ph * 1.7 + aV * 1.3);
        p.y += (s * 0.7 + s2 * 0.3) * uSwayAmp * pow(aU, 1.8);
        p.xz *= 1.0 + 0.035 * s2 * pow(aU, 1.5);

        // --- 光粒による局所的な照明 ---
        //
        // 「中心からの距離 × 総量」で近似するのをやめ、**粒 1 つずつからの距離**で足す。
        // 近似のままだとどの花も同じ形に光り、粒がどこにいるかが膜に出ない。
        // 頂点ごとに計算する（膜は滑らかなので断面ごとの補間で足りる）。
        float nOn = vCharge * float(CAPACITY);  // active は GLSL の予約語なので使えない
        float lit = 0.0;
        for (int i = 0; i < CAPACITY; i++) {
          // 蓄えの数だけを数える。break ではなく係数で消す（古い GLSL でも通る）
          float on = step(float(i) + 0.5, nOn);
          vec3 dd = p - uSlots[i];
          lit += on / (1.0 + dot(dd, dd) * uLightFall);
        }
        vLit = lit;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 nrm = normalMatrix * normal;
        #ifdef USE_INSTANCING
          mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
          nrm = normalMatrix * mat3(instanceMatrix) * normal;
        #endif
        // 面がどれだけ正面を向いているか。0 = 真横（シルエット）
        vNdv = abs(dot(normalize(nrm), normalize(-mv.xyz)));
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uTint;
      uniform vec3 uGlowCool;
      uniform vec3 uGlowWarm;
      uniform float uAlpha;
      uniform float uBodyLit;
      uniform float uGlowGain;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying float vU;
      varying float vV;
      varying float vCharge;
      varying float vDepth;
      varying float vLit;
      varying float vNdv;

      void main() {
        // 膜の縁。**硬い輪郭を一切作らない**のがこの作品での最優先。
        //
        // ここに「平坦部」を作ってはいけない。smoothstep(0.0, 0.62, edge) のように
        // 途中で 1.0 に達する形にすると、達した所に**輪郭線が立って板に見える**
        // （実際に一度そうなった。ガラスの破片のような直線が何本も出た）。
        // 中心線でだけ最大になり、面の端では必ず 0 になる連続な関数を掛け合わせる。
        float edge = 1.0 - abs(vV);
        float side = pow(smoothstep(0.0, 1.0, edge), 1.25);
        float tip  = smoothstep(1.0, 0.30, vU);       // 先は丸く消える
        float root = smoothstep(0.0, 0.34, vU);       // 根元も落として器の底を空ける
        // 面を真横から見ている所は溶かす。
        // ここを入れないと、器の下側のようにほぼ真横を向く面でシルエットが
        // 幅 0 の直線として立ち、「硬い板」に見える。
        float face = smoothstep(0.0, 0.34, vNdv);

        // 膜の厚み。散乱はこちらに比例させる（稜を掛けない）
        float aBase = uAlpha * side * tip * root * face;
        // 花びらの中心線に柔らかい稜を入れる。これが無いと 7 枚が溶け合って
        // 「器」ではなく「霞」に見える。線ではなく指数の山なので輪郭は立たない。
        // **稜は膜の見た目だけに効かせる。** 散乱にも掛けると中心線だけが明るくなり、
        // 遠目に放射状の光条（レンズフレア）に見える（§12 で一度却下した見え方）
        float vein = exp(-abs(vV) * 3.2);
        float a = aBase * (0.72 + 0.50 * vein);

        // 散乱の量は **その点の近くに光粒が何個いるか** で決まる（頂点で計算済み）。
        // 花は自分では光らないので、粒が抜ければ vLit が 0 になり形だけが残る。
        float glow = vLit * uGlowGain;

        // 膜そのものの色（発光ではない。形が辛うじて見える最低限）
        vec3 body = uTint * (uBodyLit + 0.22 * edge);
        // 散乱。中心は暖色寄り、外へ行くほど寒色へ。
        // **膜のある所でしか散らない**ので a を掛ける。掛けないと、膜が透明な
        // 場所にまで光が足されて、器の中心が白い塊に潰れる。
        vec3 scat = mix(uGlowWarm, uGlowCool, clamp(vU * 1.4, 0.0, 1.0)) * glow * aBase;

        // 霧。遠い花は水に溶ける
        float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
        vec3 rgb = mix(body * a + scat, uFogColor * a, fog);
        gl_FragColor = vec4(rgb, a * (1.0 - fog * 0.55));
      }
    `,
  });
}

// ---------------------------------------------------------------
// 魚のシルエット。**アルファだけを作る**（色はマテリアルの color で着ける）。
//
// 公開後に「黒い花びらのようなものが出る」と指摘を受けた箇所。以前は
// ShapeGeometry で輪郭そのものを三角形にしていたため、(1) 分割数が粗く曲線が
// 折れ線になり (2) 縁がぴたりと立ち (3) 尾が割れておらずレンズ形だったので、
// 魚ではなく「黒い木の葉」に見えていた。**原因は 3 つともこのテクスチャ側**で、
// 深度やブレンドの設定は無関係だったことを canary との画素比較で確認している。
//
// ぼかしに `ctx.filter = 'blur()'` は使わない。iOS Safari は対応が遅く、
// 効かない環境では**縁が立ったまま**＝直したはずの不具合がそのまま出る。
// 太さを変えたストロークを重ねて手で階段を作れば、どこでも同じ絵になる。
// ---------------------------------------------------------------
const FISH_TEX_W = 256;
const FISH_TEX_H = 128;
// 縁のぼかしの強さ。大きいほど柔らかい（テクスチャをこの割合まで縮めてから戻す）
const BLUR_DIV = 8;

function makeFishTexture(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // 正規化座標（左＝尾、右＝頭、y は上が 0）で形を決める
  const X = (t) => t * w;
  const Y = (t) => t * h;

  // --- 胴と尾。尾は割る（レンズ形に見えていた最大の原因） ---
  const body = new Path2D();
  body.moveTo(X(0.96), Y(0.50));                                   // 口先
  body.quadraticCurveTo(X(0.78), Y(0.29), X(0.52), Y(0.31));       // 背
  body.quadraticCurveTo(X(0.40), Y(0.33), X(0.31), Y(0.41));       // 尾の付け根へ絞る
  body.lineTo(X(0.05), Y(0.15));                                   // 尾びれ上の先
  body.quadraticCurveTo(X(0.17), Y(0.50), X(0.05), Y(0.85));       // 尾の切れ込み
  body.lineTo(X(0.31), Y(0.59));
  body.quadraticCurveTo(X(0.40), Y(0.67), X(0.52), Y(0.69));       // 腹
  body.quadraticCurveTo(X(0.78), Y(0.71), X(0.96), Y(0.50));
  body.closePath();

  // --- ひれ。胴より薄くして、透ける膜に見せる ---
  const fins = new Path2D();
  fins.moveTo(X(0.60), Y(0.30));                                   // 背びれ
  fins.quadraticCurveTo(X(0.52), Y(0.10), X(0.40), Y(0.30));
  fins.closePath();
  fins.moveTo(X(0.66), Y(0.66));                                   // 胸びれ
  fins.quadraticCurveTo(X(0.62), Y(0.86), X(0.50), Y(0.70));
  fins.closePath();

  // --- いったん輪郭どおりに塗る ---
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';  // ひれは薄く＝透ける膜に見せる
  ctx.fill(fins);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fill(body);

  // --- 縁をぼかす ---
  //
  // 幅を変えたストロークを重ねる方法では駄目だった。**外側に薄い裾は付くが、
  // 芯の塗りの境目でアルファが 0.1 → 1.0 に跳ねるので、縁は立ったまま**になる
  // （実測で 10%→90% が 1px。直したつもりで直っていなかった）。
  // 一度小さく描いてから引き伸ばすと、拡大時の線形補間が本物の階段を作る。
  // `ctx.filter='blur()'` に頼らないので iOS Safari でも同じ絵になる。
  const bw = Math.max(8, Math.round(w / BLUR_DIV));
  const bh = Math.max(8, Math.round(h / BLUR_DIV));
  const small = document.createElement('canvas');
  small.width = bw;
  small.height = bh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(c, 0, 0, bw, bh);

  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, w, h);
  // 芯が薄くなりすぎるので、同じものをもう一度重ねて中心だけ濃くする。
  // 加算ではなく通常合成なので、1.0 に達した芯はそれ以上濃くならず、
  // 裾だけが少し持ち上がる（縁の階段は残る）。
  ctx.drawImage(small, 0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  // **ここは光の粒と方針が逆で、ミップを作る。**
  // 光の粒は半径の 8% しかない芯がミップの平均で消えるので切っていたが、
  // 魚は大きく滑らかなシルエットで、失って困る細部が無い。
  // 画面上は 50〜90px しかないのに 256px のテクスチャを貼るため強い縮小になり、
  // ミップが無いと縁が飛び飛びに標本化されて**ぼかしたはずの階段が消える**うえ、
  // 泳いで動く分だけちらつく（1時間眺める作品では致命的）。
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------
// 花の個体差。位置から決めるので毎フレーム安定し、インデックスが
// 入れ替わっても（swap-remove で起きる）同じ花は同じ姿のままになる。
// 光の位置と花弁の位置がずれないよう、両方でこの1か所を使う。
// ---------------------------------------------------------------
const FLOWER_BASE_DY = -0.4;   // 花の根元の高さ（ecosystem の y からの差）
const FLOWER_DY_JITTER = 6.2;  // 高さの個体差の幅。器を大きくしたぶん広げないと、
                               // 縁どうしが重なって横一列の帯に融合する（実際にそうなった）

function hash2(x, z, ax, az, k) {
  return (Math.abs(Math.sin(x * ax + z * az)) * k) % 1;
}

/**
 * 花の姿勢。**光粒の配置と花弁の描画で必ず同じものを使う。**
 * 別々に計算すると、器が傾いているのに光だけ傾かない、という壊れ方をする。
 */
function flowerQuaternion(ft, out) {
  _euler2.set((ft.h2 - 0.5) * 0.42, ft.h2 * Math.PI * 2, (ft.h3 - 0.5) * 0.42);
  return out.setFromEuler(_euler2);
}

/** 割り当てを起こさないよう、結果は使い回しのオブジェクトに書く。 */
const _ft = { h1: 0, h2: 0, h3: 0, baseY: 0, scale: 0 };
const _euler2 = new THREE.Euler();
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
    // コンテキストが生きているか。false になっている間は描かない（§6.4）
    this.contextLost = false;
    this.contextLostCount = 0;

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
    this._bindContextEvents();
  }

  // ---------------------------------------------------------------
  // WebGL コンテキストの消失と復帰（§6.4）
  //
  // iOS はメモリ逼迫やアプリ切替でコンテキストを容赦なく捨てる。捨てられたまま
  // 描き続けると**エラーも出さずに黒い画面**になる。これが「一晩置いたら黒かった」の正体。
  // ---------------------------------------------------------------
  _bindContextEvents() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('webglcontextlost', (e) => {
      // これを呼ばないと webglcontextrestored が来ない。
      // three.js も自前のハンドラで呼んでいる（先に登録されているので実際はそちらが効く）が、
      // 依存したくないので明示的に呼ぶ。二重に呼んでも害はない。
      e.preventDefault();
      this.contextLost = true;
      this.contextLostCount++;
    }, false);

    canvas.addEventListener('webglcontextrestored', () => {
      // three.js は initGLContext() で WebGLProperties と WebGLTextures を作り直すので、
      // テクスチャとバッファは次の描画で自動的に再アップロードされる。
      // ただし **WebGLBackground も作り直される**ため、setClearColor で入れた値は失われる。
      // ここで入れ直さないと、消失前と後で背景の下端の色が変わる。
      this.renderer.setClearColor(PALETTE.bgBottom, 1);
      this.renderer.autoClear = false;
      // ビューポートと pixelRatio も張り直す（state が作り直されているため）
      this.resize();
      this.contextLost = false;
      this.forceCompositorRepaint();
    }, false);
  }

  /**
   * 合成レイヤーを作り直させる。
   *
   * iPad Safari が GPU タイルを描かず黒いまま／一部の帯だけ正しい色、という
   * 事象が別プロジェクト（kana-practice, 2026-07）で実際に起きた。
   * **`void el.offsetHeight` による reflow 強制は効かない**（レイヤーが再構築されないため）。
   * display を none → '' に**同期的に**トグルするとレイヤーごと作り直される。
   * 同一タスク内で戻すのでちらつかない。
   *
   * Safari 固有なので Chrome では黒を再現できない。ここは実機でしか最終確認できない。
   */
  forceCompositorRepaint() {
    const el = this.renderer.domElement;
    const prev = el.style.display;
    el.style.display = 'none';
    void el.offsetHeight; // 読み取ってスタイルの再計算を確定させる
    el.style.display = prev || '';
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
        uSizeScale: { value: 1 },
        uGain: { value: CONF.lightGain },
        uWarmGain: { value: CONF.lightWarmGain },
      },
      vertexShader: `
        attribute float aWarm;
        attribute float aScale;
        uniform float uSize, uRefDist, uFocus, uFocusRange, uBlurSize, uBlurDim, uSizeScale, uFogDensity;
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
          gl_PointSize = uSize * aScale * uSizeScale * (1.0 + blur * uBlurSize) * uRefDist / max(depth, 1.0);

          float fog = exp(-uFogDensity * uFogDensity * depth * depth);
          vDim = fog / (1.0 + blur * uBlurDim);

          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec3 uWarm, uCool;
        uniform float uGain, uWarmGain;
        varying float vWarm;
        varying float vDim;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.004) discard;
          vec3 c = mix(uCool, uWarm, vWarm);
          // uGain は白飛び対策（CONF.lightGain のコメント参照）。
          // uWarmGain は暖色だけに掛ける（濃くして失った輝度を暖色の側で返す。
          // 寒色まで明るくすると iPhone の「光が強い」を再発させる）
          gl_FragColor = vec4(c * a * vDim * uGain * mix(1.0, uWarmGain, vWarm), 1.0);
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
        uSizeScale: { value: 1 },
        uFogDensity: { value: CONF.fogDensity },
        uPointer: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `
        attribute float aPhase;
        attribute float aScale;
        uniform float uTime, uSize, uRefDist, uSizeScale, uFogDensity;
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
          // 微粒子は元々 2.4px しかないので、小さい画面では 1px を割ってちらつく。
          // 空気を作るための背景なので、下限だけ設けて消えないようにする
          gl_PointSize = max(uSize * aScale * uSizeScale * uRefDist / max(depth, 1.0), 1.3);
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
  /**
   * 器（花冠）を組む。
   *
   * 平らな板を放射状に並べる作りをやめ、**中心が窪んだ器の面を直接張る**。
   * 板だと (1) 硬く見え (2) 器の内側という空間ができないので、
   * 「内部に光が浮かんでいる」を絵として作れなかった。
   *
   * 花びら 1 枚は u（根元 0 → 先 1）× v（左右 -1..1）の格子。
   * 枚数・角度・長さ・幅・うねりの位相を枚ごとにずらし、左右対称にしない。
   */
  _buildFlowers() {
    const max = this.eco.params.flowerMax;
    const P = CONF.flowerPetals;
    const NU = CONF.flowerSegU, NV = CONF.flowerSegV;

    const vtx = [];
    const aU = [];      // 中心からの距離（0..1）。散乱の計算に使う
    const aV = [];      // 花びらの幅方向（-1..1）。縁の抜けに使う
    const aPh = [];     // 枚ごとの揺れの位相
    const idx = [];

    // 枚ごとのばらつき。乱数ではなく決まった式から出す（毎回同じ形になる）
    const jit = (k, s) => (Math.abs(Math.sin(k * 12.9898 + s * 78.233)) * 43758.5453) % 1;

    for (let k = 0; k < P; k++) {
      const asym = CONF.flowerAsym;
      const ang = (k / P) * Math.PI * 2 + (jit(k, 1) - 0.5) * asym;
      const len = CONF.flowerLength * (1 + (jit(k, 2) - 0.5) * asym);
      const wid = CONF.flowerWidth * (1 + (jit(k, 3) - 0.5) * asym * 1.2);
      const ph = jit(k, 4) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const base = vtx.length / 3;

      for (let i = 0; i <= NU; i++) {
        const u = i / NU;
        // 幅：根元で細く、中ほどで最大、**先を 0 にしない**。
        // 0 にすると幾何が尖って刃物に見える（実際に一度そうなった）。
        // 「先端は丸く柔らかく」はアルファ側で作る。
        const hw = wid * (0.40 + 0.60 * Math.sin(Math.PI * Math.pow(u, 0.60)));
        const r = len * u;
        for (let j = 0; j <= NV; j++) {
          const v = (j / NV) * 2 - 1;
          // 器の断面：中心が最も低く、外へ行くほど立ち上がる
          let y = CONF.flowerDepth * Math.pow(u, 1.7);
          // うねり。先へ行くほど大きく波打たせる（クラゲの傘の縁）
          y += CONF.flowerWaveU * Math.sin(u * Math.PI * 1.7 + ph) * Math.pow(u, 1.4);
          y += CONF.flowerWaveV * Math.sin(v * Math.PI * 1.15 + ph * 2) * Math.pow(u, 1.5);
          const off = v * hw;
          vtx.push(ca * r - sa * off, y, sa * r + ca * off);
          aU.push(u);
          aV.push(v);
          aPh.push(ph);
        }
      }

      const row = NV + 1;
      for (let i = 0; i < NU; i++) {
        for (let j = 0; j < NV; j++) {
          const a = base + i * row + j;
          idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vtx, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU, 1));
    geo.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 1));
    geo.setAttribute('aPh', new THREE.Float32BufferAttribute(aPh, 1));
    geo.setIndex(idx);
    // 法線を作る。**シルエットで膜を溶かすのに要る。**
    // 面を斜めから見ると、縁のなだらかな変化が画面上ほぼ幅 0 に圧縮され、
    // 直線が立って「硬い板」に見える（実際に器の下側に直線が走った）
    geo.computeVertexNormals();

    const cap = this.eco.params.flowerCapacity;
    this._slots = makeFlowerSlots(cap);
    const mat = makePetalMaterial(this._slots, cap);
    this.flowerMat = mat;

    this.flowerMesh = new THREE.InstancedMesh(geo, mat, max);
    this.flowerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flowerMesh.frustumCulled = false;
    this.flowerMesh.count = max;
    // 光より後に描く。膜は光を遮りながら散乱もするので、
    // 先に描くと「花びら越しに透けて見える」にならない
    this.flowerMesh.renderOrder = 4;
    // 蓄えの量を instanceColor の R に載せる（G/B は個体差の色味に使う）
    this.flowerMesh.setColorAt(0, new THREE.Color(0, 0, 0));
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
    // 板 1 枚 ＋ アルファのテクスチャで作る。以前は ShapeGeometry で輪郭そのものを
    // 三角形に分割していたが、分割数が粗く曲線が折れ線として見えた。
    // テクスチャなら曲線は canvas が描くので、どこまで寄っても折れない。
    // 板の寸法はテクスチャの縦横比から出す（全長を指定し、丈は比で決める）。
    // ここで全長を掛けたうえに fishScale も掛けると二重に効くので注意
    const len = CONF.fishLength;
    const geo = new THREE.PlaneGeometry(len, (len * FISH_TEX_H) / FISH_TEX_W);
    geo.rotateY(-Math.PI / 2); // ローカル +X（進行方向）を +Z に合わせ、lookAt を使えるようにする
    geo.scale(CONF.fishScale, CONF.fishScale, CONF.fishScale);

    const mat = new THREE.MeshBasicMaterial({
      color: PALETTE.fish,
      map: makeFishTexture(FISH_TEX_W, FISH_TEX_H),
      transparent: true,
      opacity: CONF.fishOpacity,
      side: THREE.DoubleSide,
      fog: true,          // 遠い魚は水に溶ける
      // 半透明なので深度は書かない。
      // **これが「黒い切り抜き」の原因ではない。** 当初そう説明したが、
      // depthWrite を true に戻した canary と画素単位で比較したところ
      // 差は 0 画素だった（光の粒も花も depthWrite を切っているため、
      // この場面では深度テストに落ちるものが無い）。原因はすべてテクスチャ側。
      // それでも false にしておくのは、半透明の描画順に結果を依存させないため。
      depthWrite: false,
    });

    this.fishMeshes = [];
    for (let i = 0; i < this.eco.fishes.length; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      // 光より後に描く。実測ではこれを外しても絵は変わらなかった（差 0 画素）が、
      // three.js の半透明ソートは物体の中心距離で決まるため、魚が動けば順序も動く。
      // 明示しておけば「たまたま今は正しい」状態に依存しない。
      m.renderOrder = 5;
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
    // 粒の大きさは「描画バッファの高さ」に比例させる（CONF.refDist のコメント参照）。
    // 世界の見かけの大きさは縦画角で決まるのでバッファ高に比例する。粒だけを
    // pixelRatio に比例させると、画面が縦に短いほど粒が相対的に肥大し、
    // 加算合成で超線形に明るくなる（iPhone 横向きで白飛び 3.2%）。
    const pr = this.renderer.getPixelRatio();
    const scale = (h * pr) / CONF.refBufferHeight;
    this.lightMat.uniforms.uSizeScale.value = scale;
    this.moteMat.uniforms.uSizeScale.value = scale;
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
    this.flowerMat.uniforms.uTime.value = this.time;
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

    // 花の蓄え（暖色）。**器の内側に浮かべる。**
    //
    // 以前は椀の底から放射状に伸びる「糸」の先に載せていたが、
    // 器そのものを作った今は、その内側の空間に散らすほうが素直で、
    // 「花の内部に光が漂っている」がそのまま絵になる。
    // 中心ほど密にするため半径に指数を掛ける（均等に置くと輪に見える）。
    const flowers = eco._flowers;
    const slots = this._slots;
    const t = this.time;
    for (let i = 0; i < eco.flowerCount; i++) {
      const f = flowers[i];
      // 花弁と同じ個体差・同じ回転を使う。**膜の照明もこの表を見ている**ので、
      // ここを別に計算すると「光っている場所」と「粒の場所」がずれる
      const ft = flowerTransform(f, _ft);
      flowerQuaternion(ft, this._q);
      for (let k = 0; k < f.charge && n < this.lightN; k++) {
        const d = n * 3, sb = k * 3;
        // ゆっくりした漂い。器の中で息をしているように見せる
        const bob = Math.sin(t * 0.55 + k * 1.7 + f.x * 0.3) * CONF.flowerLightBob;
        this._v3.set(slots[sb], slots[sb + 1] + bob, slots[sb + 2]);
        this._v3.applyQuaternion(this._q).multiplyScalar(ft.scale);
        pos[d] = f.x + this._v3.x;
        pos[d + 1] = ft.baseY + this._v3.y;
        pos[d + 2] = f.z + this._v3.z;
        warm[n] = 1;
        scale[n] = CONF.lightWarmBoost;
        n++;
      }
    }

    // 魚の積載（暖色）
    const fishes = eco.fishes;
    for (let i = 0; i < fishes.length; i++) {
      const fi = fishes[i];
      // 積載は魚に重ねず、進行方向の逆側へ全長の CONF.fishCargoLead 倍だけ離す（§11.12）
      const sp = Math.hypot(fi.vx, fi.vy, fi.vz);
      const lead = CONF.fishLength * CONF.fishScale * CONF.fishCargoLead;
      const lx = sp > 0.01 ? -fi.vx / sp * lead : 0;
      const ly = sp > 0.01 ? -fi.vy / sp * lead : 0;
      const lz = sp > 0.01 ? -fi.vz / sp * lead : 0;
      for (let k = 0; k < fi.cargo && n < this.lightN; k++) {
        const d = n * 3, ob = ((i * 97 + k) % this.lightN) * 3;
        const cs = CONF.fishCargoSpread;
        pos[d] = fi.x + lx + off[ob] * cs;
        pos[d + 1] = fi.y + ly + off[ob + 1] * cs * 0.7;
        pos[d + 2] = fi.z + lz + off[ob + 2] * cs;
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
        flowerQuaternion(ft, this._q);   // 光粒の配置と同じ式（1か所にまとめてある）
        this._v3b.set(s, s, s);
        this._m4.compose(this._v3, this._q, this._v3b);
        // R に蓄えの割合を載せる。**花は自分では光らないので下駄を履かせない。**
        // 0 のときは 0 にして、光が抜けた花は形の輪郭だけが残るようにする。
        this._color.setRGB(Math.min(1, f.charge / cap), ft.h1, ft.h3);
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
    // 死んだコンテキストには描かない。描いても黙って何も起きず、
    // 「動いているのに黒い」という一番たちの悪い状態になる。
    if (this.contextLost) return;
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }
}

export default Renderer;
