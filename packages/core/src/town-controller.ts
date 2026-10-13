import * as THREE from 'three';
import type { PalaceView } from './view';
import { type PalaceDoc, type Vec2 } from './schema';
import type { PropHit, RegionLayer } from './world-layer';
import type { ParamSpec } from './catalog';
import { propKind, propKinds, type PropKind } from './props';
import { ThumbnailRenderer } from './thumbs';
import { ICONS, escapeHtml, timeAgo } from './icons';
import { html, rich } from './dom';
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

/** SVG 的子元素要放在 <svg> 里解析才是 SVG 元素：包一层再取出里面的节点（只有 <path> 的图标、插图里的片段） */

interface PaletteItem { kind: 'palace' | 'region'; id: string; title: string; sub: string; color: string }
type Drag =
  | { kind: 'palace'; id: string; regionId: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'region'; id: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean }
  | { kind: 'prop'; regionId: string; propId: string; offset: Vec2; orig: Vec2; before: string; valid: boolean; moved: boolean };

/** 正在往岛上放的新摆设：先按数据加进去（预览就是真的那条数据），取消时再撤回 */
interface PropPlacing { prop: W.PlacedProp; regionId: string; before: string; valid: boolean; down: { x: number; y: number } | null }

export class TownController {
  selectedId: string | null = null;
  hoveredId: string | null = null;
  selectedRegion: string | null = null;
  hoveredRegion: string | null = null;
  /** 选中的岛上摆设（和宫殿互斥） */
  selectedProp: string | null = null;
  editing = false;
  private hoveredProp: string | null = null;
  private hoverSince = 0;
  private tagHover: string | null = null;
  private drag: Drag | null = null;
  private placing: { doc: PalaceDoc; placed: W.PlacedPalace; regionId: string; valid: boolean; down: { x: number; y: number } | null } | null = null;
  private propPlacing: PropPlacing | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listOpen = false;
  private panel: 'build' | 'island' | 'props' | null = null;
  private palette: PaletteItem[] = [];
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
  }

  private get town() { return this.v.town; }
  private get region() { return this.v.region; }
  private get docs() { return this.v.docs; }
  private get world() { return this.v.world; }
  /** 拖动 / 放置进行中：镜头所在的岛不要自动切换 */
  get busy() { return !!this.drag || !!this.placing || !!this.propPlacing; }

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
        <div class="kp-seg kp-glass kp-town-only kp-town-view">
          <button class="kp-on" data-act="viewMap" data-ref="segMap" title="${t('地图')}">${rich(ICONS.map)}<span>${t('地图')}</span></button>
          <button data-act="viewList" data-ref="segList" title="${t('宫殿列表')}">${rich(ICONS.list)}<span>${t('列表')}</span></button>
        </div>
        <button class="kp-search kp-glass" data-act="palette" title="${t('搜索宫殿或岛（⌘K / Ctrl+K）')}">${rich(ICONS.search)}<span>${t('搜索宫殿或岛')}</span><kbd>⌘K</kbd></button>
      </div>
      <nav class="kp-bar kp-glass kp-town-only kp-town-view kp-near-only">
        <button class="kp-primary" data-act="buildPalace" title="${t('在这座岛上建造一座新宫殿')}">${rich(ICONS.plus)}<span>${t('建造宫殿')}</span></button>
        <button data-act="townEdit" title="${t('布置小镇：拖动宫殿和摆设换位置、旋转（B）')}">${rich(ICONS.move)}<span>${t('布置')}</span></button>
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
        <button class="kp-icon kp-near-only" data-act="townRotate" title="${t('旋转选中的宫殿或摆设 90°（R）')}">${rich(ICONS.rotr)}</button>
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
          <label class="kp-pal-input">${rich(ICONS.search)}<input data-ref="paletteInput" placeholder="${t('搜索宫殿或岛…')}" autocomplete="off" spellcheck="false"></label>
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
      </div>`);
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
      const docs = this.region.palaces.map(p => this.docs.get(p.palaceId)).filter(Boolean);
      v.ui.townTitle.textContent = this.region.name;
      v.ui.townSub.textContent = docs.length ? t('{n} 座宫殿', { n: docs.length }) : t('还没有宫殿 · 点「建造宫殿」开始');
      v.ui.townMark.textContent = getTheme(this.region.theme).icon;
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
    v.ui.townEditHint.replaceChildren(html`${v.far ? t('拖动岛换位置 · 岛和岛之间会留出海面') : rich(t('拖动宫殿或摆设换位置 · <b>R</b> 旋转 · <b>⌘D</b> 复制'))}`);
    this.renderCard();
    if (this.listOpen) this.renderList();
    this.updateUndoButtons();
    this.updateMarker();
  }

  /** 进出宫殿之前：收起小镇里的各种临时状态 */
  beforeLevelChange() {
    this.cancelPlacing();
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
   * 摆设 / 宫殿一起拾取：谁离镜头近就选谁；深度接近（20cm 以内）时宫殿优先，
   * 所以摆设不会抢走宫殿的点击，宫殿也不会被脚下更近的摆设挡住。地面落点排在两者之后。
   */
  private pickPropOrPalace(e: { clientX: number; clientY: number }): { prop: PropHit | null; palaceId: string | null } {
    const ray = this.ray(e);
    const prop = this.town.pickProp(ray);
    const shell = this.town.pick(ray);
    const dProp = prop ? ray.ray.origin.distanceTo(prop.point) : Infinity;
    const dShell = shell ? ray.ray.origin.distanceTo(shell.point) : Infinity;
    if (shell && dShell <= dProp + .2) return { prop: null, palaceId: shell.id };
    return { prop, palaceId: null };
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
      if (!e.buttons && !this.drag && !this.placing && !this.propPlacing) {
        if (v.far) {
          this.setRegionHover(this.pickRegion(e));
          this.setPropHover(null);
        } else if (this.editing) {
          // 布置中镜头飘到另一座岛：先把它的装饰烘焙成数据，那边的摆设才能拾取（样子不变）
          const layer = this.layerOf(this.region.id);
          const g = layer && this.town.groundOf(this.ray(e), layer);
          if (this.region.props === undefined && g && layer.onLand(g[0], g[1])) this.ensureProps(this.region);
          // 摆设优先于地面，深度上仍让给更近的宫殿
          const hit = this.pickPropOrPalace(e);
          this.setPropHover(hit.prop?.propId ?? null);
          this.setHover(hit.palaceId ?? this.tagHover);
        } else {
          this.setPropHover(null);
          this.setHover(this.pickPalace(e) ?? this.tagHover);
        }
        this.showTip(e);
      } else v.ui.tip.classList.remove('kp-on');
    }
    const busy = v.far || this.editing || !!this.placing || !!this.propPlacing || !!this.drag || !!v.camTween;
    const target = busy ? null : (this.hoveredId ?? this.selectedId);
    const ready = this.hoveredId ? performance.now() - this.hoverSince > PEEK_DELAY : true;
    if (target && ready && !(v.peek?.id === target && v.peek.open)) v.openPeek(target);
    else if (!target && v.peek?.open) v.closePeek();
    v.root.classList.toggle('kp-tags-near', v.frustum / v.isoCam.zoom < 46);
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

  select(id: string | null) {
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
    if (id !== this.selectedProp) this.propParamBefore = null;
    // 添加面板和卡片互斥：在岛上点中一个摆设就把面板收起来，卡片才有地方显示
    if (id && this.panel === 'props') this.closePanel();
    this.selectedProp = id;
    this.town.setPropSelection(id);
    if (id) this.select(null);
    else { this.renderCard(); this.updateMarker(); }
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

  onClick(e: PointerEvent) {
    if (this.placing || this.propPlacing) return;
    if (this.v.far) { this.selectRegion(this.pickRegion(e)); return; }
    if (!this.editing) { this.select(this.pickPalace(e)); return; }
    const hit = this.pickPropOrPalace(e);
    if (hit.prop) this.selectProp(hit.prop.propId);
    else this.select(this.pickPalace(e));
  }

  onDblClick(e: MouseEvent) {
    if (this.editing || this.placing || this.propPlacing) return;
    if (this.v.far) {
      const rid = this.pickRegion(e);
      if (rid) this.v.flyToRegion(rid);
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
    if (v.level !== 'town' || this.placing || this.propPlacing || this.panel === 'props') { card.classList.add('kp-hidden'); return; }
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

  private renderRegionCard(regionId: string) {
    const v = this.v, card = v.ui.townCard;
    const r = this.regionById(regionId);
    if (!r) { card.classList.add('kp-hidden'); return; }
    const theme = getTheme(r.theme);
    const docs = r.palaces.map(p => this.docs.get(p.palaceId)).filter(Boolean);
    const last = this.world.regions.length <= 1;
    card.replaceChildren(html`
      <button class="kp-close" data-act="regionDeselect">×</button>
      <div class="kp-room">${t('岛屿')} · ${theme.icon} ${t(theme.name)}</div>
      <input class="kp-name" data-field="regionName" maxlength="40" spellcheck="false">
      <div class="kp-stats">${t('{n} 座宫殿', { n: docs.length })}</div>
      <div class="kp-subtitle">${t('场景')}</div>
      <div class="kp-themes">${THEMES.map(th => html`
        <button class="kp-theme${th.id === r.theme ? ' kp-on' : ''}" data-act="regionTheme" data-theme="${th.id}" title="${t(th.desc)}">
          <i style="background:linear-gradient(135deg, ${th.colors[0]} 0 55%, ${th.colors[1]} 55% 78%, ${th.colors[2]} 78%)">${th.icon}</i><span>${t(th.name)}</span>
        </button>`)}</div>
      ${docs.length ? html`<div class="kp-subtitle">${t('岛上的宫殿')}</div><div class="kp-mini">${docs.slice(0, 5).map(d => html`
        <button data-act="regionPalace" data-id="${d.id}"><b>${d.name}</b></button>`)}
        ${docs.length > 5 ? html`<div class="kp-more-note">${t('还有 {n} 座…', { n: docs.length - 5 })}</div>` : ''}</div>` : html`<div class="kp-note-sm">${t('这座岛还是空的，前往后点「建造宫殿」。')}</div>`}
      <div class="kp-row">
        <button class="kp-danger" data-act="regionDelete" ${docs.length || last ? 'disabled' : ''} title="${last ? t('至少要保留一座岛') : docs.length ? t('先把岛上的宫殿搬走或删除') : t('删除这座空岛')}">${t('删除')}</button>
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
      this.setPropParam(param, spec.options ? spec.options[Number(el.value)]?.[0] : Number(el.value), !commit);
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
    } else if (field === 'palaceRegion' && commit && el.value && this.selectedId) {
      this.movePalaceTo(this.selectedId, el.value);
    }
  }

  // =====================================================================
  // 布置：拖动 / 旋转宫殿；群岛视角下拖动岛
  // =====================================================================

  setEditing(on: boolean) {
    if (on && this.v.readonly) return;
    if (!on) {
      // 离开「布置」：正在放的摆设撤掉，选中的 / 悬停的放下（不管当前是不是布置模式都收干净）
      this.cancelPropPlacing();
      this.selectProp(null);
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

  /** 这个位置放不放得下：草地上、不压广场、不压宫殿地块、不和别的摆设挤在一起 */
  private propFits(region: W.WorldRegion, layer: RegionLayer, prop: W.PlacedProp): boolean {
    const [x, z] = prop.pos;
    if (!layer.onLand(x, z, .4)) return false;
    const r = this.propRadius(prop);
    if (Math.hypot(x, z) < W.PLAZA_R + r + PROP_GAP) return false;
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
      const currentId = v.level === 'palace' ? v.doc?.id : null;
      for (const r of this.world.regions) {
        const icon = getTheme(r.theme).icon;
        for (const p of r.palaces) {
          const d = this.docs.get(p.palaceId);
          if (!d) continue;
          const st = W.palaceStats(d);
          const color = p.roofColor || W.palaceColor(d);
          if (match(d.name + ' ' + r.name)) out.push({ kind: 'palace', id: d.id, title: d.name, sub: `${d.id === currentId ? t('当前所在 · ') : ''}${icon} ${r.name} · ${t('{n} 个房间', { n: st.rooms })}`, color });
        }
      }
      if (tokens.length) {
        for (const r of this.world.regions) {
          const th = getTheme(r.theme), thName = t(th.name);
          if (match(r.name + ' ' + thName + ' ' + th.name)) out.push({ kind: 'region', id: r.id, title: `${th.icon} ${r.name}`, sub: `${thName} · ${t('{n} 座宫殿', { n: r.palaces.length })}`, color: th.colors[0] });
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
      </button>`) : html`<div class="kp-empty">${t('没有找到匹配的宫殿或岛')}</div>`}`);
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
  onPointerDown(e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    if (this.placing) { this.placing.down = { x: e.clientX, y: e.clientY }; return false; }
    if (this.propPlacing) { this.propPlacing.down = { x: e.clientX, y: e.clientY }; return false; }
    if (!this.editing) return false;
    const v = this.v;
    if (v.far) {
      const rid = this.pickRegion(e);
      const r = rid && this.regionById(rid), layer = rid && this.layerOf(rid);
      const g = layer && this.town.groundOf(this.ray(e), layer);
      if (!r || !g) return false;
      this.selectRegion(rid);
      const o = W.regionOrigin(r);
      // groundOf 返回区域局部坐标：原点偏移就是 -g
      this.drag = { kind: 'region', id: rid, offset: [-g[0], -g[1]], orig: [...o] as Vec2, before: this.snapshot(), valid: true, moved: false };
    } else {
      const hit = this.pickPropOrPalace(e);
      const region = hit.prop && this.regionById(hit.prop.regionId);
      const prop = hit.prop && region ? W.findProp(region, hit.prop.propId) : null;
      const layer = region && this.layerOf(region.id);
      const g = layer && this.town.groundOf(this.ray(e), layer);
      if (prop && region && layer && g) {
        // 摆设：指针下的那个更近，或者这一路上根本没有宫殿外壳
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
    }
    try { v.renderer.domElement.setPointerCapture(e.pointerId); } catch { /* 合成事件 */ }
    return true;
  }

  onPointerMove(e: PointerEvent): boolean {
    if (this.propPlacing && !e.buttons) { this.movePropPlacing(e); return true; }
    if (this.placing && !e.buttons) { this.movePlacing(e); return true; }
    const d = this.drag;
    if (!d) return false;
    if (d.kind === 'region') {
      const r = this.regionById(d.id), layer = this.layerOf(d.id);
      const g = layer && this.town.groundOf(this.ray(e), layer);
      if (!r || !g) return true;
      // g 是相对当前原点的局部坐标：换算成世界坐标再加偏移
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
    if (d.kind === 'prop') {
      // 和宫殿一样的算法：地面点 + 按下时的偏移；只动预览，数据等松手再写
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
    if (d.kind === 'prop') {
      const region = this.regionById(d.regionId);
      const prop = region && W.findProp(region, d.propId);
      if (prop && region && d.moved) {
        if (d.valid) {
          // 预览已经就位（movePropPreview），这里只把新位置落进数据
          this.pushUndo(d.before);
          this.v.worldChanged();
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
    const s = this.town.shells.get(d.id);
    if (s && d.moved) {
      if (d.valid) this.commitPalaces(d.before, d.regionId);
      else {
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
    if (this.editing && mod && k === 'd' && !this.v.far && this.selectedProp) { this.duplicateProp(); return true; }
    if (mod) return false;
    if (k === 'escape') {
      if (this.propPlacing) { this.cancelPropPlacing(); this.setEditing(true); }
      else if (this.placing) this.cancelPlacing();
      else if (this.panel) this.closePanel();
      else if (this.editing) this.setEditing(false);
      else if (this.listOpen) this.toggleList(false);
      else if (this.selectedId) this.select(null);
      else if (this.selectedRegion) this.selectRegion(null);
      else return false;
      return true;
    }
    if (k === 'r' && !this.v.far && (this.editing || this.placing || this.propPlacing)) { this.rotateSelected(); return true; }
    if (k === 'a' && this.editing && !this.v.far && !this.propPlacing) { this.openPropPanel(); return true; }
    if (k === 'b' && !this.placing && !this.propPlacing) { this.setEditing(!this.editing); return true; }
    if (k === 'enter' && !this.editing) {
      if (this.v.far && this.selectedRegion) { this.v.flyToRegion(this.selectedRegion); return true; }
      if (!this.v.far && this.selectedId) { this.v.enterPalace(this.selectedId); return true; }
    }
    if ((k === 'delete' || k === 'backspace') && this.editing && !this.v.far) {
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
        if (this.propPlacing) { this.cancelPropPlacing(); this.setEditing(true); } else this.cancelPlacing();
        return true;
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
  const shown = step >= 1 ? String(Math.round(n)) : `${n.toFixed(step < .05 ? 2 : 1)} m`;
  return html`<label class="kp-field"><span>${t(spec.label)}</span><input type="range" data-param="${spec.key}" min="${spec.min}" max="${spec.max}" step="${step}" value="${n}"><output>${shown}</output></label>`;
}
