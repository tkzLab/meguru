/**
 * 光の粒の減衰カーブが、接写ムードボードの実測プロファイルに合っているかを検証する。
 *
 *   node --test test/
 *
 * 本命は「ローレンツ型が実測に合うこと」。
 * ただし assert が通ることと、その assert が失敗しうることは別なので、
 * **旧実装が同じ assert に落ちること**を canary として明示的に確認する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  glowFalloff, legacyFalloff,
  MEASURED_PROFILE, MEASURED_RADIUS, MEASURED_CORE,
} from '../src/falloff.js';

const TOL = 0.03;

/** プロファイル10点に対する最大誤差 */
function maxError(fn) {
  let worst = 0;
  let at = null;
  for (const [r, expected] of MEASURED_PROFILE) {
    const e = Math.abs(fn(r / MEASURED_RADIUS) - expected);
    if (e > worst) { worst = e; at = r; }
  }
  return { worst, at };
}

test('ローレンツ型が実測プロファイル10点すべてに ±0.03 で一致する', () => {
  for (const [r, expected] of MEASURED_PROFILE) {
    const got = glowFalloff(r / MEASURED_RADIUS, MEASURED_CORE);
    assert.ok(
      Math.abs(got - expected) <= TOL,
      `r=${r}px: 実測 ${expected} に対し ${got.toFixed(4)}（差 ${Math.abs(got - expected).toFixed(4)} > ${TOL}）`
    );
  }
  const { worst, at } = maxError((t) => glowFalloff(t, MEASURED_CORE));
  console.log(`    ローレンツ型の最大誤差 ${worst.toFixed(4)} (r=${at}px)`);
});

test('canary: 旧実装 (1-t)^2 は同じ assert に落ちる', () => {
  // 落ちること自体を確かめる。ここが緑のままなら「本命のテストが弱い」ということ。
  const check = () => {
    for (const [r, expected] of MEASURED_PROFILE) {
      const got = legacyFalloff(r / MEASURED_RADIUS, 2.0);
      assert.ok(Math.abs(got - expected) <= TOL, `r=${r}px で旧式が合わない`);
    }
  };
  assert.throws(check, /旧式が合わない/, '旧実装が実測に合ってしまった。テストが弱い');

  // どれくらい外れているかも数値で残す（実測 0.18 に対し 0.69 を返す点がある）
  const { worst, at } = maxError((t) => legacyFalloff(t, 2.0));
  console.log(`    旧実装の最大誤差 ${worst.toFixed(4)} (r=${at}px)`);
  assert.ok(worst > 0.5, `旧実装の最大誤差が ${worst.toFixed(4)} しかない。canary として弱い`);
});

test('canary: 芯の細さ a を実測から外すと合わなくなる', () => {
  // a=0.080 が効いている値であって、どんな a でも通るわけではないことを示す。
  for (const a of [0.02, 0.20, 0.40]) {
    const { worst } = maxError((t) => glowFalloff(t, a));
    assert.ok(worst > TOL, `a=${a} でも通ってしまった（最大誤差 ${worst.toFixed(4)}）。実測が効いていない`);
  }
});

test('スプライトの縁でちょうど 0 になる（四角い継ぎ目を出さない）', () => {
  assert.equal(glowFalloff(1.0, MEASURED_CORE), 0);
  assert.equal(glowFalloff(1.5, MEASURED_CORE), 0);
  // 縁の手前も十分小さいこと（段差が見えない）
  assert.ok(glowFalloff(0.999, MEASURED_CORE) < 0.001);
});

test('中心で 1、単調減少である', () => {
  assert.equal(glowFalloff(0, MEASURED_CORE), 1);
  let prev = 1;
  for (let t = 0.01; t < 1; t += 0.01) {
    const v = glowFalloff(t, MEASURED_CORE);
    assert.ok(v <= prev + 1e-12, `t=${t.toFixed(2)} で増加した`);
    assert.ok(v >= 0, `t=${t.toFixed(2)} で負になった`);
    prev = v;
  }
});

test('微粒子用の a=0.18 は芯が広い（実測カーブより緩い）', () => {
  // 微粒子は 2px 前後で描くので、実測どおりの鋭い芯だと消えてしまう。
  // 意図的に緩くしてあることを固定しておく（勝手に 0.080 に揃えられないように）。
  const sharp = glowFalloff(0.25, MEASURED_CORE);
  const soft = glowFalloff(0.25, 0.18);
  assert.ok(soft > sharp * 2, `微粒子用が鋭すぎる（sharp ${sharp.toFixed(3)} / soft ${soft.toFixed(3)}）`);
});
