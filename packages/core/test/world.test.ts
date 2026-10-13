import { describe, it, expect } from 'vitest';
import * as W from '../src/world';
import { createFromTemplate } from '../src/templates/basic';
import type { PalaceDoc, Rect, Vec2 } from '../src/schema';

function docsMap(...docs: PalaceDoc[]) {
  return new Map(docs.map(d => [d.id, d]));
}

describe('世界：摆放', () => {
  it('syncWorld 给新宫殿找空地，互不重叠', () => {
    const a = createFromTemplate('cottage', 'A'), b = createFromTemplate('twoRooms', 'B'), c = createFromTemplate('gallery', 'C');
    const docs = docsMap(a, b, c);
    const world = W.createWorld();
    expect(W.syncWorld(world, docs)).toBe(true);
    const region = W.mainRegion(world);
    expect(region.palaces.map(p => p.palaceId).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const p of region.palaces) expect(W.canPlace(region, docs, p, docs.get(p.palaceId))).toBe(true);
    // 再同步一次没有改动
    expect(W.syncWorld(world, docs)).toBe(false);
  });

  it('settleRegions 把挤在一起的岛推开', () => {
    const a = createFromTemplate('cottage', 'A'), b = createFromTemplate('cottage', 'B');
    const docs = docsMap(a, b);
    const world = W.createWorld();
    world.regions = [W.createRegion('一', 'island'), W.createRegion('二', 'forest')];
    world.regions[0].palaces.push({ palaceId: a.id, pos: W.findFreeSpot(world.regions[0], docs, a), rot: 0 });
    world.regions[1].palaces.push({ palaceId: b.id, pos: W.findFreeSpot(world.regions[1], docs, b), rot: 0 });
    world.regions[1].origin = [5, 0];
    expect(W.settleRegions(world, docs)).toBe(true);
    const [c0, c1] = world.regions.map(r => W.regionCircle(r, docs));
    expect(Math.hypot(c1.x - c0.x, c1.z - c0.z)).toBeGreaterThanOrEqual(c0.r + c1.r + W.SEA_GAP - .5);
  });

  it('palaceStats 统计房间和物件', () => {
    const d = createFromTemplate('cottage', 'A');
    d.items.push({ id: 's', type: 'bookshelf', pos: [0, 0, 0] });
    const st = W.palaceStats(d);
    expect(st.items).toBe(d.items.length);
    expect(st.rooms).toBe(d.rooms.filter(r => r.floor).length);
  });

  it('上游世界数据里的旅程 / 数字编码表被清掉', () => {
    const raw: Record<string, unknown> = {
      ...W.createWorld(), version: 2,
      journeys: [{ id: 'j', name: '旅程', legs: [{ palaceId: 'a', routeId: 'auto' }] }],
      pao: { codes: { '00': { p: '人物', a: '动作', o: '物件' } } },
    };
    const out = W.normalizeWorld(raw);
    expect(out.version).toBe(W.WORLD_VERSION);
    expect(out.compat).toBe(W.WORLD_COMPAT);
    expect('journeys' in out).toBe(false);
    expect('pao' in out).toBe(false);
    // 其余字段原样保留
    expect(out.id).toBe(raw.id);
    expect(out.name).toBe(raw.name);
    expect(out.regions.length).toBe(1);
  });
});

describe('世界：岛上的摆设', () => {
  const base = () => {
    const w = W.createWorld();
    w.regions = [{ id: 'r', name: '岛', theme: 'island', seed: 7, origin: [0, 0], palaces: [] }];
    return w;
  };

  it('props 原样读写：顺序、位置、参数、朝向都保留', () => {
    const w = base();
    w.regions[0].props = [
      { id: 'a', kind: 'tree', pos: [1.25, -3], rot: 90, params: { h: 3, seed: 42 } },
      { id: 'b', kind: 'bench', pos: [2, 4] },
    ];
    const out = W.normalizeWorld(w);
    const props = out.regions[0].props!;
    expect(props.map(p => p.id)).toEqual(['a', 'b']);
    expect(props[0].pos).toEqual([1.25, -3]);
    expect(props[0].rot).toBe(90);
    expect(props[0].params).toEqual({ h: 3, seed: 42 });
    expect(props[1].rot).toBeUndefined();
  });

  it('坏掉的摆设条目被丢掉，其余保留', () => {
    const raw: unknown = {
      ...base(),
      regions: [{
        id: 'r', name: '岛', theme: 'island', seed: 7, origin: [0, 0], palaces: [],
        props: [
          { id: 'ok', kind: 'tree', pos: [1, 2] },
          { kind: '', pos: [1, 2] },          // kind 空
          { kind: 'tree' },                    // 没有 pos
          { kind: 'tree', pos: ['x', 2] },     // pos 不是数
          { kind: 'tree', pos: [NaN, 2] },     // pos 非有限
          { kind: 'tree', pos: [Infinity, 2] },
          'nope', null, [1, 2],                // 根本不是对象
          { id: 'ok2', kind: 'stone', pos: [3, 4], rot: 'x', params: [1, 2] },
        ],
      }],
    };
    const out = W.normalizeWorld(raw);
    const props = out.regions[0].props!;
    expect(props.map(p => p.id)).toEqual(['ok', 'ok2']);
    expect(props[1].rot).toBeUndefined();    // rot 不是数就丢掉
    expect(props[1].params).toBeUndefined(); // params 不是普通对象就丢掉
  });

  it('props 不是数组 = 没烘焙：字段整个没有', () => {
    const raw: unknown = { ...base(), regions: [{ id: 'r', name: '岛', theme: 'island', seed: 7, origin: [0, 0], palaces: [], props: 'nope' }] };
    const out = W.normalizeWorld(raw);
    expect('props' in out.regions[0]).toBe(false);
    expect(W.propsOf(out.regions[0])).toEqual([]);
  });

  it('没有 props 的旧世界文件规范化后仍然没有 props（不是空数组）', () => {
    const out = W.normalizeWorld({ ...base(), version: 1 });
    expect('props' in out.regions[0]).toBe(false);
    expect(out.version).toBe(W.WORLD_VERSION);
    expect(out.compat).toBe(W.WORLD_COMPAT);
  });

  it('烘焙过但岛上没有摆设：空数组保留下来', () => {
    const w = base();
    w.regions[0].props = [];
    const out = W.normalizeWorld(w);
    expect(out.regions[0].props).toEqual([]);
  });

  it('addProp / findProp / removeProp', () => {
    const r: W.WorldRegion = { id: 'r', name: '岛', theme: 'island', seed: 1, palaces: [] };
    expect('props' in r).toBe(false);        // 没烘焙，字段不存在
    expect(W.propsOf(r)).toEqual([]);

    const p = W.addProp(r, 'tree', [1.23456, 2.5], 45, { h: 3 });
    expect(p.id.startsWith('prop-')).toBe(true);
    expect(p.pos).toEqual([1.235, 2.5]);     // 位置取整到 3 位
    expect(p.rot).toBe(45);
    expect(p.params!.h).toBe(3);
    expect(typeof p.params!.seed).toBe('number');

    expect(W.findProp(r, p.id)).toBe(p);
    expect(W.findProp(r, 'nope')).toBeNull();
    expect(W.removeProp(r, 'nope')).toBe(false);   // 不认识的 id
    expect(W.removeProp(r, p.id)).toBe(true);
    expect(W.findProp(r, p.id)).toBeNull();
    expect(W.propsOf(r)).toEqual([]);
  });

  it('propInLot 认边界', () => {
    const lot: Rect = [-10, -10, 10, 10];
    expect(W.propInLot({ id: 'a', kind: 'tree', pos: [10, 10] }, lot)).toBe(true);
    expect(W.propInLot({ id: 'a', kind: 'tree', pos: [-10, 0] }, lot)).toBe(true);
    expect(W.propInLot({ id: 'a', kind: 'tree', pos: [10.001, 0] }, lot)).toBe(false);
  });

  it('nudgePropOutOfLot 把摆设挪出地块（不压到新宫殿）', () => {
    const lot: Rect = [-10, -10, 10, 10];
    const spots: Vec2[] = [[0, 0], [9.9, -9.9], [-9, 5]];
    for (const pos of spots) {
      const p: W.PlacedProp = { id: 'p', kind: 'tree', pos };
      W.nudgePropOutOfLot(p, lot);
      expect(W.propInLot(p, lot)).toBe(false);
      expect(Number.isFinite(p.pos[0]) && Number.isFinite(p.pos[1])).toBe(true);
    }
  });
});
