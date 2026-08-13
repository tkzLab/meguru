/**
 * meguru — 循環ロジックの検証（design.md §7 の ①②⑤）
 *
 * 実行: node --test test/
 *
 * 【重要】このファイルの本体は canary である。
 * assert が通ることと、その assert が失敗しうることは別。
 * 「わざと壊すと赤くなる」ことを確認しない検証は、空振りしている可能性がある。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Ecosystem, DEFAULT_PARAMS } from '../src/ecosystem.js';

const DT = 1 / 30;
const TEN_MIN = 18000; // 10分 @30fps
const GRID = 8;
const SNAPSHOT_INTERVAL_SEC = 5;
const COMPARE_LAG_SEC = 30;
const L1_THRESHOLD = 0.15;

/**
 * 画面上の「光がどこにあるか」を 8x8 の分布にする。
 * 漂う光・花の蓄え・魚の積載をすべて同じ重み1で数えるので、
 * 合計は常に totalLight になる（正規化しても情報が落ちない）。
 * 期待値は決め打ちせず、実物から読む。
 */
function densityGrid(eco) {
  const p = eco.params;
  const g = new Float64Array(GRID * GRID);
  const hx = p.worldX / 2;
  const hz = p.worldZ / 2;

  const put = (x, z, w) => {
    let ix = Math.floor(((x + hx) / p.worldX) * GRID);
    let iz = Math.floor(((z + hz) / p.worldZ) * GRID);
    ix = Math.max(0, Math.min(GRID - 1, ix));
    iz = Math.max(0, Math.min(GRID - 1, iz));
    g[iz * GRID + ix] += w;
  };

  const pos = eco.driftPositions;
  for (let i = 0; i < eco.driftCount; i++) put(pos[i * 3], pos[i * 3 + 2], 1);
  for (const f of eco.flowers) put(f.x, f.z, f.charge);
  for (const fi of eco.fishes) put(fi.x, fi.z, fi.cargo);

  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  if (sum > 0) for (let i = 0; i < g.length; i++) g[i] /= sum;
  return g;
}

/** 2つの分布の L1 距離。0（同一）〜2（重なりなし）。 */
function l1(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
}

/**
 * 決められたステップ数だけ回し、検証に必要なものを集める。
 * 毎ステップ totalLight を検査する。
 */
function run(steps, options) {
  const eco = new Ecosystem(options);
  const expected = eco.params.totalLight;

  let violation = null;
  const snapshots = [];
  const flowerCounts = [];
  const snapEvery = Math.round(SNAPSHOT_INTERVAL_SEC / DT);
  let pickupsAtLastMinute = 0;
  const lastMinuteStart = steps - Math.round(60 / DT);

  for (let s = 0; s < steps; s++) {
    eco.step(DT);

    // ① 毎ステップ検査する
    const total = eco.totalLight;
    if (total !== expected && violation === null) {
      violation = { step: s, time: s * DT, total, expected };
    }

    flowerCounts.push(eco.flowerCount);
    if (s === lastMinuteStart) pickupsAtLastMinute = eco.stats.pickups;
    if (s % snapEvery === 0) snapshots.push({ t: s * DT, g: densityGrid(eco) });
  }

  return {
    eco,
    violation,
    snapshots,
    flowerCounts,
    minFlowers: Math.min(...flowerCounts),
    maxFlowers: Math.max(...flowerCounts),
    pickupsInLastMinute: eco.stats.pickups - pickupsAtLastMinute,
  };
}

/** 30秒離れた全ペアの L1 距離を返す。 */
function lagDistances(snapshots) {
  const lag = Math.round(COMPARE_LAG_SEC / SNAPSHOT_INTERVAL_SEC);
  const out = [];
  for (let i = 0; i + lag < snapshots.length; i++) {
    out.push({ t: snapshots[i].t, d: l1(snapshots[i].g, snapshots[i + lag].g) });
  }
  return out;
}

// =====================================================================
// ① 光の総数が常に一定（構造的不変条件）
// =====================================================================

test('① 10分間、光の総数が毎ステップ 300 のまま', () => {
  const r = run(TEN_MIN, { seed: 1 });
  assert.equal(
    r.violation,
    null,
    r.violation ? `t=${r.violation.time.toFixed(2)}s で総数が ${r.violation.total}（期待 ${r.violation.expected}）` : ''
  );
  assert.equal(r.eco.totalLight, 300);
  // 受け渡しが実際に起きていること（何もしていないのに保存されていた、を防ぐ）
  assert.ok(r.eco.stats.absorbs > 0, '吸収が一度も起きていない');
  assert.ok(r.eco.stats.pickups > 0, '魚の受け取りが一度も起きていない');
  assert.ok(r.eco.stats.releases > 0, '魚の放出が一度も起きていない');
});

test('① パラメータを変えても総数は保存される（構造的不変条件である証明）', () => {
  const variants = [
    { seed: 7, params: { flowerAbsorbInterval: 0.1, flowerCapacity: 40 } },
    { seed: 8, params: { fishCount: 12, fishCapacity: 20, fishSpeed: 5 } },
    { seed: 9, params: { totalLight: 137, flowerInitial: 20 } },
    { seed: 10, params: { flowerDeathSec: 3, flowerMin: 1, flowerMax: 30 } },
  ];
  for (const v of variants) {
    const r = run(5400, v); // 3分
    assert.equal(
      r.violation,
      null,
      `params=${JSON.stringify(v.params)} で総数が壊れた: ${JSON.stringify(r.violation)}`
    );
    assert.equal(r.eco.totalLight, v.params.totalLight ?? 300);
  }
});

// =====================================================================
// ② 絶滅も飽和もしない
// =====================================================================

test('② 10分間、花の数が下限8〜上限24 の範囲内に留まる', () => {
  const r = run(TEN_MIN, { seed: 1 });
  assert.ok(
    r.minFlowers >= DEFAULT_PARAMS.flowerMin,
    `花が下限を割った: min=${r.minFlowers} < ${DEFAULT_PARAMS.flowerMin}`
  );
  assert.ok(
    r.maxFlowers <= DEFAULT_PARAMS.flowerMax,
    `花が上限を超えた: max=${r.maxFlowers} > ${DEFAULT_PARAMS.flowerMax}`
  );
});

test('② 10分後も循環が続いている（最後の1分でも受け渡しが起きる）', () => {
  const r = run(TEN_MIN, { seed: 1 });
  assert.ok(
    r.pickupsInLastMinute > 0,
    `最後の1分で魚の受け取りが 0 回。循環が止まっている`
  );
});

test('② 別の seed でも成立する', () => {
  for (const seed of [2, 3, 4]) {
    const r = run(TEN_MIN, { seed });
    assert.equal(r.violation, null, `seed=${seed} で総数が壊れた`);
    assert.ok(r.minFlowers >= DEFAULT_PARAMS.flowerMin, `seed=${seed} 花が下限割れ min=${r.minFlowers}`);
    assert.ok(r.maxFlowers <= DEFAULT_PARAMS.flowerMax, `seed=${seed} 花が上限超え max=${r.maxFlowers}`);
    assert.ok(r.pickupsInLastMinute > 0, `seed=${seed} 最後の1分で循環が止まっている`);
  }
});

// =====================================================================
// ⑤ 均衡に落ちていない（30秒前と構図が違う）
// =====================================================================

test('⑤ 30秒離れた全ペアで構図が変化している', () => {
  const r = run(TEN_MIN, { seed: 1 });
  const ds = lagDistances(r.snapshots);
  assert.ok(ds.length > 100, `比較ペアが少なすぎる: ${ds.length}`);

  const worst = ds.reduce((a, b) => (b.d < a.d ? b : a));
  const mean = ds.reduce((s, x) => s + x.d, 0) / ds.length;

  assert.ok(
    worst.d > L1_THRESHOLD,
    `t=${worst.t.toFixed(0)}s で構図がほぼ同じ（L1=${worst.d.toFixed(3)} <= ${L1_THRESHOLD}）。平均=${mean.toFixed(3)}`
  );
});

// =====================================================================
// canary — 検証が空振りしていないことの確認
// =====================================================================

test('canary1: 花の消滅ガードを外すと ① が破れる', () => {
  // 花が下限まで減る領域を使う。
  // その領域では「下限に阻まれて消滅できなかった花」が、その後に光を受け取り、
  // 蓄えを持ったまま寿命に達する。ガードが実際に仕事をするのはこの状態。
  // （既定パラメータでは花が上限に張り付くのでこの状態が起きない = ガードは休眠している）
  const params = { flowerDeathSec: 8, seedCount: 20 };
  const broken = run(36000, { seed: 1, params: { ...params, enforceFlowerChargeGuard: false } });

  assert.notEqual(
    broken.violation,
    null,
    'ガードを外しても総数が保存されたままだった。①の検査が空振りしている可能性がある'
  );
  assert.ok(
    broken.eco.totalLight < 300,
    `光が消えていない: totalLight=${broken.eco.totalLight}`
  );
  assert.ok(
    broken.eco.stats.guardBlocks > 0,
    'ガード該当が 0 回。この設定ではガードの有無が結果に影響しない'
  );

  // 同じ設定でガードを戻すと保存される（差分がガードに由来することの証明）
  const guarded = run(36000, { seed: 1, params: { ...params, enforceFlowerChargeGuard: true } });
  assert.equal(guarded.violation, null, 'ガードを戻しても総数が壊れた。原因がガード以外にある');
  assert.equal(guarded.eco.totalLight, 300);
});

// 光と水流だけの系（魚も花も無い）。⑤の検出器そのものを試すための最小構成。
const LIGHT_AND_CURRENT_ONLY = { fishCount: 0, flowerInitial: 0, seedCount: 99999 };

test('canary2: 大域リズムを止めると ⑤ が破れる（検出器が本当に均衡を見つける）', () => {
  // 完全な系では魚の運搬が構図を動かし続けるため、水流を止めても⑤は緑のままになる。
  // これは「検査が弱い」のではなく「別の層が肩代わりしている」。
  // そこで肩代わりする層を外し、水流だけが変化の源である系で検出器を試す。
  const fixed = run(TEN_MIN, {
    seed: 1,
    params: { ...LIGHT_AND_CURRENT_ONLY, currentPeriodSec: Infinity },
  });
  const fixedDs = lagDistances(fixed.snapshots);
  const fixedWorst = fixedDs.reduce((a, b) => (b.d < a.d ? b : a));

  assert.ok(
    fixedWorst.d <= L1_THRESHOLD,
    `水流を止めても構図が変化し続けた（最小 L1=${fixedWorst.d.toFixed(3)} > ${L1_THRESHOLD}）。` +
      `均衡検知が機能していない。閾値ではなく検知の作り方を見直すこと`
  );

  // 同じ系で回転を戻すと⑤が通る（検出器が何でも赤くするわけではないことの証明）
  const rotating = run(TEN_MIN, { seed: 1, params: LIGHT_AND_CURRENT_ONLY });
  const rotWorst = lagDistances(rotating.snapshots).reduce((a, b) => (b.d < a.d ? b : a));
  assert.ok(
    rotWorst.d > L1_THRESHOLD,
    `回転を戻しても⑤が赤いまま（最小 L1=${rotWorst.d.toFixed(3)}）。検出器が常に赤い可能性がある`
  );
});

test('canary3: 完全な系でも、大域リズムが構図変化に効いている', () => {
  // 魚の運搬という別の層があっても、大域リズムの寄与が測れることを示す。
  const rotating = run(TEN_MIN, { seed: 1 });
  const fixed = run(TEN_MIN, { seed: 1, params: { currentPeriodSec: Infinity } });
  const mean = (ds) => ds.reduce((s, x) => s + x.d, 0) / ds.length;
  const mr = mean(lagDistances(rotating.snapshots));
  const mf = mean(lagDistances(fixed.snapshots));

  assert.ok(
    mr > mf * 1.5,
    `回転ありの平均 L1=${mr.toFixed(3)} が、回転なし=${mf.toFixed(3)} に対して十分大きくない`
  );
});

test('canary4: 魚を止めると循環が止まり ② が破れる', () => {
  // ②（最後の1分でも受け渡しが起きる）が空振りしていないことの確認。
  const r = run(TEN_MIN, { seed: 1, params: { fishCount: 0 } });
  assert.equal(r.pickupsInLastMinute, 0, '魚が居ないのに受け取りが起きている');
  assert.equal(r.eco.totalLight, 300, '魚が居なくても総数は保存されなければならない');
});

// =====================================================================
// 決定論（同じ seed なら同じ軌跡）
// =====================================================================

test('同じ seed なら完全に同じ結果になる', () => {
  const a = run(3000, { seed: 42 });
  const b = run(3000, { seed: 42 });
  assert.deepEqual(Array.from(a.snapshots.at(-1).g), Array.from(b.snapshots.at(-1).g));
  assert.deepEqual(a.eco.stats, b.eco.stats);
});
