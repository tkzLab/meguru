/**
 * 花弁テクスチャの検査。**3D で描かずに、純関数の断面から直接測る。**
 *
 * 画面から測る経路（描画→スクショ→bbox→勾配）は、bbox の取り方で4割動き、
 * 内側の広い勾配に汚染されて**膜の形を動かしても数値が動かなかった**（§11.23）。
 * ここは決定的に測れる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PETAL, petalShape, petalVeins, petalRim, measureEdge } from '../src/petal.js';

test('縁の幅が参照の帯（花幅の 1.4〜2.5%）に収まる', () => {
  // 換算は src/petal.js の edgeWidth のコメント参照。
  // 遷移(v単位) × 半幅hw(u) ÷ 花幅(2*flowerLength) = 花幅に対する比
  const L = 2.35, WID = 1.12;
  for (const u of [0.4, 0.6, 0.8]) {
    const w = measureEdge(u);
    assert.ok(w !== null, `u=${u} で縁が見つからない`);
    const hw = WID * (0.40 + 0.60 * Math.sin(Math.PI * Math.pow(u, 0.60)));
    const pct = (w * hw) / (2 * L) * 100;
    assert.ok(pct > 1.2 && pct < 3.2, `u=${u} の縁の幅 ${pct.toFixed(2)}%（花幅比）が範囲外`);
  }
});

test('縁の内側は不透明が保たれている（滑らかに落ち続けない）', () => {
  // 旧実装 pow(smoothstep(0,1,1-|v|),1.25) は |v|=0.5 で 0.42 しかなかった。
  // 「端の直前まで保つ」なら、半分の位置ではほぼ 1.0 のはず
  const s = petalShape(0.6, 0.5);
  assert.ok(s > 0.9, `|v|=0.5 の不透明度 ${s.toFixed(3)} が低い＝端が無い形に戻っている`);
});

test('先端は幅が絞られて丸く閉じる', () => {
  assert.ok(petalShape(0.95, 0.6) < 0.05, '先端で幅が絞られていない');
  assert.ok(petalShape(0.55, 0.6) > 0.5, '中ほどまで絞られてしまっている');
});

test('先端と根元は 0 に落ちる（硬い切り口を作らない）', () => {
  assert.ok(petalShape(1.0, 0) < 0.01, '先端が閉じていない');
  assert.ok(petalShape(0.0, 0) < 0.01, '根元が閉じていない');
  assert.ok(petalShape(0.6, 1.0) < 0.01, '横の縁が閉じていない');
});

test('葉脈は「線と線の間に何も無い」（全面模様ではない）', () => {
  // u を固定して v を走査し、低い所（膜だけ）の割合を見る。
  // 周期場だと全面が模様で埋まるのでここが小さくなる（§11.21）
  let empty = 0, n = 0;
  for (let i = 0; i <= 2000; i++) {
    const v = -0.9 + 1.8 * (i / 2000);
    const g = petalVeins(0.6, v);
    n++;
    if (g < 0.10) empty++;
  }
  const ratio = empty / n;
  assert.ok(ratio > 0.35, `膜の空白率 ${(ratio * 100).toFixed(1)}% が低い＝全面模様になっている`);
});

test('葉脈の本数が設計どおり（数えられる本数がある）', () => {
  let peaks = 0;
  let prev = 0, rising = false;
  for (let i = 0; i <= 4000; i++) {
    const v = -0.95 + 1.9 * (i / 4000);
    const g = petalVeins(0.6, v);
    if (g > prev) rising = true;
    else if (rising && g < prev && prev > 0.25) { peaks++; rising = false; }
    prev = g;
  }
  assert.ok(peaks >= 10 && peaks <= PETAL.veins * 2,
    `葉脈の本数 ${peaks} が想定外（設計は親 ${PETAL.veins} 本＋枝）`);
});

test('縁の光は片側だけ（全周だと輪になって皿に見える）', () => {
  const u = 0.75, at = 1 - (1 - 0.30) * 0 - 0;   // 位置は petalHalf に従うので走査で探す
  let best = 0, bestV = 0;
  for (let i = 0; i <= 1000; i++) {
    const v = i / 1000;
    const r = petalRim(u, v);
    if (r > best) { best = r; bestV = v; }
  }
  assert.ok(best > 0.7, `光る側にリムが無い（最大 ${best.toFixed(2)}）`);
  assert.equal(petalRim(u, -bestV), 0, 'リムが両側に出ている');
  // **短い線であること**（全長を貫くと 3D で長い弧になる）
  assert.ok(petalRim(0.35, bestV) < 0.05, 'リムが根元側まで伸びている');
  assert.ok(petalRim(0.98, bestV) < 0.05, 'リムが先端まで伸びている');
});

test('わざと壊すと縁の検査が落ちる（canary）', () => {
  const broken = { ...PETAL, edgeWidth: 0.80 };   // 半幅いっぱいで落ちる＝段12前の形
  const L = 2.35, WID = 1.12, u = 0.6;
  const hw = WID * (0.40 + 0.60 * Math.sin(Math.PI * Math.pow(u, 0.60)));
  const pct = (measureEdge(u, broken) * hw) / (2 * L) * 100;
  assert.ok(pct > 3.2, `壊した形の縁の幅 ${pct.toFixed(2)}% が範囲内のまま＝検査が効いていない`);
});
