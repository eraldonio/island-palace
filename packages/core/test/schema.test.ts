import { describe, it, expect } from 'vitest';
import { createHomePalace } from '../src/templates/home';
import {
  PALACE_FORMAT, PALACE_COMPAT, PALACE_VERSION, normalizePalace, clonePalace,
  itemPose, setItemPose, setItemParent, subtree, isInSubtree, repairTree,
  type PalaceDoc, type PalaceItem,
} from '../src/schema';

/** 旧版数据的样子：测试里按需要塞进各种后来的 / 被删掉的字段 */
interface RawDoc {
  format: string;
  version?: number;
  rooms: unknown;
  walls: unknown;
  items: unknown;
  [key: string]: unknown;
}

/** 一份 v1 数据（与旧版插件保存的格式一致，里面还带着后来删掉的笔记字段） */
function v1Doc(): RawDoc {
  return {
    format: PALACE_FORMAT, version: 1, id: 'palace-a', name: '旧宫殿', createdAt: 1, updatedAt: 2,
    rooms: [{ id: 'r1', name: '客厅', rect: [0, 0, 5, 4], floor: 'oak' }],
    walls: [],
    items: [
      { id: 'sofa-1', type: 'sofa', pos: [1, 0, 1], rot: 90, binding: { blockId: '20260101000000-aaaaaaa', title: '费曼学习法', boundAt: 5 } },
      { id: 'shelf-1', type: 'bookshelf', pos: [3, 0, .2], binding: null },
      { id: 'lamp-1', type: 'floorLamp', pos: [4, 0, 3] },
    ],
  };
}

const item = (id: string, pos: [number, number, number], rot = 0, parent?: string): PalaceItem => ({ id, type: 'box', pos, rot, ...(parent ? { parent } : {}) });

describe('normalizePalace / 迁移', () => {
  it('v1 数据能读：笔记字段被去掉，其余原样保留', () => {
    const d = normalizePalace(v1Doc());
    expect(d.version).toBe(PALACE_VERSION);
    const [sofa, shelf, lamp] = d.items;
    expect('binding' in sofa).toBe(false);
    expect('bindings' in sofa).toBe(false);
    expect('binding' in shelf).toBe(false);
    expect('bindings' in lamp).toBe(false);
    expect(sofa.pos).toEqual([1, 0, 1]);
    expect(sofa.rot).toBe(90);
    expect(d.rooms).toEqual(v1Doc().rooms);
  });

  it('上游 1–5 版的数据都读得进来，笔记相关字段被清掉', () => {
    for (const version of [1, 2, 3, 4, 5]) {
      const raw: RawDoc = {
        ...v1Doc(), version, compat: 4, src: 'siyuan',
        routes: [{ id: 'route-1', name: '期末复习', stops: ['sofa-1'] }],
        numbers: [{ id: 'nums-1', digits: '31415926', mode: 'pao', route: 'all' }],
        ground: { plinth: [0, 0, 5, 4], slabs: [[0, 0, 5, 4]] },
      };
      raw.items = [{ id: 'sofa-1', type: 'sofa', pos: [1, 0, 1], bindings: { '': { blockId: '20260101000000-aaaaaaa' } } }];
      const d = normalizePalace(raw);
      expect(d.version).toBe(PALACE_VERSION);
      expect(d.compat).toBe(PALACE_COMPAT);
      expect('src' in d).toBe(false);
      expect('routes' in d).toBe(false);
      expect('numbers' in d).toBe(false);
      expect('bindings' in d.items[0]).toBe(false);
      // 其余字段原样保留
      expect(d.id).toBe('palace-a');
      expect(d.name).toBe('旧宫殿');
      expect(d.rooms).toEqual(raw.rooms);
      expect(d.walls).toEqual(raw.walls);
      expect(d.ground).toEqual(raw.ground);
      expect(d.items[0].pos).toEqual([1, 0, 1]);
    }
  });

  it('不改动传入的数据', () => {
    const raw = v1Doc();
    const before = JSON.stringify(raw);
    normalizePalace(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('幂等：再规范化一次不变', () => {
    const once = normalizePalace(v1Doc());
    expect(normalizePalace(clonePalace(once))).toEqual(once);
  });

  it('没有 version 的数据按 v1 处理', () => {
    const raw = v1Doc();
    delete raw.version;
    expect(normalizePalace(raw).items[0].id).toBe('sofa-1');
  });

  it('拒绝更高版本和无法识别的数据', () => {
    expect(() => normalizePalace({ ...v1Doc(), version: PALACE_VERSION + 1 })).toThrow(/请升级插件/);
    expect(() => normalizePalace({ ...v1Doc(), format: 'other' })).toThrow();
    expect(() => normalizePalace(null)).toThrow();
  });

  it('清理：无效物件、悬空 parent、环', () => {
    const raw = v1Doc();
    raw.version = 2;
    raw.items = [
      { id: 'a', type: 'box', pos: [0, 0, 0], parent: 'ghost' },
      { id: 'b', type: 'box', pos: [0, 0, 0], parent: 'c' },
      { id: 'c', type: 'box', pos: [0, 0, 0], parent: 'b' },
      { id: 'd', type: 'box', pos: [0, 0, 0], parent: 'd' },
      { type: 'box', pos: [0, 0, 0] },
      null,
    ];
    const d = normalizePalace(raw);
    expect(d.items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(d.items[0].parent).toBeUndefined();
    // 环被打断：b、c 至少有一个不再有父物件，且不再互相指向
    const b = d.items[1], c = d.items[2];
    expect(!(b.parent === 'c' && c.parent === 'b')).toBe(true);
    expect(d.items[3].parent).toBeUndefined();
  });
});

describe('物件树', () => {
  const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));

  it('itemPose 沿父物件链换算（与 three.js 的 rotation.y 一致）', () => {
    const items = [
      item('table', [2, 0, 3], 90),
      item('tray', [.5, .45, 0], 0, 'table'),
      item('cup', [.1, .02, 0], 180, 'tray'),
    ];
    // rot 90：局部 +x → 父坐标 −z
    close(itemPose(items, items[1]).pos, [2, .45, 2.5]);
    close(itemPose(items, items[2]).pos, [2, .47, 2.4]);
    expect(itemPose(items, items[2]).rot).toBe(-90);
  });

  it('换父物件时保持在宫殿里的位置和朝向', () => {
    const items = [
      item('table', [2, 0, 3], 45),
      item('shelf', [-1, 0, 1], -90),
      item('vase', [2.3, .75, 3.1], 30),
    ];
    const vase = items[2];
    const before = itemPose(items, vase);
    expect(setItemParent(items, vase, 'table')).toBe(true);
    expect(vase.parent).toBe('table');
    close(itemPose(items, vase).pos, before.pos);
    expect(itemPose(items, vase).rot).toBe(before.rot);
    // 再换到另一个父物件、再放回地面
    setItemParent(items, vase, 'shelf');
    close(itemPose(items, vase).pos, before.pos);
    setItemParent(items, vase, null);
    expect(vase.parent).toBeUndefined();
    close(vase.pos, before.pos);
    expect(vase.rot).toBe(30);
  });

  it('不能挂到自己或自己的子孙上', () => {
    const items = [item('a', [0, 0, 0]), item('b', [0, 1, 0], 0, 'a'), item('c', [0, 1, 0], 0, 'b')];
    expect(setItemParent(items, items[0], 'c')).toBe(false);
    expect(setItemParent(items, items[0], 'a')).toBe(false);
    expect(items[0].parent).toBeUndefined();
    expect(isInSubtree(items, 'c', 'a')).toBe(true);
    expect(isInSubtree(items, 'a', 'c')).toBe(false);
  });

  it('subtree：父在前，包含全部子孙', () => {
    const items = [item('c', [0, 0, 0], 0, 'b'), item('a', [0, 0, 0]), item('b', [0, 0, 0], 0, 'a'), item('x', [0, 0, 0])];
    expect(subtree(items, 'a').map(i => i.id)).toEqual(['a', 'b', 'c']);
    expect(subtree(items, 'missing')).toEqual([]);
  });

  it('setItemPose 直接按宫殿坐标摆到父物件上', () => {
    const items = [item('t', [1, 0, 1], 90), item('v', [0, 0, 0])];
    setItemPose(items, items[1], [1, .7, 0], 90, 't');
    // 父物件转了 90°：宫殿里的 −z 方向就是它局部的 +x
    close(items[1].pos, [1, .7, 0]);
    close(itemPose(items, items[1]).pos, [1, .7, 0]);
    expect(items[1].rot).toBe(0);
  });

  it('repairTree 保留正常的父子关系', () => {
    const items = [item('a', [0, 0, 0]), item('b', [0, 0, 0], 0, 'a')];
    repairTree(items);
    expect(items[1].parent).toBe('a');
  });
});

describe('模板', () => {
  it('新建的宫殿是当前版本', () => {
    const d: PalaceDoc = createHomePalace();
    expect(d.version).toBe(PALACE_VERSION);
    expect(normalizePalace(d).items.length).toBe(d.items.length);
  });
});
