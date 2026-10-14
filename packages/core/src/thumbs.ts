import * as THREE from 'three';
import type { Kit } from './kit';
import type { Catalog, Preset } from './catalog';
import { seedFromString } from './random';
import { t } from './i18n';
import { buildProp, type PropKind } from './props';
import { THEMES } from './themes';
import { commonMats, WATER_Y, type Mats, type ThemeCtx } from './themes/common';
import type { PlacedProp, WorldRegion } from './world';

/* =====================================================================
 * 物件缩略图：借用主渲染器画到离屏目标，读回像素转成 dataURL。
 * 逐帧少量生成，避免打开目录面板时卡顿。
 * 岛上摆设（prop）也用同一套离屏渲染：buildProp 在原点建几何，取景方式完全一样。
 * ===================================================================== */

const SIZE = 256;
const OUT = 128;

interface Job { key: string; build(): string; resolve: (url: string) => void }

export class ThumbnailRenderer {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 200);
  private rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
  private cache = new Map<string, string>();
  private queue: Job[] = [];
  private raf = 0;
  private disposed = false;
  private pixels = new Uint8Array(SIZE * SIZE * 4);
  private bigCanvas: HTMLCanvasElement | null = null;
  private bigCtx: CanvasRenderingContext2D | null = null;
  private bigImg: ImageData | null = null;
  private outCanvas: HTMLCanvasElement | null = null;
  private outCtx: CanvasRenderingContext2D | null = null;
  /** 摆设缩略图用的临时上下文（第一次要摆设缩略图时才建） */
  private pctx: ThemeCtx | null = null;

  constructor(private renderer: THREE.WebGLRenderer, private K: Kit, private catalog: Catalog, env: THREE.Texture) {
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene.environment = env;
    this.scene.environmentIntensity = .75;
    this.scene.add(new THREE.HemisphereLight('#fff6ea', '#b7a58e', 1.3));
    const key = new THREE.DirectionalLight('#fff3e0', 1.9);
    key.position.set(3, 6, 5);
    this.scene.add(key);

    if (typeof document !== 'undefined') {
      this.bigCanvas = document.createElement('canvas');
      this.bigCanvas.width = this.bigCanvas.height = SIZE;
      this.bigCtx = this.bigCanvas.getContext('2d');
      if (this.bigCtx) this.bigImg = this.bigCtx.createImageData(SIZE, SIZE);

      this.outCanvas = document.createElement('canvas');
      this.outCanvas.width = this.outCanvas.height = OUT;
      this.outCtx = this.outCanvas.getContext('2d');
      if (this.outCtx) this.outCtx.imageSmoothingQuality = 'high';
    }
  }

  get(preset: Preset): Promise<string> {
    const hit = this.cache.get(preset.id);
    if (hit) return Promise.resolve(hit);
    return this.enqueue(preset.id, () => this.draw(preset));
  }

  /** 摆设原型缩略图（添加面板用）：按 kind 的默认参数建一份，缓存和目录缩略图共用 */
  prop(kind: PropKind): Promise<string> {
    const key = 'prop:' + kind.kind;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    return this.enqueue(key, () => this.drawProp(kind));
  }

  private enqueue(key: string, build: () => string) {
    return new Promise<string>((resolve) => {
      this.queue.push({ key, build, resolve });
      if (!this.raf) this.raf = window.requestAnimationFrame(() => this.pump());
    });
  }

  private pump() {
    this.raf = 0;
    if (this.disposed) return;
    const start = performance.now();
    while (this.queue.length && performance.now() - start < 12) {
      const { key, build, resolve } = this.queue.shift();
      const cached = this.cache.get(key);
      if (cached) { resolve(cached); continue; }
      let url = '';
      try { url = build(); } catch (e) { console.warn(t('[island-palace] 缩略图生成失败'), key, e); }
      if (url) this.cache.set(key, url);
      resolve(url);
    }
    if (this.queue.length) this.raf = window.requestAnimationFrame(() => this.pump());
  }

  private draw(preset: Preset) {
    const entry = this.catalog[preset.type];
    if (!entry) return '';
    const lamps = this.K.LAMPS.length;
    seedFromString(preset.id);
    const obj = entry.build(preset.params || {});
    this.K.LAMPS.length = lamps;
    return this.shot(obj, entry.mount);
  }

  /** 摆设：和岛上一样按 kind.build 建几何（只记录不摆放的那条路径，见 props.ts 的 buildProp） */
  private drawProp(kind: PropKind) {
    const lamps = this.K.LAMPS.length;
    seedFromString('prop:' + kind.kind);
    const params: Record<string, unknown> = { seed: 1 };
    for (const spec of kind.params || []) params[spec.key] = spec.def;
    const prop: PlacedProp = { id: 'thumb', kind: kind.kind, pos: [0, 0], params };
    const obj = buildProp(this.propCtx(), prop);
    this.K.LAMPS.length = lamps;
    if (!obj) return '';
    return this.shot(obj, 'floor');
  }

  /** 摆设可能属于任何场景主题（海岛 / 森林 / 雪山 / 浮空），缩略图把所有主题的材质合起来用 */
  private propCtx(): ThemeCtx {
    if (!this.pctx) {
      const mats: Mats = { ...commonMats(this.K) };
      for (const th of THEMES) Object.assign(mats, th.materials(this.K));
      const region: WorldRegion = { id: 'thumb', name: '', theme: THEMES[0].id, seed: 1, palaces: [] };
      this.pctx = {
        K: this.K, catalog: this.catalog, region, mats,
        land: new THREE.Group(), raw: new THREE.Group(),
        seaY: WATER_Y, R: () => 30, center: [0, 0], maxR: 30, lots: [], roads: null,
        blockers: [], landmarks: [],
      };
    }
    return this.pctx;
  }

  private shot(obj: THREE.Object3D, mount?: string) {
    // 缩略图不需要点光源（也避免主场景材质因灯光数量不同而重新编译）
    const lights: THREE.Object3D[] = [];
    obj.traverse(o => { if ((o as THREE.PointLight).isPointLight) lights.push(o); });
    lights.forEach(l => l.removeFromParent());
    this.scene.add(obj);
    obj.updateMatrixWorld(true);

    // 等距视角，按包围盒在相机空间里的投影紧凑取景
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const dir = mount === 'wall' ? new THREE.Vector3(.55, .35, 1) : new THREE.Vector3(1, .95, 1.3);
    this.cam.position.copy(center).addScaledVector(dir.normalize(), 30);
    this.cam.lookAt(center);
    this.cam.updateMatrixWorld(true);
    const inv = this.cam.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const half = Math.max(maxX - minX, maxY - minY) / 2 * 1.12;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    Object.assign(this.cam, { left: cx - half, right: cx + half, top: cy + half, bottom: cy - half, near: .01, far: 100 });
    this.cam.updateProjectionMatrix();

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.cam);
    r.readRenderTargetPixels(this.rt, 0, 0, SIZE, SIZE, this.pixels);
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);

    this.scene.remove(obj);
    obj.traverse((o: any) => { if (o.isMesh && !o.geometry.userData.shared) o.geometry.dispose(); });

    // 翻转 Y 并 2 倍降采样（抗锯齿）
    if (!this.bigCanvas || !this.bigCtx || !this.bigImg || !this.outCanvas || !this.outCtx) return '';
    const row = SIZE * 4;
    for (let y = 0; y < SIZE; y++) this.bigImg.data.set(this.pixels.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row);
    this.bigCtx.putImageData(this.bigImg, 0, 0);
    this.outCtx.clearRect(0, 0, OUT, OUT);
    this.outCtx.drawImage(this.bigCanvas, 0, 0, OUT, OUT);
    return this.outCanvas.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    this.queue = [];
    this.rt.dispose();
    this.bigCanvas = null;
    this.bigCtx = null;
    this.bigImg = null;
    this.outCanvas = null;
    this.outCtx = null;
    // 摆设缩略图专用的那套材质是自己建的，跟着一起还掉
    for (const m of Object.values(this.pctx?.mats || {})) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
    this.pctx = null;
  }
}
