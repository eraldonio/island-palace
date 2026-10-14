import { describe, it, expect } from 'vitest';
import {
  PALACE_FORMAT, PALACE_VERSION, PALACE_COMPAT, MEDIA_PARAMS, normalizePalace, palaceMedia, gid,
  type PalaceDoc,
} from '../src/schema';
import { WORLD_FORMAT, WORLD_VERSION, normalizeWorld, createWorld } from '../src/world';
import { sha256Hex, sha256Js, mediaIdOf, MEDIA_ID } from '../src/hash';
// Vite 的 ?raw 导入（读源码文本）
import catalogSource from '../src/catalog.ts?raw';

const BLOCK = '20260101000000-aaaaaaa';

/** 上游插件保存的数据里的一条物件 */
interface RawItem {
  id: string;
  type: string;
  pos: number[];
  params?: Record<string, string>;
  /** 6 版以前的绑定的笔记块 */
  bindings?: Record<string, { blockId: string; title?: string }>;
  /** 规范化时原样保留的不认识字段 */
  glow?: boolean;
}

/** 一份 v3 数据（与上游插件保存的格式一致） */
interface RawDoc {
  format: string;
  version: number;
  compat?: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  src?: string;
  weather?: string;
  rooms: unknown[];
  walls: unknown[];
  items: RawItem[];
}

function v3Doc(): RawDoc {
  return {
    format: PALACE_FORMAT, version: 3, id: 'palace-a', name: '宫殿', createdAt: 1, updatedAt: 2,
    rooms: [{ id: 'r1', name: '客厅', rect: [0, 0, 5, 4], floor: 'oak' }], walls: [],
    items: [{ id: 'sofa-1', type: 'sofa', pos: [1, 0, 1], bindings: { '': { blockId: BLOCK, title: 'A' } } }],
  };
}

describe('版本兼容（compat）', () => {
  it('v3 → v6：版本和 compat 升到当前，笔记相关字段被去掉', () => {
    const d = normalizePalace(v3Doc());
    expect(d.version).toBe(PALACE_VERSION);
    expect(d.compat).toBe(PALACE_COMPAT);
    expect('src' in d).toBe(false);
    expect('bindings' in d.items[0]).toBe(false);
  });

  it('更高版本但声明兼容的数据：能打开，版本号和不认识的字段原样保留', () => {
    const raw: RawDoc = { ...v3Doc(), version: PALACE_VERSION + 3, compat: PALACE_COMPAT, weather: 'rain' };
    raw.items[0].glow = true;
    // 规范化后读回来还要看类型里没有的字段（不认识的字段原样保留）
    const d = normalizePalace(raw) as PalaceDoc & RawDoc;
    expect(d.version).toBe(PALACE_VERSION + 3);
    expect(d.compat).toBe(PALACE_COMPAT);
    expect(d.weather).toBe('rain');
    expect(d.items[0].glow).toBe(true);
  });

  it('要求更高版本的数据：报错提示升级', () => {
    expect(() => normalizePalace({ ...v3Doc(), version: PALACE_VERSION + 1, compat: PALACE_VERSION + 1 })).toThrow(/升级插件/);
    // 旧数据没有 compat：按 version 判断
    expect(() => normalizePalace({ ...v3Doc(), version: PALACE_VERSION + 1 })).toThrow(/升级插件/);
  });

  it('世界数据同样按 compat 判断', () => {
    const w = createWorld();
    expect(w.compat).toBe(1);
    expect(normalizeWorld({ ...w, version: WORLD_VERSION + 2, compat: 1 }).version).toBe(WORLD_VERSION + 2);
    expect(() => normalizeWorld({ ...w, version: WORLD_VERSION + 1, compat: WORLD_VERSION + 1 })).toThrow(/升级插件/);
    const old = normalizeWorld({ format: WORLD_FORMAT, version: 1, id: 'w', name: 'w', createdAt: 0, updatedAt: 0, regions: [] });
    expect(old.compat).toBe(1);
    expect(old.regions.length).toBe(1);
  });
});

describe('全局 id', () => {
  it('gid：前缀 + 16 位随机，不重复', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => gid('palace-')));
    expect(ids.size).toBe(2000);
    for (const id of [...ids].slice(0, 20)) expect(id).toMatch(/^palace-[0-9a-z]{16}$/);
  });
});

describe('内容哈希', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('SHA-256 标准向量（纯 JS 和 crypto.subtle 一致）', async () => {
    const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sha256Js(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Js(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // 跨过 64 字节分块边界（55 / 56 / 64 字节）
    for (const n of [55, 56, 63, 64, 65, 1000]) {
      const data = enc('x'.repeat(n));
      expect(hex(sha256Js(data))).toBe(await sha256Hex(data));
    }
    expect(await sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('媒体 id：同内容同 id，扩展名规范化', async () => {
    const a = await mediaIdOf(new Blob([enc('photo')]), 'WebP');
    const b = await mediaIdOf(enc('photo'), 'webp');
    expect(a).toBe(b);
    expect(a).toMatch(MEDIA_ID);
    expect(await mediaIdOf(enc('photo2'), 'webp')).not.toBe(a);
    expect(await mediaIdOf(enc('x'), '.g/lb')).toMatch(/\.glb$/);
  });
});

describe('媒体引用', () => {
  it('MEDIA_PARAMS 覆盖目录里所有照片 / 模型参数', () => {
    const src: string = catalogSource;
    const found: Record<string, string[]> = {};
    for (const line of src.split('\n')) {
      const t = line.match(/^\s+(\w+): E\(/)?.[1];
      if (!t) continue;
      for (const m of line.matchAll(/\{ key: '(\w+)', label: '[^']*', kind: '(photo|model)' \}/g)) (found[t] ||= []).push(m[1]);
    }
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(MEDIA_PARAMS);
  });

  it('palaceMedia：照片、模型，去重', () => {
    const d = normalizePalace({
      ...v3Doc(), items: [
        { id: 'p1', type: 'painting', pos: [0, 0, 0], params: { photo: 'a.webp' } },
        { id: 'p2', type: 'photoFrame', pos: [0, 0, 0], params: { photo: 'a.webp' } },
        { id: 'm', type: 'model', pos: [0, 0, 0], params: { src: 'm.glb' } },
        { id: 's', type: 'sofa', pos: [0, 0, 0], params: { src: 'not-media' } },
      ],
    });
    expect(palaceMedia(d).sort()).toEqual(['a.webp', 'm.glb']);
  });
});
