# Sticky note — world element spec

**English** | [简体中文](sticky-note.zh-CN.md)

> Status: **implemented** (this spec was written first, then built to match). Accepted tradeoffs
> are listed in §10.

## 1. Summary

A sticky note is a new element that can be **added to the world**. It lies **flat on the ground**,
shows its writing right there in the scene, and can be edited **two ways**: directly on the ground,
or in an opened **full WYSIWYG editor**.

## 2. Element and data

- A **first-class element** on a world region: a new `region.notes` array beside `palaces` and `props`.
- Persisted format: bump `WORLD_VERSION` (4 → **5**), keep `WORLD_COMPAT` at `1` — old saves still load.
- One note:

  | Field | Meaning |
  | --- | --- |
  | `id` | generated (`gid('note-')`), like props |
  | `pos` | `[x, z]` on the region plane, metres |
  | `rot` | rotation about y, degrees |
  | `w`, `h` | base size in metres |
  | `color` | index into `NOTE_COLORS` |
  | `fs` | preview text height, metres |
  | `html` | the writing, as a sanitised HTML subset (§6) |

## 3. Placement

- **Add flow**: a **note tool** in the build UI; **click the ground** to drop a note there.
- **Snapping**: identical to every other placed object — snap to the **5 cm grid** (`GRID = .05`),
  honouring the existing **snap toggle**, **Alt** bypasses it.
- **Rotation**: snaps to **15°** steps (`ANGLE = 15`) when snapping is on, free with Alt; **`R`** turns
  by 90°.
- A note **does not collide** with anything: it is flat and non-blocking, so no palace-lot or prop
  avoidance.

## 4. Appearance

- **Base size**: default **2.0 m × 1.5 m**; **Resize** allows **1.0 – 6.0 m**, step **0.5 m**.
- **Corner handles**: when a note is selected, a handle sits on each of its four projected corners.
  Dragging one resizes **width and depth independently** (they need not stay in proportion), snapping
  to the 5 cm grid (**Alt** = free), pivoting on the **opposite corner** — which stays put.
- **Background colour**: 6 light paper colours, exported as `NOTE_COLORS` from `world.ts`; names go
  through `t()`. Light papers keep the fixed dark ink readable.
- **Ink**: fixed dark **`#2b2b2b`** on every note — no per-note text colour.
- **Preview text size** (`fs`): **0.1 – 0.5 m**, step **0.05 m**, default **0.2 m**.
- The note rests on the island surface at the note's position, with a small offset (**2 cm**) so it
  never z-fights the ground. The paper's corners are rounded and **cut out** (material
  `transparent` + `alphaTest`), so the world shows through instead of black corners.
- The preview texture is rendered at **384 px per metre** (a 2 × 1.5 m note = 768 × 576), with text
  drawn on whole pixels, so the writing stays crisp when you zoom in.

## 5. Viewing on the ground

- The writing is drawn on the note, always — at any zoom level (tradeoff in §10).
- Content longer than the note **wraps within the base width and is clipped** at the base size; the
  WYSIWYG editor shows everything.

## 6. Editing

1. **Single click selects** the note; it never starts an edit or fights the camera / selection drag,
   and it is what puts the four corner handles (§4) and the card (§7) on screen.
2. **Double-click writes on the note itself.** The text is edited **in the world, on the paper**: a
   `contenteditable` is laid over the note with an affine `transform: matrix(…)` (the camera is
   orthographic, so this is exact — the overlay's rect matches the projected note within 1px), and the
   note's texture switches to **paper only** while editing. So what you type appears on the note as
   real, crisp text; `Esc`, `⌘/Ctrl+Enter` or clicking away commits it back into the paper texture.
3. **Open the note** (the card's **Edit**) for the **full WYSIWYG editor** instead.

- **Editor**: **Quill v2** (added as a dependency; `import 'quill/dist/quill.snow.css'` in `app/app.css`, loaded lazily by `quillFor`). It is swappable, because the stored format is ours, not Quill's.
- **Stored content**: a small **sanitised HTML subset**, allowlist
  `p · br · b · strong · i · em · u · h1 · h2 · h3 · ul · ol · li · a[href]`. Everything else is stripped on
  load (the fork deliberately dropped `innerHTML`). The on-ground preview is rendered from the same
  subset into the note's canvas texture.

## 7. The note card

One card, anchored to the selected note, holding **Buttons like every other element's card**:

- **背景色 (background colour)** — cycles to the next paper colour, showing the current one as a dot.
- **`A−` / `A+`** — preview text size.
- **Rotate** — 90°.
- **Shrink / Grow** — coarse base-size steps (the corner handles do this freely).
- **Edit** — open the WYSIWYG editor.
- **Delete** — asks for confirmation (§8).

## 8. Undo

- **Note content is not undoable.** Unlike props and palaces (which push `editor.ts` undo snapshots),
  a note's text edits sit outside the undo history.
- **Delete asks for confirmation** before removing the note — the one guard against the
  non-undoable delete.

## 9. Where it fits in this app

Grounded in the current structure of `packages/core`:

| Concern | Module | Where it lives |
| --- | --- | --- |
| World data | `src/world.ts` | `PlacedNote` + `WorldRegion.notes`; `WORLD_VERSION` 5 (`WORLD_COMPAT` stays 1); `NOTE_NEW` / `NOTE_SIZE` / `NOTE_FS`; `normNotes` in `normalizeWorld`; `notesOf` / `findNote` / `addNote` / `removeNote` (mirrors the prop helpers). |
| Content | `src/notes.ts` | The whole note module: `parseNote` / `serializeNote` / `sanitizeNoteHtml` (allowlist `p·br·b·strong·i·em·u·h1-3·ul·ol·li·a[href]`), `noteToDom` (in-place editor seed), `NOTE_COLORS` / `NOTE_INK`, `drawNote` (canvas), `noteCanvasSize` (texture pixel budget), and `NoteLayer` (meshes / picking / move). |
| Scene | `src/world-layer.ts` | `RegionLayer` owns a `NoteLayer` under its group; `rebuildNotes` / `pickNote` / `moveNote` / `noteBox`, mirrored on `WorldLayer` (`rebuildNotes` / `pickNote` / `moveNotePreview` / `noteBox`, `NotePick`). |
| Region UI | `src/town-controller.ts` | The region-level owner (props live here too): the note tool (`noteAdd`), start/move/commit placing with 5 cm snap, selection + marker, drag/rotate/delete, the note card, the in-place editor, and the Quill modal (`quillFor` dynamic import). |
| i18n | `src/i18n/en/notes.ts` | The English strings for the note UI; `pnpm -C packages/core i18n` and `i18n.test.ts` gate completeness. |
| Tests | `test/world.test.ts` | The `世界：岛上的便签` block: round-trip, bad-entry dropping, range clamping, old-save default, helpers, sanitising. |

## 10. Accepted tradeoffs

- **Text is always drawn** (chosen over LOD): at archipelago / planet zoom the writing is sub-pixel
  and effectively unreadable. Accepted; the coloured slab still marks the note.
- **Note content is not undoable**: text edits and delete are outside the undo stack. Mitigated only
  by the delete confirmation.
- **No collision handling**: notes can be placed and moved anywhere on the surface, including near or
  over palaces and props, since they are flat and non-blocking.

## 11. Acceptance criteria

- A note can be added with the note tool by clicking the ground, with props' exact snapping (5 cm,
  snap toggle, Alt) and rotation (15°, `R` 90°); it persists across reload (version 5, old saves load).
- It renders flat on the ground at its base size, writing always drawn, and readable.
- Content longer than the base size wraps and clips on the ground; the WYSIWYG editor shows all of it.
- Single click selects and shows the menu; double-click edits in place; Edit opens Quill with
  bold/italic/underline, headings, lists and links, stored as the sanitised subset.
- The menu changes background colour, preview size, base size, opens the editor, and deletes with a
  confirmation.
- Ink is fixed `#2b2b2b`; UI strings go through `t()` with English in `src/i18n/en/`;
  `pnpm typecheck && pnpm test` stays green.
