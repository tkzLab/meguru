/**
 * meguru — 診断表示（design.md §8）
 *
 * **これは iPad 側の唯一の計測手段。**
 * ヘッドレスから iOS Safari を自動操作する手段が無いので、③（1時間後も30fps）と
 * ⑥（バックグラウンド復帰）は「1時間置いた後にこれを開いてスクショを1枚撮る」で判定する。
 * したがって**写真に撮って読めること**が最優先の要件になる。
 *
 * 開き方: 画面左上 15% の領域を 2 秒以内に 3 回タップ。もう一度同じ操作で閉じる。
 * 誤爆しにくく、§3 の「気配」タッチ（水流）とも衝突しない。
 */

const TAP_REGION = 0.15;   // 画面の左上 15%
const TAP_COUNT = 3;
const TAP_WINDOW_MS = 2000;
const MAX_BUCKETS = 60;    // 1 秒 × 60 個。窓の最大長
const UPDATE_MS = 500;     // 2Hz。毎フレーム DOM を書くとレイアウトが走って本末転倒

export class Diagnostics {
  /**
   * @param {object} deps { eco, view, stats }
   */
  constructor({ eco, view, stats }) {
    this.eco = eco;
    this.view = view;
    this.stats = stats;

    this.open = false;
    this.el = null;          // 初回に開くまで DOM を作らない
    this._lastPaint = 0;

    /**
     * 直近 N 秒の最悪フレーム時間。
     *
     * `stats.worstFrameMs` は起動からの最大値なので §8 の「直近 60 秒」を満たさない。
     * 1 秒ごとのバケツをリングで持ち、その最大を取る。
     * 起動時に1本確保するだけで、以後は確保しない（完成の定義④）。
     */
    this._buckets = new Float32Array(MAX_BUCKETS);
    this._lastSec = -1;
    this.windowSec = 60;     // テストから短くできる（check-diagnostics.mjs が 2 秒にする）

    this._taps = [];         // 直近のタップ時刻。長さ 3 で使い回す

    document.addEventListener('pointerdown', (e) => this._onTap(e), { passive: true });
  }

  // ---------------------------------------------------------------
  // 計測。**開いていなくても常に記録する。**
  // 開いた瞬間から記録を始めると、1時間放置した後に開いても窓が空で、
  // この道具の目的（放置後の状態を読む）がそのまま消える。
  // ---------------------------------------------------------------
  record(frameMs, nowMs) {
    const sec = Math.floor(nowMs / 1000);
    if (sec !== this._lastSec) {
      if (this._lastSec < 0 || sec - this._lastSec >= MAX_BUCKETS) {
        // 初回、または長く止まっていた（バックグラウンド等）。全部捨てる
        this._buckets.fill(0);
      } else {
        // 進んだぶんのバケツだけ空にする。飛ばした秒に古い値が残らないように
        for (let s = this._lastSec + 1; s <= sec; s++) {
          this._buckets[((s % MAX_BUCKETS) + MAX_BUCKETS) % MAX_BUCKETS] = 0;
        }
      }
      this._lastSec = sec;
    }
    const i = ((sec % MAX_BUCKETS) + MAX_BUCKETS) % MAX_BUCKETS;
    if (frameMs > this._buckets[i]) this._buckets[i] = frameMs;
  }

  /** 直近 windowSec 秒の最悪フレーム時間 */
  worstInWindow() {
    const n = Math.max(1, Math.min(MAX_BUCKETS, Math.floor(this.windowSec)));
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const s = this._lastSec - k;
      const i = ((s % MAX_BUCKETS) + MAX_BUCKETS) % MAX_BUCKETS;
      if (this._buckets[i] > worst) worst = this._buckets[i];
    }
    return worst;
  }

  // ---------------------------------------------------------------
  // 開閉
  // ---------------------------------------------------------------
  _onTap(e) {
    const w = window.innerWidth, h = window.innerHeight;
    const inRegion = e.clientX <= w * TAP_REGION && e.clientY <= h * TAP_REGION;
    if (!inRegion) {
      this._taps.length = 0;   // 領域の外を触ったら数え直し
      return;
    }
    const t = performance.now();
    this._taps.push(t);
    if (this._taps.length > TAP_COUNT) this._taps.shift();
    if (this._taps.length === TAP_COUNT && t - this._taps[0] <= TAP_WINDOW_MS) {
      this._taps.length = 0;
      this.toggle();
    }
  }

  toggle() { this.open ? this.hide() : this.show(); }

  show() {
    if (!this.el) this._build();
    this._taps.length = 0;    // 開閉した時点でタップの数え直し
    this.open = true;
    this.el.style.display = 'block';
    this._lastPaint = 0;      // すぐ描き直す
    this.update(true);
  }

  hide() {
    this._taps.length = 0;
    this.open = false;
    if (this.el) this.el.style.display = 'none';
  }

  _build() {
    const el = document.createElement('pre');
    el.id = 'diag';
    // pointer-events: none ＝ 表示中もタッチは下の作品に届く。
    // 開閉判定は document 側で拾っているので、これで困らない。
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'margin:0', 'z-index:10',
      'padding:14px 18px',
      'background:rgba(0,6,14,0.82)',
      'color:#BFE9FF',
      'font:600 16px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre',
      'border-bottom-right-radius:10px',
      'border:1px solid rgba(143,230,255,0.22)',
      'border-top:none', 'border-left:none',
      'pointer-events:none',
      '-webkit-user-select:none', 'user-select:none',
      'text-shadow:0 1px 2px rgba(0,0,0,0.9)',
      'display:none',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;
  }

  // ---------------------------------------------------------------
  // 描画（開いているときだけ。閉じていれば文字列も作らない）
  // ---------------------------------------------------------------
  update(force) {
    if (!this.open) return;
    const now = performance.now();
    if (!force && now - this._lastPaint < UPDATE_MS) return;
    this._lastPaint = now;

    const s = this.stats;
    const eco = this.eco;
    let cargo = 0;
    const fishes = eco.fishes;
    for (let i = 0; i < fishes.length; i++) cargo += fishes[i].cargo;

    const dpr = this.view.renderer.getPixelRatio();
    const cv = this.view.renderer.domElement;
    const wl = s.wakeLock === true ? 'あり'
      : s.wakeLock === 'unsupported' ? '非対応'
        : `なし${s.wakeLockError ? '(' + s.wakeLockError + ')' : ''}`;

    this.el.textContent =
      `めぐる 診断\n` +
      `経過時間      ${fmtElapsed(now - s.startedAt)}\n` +
      `fps           ${s.fps.toFixed(1)}\n` +
      `最悪フレーム  ${this.worstInWindow().toFixed(1)} ms (直近${Math.round(this.windowSec)}秒)\n` +
      `  全期間      ${s.worstFrameMs.toFixed(1)} ms\n` +
      `光の総数      ${eco.totalLight}\n` +
      `花の数        ${eco.flowerCount}\n` +
      `魚の積載合計  ${cargo}\n` +
      `コンテキスト  破棄 ${s.contextLost} 回\n` +
      `復帰          ${s.resumes} 回\n` +
      `Wake Lock     ${wl}\n` +
      `画面          ${window.innerWidth}x${window.innerHeight} @${dpr} (${cv.width}x${cv.height})`;
  }
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}時間${m}分${sec}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

export default Diagnostics;
