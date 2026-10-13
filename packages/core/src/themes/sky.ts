import * as THREE from 'three';
import { rand, rr, seedFromString } from '../random';
import {
  GRASS_Y, LEAF, type ThemePack, type ThemeCtx, type PropPlace, outline, extrudeLand, addLand, plazaBase, plazaBenches, edgeSpot,
  lampPosts, scatter, alongShore, shrubAt, jitter,
} from './common';
import { decorateNow } from '../props';

/** 浮空岛：整座岛悬在海面上方，岛底是倒垂的岩体，边缘有瀑布，四周飘着云；地标是风车和热气球 */
export const sky: ThemePack = {
  id: 'sky',
  name: '浮空岛',
  desc: '悬在云上，瀑布、风车和热气球',
  icon: '☁️',
  colors: ['#b7d58f', '#ffffff', '#8fd0e6'],
  lift: 14,
  margin: 7,
  minR: 20,

  materials(K) {
    const std = (color: string, roughness = .9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
    const lawn = K.TEX.lawn.clone();
    lawn.needsUpdate = true;
    lawn.repeat.set(.36, .36);
    return {
      grass: std('#eef8d8', 1, { map: lawn }),
      rim: std('#a08f7a', .95, { flatShading: true }),
      under: std('#8b7e6f', .95, { flatShading: true }),
      paver: std('#e4d8c6', .95),
      curb: std('#cdbfa9', .95),
      stream: std('#8fd0e6', .08, { metalness: .1 }),
      fall: std('#e6f6ff', .3, { emissive: '#bfe6ff', emissiveIntensity: .3, transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false }),
      cloud: std('#ffffff', 1, { flatShading: true, emissive: '#ffffff', emissiveIntensity: .12 }),
      blossom: std('#f2b8c6', .8, { flatShading: true }),
      balloon: std('#d7a342', .7),
      balloonBand: std('#c4553d', .7),
    };
  },

  terrain(ctx) {
    const { mats } = ctx;
    // 厚厚的一层岩壁 + 较平的岛底 + 岛边一圈倒垂的石笋（从斜上方俯视时，平缓的岛底是看不见的，石笋够陡才看得见）
    extrudeLand(ctx, outline(ctx, 0), GRASS_Y, 2.2, [mats.grass, mats.rim], .5);
    addLand(ctx, new THREE.Mesh(undersideGeometry(ctx), mats.under), true);
    hangingRocks(ctx);
  },

  plaza(ctx) {
    plazaBase(ctx);
  },

  props(ctx, place) {
    const LEAVES = [LEAF.leafLight, LEAF.leaf, LEAF.leafOlive];
    const FLOWERS = ['blossom', 'mustard', 'rose'];
    place('fountain', 0, 0, { params: { water: 'fountain' } });
    plazaBenches(place);
    const w = edgeSpot(ctx, -30, 3, 3.5);
    if (w) place('windmill', w.x, w.z, { rot: Math.PI / 4 });
    const f = edgeSpot(ctx, 70, .2, 3);
    if (f) {
      // 瀑布挂在崖边：地标在崖口，小溪和水潭朝岛内伸 len 米（阻挡也跟着走）
      const r = ctx.R(f.a), ux = Math.cos(f.a), uz = Math.sin(f.a), len = 8;
      place('waterfall', ctx.center[0] + ux * r, ctx.center[1] + uz * r, {
        params: { angle: f.a, len, blockers: [{ dx: -ux * len / 2, dz: -uz * len / 2, r: 2 }, { dx: -ux * len, dz: -uz * len, r: 2.5 }] },
      });
    }
    lampPosts(ctx, place, 6);
    scatter(ctx, {
      key: 'sky-tree', spacing: 4.4, max: 150, pad: 2, keep: c => .45 + c * .22,
      place: (x, z) => {
        const k = rand();
        if (k < .55) {
          const h = rr(2.4, 3.6), rot = rand() * Math.PI * 2;
          place('tree', x, z, { rot, params: { h, variant: 1 } });
        } else if (k < .82) place('blossom-tree', x, z, { params: { h: rr(2.2, 3.2) } });
        else shrubAt(place, x, z, rr(.35, .55), LEAVES[0], LEAVES[2]);
      },
    });
    alongShore(ctx, 'flowers', 3.8, [.8, 1.6], (x, z, i) => {
      if (rand() < .35) return;
      const s = rr(.3, .5);
      shrubAt(place, x, z, s, LEAVES[i % 3], LEAVES[(i + 1) % 3]);
      if (rand() < .6) place('flower', x + .15, z + .1, { params: { color: FLOWERS[i % 3], h: .5 } });
    });
    clouds(ctx, place);
    balloon(ctx, place);
  },

  decorate(ctx) {
    decorateNow(sky, ctx);
  },
};

/** 岛底：从轮廓向下收成一个参差的尖，低多边形岩石 */
function undersideGeometry(ctx: ThemeCtx) {
  seedFromString('under:' + ctx.region.seed);
  const [cx, cz] = ctx.center;
  const N = 56, K = 5, top = GRASS_Y - 2.3, tip = top - (ctx.maxR * .22 + 3);
  const rings: THREE.Vector3[][] = [];
  for (let k = 0; k <= K; k++) {
    const t = k / K, ring: THREE.Vector3[] = [];
    const shrink = 1 - Math.pow(t, .75);
    const y = top + (tip - top) * Math.pow(t, 1.25);
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2;
      const r = k === 0 ? ctx.R(a) - .2 : ctx.R(a) * shrink * rr(.82, 1.08);
      ring.push(new THREE.Vector3(cx + Math.cos(a) * r, y + (k && k < K ? rr(-.8, .8) : 0), cz + Math.sin(a) * r));
    }
    rings.push(ring);
  }
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < N; i++) {
      const a = rings[k][i], b = rings[k][(i + 1) % N], c = rings[k + 1][i], d = rings[k + 1][(i + 1) % N];
      // 法线朝外、朝下（从侧面和下方看得见）
      tri(a, b, c); tri(b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
  g.computeVertexNormals();
  return g;
}

/** 岛底倒垂的石笋：中间一根大的，边缘一圈小的，越靠外越短（生几何：是岛体的一部分） */
function hangingRocks(ctx: ThemeCtx) {
  const { K, mats } = ctx, [cx, cz] = ctx.center;
  seedFromString('spikes:' + ctx.region.seed);
  const top = GRASS_Y - 2.1, maxDepth = -ctx.seaY - 4;
  const spike = (x: number, z: number, r: number, depth: number) => {
    const geo = jitter(new THREE.ConeGeometry(r, depth, 7, 3), r * .12, -depth / 2);
    const m = K.mesh(geo, mats.under);
    m.rotation.x = Math.PI; m.rotation.y = rr(0, 3);
    m.position.set(x, top - depth / 2, z);
    ctx.raw.add(m);
  };
  spike(cx, cz, ctx.maxR * .42, Math.min(maxDepth, ctx.maxR * .55 + 6));
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2 + rr(-.12, .12), R = ctx.R(a);
    const r = rr(2.8, 5.6), d = R * rr(.45, .8);
    if (d + r > R - .5) continue;
    const depth = Math.min(maxDepth, rr(5, 10) + (1 - d / R) * 9);
    spike(cx + Math.cos(a) * d, cz + Math.sin(a) * d, r, depth);
  }
}

/** 云：岛下方一圈，远处（画面上方）几朵略高。先把每团云的位置算完再摆（云的 build 会用随机流团云块） */
function clouds(ctx: ThemeCtx, place: PropPlace) {
  const [cx, cz] = ctx.center;
  seedFromString('clouds:' + ctx.region.seed);
  const list: { x: number; z: number; y: number; n: number }[] = [];
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * Math.PI * 2 + rr(-.2, .2);
    const back = Math.sin(a + Math.PI / 4) < -.3; // 远离镜头的一侧
    const r = ctx.R(a) + rr(3, 12), y = back ? rr(-1, 2.5) : rr(-9, -4);
    list.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, y, n: 3 + Math.floor(rand() * 3) });
  }
  for (const c of list) place('cloud', c.x, c.z, { params: { y: c.y, n: c.n } });
}

/** 热气球：固定在岛的东南角外边，4 米高 */
function balloon(ctx: ThemeCtx, place: PropPlace) {
  const a = 150 * Math.PI / 180, r = ctx.R(a) + 5;
  place('balloon', ctx.center[0] + Math.cos(a) * r, ctx.center[1] + Math.sin(a) * r);
}
