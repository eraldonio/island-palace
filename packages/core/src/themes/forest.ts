import * as THREE from 'three';
import { rand, rr, seedFromString } from '../random';
import {
  GRASS_Y, LEAF, type ThemePack, outline, flatPatch, extrudeLand, plazaBase, plazaBenches, edgeSpot, innerSpot,
  lampPosts, plantScatter, alongShore, shrubAt, seaRocks,
} from './common';
import { decorateNow } from '../props';

/** 森林：卵石滩、茂密的针叶林、古树广场、瞭望塔、林间池塘 */
export const forest: ThemePack = {
  id: 'forest',
  name: '森林',
  desc: '古树、瞭望塔和林间池塘',
  icon: '🌲',
  colors: ['#7f9a5c', '#a39b8e', '#44694f'],
  margin: 9,

  materials(K) {
    const std = (color: string, roughness = .9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
    const lawn = K.TEX.lawn.clone();
    lawn.needsUpdate = true;
    lawn.repeat.set(.36, .36);
    return {
      grass: std('#b3c98f', 1, { map: lawn }),
      cliff: std('#7b7163', .95),
      pebble: std('#a39b8e', .95),
      shallow: std('#86c0b0', .3),
      paver: std('#cfc2aa', .95),
      curb: std('#a99a82', .95),
      pond: std('#5f9c96', .06, { metalness: .1 }),
      lily: std('#6f9a4e', .8, { side: THREE.DoubleSide }),
      boulder: std('#8f877b', .95, { flatShading: true }),
      moss: std('#6e8c4a', .95, { flatShading: true }),
    };
  },

  terrain(ctx) {
    const { mats } = ctx;
    flatPatch(ctx, outline(ctx, 7), ctx.seaY + .02, mats.shallow);
    extrudeLand(ctx, outline(ctx, 2.0), -.62, .6, [mats.pebble, mats.pebble], .4);
    extrudeLand(ctx, outline(ctx, 0), GRASS_Y, .75, [mats.grass, mats.cliff]);
  },

  plaza(ctx) {
    plazaBase(ctx);
  },

  props(ctx, place) {
    place('fountain', 0, 0, { params: { water: 'fountain' } });
    plazaBenches(place, false);
    // 古树：一圈石头围着一棵大树
    seedFromString('old-tree:' + ctx.region.seed);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, s = rr(.28, .42);
      const rx = rr(0, 3), ry = rr(0, 3);
      place('boulder', Math.cos(a) * 2.1, Math.sin(a) * 2.1, { params: { mat: 'boulder', s, y: .1 + s * .4, sy: .7, rx, ry } });
    }
    place('tree', 0, 0, { rot: rand() * Math.PI * 2, params: { h: 7.4, variant: 2 } });
    const t = edgeSpot(ctx, -35, 3.2, 3.5);
    if (t) {
      // 塔的朝向自己一条种子（以前是接着前面的随机流抽的，改主题后不能这么依赖）
      seedFromString('watchtower:' + ctx.region.seed);
      place('watchtower', t.x, t.z, { rot: rand() * Math.PI });
    }
    const pond = innerSpot(ctx, 4.2, 'pond');
    if (pond) {
      seedFromString('pond:' + ctx.region.seed);
      const r = rr(2.6, 3.4);
      // 池塘半径是随机的，阻挡半径也跟着 r 变，所以显式给
      place('pond', pond.x, pond.z, { params: { r, blockers: [{ r: r + 1.2 }] } });
      seedFromString('pond-reeds:' + ctx.region.seed);
      for (let i = 0; i < 10; i++) {
        const a = rr(-.8, .8) + Math.PI * .75, d = r * rr(.9, 1.05), h = rr(.6, 1.1);
        place('reed', pond.x + Math.cos(a) * d, pond.z + Math.sin(a) * d * .78, { params: { h } });
      }
    }
    lampPosts(ctx, place, 6);
    // 植被：噪声撒点（针叶林成片、白桦 / 阔叶树混生、林间空地不长东西）
    plantScatter(ctx, 'forest', place);
    // 倒下的原木
    seedFromString('logs:' + ctx.region.seed);
    for (let i = 0; i < 3; i++) {
      const s = innerSpot(ctx, 1.6, 'log' + i);
      if (!s) continue;
      place('log', s.x, s.z, { rot: rr(0, 3) });
    }
    alongShore(ctx, 'boulders', 3.4, [.4, 1.2], (x, z, i) => {
      if (rand() < .35) return;
      const s = rr(.35, .8);
      const rx = rr(0, 3), ry = rr(0, 3);
      place('boulder', x, z, { params: { mat: 'boulder', s, y: s * .25, sy: .65, rx, ry } });
      if (i % 3 === 0) shrubAt(place, x + .8, z + .3, rr(.3, .45), LEAF.leafDark, LEAF.leaf);
    });
    seaRocks(ctx, place, 12, 'boulder');
  },

  decorate(ctx) {
    decorateNow(forest, ctx);
  },
};
