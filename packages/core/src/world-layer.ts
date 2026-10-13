import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Kit } from './kit';
import type { Catalog } from './catalog';
import type { PalaceDoc, Rect, Vec2 } from './schema';
import { Wall } from './walls';
import { mergeStatic, disposeTree } from './merge';
import { planRoads, type RoadNet } from './roads';
import { seedFromString } from './random';
import { BEND, unbendRay } from './bend';
import { t } from './i18n';
import { html } from './dom';
import { buildRoof } from './roof';
import { THEMES, getTheme, type ThemePack } from './themes';
import { commonMats, GRASS_Y, WATER_Y, type Landmark, type Mats, type ThemeCtx } from './themes/common';
import { bakeRegionProps, buildProp, registerProp } from './props';
import {
  PLAZA_R, bboxOf, frontDoor, indoorRects, palaceColor, palaceLot, palaceStats, placedLot, rectCenter, regionExtent, regionOrigin, rotateVec, toRegion,
  type PalaceWorld, type PlacedPalace, type PlacedProp, type WorldRegion,
} from './world';

/* =====================================================================
 * 世界图层（群岛）
 *   WorldLayer   整个世界：一片海 + 若干座岛；宫殿外壳的总索引；点光源池
 *   RegionLayer  一座岛：地形 / 道路 / 地标（由场景主题生成）+ 岛上宫殿的外壳
 * 坐标：WorldLayer.group 内是世界坐标；每座岛的 group 平移到它的原点（浮空岛再抬高），
 * 岛内一切（地块、道路、外壳）都用区域局部坐标。
 * 视图进入某座宫殿时，会把 WorldLayer.group 整体变换到那座宫殿的局部坐标系。
 * ===================================================================== */

const DEG = Math.PI / 180;
/** 夜里同时点亮的小镇点光源数量（固定数量，避免切换时重新编译着色器） */
const LIGHT_POOL = 10;

export interface Shell {
  id: string;
  regionId: string;
  placed: PlacedPalace;
  doc: PalaceDoc;
  group: THREE.Group;
  body: THREE.Group;
  roof: THREE.Group;
  roofMats: THREE.MeshStandardMaterial[];
  owned: THREE.Material[];
  /** 屋顶最高点（局部 y） */
  top: number;
  /** 屋顶掀起程度 0..1 */
  lift: number;
  liftTarget: number;
  /** 掀起时屋顶滑开的方向（宫殿局部坐标） */
  liftDir: THREE.Vector2;
  tag: CSS2DObject;
  /** 地块（区域坐标） */
  lot: Rect;
}

/** 射线打中的摆设；point 是世界坐标（和 pick() 的 point 同一套），是拾取盒上的命中点不是网格表面 */
export interface PropHit {
  regionId: string;
  propId: string;
  point: THREE.Vector3;
}

/** 一个摆设的拾取信息 */
interface PropEntry {
  /** build() 造出来的那一帧里的包围盒（相对草地、没有朝向；根节点自己的抬高已经算在里面） */
  local: THREE.Box3;
  /** 区域局部坐标的包围盒（拾取用，和画面上看到的一致） */
  box: THREE.Box3;
  /** 根节点自带的抬高（长椅坐在铺装上 6cm、热气球在天上 4m）：落位时 y = GRASS_Y + lift */
  lift: number;
  /** 脱离批次的个体（选中时才有）；并进合批结果的是 null */
  obj: THREE.Object3D | null;
}

/** 地形参数快照（刚建好地形、还没跑装饰的那一份）：重建摆设 / 烘焙时照它造一个干净的 ctx */
interface TerrainBase {
  R(a: number): number;
  center: Vec2;
  maxR: number;
  lots: Rect[];
  roads: RoadNet | null;
  seaY: number;
  blockers: { x: number; z: number; r: number }[];
  landmarks: Landmark[];
}

// =====================================================================
// 一座岛
// =====================================================================

export class RegionLayer {
  readonly group = new THREE.Group();
  readonly land = new THREE.Group();
  readonly shellRoot = new THREE.Group();
  theme: ThemePack;
  /** 宫殿地块 + 广场的外包矩形（区域坐标，取景用） */
  extent: Rect = [-10, -10, 10, 10];
  center: Vec2 = [0, 0];
  maxR = 24;
  roads: RoadNet | null = null;
  landmarks: Landmark[] = [];
  readonly tag: CSS2DObject;
  /** 摆设的拾取信息（id → 包围盒 / 个体），区域局部坐标；没烘焙过的岛是空的 */
  private readonly propBoxes = new Map<string, PropEntry>();
  private radial: ((a: number) => number) | null = null;
  /** 选中的摆设：脱离批次单独渲染（能高亮、能拖） */
  private selected: string | null = null;
  /** 合批后的装饰批次（广场铺装 + 摆设） */
  private decor: THREE.Group | null = null;
  /** 选中的那个摆设的个体（脱离批次，挂在 land 下） */
  private selRoot: THREE.Group | null = null;
  /** 地形参数快照：重建摆设 / 烘焙时不用再跑一遍地形 */
  private terrain: TerrainBase | null = null;
  /** 当前的夜间点亮系数（view.applyNight 给每盏灯乘的那个值）：重建出来的新灯要照它点亮 */
  private night = 0;

  constructor(public region: WorldRegion, private W: WorldLayer) {
    this.theme = getTheme(region.theme);
    this.group.name = 'region:' + region.id;
    this.group.userData.regionId = region.id;
    this.land.name = 'land';
    this.shellRoot.name = 'shells';
    this.group.add(this.land, this.shellRoot);
    const el = document.createElement('div');
    el.className = 'kp-region-tag';
    el.dataset.act = 'regionTag';
    el.dataset.id = region.id;
    this.tag = new CSS2DObject(el);
    this.tag.center.set(.5, 1);
    this.tag.visible = false;
    this.group.add(this.tag);
    this.place();
  }

  get lift() { return this.theme.lift || 0; }
  /** 岛（含浅滩）的外接圆半径 */
  get outerR() { return this.maxR + 9; }

  place() {
    const [ox, oz] = regionOrigin(this.region);
    this.group.position.set(ox, this.lift, oz);
    this.group.updateMatrixWorld(true);
  }

  /** 岛中心（世界坐标，草地高度） */
  worldCenter(out = new THREE.Vector3()) {
    const [ox, oz] = regionOrigin(this.region);
    return out.set(ox + this.center[0], this.lift + GRASS_Y, oz + this.center[1]);
  }

  /** 世界坐标 → 区域局部坐标 */
  toLocal(x: number, z: number): Vec2 {
    const [ox, oz] = regionOrigin(this.region);
    return [x - ox, z - oz];
  }

  onLand(x: number, z: number, pad = 0) {
    if (!this.radial) return false;
    const [cx, cz] = this.center;
    return Math.hypot(x - cx, z - cz) < this.radial(Math.atan2(z - cz, x - cx)) - pad;
  }

  /** 重建地形、道路、地标和装饰（宫殿增删 / 移动 / 换主题后） */
  rebuildLand(docs: Map<string, PalaceDoc>) {
    const region = this.region, K = this.W.K;
    this.theme = getTheme(region.theme);
    this.place();
    this.clearLand();
    seedFromString('town:' + region.seed);
    const lots: Rect[] = [];
    for (const p of region.palaces) {
      const d = docs.get(p.palaceId);
      if (d) lots.push(placedLot(p, d));
    }
    const ext = this.extent = regionExtent(region, docs);
    this.center = rectCenter(ext);
    const R = this.radial = islandRadial(ext, lots, region.seed, this.center, this.theme.margin ?? 8, this.theme.minR ?? 22);
    let maxR = 0;
    for (let i = 0; i < 64; i++) maxR = Math.max(maxR, R(i / 64 * Math.PI * 2));
    this.maxR = maxR;

    // 地形自己一个批次：主题直接塞进 raw 的东西（浮空岛的石笋）跟着它，重建摆设时就不用重跑地形
    const landRaw = new THREE.Group();
    const ctx: ThemeCtx = {
      K, catalog: this.W.catalog, region, mats: this.W.mats(this.theme.id),
      land: this.land, raw: landRaw, seaY: WATER_Y - this.lift, R, center: this.center, maxR, lots, roads: null,
      blockers: [{ x: 0, z: 0, r: PLAZA_R + 2.5 }], landmarks: [{ kind: 'plaza', x: 0, z: 0, angle: 0 }],
    };
    this.theme.terrain(ctx);

    // 道路：从每座宫殿的门口通往广场
    const [cx, cz] = this.center;
    const sources = region.palaces.flatMap(p => {
      const d = docs.get(p.palaceId);
      if (!d) return [];
      const door = frontDoor(d);
      let rd = null;
      if (door) {
        const [x, z] = toRegion(p, door.x, door.z), [nx, nz] = rotateVec(p.rot, door.nx, door.nz);
        rd = { x, z, nx: Math.round(nx), nz: Math.round(nz), w: door.w };
      }
      return [{ id: p.palaceId, door: rd, lot: placedLot(p, d) }];
    });
    ctx.roads = this.roads = planRoads({
      bounds: [cx - maxR, cz - maxR, cx + maxR, cz + maxR],
      land: (x, z) => this.onLand(x, z, 2.5),
      lots, plaza: { x: 0, z: 0, r: PLAZA_R }, sources,
    });
    this.buildRoads(ctx);

    // 记下地形参数和「还没跑装饰」的阻挡 / 地标（摆放会读它们）：重建摆设 / 烘焙照这份造干净的 ctx
    this.terrain = {
      R, center: this.center, maxR, lots, roads: ctx.roads, seaY: ctx.seaY,
      blockers: ctx.blockers.map(b => ({ ...b })), landmarks: ctx.landmarks.map(l => ({ ...l })),
    };

    if (landRaw.children.length) this.addBatch(landRaw, 'land-decor');
    this.rebuildDecor();
    this.tag.position.set(cx, 9, cz);
  }

  // =====================================================================
  // 装饰 / 摆设
  // =====================================================================

  /**
   * 重建装饰批次：广场铺装 + 岛上的摆设。
   * 烘焙过的岛（region.props 存在）按数据建，地标 / 阻挡也按存盘的顺序重放（道路要避开灯塔）；
   * 没烘焙的岛走主题的 decorate（和以前一模一样）。两条路只走一条。
   * 选中的那个摆设不进批次，单独放在 selRoot 里，所以能高亮、能拖。
   */
  rebuildDecor() {
    const ctx = this.decorCtx();
    if (!ctx) return;
    const data = this.region.props;
    // 选中的摆设可能已经被删掉了
    if (data === undefined || !data.some(p => p.id === this.selected)) this.selected = null;
    this.dropDecor();
    this.propBoxes.clear();
    if (this.selected) {
      const sel = this.selRoot = new THREE.Group();
      sel.name = 'prop-sel';
      this.land.add(sel);
    }
    this.theme.plaza(ctx);
    if (data === undefined) this.theme.decorate(ctx);
    else this.placeProps(ctx, data);
    this.landmarks = ctx.landmarks;
    this.addBatch(ctx.raw, 'decor');
    this.lightUpNew();
  }

  /** 按数据摆出这一批摆设（原点和朝向由摆放方设置，几何见 props.ts） */
  private placeProps(ctx: ThemeCtx, list: PlacedProp[]) {
    for (const p of list) {
      const obj = buildProp(ctx, p);
      // 地标 / 阻挡必须按存盘的顺序重放：后面的摆放会读它们
      registerProp(ctx, p);
      if (!obj) continue;
      obj.updateMatrixWorld(true); // 还没进场景树：world 矩阵就是它自己的局部矩阵
      const local = new THREE.Box3().setFromObject(obj);
      const lift = obj.position.y; // build() 的根节点抬高（相对草地），落位时不能丢
      // 位置 / 朝向必须和 props.ts 里 placer 那条路一模一样（烘焙前后才看不出差别）
      obj.position.set(p.pos[0], GRASS_Y + lift, p.pos[1]);
      if (p.rot) obj.rotation.y = p.rot;
      const box = local.clone().applyMatrix4(propMatrix(p.pos, p.rot ?? 0));
      const detached = p.id === this.selected;
      this.propBoxes.set(p.id, { local, box, lift, obj: detached ? obj : null });
      (detached && this.selRoot ? this.selRoot : ctx.raw).add(obj);
    }
  }

  /**
   * 把现在这套程序化装饰冻成数据（region.props）：跑的是同一份摆放代码、同一份地形参数，
   * 所以摆出来的位置和岛上现在看到的一模一样，只记录不建几何。
   * 已经烘焙过就什么都不做（幂等，也不会覆盖用户改过的摆放）。
   */
  bake(): boolean {
    const region = this.region;
    if (region.props !== undefined) return false;
    const ctx = this.decorCtx();
    if (!ctx) return false;
    region.props = bakeRegionProps(region, ctx);
    // 立刻改走数据那条路：看起来一样，但摆设从此能单独拾取 / 移动
    this.rebuildDecor();
    return true;
  }

  /** 摆设用的干净 ctx：地形参数照旧，raw 是新的空组，地标 / 阻挡回到刚建好地形时的状态 */
  private decorCtx(): ThemeCtx | null {
    const t = this.terrain;
    if (!t) return null;
    return {
      K: this.W.K, catalog: this.W.catalog, region: this.region, mats: this.W.mats(this.theme.id),
      land: this.land, raw: new THREE.Group(), seaY: t.seaY, R: t.R, center: t.center, maxR: t.maxR, lots: t.lots, roads: t.roads,
      blockers: t.blockers.map(b => ({ ...b })), landmarks: t.landmarks.map(l => ({ ...l })),
    };
  }

  /** 丢掉上一批装饰（合批结果 + 脱离批次的个体）：几何、灯光登记一起清干净 */
  private dropDecor() {
    if (!this.decor && !this.selRoot) return;
    this.captureNight();
    for (const root of [this.decor, this.selRoot]) {
      if (!root) continue;
      this.unregisterLights(root);
      disposeTree(root);
      root.removeFromParent();
    }
    this.decor = this.selRoot = null;
  }

  /** 按材质合批后挂到 land 上（绘制调用保持和以前一样少）；点光源会被搬到合批结果里 */
  private addBatch(raw: THREE.Group, name: string) {
    raw.updateMatrixWorld(true);
    const merged = mergeStatic(raw);
    disposeTree(raw);
    merged.name = name;
    this.land.add(merged);
  }

  /** 从 Kit 的灯光登记表里摘掉一棵子树里的点光源（重建 / 清理都要做，不然 LAMPS 越积越多） */
  private unregisterLights(root: THREE.Object3D) {
    const lamps = this.W.K.LAMPS;
    for (const light of pointLights(root)) {
      const i = lamps.findIndex(e => e.l === light);
      if (i >= 0) lamps.splice(i, 1);
    }
  }

  /** 记下当前的夜间点亮系数（摘掉旧灯之前读；新的灯要照它点亮，不然选中一下就全黑了） */
  private captureNight() {
    let n = -1;
    for (const e of this.W.K.LAMPS) if (e.intensity > 0) n = Math.max(n, e.l.intensity / e.intensity);
    if (n >= 0) this.night = n;
  }

  /** 这座岛新造出来的灯按当前夜间系数点亮（白天是 0，什么都不做） */
  private lightUpNew() {
    if (this.night <= 0) return;
    const lamps = this.W.K.LAMPS;
    for (const light of pointLights(this.land)) {
      const e = lamps.find(x => x.l === light);
      if (e) light.intensity = e.intensity * this.night;
    }
  }

  private buildRoads(ctx: ThemeCtx) {
    const net = ctx.roads;
    const pave: THREE.BufferGeometry[] = [], curb: THREE.BufferGeometry[] = [];
    // 长路段切成不超过 3 m 的小段：星球模式下路面才能贴着球面弯
    const seg = (a: Vec2, b: Vec2, w: number) => {
      const h = w / 2;
      const x0 = Math.min(a[0], b[0]) - h, x1 = Math.max(a[0], b[0]) + h, z0 = Math.min(a[1], b[1]) - h, z1 = Math.max(a[1], b[1]) + h;
      const alongX = x1 - x0 >= z1 - z0, len = alongX ? x1 - x0 : z1 - z0, n = Math.max(1, Math.ceil(len / 3));
      for (let i = 0; i < n; i++) {
        const s0 = (alongX ? x0 : z0) + len * i / n, s1 = (alongX ? x0 : z0) + len * (i + 1) / n;
        const [bx0, bx1, bz0, bz1] = alongX ? [s0, s1, z0, z1] : [x0, x1, s0, s1];
        const p = new THREE.BoxGeometry(bx1 - bx0, .05, bz1 - bz0); p.translate((bx0 + bx1) / 2, GRASS_Y + .03, (bz0 + bz1) / 2); pave.push(p);
        const c = new THREE.BoxGeometry(bx1 - bx0 + (alongX ? 0 : .3), .04, bz1 - bz0 + (alongX ? .3 : 0)); c.translate((bx0 + bx1) / 2, GRASS_Y + .01, (bz0 + bz1) / 2); curb.push(c);
      }
      // 两端的路缘补齐
      for (const [ex, ez] of alongX ? [[x0 - .075, (z0 + z1) / 2], [x1 + .075, (z0 + z1) / 2]] : [[(x0 + x1) / 2, z0 - .075], [(x0 + x1) / 2, z1 + .075]]) {
        const c = new THREE.BoxGeometry(alongX ? .15 : x1 - x0 + .3, .04, alongX ? z1 - z0 + .3 : .15); c.translate(ex, GRASS_Y + .01, ez); curb.push(c);
      }
    };
    for (const r of net.runs) for (let i = 0; i + 1 < r.pts.length; i++) seg(r.pts[i], r.pts[i + 1], r.width);
    for (const w of net.walkways) seg(w.a, w.b, w.width);
    for (const [geos, mat] of [[pave, ctx.mats.paver], [curb, ctx.mats.curb]] as [THREE.BufferGeometry[], THREE.Material][]) {
      if (!geos.length) continue;
      const m = new THREE.Mesh(mergeBoxes(geos), mat);
      m.receiveShadow = true;
      this.land.add(m);
    }
  }

  private clearLand() {
    this.captureNight(); // 灯摘掉之前先记下点亮系数
    this.unregisterLights(this.land);
    disposeTree(this.land);
    this.land.clear();
    this.decor = null;
    this.selRoot = null;
    this.propBoxes.clear();
  }

  /** 群岛视角的岛名牌 */
  updateTag(docs: Map<string, PalaceDoc>) {
    const el = this.tag.element, r = this.region;
    const palaces = r.palaces.map(p => docs.get(p.palaceId)).filter(Boolean);
    el.replaceChildren(html`<em></em><span><b></b><small>${t('{n} 座宫殿', { n: palaces.length })}</small></span>`);
    el.querySelector('em').textContent = this.theme.icon;
    el.querySelector('b').textContent = r.name;
  }

  // =====================================================================
  // 摆设：拾取 / 选中
  // =====================================================================

  /** 区域局部坐标的一条射线打中的最近摆设（离镜头最近的那个）；逐个 AABB 求交，不用重建任何东西 */
  pickProp(ray: THREE.Ray): { propId: string; point: THREE.Vector3 } | null {
    let out: { propId: string; point: THREE.Vector3 } | null = null;
    let best = Infinity;
    const p = new THREE.Vector3();
    for (const [propId, e] of this.propBoxes) {
      if (!ray.intersectBox(e.box, p)) continue;
      const d = ray.origin.distanceToSquared(p);
      if (d >= best) continue;
      best = d;
      out = { propId, point: p.clone() };
    }
    return out;
  }

  /** 选中 / 取消选中：选中的那个脱离批次单独渲染（能高亮、能拖）；换选中要重建那一批，拖动中不用 */
  selectProp(propId: string | null) {
    const id = propId !== null && this.propBoxes.has(propId) ? propId : null;
    if (id === this.selected) return;
    this.selected = id;
    if (this.terrain) this.rebuildDecor();
  }

  /** 拖动中的每帧变换：只动脱离批次的个体（不重建批次），拾取盒跟着走 */
  moveProp(propId: string, pos: Vec2, rot: number) {
    if (this.selected !== propId) {
      if (!this.propBoxes.has(propId)) return; // 不是这座岛的 / 还没烘焙
      this.selectProp(propId); // 调用方没先选中：这一帧把它脱离出来（只重建这一次）
    }
    const e = this.propBoxes.get(propId);
    if (!e?.obj) return;
    e.obj.position.set(pos[0], GRASS_Y + e.lift, pos[1]);
    e.obj.rotation.y = rot;
    e.box.copy(e.local).applyMatrix4(propMatrix(pos, rot));
  }

  /** 摆设的世界包围盒（挂标记 / 命中反馈用）；没有这个摆设就返回 null */
  boxOf(propId: string): THREE.Box3 | null {
    const e = this.propBoxes.get(propId);
    return e ? e.box.clone().applyMatrix4(this.group.matrixWorld) : null;
  }

  dispose() {
    this.clearLand();
    this.tag.element.remove();
    this.group.removeFromParent();
  }
}

// =====================================================================
// 整个世界
// =====================================================================

export class WorldLayer {
  readonly group = new THREE.Group();
  readonly regions = new Map<string, RegionLayer>();
  readonly shells = new Map<string, Shell>();
  /** 所有岛的外包盒（世界坐标） */
  bounds = new THREE.Box3();
  far = false;
  /** 悬停中的摆设（只记状态：悬停不重建批次，反馈由调用方用 propBox 画） */
  hoveredProp: string | null = null;
  private ocean: THREE.Mesh;
  private oceanMat: THREE.MeshStandardMaterial;
  private common: Mats;
  private themeMats = new Map<string, Mats>();
  private shellGlass: THREE.MeshStandardMaterial;
  private lightTick = 0;
  /** 岛与岛之间的航线（虚线 + 小帆船） */
  private lanes = new THREE.Group();

  constructor(readonly K: Kit, readonly catalog: Catalog) {
    this.group.name = 'world';
    this.common = commonMats(K);
    this.oceanMat = new THREE.MeshStandardMaterial({ color: '#7cc4c0', roughness: .22, metalness: .05 });
    this.ocean = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 220, 220), this.oceanMat);
    this.ocean.rotation.x = -Math.PI / 2;
    this.ocean.position.y = WATER_Y;
    this.ocean.receiveShadow = true;
    this.ocean.name = 'ocean';
    this.lanes.name = 'lanes';
    this.group.add(this.ocean, this.lanes);
    // 外壳的窗户：白天像反光的玻璃（看不到空荡荡的内部），夜里透出暖光
    this.shellGlass = K.glow('#a9c3cb', '#ffc47a', 1.25, 0);
    this.shellGlass.roughness = .16;
    this.shellGlass.metalness = .35;
  }

  /** 某个主题的材质（共用材质 + 主题材质），按需创建、全局复用 */
  mats(themeId: string): Mats {
    let m = this.themeMats.get(themeId);
    if (!m) {
      m = { ...this.common, ...getTheme(themeId).materials(this.K) };
      this.themeMats.set(themeId, m);
    }
    return m;
  }

  // =====================================================================
  // 构建
  // =====================================================================

  /** 整体重建：所有岛 + 外壳 */
  build(world: PalaceWorld, docs: Map<string, PalaceDoc>) {
    for (const id of [...this.shells.keys()]) this.removeShell(id);
    for (const id of [...this.regions.keys()]) this.removeRegion(id);
    for (const r of world.regions) this.addRegion(r, docs);
    this.updateBounds();
  }

  addRegion(region: WorldRegion, docs: Map<string, PalaceDoc>) {
    this.removeRegion(region.id);
    const layer = new RegionLayer(region, this);
    this.regions.set(region.id, layer);
    this.group.add(layer.group);
    for (const p of region.palaces) {
      const doc = docs.get(p.palaceId);
      if (doc) this.addShell(region, p, doc);
    }
    layer.rebuildLand(docs);
    layer.updateTag(docs);
    layer.tag.visible = this.far;
    return layer;
  }

  removeRegion(id: string) {
    const layer = this.regions.get(id);
    if (!layer) return;
    for (const [sid, s] of [...this.shells]) if (s.regionId === id) this.removeShell(sid);
    layer.dispose();
    this.regions.delete(id);
  }

  /** 一座岛的宫殿摆放 / 主题变了：重建它的地形 */
  rebuildLand(regionId: string, docs: Map<string, PalaceDoc>) {
    const layer = this.regions.get(regionId);
    if (!layer) return;
    layer.rebuildLand(docs);
    layer.updateTag(docs);
    this.updateBounds();
  }

  /** 岛的实际半径（给摆放 / 推开邻岛用） */
  radii() {
    const out = new Map<string, number>();
    for (const [id, l] of this.regions) out.set(id, l.outerR);
    return out;
  }

  /** 岛的原点变了（群岛布置 / 推开邻岛）：只移动，不重建 */
  placeRegions() {
    for (const l of this.regions.values()) l.place();
    this.updateBounds();
  }

  updateBounds() {
    const b = this.bounds.makeEmpty(), v = new THREE.Vector3();
    for (const l of this.regions.values()) {
      l.worldCenter(v);
      b.expandByPoint(v.clone().add(new THREE.Vector3(-l.maxR, 0, -l.maxR)));
      b.expandByPoint(v.clone().add(new THREE.Vector3(l.maxR, 6, l.maxR)));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(-30, -1, -30), new THREE.Vector3(30, 6, 30));
    b.min.y = Math.min(b.min.y, WATER_Y);
    const c = b.getCenter(v), size = b.getSize(new THREE.Vector3());
    const span = Math.max(900, Math.max(size.x, size.z) * 5);
    this.ocean.scale.set(span, span, 1);
    this.ocean.position.set(c.x, WATER_Y, c.z);
    this.buildLanes();
  }

  /** 星球模式：海面变哑光（不然像一颗反光的玻璃弹珠） */
  setPlanetLook(p: number) {
    this.oceanMat.roughness = THREE.MathUtils.lerp(.22, .62, p);
  }

  /**
   * 航线：按最小生成树把相邻的岛连起来，海面上画一串白色虚线，中途一条小帆船。
   * 卷成星球时它们自然变成弧线。
   */
  private buildLanes() {
    disposeTree(this.lanes);
    this.lanes.clear();
    const layers = [...this.regions.values()];
    if (layers.length < 2) return;
    const pts = layers.map(l => { const w = l.worldCenter(); return { x: w.x, z: w.z, r: l.maxR + 2.5 }; });
    // Prim：从第一座岛开始，每次连上离已连通部分最近的岛
    const inTree = new Set([0]), edges: [number, number][] = [];
    while (inTree.size < pts.length) {
      let best: [number, number] | null = null, bestD = Infinity;
      for (const i of inTree) for (let j = 0; j < pts.length; j++) {
        if (inTree.has(j)) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z) - pts[i].r - pts[j].r;
        if (d < bestD) { bestD = d; best = [i, j]; }
      }
      if (!best) break;
      edges.push(best);
      inTree.add(best[1]);
    }
    const K = this.K, m = this.common, raw = new THREE.Group();
    const dashMat = m.white;
    for (const [i, j] of edges) {
      const a = pts[i], b = pts[j];
      const len = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
      const s0 = a.r, s1 = len - b.r;
      if (s1 - s0 < 6) continue;
      const rot = Math.atan2(ux, uz);
      for (let s = s0 + 1; s < s1 - 1; s += 2.6) {
        const d = K.mesh(new THREE.BoxGeometry(.3, .04, 1.4), dashMat, false);
        d.position.set(a.x + ux * s, WATER_Y + .05, a.z + uz * s);
        d.rotation.y = rot;
        raw.add(d);
      }
      raw.add(sailboat(K, m, a.x + ux * (s0 + (s1 - s0) * .38), a.z + uz * (s0 + (s1 - s0) * .38), rot));
    }
    raw.updateMatrixWorld(true);
    const merged = mergeStatic(raw);
    disposeTree(raw);
    this.lanes.add(merged);
  }

  /** 群岛视角：显示岛名牌 */
  setFar(on: boolean) {
    this.far = on;
    for (const l of this.regions.values()) l.tag.visible = on;
  }

  // =====================================================================
  // 宫殿外壳
  // =====================================================================

  addShell(region: WorldRegion, placed: PlacedPalace, doc: PalaceDoc) {
    this.removeShell(placed.palaceId);
    const layer = this.regions.get(region.id);
    if (!layer) return null;
    const K = this.K;
    const H = doc.wallHeight ?? 2.8;
    const group = new THREE.Group();
    group.name = 'shell:' + doc.id;
    group.userData.palaceId = doc.id;

    // 外墙 + 门窗 + 地坪 → 合并
    const raw = new THREE.Group();
    for (const r of doc.rooms) {
      if (!r.floor) continue;
      const [x0, z0, x1, z1] = r.rect;
      const s = K.box(raw, x1 - x0 + .2, .15, z1 - z0 + .2, K.M.slab, (x0 + x1) / 2, -.152, (z0 + z1) / 2, .01);
      s.castShadow = false;
      if (!r.outdoor) {
        const f = K.mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), K.M.cream, false);
        f.rotation.x = -Math.PI / 2; f.position.set((x0 + x1) / 2, .005, (z0 + z1) / 2);
        raw.add(f);
      }
    }
    for (const def of doc.walls) {
      if (!def.normal) continue;
      const w = new Wall(K, def, raw, H);
      w.cur = H; w.apply();
    }
    raw.traverse((o: any) => { if (o.isMesh && o.material === K.M.glass) o.material = this.shellGlass; });
    const body = mergeStatic(raw);
    const owned = new Set<THREE.Material>();
    body.traverse((o: any) => { if (o.isMesh && o.material?.userData?.owned) owned.add(o.material); });
    disposeTree(raw);
    body.name = 'shell-body';
    group.add(body);

    const color = placed.roofColor || palaceColor(doc);
    const roof = buildRoof(K, doc, H, color, placed.roof || 'auto', !!layer.theme.roofSnow);
    group.add(roof.group);

    const el = document.createElement('div');
    el.className = 'kp-tag';
    el.dataset.act = 'tag';
    el.dataset.id = doc.id;
    const tag = new CSS2DObject(el);
    tag.center.set(.5, 1);
    group.add(tag);

    const shell: Shell = {
      id: doc.id, regionId: region.id, placed, doc, group, body, roof: roof.group, roofMats: roof.mats, owned: [...owned], top: roof.top,
      lift: 0, liftTarget: 0, liftDir: new THREE.Vector2(0, -1), tag, lot: placedLot(placed, doc),
    };
    this.updateTag(shell);
    this.placeShell(shell);
    this.shells.set(doc.id, shell);
    layer.shellRoot.add(group);
    return shell;
  }

  removeShell(id: string) {
    const s = this.shells.get(id);
    if (!s) return;
    this.shells.delete(id);
    s.tag.element.remove();
    s.group.removeFromParent();
    disposeTree(s.body);
    disposeTree(s.roof);
    s.roofMats.forEach(m => m.dispose());
    s.owned.forEach(m => m.dispose());
  }

  /** 按 placed 更新外壳位置（拖动时每帧调用） */
  placeShell(s: Shell) {
    s.group.position.set(s.placed.pos[0], 0, s.placed.pos[1]);
    s.group.rotation.y = s.placed.rot * DEG;
    s.lot = placedLot(s.placed, s.doc);
  }

  updateTag(s: Shell) {
    const doc = s.doc, st = palaceStats(doc);
    const el = s.tag.element;
    el.style.setProperty('--c', s.placed.roofColor || palaceColor(doc));
    el.replaceChildren(html`<i></i><b></b>`);
    el.querySelector('b').textContent = doc.name;
    el.title = [doc.name, t('{n} 个房间', { n: st.rooms }), t('{n} 个物件', { n: st.items })].join(' · ');
    const rects = indoorRects(doc);
    const bb = bboxOf(rects.length ? rects : [palaceLot(doc)]);
    const [x, z] = rectCenter(bb);
    s.tag.position.set(x, s.top + .7, z);
  }

  regionOfShell(id: string) {
    const s = this.shells.get(id);
    return s ? this.regions.get(s.regionId) : undefined;
  }

  // =====================================================================
  // 拾取
  // =====================================================================

  /** 射线拾取宫殿外壳 */
  pick(ray: THREE.Raycaster): { id: string; point: THREE.Vector3 } | null {
    const list: THREE.Object3D[] = [];
    for (const s of this.shells.values()) if (s.group.visible) list.push(s.body, s.roof);
    const hits = ray.intersectObjects(list, true);
    for (const h of hits) {
      let o: THREE.Object3D = h.object, vis = true;
      while (o && !o.userData.palaceId) { if (!o.visible) vis = false; o = o.parent; }
      if (o && vis) return { id: o.userData.palaceId, point: h.point };
    }
    return null;
  }

  /** 射线与某座岛草地平面的交点（区域局部坐标） */
  groundOf(ray: THREE.Raycaster, layer: RegionLayer): Vec2 | null {
    const inv = this.group.matrixWorld.clone().invert();
    const r = ray.ray.clone().applyMatrix4(inv);
    // 星球模式下地面是弯的：先打在球面上，再展开回平面地图
    const out = BEND.k.value > 0 ? unbendRay(r, layer.lift) : r.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -layer.lift), new THREE.Vector3());
    if (!out) return null;
    return layer.toLocal(out.x, out.z);
  }

  /** 星球模式：海面跟着焦点走（海面是均匀的，移动它看不出来，但能保证整颗星球都被海包住） */
  setOceanCenter(x: number, z: number, reach: number) {
    // 海面要从北极一直铺到南极（弧长 πR），否则星球下半边会露出空洞
    const span = Math.min(40000, Math.max(900, reach * 2.2));
    this.ocean.scale.set(span, span, 1);
    this.ocean.position.x = x;
    this.ocean.position.z = z;
  }

  /** 射线落在哪座宫殿的地块上 */
  pickLot(ray: THREE.Raycaster): string | null {
    for (const layer of this.regions.values()) {
      const g = this.groundOf(ray, layer);
      if (!g) continue;
      for (const s of this.shells.values()) {
        if (s.regionId !== layer.region.id || !s.group.visible) continue;
        const [x0, z0, x1, z1] = s.lot;
        if (g[0] > x0 && g[0] < x1 && g[1] > z0 && g[1] < z1) return s.id;
      }
    }
    return null;
  }

  /** 射线落在哪座岛上（浮空岛优先：它在上面） */
  pickRegion(ray: THREE.Raycaster): string | null {
    const layers = [...this.regions.values()].sort((a, b) => b.lift - a.lift);
    for (const layer of layers) {
      const g = this.groundOf(ray, layer);
      if (g && layer.onLand(g[0], g[1], -3)) return layer.region.id;
    }
    return null;
  }

  // =====================================================================
  // 岛上的摆设
  // =====================================================================

  /**
   * 射线打中的最近摆设。
   * 先按岛预筛：隐藏的岛、射线连岛的范围都打不到的岛直接跳过（bounds 是外接圆，海里的礁石 / 浮冰也算）。
   * 平面模式下把射线搬进这座岛的局部坐标逐个 AABB 求交；
   * 星球模式下地面是弯的、射线打不直，就先 unbendRay 求地面落点，再从落点垂直往下打（远看时够用）。
   * 每次指针移动都会调用：每座岛一次求交 + 一次矩阵求逆，命中的那座岛最多几百个 AABB 测试。
   */
  pickProp(ray: THREE.Raycaster): PropHit | null {
    const bent = BEND.k.value > 0;
    let best: PropHit | null = null;
    let bestD = Infinity;
    for (const layer of this.regions.values()) {
      if (!layer.group.visible) continue;
      const g = this.groundOf(ray, layer);
      if (!g || Math.hypot(g[0] - layer.center[0], g[1] - layer.center[1]) > layer.outerR) continue;
      const mw = layer.group.matrixWorld;
      const local = bent
        ? new THREE.Ray(new THREE.Vector3(g[0], GRASS_Y + 60, g[1]), new THREE.Vector3(0, -1, 0))
        : ray.ray.clone().applyMatrix4(mw.clone().invert());
      const hit = layer.pickProp(local);
      if (!hit) continue;
      const d = local.origin.distanceToSquared(hit.point);
      if (d >= bestD) continue;
      bestD = d;
      best = { regionId: layer.region.id, propId: hit.propId, point: hit.point.applyMatrix4(mw) };
    }
    return best;
  }

  /** 悬停反馈：只记状态，不动几何（悬停不重建批次，反馈由调用方画） */
  setPropHover(propId: string | null) {
    this.hoveredProp = propId;
  }

  /** 选中 / 取消选中一个摆设：选中的那个脱离批次单独渲染（能高亮、能拖） */
  setPropSelection(propId: string | null) {
    for (const layer of this.regions.values()) layer.selectProp(propId);
  }

  /** 拖动中的每帧变换（只动脱离批次的个体，不重建批次） */
  movePropPreview(regionId: string, propId: string, pos: Vec2, rot: number) {
    this.regions.get(regionId)?.moveProp(propId, pos, rot);
  }

  /** 摆设的数据变了（加 / 删 / 改参数）：重建那一批 */
  rebuildProps(regionId: string) {
    this.regions.get(regionId)?.rebuildDecor();
  }

  /** 摆设的世界包围盒（挂标记 / 命中反馈用） */
  propBox(regionId: string, propId: string): THREE.Box3 | null {
    return this.regions.get(regionId)?.boxOf(propId) ?? null;
  }

  /**
   * 把一座岛现在的程序化装饰冻成数据（region.props），摆出来的位置和岛上现在看到的一模一样。
   * 幂等：已经烘焙过的岛直接返回 false（不会覆盖用户改过的摆放）。
   * 返回 true 表示新建了数据，调用方要存盘。
   */
  bakeProps(regionId: string): boolean {
    return this.regions.get(regionId)?.bake() ?? false;
  }

  // =====================================================================
  // 动画 / 灯光
  // =====================================================================

  /** 屋顶掀起 / 放下动画；返回是否还在动 */
  update(dt: number) {
    let moving = false;
    for (const s of this.shells.values()) {
      if (s.lift === s.liftTarget) continue;
      moving = true;
      const k = Math.min(1, dt * 5);
      s.lift += (s.liftTarget - s.lift) * k;
      if (Math.abs(s.lift - s.liftTarget) < .004) s.lift = s.liftTarget;
      this.applyLift(s);
    }
    return moving;
  }

  applyLift(s: Shell) {
    const t = s.lift, e = t * t * (3 - 2 * t);
    s.roof.position.set(s.liftDir.x * e * 2.2, e * 2.6, s.liftDir.y * e * 2.2);
    s.roof.rotation.set(s.liftDir.y * e * .12, 0, -s.liftDir.x * e * .12);
    s.roof.visible = t < .995;
    const fade = THREE.MathUtils.smoothstep(t, .25, .95);
    for (const m of s.roofMats) {
      const tr = fade > 0;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = 1 - fade;
    }
    s.roof.traverse((o: any) => { if (o.isMesh) o.castShadow = t < .05; });
  }

  /** 立即设定屋顶状态（无动画） */
  setLift(id: string, v: number) {
    const s = this.shells.get(id);
    if (!s) return;
    s.lift = s.liftTarget = v;
    this.applyLift(s);
  }

  /**
   * 点光源池：小镇里的路灯、灯塔只点亮离镜头焦点最近的若干盏。
   * 数量固定，岛越来越多也不会拖慢着色；看远处的岛时它们靠发光材质「亮着」。
   */
  updateLightPool(target: THREE.Vector3, force = false) {
    const now = performance.now();
    if (!force && now - this.lightTick < 400) return;
    this.lightTick = now;
    const lights: { l: THREE.PointLight; d: number }[] = [];
    const p = new THREE.Vector3();
    for (const layer of this.regions.values()) {
      layer.land.traverse((o: any) => {
        if (o.isPointLight) lights.push({ l: o, d: o.getWorldPosition(p).distanceToSquared(target) });
      });
    }
    lights.sort((a, b) => a.d - b.d);
    lights.forEach((e, i) => { e.l.visible = i < LIGHT_POOL; });
  }

  dispose() {
    for (const id of [...this.shells.keys()]) this.removeShell(id);
    for (const id of [...this.regions.keys()]) this.removeRegion(id);
    for (const mats of this.themeMats.values()) {
      for (const m of Object.values(mats)) {
        if (Object.values(this.common).includes(m)) continue;
        (m as THREE.MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
    }
    Object.values(this.common).forEach(m => m.dispose());
    this.ocean.geometry.dispose();
    this.oceanMat.dispose();
    this.group.removeFromParent();
  }
}

/** 所有主题（选择器用） */
export { THEMES };

/** 航线上的小帆船（局部 +z 朝航向） */
function sailboat(K: Kit, m: Mats, x: number, z: number, rot: number) {
  const g = new THREE.Group();
  const s = new THREE.Shape();
  s.moveTo(-.55, -1.4); s.lineTo(.55, -1.4); s.quadraticCurveTo(.6, .4, 0, 1.6); s.quadraticCurveTo(-.6, .4, -.55, -1.4);
  const hull = K.mesh(new THREE.ExtrudeGeometry(s, { depth: .4, bevelEnabled: true, bevelThickness: .06, bevelSize: .06, bevelSegments: 1, curveSegments: 10 }), [m.hull, m.red]);
  hull.rotation.x = -Math.PI / 2; g.add(hull);
  const mast = K.mesh(new THREE.CylinderGeometry(.04, .05, 2.6, 6), m.woodDark); mast.position.set(0, 1.7, .2); g.add(mast);
  const sail = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 2.2), new THREE.Vector2(1.1, .1)]);
  const sm = K.mesh(new THREE.ShapeGeometry(sail), m.hull); sm.position.set(.05, .55, .2); sm.rotation.y = -Math.PI / 2; g.add(sm);
  g.position.set(x, WATER_Y - .15, z);
  g.rotation.y = rot;
  return g;
}

// =====================================================================
// 小工具
// =====================================================================

/**
 * 摆设的摆放矩阵：先绕 y 转 rot、再放到 (x, GRASS_Y, z)。
 * 必须和「obj.position.set(x, GRASS_Y, z) + obj.rotation.y = rot」完全一致，
 * 拾取盒和拖动时都用它从原点处的包围盒算出区域局部坐标的包围盒。
 */
function propMatrix(pos: Vec2, rot: number) {
  return new THREE.Matrix4().makeRotationY(rot).setPosition(pos[0], GRASS_Y, pos[1]);
}

/** 一棵子树里的点光源（灯光登记表的登记 / 摘除都按这个来） */
function pointLights(root: THREE.Object3D): THREE.PointLight[] {
  const out: THREE.PointLight[] = [];
  root.traverse(o => { if (o instanceof THREE.PointLight) out.push(o); });
  return out;
}

/**
 * 岛的轮廓：以所有地块（和广场）角点的「支撑函数」为基础外扩，再叠加低频噪声。
 * 宫殿越多、摆得越开，岛就越大；同一个种子的海岸线形状稳定。
 */
function islandRadial(ext: Rect, lots: Rect[], seed: number, c: Vec2, margin: number, minR: number) {
  const N = 180;
  const corners: Vec2[] = [];
  for (const r of [...lots, ext]) corners.push([r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]);
  const circle = PLAZA_R + 2;
  const base = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    let h = -c[0] * ux - c[1] * uz + circle;
    for (const [x, z] of corners) h = Math.max(h, (x - c[0]) * ux + (z - c[1]) * uz);
    base[i] = Math.max(h + margin, minR);
  }
  // 平滑支撑函数的折角
  const smooth = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0, w = 0;
    for (let k = -6; k <= 6; k++) { const wk = 7 - Math.abs(k); s += base[(i + k + N) % N] * wk; w += wk; }
    smooth[i] = Math.max(base[i], s / w);
  }
  const p1 = seed * .37 % 6.28, p2 = seed * .71 % 6.28, p3 = seed * 1.13 % 6.28;
  return (a: number) => {
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const f = a / (Math.PI * 2) * N, i = Math.floor(f) % N, t = f - Math.floor(f);
    const b = smooth[i] * (1 - t) + smooth[(i + 1) % N] * t;
    return b * (1 + .045 * Math.sin(3 * a + p1) + .03 * Math.sin(5 * a + p2) + .018 * Math.sin(9 * a + p3));
  };
}

function mergeBoxes(geos: THREE.BufferGeometry[]) {
  const nonIdx = geos.map(g => { const n = g.toNonIndexed(); g.dispose(); return n; });
  let count = 0;
  for (const g of nonIdx) count += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = nonIdx[0].attributes[name].itemSize;
    const arr = new Float32Array(count * size);
    let off = 0;
    for (const g of nonIdx) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  nonIdx.forEach(g => g.dispose());
  out.computeBoundingSphere();
  return out;
}
