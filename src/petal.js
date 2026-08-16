/**
 * meguru — 花弁のテクスチャ（形・葉脈・縁）を作る純関数
 *
 * THREE も document も import しない。`render.js` から canvas に焼くのに使い、
 * Node の `node --test` からも直接検証する（`src/falloff.js` と同じ流儀）。
 *
 * 【なぜテクスチャにしたか】
 * それまでの花弁の形は、滑らかな包絡の掛け算だった:
 *
 *   aBase = uAlpha * side * tip * root * face
 *
 * **この形には「端」という概念が無い。** どれも 0 へ滑らかに落ちる関数なので、
 * 掛け合わせても滑らかなまま。実際に、
 *   - 縁を光らせるリムを4通り試して、置く場所が無いので全部「弧」や「板」になった（§11.22）
 *   - `side` を3倍・`tip` を4倍急にしても、画面で測った縁の幅が**まったく動かなかった**
 * 定数をどう選んでも輪郭は出ない ―― 構造の問題だった。
 *
 * 【もう一つの利点: 検査が短くなる】
 * 3D で描いて撮って bbox を選んで勾配を測る経路は、bbox の取り方で4割動き、
 * 内側の広い勾配に汚染されていた（物差しに2回騙された）。
 * ここは純関数なので、**縁の幅も葉脈の本数も断面から直接 assert できる**。
 * レンダリングも bbox も要らない。
 *
 * 座標: u = 0(根元) 〜 1(先端) / v = -1 〜 +1（花弁を横切る）
 */

/** 花弁の形と模様の定数。正本はここ（`render.js` の CONF からは参照するだけ）。 */
export const PETAL = {
  // --- 形 ---
  // 縁が落ちる幅（半幅 hw に対する比）。**縁の直前まで不透明度を保ち、縁だけ急に落とす。**
  //
  // 目標は参照画像の実測「膜→水の遷移が**花幅の 1.4〜2.5%**」（work/measure-edge-width.py）。
  // 換算: 花幅 = 2 × flowerLength = 4.70。u=0.6 での半幅 hw = 0.944。
  //   遷移(world) = 0.020 × 4.70 = 0.094  →  v 単位で 0.100  →  smoothstep の幅は ÷0.447 で 0.22
  // （smoothstep が 0.2→0.8 になる区間は指定幅の 0.447 倍）
  //
  // **旧実装 pow(smoothstep(0,1,edge),1.25) は v 単位で 0.36 ＝ 花幅の 7.2%。**
  // 画面から測った実測 6.7〜8.0% と一致するので、この換算は信用してよい。
  edgeWidth: 0.22,
  // **絞りすぎると花が縦に短く見え、iPhone 縦で樹冠の高さが §11.4 の帯（45〜75%）を割る**
  // （taperTo 0.30 / tipWidth 0.14 のとき t=600s で 44.5%）。先端は絞るが、丈は残す。
  tipWidth: 0.08,      // 先端が落ちる幅（長さに対する比）
  rootWidth: 0.30,     // 根元を空ける幅（§8.4「器の底を空ける」）

  // 先端に向かって膜の幅を絞る＝**シルエットを丸く閉じる**。
  // ジオメトリの半幅は先端でも 0 にしていない（0 にすると幾何が尖って刃物に見える。§11.8）。
  // その「先端は丸く柔らかく」をアルファ側で作る、と §11.8 が書いていた役目がこれ。
  // 膜を**広げることはできないが、狭めることはできる**（テクスチャは媒介変数の空間なので）。
  taperStart: 0.45,    // ここから先で幅を絞り始める
  taperTo: 0.32,       // 先端での幅（半幅に対する比）

  // --- 葉脈（段10 の繊維の距離場をそのまま 2D に焼く）---
  // 参照は円弧の上で 44〜49 本・膜の空白率およそ 50%（work/measure-vein-radial.py）。
  // 24本 × 太さ0.035 だと隣同士が接して空白率 22% ＝ 全面模様に近づく（単体テストが検出）。
  veins: 22,           // 花弁1枚あたりの親繊維
  veinWidth: 0.022,    // 繊維の太さ（v 単位）
  veinJitter: 0.55,    // 位置の不揃い（隣との間隔に対する比）
  veinBranch: 0.90,    // 子繊維（枝）の強さ

  // --- 縁の光 ---
  // §11.8 の実測「膜側 41 → 縁 107（3〜4倍）。ただし片側だけ」。
  // **全周に入れると輪になって皿に見える**ので、v > 0 側にだけ焼く
  // （花弁ごとの左右差は、シェーダ側で uv を反転して作る）。
  // **縁に沿わせ、かつ短くする。** 媒介変数の空間で全長を貫く直線を引くと、
  // 3D では花弁の縁に沿った**長い曲線**になり「弧」に見えた（4通り試して全部そうなった）。
  rimInset: 0.10,      // 膜の端からどれだけ内側に線の芯を置くか
  rimWidth: 0.05,      // 線の太さ（v 単位）
  rimFrom: 0.55,       // 線が出る範囲（長さに対する比）
  rimTo: 0.90,
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** GLSL の smoothstep と同じ（境界が逆順でも動く） */
export function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** 決まった式から作る疑似乱数（乱数を使わない＝毎回同じ絵になる） */
function hash(x) {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

/** その位置での膜の半幅（1 = ジオメトリいっぱい）。先端へ行くほど絞る */
export function petalHalf(u, p = PETAL) {
  return 1 - (1 - p.taperTo) * smoothstep(p.taperStart, 1, u);
}

/** 膜の形（0..1）。縁・先端・根元の3つの落ち方の積 */
export function petalShape(u, v, p = PETAL) {
  const edge = petalHalf(u, p) - Math.abs(v);
  const side = smoothstep(0, p.edgeWidth, edge);
  const tip = smoothstep(1, 1 - p.tipWidth, u);
  const root = smoothstep(0, p.rootWidth, u);
  return side * tip * root;
}

/**
 * 葉脈（0..1）。段10 と同じ「個体を持った繊維の距離場」。
 *
 * 周期関数（fract）で並べると膜の全面が模様で埋まってしまい、参照画像の
 * 「繊維と繊維の間に何も無い滑らかな膜」にならない（§11.21）。
 */
export function petalVeins(u, v, p = PETAL) {
  let line = 0;
  for (let i = 0; i < p.veins; i++) {
    const sd = i * 17.3 + 1.0;
    const r1 = hash(sd * 12.9898);
    const r2 = hash(sd * 78.2330);
    const r3 = hash(sd * 39.4250);
    const r4 = hash(sd * 91.1170);
    const r5 = hash(sd * 53.9110);

    // 根元で収束し、先へ行くほど花弁の幅いっぱいに広がる
    let target = ((i + 0.5) / p.veins) * 2 - 1;
    target += (r1 - 0.5) * p.veinJitter * (2 / p.veins);
    const cv = target * Math.pow(u, 0.65);
    // 根元では間隔も狭いので太さも細くする（狭い所で潰れて繋がらないように）
    const wd = p.veinWidth * (0.35 + 0.65 * Math.pow(u, 0.65)) * (0.75 + 0.5 * r3);

    // **途中で終わる。** 端は必ず 0 に落として輪郭を立てない
    const eU = 0.62 + 0.38 * r2;
    const env = smoothstep(0.03, 0.20, u) * smoothstep(eU, eU - 0.28, u);
    const d = (v - cv) / wd;
    line = Math.max(line, Math.exp(-d * d) * env);

    // 子繊維（枝）。親の途中から片側へ分かれ、短く終わる
    const sp = 0.30 + 0.35 * r4;
    const dir = r5 < 0.5 ? -1 : 1;
    const cc = cv + dir * Math.max(u - sp, 0) * 0.55;
    const cE = sp + 0.25 + 0.30 * r3;
    const cEnv = smoothstep(sp, sp + 0.10, u) * smoothstep(cE, cE - 0.18, u);
    const dc = (v - cc) / (wd * 0.7);
    line = Math.max(line, Math.exp(-dc * dc) * cEnv * p.veinBranch);
  }
  // 端では 0 に落とす（膜の縁と同じ考え方）
  return line * smoothstep(0.02, 0.20, u)
    * Math.pow(clamp01(petalHalf(u, p) - Math.abs(v)), 0.6);
}

/** 縁の光（0..1）。**片側だけ**（v > 0 側）。左右差はシェーダで uv を反転して作る */
export function petalRim(u, v, p = PETAL) {
  if (v <= 0) return 0;
  const d = (v - (petalHalf(u, p) - p.rimInset)) / p.rimWidth;
  const band = Math.exp(-d * d);
  // **短い線にする。** 両端は細く消す（閉じた輪にしない・長い弧にしない）
  return band * smoothstep(p.rimFrom, p.rimFrom + 0.12, u) * smoothstep(p.rimTo, p.rimTo - 0.12, u);
}

/**
 * 1画素ぶんの値。R=形 / G=葉脈 / B=縁の光。
 * @returns {{shape:number, vein:number, rim:number}} いずれも 0..1
 */
export function petalSample(u, v, p = PETAL) {
  return { shape: petalShape(u, v, p), vein: petalVeins(u, v, p), rim: petalRim(u, v, p) };
}

/**
 * 縁の幅を測る（テストと設計の確認用）。
 * u を固定して v を +1 側から内側へ走り、形が 0.2 → 0.8 になるまでの距離を返す。
 * **半幅に対する比**（花幅に対する比ではないので注意。花幅 = 半幅 × 2）。
 */
export function measureEdge(u, p = PETAL, steps = 4000) {
  let v20 = null, v80 = null;
  for (let i = 0; i <= steps; i++) {
    const v = 1 - i / steps;            // 縁から内側へ
    const s = petalShape(u, v, p);
    if (v20 === null && s >= 0.2) v20 = v;
    if (v80 === null && s >= 0.8) { v80 = v; break; }
  }
  if (v20 === null || v80 === null) return null;
  return v20 - v80;
}
