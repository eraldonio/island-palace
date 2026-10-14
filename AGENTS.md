# AGENTS.md — working notes for this repo

Island Palace: a standalone 3D memory-palace builder (fork of KMind Palace). Vanilla TypeScript +
three.js, no React, no build step in dev. UI source language is **Chinese**; English is a translation
layer. See `README.md` / `README.zh-CN.md` for the product, `docs/` for feature specs.

## Commands

```bash
pnpm install                                    # Node 22+
pnpm -C packages/core dev                       # vite, http://127.0.0.1:5181 (falls back to 5182+ if the port is busy)
pnpm -C packages/core typecheck                 # tsc --noEmit
pnpm -C packages/core test                      # vitest run
pnpm -C packages/core i18n                      # missing-translation report; VERBOSE=1 lists the strings
```

`pnpm typecheck && pnpm test` gating is expected before calling anything done. Tests use vitest;
only `test/dom.test.ts` and `test/props.test.ts` opt into `// @vitest-environment happy-dom`, so
**anything reachable from `src/world.ts` must work without a DOM** (that is why `src/notes.ts` has a
hand-written HTML parser instead of `DOMParser`).

## Where things live

| Area | File |
| --- | --- |
| World document (regions, palaces, props, notes), versioning, migrations | `packages/core/src/world.ts` |
| Palace document format | `src/schema.ts` |
| Palace build (rooms, walls, items) | `src/build.ts`, `src/kit.ts`, `src/catalog.ts` |
| Region/island scene: terrain, props batches, shell picking, ground ray | `src/world-layer.ts` |
| **Region-level interaction** (props, notes, placing, selecting, drag, cards, undo) | `src/town-controller.ts` |
| Palace-level item editing | `src/editor.ts` |
| Top-level view, DOM root, render loop, `ui` refs, `invalidate` | `src/view.ts` |
| Sticky notes (parse/sanitise/canvas/`NoteLayer`) | `src/notes.ts` |
| CSS (one template string), DOM builders (`html`, `rich`) | `src/styles.ts`, `src/dom.ts` |
| i18n dictionary | `src/i18n/en/*.ts` (merges through `src/i18n/en/index.ts`) |

Region-level elements live in **`town-controller.ts`**, not `editor.ts` (that is palace furniture).
It owns the toolbar actions (`data-act=...`), placing modes, selection, the `townCard` inspector and
the region undo snapshot. `view.ts` only routes events.

## Conventions and traps (learned the hard way)

1. **Hiding is per component.** There is *no* global `.kp-hidden { display: none }`. Every hidden
   surface declares its own rule (`.kp-drawer.kp-hidden`, `.kp-panel.kp-hidden`,
   `.kp-overlay.kp-hidden`, …). A new component that forgets
   `.my-thing.kp-hidden { display: none }` renders **permanently** — and because an absolutely
   positioned element with no `left/top` falls back to its static position, it appears stuck in the
   **top-left corner** and no code can hide it. `.kp-card` is the exception: it hides via
   `opacity/pointer-events`, not `display`.
2. **Contenteditable owns its keys.** `view.ts` `onKey` bails on
   `closest('input, textarea, select, [contenteditable]')` so typing never triggers world shortcuts.
   Any editor UI must handle its own `Esc` (and friends) with a local `keydown` listener —
   `townCtl.onKey` will never see those presses.
3. **i18n scan is a hand-rolled lexer.** Every CJK string literal under `core/src` needs an entry in
   `src/i18n/en/`. It skips comments and supports an `i18n-ignore` marker on a line. Trap: inside a
   `` `${…}` `` interpolation it understands quotes but *not* regex literals, so a bare `"` inside a
   regex there desyncs the scanner and produces bogus "missing translation" errors — e.g. write
   `.replaceAll('"', '…')`, never `.replace(/"/g, '…')` inside a template interpolation.
4. **World-format changes.** `normalizeWorld` spreads `...r`, so unknown region fields survive
   *unvalidated*. When adding a field, normalise it explicitly (see `normProps` / `normNotes`) and
   bump `WORLD_VERSION`, keeping `WORLD_COMPAT` so old saves still load. Add a migration in
   `MIGRATIONS` only when old data must be *removed*.
5. **Circular imports.** `world.ts` imports values from `notes.ts`; `notes.ts` imports only *types*
   from `world.ts` (`import type`) so the runtime cycle does not exist. Keep that direction.
6. **DOM building.** Use `html`/`rich` from `src/dom.ts`; the fork deliberately avoids *writing*
   `innerHTML` for UI. Reading `innerHTML` (e.g. from Quill) is fine as long as the value is
   sanitised before it is stored.
7. **Coordinates.** Region-local metres, grass top at `GRASS_Y = -.15`. Click → ground is
   `WorldLayer.groundOf(raycaster, layer)` returning region-local `[x, z]`; a placed object goes to
   `(x, GRASS_Y + lift, z)`. To ray-pick inside a region: `ray.clone().applyMatrix4(layer.group.matrixWorld.invert())`.
   Sticky notes store `pos` as the **centre**; `notes.ts` owns the local↔region convention
   (`noteToWorld` / `noteLocal` / `noteCorners`) — use those, never re-derive the trig.
8. **Undo.** `townCtl.snapshot()` is `JSON.stringify(world.regions)`, so region data is undoable for
   free — but note *content* and note *delete* are deliberately excluded (delete confirms instead).
9. **`all: unset` buttons.** `.kp-root button { all: unset }` resets `display` to `inline`, so a rule
   that only sets `width`/`height`/`background` renders a **0×0, invisible, unclickable** control
   (that is exactly how the note colour swatches shipped broken). Always set `display` on a bare
   button, or use the existing `.kp-bar button` / `.kp-row button` wrappers.
10. **Transparent canvas textures paint black** unless the material opts in: a canvas with
    transparent corners + an opaque material renders those texels black (the note paper's rounded
    corners looked like black cut-outs). Pair it with `transparent: true` + `alphaTest` so the corner
    texels are discarded and the world shows through.
11. **Pointer drags that start on DOM.** `view.ts` binds `pointermove`/`pointerup` to the **canvas**
    element. A drag begun on a DOM overlay (e.g. a resize handle) never reaches those listeners;
    call `renderer.domElement.setPointerCapture(e.pointerId)` so the events are retargeted to the canvas.
12. **DOM over 3D.** `isoCam` is an **OrthographicCamera**, so a ground-aligned plane projects
    affinely: a plain `transform: matrix(a,b,c,d,e,f)` positions a normal DOM element exactly on a
    note (verified: overlay rect matched the projected quad within 1px). Keep the matrix basis
    vectors **unit length** and size the element to the projected extent — then local px == screen px
    and the text stays crisp (never scale rasterised text through the transform).

## Verifying UI work

`app/main.ts` exposes debug handles: `window.palaceView`, `window.step(frames)`,
`window.snapshot(name)` (POSTs a JPEG to `/__snapshot`, written to `packages/core/.snapshots/`), and
`?demo=…` states for headless screenshots.

When driving a browser:

- `page.evaluate` inside `tab.run` runs in an **isolated world** — `window.palaceView` is invisible
  there (DOM and `localStorage` are shared, so it looks like the app failed to boot). Use
  `tab.evaluate("<string>")`, which runs in the page's main world.
- Puppeteer `mouse.click(x, y, { clickCount: 2 })` does **not** fire a DOM `dblclick` (verified: 0
  events). Send `down/up` with `clickCount: 1`, then `down/up` with `clickCount: 2`.
- Very fast synthetic clicks can miss the app's `pointerdown`/`pointerup` pairing (placing modes
  commit on `pointerup`). Move, wait ~100 ms, down, wait ~100 ms, up.
- Prefer real gestures for open/close bugs; calling the controller's methods directly will not catch
  CSS-level "it never hides" problems.
- To move the camera in a test, use `v.tweenCam({ target: new THREE.Vector3(x, y, z), zoom, dur: .01 })`
  and then `v.tick(1 / 30)` a few times. Setting `isoCam.zoom` directly looks right for one frame and
  is then overwritten by the tick; `render()` alone does not apply a moved target.
- Tag scene objects with `userData.<kind>Id` (see the note meshes) so a test can find *the* object
  under test instead of the first one it walks into.

## Known behaviour, not bugs

- Picking is nearest-hit across props/notes/palaces, and props are tall while notes lie flat, so a
  note overlapped by a tree or rock can be hard to click — the prop wins.
- Note text is drawn at every zoom level, so it is sub-pixel when zoomed out to the archipelago or
  planet (recorded as an accepted tradeoff in `docs/sticky-note.md` §10).
