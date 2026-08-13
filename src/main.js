/**
 * meguru — 起動と時間管理
 *
 * 30fps に固定する（design.md §6.1）。
 * iPad はファンが無く、GPU を回し続けると発熱でクロックが落ちる。
 * 水中のゆっくりした漂流では 30fps と 60fps は見分けがつかないので、
 * 半分の負荷で回して発熱・電池・持続性能を買う。
 */

import { Ecosystem } from './ecosystem.js';
import { Renderer } from './render.js';
import { Diagnostics } from './diagnostics.js';

const STEP = 1 / 30; // ecosystem は固定タイムステップでしか動かない（決定論性のため）

const canvas = document.getElementById('stage');
const eco = new Ecosystem({ seed: 20260813 });
const view = new Renderer(canvas, eco);

// 計測用（T4 の診断表示・T5 の Playwright から読む）
const stats = {
  frames: 0,       // 実際に描画したフレーム数
  steps: 0,        // ecosystem を進めた回数
  lastFrameMs: 0,
  worstFrameMs: 0,
  fps: 0,
  startedAt: performance.now(),
  contextLost: 0,      // WebGL コンテキストを失った回数（§6.4）
  wakeLock: null,      // true / false / 'unsupported'
  wakeLockError: '',
  resumes: 0,          // バックグラウンドから戻った回数
};
// 診断表示（§8）。左上 15% を 2 秒以内に 3 回タップで開く
const diag = new Diagnostics({ eco, view, stats });

window.__meguru = { eco, view, renderer: view.renderer, stats, STEP, diag };

// --- リサイズ ---
function fit() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  view.resize();
}
window.addEventListener('resize', fit);
fit();

// --- 鑑賞者の気配（§3）。命令ではないので、ごく弱く受け取るだけ ---
function onMove(clientX, clientY) {
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = (clientY / window.innerHeight) * 2 - 1;
  view.setPointer(nx, ny);
}
window.addEventListener('pointermove', (e) => onMove(e.clientX, e.clientY), { passive: true });
window.addEventListener('touchmove', (e) => {
  if (e.touches.length) onMove(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

// --- 画面の自動ロック対策（§6.4） ---
//
// 置きっぱなしで眺める作品なので、iPad が自動ロックすると作品が消える。
// セキュアコンテキスト（https / 127.0.0.1）でしか使えず、対応していない環境も
// あるので、**取れなくても作品は止めない**。
let wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    stats.wakeLock = 'unsupported';
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    stats.wakeLock = true;
    stats.wakeLockError = '';
    // バックグラウンドに行くと OS 側で解放される。戻ったら取り直す
    wakeLock.addEventListener('release', () => { stats.wakeLock = false; });
  } catch (e) {
    // NotAllowedError（ユーザー操作が無い・非セキュアなど）でここに来る。握って続行する
    stats.wakeLock = false;
    stats.wakeLockError = e && e.name ? e.name : String(e);
  }
}
acquireWakeLock();

// --- バックグラウンドからの復帰（§6.4） ---
function resume() {
  stats.resumes++;
  // 時刻の基準を入れ直す。これをやらないと、戻った瞬間に「留守にしていた時間」が
  // まるごと dt として入る。Math.min(dt, 0.25) で頭打ちにはしてあるが、
  // 端数の acc が残っていると復帰直後だけ余分に進むので明示的に捨てる。
  last = performance.now();
  acc = 0;
  view.forceCompositorRepaint();
  acquireWakeLock();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resume();
});
// iOS の戻る／アプリ切替は visibilitychange が来ないことがあるので pageshow も見る
window.addEventListener('pageshow', () => resume());

// --- 30fps ロック ---
let acc = 0;
let last = performance.now();
let fpsWindowStart = last;
let fpsWindowFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);

  // コンテキストを失っている間は描画も step もしない（§6.4）。
  // rAF は止めない ― 止めると復帰イベントの後に自力で戻れなくなる。
  // 時間も進めないので、復帰後に一気に何秒ぶんも進むことがない。
  if (view.contextLost) {
    stats.contextLost = view.contextLostCount;
    last = now;
    acc = 0;
    return;
  }
  stats.contextLost = view.contextLostCount;

  const dt = (now - last) / 1000;
  last = now;
  acc += Math.min(dt, 0.25);
  if (acc < STEP) return;
  // 端数は残す。ここを acc=0 にすると 60Hz の画面で位相がずれ、
  // 3 フレームに 1 回しか進まなくなる（実測 22fps になった）。
  acc -= STEP;
  // ただし溜め込みは許さない。遅延したぶんはまとめて進めずに捨てる
  if (acc > STEP) acc = STEP;

  const t0 = performance.now();
  eco.step(STEP);
  view.update(STEP);
  view.render();
  const ms = performance.now() - t0;

  stats.steps++;
  stats.frames++;
  stats.lastFrameMs = ms;
  if (ms > stats.worstFrameMs) stats.worstFrameMs = ms;

  // 開いていなくても記録は続ける（1時間放置した後に開いても窓が埋まっているように）
  diag.record(ms, now);
  diag.update(false);

  fpsWindowFrames++;
  if (now - fpsWindowStart >= 1000) {
    stats.fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
    fpsWindowStart = now;
    fpsWindowFrames = 0;
  }
}
requestAnimationFrame(frame);
