// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { seed } from '../src/random';
import { createKit } from '../src/kit';
import { createCatalog } from '../src/catalog';
import { getTheme } from '../src/themes';
import { commonMats, GRASS_Y, WATER_Y, type ThemeCtx, type PropPlace } from '../src/themes/common';
import { bakeRegionProps, decorateNow, propKind, propKinds, registerProp } from '../src/props';
import { WorldLayer, type RegionLayer } from '../src/world-layer';
import { createFromTemplate } from '../src/templates/basic';
import { PLAZA_R, regionLift, type WorldRegion } from '../src/world';

/**
 * happy-dom 没实现 canvas 2D（getContext('2d') 返回 null），而 kit 的程序化贴图要用它画图。
 * 这里装一个「什么都不画」的空上下文，只为让贴图生成不报错（测试不读像素）。
 */
function stubCanvas2D() {
  const sample = document.createElement('canvas');
  // 运行时才知道的形状：happy-dom 的 canvas 原型；按知名 DOM 形状取一次，装好就不再看它。
  const proto = Object.getPrototypeOf(sample) as { getContext(type: string): unknown } | null;
  if (!proto) return;
  const gradient = { addColorStop() {} };
  proto.getContext = () => ({
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    arc() {}, beginPath() {}, bezierCurveTo() {}, clip() {}, closePath() {}, ellipse() {},
    fill() {}, fillRect() {}, lineTo() {}, moveTo() {}, quadraticCurveTo() {}, rect() {},
    restore() {}, rotate() {}, save() {}, stroke() {}, strokeRect() {}, translate() {},
  });
}
stubCanvas2D();

const kit = createKit({ maxAniso: 1 });
const catalog = createCatalog(kit, 2.8);

const THEMES = ['island', 'forest', 'snow', 'sky'] as const;

/** 固定种子（createRegion 用的是 Math.random），测试才可复现 */
function makeRegion(theme: string): WorldRegion {
  return { id: 'r-' + theme, name: '测试岛', theme, seed: 12345, origin: [0, 0], palaces: [] };
}

/**
 * 和 RegionLayer.rebuildLand 里建 ThemeCtx 的方式一致：真实的地形参数（R / maxR / center）、
 * 广场那一份初始 blockers / landmarks、没有道路（摆放代码对 roads: null 是容忍的）。
 */
function makeCtx(region: WorldRegion): ThemeCtx {
  const theme = getTheme(region.theme);
  return {
    K: kit, catalog, region, mats: { ...commonMats(kit), ...theme.materials(kit) },
    land: new THREE.Group(), raw: new THREE.Group(),
    seaY: WATER_Y - regionLift(region),
    R: () => 30, center: [0, 0], maxR: 30, lots: [],
    roads: null,
    blockers: [{ x: 0, z: 0, r: PLAZA_R + 2.5 }],
    landmarks: [{ kind: 'plaza', x: 0, z: 0, angle: 0 }],
  };
}

describe('岛上的摆设：kind 注册表', () => {
  it('kind 唯一、小写无空格，都有名字 / 分组 / build', () => {
    const kinds = propKinds();
    expect(kinds.length).toBeGreaterThan(0);
    const ids = kinds.map(k => k.kind);
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of kinds) {
      expect(k.kind).toMatch(/^[a-z0-9-]+$/);
      expect(k.name.trim().length).toBeGreaterThan(0);
      expect(k.category.trim().length).toBeGreaterThan(0);
      expect(typeof k.build).toBe('function');
      expect(propKind(k.kind)).toBe(k);
    }
  });

  it('查不到老版本 / 不认识的 kind 时返回 undefined，不抛错', () => {
    expect(propKind('not-a-real-kind')).toBeUndefined();
    expect(propKind('')).toBeUndefined();
    expect(() => propKind('tree-v99')).not.toThrow();
  });
});

describe('岛上的摆设：烘焙', () => {
  for (const theme of THEMES) {
    it(`${theme}：同一座岛烘焙两次结果完全一样`, () => {
      const region = makeRegion(theme);
      seed(1);
      const a = bakeRegionProps(region, makeCtx(region));
      seed(1);
      const b = bakeRegionProps(region, makeCtx(region));

      expect(a.length).toBeGreaterThan(0);
      // ids、pos、rot、params（含派生的 seed）全等：同一座岛每次烘焙得到同一批数据
      expect(a).toEqual(b);
      expect(new Set(a.map(p => p.id)).size).toBe(a.length);

      const known = new Set(propKinds().map(k => k.kind));
      for (const p of a) {
        expect(known.has(p.kind)).toBe(true);
        expect(typeof p.params!.seed).toBe('number');
        expect(Number.isFinite(p.pos[0]) && Number.isFinite(p.pos[1])).toBe(true);
      }
    });

    it(`${theme}：烘焙出来的摆放和程序化摆放一致`, () => {
      const region = makeRegion(theme);
      const pack = getTheme(region.theme);

      // 程序化路径：跑的就是 decorateNow 里那份 theme.props(ctx, place)，只是把每次摆放记下来；
      // 也要像 props.ts 的 placer 一样登记地标 / 阻挡，后面的摆放才会避开前面的地标。
      seed(1);
      const ctx = makeCtx(region);
      const recorded: { kind: string; x: number; z: number; rot?: number; params?: Record<string, unknown> }[] = [];
      const place: PropPlace = (kind, x, z, opts = {}) => {
        if (!propKind(kind)) return;
        recorded.push({ kind, x, z, rot: opts.rot, params: opts.params });
        registerProp(ctx, { id: '', kind, pos: [x, z], rot: opts.rot, params: opts.params });
      };
      pack.props(ctx, place);

      seed(1);
      const baked = bakeRegionProps(region, makeCtx(region));

      expect(recorded.length).toBe(baked.length);
      recorded.forEach((r, i) => {
        const p = baked[i];
        expect(r.kind).toBe(p.kind);
        expect(r.x).toBe(p.pos[0]);
        expect(r.z).toBe(p.pos[1]);
        expect(r.rot ?? 0).toBe(p.rot ?? 0);
        for (const [k, v] of Object.entries(r.params || {})) expect(p.params?.[k]).toEqual(v);
      });
    });

    it(`${theme}：真跑一遍程序化渲染（decorateNow）摆出的位置和烘焙一致`, () => {
      const region = makeRegion(theme);
      const pack = getTheme(region.theme);

      // decorateNow 是程序化那条路的真入口：place 会真的建几何塞进 ctx.raw。
      // 如果 build 动了摆放用的随机流（没有先 seedFromString 定位），后面摆的东西就会移位，
      // 这里就会和烘焙数据对不上——所以这个用例能挡住两条路分岔。
      seed(1);
      const ctx = makeCtx(region);
      decorateNow(pack, ctx);
      const kids = ctx.raw.children.map(o => [o.position.x, o.position.z, o.rotation.y]);

      seed(1);
      const baked = bakeRegionProps(region, makeCtx(region));

      expect(kids.length).toBe(baked.length);
      kids.forEach((k, i) => {
        expect(k[0]).toBe(baked[i].pos[0]);
        expect(k[1]).toBe(baked[i].pos[1]);
        expect(k[2]).toBe(baked[i].rot ?? 0);
      });
    });
  }

  it('烘焙不改动调用方的 ctx：blockers / landmarks 原样，也不建几何', () => {
    const region = makeRegion('forest');
    const ctx = makeCtx(region);
    const before = JSON.stringify(ctx.blockers);
    const blockers = ctx.blockers.length, landmarks = ctx.landmarks.length;

    bakeRegionProps(region, ctx);

    expect(ctx.blockers.length).toBe(blockers);
    expect(ctx.landmarks.length).toBe(landmarks);
    expect(JSON.stringify(ctx.blockers)).toBe(before);
    expect(ctx.raw.children.length).toBe(0); // 烘焙只记录数据，不往场景里塞 mesh
  });
});

describe('岛上的摆设：抬高（lifted）不会被落位丢掉', () => {
  /**
   * 真跑程序化那条路（decorateNow），把每个摆件在世界里的包围盒收出来。
   * 注意 build() 返回的根节点 y 永远是 0（抬高放在内层节点上），所以要看的是世界包围盒，
   * 不是 raw.children[i].position.y —— 后者永远是 GRASS_Y。
   */
  const boxesOf = (theme: string): THREE.Box3[] => {
    const region = makeRegion(theme);
    seed(1);
    const ctx = makeCtx(region);
    decorateNow(getTheme(theme), ctx);
    ctx.raw.updateMatrixWorld(true);
    return ctx.raw.children.map(o => new THREE.Box3().setFromObject(o));
  };

  it('sky：热气球在天上（约 4 米），云挂在岛下（远低于草地）', () => {
    const boxes = boxesOf('sky');
    expect(boxes.length).toBeGreaterThan(0);

    // 热气球（doc 里写「4 米高」）是唯一整件都在草地 3 米以上的东西；
    // 落位把抬高丢掉的话它会掉到草地上，这条就会挂
    expect(boxes.some(b => b.min.y > GRASS_Y + 3)).toBe(true);
    // 云挂在浮空岛下方：有东西整件都在草地 3 米以下
    expect(boxes.some(b => b.max.y < GRASS_Y - 3)).toBe(true);
    // 高度不是清一色的 GRASS_Y（真把抬高丢了所有东西都会贴地）
    expect(new Set(boxes.map(b => +b.min.y.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('island：广场家具站在 6cm 铺装上（比草地高，但没飞起来）', () => {
    const boxes = boxesOf('island');
    expect(boxes.length).toBeGreaterThan(0);

    // island.props 的 plazaBenches 摆了 4 长凳 + 4 花槽，全都坐在铺装上：最低点比草地高一点点。
    // （花丛之类的自身几何也在草地之上，但高出更多；这个「铺装高度带」只圈得住家具）
    const onPaving = boxes.filter(b => b.min.y > GRASS_Y + 0.01 && b.min.y < GRASS_Y + 0.2);
    expect(onPaving.length).toBeGreaterThanOrEqual(8);
    // 也有东西就坐在草地上（树、灯……）：高度不是清一色的
    expect(boxes.some(b => b.min.y <= GRASS_Y + 0.01)).toBe(true);
    expect(new Set(boxes.map(b => +b.min.y.toFixed(4))).size).toBeGreaterThan(1);
  });
});

describe('摆设批次：重建时旧批次会被摘掉', () => {
  /** 场景里的 decor 批次个数（按名字数，不用碰私有字段） */
  const decorBatches = (layer: RegionLayer) => {
    let n = 0;
    layer.group.traverse(o => { if (o.name === 'decor') n++; });
    return n;
  };

  /**
   * 换选中、拖放、增删、改参数都会重走 rebuildDecor：旧批次没摘掉的话，场景里会一层层
   * 叠着旧复印件——拖动过的摆设会在旧位置留下一个影子（看起来像被复制了一份）。
   */
  it('烘焙过的岛和程序化生成的岛，反复重建都只留一个批次', () => {
    const K = createKit({ maxAniso: 1 });
    const world = new WorldLayer(K, createCatalog(K, 2.8));
    for (const baked of [true, false]) {
      const doc = createFromTemplate('cottage', baked ? 'BatchA' : 'BatchB');
      const region: WorldRegion = {
        ...makeRegion('island'),
        palaces: [{ palaceId: doc.id, pos: [0, 0], rot: 0 }],
        ...(baked ? { props: [] } : {}),
      };
      const docs = new Map([[doc.id, doc]]);
      world.addRegion(region, docs);
      const layer = world.regions.get(region.id);
      expect(layer).toBeTruthy();
      layer!.rebuildLand(docs);
      expect(decorBatches(layer!)).toBe(1);
      const stable = layer!.land.children.length;
      layer!.rebuildDecor();
      layer!.rebuildDecor();
      expect(decorBatches(layer!)).toBe(1);
      // 也没有别的残留（比如上一批脱离批次的个体）挂在岛上
      expect(layer!.land.children.length).toBe(stable);
    }
  });

  it('重置岛屿风景：清除烘焙摆设并重新生成自然风景', () => {
    const K = createKit({ maxAniso: 1 });
    const world = new WorldLayer(K, createCatalog(K, 2.8));
    const doc = createFromTemplate('cottage', 'ResetIslandDoc');
    const region: WorldRegion = {
      ...makeRegion('island'),
      palaces: [{ palaceId: doc.id, pos: [0, 0], rot: 0 }],
      props: [{ id: 'p1', kind: 'fountain', pos: [5, 5] }],
    };
    const docs = new Map([[doc.id, doc]]);
    world.addRegion(region, docs);
    const layer = world.regions.get(region.id);
    expect(layer).toBeTruthy();
    expect(region.props).toBeDefined();

    // 模拟重置风景：删除 props，改变 seed，并重建土地
    const oldSeed = region.seed;
    delete region.props;
    region.seed = 99999;
    expect(region.props).toBeUndefined();
    expect(region.seed).not.toBe(oldSeed);

    world.rebuildLand(region.id, docs);
    expect(decorBatches(layer!)).toBe(1);
    expect(world.propBox(region.id, 'p1')).toBeNull();
  });
});
