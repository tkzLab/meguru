/**
 * meguru — 循環ロジック
 *
 * 【絶対条件】
 * - WebGL / DOM / three.js に一切依存しない
 * - Date.now() / performance.now() を使わない（決定論性のため）
 * - 固定タイムステップ。同じ seed なら完全に同じ軌跡
 * - 光の粒は生成も消滅もしない。総数は常に params.totalLight
 *
 * 光は「漂う / 花の中 / 魚の中」のいずれか1状態にのみ存在する。
 * 総数 = driftCount + Σ flower.charge + Σ fish.cargo
 *
 * これは構造的な不変条件であり、パラメータをどう変えても成立しなければならない。
 */

/** seed 付き乱数（mulberry32）。同じ seed なら同じ列を返す。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 既定パラメータ。design.md §9.4 に対応する。
 * 呼び出し時に展開する（定義時に束縛しない）。
 */
export const DEFAULT_PARAMS = {
  // 光
  totalLight: 300,

  // 世界（y が上、床 y=0）
  worldX: 40,
  worldY: 24,
  worldZ: 30,

  // 水流（大域リズム）
  currentSpeed: 0.35,
  currentPeriodSec: 90, // Infinity にすると回転が止まる（canary2 用）
  currentCoupling: 1.2, // 漂う光が水流に追従する速さ
  driftJitter: 0.02, // ごく弱い局所ゆらぎ。大きくすると均衡検知が効かなくなる

  // 浮力：y=buoyancyNeutralY で 0 になり、それより上では沈む（対流セル）
  //
  // 中立点は「花の樹冠の高さ」に置く。これで design.md §4 の2つの記述が両立する：
  //   - 床付近の光はゆっくり浮上して樹冠に集まる（漂う光は浮上）
  //   - 魚が巡航高度で落とした光は樹冠まで降ってくる（魚の落とした光は沈む）
  // 中立点を水柱の中ほど（y=12）に置くと、光が花の吸収半径の外に溜まり循環が止まる。
  buoyancy: 0.15,
  // 釣り合う高さの散らばり（0 だと全部が同じ高さの面に集まる）
  buoyancySpread: 7.0,
  buoyancyNeutralY: 2.4,
  buoyancyCoupling: 1.5,

  // 花
  flowerInitial: 10,
  // 花は「数で埋める」のではなく「一輪が巨大な生命体」として在る。
  // 数を減らすと、有限な 300 個の光が一輪により多く集まり、
  // 「内部に光を抱えている」が新しい光を作らずに成立する（design.md §8.4）。
  flowerMin: 5,
  flowerMax: 13,
  flowerY: 2, // 海底の巨大な花。樹冠の高さに光の層が来るようにする
  // 吸収は「器の口のあたり」で起きる。**花の見た目を大きくしたら必ずここも見直す。**
  // 器を 1.62 倍にしたとき、ここだけ元のままだったので、
  // 描かれている器の口（y≈5）より内側の小さな球でしか吸収せず、
  // 鉛直に広がった光が一切届かなくなった（循環が止まり②が赤になった）
  flowerAbsorbRadius: 3.8,
  flowerMouthY: 2.6,   // 花の根元から器の口までの高さ
  flowerAbsorbInterval: 0.55,
  flowerCapacity: 14,
  flowerDeathSec: 45,
  flowerEmptyRecoverRate: 2, // charge>0 のとき空腹タイマーが戻る速さ（dt の何倍か）
  enforceFlowerChargeGuard: true, // false にすると光が消える（canary1 用）

  // 魚
  fishCount: 5,
  fishSpeed: 2.4,
  fishTurnRate: 2.2,
  fishPickupRadius: 1.2,
  fishPickupInterval: 0.1,
  fishCapacity: 8,
  fishCarryDistance: 12,
  fishReleaseInterval: 0.3,
  fishReleaseY: 7, // 巡航高度で落とす。光は樹冠まで降ってくる（鉛直の軸が見える）
  fishCruiseY: 8,

  // 新しい花の発生
  seedLowY: 4,
  seedRadius: 3,
  seedCount: 10,
  seedSustainSec: 4,
  seedSampleInterval: 0.25,
  seedMinSpacing: 4,
};

const SEEK = 0;
const COLLECT = 1;
const CARRY = 2;
const RELEASE = 3;

export class Ecosystem {
  /**
   * @param {{seed?: number, params?: object}} [options]
   */
  constructor(options) {
    const opts = options || {};
    // 既定値は「呼び出し時」に展開する。定義時に束縛しない。
    this.params = Object.assign({}, DEFAULT_PARAMS, opts.params || {});
    const p = this.params;

    this.rng = mulberry32(opts.seed === undefined ? 1 : opts.seed);
    this.time = 0;

    // --- 漂う光（固定容量。実行中に確保しない = GC を走らせない） ---
    const N = p.totalLight;
    this._pos = new Float32Array(N * 3);
    this._vel = new Float32Array(N * 3);
    this._driftCount = 0;

    // 釣り合う高さの個体差。**スロット番号から決める**（乱数を引かない）ので、
    // 同じ seed なら同じ層構造になり、swap-remove で並びが変わっても
    // 「その位置の光」の性質は変わらない。
    this._neutralOffset = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const h = (Math.abs(Math.sin(i * 12.9898 + 4.1)) * 43758.5453) % 1;
      this._neutralOffset[i] = h * p.buoyancySpread;
    }

    // --- 花（固定容量。swap-remove で出し入れする） ---
    this._flowers = [];
    for (let i = 0; i < p.flowerMax; i++) {
      this._flowers.push({ x: 0, y: p.flowerY, z: 0, charge: 0, absorbT: 0, emptyT: 0, age: 0 });
    }
    this._flowerCount = 0;

    // --- 魚（増減しない） ---
    this._fishes = [];
    for (let i = 0; i < p.fishCount; i++) {
      this._fishes.push({
        x: 0, y: p.fishCruiseY, z: 0,
        vx: 0, vy: 0, vz: 0,
        cargo: 0,
        state: SEEK,
        timer: 0,
        targetIndex: -1,
        tx: 0, ty: p.fishCruiseY, tz: 0,
        px: 0, py: 0, pz: 0, // 受け取った地点
      });
    }

    // 発生候補セルの継続カウント
    this._seedCells = new Map();
    this._seedSampleT = 0;

    this.current = { x: 0, y: 0, z: 0 };

    // 観測用（検証で使う）
    this.stats = { absorbs: 0, pickups: 0, releases: 0, births: 0, deaths: 0, guardBlocks: 0, floorBlocks: 0 };

    this._init();
  }

  _init() {
    const p = this.params;
    const r = this.rng;
    const hx = p.worldX / 2;
    const hz = p.worldZ / 2;

    // 花を床にばらまく。
    // **上限で頭打ちにする。** 器の配列は flowerMax 個しか無いので、
    // flowerInitial のほうが大きいと配列の外に書き込んで静かに壊れる
    // （flowerMax を 24 → 13 に下げたときに、パラメータ掃引のテストが検出した）。
    const initial = Math.min(p.flowerInitial, p.flowerMax);
    for (let i = 0; i < initial; i++) {
      const f = this._flowers[this._flowerCount++];
      f.x = (r() * 2 - 1) * hx * 0.85;
      f.z = (r() * 2 - 1) * hz * 0.85;
      f.y = p.flowerY;
      f.charge = 0;
      f.absorbT = r() * p.flowerAbsorbInterval;
      f.emptyT = 0;
      f.age = 0;
    }

    // 光を空間にばらまく（全部「漂う」状態から始める）
    for (let i = 0; i < p.totalLight; i++) {
      this._spawnDrift(
        (r() * 2 - 1) * hx * 0.9,
        r() * p.worldY * 0.6 + 0.5,
        (r() * 2 - 1) * hz * 0.9
      );
    }

    // 魚を配置
    for (let i = 0; i < this._fishes.length; i++) {
      const fi = this._fishes[i];
      fi.x = (r() * 2 - 1) * hx * 0.6;
      fi.y = p.fishCruiseY + (r() * 2 - 1) * 2;
      fi.z = (r() * 2 - 1) * hz * 0.6;
      fi.state = SEEK;
      fi.timer = 0;
    }
  }

  /** 漂う光を1つ追加する。呼び出し側が総数を保つ責任を持つ。 */
  _spawnDrift(x, y, z) {
    const i = this._driftCount++;
    const o = i * 3;
    this._pos[o] = x;
    this._pos[o + 1] = y;
    this._pos[o + 2] = z;
    this._vel[o] = 0;
    this._vel[o + 1] = 0;
    this._vel[o + 2] = 0;
  }

  /** 漂う光を1つ取り除く（末尾と入れ替え）。確保も解放もしない。 */
  _removeDrift(i) {
    const last = --this._driftCount;
    if (i !== last) {
      const a = i * 3;
      const b = last * 3;
      this._pos[a] = this._pos[b];
      this._pos[a + 1] = this._pos[b + 1];
      this._pos[a + 2] = this._pos[b + 2];
      this._vel[a] = this._vel[b];
      this._vel[a + 1] = this._vel[b + 1];
      this._vel[a + 2] = this._vel[b + 2];
    }
  }

  /** 1フレーム進める。dt は固定（既定 1/30 秒）。 */
  step(dt) {
    this.time += dt;
    this._updateCurrent();
    this._updateDrift(dt);
    this._updateFlowers(dt);
    this._updateFish(dt);
    this._updateSeeding(dt);
    this._updateFlowerDeath(dt);
  }

  _updateCurrent() {
    const p = this.params;
    // 周期が有限のときだけ回る。Infinity なら向きが固定される（canary2）。
    const angle = Number.isFinite(p.currentPeriodSec) && p.currentPeriodSec > 0
      ? (this.time / p.currentPeriodSec) * Math.PI * 2
      : 0;
    this.current.x = Math.cos(angle) * p.currentSpeed;
    this.current.y = 0;
    this.current.z = Math.sin(angle) * p.currentSpeed;
  }

  _updateDrift(dt) {
    const p = this.params;
    const pos = this._pos;
    const vel = this._vel;
    const hx = p.worldX / 2;
    const hz = p.worldZ / 2;
    const cx = this.current.x;
    const cz = this.current.z;
    const k = Math.min(1, p.currentCoupling * dt);
    const bk = Math.min(1, p.buoyancyCoupling * dt);
    const jitter = p.driftJitter;

    for (let i = 0; i < this._driftCount; i++) {
      const o = i * 3;

      // 水平：水流へ緩やかに追従
      vel[o] += (cx - vel[o]) * k;
      vel[o + 2] += (cz - vel[o + 2]) * k;

      // 鉛直：釣り合う高さで対流が止まる。上に行き過ぎた光は沈んで戻る。
      //
      // **釣り合う高さを 1 つにしてはいけない。** 単一の安定平衡なので、
      // 時間が経つと全部がその高さの面に集まる。実測では漂う光の半分以上が
      // y=2.40 ちょうどに張り付き、画面では横一列の帯になった（§4 が避けたかった
      // 「均衡に落ちる」が、水平ではなく鉛直で起きていた）。
      // 粒ごとに釣り合う高さを散らすと、同じ仕組みのまま厚みのある層になる。
      const neutral = p.buoyancyNeutralY + this._neutralOffset[i];
      const term = p.buoyancy * (1 - pos[o + 1] / neutral);
      vel[o + 1] += (term - vel[o + 1]) * bk;

      if (jitter > 0) {
        vel[o] += (this.rng() * 2 - 1) * jitter * dt;
        vel[o + 1] += (this.rng() * 2 - 1) * jitter * dt;
        vel[o + 2] += (this.rng() * 2 - 1) * jitter * dt;
      }

      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;

      // 壁で反射（外に出さない）
      if (pos[o] > hx) { pos[o] = hx; vel[o] = -Math.abs(vel[o]); }
      else if (pos[o] < -hx) { pos[o] = -hx; vel[o] = Math.abs(vel[o]); }
      if (pos[o + 2] > hz) { pos[o + 2] = hz; vel[o + 2] = -Math.abs(vel[o + 2]); }
      else if (pos[o + 2] < -hz) { pos[o + 2] = -hz; vel[o + 2] = Math.abs(vel[o + 2]); }
      if (pos[o + 1] > p.worldY) { pos[o + 1] = p.worldY; vel[o + 1] = -Math.abs(vel[o + 1]); }
      else if (pos[o + 1] < 0.1) { pos[o + 1] = 0.1; vel[o + 1] = Math.abs(vel[o + 1]); }
    }
  }

  _updateFlowers(dt) {
    const p = this.params;
    const pos = this._pos;
    const r2 = p.flowerAbsorbRadius * p.flowerAbsorbRadius;

    for (let fi = 0; fi < this._flowerCount; fi++) {
      const f = this._flowers[fi];
      f.age += dt;
      f.absorbT += dt;
      if (f.absorbT < p.flowerAbsorbInterval) continue;
      f.absorbT -= p.flowerAbsorbInterval;
      if (f.charge >= p.flowerCapacity) continue;

      // 半径内の漂う光を1つだけ吸収する（最も近いもの）
      let best = -1;
      let bestD = r2;
      for (let i = 0; i < this._driftCount; i++) {
        const o = i * 3;
        const dx = pos[o] - f.x;
        const dy = pos[o + 1] - (f.y + p.flowerMouthY);
        const dz = pos[o + 2] - f.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        this._removeDrift(best); // 漂う光が1つ減り
        f.charge++;              // 花の蓄えが1つ増える（総数は不変）
        this.stats.absorbs++;
      }
    }
  }

  _updateFish(dt) {
    const p = this.params;
    const hx = p.worldX / 2;
    const hz = p.worldZ / 2;

    for (let i = 0; i < this._fishes.length; i++) {
      const fi = this._fishes[i];
      fi.timer += dt;

      switch (fi.state) {
        case SEEK: {
          // 最も光を蓄えた花を目指す
          let best = -1;
          let bestCharge = 0;
          for (let j = 0; j < this._flowerCount; j++) {
            if (this._flowers[j].charge > bestCharge) {
              bestCharge = this._flowers[j].charge;
              best = j;
            }
          }
          fi.targetIndex = best;
          if (best >= 0) {
            const f = this._flowers[best];
            fi.tx = f.x; fi.ty = f.y + 0.4; fi.tz = f.z;
            const dx = fi.x - f.x, dy = fi.y - f.y, dz = fi.z - f.z;
            if (dx * dx + dy * dy + dz * dz < p.fishPickupRadius * p.fishPickupRadius) {
              fi.state = COLLECT;
              fi.timer = 0;
            }
          } else {
            // 蓄えのある花が無いときは巡航する
            fi.ty = p.fishCruiseY;
            if (fi.timer > 3) {
              fi.timer = 0;
              fi.tx = (this.rng() * 2 - 1) * hx * 0.8;
              fi.tz = (this.rng() * 2 - 1) * hz * 0.8;
            }
          }
          break;
        }

        case COLLECT: {
          const f = this._flowers[fi.targetIndex];
          if (!f || fi.targetIndex >= this._flowerCount) { fi.state = SEEK; break; }
          if (fi.timer >= p.fishPickupInterval) {
            fi.timer -= p.fishPickupInterval;
            if (f.charge > 0 && fi.cargo < p.fishCapacity) {
              f.charge--;      // 花の蓄えが1つ減り
              fi.cargo++;      // 魚の積載が1つ増える（総数は不変）
              this.stats.pickups++;
            }
          }
          if (fi.cargo >= p.fishCapacity || f.charge === 0) {
            if (fi.cargo > 0) {
              fi.px = fi.x; fi.py = fi.y; fi.pz = fi.z;
              // 受け取った場所から離れる方向を選ぶ
              const a = this.rng() * Math.PI * 2;
              fi.tx = Math.max(-hx * 0.9, Math.min(hx * 0.9, fi.x + Math.cos(a) * p.fishCarryDistance * 1.5));
              fi.tz = Math.max(-hz * 0.9, Math.min(hz * 0.9, fi.z + Math.sin(a) * p.fishCarryDistance * 1.5));
              fi.ty = p.fishCruiseY;
              fi.state = CARRY;
            } else {
              fi.state = SEEK;
            }
            fi.timer = 0;
          }
          break;
        }

        case CARRY: {
          const dx = fi.x - fi.px, dz = fi.z - fi.pz;
          if (Math.sqrt(dx * dx + dz * dz) >= p.fishCarryDistance) {
            fi.state = RELEASE;
            fi.timer = 0;
            fi.ty = p.fishReleaseY;
            break;
          }
          // 目標に着いたのにまだ十分離れていない（壁際でクランプされた等）なら
          // 別の方向を選び直す。これをしないと魚が積載を抱えたまま固まる。
          const tdx = fi.tx - fi.x, tdz = fi.tz - fi.z;
          if (tdx * tdx + tdz * tdz < 2.25) {
            const a = this.rng() * Math.PI * 2;
            fi.tx = Math.max(-hx * 0.9, Math.min(hx * 0.9, fi.x + Math.cos(a) * p.fishCarryDistance * 1.5));
            fi.tz = Math.max(-hz * 0.9, Math.min(hz * 0.9, fi.z + Math.sin(a) * p.fishCarryDistance * 1.5));
          }
          break;
        }

        case RELEASE: {
          fi.ty = p.fishReleaseY;
          if (fi.timer >= p.fishReleaseInterval) {
            fi.timer -= p.fishReleaseInterval;
            if (fi.cargo > 0) {
              fi.cargo--;                            // 魚の積載が1つ減り
              this._spawnDrift(fi.x, fi.y, fi.z);    // 漂う光が1つ増える（総数は不変）
              this.stats.releases++;
            }
          }
          if (fi.cargo === 0) { fi.state = SEEK; fi.timer = 0; }
          break;
        }
      }

      // 目標へ向かって進む（水流の影響を弱く受ける）
      let dx = fi.tx - fi.x;
      let dy = fi.ty - fi.y;
      let dz = fi.tz - fi.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const sx = (dx / d) * p.fishSpeed + this.current.x * 0.3;
      const sy = (dy / d) * p.fishSpeed;
      const sz = (dz / d) * p.fishSpeed + this.current.z * 0.3;
      const t = Math.min(1, p.fishTurnRate * dt);
      fi.vx += (sx - fi.vx) * t;
      fi.vy += (sy - fi.vy) * t;
      fi.vz += (sz - fi.vz) * t;
      fi.x += fi.vx * dt;
      fi.y += fi.vy * dt;
      fi.z += fi.vz * dt;

      if (fi.x > hx) { fi.x = hx; fi.vx = -Math.abs(fi.vx); }
      else if (fi.x < -hx) { fi.x = -hx; fi.vx = Math.abs(fi.vx); }
      if (fi.z > hz) { fi.z = hz; fi.vz = -Math.abs(fi.vz); }
      else if (fi.z < -hz) { fi.z = -hz; fi.vz = Math.abs(fi.vz); }
      if (fi.y > p.worldY - 1) { fi.y = p.worldY - 1; fi.vy = -Math.abs(fi.vy); }
      else if (fi.y < 1) { fi.y = 1; fi.vy = Math.abs(fi.vy); }
    }
  }

  /** 床付近に光が集まった場所へ新しい花を生やす。光は消費しない。 */
  _updateSeeding(dt) {
    const p = this.params;
    this._seedSampleT += dt;
    if (this._seedSampleT < p.seedSampleInterval) return;
    this._seedSampleT -= p.seedSampleInterval;

    const pos = this._pos;
    const cell = p.seedRadius;

    // 床付近の光をハッシュ格子に入れる（走査を局所化するため）
    const buckets = new Map();
    for (let i = 0; i < this._driftCount; i++) {
      const o = i * 3;
      if (pos[o + 1] >= p.seedLowY) continue;
      const cxi = Math.floor(pos[o] / cell);
      const czi = Math.floor(pos[o + 2] / cell);
      const key = cxi + ',' + czi;
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push(i);
    }

    const seen = new Set();
    const r2 = p.seedRadius * p.seedRadius;

    for (const key of buckets.keys()) {
      const [cxi, czi] = key.split(',').map(Number);
      const centerX = (cxi + 0.5) * cell;
      const centerZ = (czi + 0.5) * cell;

      // 中心から半径 seedRadius 以内の光を数える（隣接セルまで見る）
      let count = 0;
      for (let ax = cxi - 1; ax <= cxi + 1; ax++) {
        for (let az = czi - 1; az <= czi + 1; az++) {
          const b = buckets.get(ax + ',' + az);
          if (!b) continue;
          for (let n = 0; n < b.length; n++) {
            const o = b[n] * 3;
            const dx = pos[o] - centerX;
            const dz = pos[o + 2] - centerZ;
            if (dx * dx + dz * dz <= r2) count++;
          }
        }
      }

      if (count >= p.seedCount) {
        seen.add(key);
        const prev = this._seedCells.get(key) || 0;
        const next = prev + p.seedSampleInterval;
        if (next >= p.seedSustainSec) {
          this._trySeedFlower(centerX, centerZ);
          this._seedCells.set(key, 0);
        } else {
          this._seedCells.set(key, next);
        }
      }
    }

    // 条件を満たさなくなったセルは継続をリセットする
    for (const key of Array.from(this._seedCells.keys())) {
      if (!seen.has(key)) this._seedCells.delete(key);
    }
  }

  _trySeedFlower(x, z) {
    const p = this.params;
    if (this._flowerCount >= p.flowerMax) return;
    const hx = p.worldX / 2;
    const hz = p.worldZ / 2;
    if (x < -hx || x > hx || z < -hz || z > hz) return;

    // 近すぎる場所には生やさない
    for (let i = 0; i < this._flowerCount; i++) {
      const f = this._flowers[i];
      const dx = f.x - x, dz = f.z - z;
      if (dx * dx + dz * dz < p.seedMinSpacing * p.seedMinSpacing) return;
    }

    const f = this._flowers[this._flowerCount++];
    f.x = x; f.y = p.flowerY; f.z = z;
    f.charge = 0;
    f.absorbT = this.rng() * p.flowerAbsorbInterval;
    f.emptyT = 0;
    f.age = 0;
    this.stats.births++;
  }

  _updateFlowerDeath(dt) {
    const p = this.params;
    for (let i = this._flowerCount - 1; i >= 0; i--) {
      const f = this._flowers[i];
      if (f.charge === 0) {
        f.emptyT += dt;
      } else {
        // 光が流れ込むと空腹タイマーは「戻る」（即リセットではない）
        f.emptyT = Math.max(0, f.emptyT - dt * p.flowerEmptyRecoverRate);
      }
      if (f.emptyT < p.flowerDeathSec) continue;
      if (this._flowerCount <= p.flowerMin) { this.stats.floorBlocks++; continue; }

      // 光の総数保存のための絶対規則：蓄えを持つ花は消滅させない。
      // このガードを外すと f.charge 個の光が消える（canary1）。
      if (f.charge > 0) {
        this.stats.guardBlocks++;
        if (p.enforceFlowerChargeGuard) continue;
      }

      this._removeFlower(i);
      this.stats.deaths++;
    }
  }

  _removeFlower(i) {
    const last = --this._flowerCount;
    if (i !== last) {
      // オブジェクトごと入れ替える（確保しない）
      const tmp = this._flowers[i];
      this._flowers[i] = this._flowers[last];
      this._flowers[last] = tmp;
    }
    // 消えた花を目標にしていた魚は探索に戻す
    for (let k = 0; k < this._fishes.length; k++) {
      const fi = this._fishes[k];
      if (fi.targetIndex >= this._flowerCount) {
        fi.targetIndex = -1;
        if (fi.state === COLLECT) fi.state = fi.cargo > 0 ? CARRY : SEEK;
      }
    }
  }

  // ---------- 描画側・検証側が読む状態 ----------

  /** 漂う光の座標（Float32Array, 先頭 driftCount*3 個が有効） */
  get driftPositions() { return this._pos; }
  get driftCount() { return this._driftCount; }

  /** 活きている花だけを返す（配列は使い回さないので読み取り専用に扱うこと） */
  get flowers() { return this._flowers.slice(0, this._flowerCount); }
  get flowerCount() { return this._flowerCount; }

  get fishes() { return this._fishes; }

  /** 現在の水流ベクトル */
  get currentVector() { return this.current; }

  /** 光の総数。常に params.totalLight でなければならない。 */
  get totalLight() {
    let n = this._driftCount;
    for (let i = 0; i < this._flowerCount; i++) n += this._flowers[i].charge;
    for (let i = 0; i < this._fishes.length; i++) n += this._fishes[i].cargo;
    return n;
  }
}

export default Ecosystem;
