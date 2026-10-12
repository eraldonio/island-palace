/* =====================================================================
 * 宫殿数据格式（与宿主无关）
 * 单位：米。平面坐标 x 向东、z 向南，y 向上。旋转角度单位：度（绕 y 轴）。
 * 物件构建函数以「底部中心为原点、正面朝 +z」建模。
 * ===================================================================== */

import { materializeDecor } from './decor';
import { t } from './i18n';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Rect = [number, number, number, number]; // x0, z0, x1, z1

/** 磁盘上的格式标识：沿用上游的字符串，这样旧版写出的宫殿文件仍然认得出来 */
export const PALACE_FORMAT = 'kmind-palace';
/**
 * 数据版本。读到更高版本时拒绝加载（提示升级），读到低版本时在 normalizePalace 里逐级迁移。
 *   1  初版
 *   2  物件可以挂在父物件上（parent，pos / rot 相对父物件）
 *   3  家具默认的摆件（茶几上的书、餐桌上的花瓶……）变成真正的子物件，家具标 params.decor = false
 *   4  compat（最低可读版本）；媒体 id 改为内容哈希
 *   5  数字组 numbers（数字记忆）；只是新增可选字段，compat 仍为 4
 *   6  删除笔记相关的字段：笔记来源 src、记忆路线 routes、数字组 numbers、物件上的绑定 bindings
 *
 * 兼容规则：读取时只看 compat（旧数据没有 compat 时看 version）。
 * 只新增可选字段的改动只提高 PALACE_VERSION；会让旧版本读错的改动才提高 PALACE_COMPAT。
 * 6 只是去掉上游写的可选字段，旧版本照样读得懂，所以 compat 仍是 4。
 */
export const PALACE_VERSION = 6;
/** 读取本版本写出的数据，至少需要的版本 */
export const PALACE_COMPAT = 4;

export type FloorKind = 'oak' | 'oakWarm' | 'deck' | 'tileLarge' | 'tileBath' | 'cement';

export interface PalaceRoom {
  id: string;
  name: string;
  en?: string;
  rect: Rect;
  /** 地面材质；不填则不铺地面（例如庭院） */
  floor?: FloorKind;
  /** 房间名标签位置（平面坐标）；null 表示不显示标签 */
  label?: Vec2 | null;
  /** 室外区域：漫游时不加天花板 */
  outdoor?: boolean;
}

export interface WallOpening {
  /** 沿墙方向的起止坐标（x 向墙用 x，z 向墙用 z） */
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  kind: 'window' | 'door' | 'front' | 'slide';
  /** 门的开启方向：+1 / -1（沿墙的法线方向） */
  swing?: 1 | -1;
  curtain?: boolean;
  curtainColor?: string;
}

export interface WallPaint {
  /** 刷在墙的哪一侧：+1 = +z/+x 一侧，-1 = 另一侧 */
  side: 1 | -1;
  s0: number;
  s1: number;
  y0?: number;
  y1?: number;
  color?: string;
  texture?: 'subway' | 'bathWall';
  /** 贴图平铺尺寸（米） */
  tile?: number;
}

export interface PalaceWall {
  id: string;
  a: Vec2;
  b: Vec2;
  thickness?: number;
  /** 外墙朝外的法线；内墙不填 */
  normal?: Vec2;
  openings?: WallOpening[];
  paint?: WallPaint[];
}

export interface PalaceItem {
  id: string;
  /** 物件类型，对应 catalog 中的构建函数 */
  type: string;
  name?: string;
  /** 所在房间 id */
  room?: string;
  /** 父物件 id：放在另一件物件上（书架上的花瓶、茶几上的托盘），随父物件移动；pos / rot 是相对父物件的 */
  parent?: string;
  pos: Vec3;
  rot?: number;
  params?: Record<string, any>;
  /** 挂在哪面墙上（墙被剖切时随墙隐藏） */
  wall?: string;
  solid?: boolean;
  pickable?: boolean;
}

export interface PalaceGround {
  plinth: Rect;
  slabs: Rect[];
}

export interface PalaceDoc {
  format: typeof PALACE_FORMAT;
  version: number;
  /** 读取这份数据至少需要的版本 */
  compat?: number;
  id: string;
  name: string;
  /** 主题色（小镇里的名牌、屋顶）；不填则按 id 从调色板里取 */
  color?: string;
  createdAt: number;
  updatedAt: number;
  wallHeight?: number;
  ground?: PalaceGround;
  rooms: PalaceRoom[];
  walls: PalaceWall[];
  items: PalaceItem[];
}

/** 宫殿内唯一的 id（物件、房间、墙体） */
export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
/** 全局唯一的 id（宫殿、岛、世界）：16 位加密随机数 */
export function gid(prefix = '') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ID_CHARS[b % 36];
  return prefix + s;
}

/** 早期版本写在宫殿 / 物件上的笔记相关字段：迁移时按可选字段读出来删掉 */
interface LegacyNoteFields {
  src?: unknown;
  routes?: unknown;
  numbers?: unknown;
  binding?: unknown;
  bindings?: unknown;
}

/** 从版本 n 升到 n + 1 */
const MIGRATIONS: Record<number, (d: PalaceDoc) => void> = {
  2(d) {
    // 家具写死的摆件 → 子物件（旧版插件会把它们画两遍，所以要升版本）
    materializeDecor(d.items);
  },
  5(d) {
    // 笔记相关的字段都不再使用（笔记来源、记忆路线、数字组，以及单个 / 按部件的绑定）；
    // 这时数据还是刚从存储里读上来的 JSON，这些字段不在 PalaceDoc 里，按可选字段临时看一眼
    const old = d as PalaceDoc & LegacyNoteFields;
    delete old.src;
    delete old.routes;
    delete old.numbers;
    const items = old.items as (PalaceItem & LegacyNoteFields)[];
    for (const it of items) {
      delete it.binding;
      delete it.bindings;
    }
  },
};

/** 校验并规范化外部数据（返回新对象，不改动传入的数据）；低版本逐级迁移；无法识别时抛出错误 */
/** 数据是更新版本的插件写的（错误对象上的 code）：调用方据此提示升级，不靠匹配错误文字 */
export const NEWER_VERSION = 'kp-newer-version';

export function normalizePalace(raw: unknown): PalaceDoc {
  const src = raw as PalaceDoc;
  if (!src || typeof src !== 'object' || src.format !== PALACE_FORMAT) throw new Error(t('不是有效的宫殿数据'));
  const version = Number(src.version) || 1;
  // 旧数据没有 compat：按 version 判断
  const compat = Number(src.compat) || version;
  if (compat > PALACE_VERSION) throw Object.assign(new Error(t('这座宫殿需要更新版本的插件才能打开（数据要求 {need}，当前支持 {have}），请升级插件', { need: compat, have: PALACE_VERSION })), { code: NEWER_VERSION });
  const d: PalaceDoc = JSON.parse(JSON.stringify(src));
  d.rooms = Array.isArray(d.rooms) ? d.rooms : [];
  d.walls = Array.isArray(d.walls) ? d.walls : [];
  d.items = Array.isArray(d.items) ? d.items.filter(i => i && typeof i === 'object' && i.id && i.type && Array.isArray(i.pos)) : [];
  for (let v = version; v < PALACE_VERSION; v++) MIGRATIONS[v]?.(d);
  // 更新版本写的、但声明兼容的数据：原样保留它的版本号和不认识的字段
  d.version = Math.max(version, PALACE_VERSION);
  d.compat = Math.max(Number(src.compat) || 0, PALACE_COMPAT);
  repairTree(d.items);
  return d;
}

export function clonePalace(d: PalaceDoc): PalaceDoc {
  return JSON.parse(JSON.stringify(d));
}

/** 物件参数里引用媒体文件的键（照片、模型），按物件类型 */
export const MEDIA_PARAMS: Record<string, string[]> = { painting: ['photo'], photoFrame: ['photo'], model: ['src'], rug: ['photo'], poster: ['photo'], mediaConsole: ['photo'] };

/** 宫殿引用的全部媒体 id（物件的照片 / 模型），去重 */
export function palaceMedia(d: PalaceDoc): string[] {
  const out = new Set<string>();
  for (const it of d.items) {
    for (const k of MEDIA_PARAMS[it.type] || []) if (typeof it.params?.[k] === 'string' && it.params[k]) out.add(it.params[k]);
  }
  return [...out];
}

// =====================================================================
// 物件树：父物件 / 子物件
// 旋转只绕 y 轴；与 three.js 一致，rot = θ 时局部 (x, z) → 父坐标 (x cosθ + z sinθ, −x sinθ + z cosθ)
// =====================================================================

const DEG = Math.PI / 180;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** 角度归一到 (−180, 180]，取整到 1° */
export const normDeg = (d: number) => { const r = Math.round(((d % 360) + 540) % 360 - 180); return r === -180 ? 180 : r; };

function rotY(x: number, z: number, deg: number): [number, number] {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [x * c + z * s, -x * s + z * c];
}

function itemMap(items: PalaceItem[]) {
  return new Map(items.map(i => [i.id, i]));
}

/** 去掉指向不存在物件的 parent，并打断环（数据损坏或手工编辑时） */
export function repairTree(items: PalaceItem[]) {
  const byId = itemMap(items);
  for (const it of items) {
    if (it.parent !== undefined && (!it.parent || !byId.has(it.parent) || it.parent === it.id)) delete it.parent;
  }
  for (const it of items) {
    const seen = new Set<string>([it.id]);
    let p = it.parent && byId.get(it.parent);
    while (p) {
      if (seen.has(p.id)) { delete it.parent; break; }
      seen.add(p.id);
      p = p.parent && byId.get(p.parent);
    }
  }
}

export function childrenOf(items: PalaceItem[], id: string) {
  return items.filter(i => i.parent === id);
}

/** 物件自己 + 全部子孙（父在前） */
export function subtree(items: PalaceItem[], id: string): PalaceItem[] {
  const root = items.find(i => i.id === id);
  if (!root) return [];
  const out = [root];
  for (let k = 0; k < out.length; k++) out.push(...childrenOf(items, out[k].id));
  return out;
}

/** a 是否是 b 自己或 b 的子孙 */
export function isInSubtree(items: PalaceItem[], a: string, b: string) {
  const byId = itemMap(items);
  let p = byId.get(a);
  for (let guard = 0; p && guard < 1000; guard++) {
    if (p.id === b) return true;
    p = p.parent ? byId.get(p.parent) : undefined;
  }
  return false;
}

/** 物件在宫殿坐标系里的位置和朝向（沿父物件链换算） */
export function itemPose(items: PalaceItem[], item: PalaceItem): { pos: Vec3; rot: number } {
  const byId = itemMap(items);
  let [x, y, z] = item.pos, rot = item.rot || 0;
  let p = item.parent ? byId.get(item.parent) : undefined;
  for (let guard = 0; p && guard < 1000; guard++) {
    const [rx, rz] = rotY(x, z, p.rot || 0);
    x = rx + p.pos[0]; y += p.pos[1]; z = rz + p.pos[2];
    rot += p.rot || 0;
    p = p.parent ? byId.get(p.parent) : undefined;
  }
  return { pos: [x, y, z], rot: normDeg(rot) };
}

/**
 * 按宫殿坐标摆放物件，并挂到 parentId 下（null / undefined = 直接放在地面上）。
 * 存进数据的是相对父物件的局部坐标。父物件不能是自己或自己的子孙（返回 false，不做改动）。
 */
export function setItemPose(items: PalaceItem[], item: PalaceItem, pos: Vec3, rot: number, parentId?: string | null) {
  const parent = parentId ? items.find(i => i.id === parentId) : undefined;
  if (parentId && (!parent || isInSubtree(items, parentId, item.id))) return false;
  let [x, y, z] = pos, r = rot;
  if (parent) {
    const pp = itemPose(items, parent);
    [x, z] = rotY(x - pp.pos[0], z - pp.pos[2], -pp.rot);
    y -= pp.pos[1];
    r -= pp.rot;
    item.parent = parent.id;
  } else delete item.parent;
  item.pos = [round3(x), round3(y), round3(z)];
  item.rot = normDeg(r);
  return true;
}

/** 换父物件（或放回地面），保持物件在宫殿里的位置和朝向不变 */
export function setItemParent(items: PalaceItem[], item: PalaceItem, parentId: string | null) {
  const pose = itemPose(items, item);
  return setItemPose(items, item, pose.pos, pose.rot, parentId);
}
