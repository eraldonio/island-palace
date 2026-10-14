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

/**
 * 在抖动网格上撒点（树木等）：同一个格子的位置由种子决定，岛变大时已有的树不会乱跳。
 * keep(cluster) 返回保留概率；cluster 是 -3..3 的低频噪声，用来让树成簇。
 * place 回调负责抽这一棵的随机细节（尺寸、色彩…），再交给 props.ts 的 place()。
 */
export function scatter(ctx: ThemeCtx, opts: { key: string; spacing: number; max: number; pad: number; edge?: number; keep(cluster: number): number; place(x: number, z: number, i: number): void }) {
  const S = opts.spacing, seedN = ctx.region.seed, [cx, cz] = ctx.center, R = ctx.maxR;
  const n0 = Math.floor((cx - R) / S), n1 = Math.ceil((cx + R) / S);
  const m0 = Math.floor((cz - R) / S), m1 = Math.ceil((cz + R) / S);
  let count = 0;
  for (let j = m0; j <= m1; j++) for (let i = n0; i <= n1; i++) {
    seedFromString(`${opts.key}:${seedN}:${i}:${j}`);
    const x = (i + rr(.15, .85)) * S, z = (j + rr(.15, .85)) * S;
    const cluster = Math.sin(x * .09 + seedN) + Math.cos(z * .11 - seedN * .7) + Math.sin((x + z) * .05);
    if (rand() >= opts.keep(cluster) || !free(ctx, x, z, opts.pad, opts.edge)) continue;
    if (count++ >= opts.max) return;
    opts.place(x, z, count);
  }
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

/** 灌木（摆放用）：随机细节在这里抽完，几何见 props.ts 的 shrub */
export function shrubAt(place: PropPlace, x: number, z: number, s: number, leafA: number, leafB: number) {
  const second = rand() < .5;
  const dx = second ? rr(-.5, .5) : 0, dz = second ? rr(-.5, .5) : 0;
  place('shrub', x, z, { params: { s, leafA, leafB, second, dx, dz } });
}

/** 针叶树（摆放用）：几何见 props.ts 的 conifer */
export function coniferAt(place: PropPlace, x: number, z: number, h: number, snow = false) {
  const leaf = rand() < .5 ? 'pine' : 'pineLight';
  const tier = [rr(0, 1), rr(0, 1), rr(0, 1)];
  place('conifer', x, z, { params: { h, snow, leaf, tier } });
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
