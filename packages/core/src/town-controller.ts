import * as THREE from 'three';
import type { PalaceView } from './view';
import { type PalaceDoc, type Vec2 } from './schema';
import type { PropHit, NotePick, RegionLayer } from './world-layer';
import type { ParamSpec } from './catalog';
import { propKind, propKinds, type PropKind } from './props';
import { ThumbnailRenderer } from './thumbs';
import { ICONS, escapeHtml, timeAgo } from './icons';
import { html, rich } from './dom';
import { NOTE_LIFT, noteCorners, notePaper, noteToDom, noteToWorld } from './notes';
import { TEMPLATES, createFromTemplate } from './templates/basic';
import { THEMES, getTheme } from './themes';
import * as W from './world';
import { t } from './i18n';

/* =====================================================================
 * 小镇 / 群岛层级的交互
 *   近看一座岛：悬停掀屋顶、选中宫殿、布置（拖动 / 旋转宫殿）、建造新宫殿、搬到别的岛
 *              布置里也能动岛上的摆设（props）：选中、拖动、旋转、复制、删除、改参数，还能从面板里加
 *   群岛视角：悬停 / 选中岛、双击飞过去、岛屿设置（名字 / 场景）、开辟新岛、布置岛屿
 *   两个层级都能用：宫殿列表（按岛分组）、⌘K 快速跳转（宫殿 / 岛）
 * ===================================================================== */

const GRASS_Y = -.15;
const PEEK_DELAY = 280;
/** 摆设之间的最小间距 / 和宫殿地块、广场的额外退让 */
const PROP_GAP = .6;
/** 便签吸附的网格（和编辑器里物件摆放一致：5 cm） */
const NOTE_GRID = .05;
const snapNote = (n: number) => Math.round(n / NOTE_GRID) * NOTE_GRID;
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** SVG 的子元素要放在 <svg> 里解析才是 SVG 元素：包一层再取出里面的节点（只有 <path> 的图标、插图里的片段） */

interface PaletteItem { kind: 'palace' | 'region'; id: string; title: string; sub: string; color: string }
type Drag =
  | { kind: 'palace'; id: string; regionId: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'region'; id: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'prop'; regionId: string; propId: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'note'; regionId: string; noteId: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'group'; regionId: string; anchorPos: Vec2; propOffsets: Map<string, Vec2>; noteOffsets: Map<string, Vec2>; propOrig: Map<string, Vec2>; noteOrig: Map<string, Vec2>; before: string; valid: boolean; moved: boolean };

/** 正在往岛上放的新摆设：先按数据加进去（预览就是真的那条数据），取消时再撤回 */
interface PropPlacing { prop: W.PlacedProp; regionId: string; before: string; valid: boolean; down: { x: number; y: number } | null }

/** 正在往岛上放的新便签：同样是先插数据、预览就是真数据 */
interface NotePlacing { note: W.PlacedNote; regionId: string; before: string; valid: boolean; down: { x: number; y: number } | null }

/** Quill 的最小接口：动态 import，免得把编辑器塞进所有入口的打包 */
interface QuillLike {
  root: HTMLElement;
  clipboard: { convert(input: { html: string }): unknown };
  setContents(delta: unknown, source?: string): void;
  getLength(): number;
  setSelection(index: number, length?: number): void;
  history: { clear(): void };
  focus(): void;
}

export class TownController {
  selectedId: string | null = null;
  hoveredId: string | null = null;
  selectedRegion: string | null = null;
  hoveredRegion: string | null = null;
  /** 选中的岛上摆设（和宫殿互斥） */
  selectedProp: string | null = null;
  /** 多选集合：批量选中的摆设与便签（支持框选） */
  selectedProps = new Set<string>();
  selectedNotes = new Set<string>();
  private boxSelect: { startX: number; startY: number; moved: boolean } | null = null;
  editing = false;
  private hoveredProp: string | null = null;
  private hoverSince = 0;
  private tagHover: string | null = null;
  private drag: Drag | null = null;
  private placing: { doc: PalaceDoc; placed: W.PlacedPalace; regionId: string; valid: boolean; down: { x: number; y: number } | null } | null = null;
  private propPlacing: PropPlacing | null = null;
  /** 便签：正在放的 / 选中的 / 直接在便签上编辑的（noteLive）/ 拖角改尺寸的（noteResize）/ 打开富文本编辑器的 */
  private notePlacing: NotePlacing | null = null;
  private selectedNote: string | null = null;
  private noteLive: { id: string; regionId: string } | null = null;
  private noteResize: { regionId: string; noteId: string; corner: number; fixed: Vec2; before: string; moved: boolean } | null = null;
  private noteModal: { id: string; regionId: string } | null = null;
  private quill: QuillLike | null = null;
  private quillReady: Promise<QuillLike> | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listOpen = false;
  private panel: 'build' | 'island' | 'props' | null = null;
  private palette: PaletteItem[] = [];
  /** 岛屿捏形工具：正在捏形 / 刷地形扩展 */
  sculptMode = false;
  sculptBrush: 'expand' | 'shrink' = 'expand';
  private sculptDrag: { regionId: string; mode: 'expand' | 'shrink'; before: string; lastApply: number } | null = null;
  private paletteSel = 0;
  private confirmResolve: ((ok: boolean) => void) | null = null;
  private planCache = new Map<string, DocumentFragment>();
  /** 摆设面板的缩略图（第一次打开面板时才建） */
  private propThumbs: ThumbnailRenderer | null = null;
  /** 参数编辑开始时的快照（滑杆拖动期间只重建预览，松手才记一步撤销） */
  private propParamBefore: string | null = null;
  private propRaf = 0;

  constructor(private v: PalaceView) {
    this.buildUI();
    const labels = v.root.querySelector('.kp-labels') as HTMLElement;
    v.on(labels, 'pointerover', (e: PointerEvent) => {
      const tag = (e.target as HTMLElement).closest<HTMLElement>('.kp-tag');
      if (!tag || v.level !== 'town') return;
      this.tagHover = tag.dataset.id;
      this.setHover(this.tagHover);
    });
    v.on(labels, 'pointerout', (e: PointerEvent) => {
      const tag = (e.target as HTMLElement).closest<HTMLElement>('.kp-tag');
      if (!tag || tag.contains(e.relatedTarget as Node)) return;
      this.tagHover = null;
      this.setHover(null);
    });
    v.on(labels, 'dblclick', (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const tag = t.closest<HTMLElement>('.kp-tag'), rtag = t.closest<HTMLElement>('.kp-region-tag');
      if (v.level !== 'town' || this.editing) return;
      if (tag) v.enterPalace(tag.dataset.id);
      else if (rtag) v.flyToRegion(rtag.dataset.id);
    });
    const input = v.ui.paletteInput as HTMLInputElement;
    v.on(input, 'input', () => { this.paletteSel = 0; this.renderPalette(); });
    v.on(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.palette.length;
        if (n) this.paletteSel = (this.paletteSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.renderPalette(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = this.palette[this.paletteSel];
        if (it) this.pickPalette(it);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this.closePalette();
      }
    });
    v.on(v.ui.paletteWrap, 'pointerdown', (e: PointerEvent) => { if (e.target === v.ui.paletteWrap) this.closePalette(); });
    v.on(v.ui.townList, 'pointerover', (e: PointerEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.kp-list-row[data-id]');
      if (row) this.setHover(row.dataset.id);
    });
    v.on(v.ui.townList, 'pointerleave', () => this.setHover(null));
    // 直接在便签上写字：视图层会忽略 contenteditable 里的按键（免得打字触发世界快捷键），
    // 所以 Esc / ⌘Enter 在这里自己收尾；点走别处（失焦）也算写完。
    v.on(v.ui.noteLiveBox, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
        e.preventDefault();
        e.stopPropagation();
        this.commitNoteLive();
      }
    });
    v.on(v.ui.noteLiveBox, 'blur', () => this.commitNoteLive());
    // 四个角：拖它改尺寸（宽 / 深各自独立）
    v.on(v.ui.noteHandles, 'pointerdown', (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.kp-note-handle');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      this.beginNoteResize(Number(el.dataset.corner) || 0, e);
    });
    v.on(v.ui.noteEditorWrap, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeNoteEditor();
      }
    });
  }

  private get town() { return this.v.town; }
  private get region() { return this.v.region; }
  private get docs() { return this.v.docs; }
  private get world() { return this.v.world; }
  /** 拖动 / 放置进行中：镜头所在的岛不要自动切换 */
  get busy() { return !!this.drag || !!this.placing || !!this.propPlacing || !!this.notePlacing || !!this.noteLive || !!this.noteResize || !!this.sculptDrag; }

  private layerOf(regionId: string): RegionLayer | undefined { return this.town.regions.get(regionId); }
  private regionById(id: string) { return this.world.regions.find(r => r.id === id); }

  // =====================================================================
  // UI
  // =====================================================================

  private buildUI() {
    this.v.root.append(html`
      <div class="kp-brand kp-glass kp-town-only">
        <div class="kp-mark" data-ref="townMark">${rich(ICONS.logo)}</div>
        <div style="min-width:0">
          <div class="kp-title" data-ref="townTitle"></div>
          <div class="kp-sub" data-ref="townSub"></div>
        </div>
        <button class="kp-loci-btn kp-near-only" data-act="regionSettings" title="${t('这座岛的名字和场景')}">${rich(ICONS.map)}<span>${t('岛屿')}</span></button>
      </div>
      <div class="kp-topright kp-iso-only">
        <button class="kp-search kp-glass" data-act="palette" title="${t('搜索岛屿（⌘K / Ctrl+K）')}">${rich(ICONS.search)}<span>${t('搜索岛屿')}</span><kbd>⌘K</kbd></button>
      </div>
      <nav class="kp-bar kp-glass kp-town-only kp-town-view kp-near-only">
        <button class="kp-primary" data-act="propPanel" title="${t('添加摆设（A）')}">${rich(ICONS.plus)}<span>${t('添加摆设')}</span></button>
        <button data-act="noteAdd" title="${t('添加便签')}">${rich(ICONS.note)}<span>${t('便签')}</span></button>
        <button data-act="sculptStart" title="${t('捏形工具：改变岛屿形状与大小')}">${rich(ICONS.build)}<span>${t('捏形')}</span></button>
        <button data-act="townEdit" title="${t('布置小岛：拖动摆设和便签换位置、旋转（B）')}">${rich(ICONS.move)}<span>${t('布置')}</span></button>
        <span class="kp-sep"></span>
        <button data-act="toWorld" title="${t('拉远，看看所有的岛')}">${rich(ICONS.globe)}<span>${t('群岛')}</span></button>
        <button class="kp-icon" data-act="rotl" title="${t('向左旋转 90°（Q）')}">${rich(ICONS.rotl)}</button>
        <button class="kp-icon" data-act="rotr" title="${t('向右旋转 90°（E）')}">${rich(ICONS.rotr)}</button>
        <button data-act="night" title="${t('日 / 夜（N）')}"><svg class="kp-i" viewBox="0 0 24 24" data-night-icon>${rich(ICONS.moon)}</svg><span data-night-text>${t('夜晚')}</span></button>
        <button data-act="reset" title="${t('复位视角（R）')}">${rich(ICONS.reset)}<span>${t('复位')}</span></button>
      </nav>
      <nav class="kp-bar kp-glass kp-town-only kp-town-view kp-far-only">
        <button class="kp-primary" data-act="newIsland" title="${t('开辟一座新的岛')}">${rich(ICONS.plus)}<span>${t('开辟新岛')}</span></button>
        <button data-act="townEdit" title="${t('布置岛屿：拖动岛换位置（B）')}">${rich(ICONS.move)}<span>${t('布置岛屿')}</span></button>
        <span class="kp-sep"></span>
        <button class="kp-no-planet" data-act="toPlanet" title="${t('继续拉远：整个世界卷成一颗小星球')}">${rich(ICONS.planet)}<span>${t('星球')}</span></button>
        <button class="kp-planet-only" data-act="toWorld" title="${t('回到群岛全景')}">${rich(ICONS.globe)}<span>${t('群岛')}</span></button>
        <button class="kp-icon" data-act="rotl" title="${t('向左旋转 90°（Q）')}">${rich(ICONS.rotl)}</button>
        <button class="kp-icon" data-act="rotr" title="${t('向右旋转 90°（E）')}">${rich(ICONS.rotr)}</button>
        <button data-act="night" title="${t('日 / 夜（N）')}"><svg class="kp-i" viewBox="0 0 24 24" data-night-icon>${rich(ICONS.moon)}</svg><span data-night-text>${t('夜晚')}</span></button>
        <button data-act="reset" title="${t('全景（R）')}">${rich(ICONS.reset)}<span>${t('全景')}</span></button>
      </nav>
      <nav class="kp-bar kp-glass kp-town-only kp-town-edit">
        <span class="kp-bar-hint" data-ref="townEditHint"></span>
        <button class="kp-icon kp-near-only" data-act="propPanel" title="${t('添加摆设（A）')}">${rich(ICONS.plus)}</button>
        <button class="kp-icon kp-near-only" data-act="noteAdd" title="${t('添加便签')}">${rich(ICONS.note)}</button>
        <button class="kp-icon kp-near-only" data-act="sculptStart" title="${t('捏形工具：改变岛屿形状与大小')}">${rich(ICONS.build)}</button>
        <button class="kp-icon kp-near-only" data-act="townRotate" title="${t('旋转选中的宫殿或摆设 90°（R）')}">${rich(ICONS.rotr)}</button>
        <button class="kp-icon kp-near-only" data-act="resetIslandScenery" title="${t('重新生成风景：清除摆设修改，重置为自然风景')}">${rich(ICONS.reset)}</button>
        <span class="kp-sep"></span>
        <button class="kp-icon" data-act="townUndo" data-ref="townUndo" title="${t('撤销（⌘Z）')}" disabled>${rich(ICONS.undo)}</button>
        <button class="kp-icon" data-act="townRedo" data-ref="townRedo" title="${t('重做（⇧⌘Z）')}" disabled>${rich(ICONS.redo)}</button>
        <span class="kp-sep"></span>
        <button class="kp-primary" data-act="townEditDone" title="${t('完成布置（Esc）')}">${rich(ICONS.check)}<span>${t('完成')}</span></button>
      </nav>
      <div class="kp-place kp-glass kp-town-only kp-town-placing-only"><span data-ref="townPlaceHint"></span><button data-act="townPlaceCancel">${t('取消')}</button></div>
      <div class="kp-card kp-glass kp-hidden kp-town-only" data-ref="townCard"></div>
      <div class="kp-panel kp-build kp-glass kp-hidden kp-town-only" data-ref="buildPanel"></div>
      <div class="kp-panel kp-list kp-glass kp-hidden kp-town-only" data-ref="townList"></div>
      <div class="kp-panel kp-list kp-glass kp-hidden kp-town-only" data-ref="propPanel"></div>
      <div class="kp-overlay kp-hidden" data-ref="paletteWrap">
        <div class="kp-palette kp-glass">
          <label class="kp-pal-input">${rich(ICONS.search)}<input data-ref="paletteInput" placeholder="${t('搜索岛屿…')}" autocomplete="off" spellcheck="false"></label>
          <div class="kp-pal-list" data-ref="paletteList"></div>
          <div class="kp-pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> ${t('选择')}</span><span><kbd>Enter</kbd> ${t('前往')}</span><span><kbd>Esc</kbd> ${t('关闭')}</span></div>
        </div>
      </div>
      <div class="kp-overlay kp-center kp-hidden" data-ref="confirmWrap">
        <div class="kp-confirm kp-glass">
          <b data-ref="confirmTitle"></b>
          <p data-ref="confirmMsg"></p>
          <div class="kp-row"><button data-act="confirmNo">${t('取消')}</button><button class="kp-danger-strong" data-act="confirmYes" data-ref="confirmYes">${t('删除')}</button></div>
        </div>
      </div>
      <div class="kp-note-live kp-hidden" data-ref="noteLive">
        <div class="kp-note-live-box" data-ref="noteLiveBox" contenteditable="true" spellcheck="false"></div>
      </div>
      <div class="kp-note-handles kp-hidden" data-ref="noteHandles">${[0, 1, 2, 3].map(i => html`<div class="kp-note-handle" data-corner="${i}"></div>`)}</div>
      <div class="kp-overlay kp-center kp-hidden" data-ref="noteEditorWrap">
        <div class="kp-note-modal kp-glass">
          <b>${t('编辑便签')}</b>
          <div class="kp-note-editor" data-ref="noteEditor"></div>
          <div class="kp-row"><button data-act="noteEditorCancel">${t('取消')}</button><button class="kp-primary kp-grow" data-act="noteEditorSave">${t('完成')}</button></div>
        </div>
      </div>
      <div class="kp-marquee kp-hidden" data-ref="marquee"></div>`);
    this.v.root.querySelectorAll<HTMLElement>('[data-ref]').forEach(el => { this.v.ui[el.dataset.ref] = el; });
  }

  /** 世界 / 宫殿数据变化后刷新：品牌区统计、名牌、卡片、列表 */
  refresh() {
    const v = this.v;
    if (!this.region) return;
    if (v.far) {
      const placed = this.world.regions.reduce((s, r) => s + r.palaces.filter(p => this.docs.has(p.palaceId)).length, 0);
      v.ui.townTitle.textContent = this.world.name || t('记忆世界');
      v.ui.townSub.textContent = v.planet > .6
        ? `${t('{n} 座岛', { n: this.world.regions.length })} · ${t('拖动转动星球 · 滚轮拉近')}`
        : [t('{n} 座岛', { n: this.world.regions.length }), t('{n} 座宫殿', { n: placed })].join(' · ');
      v.ui.townMark.replaceChildren(html`${rich(ICONS.globe)}`);
    } else {
      const th = getTheme(this.region.theme);
      v.ui.townTitle.textContent = this.region.name;
      v.ui.townSub.textContent = t(th.desc);
      v.ui.townMark.textContent = th.icon;
    }
    for (const s of this.town.shells.values()) {
      this.town.updateTag(s);
      s.tag.element.classList.toggle('kp-hot', s.id === this.hoveredId);
      s.tag.element.classList.toggle('kp-sel', s.id === this.selectedId);
    }
    for (const l of this.town.regions.values()) {
      l.updateTag(this.docs);
      l.tag.element.classList.toggle('kp-hot', l.region.id === this.hoveredRegion);
      l.tag.element.classList.toggle('kp-sel', l.region.id === this.selectedRegion);
    }
    if (this.selectedId && !this.docs.has(this.selectedId)) this.selectedId = null;
    if (this.selectedRegion && !this.regionById(this.selectedRegion)) this.selectedRegion = null;
    if (this.selectedProp && !this.propAt(this.selectedProp)) this.selectProp(null);
    if (this.selectedNote && !this.noteAt(this.selectedNote)) this.selectedNote = null;
    v.ui.townEditHint.replaceChildren(html`${v.far ? t('拖动岛换位置 · 岛和岛之间会留出海面') : rich(t('拖动宫殿或摆设换位置 · <b>R</b> 旋转 · <b>⌘D</b> 复制'))}`);
    this.renderCard();
    if (this.listOpen) this.renderList();
    this.updateUndoButtons();
    this.updateMarker();
  }

  /** 进出宫殿之前：收起小镇里的各种临时状态 */
  beforeLevelChange() {
    this.cancelPlacing();
    this.cancelNotePlacing();
    this.commitNoteLive();
    this.closeNoteEditor();
    this.setEditing(false);
    this.closePanel();
    this.toggleList(false);
    this.selectedId = this.hoveredId = this.selectedRegion = this.hoveredRegion = null;
    this.tagHover = null;
    this.v.ui.townCard.classList.add('kp-hidden');
    this.v.setMarker(null);
    this.v.setCursor('');
    for (const s of this.town.shells.values()) s.tag.element.classList.remove('kp-hot', 'kp-sel');
    for (const l of this.town.regions.values()) l.tag.element.classList.remove('kp-hot', 'kp-sel');
  }

  /** 近看 ↔ 群岛视角切换 */
  onFarChange(far: boolean) {
    this.setEditing(false);
    this.cancelPlacing();
    this.closePanel();
    this.setHover(null);
    this.setRegionHover(null);
    if (far) this.select(null); else this.selectRegion(null);
    this.refresh();
  }

  highlights(): [THREE.Object3D, number][] {
    return [];
  }

  // =====================================================================
  // 拾取
  // =====================================================================

  private ray(e: { clientX: number; clientY: number }) {
    const v = this.v;
    v.raycaster.setFromCamera(v.ndc(e.clientX, e.clientY), v.isoCam);
    return v.raycaster;
  }

  /** 指针落在某座岛草地平面上的点（区域局部坐标） */
  private regionGround(e: { clientX: number; clientY: number }, regionId: string): Vec2 | null {
    const layer = this.layerOf(regionId);
    return layer ? this.town.groundOf(this.ray(e), layer) : null;
  }

  /** 指针下的宫殿：外壳 / 屋顶 → 正在预览的内部 → 地块 */
  private pickPalace(e: { clientX: number; clientY: number }): string | null {
    const v = this.v, ray = this.ray(e);
    const hit = this.town.pick(ray);
    if (hit) return hit.id;
    if (v.peek) {
      for (const h of ray.intersectObject(v.peek.built.root, true)) {
        let o: THREE.Object3D = h.object, vis = true;
        while (o) { if (!o.visible) { vis = false; break; } o = o.parent; }
        if (vis) return v.peek.id;
      }
    }
    return this.town.pickLot(ray);
  }

  private pickRegion(e: { clientX: number; clientY: number }) {
    return this.town.pickRegion(this.ray(e));
  }

  /**
   * 摆设 / 便签 / 宫殿一起拾取：岛上的东西谁离镜头近就选谁；深度接近（20cm 以内）时宫殿优先，
   * 所以岛上的小东西不会抢走宫殿的点击，宫殿也不会被脚边更近的东西挡住。地面落点排在最后。
   */
  private pickPropOrPalace(e: { clientX: number; clientY: number }): { prop: PropHit | null; note: NotePick | null; palaceId: string | null } {
    const ray = this.ray(e);
    const prop = this.town.pickProp(ray);
    const note = this.town.pickNote(ray);
    const shell = this.town.pick(ray);
    const away = (p: { point: THREE.Vector3 } | null) => p ? ray.ray.origin.distanceTo(p.point) : Infinity;
    const dNear = Math.min(away(prop), away(note));
    if (shell && away(shell) <= dNear + .2) return { prop: null, note: null, palaceId: shell.id };
    return away(note) <= away(prop) ? { prop: null, note, palaceId: null } : { prop, note: null, palaceId: null };
  }

  /** 便签和它所在的岛（撤销之后 id 可能已经没了） */
  private noteAt(noteId: string) {
    for (const region of this.world.regions) {
      const note = W.findNote(region, noteId);
      if (note) return { region, note };
    }
    return null;
  }

  /** 摆设和它所在的岛（找不到返回 null：撤销之后 id 可能已经没了） */
  private propAt(propId: string) {
    for (const region of this.world.regions) {
      const prop = W.findProp(region, propId);
      if (prop) return { region, prop };
    }
    return null;
  }

  // =====================================================================
  // 悬停 / 选中
  // =====================================================================

  /** 每帧：处理悬停、屋顶预览、名牌详略 */
  update(_dt: number) {
    const v = this.v;
    const e = v.lastPointer;
    if (e && !v.camTween) {
      v.lastPointer = null;
      if (!e.buttons && !this.drag && !this.placing && !this.propPlacing && !this.notePlacing && !this.sculptMode) {
        if (v.far) {
          this.setRegionHover(this.pickRegion(e));
          this.setPropHover(null);
        } else {
          const layer = this.layerOf(this.region.id);
          const g = layer && this.town.groundOf(this.ray(e), layer);
          if (this.region.props === undefined && g && layer.onLand(g[0], g[1])) this.ensureProps(this.region);
          const hit = this.pickPropOrPalace(e);
          this.setPropHover(hit.prop?.propId ?? null);
          this.setHover(hit.palaceId ?? this.tagHover);
        }
        this.showTip(e);
      } else v.ui.tip.classList.remove('kp-on');
    }
    const busy = v.far || this.editing || !!this.placing || !!this.propPlacing || !!this.drag || !!this.sculptMode || !!this.sculptDrag || !!v.camTween;
    const target = busy ? null : (this.hoveredId ?? this.selectedId);
    const ready = this.hoveredId ? performance.now() - this.hoverSince > PEEK_DELAY : true;
    if (target && ready && !(v.peek?.id === target && v.peek.open)) v.openPeek(target);
    else if (!target && v.peek?.open) v.closePeek();
    v.root.classList.toggle('kp-tags-near', v.frustum / v.isoCam.zoom < 46);
    this.positionNoteOverlays();
  }

  private setHover(id: string | null) {
    if (id === this.hoveredId) return;
    const old = this.hoveredId;
    this.hoveredId = id;
    this.hoverSince = performance.now();
    if (old) this.town.shells.get(old)?.tag.element.classList.remove('kp-hot');
    if (id) this.town.shells.get(id)?.tag.element.classList.add('kp-hot');
    this.v.setCursor(id ? 'pointer' : '');
    const peek = this.v.peek;
    if (peek?.open && peek.id !== id && peek.id !== this.selectedId) this.v.closePeek();
    this.v.ui.townList.querySelectorAll('.kp-list-row[data-id]').forEach(r => r.classList.toggle('kp-hot', (r as HTMLElement).dataset.id === id));
    this.v.invalidate();
  }

  private setRegionHover(id: string | null) {
    if (id === this.hoveredRegion) return;
    const old = this.hoveredRegion;
    this.hoveredRegion = id;
    if (old) this.layerOf(old)?.tag.element.classList.remove('kp-hot');
    if (id) this.layerOf(id)?.tag.element.classList.add('kp-hot');
    this.v.setCursor(id ? 'pointer' : '');
  }

  /** 布置模式下悬停的摆设：只做高亮，不重建批次（见 world-layer 的 setPropHover） */
  private setPropHover(id: string | null) {
    if (id === this.hoveredProp) return;
    this.hoveredProp = id;
    this.town.setPropHover(id);
    if (id) this.v.setCursor('pointer');
    else if (!this.hoveredId) this.v.setCursor('');
  }

  onPointerLeave() {
    if (!this.tagHover) this.setHover(null);
    this.setRegionHover(null);
    this.setPropHover(null);
    this.v.ui.tip.classList.remove('kp-on');
  }

  /** 悬停提示：名字 + 操作方式 */
  private showTip(e: { clientX: number; clientY: number }) {
    const v = this.v, tip = v.ui.tip;
    if (v.far) {
      const r = this.hoveredRegion && this.regionById(this.hoveredRegion);
      if (!r) { tip.classList.remove('kp-on'); return; }
      tip.replaceChildren(html`${r.name}<small>${this.editing ? t('拖动换位置') : t('双击前往 · 单击查看')}</small>`);
      v.placeTip(e);
      return;
    }
    const at = this.hoveredProp && this.propAt(this.hoveredProp);
    if (at) {
      const kind = propKind(at.prop.kind);
      tip.replaceChildren(html`${kind ? t(kind.name) : at.prop.kind}<small>${t('拖动换位置 · R 旋转')}</small>`);
      v.placeTip(e);
      return;
    }
    const doc = this.hoveredId && !this.tagHover ? this.docs.get(this.hoveredId) : null;
    if (!doc) { tip.classList.remove('kp-on'); return; }
    tip.replaceChildren(html`${doc.name}<small>${this.editing ? t('拖动换位置 · R 旋转') : t('双击进入 · 单击查看')}</small>`);
    v.placeTip(e);
  }

  clearMultiSelect() {
    this.selectedProps.clear();
    this.selectedNotes.clear();
  }

  select(id: string | null) {
    if (id) this.clearMultiSelect();
    // 宫殿和摆设的选中互斥：选了宫殿就把摆设放下
    if (id && (this.selectedProp || this.hoveredProp)) {
      this.selectedProp = null;
      this.hoveredProp = null;
      this.town.setPropSelection(null);
      this.town.setPropHover(null);
    }
    const old = this.selectedId;
    this.selectedId = id;
    if (old) this.town.shells.get(old)?.tag.element.classList.remove('kp-sel');
    if (id) this.town.shells.get(id)?.tag.element.classList.add('kp-sel');
    if (old && old !== id && this.v.peek?.id === old && this.hoveredId !== old) this.v.closePeek();
    this.updateMarker();
    this.renderCard();
    this.v.ui.townList.querySelectorAll('.kp-list-row[data-id]').forEach(r => r.classList.toggle('kp-on', (r as HTMLElement).dataset.id === id));
  }

  /** 选中岛上的一个摆设（和宫殿的选中互斥）；渲染层会把它从批次里拆出来单独渲染 */
  selectProp(id: string | null) {
    if (id) this.clearMultiSelect();
    if (id !== this.selectedProp) this.propParamBefore = null;
    // 添加面板和卡片互斥：在岛上点中一个摆设就把面板收起来，卡片才有地方显示
    if (id && this.panel === 'props') this.closePanel();
    this.selectedProp = id;
    this.town.setPropSelection(id);
    if (id) { this.selectedNote = null; this.select(null); }
    this.renderCard();
    this.updateMarker();
    this.v.invalidate();
  }

  /** 选中一张便签（和摆设 / 宫殿的选中互斥）；选中的反馈是地面上的橙框 + 卡片 */
  selectNote(id: string | null) {
    if (id) this.clearMultiSelect();
    if (id !== this.selectedNote) this.commitNoteLive();
    if (id && this.panel === 'props') this.closePanel();
    this.selectedNote = id;
    if (id) { this.selectedProp = null; this.town.setPropSelection(null); this.select(null); this.selectRegion(null); }
    this.renderCard();
    this.updateMarker();
    this.v.invalidate();
  }

  selectRegion(id: string | null) {
    const old = this.selectedRegion;
    this.selectedRegion = id;
    if (old) this.layerOf(old)?.tag.element.classList.remove('kp-sel');
    if (id) this.layerOf(id)?.tag.element.classList.add('kp-sel');
    this.renderCard();
  }

  private updateMarker(valid = true) {
    const v = this.v;
    if (v.level !== 'town') return;
    const multiCount = this.selectedProps.size + this.selectedNotes.size;
    if (multiCount > 1) {
      let unionBox: THREE.Box3 | null = null;
      let minLift = 0;
      for (const pid of this.selectedProps) {
        const at = this.propAt(pid);
        const l = at ? this.layerOf(at.region.id) : undefined;
        const b = at && l ? this.town.propBox(at.region.id, pid) : null;
        if (b && l) {
          minLift = l.lift;
          if (!unionBox) unionBox = b.clone(); else unionBox.union(b);
        }
      }
      for (const nid of this.selectedNotes) {
        const at = this.noteAt(nid);
        const l = at ? this.layerOf(at.region.id) : undefined;
        const b = at && l ? this.town.noteBox(at.region.id, nid) : null;
        if (b && l) {
          minLift = l.lift;
          if (!unionBox) unionBox = b.clone(); else unionBox.union(b);
        }
      }
      if (unionBox) {
        v.setMarker(unionBox, minLift + GRASS_Y + .06, .08, valid ? '#ef8235' : '#d9483b');
        return;
      }
    }
    if (this.selectedNote) { this.noteMarker(this.selectedNote, valid); return; }
    if (this.selectedProp) { this.propMarker(this.selectedProp, valid); return; }
    const id = this.placing?.doc.id || (v.far ? null : this.selectedId);
    const s = id ? this.town.shells.get(id) : null;
    const layer = s && this.layerOf(s.regionId);
    if (!s || !layer) { v.setMarker(null); return; }
    const [x0, z0, x1, z1] = s.lot, [ox, oz] = W.regionOrigin(layer.region);
    const box = new THREE.Box3(new THREE.Vector3(ox + x0, 0, oz + z0), new THREE.Vector3(ox + x1, 0, oz + z1));
    v.setMarker(box, layer.lift + GRASS_Y + .07, .05, valid ? '#ef8235' : '#d9483b');
  }

  /** 选中 / 拖动中的摆设：渲染层给的包围盒已经是世界坐标，直接铺在地面上 */
  private propMarker(propId: string, valid: boolean) {
    const v = this.v;
    const at = this.propAt(propId);
    const layer = at ? this.layerOf(at.region.id) : undefined;
    const box = at && layer ? this.town.propBox(at.region.id, propId) : null;
    if (!at || !layer || !box) { v.setMarker(null); return; }
    v.setMarker(box, layer.lift + GRASS_Y + .07, .05, valid ? '#ef8235' : '#d9483b');
  }

  /** 选中 / 拖动中的便签：渲染层给的包围盒已经是世界坐标，直接铺在地面上 */
  private noteMarker(noteId: string, valid: boolean) {
    const v = this.v;
    const at = this.noteAt(noteId);
    const layer = at ? this.layerOf(at.region.id) : undefined;
    const box = at && layer ? this.town.noteBox(at.region.id, noteId) : null;
    if (!at || !layer || !box) { v.setMarker(null); return; }
    v.setMarker(box, layer.lift + GRASS_Y + .04, .04, valid ? '#ef8235' : '#d9483b');
  }

  onClick(e: PointerEvent) {
    if (this.placing || this.propPlacing || this.notePlacing) return;
    if (this.v.far) { this.selectRegion(this.pickRegion(e)); return; }
    if (this.v.companion.click(e.clientX, e.clientY)) return;
    const hit = this.pickPropOrPalace(e);
    if (hit.note) {
      this.clearMultiSelect();
      this.selectNote(hit.note.noteId);
      const at = this.noteAt(hit.note.noteId);
      if (at) this.v.companion.onSelectPropOrNote(at.note.pos[0], at.note.pos[1]);
    } else if (hit.prop) {
      this.clearMultiSelect();
      this.selectProp(hit.prop.propId);
      const at = this.propAt(hit.prop.propId);
      if (at) this.v.companion.onSelectPropOrNote(at.prop.pos[0], at.prop.pos[1]);
    } else {
      this.clearMultiSelect();
      this.selectNote(null);
      this.selectProp(null);
      this.select(this.pickPalace(e));
    }
  }

  onDblClick(e: MouseEvent) {
    if (this.placing || this.propPlacing || this.notePlacing) return;
    if (this.v.far) {
      const rid = this.pickRegion(e);
      if (rid) this.v.flyToRegion(rid);
      return;
    }
    const hit = this.pickPropOrPalace(e);
    if (hit.note) {
      this.selectNote(hit.note.noteId);
      this.startNoteLive(hit.note.noteId);
      return;
    }
    const id = this.pickPalace(e);
    if (id) this.v.enterPalace(id);
  }

  // =====================================================================
  // 卡片：宫殿 / 岛 / 摆设
  // =====================================================================

  private renderCard() {
    const v = this.v, card = v.ui.townCard;
    if (v.level !== 'town' || this.placing || this.propPlacing || this.notePlacing || this.panel === 'props') { card.classList.add('kp-hidden'); return; }
    if (this.selectedProps.size + this.selectedNotes.size > 1) return this.renderMultiCard();
    if (this.selectedNote) return this.renderNoteCard();
    if (this.selectedProp) return this.renderPropCard();
    if (this.editing) { card.classList.add('kp-hidden'); return; }
    if (this.selectedRegion) return this.renderRegionCard(this.selectedRegion);
    const id = this.selectedId;
    const doc = id && this.docs.get(id), placed = id && v.placementOf(id);
    if (!doc || !placed || v.far) { card.classList.add('kp-hidden'); return; }
    const st = W.palaceStats(doc);
    const color = placed.roofColor || W.palaceColor(doc);
    const roof = placed.roof || 'auto';
    const roofs: [W.RoofKind, string][] = [['auto', t('自动')], ['flat', t('平顶')], ['gable', t('坡顶')], ['none', t('无')]];
    const here = v.regionOf(id);
    const others = this.world.regions.filter(r => r !== here);
    if (v.readonly) {
      // 只读：只能看
      card.replaceChildren(html`
        <button class="kp-close" data-act="townDeselect">×</button>
        <div class="kp-room">${t('宫殿')}</div>
        <h3 class="kp-ro-name"></h3>
        <div class="kp-stats">${t('{n} 个房间', { n: st.rooms })} · ${t('{n} 个物件', { n: st.items })}</div>
        <div class="kp-row"><button class="kp-primary kp-grow" data-act="palaceEnter">${t('进去参观 →')}</button></div>`);
      card.querySelector('.kp-ro-name').textContent = doc.name;
      card.classList.remove('kp-hidden');
      return;
    }
    card.replaceChildren(html`
      <button class="kp-close" data-act="townDeselect">×</button>
      <div class="kp-room">${t('宫殿 · {time}更新', { time: timeAgo(doc.updatedAt) })}</div>
      <input class="kp-name" data-field="palaceName" maxlength="40" spellcheck="false">
      <div class="kp-stats">${t('{n} 个房间', { n: st.rooms })} · ${t('{n} 个物件', { n: st.items })}</div>
      <div class="kp-subtitle">${t('主题色')}</div>
      <div class="kp-swatches kp-swatches-10">${W.PALACE_COLORS.map(c => html`<span class="kp-swatch${c === color ? ' kp-on' : ''}" data-act="palaceColor" data-color="${c}" style="background:${c}" title="${c}"></span>`)}</div>
      <div class="kp-subtitle">${t('屋顶')}</div>
      <div class="kp-seg kp-seg-full">${roofs.map(([k, l]) => html`<button data-act="palaceRoof" data-roof="${k}" class="${roof === k ? 'kp-on' : ''}">${l}</button>`)}</div>
      ${others.length ? html`<label class="kp-field kp-move-to"><span>${t('搬到')}</span><select data-field="palaceRegion">
        <option value="">${getTheme(here?.theme).icon + ' ' + (here?.name || '')}${t('（当前）')}</option>
        ${others.map(r => html`<option value="${r.id}">${getTheme(r.theme).icon + ' ' + r.name}</option>`)}
      </select></label>` : ''}
      <div class="kp-row">
        <button data-act="palaceMove" title="${t('拖动到别处 / 旋转')}">${rich(ICONS.move)} ${t('移动')}</button>
        <button class="kp-danger" data-act="palaceDelete" title="${t('删除这座宫殿')}">${t('删除')}</button>
        <button class="kp-primary kp-grow" data-act="palaceEnter">${t('进入宫殿 →')}</button>
      </div>`);
    (card.querySelector('[data-field="palaceName"]') as HTMLInputElement).value = doc.name;
    card.classList.remove('kp-hidden');
  }

  private renderPropCard() {
    const v = this.v, card = v.ui.townCard;
    const at = this.selectedProp && this.propAt(this.selectedProp);
    if (!at) { card.classList.add('kp-hidden'); return; }
    const kind = propKind(at.prop.kind);
    const specs = kind?.params || [];
    card.replaceChildren(html`
      <button class="kp-close" data-act="propDeselect">×</button>
      <div class="kp-room">${kind ? t(kind.category) : ''} · ${t('摆设')}</div>
      <h3>${kind ? t(kind.name) : at.prop.kind}</h3>
      ${specs.length ? html`<div class="kp-params">${specs.map(spec => propParamField(spec, at.prop.params?.[spec.key] ?? spec.def))}</div>` : ''}
      <div class="kp-row">
        <button data-act="propRotate" title="${t('旋转 90°（R）')}">${rich(ICONS.rotr)} ${t('旋转')}</button>
        <button data-act="propDuplicate" title="${t('复制一份（⌘D）')}">${t('复制')}</button>
        <button class="kp-danger" data-act="propDelete" title="${t('删除这个摆设')}">${t('删除')}</button>
      </div>`);
    card.classList.remove('kp-hidden');
  }

  /** 便签的卡片：换纸色、预览字号、尺寸、旋转、打开编辑器、删除（四角也能直接拖） */
  private renderNoteCard() {
    const v = this.v, card = v.ui.townCard;
    const at = this.selectedNote && this.noteAt(this.selectedNote);
    if (!at) { card.classList.add('kp-hidden'); return; }
    const n = at.note;
    card.replaceChildren(html`
      <button class="kp-close" data-act="noteDeselect">×</button>
      <div class="kp-room">${t('岛屿')} · ${t('便签')}</div>
      <div class="kp-row">
        <button data-act="noteColor" title="${t('换一种纸色')}"><i class="kp-dot" style="background:${notePaper(n)}"></i>${t('背景色')}</button>
        <button data-act="noteSize" data-d="-1" title="${t('预览字号小一点')}">A−</button>
        <button data-act="noteSize" data-d="1" title="${t('预览字号大一点')}">A+</button>
        <button data-act="noteRotate" title="${t('旋转 90°（R）')}">${rich(ICONS.rotr)}</button>
      </div>
      <div class="kp-row">
        <button data-act="noteResize" data-d="-1" title="${t('缩小便签（{step} m 一档）', { step: W.NOTE_SIZE.step })}">${t('缩小')}</button>
        <button data-act="noteResize" data-d="1" title="${t('放大便签（{step} m 一档）', { step: W.NOTE_SIZE.step })}">${t('放大')}</button>
        <button class="kp-primary kp-grow" data-act="noteEdit" title="${t('打开富文本编辑器')}">${t('编辑')}</button>
        <button class="kp-danger" data-act="noteDelete" title="${t('删除这张便签')}">${t('删除')}</button>
      </div>
      <div class="kp-note-sm">${t('双击便签就能在世界上面直接写；拖四角改宽窄和深浅。')}</div>`);
    card.classList.remove('kp-hidden');
  }

  private renderMultiCard() {
    const v = this.v, card = v.ui.townCard;
    const total = this.selectedProps.size + this.selectedNotes.size;
    if (total <= 1) { card.classList.add('kp-hidden'); return; }
    card.replaceChildren(html`
      <button class="kp-close" data-act="multiDeselect">×</button>
      <div class="kp-room">${t('岛屿')} · ${t('多选')}</div>
      <h3>${t('已选 {n} 个物件', { n: total })}</h3>
      <div class="kp-row">
        <button data-act="multiRotate" title="${t('批量旋转 90°（R）')}">${rich(ICONS.rotr)} ${t('旋转')}</button>
        <button data-act="multiDuplicate" title="${t('批量复制（⌘D）')}">${t('复制')}</button>
        <button class="kp-danger" data-act="multiDelete" title="${t('批量删除选中的物件')}">${t('删除')}</button>
      </div>`);
    card.classList.remove('kp-hidden');
  }

  private renderRegionCard(regionId: string) {
    const v = this.v, card = v.ui.townCard;
    const r = this.regionById(regionId);
    if (!r) { card.classList.add('kp-hidden'); return; }
    const theme = getTheme(r.theme);
    const last = this.world.regions.length <= 1;
    const propsCount = r.props?.length ?? 0;
    const notesCount = r.notes?.length ?? 0;
    const currentScale = r.shapeOffsets?.length ? Math.round(r.shapeOffsets.reduce((s, n) => s + n, 0) / r.shapeOffsets.length) : 0;
    card.replaceChildren(html`
      <button class="kp-close" data-act="regionDeselect">×</button>
      <div class="kp-room">${t('岛屿')} · ${theme.icon} ${t(theme.name)}</div>
      <input class="kp-name" data-field="regionName" maxlength="40" spellcheck="false">
      <div class="kp-stats">${t('{props} 个摆设 · {notes} 条便签', { props: propsCount, notes: notesCount })}</div>
      <div class="kp-subtitle">${t('场景风格')}</div>
      <div class="kp-themes">${THEMES.map(th => html`
        <button class="kp-theme${th.id === r.theme ? ' kp-on' : ''}" data-act="regionTheme" data-theme="${th.id}" title="${t(th.desc)}">
          <i style="background:linear-gradient(135deg, ${th.colors[0]} 0 55%, ${th.colors[1]} 55% 78%, ${th.colors[2]} 78%)">${th.icon}</i><span>${t(th.name)}</span>
        </button>`)}</div>
      <div class="kp-subtitle">${t('岛屿大小')}</div>
      <div class="kp-field">
        <span>${t('整体尺寸')}</span>
        <input type="range" data-field="regionScale" min="-20" max="40" step="1" value="${currentScale}">
        <span class="kp-val">${currentScale >= 0 ? '+' : ''}${currentScale}m</span>
      </div>
      <div class="kp-row">
        <button data-act="regionScaleStep" data-d="-2" title="${t('缩小岛屿（-2m）')}">- ${t('缩小')}</button>
        <button data-act="regionScaleStep" data-d="2" title="${t('放大岛屿（+2m）')}">+ ${t('放大')}</button>
        <button class="kp-primary kp-grow" data-act="sculptStart" title="${t('用画笔在海面或海岸上捏造岛屿形状')}">${rich(ICONS.build)} ${t('捏形工具')}</button>
      </div>
      <div class="kp-row">
        ${(r.shapeOffsets?.length || r.props !== undefined) ? html`<button class="kp-danger" data-act="regionResetScenery" title="${t('恢复默认海岸线与自然风景')}">${t('重置风景')}</button>` : ''}
        <button class="kp-danger" data-act="regionDelete" ${last ? 'disabled' : ''} title="${last ? t('至少要保留一座岛') : t('删除这座岛屿')}">${t('删除')}</button>
        <button class="kp-primary kp-grow" data-act="regionGo">${t('前往 →')}</button>
      </div>`);
    (card.querySelector('[data-field="regionName"]') as HTMLInputElement).value = r.name;
    card.classList.remove('kp-hidden');
  }

  onInput(e: Event, commit: boolean) {
    const el = e.target as HTMLInputElement;
    const field = el.dataset?.field;
    const param = el.dataset?.param;
    if (param && this.selectedProp) {
      const at = this.propAt(this.selectedProp);
      const spec = at && propKind(at.prop.kind)?.params?.find(p => p.key === param);
      if (!spec) return;
      if (spec.options) {
        this.setPropParam(param, spec.options[Number(el.value)]?.[0], !commit);
        return;
      }
      let val = Number(el.value);
      if (isNaN(val)) val = spec.def ?? 0;
      if (spec.min !== undefined && val < spec.min) val = spec.min;
      if (spec.max !== undefined && val > spec.max) val = spec.max;
      // 同步兄弟输入控件（滑杆 ↔ 数字框）
      const parent = el.closest('.kp-field');
      if (parent) {
        parent.querySelectorAll<HTMLInputElement>(`input[data-param="${param}"]`).forEach(inp => {
          if (inp !== el) inp.value = String(val);
        });
      }
      if (commit && el.type === 'number') el.value = String(val);
      this.setPropParam(param, val, !commit);
      return;
    }
    if (field === 'palaceName' && this.selectedId) {
      const doc = this.docs.get(this.selectedId), s = this.town.shells.get(this.selectedId);
      if (!doc) return;
      const name = el.value.trim();
      if (!name) { if (commit) el.value = doc.name; return; }
      doc.name = name;
      if (s) this.town.updateTag(s);
      if (commit) {
        doc.updatedAt = Date.now();
        this.v.host.onDocChange?.(doc);
        this.refresh();
      }
      this.v.invalidate();
    } else if (field === 'regionName') {
      const r = this.regionById(this.selectedRegion || this.region.id);
      if (!r) return;
      const name = el.value.trim();
      if (!name) { if (commit) el.value = r.name; return; }
      r.name = name;
      this.layerOf(r.id)?.updateTag(this.docs);
      if (commit) { this.v.worldChanged(); }
      this.v.invalidate();
    } else if (field === 'regionScale') {
      const r = this.regionById(this.selectedRegion || this.region.id);
      if (!r) return;
      const val = Number(el.value) || 0;
      this.applyRegionScale(r, val, commit);
    } else if (field === 'palaceRegion' && commit && el.value && this.selectedId) {
      this.movePalaceTo(this.selectedId, el.value);
    }
  }

  private applyRegionScale(r: W.WorldRegion, targetScale: number, commit: boolean) {
    const count = 16;
    if (!r.shapeOffsets || r.shapeOffsets.length !== count) {
      r.shapeOffsets = new Array(count).fill(targetScale);
    } else {
      const avg = r.shapeOffsets.reduce((s, n) => s + n, 0) / count;
      const diff = targetScale - avg;
      r.shapeOffsets = r.shapeOffsets.map(n => Math.round(Math.max(-30, Math.min(60, n + diff)) * 10) / 10);
    }
    const card = this.v.ui.townCard;
    const valSpan = card?.querySelector('.kp-field .kp-val');
    if (valSpan) valSpan.textContent = `${targetScale >= 0 ? '+' : ''}${targetScale}m`;
    const rangeInp = card?.querySelector<HTMLInputElement>('input[data-field="regionScale"]');
    if (rangeInp) rangeInp.value = String(targetScale);

    this.town.rebuildLand(r.id, this.docs);
    const layer = this.layerOf(r.id);
    if (layer) this.syncVegetation(r, layer);
    this.v.settleRegions();
    if (commit) {
      this.pushUndo(this.snapshot());
      this.v.worldChanged();
    }
    this.v.invalidate();
  }

  stepRegionScale(delta: number) {
    const r = this.regionById(this.selectedRegion || this.region.id);
    if (!r) return;
    const currentScale = r.shapeOffsets?.length ? Math.round(r.shapeOffsets.reduce((s, n) => s + n, 0) / r.shapeOffsets.length) : 0;
    const next = Math.max(-20, Math.min(40, currentScale + delta));
    this.applyRegionScale(r, next, true);
  }

  // =====================================================================
  // 布置：拖动 / 旋转宫殿；群岛视角下拖动岛
  // =====================================================================

  setEditing(on: boolean) {
    if (on && this.v.readonly) return;
    if (!on) {
      // 离开「布置」：正在放的摆设 / 便签撤掉，选中的 / 悬停的放下（不管当前是不是布置模式都收干净）
      this.cancelPropPlacing();
      this.cancelNotePlacing();
      this.commitNoteLive();
      this.closeNoteEditor();
      this.selectProp(null);
      this.selectNote(null);
      this.setPropHover(null);
    }
    if (on === this.editing) return;
    if (on) {
      this.cancelPlacing();
      this.closePanel();
      this.toggleList(false);
      this.v.closePeek();
      // 第一次布置这座岛：把程序化生成的装饰烘焙成数据（样子不变，但从此可以编辑）
      if (!this.v.far) this.ensureProps(this.region);
    }
    this.editing = on;
    this.drag = null;
    this.v.root.classList.toggle('kp-town-editing', on);
    this.renderCard();
    this.updateMarker();
    this.updateUndoButtons();
    this.v.invalidate();
  }

  /** 可撤销的状态：所有岛（位置、名字、场景）、岛上宫殿的摆放、岛上的摆设（props 也在 regions 里） */
  private snapshot() {
    return JSON.stringify(this.world.regions);
  }

  private pushUndo(before: string) {
    if (before === this.snapshot()) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
    return true;
  }

  private commitPalaces(before: string, regionId: string) {
    if (!this.pushUndo(before)) return;
    this.town.rebuildLand(regionId, this.docs);
    this.v.settleRegions();
    this.v.worldChanged();
  }

  private restore(json: string) {
    const v = this.v;
    const cur = this.region?.id;
    this.world.regions = JSON.parse(json);
    v.region = this.world.regions.find(r => r.id === cur) || this.world.regions[0];
    v.closePeek(true);
    this.selectedId = this.selectedRegion = null;
    // 撤销 / 重做会把所有岛推倒重建：摆设的选中和悬停状态一并放下
    this.selectedProp = null;
    this.hoveredProp = null;
    this.town.setPropSelection(null);
    this.town.setPropHover(null);
    this.town.build(this.world, this.docs);
    this.town.setFar(v.far);
    v.settleRegions();
    v.worldChanged();
    v.invalidate(3);
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  private redo() {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  private updateUndoButtons() {
    this.v.ui.townUndo?.toggleAttribute('disabled', !this.undoStack.length);
    this.v.ui.townRedo?.toggleAttribute('disabled', !this.redoStack.length);
  }

  private rotateSelected() {
    if (this.selectedProps.size + this.selectedNotes.size > 1) {
      this.rotateMulti();
      return;
    }
    // 便签优先：正在放 / 正选着便签时，R 转的是它
    const notePlacing = this.notePlacing;
    const noteAt = this.selectedNote ? this.noteAt(this.selectedNote) : null;
    if (notePlacing) { this.rotateNote(notePlacing.note, notePlacing.regionId); return; }
    if (noteAt) { this.rotateNote(noteAt.note, noteAt.region.id); return; }
    // 摆设优先：正在放 / 正选着摆设时，R 转的是它
    const placing = this.propPlacing;
    const at = this.selectedProp ? this.propAt(this.selectedProp) : null;
    if (placing) { this.rotateProp(placing.prop, placing.regionId); return; }
    if (at) { this.rotateProp(at.prop, at.region.id); return; }
    const id = this.placing?.doc.id || this.selectedId;
    const s = id && this.town.shells.get(id);
    const region = s && this.regionById(s.regionId);
    if (!s || !region) { this.v.host.notify?.(t('先点选一座宫殿')); return; }
    const [cx, cz] = W.rectCenter(s.lot);
    const rot = W.normRot(s.placed.rot + 90);
    const pos = W.posForLotCenter(s.doc, rot, cx, cz);
    if (this.placing) {
      Object.assign(s.placed, { rot, pos });
      this.town.placeShell(s);
      this.placing.valid = W.canPlace(region, this.docs, s.placed, s.doc);
      this.updateMarker(this.placing.valid);
      this.v.invalidate();
      return;
    }
    if (!W.canPlace(region, this.docs, { ...s.placed, rot, pos }, s.doc)) {
      this.v.host.notify?.(t('这里转不开，先把宫殿挪到空一点的地方'));
      return;
    }
    const before = this.snapshot();
    Object.assign(s.placed, { rot, pos });
    this.town.placeShell(s);
    this.commitPalaces(before, region.id);
    this.updateMarker();
  }

  // =====================================================================
  // 布置：岛上的摆设（props）
  // =====================================================================

  /** 这座岛还没烘焙过摆设就先烘焙一次：跑的是同一份摆放代码，样子不变，但从此可以编辑 */
  private ensureProps(region: W.WorldRegion): boolean {
    if (region.props !== undefined) return true;
    if (!this.town.bakeProps(region.id)) return false;
    this.v.worldChanged();
    return true;
  }

  /** 摆设的占地半径：地标用自己的阻挡半径，普通摆设给一个小的默认值 */
  private propRadius(prop: W.PlacedProp) {
    return propKind(prop.kind)?.blocker ?? .5;
  }

  /** 这个位置放不放得下：草地上、不压宫殿地块、不和别的摆设挤在一起 */
  private propFits(region: W.WorldRegion, layer: RegionLayer, prop: W.PlacedProp): boolean {
    const [x, z] = prop.pos;
    if (!layer.onLand(x, z, .4)) return false;
    const r = this.propRadius(prop);
    if (region.palaces.length > 0 && Math.hypot(x, z) < W.PLAZA_R + r + PROP_GAP) return false;
    for (const placed of region.palaces) {
      const doc = this.docs.get(placed.palaceId);
      if (!doc) continue;
      const [x0, z0, x1, z1] = W.placedLot(placed, doc);
      if (x > x0 - r - PROP_GAP && x < x1 + r + PROP_GAP && z > z0 - r - PROP_GAP && z < z1 + r + PROP_GAP) return false;
    }
    for (const other of W.propsOf(region)) {
      if (other === prop) continue;
      const gap = Math.max(PROP_GAP, (r + this.propRadius(other)) * .5);
      if (Math.hypot(other.pos[0] - x, other.pos[1] - z) < gap) return false;
    }
    return true;
  }

  /** 新摆设的落点：从镜头中心开始向外螺旋找第一块空地（找不到就先放在中心，用户可以再挪） */
  private freePropSpot(region: W.WorldRegion, layer: RegionLayer, kind: PropKind, near: Vec2): Vec2 {
    const probe: W.PlacedProp = { id: '', kind: kind.kind, pos: [near[0], near[1]] };
    for (let i = 0; i < 64; i++) {
      const a = i * 2.399, d = i ? 1.2 + i * .55 : 0;
      probe.pos = [Math.round(near[0] + Math.cos(a) * d), Math.round(near[1] + Math.sin(a) * d)];
      if (this.propFits(region, layer, probe)) return probe.pos;
    }
    return [Math.round(near[0]), Math.round(near[1])];
  }

  /** 从面板里挑了一个摆设：先按数据加进去（预览就是真数据），再点击空地放下 */
  private startPropPlacing(kindId: string) {
    const v = this.v, region = this.region, layer = this.layerOf(region.id);
    const kind = propKind(kindId);
    if (!kind || !layer || v.far || !this.ensureProps(region)) return;
    // 和放宫殿一样：摆放期间先退出「布置」（底部只留摆放提示条），放完 / 取消再回到布置
    this.setEditing(false);
    this.closePanel();
    const [ox, oz] = W.regionOrigin(region);
    const pos = this.freePropSpot(region, layer, kind, [Math.round(v.orbit.target.x - ox), Math.round(v.orbit.target.z - oz)]);
    const before = this.snapshot();
    const prop = W.addProp(region, kindId, pos, 0);
    this.town.rebuildProps(region.id);
    this.propPlacing = { prop, regionId: region.id, before, valid: true, down: null };
    this.selectProp(prop.id);
    v.root.classList.add('kp-town-placing');
    v.ui.townPlaceHint.replaceChildren(html`${rich(t('把「{name}」放到岛上：点击空地放下 · <b>R</b> 旋转 · <b>Esc</b> 取消', { name: escapeHtml(t(kind.name)) }))}`);
    this.updateMarker(true);
    v.invalidate();
  }

  /** 每帧：把新摆设挪到指针下的草地（只动预览，数据等放下时才算） */
  private movePropPlacing(e: { clientX: number; clientY: number }) {
    const p = this.propPlacing;
    if (!p) return;
    const g = this.regionGround(e, p.regionId);
    const region = this.regionById(p.regionId), layer = this.layerOf(p.regionId);
    if (!g || !region || !layer) return;
    const pos: Vec2 = [Math.round(g[0]), Math.round(g[1])];
    if (pos[0] === p.prop.pos[0] && pos[1] === p.prop.pos[1]) return;
    p.prop.pos = pos;
    this.town.movePropPreview(p.regionId, p.prop.id, pos, p.prop.rot || 0);
    p.valid = this.propFits(region, layer, p.prop);
    this.updateMarker(p.valid);
    this.v.invalidate();
  }

  private commitPropPlacing() {
    const p = this.propPlacing;
    if (!p) return;
    this.propPlacing = null;
    this.v.root.classList.remove('kp-town-placing');
    const region = this.regionById(p.regionId);
    if (!p.valid || !region) {
      if (region) W.removeProp(region, p.prop.id);
      this.selectProp(null);
      this.town.rebuildProps(p.regionId);
      this.v.host.notify?.(t('这里放不下：离其他摆设、宫殿或广场太近了'));
      this.setEditing(true);
      return;
    }
    this.pushUndo(p.before);
    this.v.worldChanged();
    // 回到「布置」，新摆设保持选中（卡片会显示出来，可以接着改参数）
    this.setEditing(true);
    const propObj = this.town.propObj(p.regionId, p.prop.id);
    const box = this.town.propBox(p.regionId, p.prop.id);
    const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
    this.v.spawnFx.trigger(propObj, center);
  }

  /** 只是把预览撤掉；要不要回到「布置」由调用方决定（见 startPropPlacing 的说明） */
  private cancelPropPlacing() {
    const p = this.propPlacing;
    if (!p) return;
    this.propPlacing = null;
    this.v.root.classList.remove('kp-town-placing');
    const region = this.regionById(p.regionId);
    if (region) W.removeProp(region, p.prop.id);
    this.selectProp(null);
    this.town.rebuildProps(p.regionId);
    this.updateMarker();
    this.v.invalidate();
  }

  /** 转 90°：正在放的时候只动预览，已经放好的记一步撤销 */
  private rotateProp(prop: W.PlacedProp, regionId: string) {
    // PlacedProp.rot 是弧度（和 rotation.y 一致），不是宫殿那种度数
    prop.rot = (((prop.rot || 0) + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const placing = this.propPlacing;
    if (placing) {
      this.town.movePropPreview(regionId, prop.id, prop.pos, prop.rot);
      const region = this.regionById(regionId), layer = this.layerOf(regionId);
      if (region && layer) {
        placing.valid = this.propFits(region, layer, prop);
        this.updateMarker(placing.valid);
      }
      this.v.invalidate();
      return;
    }
    const before = this.snapshot();
    this.town.rebuildProps(regionId);
    this.pushUndo(before);
    this.v.worldChanged();
    this.updateMarker();
    this.v.invalidate();
  }

  /** 复制选中的摆设：新的 id、新的随机种子，往旁边挪一点 */
  private duplicateProp() {
    const at = this.selectedProp ? this.propAt(this.selectedProp) : null;
    if (!at) return;
    const before = this.snapshot();
    const copy = W.addProp(at.region, at.prop.kind, [at.prop.pos[0] + 1.2, at.prop.pos[1] + 1.2], at.prop.rot, at.prop.params);
    this.town.rebuildProps(at.region.id);
    this.selectProp(copy.id);
    const propObj = this.town.propObj(at.region.id, copy.id);
    const box = this.town.propBox(at.region.id, copy.id);
    const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
    this.v.spawnFx.trigger(propObj, center);
    this.pushUndo(before);
    this.v.worldChanged();
    this.v.invalidate();
  }

  private deleteProp() {
    const at = this.selectedProp ? this.propAt(this.selectedProp) : null;
    if (!at) return;
    const name = propKind(at.prop.kind)?.name || at.prop.kind;
    const before = this.snapshot();
    this.selectProp(null);
    W.removeProp(at.region, at.prop.id);
    this.town.rebuildProps(at.region.id);
    this.pushUndo(before);
    this.v.worldChanged();
    this.v.host.notify?.(t('已删除「{name}」', { name: t(name) }));
    this.v.invalidate();
  }

  private rotateMulti() {
    const total = this.selectedProps.size + this.selectedNotes.size;
    if (!total) return;
    const before = this.snapshot();
    const affectedRegions = new Set<string>();

    for (const pid of this.selectedProps) {
      const at = this.propAt(pid);
      if (at) {
        at.prop.rot = (((at.prop.rot || 0) + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        affectedRegions.add(at.region.id);
      }
    }
    for (const nid of this.selectedNotes) {
      const at = this.noteAt(nid);
      if (at) {
        at.note.rot = ((((at.note.rot || 0) + 90) % 360) + 360) % 360;
        affectedRegions.add(at.region.id);
      }
    }

    for (const rid of affectedRegions) {
      this.town.rebuildProps(rid);
      this.town.rebuildNotes(rid);
    }
    this.pushUndo(before);
    this.v.worldChanged();
    this.updateMarker();
    this.v.invalidate();
  }

  private duplicateMulti() {
    const total = this.selectedProps.size + this.selectedNotes.size;
    if (!total) return;
    const before = this.snapshot();
    const newProps = new Set<string>();
    const newNotes = new Set<string>();
    const affectedRegions = new Set<string>();

    for (const pid of this.selectedProps) {
      const at = this.propAt(pid);
      if (at) {
        const copy = W.addProp(at.region, at.prop.kind, [at.prop.pos[0] + 1.2, at.prop.pos[1] + 1.2], at.prop.rot, at.prop.params);
        newProps.add(copy.id);
        affectedRegions.add(at.region.id);
      }
    }
    for (const nid of this.selectedNotes) {
      const at = this.noteAt(nid);
      if (at) {
        const copy = W.addNote(at.region, [at.note.pos[0] + 1.2, at.note.pos[1] + 1.2], {
          html: at.note.html,
          color: at.note.color,
          fs: at.note.fs,
          w: at.note.w,
          h: at.note.h,
          rot: at.note.rot,
        });
        newNotes.add(copy.id);
        affectedRegions.add(at.region.id);
      }
    }

    this.selectedProps = newProps;
    this.selectedNotes = newNotes;
    for (const rid of affectedRegions) {
      this.town.rebuildProps(rid);
      this.town.rebuildNotes(rid);
    }
    this.pushUndo(before);
    this.v.worldChanged();

    for (const pid of newProps) {
      const at = this.propAt(pid);
      if (at) {
        const propObj = this.town.propObj(at.region.id, pid);
        const box = this.town.propBox(at.region.id, pid);
        const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
        this.v.spawnFx.trigger(propObj, center);
      }
    }
    for (const nid of newNotes) {
      const at = this.noteAt(nid);
      if (at) {
        const holder = this.town.noteHolder(at.region.id, nid);
        const box = this.town.noteBox(at.region.id, nid);
        const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
        this.v.spawnFx.trigger(holder, center);
      }
    }

    this.updateMarker();
    this.renderCard();
    this.v.invalidate();
  }

  private async deleteMulti() {
    const total = this.selectedProps.size + this.selectedNotes.size;
    if (!total) return;
    const ok = await this.confirm(t('删除选中的 {n} 个物件？', { n: total }), t('选中的物件删除后无法撤销。'), t('删除'));
    if (!ok) return;

    const before = this.snapshot();
    const affectedRegions = new Set<string>();

    for (const pid of this.selectedProps) {
      const at = this.propAt(pid);
      if (at) {
        W.removeProp(at.region, pid);
        affectedRegions.add(at.region.id);
      }
    }
    for (const nid of this.selectedNotes) {
      const at = this.noteAt(nid);
      if (at) {
        W.removeNote(at.region, nid);
        affectedRegions.add(at.region.id);
      }
    }

    this.clearMultiSelect();
    for (const rid of affectedRegions) {
      this.town.rebuildProps(rid);
      this.town.rebuildNotes(rid);
    }
    this.pushUndo(before);
    this.v.worldChanged();
    this.updateMarker();
    this.renderCard();
    this.v.host.notify?.(t('已删除 {n} 个物件', { n: total }));
    this.v.invalidate();
  }

  /**
   * 改摆设参数：live（滑杆拖动中）只重建几何，松手（change）才记一步撤销。
   * params 整份摊开再改一个键，所以 seed / blockers / angle 这些内部字段原样保留，
   * 树冠、浮冰棱角那类由种子定住的随机细节不会重掷。
   */
  private setPropParam(key: string, value: unknown, live: boolean) {
    const at = this.selectedProp ? this.propAt(this.selectedProp) : null;
    if (!at) return;
    if (this.propParamBefore === null) this.propParamBefore = this.snapshot();
    at.prop.params = { ...(at.prop.params || {}), [key]: value };
    const regionId = at.region.id;
    if (live) {
      if (!this.propRaf) this.propRaf = window.requestAnimationFrame(() => {
        this.propRaf = 0;
        this.town.rebuildProps(regionId);
        this.v.invalidate();
      });
      return;
    }
    if (this.propRaf) { cancelAnimationFrame(this.propRaf); this.propRaf = 0; }
    this.town.rebuildProps(regionId);
    const before = this.propParamBefore;
    this.propParamBefore = null;
    if (before !== null) this.pushUndo(before);
    this.v.worldChanged();
    this.v.invalidate();
  }

  /** 添加摆设面板：按 PropKind.category 分组，缩略图和物件目录一样逐帧离屏生成 */
  private openPropPanel() {
    const v = this.v;
    if (v.far) { v.host.notify?.(t('先拉近到一座岛上再添加摆设')); return; }
    if (!this.ensureProps(this.region)) return;
    const thumbs = this.propThumbs ?? (this.propThumbs = new ThumbnailRenderer(v.renderer, v.kit, v.catalog, v.scene.environment));
    this.closePanel();
    this.selectProp(null);
    const groups = new Map<string, PropKind[]>();
    for (const kind of propKinds()) {
      const list = groups.get(kind.category);
      if (list) list.push(kind); else groups.set(kind.category, [kind]);
    }
    const panel = v.ui.propPanel;
    panel.replaceChildren(html`
      <div class="kp-panel-head"><b>${t('添加摆设')}</b><button class="kp-close" data-act="closePanel">×</button></div>
      <div class="kp-list-body">${[...groups].map(([category, kinds]) => html`
        <div class="kp-list-group"><b>${t(category)}</b></div>
        <div class="kp-tiles">${kinds.map(kind => html`
          <button class="kp-tile" data-act="pickProp" data-kind="${kind.kind}" title="${t(kind.name)}">
            <span class="kp-thumb"><img alt="" data-prop="${kind.kind}"></span><span class="kp-tile-name">${t(kind.name)}</span>
          </button>`)}</div>`)}</div>`);
    this.panel = 'props';
    panel.classList.remove('kp-hidden');
    this.renderCard();
    for (const kind of propKinds()) {
      void thumbs.prop(kind).then(url => {
        const img = panel.querySelector<HTMLImageElement>(`img[data-prop="${kind.kind}"]`);
        if (img && url) { img.src = url; img.classList.add('kp-loaded'); }
      });
    }
  }

  /** 岛之间是否留够了海面 */
  private regionFits(region: W.WorldRegion) {
    const radii = this.town.radii();
    const me = W.regionCircle(region, this.docs, radii);
    return this.world.regions.every(o => {
      if (o === region) return true;
      const c = W.regionCircle(o, this.docs, radii);
      return Math.hypot(c.x - me.x, c.z - me.z) >= c.r + me.r + W.SEA_GAP - .5;
    });
  }

  // =====================================================================
  // 建造新宫殿 / 开辟新岛
  // =====================================================================

  private openBuild() {
    const v = this.v, panel = v.ui.buildPanel;
    this.setEditing(false);
    this.toggleList(false);
    this.select(null);
    const n = this.region.palaces.length + 1;
    panel.replaceChildren(html`
      <div class="kp-panel-head"><b>${t('在「{name}」建造一座新宫殿', { name: this.region.name })}</b><button class="kp-close" data-act="closePanel">×</button></div>
      <label class="kp-field kp-name-field"><span>${t('名称')}</span><input class="kp-text" data-ref="newName" maxlength="40" spellcheck="false"></label>
      <div class="kp-templates">${TEMPLATES.map(tpl => html`
        <button class="kp-tpl" data-act="pickTemplate" data-tpl="${tpl.id}">
          <div class="kp-tpl-art">${this.planSvg(tpl.id)}</div>
          <b>${t(tpl.name)}</b><small>${t(tpl.desc)}</small>
        </button>`)}</div>
      <div class="kp-note">${t('选一个模板，然后在岛上点击空地放下。之后可以在宫殿里随意改造。')}</div>`);
    const input = panel.querySelector('input') as HTMLInputElement;
    input.value = t('新宫殿 {n}', { n });
    v.ui.newName = input;
    this.panel = 'build';
    panel.classList.remove('kp-hidden');
    input.focus();
    input.select();
  }

  private openNewIsland() {
    const v = this.v, panel = v.ui.buildPanel;
    this.setEditing(false);
    this.toggleList(false);
    this.selectRegion(null);
    panel.replaceChildren(html`
      <div class="kp-panel-head"><b>${t('开辟一座新岛')}</b><button class="kp-close" data-act="closePanel">×</button></div>
      <label class="kp-field kp-name-field"><span>${t('名称')}</span><input class="kp-text" data-ref="newName" maxlength="40" spellcheck="false" placeholder="${t('不填就按场景起名')}"></label>
      <div class="kp-templates">${THEMES.map(th => html`
        <button class="kp-tpl" data-act="pickTheme" data-theme="${th.id}">
          <div class="kp-tpl-art">${this.themeArt(th.id)}</div>
          <b>${th.icon} ${t(th.name)}</b><small>${t(th.desc)}</small>
        </button>`)}</div>
      <div class="kp-note">${t('新岛会出现在群岛旁边，之后可以在「布置岛屿」里拖到别处，也可以在岛屿设置里换场景。')}</div>`);
    const input = panel.querySelector('input') as HTMLInputElement;
    v.ui.newName = input;
    this.panel = 'island';
    panel.classList.remove('kp-hidden');
    input.focus();
  }

  private closePanel() {
    this.panel = null;
    this.v.ui.buildPanel.classList.add('kp-hidden');
    this.v.ui.propPanel.classList.add('kp-hidden');
    this.renderCard();
  }

  /** 模板的迷你平面图 */
  private planSvg(id: string) {
    if (this.planCache.has(id)) return this.planCache.get(id).cloneNode(true) as DocumentFragment;
    const doc = createFromTemplate(id, 'x');
    const rooms = doc.rooms.filter(r => r.floor);
    const bb = W.bboxOf(rooms.map(r => r.rect));
    const pad = .6, w = bb[2] - bb[0] + pad * 2, h = bb[3] - bb[1] + pad * 2;
    const fills: Record<string, string> = { oak: '#e6cfae', oakWarm: '#d4b08a', deck: '#bfa089', tileLarge: '#e9e4dc', tileBath: '#d9e4e0', cement: '#dcd3c6' };
    const svg = html`<svg viewBox="${bb[0] - pad} ${bb[1] - pad} ${w} ${h}" preserveAspectRatio="xMidYMid meet">${rooms.map(r => {
      const [x0, z0, x1, z1] = r.rect;
      return html`<rect x="${x0}" y="${z0}" width="${x1 - x0}" height="${z1 - z0}" fill="${fills[r.floor] || '#e6cfae'}" stroke="#4a4139" stroke-width="${Math.max(w, h) * .018}"/>`;
    })}</svg>`;
    this.planCache.set(id, svg);
    return svg.cloneNode(true) as DocumentFragment;
  }

  /** 场景主题的小插图：海 + 海岸 + 岛 + 图标 */
  private themeArt(id: string) {
    const t = getTheme(id), [g, shore, accent] = t.colors;
    const floating = !!t.lift;
    return html`<svg viewBox="0 0 100 70">
      <rect width="100" height="70" rx="8" fill="${floating ? '#dcecf5' : '#9fd3cf'}"/>
      ${floating ? html`<path d="M22 36 Q50 72 78 36 Z" fill="#8b7e6f"/><ellipse cx="30" cy="54" rx="12" ry="5" fill="#fff"/><ellipse cx="72" cy="58" rx="10" ry="4" fill="#fff"/>` : html`<ellipse cx="50" cy="38" rx="38" ry="22" fill="${shore}"/>`}
      <ellipse cx="50" cy="${floating ? 34 : 36}" rx="${floating ? 30 : 33}" ry="${floating ? 12 : 18}" fill="${g}"/>
      <circle cx="${floating ? 60 : 64}" cy="${floating ? 30 : 30}" r="5" fill="${accent}"/>
      <text x="50" y="${floating ? 36 : 42}" font-size="18" text-anchor="middle">${t.icon}</text>
    </svg>`;
  }

  // =====================================================================
  // 布置：岛上的便签
  // =====================================================================

  /** 从工具栏加一张便签：先按数据加进去（预览就是真数据），再点击地面放下 */
  private startNotePlacing() {
    const v = this.v, region = this.region, layer = this.layerOf(region.id);
    if (!layer || v.far) { v.host.notify?.(t('先拉近到一座岛上再添加便签')); return; }
    // 和放摆设一样：摆放期间先退出「布置」（底部只留摆放提示条），放完 / 取消再回到布置
    this.setEditing(false);
    this.closePanel();
    const [ox, oz] = W.regionOrigin(region);
    const pos = this.freeNoteSpot(layer, [snapNote(v.orbit.target.x - ox), snapNote(v.orbit.target.z - oz)]);
    const before = this.snapshot();
    const note = W.addNote(region, pos);
    this.town.rebuildNotes(region.id);
    this.notePlacing = { note, regionId: region.id, before, valid: true, down: null };
    this.selectNote(note.id);
    v.root.classList.add('kp-town-placing');
    v.ui.townPlaceHint.replaceChildren(html`${rich(t('把便签放到岛上：点击地面放下 · <b>R</b> 旋转 · <b>Esc</b> 取消'))}`);
    this.updateMarker(true);
    v.invalidate();
  }

  /** 便签的落点：从 near 向外螺旋找一块在岛上的地；便签是平的、不挡东西，所以不做碰撞 */
  private freeNoteSpot(layer: RegionLayer, near: Vec2): Vec2 {
    for (let i = 0; i < 64; i++) {
      const a = i * 2.399, d = i ? 1.2 + i * .55 : 0;
      const x = snapNote(near[0] + Math.cos(a) * d), z = snapNote(near[1] + Math.sin(a) * d);
      if (layer.onLand(x, z, 1.2)) return [x, z];
    }
    return near;
  }

  /** 吸附：编辑器里开着吸附（且没按 Alt）时对到 5 cm 网格 */
  private snapPoint(p: Vec2, alt?: boolean): Vec2 {
    const on = this.v.editor?.snap !== false && !alt;
    return on ? [snapNote(p[0]), snapNote(p[1])] : p;
  }

  private moveNotePlacing(e: { clientX: number; clientY: number; altKey?: boolean }) {
    const p = this.notePlacing;
    if (!p) return;
    const g = this.regionGround(e, p.regionId), layer = this.layerOf(p.regionId);
    if (!g || !layer) return;
    p.note.pos = this.snapPoint(g, e.altKey);
    p.valid = layer.onLand(p.note.pos[0], p.note.pos[1], 1.2);
    this.town.moveNotePreview(p.regionId, p.note.id, p.note.pos, p.note.rot || 0);
    this.updateMarker(p.valid);
    this.v.invalidate();
  }

  private commitNotePlacing() {
    const p = this.notePlacing;
    if (!p) return;
    this.notePlacing = null;
    this.v.root.classList.remove('kp-town-placing');
    const region = this.regionById(p.regionId);
    if (!p.valid || !region) {
      if (region) W.removeNote(region, p.note.id);
      this.selectNote(null);
      if (region) this.town.rebuildNotes(p.regionId);
      this.v.host.notify?.(t('便签要落在岛上'));
      this.setEditing(true);
      this.v.invalidate();
      return;
    }
    this.pushUndo(p.before);
    this.v.worldChanged();
    // 回到「布置」，新便签保持选中（卡片会显示出来，可以接着改）
    this.setEditing(true);
    this.town.rebuildNotes(p.regionId);
    const holder = this.town.noteHolder(p.regionId, p.note.id);
    const box = this.town.noteBox(p.regionId, p.note.id);
    const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
    this.v.spawnFx.trigger(holder, center);
    this.v.invalidate();
  }

  private cancelNotePlacing() {
    const p = this.notePlacing;
    if (!p) return;
    this.notePlacing = null;
    this.v.root.classList.remove('kp-town-placing');
    const region = this.regionById(p.regionId);
    if (region) W.removeNote(region, p.note.id);
    this.selectNote(null);
    this.town.rebuildNotes(p.regionId);
    this.updateMarker();
    this.v.invalidate();
  }

  private rotateNote(note: W.PlacedNote, regionId: string) {
    note.rot = ((((note.rot || 0) + 90) % 360) + 360) % 360;
    if (this.notePlacing) {
      this.town.moveNotePreview(regionId, note.id, note.pos, note.rot);
      this.v.invalidate();
      return;
    }
    const before = this.snapshot();
    this.town.rebuildNotes(regionId);
    this.pushUndo(before);
    this.v.worldChanged();
    this.updateMarker();
    this.v.invalidate();
  }

  /** 改选中便签的一个字段（纸色 / 字号 / 尺寸）：一步撤销 */
  private editNote(patch: Partial<W.PlacedNote>) {
    const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
    if (!at) return;
    const before = this.snapshot();
    Object.assign(at.note, patch);
    this.town.rebuildNotes(at.region.id);
    this.pushUndo(before);
    this.v.worldChanged();
    this.renderCard();
    this.updateMarker();
    this.v.invalidate();
  }

  /** 删除便签：不可撤销，所以先确认 */
  private async deleteNote() {
    const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
    if (!at) return;
    const ok = await this.confirm(t('删除这张便签？'), t('便签删除后无法撤销。'), t('删除'));
    if (!ok) return;
    this.selectNote(null);
    W.removeNote(at.region, at.note.id);
    this.town.rebuildNotes(at.region.id);
    this.v.worldChanged();
    this.v.invalidate();
  }

  // ---- 编辑：直接在便签上写（DOM 贴在便签上，就是在世界上改） ----

  private startNoteLive(id: string) {
    const at = this.noteAt(id);
    if (!at) return;
    const v = this.v;
    this.closeNoteEditor();
    v.ui.noteLiveBox.replaceChildren(noteToDom(at.note.html));
    this.noteLive = { id, regionId: at.region.id };
    v.root.classList.add('kp-note-editing');
    // 贴图只留纸面：文字交给 DOM（真文字，清晰、能改）
    this.town.paperNote(at.region.id, id, true);
    this.positionNoteOverlays();
    v.ui.noteLive.classList.remove('kp-hidden');
    v.invalidate();
    // 摆好了再聚焦，并把光标放到末尾（不然 caret 会落在文首）
    window.requestAnimationFrame(() => {
      const box = v.ui.noteLiveBox;
      box.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  /** 写完：内容变了就存下来、贴图重新画上文字。便签内容不参与撤销（和卡片上的操作不一样）。 */
  private commitNoteLive() {
    const e = this.noteLive;
    if (!e) return;
    this.noteLive = null;
    const v = this.v;
    v.ui.noteLive.classList.add('kp-hidden');
    v.root.classList.remove('kp-note-editing');
    this.town.paperNote(e.regionId, e.id, false);
    const at = this.noteAt(e.id);
    const html_ = W.sanitizeNoteHtml(v.ui.noteLiveBox.innerHTML);
    if (!at || html_ === at.note.html) { v.invalidate(); return; }
    at.note.html = html_;
    this.town.rebuildNotes(e.regionId);
    v.worldChanged();
    v.invalidate();
  }

  /** 便签局部坐标 → 屏幕 CSS 像素（相对 .kp-root） */
  private noteScreen(layer: RegionLayer, note: W.PlacedNote, X: number, Z: number) {
    const [lx, lz] = noteToWorld(note, X, Z);
    const p = new THREE.Vector3(lx, GRASS_Y + NOTE_LIFT, lz).applyMatrix4(layer.group.matrixWorld).project(this.v.isoCam);
    const r = this.v.renderer.domElement.getBoundingClientRect();
    return { x: (p.x * .5 + .5) * r.width, y: (-p.y * .5 + .5) * r.height };
  }

  /**
   * 便签落到屏幕上的那个四边形。正交相机下地面上的平面投到屏幕上是仿射的，
   * 所以一个普通 DOM 元素用 matrix(a,b,c,d,e,f) 就能严丝合缝贴在便签上——
   * 也因此这里的文字是真正被光栅化的文字，比画进贴图清晰得多。
   */
  private noteQuad(note: W.PlacedNote, layer: RegionLayer) {
    const c = noteCorners(note);
    const p00 = this.noteScreen(layer, note, c[0][0], c[0][1]);
    const p10 = this.noteScreen(layer, note, c[1][0], c[1][1]);
    const p01 = this.noteScreen(layer, note, c[2][0], c[2][1]);
    const p11 = this.noteScreen(layer, note, c[3][0], c[3][1]);
    const ux = p10.x - p00.x, uy = p10.y - p00.y;
    const vx = p01.x - p00.x, vy = p01.y - p00.y;
    const uw = Math.hypot(ux, uy) || 1, vh = Math.hypot(vx, vy) || 1;
    return { p00, p10, p01, p11, ux, uy, vx, vy, uw, vh, mpx: uw / Math.max(.2, note.w) };
  }

  /** 每帧：把「直接在便签上写」的 DOM 和四个角贴到便签上（镜头动了也跟着） */
  private positionNoteOverlays() {
    const v = this.v;
    const live = this.noteLive;
    const id = live ? live.id : this.selectedNote;
    const at = id ? this.noteAt(id) : null;
    const layer = at ? this.layerOf(at.region.id) : undefined;
    const q = at && layer ? this.noteQuad(at.note, layer) : null;
    const wrap = v.ui.noteLive;
    if (q && live) {
      wrap.style.transformOrigin = '0 0';
      // 基向量取单位长度：元素里的 1px 就是屏幕上的 1px，字不会被拉伸糊掉
      wrap.style.transform = `matrix(${q.ux / q.uw}, ${q.uy / q.uw}, ${q.vx / q.vh}, ${q.vy / q.vh}, ${q.p00.x}, ${q.p00.y})`;
      wrap.style.width = `${q.uw}px`;
      wrap.style.height = `${q.vh}px`;
      wrap.style.fontSize = `${Math.max(6, at!.note.fs * q.mpx)}px`;
      wrap.style.padding = `${Math.max(2, q.mpx * .14)}px`;
      wrap.classList.remove('kp-hidden');
    } else wrap.classList.add('kp-hidden');

    const handles = v.ui.noteHandles;
    if (q && this.selectedNote && !live) {
      const kids = handles.children as HTMLCollectionOf<HTMLElement>;
      const pts = [q.p00, q.p10, q.p01, q.p11];
      for (let i = 0; i < kids.length; i++) {
        kids[i].style.left = `${pts[i].x}px`;
        kids[i].style.top = `${pts[i].y}px`;
      }
      handles.classList.remove('kp-hidden');
    } else handles.classList.add('kp-hidden');
  }

  // ---- 拖角改尺寸：宽 / 深各自独立，对角固定 ----

  private beginNoteResize(corner: number, e: PointerEvent) {
    const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
    if (!at) return;
    const c = noteCorners(at.note);
    const opp = c[3 - corner] || c[0];
    // 指针要捕获在画布上：视图的 pointermove / pointerup 是挂在画布上的，
    // 捕获在句柄上这些事件就到不了拖动逻辑（句柄只是 DOM，不是画布）。
    try { this.v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
    this.commitNoteLive();
    this.noteResize = {
      regionId: at.region.id, noteId: at.note.id, corner,
      fixed: noteToWorld(at.note, opp[0], opp[1]) as Vec2,
      before: this.snapshot(), moved: false,
    };
    this.v.invalidate();
  }

  private moveNoteResize(e: { clientX: number; clientY: number; altKey?: boolean }) {
    const rz = this.noteResize;
    if (!rz) return;
    const at = this.noteAt(rz.noteId);
    const g = this.regionGround(e, rz.regionId);
    if (!at || !g) return;
    // 相对固定的那个角，在便签自己的坐标里量出新的宽 / 深
    const relX = g[0] - rz.fixed[0], relZ = g[1] - rz.fixed[1];
    const a = (at.note.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const X = relX * c - relZ * s, Z = relX * s + relZ * c;
    const on = this.v.editor?.snap !== false && !e.altKey;
    const snap = (n: number) => (on ? Math.round(n / NOTE_GRID) * NOTE_GRID : n);
    const w = clampNum(snap(Math.abs(X)), W.NOTE_SIZE.min, W.NOTE_SIZE.max);
    const h = clampNum(snap(Math.abs(Z)), W.NOTE_SIZE.min, W.NOTE_SIZE.max);
    const sx = X < 0 ? -1 : 1, sz = Z < 0 ? -1 : 1;
    const nx = rz.fixed[0] + (sx * w / 2) * c + (sz * h / 2) * s;
    const nz = rz.fixed[1] - (sx * w / 2) * s + (sz * h / 2) * c;
    if (w === at.note.w && h === at.note.h && nx === at.note.pos[0] && nz === at.note.pos[1]) return;
    at.note.w = w;
    at.note.h = h;
    at.note.pos = [nx, nz];
    rz.moved = true;
    this.town.rebuildNotes(rz.regionId);
    this.updateMarker();
    this.v.invalidate();
  }

  private endNoteResize() {
    const rz = this.noteResize;
    if (!rz) return;
    this.noteResize = null;
    if (rz.moved) {
      this.pushUndo(rz.before);
      this.v.worldChanged();
    }
    this.v.invalidate();
  }

  // ---- 编辑：打开富文本编辑器（Quill） ----

  private quillFor(): Promise<QuillLike> {
    if (this.quillReady) return this.quillReady;
    this.quillReady = import('quill').then(mod => {
      // esm / cjs 互操作：有 default 就用 default，否则整个模块就是构造器
      const Ctor: unknown = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
      // Quill 的运行时不导出可用的构造器类型，这里按最小接口造一个实例
      const q = new (Ctor as new (el: Element, opts: unknown) => QuillLike)(this.v.ui.noteEditor, {
        theme: 'snow',
        placeholder: t('写点什么…'),
        modules: { toolbar: [['bold', 'italic', 'underline'], [{ header: [1, 2, 3, false] }], [{ list: 'ordered' }, { list: 'bullet' }], ['link', 'clean']] },
      });
      this.quill = q;
      return q;
    });
    return this.quillReady;
  }

  private async openNoteEditor(id: string) {
    const at = this.noteAt(id);
    if (!at) return;
    this.commitNoteLive();
    this.noteModal = { id, regionId: at.region.id };
    this.v.ui.noteEditorWrap.classList.remove('kp-hidden');
    const quill = await this.quillFor();
    quill.setContents(quill.clipboard.convert({ html: W.sanitizeNoteHtml(at.note.html) }), 'silent');
    quill.history.clear();
    // 光标落到末尾：接着写，而不是每次都在开头（或上次的位置）插入。
    // 必须先 focus()：它会把 Quill 存着的那段选区恢复回来，之后设的光标才算数。
    quill.focus();
    quill.setSelection(quill.getLength() - 1, 0);
  }

  /** 内容不参与撤销（和原地编辑一致） */
  private saveNoteEditor() {
    const m = this.noteModal;
    if (!m) return;
    this.noteModal = null;
    this.v.ui.noteEditorWrap.classList.add('kp-hidden');
    const at = this.noteAt(m.id);
    const html_ = W.sanitizeNoteHtml(this.quill?.root.innerHTML || '');
    if (!at || html_ === at.note.html) return;
    at.note.html = html_;
    this.town.rebuildNotes(m.regionId);
    this.v.worldChanged();
    this.v.invalidate();
  }

  private closeNoteEditor() {
    if (!this.noteModal) return;
    this.noteModal = null;
    this.v.ui.noteEditorWrap?.classList.add('kp-hidden');
  }

  // =====================================================================
  // 岛屿捏形工具（扩建海岸 / 削减海湾）
  // =====================================================================

  startSculpt() {
    const v = this.v;
    if (v.far) { v.host.notify?.(t('先拉近到一座岛上再调整形状')); return; }
    this.sculptMode = true;
    this.sculptBrush = 'expand';
    this.setEditing(false);
    this.closePanel();
    this.selectProp(null);
    this.selectNote(null);
    this.selectRegion(null);
    v.root.classList.add('kp-town-placing');
    this.updateSculptUI();
    v.setCursor('crosshair');
    v.invalidate();
  }

  setSculptBrush(brush: 'expand' | 'shrink') {
    this.sculptBrush = brush;
    this.updateSculptUI();
    this.v.invalidate();
  }

  private updateSculptUI() {
    const v = this.v;
    const isExp = this.sculptBrush === 'expand';
    v.ui.townPlaceHint.replaceChildren(html`
      <div class="kp-seg" style="display:inline-flex;margin-right:8px;vertical-align:middle">
        <button class="${isExp ? 'kp-on' : ''}" data-act="sculptBrushExpand">${t('填海扩岛')}</button>
        <button class="${!isExp ? 'kp-on' : ''}" data-act="sculptBrushShrink">${t('削减海湾')}</button>
      </div>
      <span>${rich(isExp ? t('按住拖动扩建陆地（也可按住 <b>Alt / ⌥</b> 临时削减）') : t('按住拖动削减内凹海湾（也可松开 <b>Alt</b> 扩建）'))}</span>
    `);
  }

  stopSculpt() {
    if (!this.sculptMode) return;
    this.sculptMode = false;
    this.sculptDrag = null;
    const v = this.v;
    v.root.classList.remove('kp-town-placing');
    v.setCursor('');
    v.invalidate();
  }

  private applySculpt(e: PointerEvent, force = false) {
    const v = this.v, region = this.region, layer = this.layerOf(region.id);
    if (!layer) return;
    const g = this.town.groundOf(this.ray(e), layer);
    if (!g) return;
    const now = performance.now();
    if (!force && this.sculptDrag && now - this.sculptDrag.lastApply < 45) return;
    if (this.sculptDrag) this.sculptDrag.lastApply = now;

    const [cx, cz] = layer.center;
    const dx = g[0] - cx, dz = g[1] - cz;
    let angle = Math.atan2(dz, dx);
    if (angle < 0) angle += Math.PI * 2;

    const count = 16;
    if (!region.shapeOffsets || region.shapeOffsets.length !== count) {
      region.shapeOffsets = new Array(count).fill(0);
    }

    const normAngle = angle / (Math.PI * 2) * count;
    const centerIdx = Math.round(normAngle) % count;
    const isShrink = e.altKey ? this.sculptBrush === 'expand' : this.sculptBrush === 'shrink';
    const delta = isShrink ? -1.8 : 1.8;

    for (let k = -2; k <= 2; k++) {
      const idx = (centerIdx + k + count) % count;
      const weight = k === 0 ? 1 : Math.abs(k) === 1 ? 0.65 : 0.3;
      const current = region.shapeOffsets[idx] ?? 0;
      region.shapeOffsets[idx] = Math.round(Math.max(-30, Math.min(60, current + delta * weight)) * 10) / 10;
    }

    this.town.rebuildLand(region.id, this.docs);
    this.syncVegetation(region, layer);
    this.v.settleRegions();
    this.v.invalidate();
  }

  /**
   * 扩岛或缩岛时同步植被：
   * 1. 缩岛削减时：清理已经不在陆地范围内的自然植物。
   * 2. 扩岛扩大时：在新扩出的陆地空隙处补充散布自然植物。
   */
  private syncVegetation(region: W.WorldRegion, layer: RegionLayer) {
    if (!region.props) return;
    const NATURE_KINDS = new Set(['tree', 'conifer', 'shrub', 'flower', 'reed', 'blossom-tree', 'boulder', 'snowdrift']);
    let changed = false;

    // 1. 移除掉入海里的植物
    const surviving = region.props.filter(p => {
      if (!NATURE_KINDS.has(p.kind)) return true;
      const keep = layer.onLand(p.pos[0], p.pos[1], 0.2);
      if (!keep) changed = true;
      return keep;
    });

    // 2. 检查新陆地并适量补种植物
    const [cx, cz] = layer.center;
    const maxR = layer.maxR;
    const step = 4.5;
    let addedCount = 0;
    const maxAdd = 12;

    const n0 = Math.floor((cx - maxR) / step), n1 = Math.ceil((cx + maxR) / step);
    const m0 = Math.floor((cz - maxR) / step), m1 = Math.ceil((cz + maxR) / step);

    for (let j = m0; j <= m1 && addedCount < maxAdd; j++) {
      for (let i = n0; i <= n1 && addedCount < maxAdd; i++) {
        const x = (i + 0.5) * step;
        const z = (j + 0.5) * step;
        if (!layer.onLand(x, z, 1.8)) continue;

        // 检查附近是否已经有任何摆设
        const hasNear = surviving.some(p => Math.hypot(p.pos[0] - x, p.pos[1] - z) < 3.2);
        if (hasNear) continue;

        // 根据主题风格选择自然植物种类
        let kind = 'tree';
        let params: Record<string, unknown> = {};
        if (region.theme === 'snow') {
          kind = 'conifer';
          params = { h: 2.8, snow: true, leaf: 'pine' };
        } else if (region.theme === 'sky') {
          kind = Math.random() < 0.4 ? 'blossom-tree' : 'tree';
          params = { h: 2.6, variant: 1 };
        } else {
          kind = Math.random() < 0.65 ? 'tree' : 'shrub';
          params = { h: 2.8, variant: 0 };
        }

        const id = `${kind}-${Math.floor(Math.random() * 1e8).toString(36)}`;
        surviving.push({ id, kind, pos: [Math.round(x * 10) / 10, Math.round(z * 10) / 10], params: { ...params, seed: Math.floor(Math.random() * 1e6) } });
        addedCount++;
        changed = true;
      }
    }

    if (changed) {
      region.props = surviving;
      layer.rebuildDecor();
    }
  }

  private startPlacing(tplId: string) {
    const v = this.v, region = this.region;
    const name = ((v.ui.newName as HTMLInputElement)?.value || '').trim() || t('新宫殿 {n}', { n: region.palaces.length + 1 });
    const doc = createFromTemplate(tplId, name);
    const used = new Set([...this.docs.values()].map(d => W.palaceColor(d)));
    doc.color = W.PALACE_COLORS.find(c => !used.has(c)) || W.palaceColor(doc);
    const tgt = v.orbit.target, [ox, oz] = W.regionOrigin(region);
    const pos = W.findFreeSpot(region, this.docs, doc, 0, [Math.round(tgt.x - ox), Math.round(tgt.z - oz)]);
    const placed: W.PlacedPalace = { palaceId: doc.id, pos, rot: 0 };
    this.town.addShell(region, placed, doc);
    this.placing = { doc, placed, regionId: region.id, valid: true, down: null };
    this.closePanel();
    this.select(null);
    v.root.classList.add('kp-town-placing');
    v.ui.townPlaceHint.replaceChildren(html`${rich(t('把「{name}」放到岛上：点击空地放下 · <b>R</b> 旋转 · <b>Esc</b> 取消', { name: escapeHtml(name) }))}`);
    this.updateMarker(true);
    v.invalidate();
  }

  private movePlacing(e: { clientX: number; clientY: number }) {
    const p = this.placing;
    const g = p && this.regionGround(e, p.regionId);
    if (!g) return;
    const pos = W.posForLotCenter(p.doc, p.placed.rot, g[0], g[1]);
    if (pos[0] === p.placed.pos[0] && pos[1] === p.placed.pos[1]) return;
    p.placed.pos = pos;
    const s = this.town.shells.get(p.doc.id);
    if (s) this.town.placeShell(s);
    p.valid = W.canPlace(this.regionById(p.regionId), this.docs, p.placed, p.doc);
    this.updateMarker(p.valid);
    this.v.invalidate();
  }

  private commitPlacing() {
    const p = this.placing;
    if (!p) return;
    if (!p.valid) { this.v.host.notify?.(t('这里放不下：离其他宫殿或广场太近了')); return; }
    const region = this.regionById(p.regionId);
    this.placing = null;
    this.v.root.classList.remove('kp-town-placing');
    this.docs.set(p.doc.id, p.doc);
    region.palaces.push(p.placed);
    this.undoStack = [];
    this.redoStack = [];
    this.v.host.onDocChange?.(p.doc);
    this.town.rebuildLand(region.id, this.docs);
    this.v.settleRegions();
    this.v.worldChanged();
    this.v.setMarker(null);
    this.v.host.notify?.(t('「{name}」建好了', { name: p.doc.name }));
    this.v.enterPalace(p.doc.id);
  }

  private cancelPlacing() {
    const p = this.placing;
    if (!p) return;
    this.placing = null;
    this.town.removeShell(p.doc.id);
    this.v.root.classList.remove('kp-town-placing');
    this.updateMarker();
    this.v.invalidate();
  }

  private createIsland(themeId: string) {
    const v = this.v, theme = getTheme(themeId);
    let name = ((v.ui.newName as HTMLInputElement)?.value || '').trim();
    if (!name) {
      const base = t(W.THEME_NAMES[themeId] || '新的岛');
      const taken = new Set(this.world.regions.map(r => r.name));
      name = base;
      for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
    }
    const before = this.snapshot();
    const region = W.createRegion(name, theme.id);
    region.origin = W.findRegionSpot(this.world, this.docs, region, this.town.radii());
    this.world.regions.push(region);
    this.town.addRegion(region, this.docs);
    this.town.updateBounds();
    v.settleRegions();
    this.pushUndo(before);
    this.closePanel();
    v.worldChanged();
    v.flyToRegion(region.id, 1.4);
    v.host.notify?.(t('「{name}」开辟好了，点「建造宫殿」建第一座宫殿吧', { name }));
  }

  // =====================================================================
  // 岛：换场景 / 删除；宫殿：搬到别的岛 / 删除
  // =====================================================================

  private setTheme(regionId: string, themeId: string) {
    const v = this.v, r = this.regionById(regionId);
    if (!r || r.theme === themeId) return;
    const before = this.snapshot();
    v.closePeek(true);
    r.theme = themeId;
    this.town.addRegion(r, this.docs);
    this.town.setFar(v.far);
    this.town.updateBounds();
    v.settleRegions();
    this.pushUndo(before);
    v.worldChanged();
    v.invalidate(3);
  }

  private async deleteRegion(regionId: string) {
    const v = this.v, r = this.regionById(regionId);
    if (!r || r.palaces.some(p => this.docs.has(p.palaceId)) || this.world.regions.length <= 1) return;
    const ok = await this.confirm(t('删除「{name}」？', { name: r.name }), t('这是一座空岛，删除后它会从群岛里消失。'), t('删除'));
    if (!ok) return;
    const before = this.snapshot();
    this.selectRegion(null);
    this.world.regions = this.world.regions.filter(x => x !== r);
    this.town.removeRegion(r.id);
    this.town.updateBounds();
    if (v.region === r) v.region = this.world.regions[0];
    this.pushUndo(before);
    v.worldChanged();
    v.invalidate(3);
  }

  private async resetIslandScenery(regionId: string) {
    const v = this.v, r = this.regionById(regionId);
    if (!r) return;
    const ok = await this.confirm(t('重新生成风景？'), t('将清除这座岛上所有摆设的修改与新增，恢复并重新生成自然风景。'), t('重新生成'));
    if (!ok) return;
    const before = this.snapshot();
    this.selectProp(null);
    delete r.props;
    delete r.shapeOffsets;
    r.seed = Math.floor(Math.random() * 1e6);
    this.town.rebuildLand(r.id, this.docs);
    v.settleRegions();
    this.pushUndo(before);
    this.renderCard();
    v.worldChanged();
    v.invalidate(3);
  }

  private movePalaceTo(id: string, targetId: string) {
    const v = this.v;
    const from = v.regionOf(id);
    const before = this.snapshot();
    const placed = W.movePalaceToRegion(this.world, this.docs, id, targetId);
    if (!placed || !from) return;
    v.closePeek(true);
    this.select(null);
    v.refreshShell(id, true);
    this.town.rebuildLand(from.id, this.docs);
    v.settleRegions();
    this.pushUndo(before);
    v.worldChanged();
    const target = this.regionById(targetId);
    v.flyToRegion(targetId, 1.3);
    this.select(id);
    v.host.notify?.(t('已把「{palace}」搬到「{island}」', { palace: this.docs.get(id)?.name ?? '', island: target?.name ?? '' }));
  }

  private async deletePalace(id: string) {
    const v = this.v, doc = this.docs.get(id), region = v.regionOf(id);
    if (!doc || !region) return;
    const st = W.palaceStats(doc);
    const ok = await this.confirm(t('删除「{name}」？', { name: doc.name }), t('宫殿里的 {n} 个物件会一起删除，此操作无法撤销。', { n: st.items }), t('删除'));
    if (!ok || !this.docs.has(id)) return;
    v.closePeek(true);
    this.select(null);
    region.palaces = region.palaces.filter(p => p.palaceId !== id);
    this.docs.delete(id);
    this.town.removeShell(id);
    this.town.rebuildLand(region.id, this.docs);
    this.undoStack = [];
    this.redoStack = [];
    v.host.onDocDelete?.(id);
    v.worldChanged();
    v.host.notify?.(t('已删除「{name}」', { name: doc.name }));
    v.invalidate(3);
  }

  private confirm(title: string, msg: string, ok: string) {
    const v = this.v;
    v.ui.confirmTitle.textContent = title;
    v.ui.confirmMsg.textContent = msg;
    v.ui.confirmYes.textContent = ok;
    v.ui.confirmWrap.classList.remove('kp-hidden');
    return new Promise<boolean>((resolve) => {
      this.confirmResolve?.(false);
      this.confirmResolve = resolve;
    });
  }

  private closeConfirm(ok: boolean) {
    this.v.ui.confirmWrap.classList.add('kp-hidden');
    const r = this.confirmResolve;
    this.confirmResolve = null;
    r?.(ok);
    this.v.root.focus({ preventScroll: true });
  }

  // =====================================================================
  // 列表（按岛分组）
  // =====================================================================

  private toggleList(on = !this.listOpen) {
    this.listOpen = on;
    const v = this.v;
    v.ui.townList.classList.toggle('kp-hidden', !on);
    v.ui.segMap?.classList.toggle('kp-on', !on);
    v.ui.segList?.classList.toggle('kp-on', on);
    if (on) { this.closePanel(); this.renderList(); }
  }

  private renderList() {
    const v = this.v;
    const regions = [...this.world.regions].sort((a, b) => (a === this.region ? -1 : b === this.region ? 1 : 0));
    const total = regions.reduce((s, r) => s + r.palaces.filter(p => this.docs.has(p.palaceId)).length, 0);
    const row = (d: PalaceDoc) => {
      const st = W.palaceStats(d), placed = v.placementOf(d.id);
      const color = placed?.roofColor || W.palaceColor(d);
      return html`<div class="kp-list-row${d.id === this.selectedId ? ' kp-on' : ''}" data-id="${d.id}">
        <button class="kp-list-main" data-act="listPick" data-id="${d.id}">
          <i style="background:${color}"></i>
          <span><b>${d.name}</b><small>${t('{n} 个房间', { n: st.rooms })} · ${t('{n} 个物件', { n: st.items })} · ${timeAgo(d.updatedAt)}</small></span>
        </button>
        <button class="kp-list-go" data-act="listEnter" data-id="${d.id}" title="${t('进入')}">→</button>
      </div>`;
    };
    v.ui.townList.replaceChildren(html`
      <div class="kp-panel-head"><b>${t('全部宫殿 · {n}', { n: total })}</b><button class="kp-close" data-act="viewMap">×</button></div>
      <div class="kp-list-body">${regions.map(r => {
        const docs = r.palaces.map(p => this.docs.get(p.palaceId)).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
        return html`<button class="kp-list-group" data-act="listRegion" data-region="${r.id}">
            <em>${getTheme(r.theme).icon}</em><b>${r.name}</b><small>${t('{n} 座', { n: docs.length })}</small></button>
          ${docs.length ? docs.map(row) : html`<div class="kp-empty kp-empty-sm">${t('空岛')}</div>`}`;
      })}</div>
      <button class="kp-list-add" data-act="${v.far ? 'newIsland' : 'buildPalace'}">${rich(ICONS.plus)}<span>${v.far ? t('开辟新岛') : t('建造宫殿')}</span></button>`);
  }

  // =====================================================================
  // ⌘K 快速跳转
  // =====================================================================

  openPalette() {
    const v = this.v;
    v.ui.paletteWrap.classList.remove('kp-hidden');
    const input = v.ui.paletteInput as HTMLInputElement;
    input.value = '';
    this.paletteSel = 0;
    this.renderPalette();
    window.requestAnimationFrame(() => input.focus());
  }

  closePalette() {
    this.v.ui.paletteWrap.classList.add('kp-hidden');
    this.v.root.focus({ preventScroll: true });
  }

  private get paletteOpen() { return !this.v.ui.paletteWrap.classList.contains('kp-hidden'); }

  private renderPalette(recompute = true) {
    const v = this.v;
    if (recompute) {
      const q = (v.ui.paletteInput as HTMLInputElement).value.trim().toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      const match = (s: string) => tokens.every(tok => s.toLowerCase().includes(tok));
      const out: PaletteItem[] = [];
      for (const r of this.world.regions) {
        const th = getTheme(r.theme), thName = t(th.name);
        if (!tokens.length || match(r.name + ' ' + thName + ' ' + th.name)) {
          out.push({ kind: 'region', id: r.id, title: `${th.icon} ${r.name}`, sub: `${thName}`, color: th.colors[0] });
        }
      }
      this.palette = out.slice(0, 60);
      this.paletteSel = Math.min(this.paletteSel, Math.max(0, this.palette.length - 1));
    }
    const kinds = { palace: t('宫殿'), region: t('岛') };
    const list = v.ui.paletteList;
    list.replaceChildren(html`${this.palette.length ? this.palette.map((it, i) => html`
      <button class="kp-pal-row${i === this.paletteSel ? ' kp-on' : ''}" data-act="palPick" data-i="${i}">
        <i style="background:${it.color}"></i>
        <span><b>${it.title}</b><small>${it.sub}</small></span>
        <kbd>${kinds[it.kind]}</kbd>
      </button>`) : html`<div class="kp-empty">${t('没有找到匹配的岛屿')}</div>`}`);
    list.querySelector('.kp-on')?.scrollIntoView({ block: 'nearest' });
  }

  private pickPalette(it: PaletteItem) {
    this.closePalette();
    const v = this.v;
    if (it.kind === 'region') {
      if (v.level === 'palace') { v.exitPalace(); window.setTimeout(() => v.flyToRegion(it.id), 1200); } else v.flyToRegion(it.id);
    } else v.enterPalace(it.id);
  }

  // =====================================================================
  // 指针 / 键盘 / 按钮
  // =====================================================================

  /** 捕获阶段的 pointerdown；返回 true 表示接管（不平移视角） */
  /** 局部点投到屏幕 CSS 像素（相对 .kp-root） */
  private pointScreen(layer: RegionLayer, x: number, z: number, y = GRASS_Y) {
    const p = new THREE.Vector3(x, layer.lift + y, z).applyMatrix4(layer.group.matrixWorld).project(this.v.isoCam);
    const r = this.v.renderer.domElement.getBoundingClientRect();
    return { x: (p.x * .5 + .5) * r.width, y: (-p.y * .5 + .5) * r.height };
  }

  /** 捕获阶段的 pointerdown；返回 true 表示接管（不平移视角） */
  onPointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    // 便签四角的句柄自己处理 pointerdown（拖角改尺寸），不要当成画布上的拖动
    if ((e.target as HTMLElement)?.closest?.('.kp-note-handle')) return false;
    if (this.placing) { this.placing.down = { x: e.clientX, y: e.clientY }; return false; }
    if (this.propPlacing) { this.propPlacing.down = { x: e.clientX, y: e.clientY }; return false; }
    if (this.notePlacing) { this.notePlacing.down = { x: e.clientX, y: e.clientY }; return false; }
    if (this.sculptMode) {
      this.sculptDrag = { regionId: this.region.id, mode: e.altKey ? 'shrink' : 'expand', before: this.snapshot(), lastApply: 0 };
      this.applySculpt(e, true);
      try { this.v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
      return true;
    }
    const v = this.v;
    if (v.far) {
      const rid = this.pickRegion(e);
      const r = rid && this.regionById(rid), layer = rid && this.layerOf(rid);
      const g = layer && this.town.groundOf(this.ray(e), layer);
      if (!r || !g) return false;
      this.selectRegion(rid);
      const o = W.regionOrigin(r);
      this.drag = { kind: 'region', id: rid, offset: [-g[0], -g[1]], orig: [...o] as Vec2, before: this.snapshot(), valid: true, moved: false };
      try { v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
      return true;
    }

    const hit = this.pickPropOrPalace(e);

    // 如果没有点中任何物体，并且在布置状态或按住 Shift，启动框选矩形
    if (!hit.note && !hit.prop && !hit.palaceId) {
      if (this.editing || e.shiftKey) {
        this.boxSelect = { startX: e.clientX, startY: e.clientY, moved: false };
        try { v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
        return true;
      }
      return false;
    }

    if (!this.editing) {
      this.setEditing(true);
    }

    const regionId = hit.note?.regionId || hit.prop?.regionId;
    const region = regionId ? this.regionById(regionId) : undefined;
    const layer = region && this.layerOf(region.id);
    const g = layer && this.town.groundOf(this.ray(e), layer);
    const note = hit.note && region ? W.findNote(region, hit.note.noteId) : null;
    const prop = hit.prop && region ? W.findProp(region, hit.prop.propId) : null;

    // 如果点中的是当前多选集合里的成员，启动整组拖动
    const isMultiTarget = (prop && this.selectedProps.has(prop.id)) || (note && this.selectedNotes.has(note.id));
    if (isMultiTarget && (this.selectedProps.size + this.selectedNotes.size > 1) && region && g) {
      const propOffsets = new Map<string, Vec2>();
      const noteOffsets = new Map<string, Vec2>();
      const propOrig = new Map<string, Vec2>();
      const noteOrig = new Map<string, Vec2>();
      for (const pid of this.selectedProps) {
        const p = W.findProp(region, pid);
        if (p) {
          propOffsets.set(pid, [p.pos[0] - g[0], p.pos[1] - g[1]]);
          propOrig.set(pid, [...p.pos] as Vec2);
        }
      }
      for (const nid of this.selectedNotes) {
        const n = W.findNote(region, nid);
        if (n) {
          noteOffsets.set(nid, [n.pos[0] - g[0], n.pos[1] - g[1]]);
          noteOrig.set(nid, [...n.pos] as Vec2);
        }
      }
      this.drag = {
        kind: 'group',
        regionId: region.id,
        anchorPos: [g[0], g[1]],
        propOffsets,
        noteOffsets,
        propOrig,
        noteOrig,
        before: this.snapshot(),
        valid: true,
        moved: false,
      };
      try { v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
      return true;
    }

    // 单个物件拖动
    if (note && region && layer && g) {
      this.selectNote(note.id);
      this.drag = { kind: 'note', regionId: region.id, noteId: note.id, offset: [note.pos[0] - g[0], note.pos[1] - g[1]], orig: [...note.pos] as Vec2, before: this.snapshot(), valid: true, moved: false };
    } else if (prop && region && layer && g) {
      this.selectProp(prop.id);
      this.drag = { kind: 'prop', regionId: region.id, propId: prop.id, offset: [prop.pos[0] - g[0], prop.pos[1] - g[1]], orig: [...prop.pos] as Vec2, before: this.snapshot(), valid: true, moved: false };
    } else {
      const id = this.pickPalace(e);
      const s = id && this.town.shells.get(id);
      const sg = s && this.regionGround(e, s.regionId);
      if (!s || !sg) return false;
      this.select(id);
      this.drag = { kind: 'palace', id, regionId: s.regionId, offset: [s.placed.pos[0] - sg[0], s.placed.pos[1] - sg[1]], orig: [...s.placed.pos] as Vec2, before: this.snapshot(), valid: true, moved: false };
    }
    try { v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
    return true;
  }

  onPointerMove(e: PointerEvent): boolean {
    if (this.sculptDrag) {
      this.applySculpt(e);
      return true;
    }
    if (this.noteResize) { this.moveNoteResize(e); return true; }
    if (this.propPlacing && !e.buttons) { this.movePropPlacing(e); return true; }
    if (this.notePlacing && !e.buttons) { this.moveNotePlacing(e); return true; }
    if (this.placing && !e.buttons) { this.movePlacing(e); return true; }

    // 处理框选矩形
    if (this.boxSelect) {
      const dx = e.clientX - this.boxSelect.startX;
      const dy = e.clientY - this.boxSelect.startY;
      if (Math.hypot(dx, dy) > 4) {
        this.boxSelect.moved = true;
        const rect = this.v.root.getBoundingClientRect();
        const left = Math.min(this.boxSelect.startX, e.clientX) - rect.left;
        const top = Math.min(this.boxSelect.startY, e.clientY) - rect.top;
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        const m = this.v.ui.marquee;
        if (m) {
          m.style.left = `${left}px`;
          m.style.top = `${top}px`;
          m.style.width = `${width}px`;
          m.style.height = `${height}px`;
          m.classList.remove('kp-hidden');
        }

        // 动态计算框内选中的物件
        const minX = Math.min(this.boxSelect.startX, e.clientX) - rect.left;
        const maxX = Math.max(this.boxSelect.startX, e.clientX) - rect.left;
        const minY = Math.min(this.boxSelect.startY, e.clientY) - rect.top;
        const maxY = Math.max(this.boxSelect.startY, e.clientY) - rect.top;

        const region = this.region;
        const layer = region && this.layerOf(region.id);
        if (region && layer) {
          this.selectedProps.clear();
          this.selectedNotes.clear();
          if (region.props) {
            for (const p of region.props) {
              const sp = this.pointScreen(layer, p.pos[0], p.pos[1]);
              if (sp.x >= minX && sp.x <= maxX && sp.y >= minY && sp.y <= maxY) {
                this.selectedProps.add(p.id);
              }
            }
          }
          if (region.notes) {
            for (const n of region.notes) {
              const sp = this.pointScreen(layer, n.pos[0], n.pos[1]);
              if (sp.x >= minX && sp.x <= maxX && sp.y >= minY && sp.y <= maxY) {
                this.selectedNotes.add(n.id);
              }
            }
          }
          this.selectedProp = null;
          this.selectedNote = null;
          this.updateMarker();
        }
      }
      return true;
    }

    const d = this.drag;
    if (!d) return false;
    if (d.kind === 'region') {
      const r = this.regionById(d.id), layer = this.layerOf(d.id);
      const g = layer && this.town.groundOf(this.ray(e), layer);
      if (!r || !g) return true;
      const o = W.regionOrigin(r);
      const next: Vec2 = [Math.round(o[0] + g[0] + d.offset[0]), Math.round(o[1] + g[1] + d.offset[1])];
      if (next[0] !== o[0] || next[1] !== o[1]) {
        r.origin = next;
        layer.place();
        d.valid = this.regionFits(r);
        d.moved = true;
        layer.tag.element.classList.toggle('kp-bad', !d.valid);
        this.v.invalidate();
      }
      return true;
    }
    if (d.kind === 'note') {
      const region = this.regionById(d.regionId), layer = this.layerOf(d.regionId);
      const note = region && W.findNote(region, d.noteId);
      const ng = this.regionGround(e, d.regionId);
      if (!note || !region || !layer || !ng) return true;
      const next: Vec2 = this.snapPoint([ng[0] + d.offset[0], ng[1] + d.offset[1]], e.altKey);
      if (next[0] !== note.pos[0] || next[1] !== note.pos[1]) {
        note.pos = next;
        this.town.moveNotePreview(d.regionId, d.noteId, next, note.rot || 0);
        d.valid = layer.onLand(next[0], next[1], 1.2);
        d.moved = true;
        this.updateMarker(d.valid);
        this.v.invalidate();
      }
      return true;
    }
    if (d.kind === 'prop') {
      const region = this.regionById(d.regionId), layer = this.layerOf(d.regionId);
      const prop = region && W.findProp(region, d.propId);
      const pg = this.regionGround(e, d.regionId);
      if (!prop || !region || !layer || !pg) return true;
      const next: Vec2 = [Math.round(pg[0] + d.offset[0]), Math.round(pg[1] + d.offset[1])];
      if (next[0] !== prop.pos[0] || next[1] !== prop.pos[1]) {
        prop.pos = next;
        this.town.movePropPreview(d.regionId, d.propId, next, prop.rot || 0);
        d.valid = this.propFits(region, layer, prop);
        d.moved = true;
        this.updateMarker(d.valid);
        this.v.invalidate();
      }
      return true;
    }
    if (d.kind === 'group') {
      const region = this.regionById(d.regionId), layer = this.layerOf(d.regionId);
      const g = this.regionGround(e, d.regionId);
      if (!region || !layer || !g) return true;
      d.moved = true;
      let allValid = true;

      for (const [pid, offset] of d.propOffsets) {
        const prop = W.findProp(region, pid);
        if (prop) {
          const next: Vec2 = [Math.round(g[0] + offset[0]), Math.round(g[1] + offset[1])];
          prop.pos = next;
          this.town.movePropPreview(d.regionId, pid, next, prop.rot || 0);
          if (!layer.onLand(next[0], next[1], 0.2)) allValid = false;
        }
      }
      for (const [nid, offset] of d.noteOffsets) {
        const note = W.findNote(region, nid);
        if (note) {
          const next: Vec2 = this.snapPoint([g[0] + offset[0], g[1] + offset[1]], e.altKey);
          note.pos = next;
          this.town.moveNotePreview(d.regionId, nid, next, note.rot || 0);
          if (!layer.onLand(next[0], next[1], 1.2)) allValid = false;
        }
      }
      d.valid = allValid;
      this.updateMarker(d.valid);
      this.v.invalidate();
      return true;
    }
    const g = this.regionGround(e, d.regionId), s = this.town.shells.get(d.id), region = this.regionById(d.regionId);
    if (!g || !s || !region) return true;
    const pos: Vec2 = [Math.round(g[0] + d.offset[0]), Math.round(g[1] + d.offset[1])];
    if (pos[0] !== s.placed.pos[0] || pos[1] !== s.placed.pos[1]) {
      s.placed.pos = pos;
      this.town.placeShell(s);
      d.valid = W.canPlace(region, this.docs, s.placed, s.doc);
      d.moved = true;
      this.updateMarker(d.valid);
      this.v.invalidate();
    }
    return true;
  }

  onPointerUp(e: PointerEvent): boolean {
    if (this.sculptDrag) {
      const before = this.sculptDrag.before;
      this.sculptDrag = null;
      this.pushUndo(before);
      this.v.worldChanged();
      this.v.invalidate();
      return true;
    }
    if (this.noteResize) { this.endNoteResize(); return true; }
    const np = this.notePlacing;
    if (np) {
      const down = np.down;
      np.down = null;
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return !!down;
      this.moveNotePlacing(e);
      this.commitNotePlacing();
      return true;
    }
    const pp = this.propPlacing;
    if (pp) {
      const down = pp.down;
      pp.down = null;
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return !!down;
      this.movePropPlacing(e);
      this.commitPropPlacing();
      return true;
    }
    const p = this.placing;
    if (p) {
      const down = p.down;
      p.down = null;
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return !!down;
      this.movePlacing(e);
      this.commitPlacing();
      return true;
    }

    // 框选结束
    if (this.boxSelect) {
      const moved = this.boxSelect.moved;
      this.boxSelect = null;
      this.v.ui.marquee?.classList.add('kp-hidden');
      if (moved) {
        const total = this.selectedProps.size + this.selectedNotes.size;
        if (total === 1) {
          const firstProp = [...this.selectedProps][0];
          const firstNote = [...this.selectedNotes][0];
          this.clearMultiSelect();
          if (firstProp) this.selectProp(firstProp);
          else if (firstNote) this.selectNote(firstNote);
        } else if (total > 1) {
          this.selectedProp = null;
          this.selectedNote = null;
          this.updateMarker();
          this.renderCard();
        } else {
          this.clearMultiSelect();
          this.updateMarker();
          this.renderCard();
        }
        this.v.invalidate();
        return true;
      }
    }

    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    if (d.kind === 'region') {
      const r = this.regionById(d.id), layer = this.layerOf(d.id);
      layer?.tag.element.classList.remove('kp-bad');
      if (r && d.moved) {
        if (d.valid) {
          this.pushUndo(d.before);
          this.town.updateBounds();
          this.v.worldChanged();
        } else {
          r.origin = d.orig;
          layer?.place();
          this.v.host.notify?.(t('离其他岛太近了，岛和岛之间要留出一片海'));
        }
      }
      this.v.invalidate();
      return true;
    }
    if (d.kind === 'note') {
      const region = this.regionById(d.regionId);
      const note = region && W.findNote(region, d.noteId);
      if (note && region && d.moved) {
        if (d.valid) {
          this.pushUndo(d.before);
          this.v.worldChanged();
          const holder = this.town.noteHolder(d.regionId, d.noteId);
          const box = this.town.noteBox(d.regionId, d.noteId);
          const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
          this.v.spawnFx.dropImpact(holder, center, 0.7);
        } else {
          note.pos = d.orig;
          this.town.moveNotePreview(d.regionId, d.noteId, d.orig, note.rot || 0);
          this.v.host.notify?.(t('便签要落在岛上'));
        }
      }
      this.updateMarker();
      this.v.invalidate();
      return true;
    }
    if (d.kind === 'prop') {
      const region = this.regionById(d.regionId);
      const prop = region && W.findProp(region, d.propId);
      if (prop && region && d.moved) {
        if (d.valid) {
          this.pushUndo(d.before);
          this.v.worldChanged();
          const propObj = this.town.propObj(d.regionId, d.propId);
          const box = this.town.propBox(d.regionId, d.propId);
          const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
          this.v.spawnFx.dropImpact(propObj, center, 1.1);
        } else {
          prop.pos = d.orig;
          this.town.movePropPreview(d.regionId, d.propId, d.orig, prop.rot || 0);
          this.v.host.notify?.(t('这里放不下：离其他摆设、宫殿或广场太近了'));
        }
      }
      this.updateMarker();
      this.v.invalidate();
      return true;
    }
    if (d.kind === 'group') {
      const region = this.regionById(d.regionId);
      if (region && d.moved) {
        if (d.valid) {
          this.pushUndo(d.before);
          this.v.worldChanged();
          for (const pid of d.propOffsets.keys()) {
            const propObj = this.town.propObj(d.regionId, pid);
            const box = this.town.propBox(d.regionId, pid);
            const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
            this.v.spawnFx.dropImpact(propObj, center, 1.0);
          }
          for (const nid of d.noteOffsets.keys()) {
            const holder = this.town.noteHolder(d.regionId, nid);
            const box = this.town.noteBox(d.regionId, nid);
            const center = box ? box.getCenter(new THREE.Vector3()) : undefined;
            this.v.spawnFx.dropImpact(holder, center, 0.7);
          }
        } else {
          for (const [pid, orig] of d.propOrig) {
            const prop = W.findProp(region, pid);
            if (prop) {
              prop.pos = orig;
              this.town.movePropPreview(d.regionId, pid, orig, prop.rot || 0);
            }
          }
          for (const [nid, orig] of d.noteOrig) {
            const note = W.findNote(region, nid);
            if (note) {
              note.pos = orig;
              this.town.moveNotePreview(d.regionId, nid, orig, note.rot || 0);
            }
          }
          this.v.host.notify?.(t('部分物件超出了陆地范围'));
        }
      }
      this.updateMarker();
      this.v.invalidate();
      return true;
    }
    const s = this.town.shells.get(d.id);
    if (s && d.moved) {
      if (d.valid) {
        this.commitPalaces(d.before, d.regionId);
        const center = s.group.getWorldPosition(new THREE.Vector3());
        this.v.spawnFx.dropImpact(s.group, center, 1.8);
      } else {
        s.placed.pos = d.orig;
        this.town.placeShell(s);
        this.v.host.notify?.(t('这里放不下：离其他宫殿或广场太近了'));
      }
    }
    this.updateMarker();
    this.v.invalidate();
    return true;
  }

  /** 两个层级都生效的快捷键（⌘K、弹层里的 Esc） */
  onGlobalKey(e: KeyboardEvent): boolean {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      if (this.paletteOpen) this.closePalette(); else this.openPalette();
      return true;
    }
    if (e.key === 'Escape') {
      if (this.confirmResolve) { this.closeConfirm(false); return true; }
      if (this.paletteOpen) { this.closePalette(); return true; }
    }
    return false;
  }

  /** 小镇层级的按键；返回 true 表示已处理 */
  onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (this.editing && mod && k === 'z') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (this.editing && mod && k === 'y') { this.redo(); return true; }
    if (this.editing && mod && k === 'd' && !this.v.far) {
      if (this.selectedProps.size + this.selectedNotes.size > 1) { this.duplicateMulti(); return true; }
      if (this.selectedProp) { this.duplicateProp(); return true; }
    }
    if (mod) return false;
    if (k === 'escape') {
      if (this.sculptMode) this.stopSculpt();
      else if (this.noteLive) this.commitNoteLive();
      else if (this.noteModal) this.closeNoteEditor();
      else if (this.notePlacing) { this.cancelNotePlacing(); this.setEditing(true); }
      else if (this.propPlacing) { this.cancelPropPlacing(); this.setEditing(true); }
      else if (this.placing) this.cancelPlacing();
      else if (this.panel) this.closePanel();
      else if (this.selectedProps.size + this.selectedNotes.size > 1) { this.clearMultiSelect(); this.updateMarker(); this.renderCard(); }
      else if (this.editing) this.setEditing(false);
      else if (this.listOpen) this.toggleList(false);
      else if (this.selectedId) this.select(null);
      else if (this.selectedRegion) this.selectRegion(null);
      else return false;
      return true;
    }
    if (k === 'r' && !this.v.far && (this.editing || this.placing || this.propPlacing || this.notePlacing)) { this.rotateSelected(); return true; }
    if (k === 'a' && this.editing && !this.v.far && !this.propPlacing && !this.notePlacing) { this.openPropPanel(); return true; }
    if (k === 'b' && !this.placing && !this.propPlacing && !this.notePlacing) { this.setEditing(!this.editing); return true; }
    if (k === 'enter' && !this.editing) {
      if (this.v.far && this.selectedRegion) { this.v.flyToRegion(this.selectedRegion); return true; }
      if (!this.v.far && this.selectedId) { this.v.enterPalace(this.selectedId); return true; }
    }
    if ((k === 'delete' || k === 'backspace') && this.editing && !this.v.far) {
      if (this.selectedProps.size + this.selectedNotes.size > 1) { void this.deleteMulti(); return true; }
      if (this.selectedNote) { void this.deleteNote(); return true; }
      if (this.selectedProp) { this.deleteProp(); return true; }
      if (this.selectedId) { void this.deletePalace(this.selectedId); return true; }
    }
    return false;
  }

  onAction(act: string, el: HTMLElement, _e: MouseEvent): boolean {
    const v = this.v;
    switch (act) {
      case 'palette': this.openPalette(); return true;
      case 'palPick': { const it = this.palette[Number(el.dataset.i)]; if (it) this.pickPalette(it); return true; }
      case 'confirmYes': this.closeConfirm(true); return true;
      case 'confirmNo': this.closeConfirm(false); return true;
    }
    if (v.level !== 'town') return false;
    const id = this.selectedId;
    switch (act) {
      case 'tag': if (!this.placing && !v.far) this.select(el.dataset.id); return true;
      case 'regionTag': if (!this.editing) this.selectRegion(el.dataset.id); return true;
      case 'buildPalace':
        if (v.far) { v.flyToRegion(this.region.id); window.setTimeout(() => this.openBuild(), 900); } else this.openBuild();
        return true;
      case 'newIsland': this.openNewIsland(); return true;
      case 'closePanel': this.closePanel(); return true;
      case 'pickTemplate': this.startPlacing(el.dataset.tpl); return true;
      case 'pickTheme': this.createIsland(el.dataset.theme); return true;
      case 'townPlaceCancel':
        if (this.sculptMode) this.stopSculpt();
        else if (this.notePlacing) { this.cancelNotePlacing(); this.setEditing(true); }
        else if (this.propPlacing) { this.cancelPropPlacing(); this.setEditing(true); }
        else this.cancelPlacing();
        return true;
      case 'sculptStart': this.startSculpt(); return true;
      case 'sculptBrushExpand': this.setSculptBrush('expand'); return true;
      case 'sculptBrushShrink': this.setSculptBrush('shrink'); return true;
      case 'regionScaleStep': this.stepRegionScale(Number(el.dataset.d) || 0); return true;
      case 'townEdit': this.setEditing(true); return true;
      case 'townEditDone': this.setEditing(false); return true;
      case 'townRotate': this.rotateSelected(); return true;
      case 'townUndo': this.undo(); return true;
      case 'townRedo': this.redo(); return true;
      case 'townDeselect': this.select(null); return true;
      case 'propPanel': this.openPropPanel(); return true;
      case 'pickProp': this.startPropPlacing(el.dataset.kind); return true;
      case 'propDeselect': this.selectProp(null); return true;
      case 'propRotate': this.rotateSelected(); return true;
      case 'propDuplicate': this.duplicateProp(); return true;
      case 'propDelete': this.deleteProp(); return true;
      case 'multiDeselect': this.clearMultiSelect(); this.updateMarker(); this.renderCard(); this.v.invalidate(); return true;
      case 'multiRotate': this.rotateMulti(); return true;
      case 'multiDuplicate': this.duplicateMulti(); return true;
      case 'multiDelete': void this.deleteMulti(); return true;
      case 'noteAdd': this.startNotePlacing(); return true;
      case 'noteDeselect': this.selectNote(null); return true;
      case 'noteColor': {
        const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
        if (at) this.editNote({ color: (at.note.color + 1) % W.NOTE_COLORS.length });
        return true;
      }
      case 'noteSize': {
        const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
        if (at) this.editNote({ fs: clampNum(at.note.fs + Number(el.dataset.d) * W.NOTE_FS.step, W.NOTE_FS.min, W.NOTE_FS.max) });
        return true;
      }
      case 'noteResize': {
        const at = this.selectedNote ? this.noteAt(this.selectedNote) : null;
        if (at) {
          const d = Number(el.dataset.d) * W.NOTE_SIZE.step;
          this.editNote({
            w: clampNum(at.note.w + d, W.NOTE_SIZE.min, W.NOTE_SIZE.max),
            h: clampNum(at.note.h + d, W.NOTE_SIZE.min, W.NOTE_SIZE.max),
          });
        }
        return true;
      }
      case 'noteRotate': this.rotateSelected(); return true;
      case 'noteEdit': if (this.selectedNote) void this.openNoteEditor(this.selectedNote); return true;
      case 'noteDelete': void this.deleteNote(); return true;
      case 'noteEditorSave': this.saveNoteEditor(); return true;
      case 'noteEditorCancel': this.closeNoteEditor(); return true;
      case 'regionDeselect': this.selectRegion(null); return true;
      case 'toWorld': this.select(null); v.flyToWorld(); return true;
      case 'toPlanet': this.select(null); this.selectRegion(null); v.flyToPlanet(); return true;
      case 'regionSettings': this.selectRegion(this.region.id); return true;
      case 'regionGo': {
        const rid = this.selectedRegion;
        this.selectRegion(null);
        if (rid) v.flyToRegion(rid);
        return true;
      }
      case 'regionTheme': if (this.selectedRegion) this.setTheme(this.selectedRegion, el.dataset.theme); return true;
      case 'regionResetScenery': if (this.selectedRegion) void this.resetIslandScenery(this.selectedRegion); return true;
      case 'resetIslandScenery': if (this.region) void this.resetIslandScenery(this.region.id); return true;
      case 'regionDelete': if (this.selectedRegion) void this.deleteRegion(this.selectedRegion); return true;
      case 'regionPalace': {
        const pid = el.dataset.id, rid = v.regionOf(pid)?.id;
        this.selectRegion(null);
        if (rid) { v.flyToRegion(rid); this.select(pid); }
        return true;
      }
      case 'viewMap': this.toggleList(false); return true;
      case 'viewList': this.toggleList(true); return true;
      case 'listRegion': this.toggleList(false); v.flyToRegion(el.dataset.region); return true;
      case 'listPick': {
        const pid = el.dataset.id, s = this.town.shells.get(pid), layer = s && this.layerOf(s.regionId);
        if (s && layer) {
          if (v.region !== layer.region) v.region = layer.region;
          const [x, z] = W.rectCenter(s.lot), [ox, oz] = W.regionOrigin(layer.region);
          v.flyTo(ox + x, oz + z, Math.max(30, (s.lot[2] - s.lot[0]) * 2.4), .9, layer.lift);
        }
        this.select(pid);
        return true;
      }
      case 'listEnter': this.toggleList(false); v.enterPalace(el.dataset.id); return true;
      case 'palaceEnter': if (id) v.enterPalace(id); return true;
      case 'palaceMove': this.setEditing(true); return true;
      case 'palaceDelete': if (id) void this.deletePalace(id); return true;
      case 'palaceColor': {
        const doc = id && this.docs.get(id), placed = id && v.placementOf(id);
        if (!doc || !placed) return true;
        doc.color = el.dataset.color;
        doc.updatedAt = Date.now();
        const hadRoofColor = !!placed.roofColor;
        delete placed.roofColor;
        v.host.onDocChange?.(doc);
        if (hadRoofColor) v.worldChanged();
        this.reshell(id);
        return true;
      }
      case 'palaceRoof': {
        const placed = id && v.placementOf(id);
        if (!placed) return true;
        const before = this.snapshot();
        placed.roof = el.dataset.roof as W.RoofKind;
        if (placed.roof === 'auto') delete placed.roof;
        this.reshell(id);
        this.pushUndo(before);
        v.worldChanged();
        return true;
      }
    }
    return false;
  }

  /** 外观变了（颜色 / 屋顶）：只重建这一座的外壳 */
  private reshell(id: string) {
    const v = this.v;
    const peeking = v.peek?.id === id && v.peek.open;
    v.refreshShell(id, false);
    if (peeking) v.openPeek(id);
    this.refresh();
    v.invalidate();
  }

  dispose() {
    this.confirmResolve?.(false);
    this.confirmResolve = null;
    if (this.propRaf) cancelAnimationFrame(this.propRaf);
    this.propRaf = 0;
    this.propThumbs?.dispose();
    this.propThumbs = null;
  }
}

/**
 * 摆设参数的输入行：和 editor.ts 的 paramField 用同一套样式（实现各写各的，
 * 免得小镇控制器去碰编辑器的内部）。摆设的参数只有「下拉」和「滑杆」两种。
 */
function propParamField(spec: ParamSpec, value: unknown) {
  if (spec.options) {
    const idx = Math.max(0, spec.options.findIndex(([v]) => v === value));
    return html`<label class="kp-field"><span>${t(spec.label)}</span><select data-param="${spec.key}">${spec.options.map(([, label], i) => html`<option value="${i}"${i === idx ? ' selected' : ''}>${t(label)}</option>`)}</select></label>`;
  }
  const n = Number(value ?? spec.def ?? 0);
  const step = spec.step ?? .1;
  return html`<label class="kp-field"><span>${t(spec.label)}</span><input type="range" data-param="${spec.key}" min="${spec.min}" max="${spec.max}" step="${step}" value="${n}"><input type="number" class="kp-param-num" data-param="${spec.key}" min="${spec.min}" max="${spec.max}" step="${step}" value="${n}"></label>`;
}
