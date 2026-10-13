import * as THREE from 'three';
import { rand, rr, seed, seedFromString } from '../random';
import {
  GRASS_Y, type ThemePack, type ThemeCtx, type PropPlace, outline, flatPatch, extrudeLand, plazaBase, plazaBenches, edgeSpot, innerSpot,
  lampPosts, scatter, coniferAt, alongShore,
} from './common';
import { decorateNow } from '../props';

/** 雪山：冰岸、积雪的针叶林、海边的雪山、冰冻的喷泉、雪人、冰屋、浮冰 */
export const snow: ThemePack = {
  id: 'snow',
  name: '雪山',
  desc: '雪山、冰屋和浮冰',
  icon: '🏔',
  colors: ['#eef3f7', '#cfe4ec', '#44694f'],
  margin: 9,
  roofSnow: true,

  materials(K) {
    const std = (color: string, roughness = .9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
    const tex = snowTexture();
    const snowMat = std('#ffffff', .92, { map: tex });
    snowMat.userData.ownedMap = tex;
    return {
      snow: snowMat,
      cliff: std('#c3d2dd', .8, { flatShading: true }),
      ice: std('#dbeef5', .18, { metalness: .05 }),
      shallow: std('#c3e3ea', .25),
      paver: std('#cdd5de', .9),
      curb: std('#a9b4bf', .9),
      frozen: std('#cfe8f0', .05, { metalness: .1 }),
      mountain: std('#ffffff', .95, { flatShading: true, vertexColors: true }),
      floe: std('#f2f8fb', .5, { flatShading: true }),
      carrot: std('#e07a2e', .7),
      scarf: std('#c4553d', .9),
      coal: std('#2b2b2b', .6),
    };
  },

  terrain(ctx) {
    const { mats } = ctx;
    flatPatch(ctx, outline(ctx, 10), ctx.seaY + .02, mats.shallow);
    extrudeLand(ctx, outline(ctx, 2.8), -.62, .6, [mats.ice, mats.ice], .5);
    extrudeLand(ctx, outline(ctx, 0), GRASS_Y, .75, [mats.snow, mats.cliff]);
  },

  plaza(ctx) {
    plazaBase(ctx);
  },

  props(ctx, place) {
    place('fountain', 0, 0, { params: { water: 'frozen' } });
    plazaBenches(place, false);
    place('snowman', 3.3, -1.6, { rot: Math.atan2(4, 4) });
    const m = edgeSpot(ctx, -140, 5.5, 7);
    if (m) place('mountain', m.x, m.z, { params: { ang: Math.atan2(m.z - ctx.center[1], m.x - ctx.center[0]) + .9 } });
    const ig = innerSpot(ctx, 2.6, 'igloo');
    if (ig) place('igloo', ig.x, ig.z);
    lampPosts(ctx, place, 6);
    scatter(ctx, {
      key: 'pine', spacing: 4, max: 220, pad: 1.8, keep: c => .5 + c * .22,
      place: (x, z) => {
        if (rand() < .86) coniferAt(place, x, z, rr(2.8, 4.8), true);
        else {
          const s = rr(.35, .7);
          place('boulder', x, z, { params: { mat: 'floe', s, y: s * .3, sy: .6 } });
        }
      },
    });
    alongShore(ctx, 'snowdrift', 3.6, [.5, 1.3], (x, z) => {
      if (rand() < .4) return;
      const s = rr(.4, .8), rot = rr(0, 3);
      place('snowdrift', x, z, { rot, params: { s } });
    });
    floes(ctx, place);
  },

  decorate(ctx) {
    decorateNow(snow, ctx);
  },
};

function snowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f5f8'; g.fillRect(0, 0, 256, 256);
  seed(4242);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rand() < .5 ? `rgba(170,190,212,${rr(.05, .16)})` : `rgba(255,255,255,${rr(.4, .9)})`;
    const s = rr(1, 3);
    g.fillRect(rand() * 256, rand() * 256, s, s);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(.3, .3);
  return t;
}

/** 海面上的浮冰：先把每一块的位置 / 大小 / 朝向算完，再摆（floe 的 build 会用随机流抖棱角） */
function floes(ctx: ThemeCtx, place: PropPlace) {
  const [cx, cz] = ctx.center;
  seedFromString('floes:' + ctx.region.seed);
  const list: { x: number; z: number; s: number; rot: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const a = rr(0, Math.PI * 2), r = ctx.R(a) + rr(4, 13);
    const s = rr(.8, 2.2);
    list.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, s, rot: rr(0, 3) });
  }
  for (const f of list) place('floe', f.x, f.z, { rot: f.rot, params: { s: f.s } });
}
