// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createKit } from '../src/kit';
import { createCatalog } from '../src/catalog';
import { getTheme, THEMES } from '../src/themes';
import { commonMats, WATER_Y, type ThemeCtx } from '../src/themes/common';
import { buildProp, propKinds } from '../src/props';
import { PLAZA_R, regionLift, type WorldRegion } from '../src/world';

/**
 * 摆设的材质必须每个主题都取得到。
 *
 * 有些材质只有某一个主题才有（池塘是森林的、浮冰 / 雪山 / 雪人是雪山的、云和瀑布是浮空岛的），
 * 而缩略图把所有主题的材质合在一起用（见 thumbs.ts 的 propCtx），所以缺材质在预览里看不出来——
 * 只有把摆设摆到别的主题的岛上，three 才会用默认的白材质顶上，整块摆设变成一片白。
 * 这个用例把「每个 kind × 每个主题」都建一遍，任何一处漏掉都会在这里失败。
 */

function stubCanvas2D() {
  const sample = document.createElement('canvas');
  const proto = Object.getPrototypeOf(sample) as { getContext(type: string): unknown } | null;
  if (!proto) return;
  proto.getContext = () => ({
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData() {}, drawImage() {},
    measureText: () => ({ width: 8 }), setTransform() {}, scale() {}, fillText() {}, strokeText() {},
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    arc() {}, beginPath() {}, bezierCurveTo() {}, clip() {}, closePath() {}, ellipse() {},
    fill() {}, fillRect() {}, lineTo() {}, moveTo() {}, quadraticCurveTo() {}, rect() {},
    restore() {}, rotate() {}, save() {}, stroke() {}, strokeRect() {}, translate() {},
  });
}
stubCanvas2D();

const kit = createKit({ maxAniso: 1 });
const catalog = createCatalog(kit, 2.8);

function ctxFor(themeId: string): ThemeCtx {
  const region: WorldRegion = { id: 'r', name: '', theme: themeId, seed: 1, origin: [0, 0], palaces: [] };
  const theme = getTheme(themeId);
  return {
    K: kit, catalog, region, mats: { ...commonMats(kit), ...theme.materials(kit) },
    land: new THREE.Group(), raw: new THREE.Group(), seaY: WATER_Y - regionLift(region),
    R: () => 30, center: [0, 0], maxR: 30, lots: [], roads: null,
    blockers: [{ x: 0, z: 0, r: PLAZA_R + 2.5 }], landmarks: [{ kind: 'plaza', x: 0, z: 0, angle: 0 }],
  };
}

describe('摆设：每个主题都能取到材质', () => {
  for (const theme of THEMES) {
    it(`${theme.id}：没有摆设会退到 three 的默认白材质`, () => {
      const ctx = ctxFor(theme.id);
      for (const kind of propKinds()) {
        const params: Record<string, unknown> = { seed: 1 };
        for (const spec of kind.params || []) params[spec.key] = spec.def;
        const obj = buildProp(ctx, { id: kind.kind, kind: kind.kind, pos: [0, 0], params });
        if (!obj) continue;
        const blanks: string[] = [];
        obj.traverse(o => {
          if (!(o as THREE.Mesh).isMesh) return;
          const m = (o as THREE.Mesh).material;
          // MeshBasicMaterial 不是这套场景用的材质，出现它只可能是「材质没取到」时的兜底默认值
          for (const one of Array.isArray(m) ? m : [m]) if (!one || one.type === 'MeshBasicMaterial') blanks.push(o.name || o.type);
        });
        expect(blanks, `${kind.kind} 在 ${theme.id} 上缺材质`).toEqual([]);
      }
    });
  }
});
