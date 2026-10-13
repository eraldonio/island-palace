import * as THREE from 'three';
import { rand, rr } from '../random';
import {
  GRASS_Y, LEAF, type ThemePack, outline, flatPatch, extrudeLand, plazaBase, plazaBenches, edgeSpot,
  lampPosts, scatter, alongShore, shrubAt, seaRocks,
} from './common';
import { decorateNow } from '../props';

/** 海岛：沙滩、浅滩、灯塔、码头和小船 */
export const island: ThemePack = {
  id: 'island',
  name: '海岛',
  desc: '沙滩、灯塔和码头',
  icon: '🏝',
  colors: ['#a4b27f', '#ecd9b2', '#7cc4c0'],

  materials(K) {
    const std = (color: string, roughness = .9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
    const lawn = K.TEX.lawn.clone();
    lawn.needsUpdate = true;
    lawn.repeat.set(.36, .36);
    return {
      grass: std('#ffffff', 1, { map: lawn }),
      cliff: std('#b39873', .95),
      sand: std('#ecd9b2', .95),
      shallow: std('#a6ddd2', .3),
      paver: std('#e4d8c6', .95),
      curb: std('#cdbfa9', .95),
    };
  },

  terrain(ctx) {
    const { mats } = ctx;
    flatPatch(ctx, outline(ctx, 9), ctx.seaY + .02, mats.shallow);
    extrudeLand(ctx, outline(ctx, 3.4), -.55, .7, [mats.sand, mats.sand]);
    extrudeLand(ctx, outline(ctx, 0), GRASS_Y, .75, [mats.grass, mats.cliff]);
  },

  plaza(ctx) {
    plazaBase(ctx);
  },

  props(ctx, place) {
    const LEAVES = [LEAF.leaf, LEAF.leafLight, LEAF.leafDark];
    const FLOWERS = ['terracotta', 'mustard', 'rose'];
    place('fountain', 0, 0, { params: { water: 'fountain' } });
    plazaBenches(place);
    const lh = edgeSpot(ctx, -18, 2.6, 3);
    if (lh) place('lighthouse', lh.x, lh.z);
    const p = edgeSpot(ctx, 95, 1.2, 3);
    if (p) place('pier', p.x, p.z, { rot: Math.atan2(Math.cos(p.a), Math.sin(p.a)), params: { angle: p.a } });
    lampPosts(ctx, place);
    scatter(ctx, {
      key: 'tree', spacing: 4.6, max: 160, pad: 2, keep: c => .42 + c * .24,
      place: (x, z) => {
        const h = rr(2.5, 3.9), variant = Math.floor(rand() * 3), kind = rand();
        if (kind < .72) place('tree', x, z, { rot: rand() * Math.PI * 2, params: { h, variant } });
        else shrubAt(place, x, z, rr(.35, .6), LEAVES[variant], LEAVES[(variant + 1) % 3]);
      },
    });
    alongShore(ctx, 'shore', 4.2, [1, 1.8], (x, z, i) => {
      if (rand() < .3) return;
      const s = rr(.35, .6);
      shrubAt(place, x, z, s, LEAVES[i % 3], LEAVES[(i + 1) % 3]);
      if (rand() < .35) place('flower', x + .2, z + .1, { params: { color: FLOWERS[i % 3], h: s * 1.1 } });
    });
    seaRocks(ctx, place, 9, 'rock');
  },

  decorate(ctx) {
    decorateNow(island, ctx);
  },
};
