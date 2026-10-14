import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Kit } from '../kit';
import type { Catalog } from '../catalog';
import type { Rect, Vec2 } from '../schema';
import type { WorldRegion } from '../world';
import type { RoadNet } from '../roads';
import { PLAZA_R } from '../world';
import { seedFromString, rand, rr } from '../random';

/* =====================================================================
 * 场景主题（ThemePack）：一座岛「长什么样」全部由主题决定——
 * 地形（海岸 / 地面 / 岛底）、广场铺装、道路旁 / 岸边的摆设…
 * 宫殿本身不受主题影响。这里是各主题共用的类型和小工具。
 *
 * 岛上的摆设（树、石头、长椅……）不在这里建几何：主题的 props(ctx, place) 只决定摆什么、
 * 摆在哪、参数是什么，几何在 props.ts 里按 kind 建（这样摆件才能单独移动 / 存盘）。
 * 所有坐标都是区域局部坐标（广场中心为原点，草地顶面 y = GRASS_Y）。
 * ===================================================================== */

export const GRASS_Y = -.15;
export const WATER_Y = -1;
export const DEG = Math.PI / 180;

export type Mats = Record<string, THREE.Material>;
export interface Landmark { kind: string; x: number; z: number; angle: number }

/** 树叶材质名（顺序固定）：摆设的参数里只存序号，props.ts 按这里的名字取材质 */
export const LEAF_NAMES = ['leaf', 'leafLight', 'leafDark', 'leafOlive'] as const;
export type LeafName = typeof LEAF_NAMES[number];
/** 树叶序号的具名常量：摆放时写 LEAF.leafDark 这样的写法，存进 params 的是序号 */
export const LEAF = Object.fromEntries(LEAF_NAMES.map((n, i) => [n, i])) as Record<LeafName, number>;

export interface ThemeCtx {
  K: Kit;
  catalog: Catalog;
  region: WorldRegion;
  mats: Mats;
  /** 直接加入场景的网格（地形、道路） */
  land: THREE.Group;
  /** 装饰物：生成完后按材质合并 */
  raw: THREE.Group;
  /** 海面在区域局部坐标里的高度（浮空岛是很低的负数） */
  seaY: number;
  /** 岛的轮廓：以 center 为圆心、角度 a 方向上的半径 */
  R(a: number): number;
  center: Vec2;
  maxR: number;
  lots: Rect[];
  roads: RoadNet | null;
  /** 已被地标占用的圆形区域（树木、灌木会避开） */
  blockers: { x: number; z: number; r: number }[];
  landmarks: Landmark[];
}

/** 摆一个摆设：只决定「什么 kind、在哪、朝哪边、参数是什么」，几何见 props.ts */
export type PropPlace = (kind: string, x: number, z: number, opts?: { rot?: number; params?: Record<string, unknown> }) => void;

export interface ThemePack {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** 选择器里的配色预览：[地面, 海岸, 点缀] */
  colors: [string, string, string];
  /** 岛整体抬高（浮空岛） */
  lift?: number;
  /** 岛轮廓在宫殿占地外扩的距离、最小半径 */
  margin?: number;
  minR?: number;
  /** 屋顶积雪 */
  roofSnow?: boolean;
  materials(K: Kit): Mats;
  terrain(ctx: ThemeCtx): void;
  /** 广场铺装（生几何，不随摆设移动） */
  plaza(ctx: ThemeCtx): void;
  /** 岛上的摆设：决定摆什么、摆在哪（同一份代码喂程序化和烘焙两条路） */
  props(ctx: ThemeCtx, place: PropPlace): void;
  /** 兼容旧渲染器：等价于 props() 里立刻建几何的那条路；渲染层改成走 region.props 后删掉 */
  decorate(ctx: ThemeCtx): void;
}

// =====================================================================
// 几何小工具
// =====================================================================

export function outline(ctx: ThemeCtx, off: number, n = 180): Vec2[] {
  const [cx, cz] = ctx.center, out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, r = ctx.R(a) + off;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

export function shapeOf(points: Vec2[]) {
  // 轮廓已经足够平滑（径向函数密集采样），直接连成多边形；形状在 XY 平面，旋转到地面后 y → -z
  return new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
}

export function addLand(ctx: ThemeCtx, m: THREE.Mesh, cast = false) {
  m.castShadow = cast; m.receiveShadow = true;
  ctx.land.add(m);
  return m;
}

/**
 * 一层地面：顶面按极坐标细分成网格（从岛心到轮廓一圈圈），外缘一圈斜边 + 竖直的侧壁。
 * 细分是为了星球模式：顶点足够密，卷成球面时地面才不会穿到建筑下面。
 */
export function extrudeLand(ctx: ThemeCtx, pts: Vec2[], top: number, depth: number, mats: THREE.Material[], bevel = .6) {
  const topGeo = polarTop(ctx.center, pts, top);
  const sideGeo = landSide(ctx.center, pts, top, top - depth - (bevel > 0 ? .12 : 0), bevel);
  const geo = mergeGeometries([topGeo, sideGeo], true);
  topGeo.dispose(); sideGeo.dispose();
  return addLand(ctx, new THREE.Mesh(geo, mats), true);
}

/** 平铺在水面上的一片（浅滩） */
export function flatPatch(ctx: ThemeCtx, pts: Vec2[], y: number, mat: THREE.Material) {
  return addLand(ctx, new THREE.Mesh(polarTop(ctx.center, pts, y), mat));
}

const RINGS = [0, .12, .24, .36, .48, .6, .7, .79, .87, .93, .97, 1];

/** 极坐标细分的顶面；uv 用米为单位（和原来的形状挤出一致，贴图平铺不变） */
export function polarTop(c: Vec2, pts: Vec2[], y: number) {
  const [cx, cz] = c, n = pts.length;
  const pos: number[] = [cx, y, cz], uv: number[] = [cx, -cz], idx: number[] = [];
  for (let r = 1; r < RINGS.length; r++) {
    const t = RINGS[r];
    for (const [px, pz] of pts) {
      const x = cx + (px - cx) * t, z = cz + (pz - cz) * t;
      pos.push(x, y, z); uv.push(x, -z);
    }
  }
  const v = (r: number, i: number) => 1 + (r - 1) * n + (i % n);
  for (let i = 0; i < n; i++) idx.push(0, v(1, i + 1), v(1, i));
  for (let r = 1; r + 1 < RINGS.length; r++) {
    for (let i = 0; i < n; i++) {
      const a = v(r, i), b = v(r, i + 1), cc = v(r + 1, i), d = v(r + 1, i + 1);
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 外缘：轮廓 → 向外 bevel 米、下沉 0.12 的斜边 → 竖直侧壁到 bottom */
function landSide(c: Vec2, pts: Vec2[], top: number, bottom: number, bevel: number) {
  const [cx, cz] = c, n = pts.length;
  const rows: [number, number][][] = [];
  const push = (off: number) => pts.map(([x, z]) => {
    const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
    return [x + dx / l * off, z + dz / l * off] as [number, number];
  });
  const ys: number[] = [];
  rows.push(pts); ys.push(top);
  if (bevel > 0) { rows.push(push(bevel)); ys.push(top - .12); }
  rows.push(push(Math.max(bevel, 0))); ys.push(bottom);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let arc = 0;
  const arcs = pts.map((p, i) => { if (i) arc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]); return arc; });
  rows.forEach((row, r) => row.forEach(([x, z], i) => { pos.push(x, ys[r], z); uv.push(arcs[i], ys[r]); }));
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + (i + 1) % n, cc = (r + 1) * n + i, d = (r + 1) * n + (i + 1) % n;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function onLand(ctx: ThemeCtx, x: number, z: number, pad = 0) {
  const [cx, cz] = ctx.center;
  return Math.hypot(x - cx, z - cz) < ctx.R(Math.atan2(z - cz, x - cx)) - pad;
}

export function nearLot(ctx: ThemeCtx, x: number, z: number, pad: number) {
  return ctx.lots.some(r => x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad);
}

export function blocked(ctx: ThemeCtx, x: number, z: number, pad = 0) {
  return ctx.blockers.some(b => Math.hypot(x - b.x, z - b.z) < b.r + pad);
}

/** 可以种树 / 摆装饰的空地 */
export function free(ctx: ThemeCtx, x: number, z: number, pad: number, edge = 3.2) {
  return onLand(ctx, x, z, edge) && !nearLot(ctx, x, z, pad) && !ctx.roads?.onRoad(x, z, 1.1) && !blocked(ctx, x, z);
}

/** 沿海岸找一个地标的位置：从 angle 开始左右交替搜索，避开宫殿、道路、广场 */
export function edgeSpot(ctx: ThemeCtx, angleDeg: number, inset: number, clear: number) {
  const [cx, cz] = ctx.center;
  for (let k = 0; k < 36; k++) {
    const a = angleDeg * DEG + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 10 * DEG;
    const r = ctx.R(a) - inset;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (!nearLot(ctx, x, z, clear) && !ctx.roads?.onRoad(x, z, 1.5) && Math.hypot(x, z) > PLAZA_R + clear && !blocked(ctx, x, z, clear)) return { x, z, a, r };
  }
  return null;
}

/** 在岛内部找一块空地（例如池塘）：按种子在抖动网格上挑 */
export function innerSpot(ctx: ThemeCtx, radius: number, key: string) {
  const [cx, cz] = ctx.center;
  seedFromString(key + ctx.region.seed);
  for (let i = 0; i < 200; i++) {
    const a = rand() * Math.PI * 2, r = rr(.3, .8) * ctx.maxR;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (onLand(ctx, x, z, radius + 3) && !nearLot(ctx, x, z, radius + 1.5) && !ctx.roads?.onRoad(x, z, radius + 1) && !blocked(ctx, x, z, radius + 1) && Math.hypot(x, z) > PLAZA_R + radius + 2) return { x, z };
  }
  return null;
}

// =====================================================================
// 共用的装饰
// =====================================================================

export function commonMats(K: Kit): Mats {
  const std = (color: string, roughness = .9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
  return {
    stone: std('#d9d2c6', .8),
    paverDark: std('#d6c7b1', .95),
    fountain: std('#9fd6dc', .08, { metalness: .1 }),
    wood: std('#9a7253', .8),
    woodDark: std('#6e4d36', .8),
    hull: std('#f3efe6', .6, { side: THREE.DoubleSide }),
    red: std('#c4553d', .6),
    white: std('#f6f1e8', .6),
    dark: std('#3b3733', .5),
    rock: std('#a39a8d', .95, { flatShading: true }),
    pine: std('#44694f', .85, { flatShading: true }),
    pineLight: std('#5a7f55', .85, { flatShading: true }),
    snowCap: std('#f5f8fb', .7, { flatShading: true }),
  };
}

/** 广场地面铺装：已升级为纯净自然地面，不再硬编码不可移动的预渲染铺装圆盘 */
export function plazaBase(_ctx: ThemeCtx) {
  // 原硬编码的 plazaBase 铺装圆盘已移除，使中心成为纯净自然地面；
  // 用户可随时在岛中心自由摆放或移动喷泉、长椅、绿植等模型。
}

/** 广场四周的长椅和花槽（只决定位置，几何见 props.ts 的 bench / planter） */
export function plazaBenches(place: PropPlace, planters = true) {
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    place('bench', Math.sin(a) * 4.4, Math.cos(a) * 4.4, { rot: a + Math.PI, params: { w: 1.6 } });
    if (!planters) continue;
    const pa = a + Math.PI / 4;
    place('planter', Math.sin(pa) * 5.1, Math.cos(pa) * 5.1, { rot: pa, params: { w: 1.2 } });
  }
}

/** 路灯：沿路每隔一段放一盏 */
export function lampPosts(ctx: ThemeCtx, place: PropPlace, max = 8) {
  const net = ctx.roads;
  if (!net) return;
  const ok = (x: number, z: number) => !nearLot(ctx, x, z, .3) && !net.onRoad(x, z, .25) && Math.hypot(x, z) > PLAZA_R + .6 && !blocked(ctx, x, z);
  const spots: Vec2[] = [];
  const runs = [...net.runs].sort((a, b) => b.width - a.width);
  for (const r of runs) {
    let acc = 4;
    for (let i = 0; i + 1 < r.pts.length && spots.length < max; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / (len || 1), uz = (bz - az) / (len || 1);
      for (let t = acc; t < len; t += 13) {
        const off = r.width / 2 + .45;
        const x = ax + ux * t - uz * off, z = az + uz * t + ux * off;
        if (ok(x, z) && spots.every(([px, pz]) => Math.hypot(px - x, pz - z) > 9)) spots.push([x, z]);
        acc = t + 13 - len;
      }
      if (acc < 0) acc = 4;
    }
  }
  for (const [x, z] of spots) place('lamp', x, z);
}

// =====================================================================
// 自然撒点：树 / 灌木 / 石头……
//
// 不是均匀网格：每个候选点看三张噪声（大块成簇 / 中频疏密 / 细碎抖动）和一张「空地」噪声，
// 所以有的地方密、有的地方整片空着、有的地方两棵挨在一起。
// 逐格的判断只看它自己的格号（用独立哈希，不碰共享随机流），所以扩岛时新长出来的格子
// 不会把已有的树挤走——同一座岛、同一个 key 永远得到同一批点。
// =====================================================================

/** 一个候选点：位置 + 这一格的簇噪声 + 稳定种子串 */
export interface PlantSpot {
  x: number;
  z: number;
  /** 低频簇噪声（约 -3..3）：负 = 林间空地，正 = 密林 */
  cluster: number;
  /** 这一格的稳定种子：抽这一棵的细节前先 seedFromString(spot.key) */
  key: string;
  i: number;
  j: number;
}

/** 撒点参数（free 之外都由主题配方给，见 PLANT_RECIPES） */
export interface ScatterOpts {
  key: string;
  spacing: number;
  max: number;
  keep(cluster: number): number;
  /** 这个位置摆不摆得下（草地边界 / 宫殿地块 / 道路 / 阻挡 / 已有的摆设） */
  free(x: number, z: number): boolean;
  center: Vec2;
  maxR: number;
  /**
   * 每个格子再细分成 sub×sub 个候选点（保留概率按面积摊薄，总疏密不变）。
   * 给「扩岛补种」用：新长出来的陆地是一条窄边，按整格抽点抽不到几个；细分成子格以后
   * 同一个疏密场里能抽到足够多的点，而且落点和生成时的那一套格子不重合（不会压到已有的树上）。
   */
  sub?: number;
}

/** 字符串命名空间 → 32 位整数（同一串只算一次） */
const keyHashes: Record<string, number> = Object.create(null);
function keyHash(key: string) {
  const cached = keyHashes[key];
  if (cached !== undefined) return cached;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h = h >>> 0;
  keyHashes[key] = h;
  return h;
}

/** 格号 + 命名空间 → 0..1 的稳定哈希（不碰共享随机流：撒点的判断不能互相干扰） */
function cell01(key: string, i: number, j: number, salt: number) {
  let h = keyHash(key) ^ Math.imul(salt + 1, 0x9E3779B1);
  h = Math.imul(h ^ (i | 0), 0x85EBCA6B); h ^= h >>> 13;
  h = Math.imul(h ^ (j | 0), 0xC2B2AE35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 格坐标上的值噪声：freq 是「几格一个起伏」（越小越大块） */
function lattice(key: string, i: number, j: number, freq: number, salt: number) {
  const x = i / freq, z = j / freq;
  const i0 = Math.floor(x), j0 = Math.floor(z);
  const tx = x - i0, tz = z - j0;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = cell01(key, i0, j0, salt), b = cell01(key, i0 + 1, j0, salt);
  const c = cell01(key, i0, j0 + 1, salt), d = cell01(key, i0 + 1, j0 + 1, salt);
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

/**
 * 撒出一批「自然」的候选点：格子里随机落点 + 细碎噪声推开 + 邻近去重（密的格子互相让掉一棵），
 * 再加上大块的空地噪声，所以会出现成片的树林和整片的空地。
 */
export function scatterSpots(seedN: number, o: ScatterOpts): PlantSpot[] {
  const sub = Math.max(1, Math.round(o.sub ?? 1));
  const S = o.spacing / sub, ns = `${o.key}:${seedN}`;
  const n0 = Math.floor((o.center[0] - o.maxR) / S) - sub, n1 = Math.ceil((o.center[0] + o.maxR) / S) + sub;
  const m0 = Math.floor((o.center[1] - o.maxR) / S) - sub, m1 = Math.ceil((o.center[1] + o.maxR) / S) + sub;
  const cache: Record<number, PlantSpot | null> = Object.create(null);
  const at = (i: number, j: number): PlantSpot | null => {
    const slot = (i - n0) * (m1 - m0 + 4) + (j - m0);
    const hit = cache[slot];
    if (hit !== undefined) return hit;
    // 疏密场按「整格」采样（子格索引除以 sub），所以细分不会改变树林 / 空地的尺度
    const ci = i / sub, cj = j / sub;
    // 成簇：三张不同频率的噪声叠起来（越大块越明显）
    const cluster = (lattice(ns, ci, cj, 26, 1) - .5) * 3.4
      + (lattice(ns, ci, cj, 9, 2) - .5) * 2.2
      + (lattice(ns, ci, cj, 3, 3) - .5) * 1.1;
    // 空地：另一张更稀疏的噪声，低的地方整片几乎不长东西（林间空地 / 石滩）
    const patch = (lattice(ns, ci, cj, 7, 4) - .5) * 2;
    const field = .1 + 1.05 * Math.max(0, Math.min(1, (patch + .3) / .75));
    const p = Math.max(0, Math.min(1, o.keep(cluster) * field)) / (sub * sub);
    let spot: PlantSpot | null = null;
    if (cell01(ns, i, j, 5) < p) {
      const x = (i + .08 + .84 * cell01(ns, i, j, 6)) * S + (lattice(ns, ci, cj, 1.6, 7) - .5) * S * .5;
      const z = (j + .08 + .84 * cell01(ns, i, j, 8)) * S + (lattice(ns, ci, cj, 1.6, 9) - .5) * S * .5;
      spot = { x, z, cluster, key: `${ns}:${i}:${j}`, i, j };
    }
    cache[slot] = spot;
    return spot;
  };
  const kept: { spot: PlantSpot; pri: number }[] = [];
  const r2 = (S * .62) ** 2;
  for (let j = m0; j <= m1; j++) for (let i = n0; i <= n1; i++) {
    const spot = at(i, j);
    if (!spot || !o.free(spot.x, spot.z)) continue;
    const pri = cell01(ns, i, j, 10);
    // 邻近去重：紧挨着的两棵只留优先级高的那棵（密林里自然稀疏，空地不受影响）
    let dup = false;
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]] as [number, number][]) {
      const other = at(i + di, j + dj);
      if (!other) continue;
      if ((other.x - spot.x) ** 2 + (other.z - spot.z) ** 2 >= r2) continue;
      if (cell01(ns, i + di, j + dj, 10) > pri) { dup = true; break; }
    }
    if (!dup) kept.push({ spot, pri });
  }
  // 超过上限时按优先级丢，而不是砍掉某一个方向（不然远处会出现整片空地）
  if (kept.length > o.max) {
    kept.sort((a, b) => b.pri - a.pri);
    kept.length = o.max;
  }
  return kept.map(k => k.spot).sort((a, b) => (a.i - b.i) || (a.j - b.j));
}

/**
 * 在岛上撒点（树木等）：place 回调负责摆这一棵（见 plantAt）。
 * 细节用共享随机流抽，所以回调开始前先按这一格的种子定位（同一座岛每次都一样）。
 */
export function scatter(ctx: ThemeCtx, opts: Omit<ScatterOpts, 'center' | 'maxR' | 'free'> & { pad: number; edge?: number; free?(x: number, z: number): boolean; place(x: number, z: number, spot: PlantSpot): void }) {
  const spots = scatterSpots(ctx.region.seed, {
    key: opts.key, spacing: opts.spacing, max: opts.max, keep: opts.keep, sub: opts.sub,
    free: opts.free || ((x, z) => free(ctx, x, z, opts.pad, opts.edge)),
    center: ctx.center, maxR: ctx.maxR,
  });
  for (const spot of spots) {
    seedFromString(spot.key);
    opts.place(spot.x, spot.z, spot);
  }
}

/**
 * 主题的自然植被配方：撒点参数 + 树种搭配。
 * 主题自己的 props() 和「扩岛补种」（town-controller 的 syncVegetation）用的是同一份配方，
 * 所以新扩出来的陆地上长出来的东西和原来的林子是一套。
 */
export interface PlantRecipe {
  key: string;
  spacing: number;
  max: number;
  pad: number;
  keep(cluster: number): number;
  /** 树种搭配：kind → 权重（数字大的更常见） */
  mix: [string, number][];
  /** 叶色候选（LEAF 序号） */
  tones: number[];
  /** 高度范围（米） */
  h: [number, number];
  /** 灌木大小范围 */
  shrub?: [number, number];
  /** 针叶树积雪 */
  snow?: boolean;
  /** boulder 用的材质名 */
  mat?: string;
}

export const PLANT_RECIPES: Record<string, PlantRecipe> = {
  island: {
    key: 'tree', spacing: 4.6, max: 160, pad: 2, keep: c => .68 + c * .24,
    mix: [['tree', 5], ['broadleaf', 3], ['palm', 2], ['shrub', 3]],
    tones: [LEAF.leaf, LEAF.leafLight, LEAF.leafDark, LEAF.leafOlive], h: [2.4, 4.6], shrub: [.35, .6],
  },
  forest: {
    key: 'forest', spacing: 3.6, max: 280, pad: 1.8, keep: c => 1.15 + c * .26,
    mix: [['conifer', 7], ['tree', 3], ['birch', 3], ['broadleaf', 2], ['dead-tree', .7], ['shrub', 2]],
    tones: [LEAF.leaf, LEAF.leafDark, LEAF.leafOlive, LEAF.leafLight], h: [2.8, 5.4], shrub: [.35, .55],
  },
  snow: {
    key: 'pine', spacing: 4, max: 220, pad: 1.8, keep: c => .95 + c * .24,
    mix: [['conifer', 10], ['dead-tree', 1.2], ['shrub', .8], ['boulder', 1.4]],
    tones: [LEAF.leafDark, LEAF.leafOlive], h: [2.8, 4.8], snow: true, shrub: [.35, .7], mat: 'floe',
  },
  sky: {
    key: 'sky-tree', spacing: 4.4, max: 150, pad: 2, keep: c => .82 + c * .24,
    mix: [['tree', 4], ['broadleaf', 3], ['birch', 2], ['blossom-tree', 2], ['palm', 1], ['shrub', 3]],
    tones: [LEAF.leafLight, LEAF.leaf, LEAF.leafOlive, LEAF.leafDark], h: [2.4, 3.8], shrub: [.35, .55],
  },
};

/** 自然植被的 kind：缩岛时要清理、扩岛时要补种的就是这些（人工摆设不会被自动清掉） */
export const PLANT_KINDS = ['tree', 'broadleaf', 'birch', 'palm', 'dead-tree', 'conifer', 'shrub', 'flower', 'reed', 'blossom-tree', 'boulder', 'snowdrift'] as const;

/** 按权重抽树种：掺一点低频簇噪声，所以同一片林子偏向同一个树种，不会一棵一个样 */
function pickMix(mix: [string, number][], cluster: number, r: number) {
  let total = 0;
  for (const [, w] of mix) total += w;
  const t = ((r * .72 + (cluster * .06 + .5) * .28) % 1 + 1) % 1 * total;
  let acc = 0;
  for (const [kind, w] of mix) { acc += w; if (t <= acc) return kind; }
  return mix[mix.length - 1][0];
}

/**
 * 按主题配方在 (x, z) 栽一棵：树种、高度、叶色、朝向、树冠 / 树干参数全部现抽。
 * 抽之前先按 spot.key 定位随机流，所以同一格永远是同一棵（烘焙前后、扩岛补种都一致）。
 * 返回实际落下的 kind。
 */
export function plantAt(place: PropPlace, spot: PlantSpot, themeId: string): string {
  const r = PLANT_RECIPES[themeId] || PLANT_RECIPES.island;
  seedFromString(spot.key);
  const kind = pickMix(r.mix, spot.cluster, rand());
  const leaf = r.tones[Math.floor(rand() * r.tones.length)] ?? LEAF.leaf;
  const h = rr(r.h[0], r.h[1]);
  const rot = rand() * Math.PI * 2;
  if (kind === 'conifer') {
    coniferAt(place, spot.x, spot.z, h, r.snow === true, leaf);
  } else if (kind === 'shrub') {
    shrubAt(place, spot.x, spot.z, rr(...(r.shrub || [.35, .55])), leaf, r.tones[(r.tones.indexOf(leaf) + 1) % r.tones.length]);
  } else if (kind === 'boulder') {
    const s = rr(.35, .8);
    place('boulder', spot.x, spot.z, { rot, params: { mat: r.mat || 'boulder', s, y: s * .3, sy: rr(.55, .7), rx: rr(0, 3), ry: rr(0, 3) } });
  } else if (kind === 'blossom-tree') {
    place('blossom-tree', spot.x, spot.z, { rot, params: { h, w: rr(.8, 1.4), lean: rr(0, .14), color: rand() < .75 ? 'blossom' : 'rose' } });
  } else {
    // 树：轮廓 / 树冠宽度 / 树干粗细 / 弯曲都掺随机，所以同一片林子里没有两棵一样
    place(kind, spot.x, spot.z, {
      rot,
      params: {
        h, leaf,
        w: rr(.78, 1.35),
        trunk: rr(.75, 1.3),
        shape: rand() < .42 ? 0 : rand() < .55 ? 1 : rand() < .5 ? 2 : 3,
        lean: rr(0, .22),
        fronds: 6 + Math.floor(rand() * 4),
        branches: 3 + Math.floor(rand() * 4),
      },
    });
  }
  return kind;
}

/** 按主题配方撒一整岛的植被（主题的 props() 用这个；扩岛补种走同一份配方） */
export function plantScatter(ctx: ThemeCtx, themeId: string, place: PropPlace) {
  const r = PLANT_RECIPES[themeId] || PLANT_RECIPES.island;
  scatter(ctx, {
    key: r.key, spacing: r.spacing, max: r.max, pad: r.pad, keep: r.keep,
    place: (_x, _z, spot) => { plantAt(place, spot, themeId); },
  });
}

/** 沿海岸一圈（往里 inset 米）按间距调用 place */
export function alongShore(ctx: ThemeCtx, key: string, every: number, inset: [number, number], place: (x: number, z: number, i: number, a: number) => void) {
  const [cx, cz] = ctx.center;
  let perim = 0;
  for (let i = 0; i < 64; i++) perim += ctx.R(i / 64 * Math.PI * 2) * Math.PI * 2 / 64;
  const n = Math.floor(perim / every);
  seedFromString(key + ':' + ctx.region.seed);
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + rr(-.02, .02);
    const r = ctx.R(a) - rr(inset[0], inset[1]);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (blocked(ctx, x, z, 1) || ctx.roads?.onRoad(x, z, 1)) { rand(); continue; }
    place(x, z, i, a);
  }
}

/** 海里的礁石 */
export function seaRocks(ctx: ThemeCtx, place: PropPlace, n: number, mat: string, dist: [number, number] = [2.2, 5.5]) {
  const [cx, cz] = ctx.center;
  seedFromString('rocks:' + ctx.region.seed);
  for (let i = 0; i < n; i++) {
    const a = rr(0, Math.PI * 2), r = ctx.R(a) + rr(dist[0], dist[1]);
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (blocked(ctx, x, z, 2)) continue;
    const s = rr(.5, 1.1), rx = rr(0, 3), ry = rr(0, 3);
    const extra = rand() < .6, dz = extra ? rr(-.5, .5) : 0;
    place('sea-rock', x, z, { params: { mat, s, rx, ry, extra, dz } });
  }
}

/** 灌木（摆放用）：团数 / 展开 / 两色叶子的细节都在这里抽，几何见 props.ts 的 shrub */
export function shrubAt(place: PropPlace, x: number, z: number, s: number, leafA: number, leafB: number) {
  const blobs = 2 + Math.floor(rand() * 3);
  const spread = rr(.7, 1.35);
  place('shrub', x, z, { params: { s, leafA, leafB, blobs, spread } });
}

/** 针叶树的叶色候选（顺序和 props.ts 里 conifer 的参数选项一致，改一边要改另一边） */
const CONIFER_TONES = ['pine', 'pineLight', 'leafDark', 'leafOlive'];

/** 针叶树（摆放用）：叶色 / 层数 / 树冠宽度都在这里抽，几何见 props.ts 的 conifer */
export function coniferAt(place: PropPlace, x: number, z: number, h: number, snow = false, tone?: number) {
  const i = tone ?? Math.floor(rand() * 2);
  const leaf = CONIFER_TONES[((i % CONIFER_TONES.length) + CONIFER_TONES.length) % CONIFER_TONES.length];
  const tiers = 3 + Math.floor(rand() * 2);
  const tier: number[] = [];
  for (let k = 0; k < tiers; k++) tier.push(rr(0, 1));
  place('conifer', x, z, { params: { h, snow, leaf, tier, tiers, spread: rr(.8, 1.25) } });
}

/** 按顶点随机扰动（低多边形岩石 / 山体） */
export function jitter(geo: THREE.BufferGeometry, amount: number, keepBottomY?: number) {
  const pos = geo.attributes.position;
  const key = (i: number) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  const offs = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    if (!offs.has(k)) offs.set(k, [rr(-amount, amount), rr(-amount, amount) * .6, rr(-amount, amount)]);
    const [dx, dy, dz] = offs.get(k)!;
    if (keepBottomY !== undefined && Math.abs(pos.getY(i) - keepBottomY) < 1e-3) pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i), pos.getZ(i) + dz);
    else pos.setXYZ(i, pos.getX(i) + dx, pos.getY(i) + dy, pos.getZ(i) + dz);
  }
  geo.computeVertexNormals();
  return geo;
}
