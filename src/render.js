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
  blurSizeGain: 2.2,   // ボケるほど大きく
  blurDimGain: 3.4,    // ボケるほど暗く（面積が増えるぶん暗くしないと明るさが増える）

  // 意味のある光（保存量 300 個）: 基準距離で 7px
  lightSize: 13.0,
  lightWarmBoost: 2.35,  // 大きな粒1つより、小さな粒が密に集まる方がムードボードに近い

  // 環境の微粒子（保存則の外。空気を作るためだけに在る）: 基準距離で 1.8px
  moteCount: 12000,
  moteSize: 2.4,
  moteOpacity: 1.0,

  // 花：小さく・薄く。主役は花そのものではなく、花が抱えている光
  flowerScale: 1.15,
  flowerOpacity: 0.22,
  flowerLightSpread: 1.30,  // 蓄えた光を花の椀の中に散らす半径

  fishScale: 0.85,

  fogDensity: 0.016,
};

/** canvas に放射状の減衰を描いてスプライトにする（外部画像を使わない）。 */
function makeGlowTexture(size, power) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      // 芯が細く、裾が長い減衰。§11.3 の「小さな点が沢山」に寄せる
      const a = d >= 1 ? 0 : Math.pow(1 - d, power);
      const o = (y * size + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * 花弁のテクスチャ。薄い膜＋放射状のかすかな筋。
 * uv(0,0)=根元の左、uv(1,1)=先端の右。根元が細く、6 割の高さで最も広く、先端は尖る。
 */
function makePetalTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;

  // 花弁の輪郭（下＝根元、上＝先端）
  const petal = new Path2D();
  petal.moveTo(cx, size * 0.99);
  petal.bezierCurveTo(cx - size * 0.30, size * 0.72, cx - size * 0.34, size * 0.36, cx, size * 0.03);
  petal.bezierCurveTo(cx + size * 0.34, size * 0.36, cx + size * 0.30, size * 0.72, cx, size * 0.99);
  petal.closePath();

  // 根元が明るく、先端に向かって消える薄い膜
  const g = ctx.createLinearGradient(0, size, 0, 0);
  g.addColorStop(0.00, 'rgba(214,240,255,0.85)');
  g.addColorStop(0.30, 'rgba(186,228,255,0.42)');
  g.addColorStop(0.70, 'rgba(160,214,250,0.16)');
  g.addColorStop(1.00, 'rgba(150,205,245,0.00)');
  ctx.fillStyle = g;
  ctx.fill(petal);

  // 縁だけわずかに明るくして膜らしさを出す
  ctx.save();
  ctx.clip(petal);
  ctx.strokeStyle = 'rgba(220,245,255,0.30)';
  ctx.lineWidth = Math.max(1.5, size / 90);
  ctx.stroke(petal);
  // 根元から先端へ伸びるかすかな筋
  ctx.strokeStyle = 'rgba(200,238,255,0.13)';
  ctx.lineWidth = Math.max(1, size / 200);
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, size * 0.97);
    ctx.quadraticCurveTo(cx + i * size * 0.045, size * 0.55, cx + i * size * 0.035, size * 0.08);
    ctx.stroke();
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
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
        uMap: { value: makeGlowTexture(64, 2.0) },
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
        varying float vWarm;
        varying float vDim;
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a;
          if (a < 0.004) discard;
          vec3 c = mix(uCool, uWarm, vWarm);
          gl_FragColor = vec4(c * a * vDim, 1.0);
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
        uMap: { value: makeGlowTexture(32, 1.8) },
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
    const w = 1.6, h = 3.6, tilt = 1.30; // 外へ倒す角度（rad）。立てるとワイングラスに見える

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

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
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

    // 花の蓄え（暖色）。中心のまわりに固定オフセットで散らす
    // eco.flowers は毎回 slice するので描画ループでは使わない（確保を避ける）
    const flowers = eco._flowers;
    for (let i = 0; i < eco.flowerCount; i++) {
      const f = flowers[i];
      for (let k = 0; k < f.charge && n < this.lightN; k++) {
        const d = n * 3, ob = ((i * 31 + k) % this.lightN) * 3;
        const sp = CONF.flowerLightSpread;
        pos[d] = f.x + off[ob] * sp;
        pos[d + 1] = f.y + 0.9 + off[ob + 1] * sp * 0.6;
        pos[d + 2] = f.z + off[ob + 2] * sp;
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
        pos[d] = fi.x + off[ob] * 0.6;
        pos[d + 1] = fi.y + off[ob + 1] * 0.4;
        pos[d + 2] = fi.z + off[ob + 2] * 0.6;
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
        // 生えたてはまだ小さい（age で立ち上げる）
        const grow = Math.min(1, f.age / 6);
        // 同じ大きさが並ぶと生垣に見える。個体差を付ける（位置から決めるので毎フレーム安定）
        const h = (Math.abs(Math.sin(f.x * 12.9898 + f.z * 78.233)) * 43758.5453) % 1;
        const indiv = 0.72 + h * 0.75;
        const s = CONF.flowerScale * indiv * (0.55 + grow * 0.45);
        // 同じ高さに一列に並ぶと「灯りの列」に見える。高さにも個体差を付ける
        this._v3.set(f.x, f.y - 0.4 + (h - 0.5) * 2.2, f.z);
        this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.39996));
        this._v3b.set(s, s, s);
        this._m4.compose(this._v3, this._q, this._v3b);
        // 蓄えが多いほど明るい
        const lit = 0.55 + Math.min(1, f.charge / cap) * 0.85;
        this._color.setRGB(lit * 0.75, lit * 0.95, lit);
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
