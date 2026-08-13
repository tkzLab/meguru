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
};
window.__meguru = { eco, view, renderer: view.renderer, stats, STEP };

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

// --- 30fps ロック ---
let acc = 0;
let last = performance.now();
let fpsWindowStart = last;
let fpsWindowFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);

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

  fpsWindowFrames++;
  if (now - fpsWindowStart >= 1000) {
    stats.fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
    fpsWindowStart = now;
    fpsWindowFrames = 0;
  }
}
requestAnimationFrame(frame);
