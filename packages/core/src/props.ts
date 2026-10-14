import * as THREE from 'three';
import type { ParamSpec } from './catalog';
import { rand, rr, seed, getState, setState } from './random';
import type { PlacedProp, WorldRegion } from './world';
import type { PropPlace, ThemeCtx, ThemePack } from './themes/common';
import { GRASS_Y, LEAF, LEAF_NAMES, WATER_Y, jitter } from './themes/common';
import { getTheme } from './themes';

/* =====================================================================
 * 岛上的摆设（prop）：树、石头、长椅、灯塔……站着的东西都是 prop。
 * 地形 / 海岸 / 道路 / 广场铺装仍然是程序化生成的「生几何」（见各主题的 terrain / plaza）。
 *
 * 两件事分开：
 *   摆放（placement）——主题的 props(ctx, place) 只决定「什么 kind、在哪、朝哪边、参数是什么」，
 *                       用的是共用的确定性随机（seedFromString / rand / rr）；
 *   几何（geometry）——每种 kind 的 build(ctx, params) 在原点（y = 0 是地面，+z 是正面）建出这个摆设。
 *
 * 摆放是唯一的事实来源，同一份摆放代码喂两条路：
 *   程序化（岛还没烘焙）——place 立刻建几何塞进 ctx.raw，看起来和以前一模一样；
 *   烘焙   （岛已经有 region.props）——只记录成数据（bakeRegionProps），渲染时再按数据重建。
 * 所以摆放里不许碰几何，几何里不许碰摆放用的随机流：
 *   - props(ctx, place) 里可以用 rand / rr，但每一组都要先 seedFromString(...) 定位自己的随机流；
 *   - build 里要随机细节时先用 params.seed 重设随机流（params.seed 是 place 按位置推出的稳定种子），
 *     这样烘焙前后的样子完全一致。build 的 seed() 不会影响摆放：惰性建几何那条路（placer）
 *     在建几何前后会给随机流存档 / 读档。
 *
 * params 里除了界面参数（见 PropKind.params）还有几个内部字段：
 *   seed      这个摆件的稳定随机种子（不许删，删了树会长歪）
 *   blockers  覆盖默认阻挡半径：[{ dx, dz, r }]（形状自带尺寸的地标，如池塘 / 瀑布）
 *   angle     地标朝向（灯塔 / 码头 / 瀑布的同名参数）
 * ===================================================================== */

/** 广场家具坐在铺装上：plazaBase 把铺装铺到草地上方 6cm */
const PAVE_Y = .06;

// ---------------- 参数小工具 ----------------

const num = (v: unknown, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const str = (v: unknown, def: string) => (typeof v === 'string' && v ? v : def);

const pnum = (key: string, label: string, min: number, max: number, step: number, def: number): ParamSpec => ({ key, label, min, max, step, def });
const psel = (key: string, label: string, options: [unknown, string][], def: unknown): ParamSpec => ({ key, label, options, def });

const WOODS: [string, string][] = [['oak', '橡木'], ['oakLight', '浅橡木'], ['walnut', '胡桃木']];
const LEAF_TONES: [number, string][] = [[LEAF.leaf, '深绿'], [LEAF.leafLight, '浅绿'], [LEAF.leafDark, '墨绿'], [LEAF.leafOlive, '橄榄绿']];

/** 树叶材质：按 common.ts 里固定的顺序取（params 里存序号，不会随主题变） */
const leafMat = (ctx: ThemeCtx, i: number) => ctx.K.M[LEAF_NAMES[((Math.round(i) % LEAF_NAMES.length) + LEAF_NAMES.length) % LEAF_NAMES.length]];

/**
 * 取主题材质；这个主题没有就按后面的名字依次退回。
 * 有些材质只有某一个主题才有（池塘是森林的、浮冰和雪山是雪山的、云和瀑布是浮空岛的），
 * 而缩略图把四个主题的材质合在一起用——所以缺材质在预览里看不出来，只有摆到岛上才会暴露成
 * three 的默认白材质（整块摆设变成一片白）。这里最后兜底到岩石色。
 */
function themeMat(ctx: ThemeCtx, ...names: string[]): THREE.Material {
  const shared = ctx.K.M as unknown as Record<string, THREE.Material>;
  for (const n of names) {
    const m = ctx.mats[n] || shared[n];
    if (m) return m;
  }
  return shared.stone;
}

/** 顶点色岩石（雪山摆到别的主題上时用）：山顶的雪线画在几何顶点色里，退回的材质也要开 vertexColors */
const vColorRocks = new WeakMap<object, THREE.MeshStandardMaterial>();
function vertexRockMat(ctx: ThemeCtx): THREE.MeshStandardMaterial {
  const hit = vColorRocks.get(ctx.K);
  if (hit) return hit;
  const m = ctx.K.std('#ffffff', .95, 0, { flatShading: true, vertexColors: true });
  vColorRocks.set(ctx.K, m);
  return m;
}

/**
 * 摆设的落位基准 y（区域局部坐标）：默认坐在草地上；params.water 让它落在水面（海面那一层），
 * params.air 再把它从基准抬高 air 米（云、热气球这类要放到天上的东西）。
 * 摆放（placer）、渲染（world-layer 的 placeProps / moveProp）用的是同一个函数，
 * 所以烘焙前后、拖动预览和最终落位才会一致。
 */
export function propBaseY(seaY: number, params?: Record<string, unknown>): number {
  return (params?.water === true ? seaY : GRASS_Y) + num(params?.air);
}

/**
 * 整体抬高 y 米（广场家具坐在铺装上、云飘在不同高度、热气球 4 米高……）。
 * 抬高量放在内层节点上，返回的根节点 y 恒为 0（= 草地）。
 * 摆放方按「y = GRASS_Y + 根节点 y」落位（placer 和 world-layer 的 placeProps 都是），
 * 所以内层抬高不会被覆盖；万一某个 kind 直接把抬高写在根节点上，也照样保得住。
 */
function lifted(child: THREE.Object3D, y: number) {
  if (!y) return child;
  const holder = new THREE.Group();
  holder.position.y = y;
  holder.add(child);
  const root = new THREE.Group();
  root.add(holder);
  return root;
}

/* =====================================================================
 * 各种摆设
 * ===================================================================== */

export interface PropKind {
  /** 稳定 id（存盘用）：小写、没有空格 */
  kind: string;
  /** 显示名（中文原文，界面用 t() 包） */
  name: string;
  /** 摆放面板里的分组（也是中文原文） */
  category: string;
  /** 地标：道路 / 地标簿记用（灯塔、码头、风车、瞭望塔、池塘、雪山、喷泉……） */
  landmark?: boolean;
  /** 地标要占住的半径（道路要避开；形状自带尺寸的见 params.blockers） */
  blocker?: number;
  /**
   * 在原点建几何：y = 0 是地面，+z 是正面。
   * 根节点的 position / rotation 由摆放方设置——placer() 和渲染层的 placeProps() 都是
   * position = (x, GRASS_Y + 根节点 y, z)、rotation.y = rot（两条路必须一致，烘焙前后才看不出差别）。
   * 所以根节点 y 保持 0（= 草地）最稳；要抬高（铺装上的家具、天上的云和热气球）用 lifted()。
   */
  build(ctx: ThemeCtx, params: Record<string, unknown>): THREE.Object3D;
  /** 摆放面板可调参数（和物件目录共用 ParamSpec） */
  params?: ParamSpec[];
}

/** 码头 + 小船（局部 +z 指向海面） */
function boat(ctx: ThemeCtx, x: number, y: number, z: number, rot = 0) {
  const { K, mats } = ctx;
  const hullShape = (w: number, l: number) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, -l / 2); s.lineTo(w / 2, -l / 2);
    s.quadraticCurveTo(w / 2 + .05, l * .15, 0, l / 2);
    s.quadraticCurveTo(-w / 2 - .05, l * .15, -w / 2, -l / 2);
    return s;
  };
  const b = new THREE.Group();
  const hullGeo = new THREE.ExtrudeGeometry(hullShape(1.3, 3.4), { depth: .42, bevelEnabled: true, bevelThickness: .08, bevelSize: .08, bevelSegments: 2, curveSegments: 12 });
  const hull = K.mesh(hullGeo, [mats.hull, mats.red]); hull.rotation.x = -Math.PI / 2; b.add(hull);
  const inner = K.mesh(new THREE.ExtrudeGeometry(hullShape(1.02, 2.9), { depth: .05, bevelEnabled: false, curveSegments: 12 }), mats.woodDark, false);
  inner.rotation.x = -Math.PI / 2; inner.position.set(0, .46, .05); b.add(inner);
  for (const zz of [-.55, .35]) { const seat = K.mesh(new THREE.BoxGeometry(1.1, .05, .26), mats.wood, false); seat.position.set(0, .58, zz); b.add(seat); }
  b.position.set(x, y, z); b.rotation.y = rot;
  return b;
}

// ---------------- 树 ----------------

const UP = new THREE.Vector3(0, 1, 0);

/**
 * 一根低多边形的「干 / 枝 / 叶脉」：从 a 到 b 的锥形柱体。
 * flat < 1 时把横截面压扁成叶片——压的是局部 x（和 ab 垂直的那个方向）；所以要让叶片平躺，
 * 这一串点必须落在自己那个组的 xy 平面里（方位角交给外层组的 rotation.y）。
 */
function limb(ctx: ThemeCtx, g: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, rTop: number, rBot: number, mat: THREE.Material, flat = 1, seg = 6) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  if (len < 1e-4) return null;
  const m = ctx.K.mesh(new THREE.CylinderGeometry(rTop, rBot, len, seg), mat);
  m.position.copy(a).addScaledVector(dir, .5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  if (flat !== 1) m.scale.x = flat;
  g.add(m);
  return m;
}

/** 树冠轮廓（参数 shape）：圆冠 / 高冠 / 伞冠 / 疏冠 */
const TREE_SHAPES: [number, string][] = [[0, '圆冠'], [1, '高冠'], [2, '伞冠'], [3, '疏冠']];

/** 树冠团的配色：以叶色为基色往上取相邻两档，一团一个色（和主题的材质表同一套绿） */
function canopyTones(leaf: number) {
  const n = LEAF_NAMES.length;
  const base = ((Math.round(leaf) % n) + n) % n;
  return [0, 1, 2].map(k => (base + k) % n);
}

/**
 * 低多边形阔叶树：带锥度的树干 + 几团二十面体树冠。
 * 高度 / 树冠宽度 w / 树干粗细 trunk / 叶色 tones / 轮廓 shape 全由参数定；
 * 随机的是每团的偏角和半径（调用方要先按 params.seed 定位随机流）。
 * 返回根节点和树干尺寸（白桦要在树干上贴斑纹）。
 */
function leafTree(ctx: ThemeCtx, o: { h: number; w: number; trunk: number; tones: number[]; shape: number; ratio?: number; bark?: THREE.Material }) {
  const { K } = ctx;
  const g = new THREE.Group();
  const th = o.h * (o.ratio ?? .52), r0 = o.h * .042 * o.trunk;
  const trunk = K.mesh(new THREE.CylinderGeometry(r0 * .62, r0, th, 7), o.bark ?? K.M.bark);
  trunk.position.y = th / 2;
  g.add(trunk);
  const spread = o.h * (.06 + .18 * o.w);
  const blobs = o.shape === 3 ? 5 : 8;
  for (let i = 0; i < blobs; i++) {
    // 黄金角排布：团与团之间自然错开，不会叠成一根糖葫芦
    const a = i * 2.39996 + rr(-.35, .35);
    const t = i / Math.max(1, blobs - 1);
    let y = 0, rad = 0, r = 0, squash = 1;
    if (o.shape === 1) {           // 高冠：越往上越细
      y = th * .78 + (o.h - th * .78) * (.15 + t * .8);
      rad = spread * (1 - t * .72);
      r = o.h * (.1 + .1 * (1 - t));
    } else if (o.shape === 2) {    // 伞冠：低而平，向四周撑开
      y = th * .8 + o.h * .07 + rr(-.03, .03) * o.h;
      rad = spread * (1.05 + rr(-.15, .15));
      r = o.h * rr(.15, .2);
      squash = .62;
    } else if (o.shape === 3) {    // 疏冠：几团小而散，看得见树干
      y = th * .72 + o.h * (.12 + .3 * rand());
      rad = spread * (.45 + 1.05 * rand());
      r = o.h * rr(.1, .14);
    } else {                       // 圆冠：团成一顶
      y = th * .76 + o.h * (.08 + Math.sin(t * Math.PI) * .16);
      rad = spread * Math.sin(t * Math.PI) * .95;
      r = o.h * rr(.15, .21);
    }
    const m = K.ico(g, r, leafMat(ctx, o.tones[i % o.tones.length]), Math.cos(a) * rad, y, Math.sin(a) * rad, 1);
    if (squash !== 1) m.scale.y = squash;
  }
  return { g, trunkR: r0, trunkH: th };
}

const KINDS: PropKind[] = [
  // ---------------- 植物 ----------------
  {
    kind: 'tree', name: '树', category: '植物',
    params: [pnum('h', '高度', 1.5, 8, .1, 3.2), psel('shape', '树冠', TREE_SHAPES, 0), pnum('w', '树冠宽度', .6, 1.6, .05, 1), pnum('trunk', '树干粗细', .6, 1.8, .05, 1), psel('leaf', '叶色', LEAF_TONES, LEAF.leaf)],
    build(ctx, p) {
      const h = num(p.h, 3.2);
      seed(num(p.seed, 1));
      // 老存档只有 h + variant：照旧用目录里那棵树，样子不变
      if (p.shape === undefined && p.leaf === undefined && p.variant !== undefined) return ctx.catalog.tree.build({ h, variant: num(p.variant, 0) });
      return leafTree(ctx, { h, w: num(p.w, 1), trunk: num(p.trunk, 1), tones: canopyTones(num(p.leaf, LEAF.leaf)), shape: num(p.shape, 0) }).g;
    },
  },
  {
    kind: 'broadleaf', name: '阔叶树', category: '植物',
    params: [pnum('h', '高度', 2, 9, .1, 4.6), psel('shape', '树冠', TREE_SHAPES, 0), pnum('w', '树冠宽度', .6, 1.6, .05, 1.25), pnum('trunk', '树干粗细', .6, 1.8, .05, 1.2), psel('leaf', '叶色', LEAF_TONES, LEAF.leafDark), pnum('lean', '倾斜', 0, .3, .01, 0)],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const t = leafTree(ctx, { h: num(p.h, 4.6), w: num(p.w, 1.25), trunk: num(p.trunk, 1.2), tones: canopyTones(num(p.leaf, LEAF.leafDark)), shape: num(p.shape, 0), ratio: .46 });
      t.g.rotation.z = num(p.lean);
      return t.g;
    },
  },
  {
    kind: 'birch', name: '白桦', category: '植物',
    params: [pnum('h', '高度', 2, 9, .1, 5.4), pnum('w', '树冠宽度', .5, 1.4, .05, .85), pnum('lean', '弯曲', 0, .3, .01, .08), psel('leaf', '叶色', LEAF_TONES, LEAF.leafLight)],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const { K } = ctx;
      const t = leafTree(ctx, { h: num(p.h, 5.4), w: num(p.w, .85), trunk: .55, tones: canopyTones(num(p.leaf, LEAF.leafLight)), shape: 3, ratio: .66, bark: K.M.linen });
      // 树皮上的横斑：白桦最好认的一处
      for (let i = 0; i < 4; i++) {
        const ring = K.mesh(new THREE.CylinderGeometry(t.trunkR * rr(1.03, 1.14), t.trunkR * rr(1.03, 1.14), t.trunkH * .022, 7), K.M.charcoal);
        ring.position.set(rr(-.012, .012), t.trunkH * rr(.12, .85), rr(-.012, .012));
        t.g.add(ring);
      }
      t.g.rotation.z = num(p.lean, .08);
      return t.g;
    },
  },
  {
    kind: 'palm', name: '棕榈', category: '植物',
    params: [pnum('h', '高度', 2, 7, .1, 4.2), pnum('fronds', '叶片数', 5, 12, 1, 9), pnum('lean', '弯曲', 0, .5, .02, .16), psel('leaf', '叶色', LEAF_TONES, LEAF.leafOlive)],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const { K } = ctx;
      const h = num(p.h, 4.2), n = Math.max(5, Math.round(num(p.fronds, 9))), lean = num(p.lean, .16);
      const g = new THREE.Group();
      // 树干：沿一条弧首尾相接的锥形段（每根都从上一根的末端长出来，接缝不错位），外面套几道叶痕
      const segs = 6, R = h * .045;
      const pts = [new THREE.Vector3(0, 0, 0)];
      for (let i = 0; i < segs; i++) {
        const a = lean * ((i + .5) / segs), last = pts[i];
        pts.push(new THREE.Vector3(last.x + Math.sin(a) * h / segs, last.y + Math.cos(a) * h / segs, 0));
      }
      const radius = (t: number) => R * (.6 + .4 * (1 - t));
      const at = (t: number) => {
        const f = Math.min(segs - 1e-6, t * segs), i = Math.floor(f);
        return pts[i].clone().lerp(pts[i + 1], f - i);
      };
      for (let i = 0; i < segs; i++) limb(ctx, g, pts[i], pts[i + 1], radius((i + 1) / segs), radius(i / segs), K.M.bark, 1, 7);
      for (const t of [.28, .52, .76]) {
        const r = radius(t) * 1.07;
        limb(ctx, g, at(t), at(t + .05), r, r, K.M.walnut, 1, 7);
      }
      const tip = at(1);
      const mat = leafMat(ctx, num(p.leaf, LEAF.leafOlive));
      const mat2 = leafMat(ctx, num(p.leaf, LEAF.leafOlive) + 1);
      // 树心：顶上两团小叶子，树冠才有根
      K.ico(g, h * .07, mat, tip.x, tip.y, tip.z, 0);
      K.ico(g, h * .05, mat2, tip.x + h * .03, tip.y + h * .035, tip.z - h * .02, 0);
      for (let i = 0; i < n; i++) {
        // 叶片：先向上翘、再垂下来的一条窄带（三段接成弧），四周错开
        const frond = new THREE.Group();
        frond.position.copy(tip);
        frond.rotation.y = i / n * Math.PI * 2 + rr(-.12, .12);
        g.add(frond);
        const len = h * rr(.45, .6);
        let a = rr(.5, .85);
        let from = new THREE.Vector3(0, 0, 0);
        for (let k = 0; k < 3; k++) {
          const l = len / 3, w = h * .055 * (1 - k * .3);
          const to = from.clone().add(new THREE.Vector3(Math.cos(a) * l, Math.sin(a) * l, 0));
          limb(ctx, frond, from, to, w * .5, w, k % 2 ? mat2 : mat, .3, 5);
          from = to;
          a -= rr(.5, .75);
        }
      }
      for (let i = 0; i < 3; i++) {
        const a = i / 3 * Math.PI * 2 + rr(-.3, .3);
        K.ball(g, h * .032, K.M.walnut, tip.x + Math.cos(a) * h * .055, tip.y - h * .045, tip.z + Math.sin(a) * h * .055, [1, 1.15, 1], 8);
      }
      return g;
    },
  },
  {
    kind: 'dead-tree', name: '枯树', category: '植物',
    params: [pnum('h', '高度', 1.5, 7, .1, 3.6), pnum('branches', '分叉', 3, 8, 1, 5)],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const { K } = ctx;
      const h = num(p.h, 3.6), n = Math.max(1, Math.round(num(p.branches, 5))), th = h * .56;
      const g = new THREE.Group();
      limb(ctx, g, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, th, 0), h * .028, h * .05, K.M.bark, 1, 6);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const a = i * 2.39996 + rr(-.4, .4), y = th * (.55 + .45 * t);
        const len = h * rr(.16, .3) * (1 - t * .5), tilt = rr(.5, 1.05);
        const from = new THREE.Vector3(0, y, 0);
        const to = from.clone().add(new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).multiplyScalar(len));
        limb(ctx, g, from, to, h * .008, h * .018, K.M.bark, 1, 5);
        if (rand() < .7) {  // 枝尖再分一根小杈
          const d2 = new THREE.Vector3(to.x * rr(.3, .9) + rr(-.5, .5), rr(.5, 1), to.z * rr(.3, .9) + rr(-.5, .5)).normalize().multiplyScalar(len * rr(.45, .7));
          limb(ctx, g, to, to.clone().add(d2), h * .004, h * .011, K.M.bark, 1, 4);
        }
      }
      return g;
    },
  },
  {
    kind: 'conifer', name: '针叶树', category: '植物',
    params: [pnum('h', '高度', 2, 8, .1, 4), pnum('tiers', '层数', 2, 6, 1, 3), pnum('spread', '树冠宽度', .6, 1.5, .05, 1), psel('leaf', '颜色', [['pine', '深绿'], ['pineLight', '浅绿'], ['leafDark', '墨绿'], ['leafOlive', '橄榄绿']], 'pine'), psel('snow', '积雪', [[false, '无雪'], [true, '积雪']], false)],
    build(ctx, p) {
      const { K, mats } = ctx;
      const h = num(p.h, 4), spread = num(p.spread, 1);
      const spin: unknown[] = Array.isArray(p.tier) ? p.tier : [];
      const tiers = Math.max(2, Math.round(num(p.tiers, spin.length || 3)));
      const name = str(p.leaf, 'pine');
      const leaf = mats[name] || K.M[name as 'pine'] || mats.pine;
      const g = new THREE.Group();
      const trunk = K.mesh(new THREE.CylinderGeometry(.08, .13, h * .34, 8), K.M.bark);
      trunk.position.y = h * .17; g.add(trunk);
      for (let i = 0; i < tiers; i++) {
        const t = i / tiers, r = h * (.3 - t * .075) * spread, th = h * (.34 - t * .04), y = h * (.22 + t * .48);
        const cone = K.mesh(new THREE.ConeGeometry(r, th, 7), leaf);
        cone.position.y = y + th / 2; cone.rotation.y = num(spin[i]); g.add(cone);
        if (p.snow === true) {
          const cap = K.mesh(new THREE.ConeGeometry(r * .62, th * .48, 7), mats.snowCap);
          cap.position.y = y + th - th * .24 + .02; cap.rotation.y = cone.rotation.y; g.add(cap);
        }
      }
      return g;
    },
  },
  {
    kind: 'shrub', name: '灌木', category: '植物',
    params: [pnum('s', '大小', .2, .9, .05, .4), psel('leafA', '颜色', LEAF_TONES, LEAF.leaf), psel('leafB', '颜色', LEAF_TONES, LEAF.leafLight), pnum('blobs', '团数', 1, 5, 1, 2), pnum('spread', '展开', .6, 1.6, .05, 1)],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const { K } = ctx;
      const s = num(p.s, .4);
      const g = new THREE.Group();
      K.ico(g, s, leafMat(ctx, num(p.leafA)), 0, s * .55, 0, 1);
      // 老存档记的是 second + dx/dz（再来一团），新的是 blobs + spread（几团、铺多开）
      const extra = p.blobs !== undefined ? Math.round(num(p.blobs, 2)) - 1 : (p.second === true ? 1 : 0);
      const spread = num(p.spread, 1);
      for (let i = 0; i < extra; i++) {
        const a = i * 2.39996 + rr(0, 1);
        const d = s * rr(.55, 1.15) * spread, r = s * rr(.5, .78);
        const m = K.ico(g, r, leafMat(ctx, i % 2 ? num(p.leafB, 1) : num(p.leafA)), Math.cos(a) * d, s * rr(.35, .7), Math.sin(a) * d, 1);
        m.scale.y = rr(.75, 1);
      }
      return g;
    },
  },
  {
    kind: 'flower', name: '花丛', category: '植物',
    params: [psel('color', '颜色', [['terracotta', '陶土红'], ['mustard', '芥末黄'], ['rose', '豆沙粉'], ['blossom', '樱粉']], 'terracotta')],
    build(ctx, p) {
      const c = str(p.color, 'terracotta');
      const mat = c === 'mustard' ? ctx.K.M.mustard : c === 'rose' ? ctx.K.M.rose : c === 'blossom' ? ctx.mats.blossom || ctx.K.M.rose : ctx.K.M.terracotta;
      const g = new THREE.Group();
      ctx.K.ball(g, .1, mat, 0, num(p.h, .5), 0, [1, 1, 1], 10);
      return g;
    },
  },
  {
    kind: 'blossom-tree', name: '樱花树', category: '植物',
    params: [pnum('h', '高度', 1.5, 5, .1, 2.6), pnum('w', '树冠宽度', .6, 1.6, .05, 1), pnum('lean', '倾斜', 0, .3, .01, .04), psel('color', '花色', [['blossom', '樱粉'], ['rose', '豆沙粉'], ['linen', '米白']], 'blossom')],
    build(ctx, p) {
      seed(num(p.seed, 1));
      const { K, mats } = ctx;
      const h = num(p.h, 2.6), w = num(p.w, 1);
      const color = str(p.color, 'blossom');
      const petal = color === 'rose' ? K.M.rose : color === 'linen' ? K.M.linen : mats.blossom || K.M.rose;
      const accent = color === 'rose' ? (mats.blossom || K.M.rose) : K.M.rose;
      const g = new THREE.Group();
      const trunk = K.mesh(new THREE.CylinderGeometry(.07, .12, h * .55, 8), K.M.bark);
      trunk.position.y = h * .27; g.add(trunk);
      for (let i = 0; i < 7; i++) {
        const a = rand() * Math.PI * 2, d = rr(0, h * .22 * w), s = rr(h * .13, h * .2) * w;
        const c = K.mesh(new THREE.IcosahedronGeometry(s, 1), i % 3 ? petal : accent);
        c.position.set(Math.cos(a) * d, rr(h * .55, h * .85), Math.sin(a) * d); g.add(c);
      }
      g.rotation.z = num(p.lean, .04);
      return g;
    },
  },
  {
    kind: 'reed', name: '芦苇', category: '植物',
    params: [pnum('h', '高度', .4, 1.4, .05, .8)],
    build(ctx, p) {
      const g = new THREE.Group();
      const m = ctx.K.mesh(new THREE.ConeGeometry(.03, num(p.h, .8), 4), ctx.K.M.leafOlive);
      m.position.y = .4; g.add(m);
      return g;
    },
  },

  // ---------------- 自然 ----------------
  {
    kind: 'boulder', name: '石头', category: '自然',
    params: [pnum('s', '大小', .2, 1.6, .05, .6), psel('mat', '材质', [['rock', '礁岩'], ['boulder', '卵石'], ['floe', '浮冰']], 'rock')],
    build(ctx, p) {
      const s = num(p.s, .6);
      const m = ctx.K.mesh(new THREE.DodecahedronGeometry(s, 0), ctx.mats[str(p.mat, 'rock')] || ctx.mats.rock || ctx.mats.boulder);
      m.position.y = num(p.y, s * .25); m.scale.y = num(p.sy, .7); m.rotation.set(num(p.rx), num(p.ry), 0);
      const g = new THREE.Group();
      g.add(m);
      return g;
    },
  },
  {
    kind: 'sea-rock', name: '礁石', category: '自然',
    params: [pnum('s', '大小', .3, 1.5, .05, .8), psel('mat', '材质', [['rock', '礁岩'], ['boulder', '卵石']], 'rock')],
    build(ctx, p) {
      const { K } = ctx;
      const s = num(p.s, .8), y = ctx.seaY - GRASS_Y;
      const mat = ctx.mats[str(p.mat, 'rock')] || ctx.mats.rock || ctx.mats.boulder;
      const g = new THREE.Group();
      const m = K.mesh(new THREE.DodecahedronGeometry(s, 0), mat);
      m.position.y = y + s * .2; m.rotation.set(num(p.rx), num(p.ry), 0); m.scale.y = .7;
      g.add(m);
      if (p.extra === true) {
        const m2 = K.mesh(new THREE.DodecahedronGeometry(s * .55, 0), mat);
        m2.position.set(s * 1.1, y + s * .1, num(p.dz)); m2.scale.y = .7;
        g.add(m2);
      }
      return g;
    },
  },
  {
    kind: 'log', name: '倒木', category: '自然', blocker: 1.6,
    params: [pnum('len', '长度', 1.2, 4, .1, 2.6)],
    build(ctx, p) {
      const g = new THREE.Group();
      const m = ctx.K.mesh(new THREE.CylinderGeometry(.22, .26, num(p.len, 2.6), 10), ctx.K.M.bark);
      m.rotation.z = Math.PI / 2; m.position.y = .22;
      g.add(m);
      return g;
    },
  },
  {
    kind: 'snowdrift', name: '雪堆', category: '自然',
    params: [pnum('s', '大小', .3, .9, .05, .6)],
    build(ctx, p) {
      const s = num(p.s, .6);
      const d = ctx.K.mesh(new THREE.SphereGeometry(s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), themeMat(ctx, 'floe', 'snowCap'));
      d.position.y = -.02; d.scale.set(1.4, .45, 1);
      const g = new THREE.Group();
      g.add(d);
      return g;
    },
  },
  {
    kind: 'floe', name: '浮冰', category: '自然',
    params: [pnum('s', '大小', .6, 2.4, .1, 1.4)],
    build(ctx, p) {
      // 浮冰的棱角是顶点抖动出来的，用 params.seed 定住
      seed(num(p.seed, 1));
      const s = num(p.s, 1.4);
      const f = ctx.K.mesh(jitter(new THREE.CylinderGeometry(s, s * 1.08, .3, 6), s * .12), themeMat(ctx, 'floe', 'snowCap'));
      f.position.y = ctx.seaY - GRASS_Y + .06;
      const g = new THREE.Group();
      g.add(f);
      return g;
    },
  },
  {
    kind: 'pond', name: '池塘', category: '自然', landmark: true, blocker: 4.2,
    params: [pnum('r', '半径', 2, 4, .1, 3)],
    build(ctx, p) {
      // 卵石 / 睡莲的位置是随机的，用 params.seed 定住
      seed(num(p.seed, 1));
      const { K } = ctx;
      const r = num(p.r, 3);
      const g = new THREE.Group();
      const water = K.mesh(new THREE.CylinderGeometry(r, r, .06, 40), themeMat(ctx, 'pond', 'fountain'), false);
      water.position.y = .01; water.scale.z = .75; g.add(water);
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2, s = rr(.18, .32);
        const m = K.mesh(jitter(new THREE.DodecahedronGeometry(s, 0), .04), themeMat(ctx, 'pebble', 'rock'));
        m.position.set(Math.cos(a) * r * 1.03, .06, Math.sin(a) * r * .78); m.scale.y = .55;
        g.add(m);
      }
      for (let i = 0; i < 6; i++) {
        const a = rr(0, Math.PI * 2), d = rr(.3, .75) * r;
        const pad = K.mesh(new THREE.CylinderGeometry(rr(.22, .34), rr(.22, .34), .02, 12, 1, false, .3, Math.PI * 1.8), themeMat(ctx, 'lily', 'leafFlat'), false);
        pad.position.set(Math.cos(a) * d, .05, Math.sin(a) * d * .75); g.add(pad);
      }
      return g;
    },
  },
  {
    kind: 'mountain', name: '雪山', category: '自然', landmark: true, blocker: 10,
    build(ctx, p) {
      // 抖动 + 按面片高度上色都用随机数，用 params.seed 定住
      seed(num(p.seed, 1));
      const { K, mats } = ctx;
      const rock = new THREE.Color('#7d8791'), rock2 = new THREE.Color('#6b7580'), snowC = new THREE.Color('#f4f7fa');
      const g = new THREE.Group();
      const peak = (px: number, pz: number, r: number, h: number) => {
        const geo = jitter(new THREE.ConeGeometry(r, h, 9, 5), r * .08, -h / 2).toNonIndexed();
        const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i += 3) {
          const t = ((pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 + h / 2) / h;
          const c = t > .5 + rr(-.1, .08) ? snowC : rand() < .3 ? rock2 : rock;
          for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        const m = K.mesh(geo, mats.mountain || vertexRockMat(ctx));
        m.position.set(px, h / 2 - .3, pz); m.rotation.y = rr(0, 1);
        g.add(m);
      };
      peak(0, 0, 8.5, 12);
      const a = num(p.ang, .9);
      peak(Math.cos(a) * 7.5, Math.sin(a) * 7.5, 5.2, 7.2);
      return g;
    },
  },
  {
    kind: 'cloud', name: '云朵', category: '自然',
    build(ctx, p) {
      // 一团云由几块球组成，块的位置用 params.seed 定住
      seed(num(p.seed, 1));
      const { K } = ctx;
      const n = num(p.n, 4);
      const g = new THREE.Group();
      for (let k = 0; k < n; k++) {
        const s = rr(1.1, 2.2);
        const m = K.mesh(new THREE.IcosahedronGeometry(s, 1), themeMat(ctx, 'cloud', 'white'), false);
        m.position.set(rr(-2, 2), rr(-.3, .5), rr(-1.4, 1.4)); m.scale.y = .62;
        g.add(m);
      }
      return lifted(g, num(p.y) - GRASS_Y);
    },
  },

  // ---------------- 水景 / 建筑 ----------------
  {
    kind: 'fountain', name: '喷泉', category: '户外', landmark: true,
    params: [psel('water', '材质', [['fountain', '活水'], ['frozen', '冰面']], 'fountain')],
    build(ctx, p) {
      const { K, mats } = ctx;
      const water = mats[str(p.water, 'fountain')] || mats.fountain;
      const g = new THREE.Group();
      const c = (rt: number, rb: number, h: number, y: number, mat: THREE.Material, seg = 48) => {
        const m = K.mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
        m.position.y = y + h / 2; g.add(m); return m;
      };
      c(1.9, 2.0, .5, .05, mats.stone);
      c(1.72, 1.72, .04, .5, water).castShadow = false;
      c(.18, .26, 1.1, .5, mats.stone, 20);
      c(.75, .3, .22, 1.5, mats.stone, 32);
      const top = K.mesh(new THREE.SphereGeometry(.2, 20, 12), water); top.position.y = 1.85; g.add(top);
      return g;
    },
  },
  {
    kind: 'waterfall', name: '瀑布', category: '自然', landmark: true, blocker: 2,
    build(ctx, p) {
      // 水雾的位置是随机的，用 params.seed 定住；小溪 / 水潭的位置由 params.angle / len 决定
      seed(num(p.seed, 1));
      const { K } = ctx;
      const a = num(p.angle), len = num(p.len, 8);
      const ux = Math.cos(a), uz = Math.sin(a), rot = Math.atan2(ux, uz);
      const g = new THREE.Group();
      const stream = K.mesh(new THREE.BoxGeometry(1.3, .05, len + .8), themeMat(ctx, 'stream', 'fountain'), false);
      stream.position.set(-ux * len / 2, .02, -uz * len / 2); stream.rotation.y = rot; g.add(stream);
      const pondR = 1.5;
      const pond = K.mesh(new THREE.CylinderGeometry(pondR, pondR, .05, 24), themeMat(ctx, 'stream', 'fountain'), false);
      pond.position.set(-ux * len, .02, -uz * len); g.add(pond);
      const drop = GRASS_Y - ctx.seaY;
      for (const [w, off] of [[1.5, .7], [1.0, .9]] as [number, number][]) {
        const fall = new THREE.Mesh(new THREE.PlaneGeometry(w, drop), themeMat(ctx, 'fall', 'fountain'));
        fall.position.set(ux * off, -drop / 2, uz * off);
        fall.rotation.y = rot + Math.PI / 2;
        fall.renderOrder = 2;
        g.add(fall);
      }
      for (let i = 0; i < 7; i++) {
        const m = K.mesh(new THREE.IcosahedronGeometry(rr(.6, 1.2), 1), themeMat(ctx, 'cloud', 'white'), false);
        m.position.set(ux + rr(-1.2, 1.2), ctx.seaY - GRASS_Y + rr(.2, .9), uz + rr(-1.2, 1.2));
        g.add(m);
      }
      return g;
    },
  },
  {
    kind: 'lighthouse', name: '灯塔', category: '户外', landmark: true, blocker: 3.5,
    build(ctx, p) {
      const { K, mats } = ctx;
      const g = new THREE.Group();
      const tower = (r0: number, r1: number, h: number, y: number, mat: THREE.Material) => {
        const m = K.mesh(new THREE.CylinderGeometry(r1, r0, h, 28), mat); m.position.y = y + h / 2; g.add(m);
      };
      tower(1.4, 1.5, .35, 0, mats.stone);
      for (let i = 0; i < 5; i++) tower(1.1 - i * .1, 1.0 - i * .1, 1.2, .35 + i * 1.2, i % 2 ? mats.red : mats.white);
      tower(.72, .72, .16, 6.35, mats.dark);
      const lamp = K.mesh(new THREE.CylinderGeometry(.42, .42, .8, 16), K.G.bulb); lamp.position.y = 6.91; g.add(lamp);
      const cap = K.mesh(new THREE.ConeGeometry(.62, .7, 16), mats.red); cap.position.y = 7.66; g.add(cap);
      K.addLight(g, 0, 6.9, 0, 30, 30, '#ffd9a0');
      return g;
    },
  },
  {
    kind: 'pier', name: '码头', category: '户外', landmark: true, blocker: 3,
    build(ctx, p) {
      const { K, mats } = ctx;
      const g = new THREE.Group();
      const L = 10, y0 = -GRASS_Y; // 码头建在 y = 0（海面那一层），prop 的原点在草地上
      const deck = K.mesh(new THREE.BoxGeometry(2.2, .14, L), mats.wood); deck.position.set(0, -.3 + y0, L / 2 - 1); g.add(deck);
      for (let i = 0; i < 10; i++) {
        const plank = K.mesh(new THREE.BoxGeometry(2.24, .02, .04), mats.woodDark, false); plank.position.set(0, -.225 + y0, i * 1 - .5); g.add(plank);
      }
      for (const zz of [2.5, 5.5, 8.5]) for (const xx of [-1.05, 1.05]) {
        const post = K.mesh(new THREE.CylinderGeometry(.1, .1, 1.3, 10), mats.woodDark); post.position.set(xx, -.6 + y0, zz); g.add(post);
      }
      g.add(boat(ctx, 2.3, WATER_Y - .12 - GRASS_Y, 7.4, .08));
      return g;
    },
  },
  {
    kind: 'watchtower', name: '瞭望塔', category: '户外', landmark: true, blocker: 3,
    build(ctx, p) {
      const { K, mats } = ctx;
      const g = new THREE.Group();
      const H = 5.6, s = 1.05;
      for (const [dx, dz] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
        const leg = K.mesh(new THREE.CylinderGeometry(.1, .14, H, 8), mats.woodDark);
        leg.position.set(dx, H / 2, dz); g.add(leg);
      }
      for (const y of [1.6, 3.4]) {
        for (const [ax, az, len, rot] of [[0, -s, s * 2, 0], [0, s, s * 2, 0], [-s, 0, s * 2, Math.PI / 2], [s, 0, s * 2, Math.PI / 2]] as [number, number, number, number][]) {
          const b = K.mesh(new THREE.BoxGeometry(len, .1, .1), mats.wood); b.position.set(ax, y, az); b.rotation.y = rot; g.add(b);
        }
      }
      const deck = K.mesh(new THREE.BoxGeometry(3, .16, 3), mats.wood); deck.position.y = H; g.add(deck);
      const cabin = K.mesh(new THREE.BoxGeometry(2.4, 1.3, 2.4), mats.wood); cabin.position.y = H + .8; g.add(cabin);
      for (const [dx, dz, w, d] of [[0, 1.21, 1.3, .02], [0, -1.21, 1.3, .02], [1.21, 0, .02, 1.3], [-1.21, 0, .02, 1.3]]) {
        const win = K.mesh(new THREE.BoxGeometry(w, .55, d), mats.dark, false); win.position.set(dx, H + 1, dz); g.add(win);
      }
      const roof = K.mesh(new THREE.ConeGeometry(2.3, 1.3, 4), mats.red); roof.rotation.y = Math.PI / 4; roof.position.y = H + 2.1; g.add(roof);
      const ladder = K.mesh(new THREE.BoxGeometry(.5, H, .06), mats.woodDark); ladder.position.set(0, H / 2, s + .25); ladder.rotation.x = -.12; g.add(ladder);
      return g;
    },
  },
  {
    kind: 'windmill', name: '风车', category: '户外', landmark: true, blocker: 3,
    build(ctx, p) {
      const { K, mats } = ctx;
      const g = new THREE.Group();
      const tower = K.mesh(new THREE.CylinderGeometry(.85, 1.45, 5.6, 8), mats.white); tower.position.y = 2.8; g.add(tower);
      const cap = K.mesh(new THREE.ConeGeometry(1.15, 1.3, 8), mats.red); cap.position.y = 6.25; g.add(cap);
      const door = K.mesh(new THREE.BoxGeometry(.7, 1.2, .1), mats.woodDark, false); door.position.set(0, .6, 1.38); door.rotation.x = -.1; g.add(door);
      const hub = new THREE.Group(); hub.position.set(0, 5.3, 1.05); g.add(hub);
      const axle = K.mesh(new THREE.CylinderGeometry(.14, .14, .5, 10), mats.dark); axle.rotation.x = Math.PI / 2; hub.add(axle);
      for (let i = 0; i < 4; i++) {
        const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + .3; hub.add(arm);
        const spar = K.mesh(new THREE.BoxGeometry(.1, 3.2, .06), mats.woodDark); spar.position.y = 1.6; arm.add(spar);
        const sail = K.mesh(new THREE.BoxGeometry(.7, 2.4, .03), mats.hull); sail.position.set(.4, 1.9, .03); arm.add(sail);
      }
      return g;
    },
  },
  {
    kind: 'igloo', name: '冰屋', category: '户外', landmark: true, blocker: 2.6,
    build(ctx, p) {
      const { K } = ctx;
      const g = new THREE.Group();
      const dome = K.mesh(new THREE.SphereGeometry(1.6, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), themeMat(ctx, 'floe', 'snowCap')); g.add(dome);
      const tunnel = K.mesh(new THREE.CylinderGeometry(.7, .7, 1.4, 14, 1, false, -Math.PI / 2, Math.PI), themeMat(ctx, 'floe', 'snowCap'));
      tunnel.rotation.x = Math.PI / 2; tunnel.position.set(0, 0, 1.6); g.add(tunnel);
      const door = K.mesh(new THREE.CircleGeometry(.5, 14, 0, Math.PI), themeMat(ctx, 'coal', 'charcoal'), false);
      door.position.set(0, .01, 2.31); g.add(door);
      return g;
    },
  },
  {
    kind: 'snowman', name: '雪人', category: '户外',
    build(ctx, p) {
      const { K } = ctx;
      const g = new THREE.Group();
      const ball = (r: number, y: number) => { const m = K.mesh(new THREE.SphereGeometry(r, 16, 12), themeMat(ctx, 'floe', 'snowCap')); m.position.y = y; g.add(m); };
      ball(.42, .38); ball(.3, .98); ball(.21, 1.42);
      const nose = K.mesh(new THREE.ConeGeometry(.05, .26, 8), themeMat(ctx, 'carrot', 'fruitO')); nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.43, .3); g.add(nose);
      for (const s of [-1, 1]) { const e = K.mesh(new THREE.SphereGeometry(.028, 8, 6), themeMat(ctx, 'coal', 'charcoal')); e.position.set(s * .07, 1.5, .18); g.add(e); }
      const scarf = K.mesh(new THREE.TorusGeometry(.22, .05, 6, 18), themeMat(ctx, 'scarf', 'red')); scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.23; g.add(scarf);
      return lifted(g, PAVE_Y);
    },
  },
  {
    kind: 'balloon', name: '热气球', category: '户外',
    build(ctx, p) {
      const { K, mats } = ctx;
      const g = new THREE.Group();
      const env = K.mesh(new THREE.SphereGeometry(1.7, 20, 14), themeMat(ctx, 'balloon', 'mustard')); env.scale.y = 1.18; env.position.y = 3.2; g.add(env);
      const band = K.mesh(new THREE.TorusGeometry(1.66, .12, 8, 28), themeMat(ctx, 'balloonBand', 'red')); band.rotation.x = Math.PI / 2; band.position.y = 3.1; g.add(band);
      const neck = K.mesh(new THREE.ConeGeometry(.7, .9, 14), themeMat(ctx, 'balloon', 'mustard')); neck.rotation.x = Math.PI; neck.position.y = 1.35; g.add(neck);
      const basket = K.mesh(new THREE.BoxGeometry(.7, .5, .7), mats.wood); basket.position.y = .25; g.add(basket);
      for (const [dx, dz] of [[-.3, -.3], [.3, -.3], [-.3, .3], [.3, .3]]) {
        const rope = K.mesh(new THREE.CylinderGeometry(.015, .015, 1.1, 4), mats.dark, false); rope.position.set(dx, .95, dz); g.add(rope);
      }
      return lifted(g, 4 - GRASS_Y);
    },
  },

  // ---------------- 目录里的家具 ----------------
  {
    kind: 'bench', name: '长凳', category: '户外',
    params: [pnum('w', '宽度', .8, 2, .1, 1.6), psel('wood', '木色', WOODS, 'oak')],
    build(ctx, p) {
      const g = new THREE.Group();
      g.add(ctx.catalog.bench.build({ w: num(p.w, 1.6), wood: str(p.wood, 'oak') }));
      return lifted(g, PAVE_Y);
    },
  },
  {
    kind: 'planter', name: '花槽', category: '植物',
    params: [pnum('w', '长度', .6, 2.4, .1, 1.2)],
    build(ctx, p) {
      // 目录里的花槽自己会用随机流摆花，所以先按 params.seed 定位
      seed(num(p.seed, 1));
      const g = new THREE.Group();
      g.add(ctx.catalog.planter.build({ w: num(p.w, 1.2) }));
      return lifted(g, PAVE_Y);
    },
  },
  {
    kind: 'lamp', name: '庭院灯', category: '户外',
    build(ctx) {
      return ctx.catalog.lampPost.build({});
    },
  },
];

/** kind → 定义（存盘里可能有老版本 / 不认识的 kind，查不到要给 undefined） */
const KIND_BY_ID: Record<string, PropKind | undefined> = Object.create(null);

for (const k of KINDS) KIND_BY_ID[k.kind] = k;

export function propKind(kind: string): PropKind | undefined {
  return KIND_BY_ID[kind];
}

/** 所有摆设种类（别改返回的数组，摆放面板按这个顺序显示） */
export function propKinds(): PropKind[] {
  return KINDS;
}

// =====================================================================
// 摆放数据 ←→ 几何
// =====================================================================

/** 和 random.ts 的 seedFromString 同一个散列，但不能用那个函数——它会改共享的随机流 */
function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 一次摆放（place 的调用序列）里把 opts 变成一条 PlacedProp：
 * id 和 params.seed 都由「岛种子 + kind + 位置」推出来，同一座岛每次烘焙得到同一批 id。
 */
function makeProp(region: WorldRegion, kind: string, x: number, z: number, opts: NonNullable<Parameters<PropPlace>[3]>, seen: Map<string, number>): PlacedProp {
  const at = `${kind}@${x.toFixed(3)},${z.toFixed(3)}`;
  const n = seen.get(at) || 0;
  seen.set(at, n + 1);
  const key = `${region.seed}:${at}:${n}`;
  const prop: PlacedProp = {
    id: `${kind}-${hash32(key).toString(36)}`,
    kind,
    pos: [x, z],
    params: { ...(opts.params || {}), seed: (hash32(`${kind}:${key}`) || 1) },
  };
  if (opts.rot !== undefined) prop.rot = opts.rot;
  return prop;
}

/**
 * 一条摆设的数据：id 和 params.seed 由「岛种子 + kind + 位置」推出，和摆放时是同一条规则。
 * 给「先算好位置、再建摆设」的调用方用（扩岛补种就是这样：位置由撒点器算，种什么由主题配方定）。
 */
export function placedProp(region: WorldRegion, kind: string, x: number, z: number, opts: { rot?: number; params?: Record<string, unknown> } = {}): PlacedProp {
  return makeProp(region, kind, x, z, opts, new Map());
}

/** 登记地标和阻挡（旧 decorate 里写在各个装饰函数末尾的那两行） */
export function registerProp(ctx: ThemeCtx, p: PlacedProp): void {
  const kind = propKind(p.kind);
  if (!kind) return;
  const list = p.params?.blockers;
  if (Array.isArray(list)) {
    for (const b of list) {
      if (!b || typeof b !== 'object') continue;
      ctx.blockers.push({ x: p.pos[0] + num('dx' in b ? b.dx : 0), z: p.pos[1] + num('dz' in b ? b.dz : 0), r: num('r' in b ? b.r : 0) });
    }
  } else if (kind.blocker) {
    ctx.blockers.push({ x: p.pos[0], z: p.pos[1], r: kind.blocker });
  }
  if (kind.landmark) ctx.landmarks.push({ kind: kind.kind, x: p.pos[0], z: p.pos[1], angle: num(p.params?.angle) });
}

/** 按数据建几何（原点在 prop 的位置上，y = 0 是地面；调用方负责 position / rotation / 入场景） */
export function buildProp(ctx: ThemeCtx, p: PlacedProp): THREE.Object3D | null {
  const kind = propKind(p.kind);
  return kind ? kind.build(ctx, p.params || {}) : null;
}

/**
 * 摆放函数：
 *   sink 为 null 时立刻建几何塞进 ctx.raw（程序化路径，今天的样子）；
 *   给了 sink 就只记录（烘焙 / 不渲染）。
 * 建几何前后给随机流存档 / 读档：build() 里常有 seed(params.seed)（树的团块、岩石的棱角），
 * 不保护的话，同一段摆放代码在「建几何」和「只记录」两条路上会抽出不同的位置。
 */
function placer(ctx: ThemeCtx, sink: PlacedProp[] | null): PropPlace {
  const seen = new Map<string, number>();
  return (kind, x, z, opts = {}) => {
    if (!KIND_BY_ID[kind]) return;
    const p = makeProp(ctx.region, kind, x, z, opts, seen);
    registerProp(ctx, p);
    if (sink) { sink.push(p); return; }
    const stream = getState();
    let obj: THREE.Object3D | null = null;
    try {
      obj = buildProp(ctx, p);
    } finally {
      setState(stream);
    }
    if (!obj) return;
    // 落位：草地 / 水面 / 空中（见 propBaseY），再加上 build() 根节点自己的抬高
    obj.position.set(x, propBaseY(ctx.seaY, p.params) + obj.position.y, z);
    if (p.rot) obj.rotation.y = p.rot;
    ctx.raw.add(obj);
  };
}

/**
 * 旧渲染器的兼容入口：等价于以前的 theme.decorate(ctx)——按同一份摆放代码立刻建几何。
 * 等渲染层改成走 region.props 之后就可以删掉（ThemePack.decorate）。
 */
export function decorateNow(pack: ThemePack, ctx: ThemeCtx): void {
  pack.props(ctx, placer(ctx, null));
}

/**
 * 把一座岛的摆设烘焙成数据（第一次编辑 / 附魔这座岛时用，结果写给 region.props）。
 *
 * 跑的是同一份 props()、同一个 ctx 的地形参数，所以算出来的位置和程序化渲染的那一批完全一致；
 * 只记录不建几何（不分配任何 mesh）。
 * 注意：ctx 必须是「刚建好、还没跑过 decorate」的那一份（blockers 里只有广场）——摆放是会读
 * blockers 的，跑到一半的 ctx 会让结果和岛上看到的不一样。烘焙在副本上跑，不会把地标 / 阻挡
 * 写回调用方的 ctx，调用方接下来照常 decorate。
 */
export function bakeRegionProps(region: WorldRegion, ctx: ThemeCtx): PlacedProp[] {
  const out: PlacedProp[] = [];
  const scratch: ThemeCtx = { ...ctx, blockers: ctx.blockers.slice(), landmarks: ctx.landmarks.slice() };
  getTheme(region.theme).props(scratch, placer(scratch, out));
  return out;
}
