import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { PalaceView } from './view';
import { Character, renderLookThumb } from './avatar';
import { SPECIES, ACCESSORIES, cleanLook, seededLook, type Look } from './look';
import { WalkGrid, type P2 } from './path';
import { ownBox } from './build';
import { frontDoor, PET_NAME } from './world';
import { GRASS_Y } from './themes/common';
import { escapeHtml } from './icons';
import { html, rich } from './dom';
import { t } from './i18n';

/* =====================================================================
 * 小管家：生活在岛屿世界里的小动物。
 *   在岛上自由漫步、看风景；
 *   点它可以互动、挥手、冒气泡，打开换装面板（物种、颜色、配饰、名字）；
 *   镜头聚焦移动或选中物体时，会好奇地跑过来观望。
 * 外观保存在世界数据里（world.pet）。
 * ===================================================================== */

const SPEED = 1.2;
/** 比真实小动物大一圈，俯视时看得清、点得中 */
const SCALE = 1.6;
const TIPS = [
  '点我可以换衣服、换配饰，还能换物种哦～',
  '在岛上按 B 可以布置小镇，随心摆放摆设和便签。',
  '夜里（按 N）整个世界会亮起灯火，星光漫天。',
];

/** 小管家的名字（显示用）：默认名字跟着界面语言走，自己起的名字原样显示 */
export function petDisplayName(name: string) { return name === PET_NAME ? t(PET_NAME) : name; }

export class Companion {
  ch: Character | null = null;
  private grid: WalkGrid | null = null;
  private gridKey: unknown = null;
  private path: P2[] = [];
  /** 走到之后面朝哪里：一个点，或者直接给朝向角 */
  private faceAfter: P2 | number | null = null;
  private idleFor = 0;
  private nextIdle = 4;
  private followCheck = 0;
  private bubble: CSS2DObject | null = null;
  private bubbleUntil = 0;
  private hit: THREE.Mesh | null = null;
  panelOpen = false;
  private thumbs = new Map<string, string>();
  private time = 0;
  private docId: string | null = null;
  private activeRegionId: string | null = null;

  constructor(private v: PalaceView) {
    v.root.append(html`<div class="kp-routes kp-pet-panel kp-glass kp-hidden" data-ref="petPanel"></div>`);
    v.ui.petPanel = v.root.querySelector('[data-ref="petPanel"]') as HTMLElement;
  }

  get pet() { return this.v.world.pet || { name: PET_NAME, look: seededLook(this.v.world.id) }; }
  get hidden() { return !!this.v.world.pet?.hidden; }
  /** 显示用的名字（默认名字会翻译） */
  get petName() { return petDisplayName(this.pet.name); }

  // =====================================================================
  // 生命周期
  // =====================================================================

  /** 确保在当前岛屿上出现并漫步 */
  ensureWorldCompanion() {
    const v = this.v;
    if (this.hidden || v.readonly) {
      if (this.ch) this.remove();
      return;
    }
    const currentRegionId = v.region?.id;
    if (this.ch && this.activeRegionId === currentRegionId) return;

    this.remove();
    this.activeRegionId = currentRegionId || null;
    const layer = currentRegionId ? v.town.regions.get(currentRegionId) : undefined;
    if (!layer) return;

    const ch = this.ch = new Character(this.pet.look, SCALE);
    ch.root.name = 'kp-pet';
    // 点击用的隐形球（比小动物本身好点中）
    const hit = this.hit = new THREE.Mesh(new THREE.SphereGeometry(.32 * SCALE, 8, 6), new THREE.MeshBasicMaterial());
    hit.position.y = .24 * SCALE;
    hit.visible = false;
    ch.root.add(hit);

    // 对话气泡
    const el = document.createElement('div');
    el.className = 'kp-pet-bubble kp-hidden';
    const bubble = this.bubble = new CSS2DObject(el);
    bubble.position.y = .64 * SCALE;
    ch.root.add(bubble);

    // 挂载到岛屿 layer.group 下，使用区域局部坐标
    layer.group.add(ch.root);

    // 初始位置：广场中央或岛屿中心附近
    const startX = layer.center[0] + (Math.random() - .5) * 3;
    const startZ = layer.center[1] + (Math.random() - .5) * 3;
    ch.root.position.set(startX, GRASS_Y, startZ);

    const cam = v.isoCam.position;
    ch.root.rotation.y = Math.atan2(cam.x - startX, cam.z - startZ);
    ch.play('hop');
    this.idleFor = 0;
    this.nextIdle = 3 + Math.random() * 4;
    v.invalidate(2);
  }

  /** 进了一座宫殿：在门口出现（兼容遗留宫殿） */
  onPalaceLoaded() {
    const v = this.v, b = v.built, doc = v.doc;
    if (this.ch && doc && this.docId === doc.id) { this.grid = null; this.path = []; return; }
    this.remove();
    this.docId = doc?.id || null;
    if (!b || !doc || this.hidden || v.readonly) return;
    const ch = this.ch = new Character(this.pet.look, SCALE);
    ch.root.name = 'kp-pet';
    const hit = this.hit = new THREE.Mesh(new THREE.SphereGeometry(.28 * SCALE, 8, 6), new THREE.MeshBasicMaterial());
    hit.position.y = .24 * SCALE;
    hit.visible = false;
    ch.root.add(hit);
    const el = document.createElement('div');
    el.className = 'kp-pet-bubble kp-hidden';
    const bubble = this.bubble = new CSS2DObject(el);
    bubble.position.y = .62 * SCALE;
    ch.root.add(bubble);
    v.scene.add(ch.root);
    this.grid = null;
    const door = frontDoor(doc);
    const g = this.walkGrid();
    let p: P2 = door ? [door.x - door.nx * .9, door.z - door.nz * .9] : [b.bounds.getCenter(new THREE.Vector3()).x, b.bounds.getCenter(new THREE.Vector3()).z];
    p = g?.nearestFree(p[0], p[1]) || p;
    ch.root.position.set(p[0], 0, p[1]);
    const cam = v.isoCam.position;
    ch.root.rotation.y = Math.atan2(cam.x - p[0], cam.z - p[1]);
    ch.play('hop');
    this.idleFor = 0;
    this.nextIdle = 5 + Math.random() * 4;
    if (!v.readonly) {
      this.say(html`${rich(t('你好！我是小管家 <b>{name}</b>，以后我陪你在岛上生活。点我可以给我换装哦～', { name: escapeHtml(this.petName) }))}`, 7000);
    }
    v.invalidate(2);
  }

  /** 离开 / 关掉 */
  remove() {
    if (!this.ch) return;
    this.bubble?.element.remove();
    this.hit?.geometry.dispose();
    (this.hit?.material as THREE.Material)?.dispose();
    this.ch.dispose();
    this.ch = null;
    this.bubble = null;
    this.hit = null;
    this.path = [];
    this.grid = null;
    this.docId = null;
    this.activeRegionId = null;
  }

  /** 离开宫殿：收起小管家和面板 */
  leavePalace() {
    this.remove();
    this.togglePanel(false);
  }

  dispose() {
    this.remove();
    this.v.ui.petPanel?.remove();
  }

  private walkGrid(): WalkGrid | null {
    if (this.v.level !== 'palace') return null;
    const b = this.v.built;
    if (!b) return null;
    const colliders = this.v.colliders();
    if (this.grid && this.gridKey === colliders) return this.grid;
    const bb = b.bounds;
    this.gridKey = colliders;
    this.grid = new WalkGrid({ x0: bb.min.x - .5, z0: bb.min.z - .5, x1: bb.max.x + .5, z1: bb.max.z + .5 }, colliders, .15, .12);
    return this.grid;
  }

  /** 家具搬动过：下次找路时重建网格 */
  invalidateGrid() { this.grid = null; }

  // =====================================================================
  // 行为
  // =====================================================================

  /** 走到 (x, z)；face 给了就到了之后面朝那里 */
  walkTo(x: number, z: number, face?: P2 | number) {
    const ch = this.ch;
    if (!ch) return;
    if (this.v.level === 'palace') {
      const g = this.walkGrid();
      const from: P2 = [ch.root.position.x, ch.root.position.z];
      const path = g?.path(from, [x, z]) || [from, [x, z]];
      this.path = path.slice(1);
    } else {
      // 岛屿地表漫游：直走或者沿 waypoint 前进
      const from: P2 = [ch.root.position.x, ch.root.position.z];
      const mx = (from[0] + x) / 2 + (Math.random() - .5) * 1.5;
      const mz = (from[1] + z) / 2 + (Math.random() - .5) * 1.5;
      const layer = this.v.region ? this.v.town.regions.get(this.v.region.id) : undefined;
      if (layer && layer.onLand(mx, mz, 1.5)) {
        this.path = [[mx, mz], [x, z]];
      } else {
        this.path = [[x, z]];
      }
    }
    this.faceAfter = face ?? null;
    if (this.path.length) ch.play('walk');
    this.idleFor = 0;
    this.v.invalidate(2);
  }

  /** 选中了一件东西：跑到它前面（靠镜头这一侧） */
  onSelect(obj: THREE.Object3D | null) {
    if (!this.ch || !obj || this.v.mode !== 'iso') return;
    if (this.v.level === 'palace') {
      const c = ownBox(obj).getCenter(new THREE.Vector3());
      const dir = new THREE.Vector3().subVectors(this.v.orbit.target, this.v.isoCam.position).setY(0).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const size = ownBox(obj).getSize(new THREE.Vector3());
      const r = Math.max(size.x, size.z) / 2 + .35;
      const tx = c.x - dir.x * r + side.x * .35, tz = c.z - dir.z * r + side.z * .35;
      const p = this.walkGrid()?.nearestFree(tx, tz, 1.5) || [tx, tz];
      const toCam = Math.atan2(-dir.x, -dir.z), toItem = Math.atan2(c.x - p[0], c.z - p[1]);
      this.walkTo(p[0], p[1], toCam + angleDiff(toCam, toItem) * .35);
    }
  }

  /** 在岛屿上选了摆设或便签：跑过去围观 */
  onSelectPropOrNote(localX: number, localZ: number) {
    if (!this.ch || this.v.far) return;
    const layer = this.v.region ? this.v.town.regions.get(this.v.region.id) : undefined;
    if (!layer) return;
    const angle = Math.random() * Math.PI * 2;
    const dist = 1.4 + Math.random() * 0.8;
    const tx = localX + Math.cos(angle) * dist;
    const tz = localZ + Math.sin(angle) * dist;
    if (layer.onLand(tx, tz, 1.0)) {
      this.walkTo(tx, tz, [localX, localZ]);
    }
  }

  /** 头顶冒一句话 */
  say(content: DocumentFragment, ms = 3000) {
    if (!this.bubble) return;
    const el = this.bubble.element;
    el.replaceChildren(content);
    el.classList.remove('kp-hidden');
    this.bubbleUntil = this.time + ms / 1000;
    this.v.invalidate(2);
  }

  /** 屏幕坐标点到了小管家吗 */
  pick(clientX: number, clientY: number): boolean {
    if (!this.ch || !this.hit || !this.ch.root.visible) return false;
    const rc = this.v.raycaster;
    rc.setFromCamera(this.v.ndc(clientX, clientY), this.v.isoCam);
    return rc.intersectObject(this.hit, false).length > 0;
  }

  /** 点击：点到自己的小管家时处理并返回 true */
  click(clientX: number, clientY: number): boolean {
    if (this.pick(clientX, clientY)) { this.onClick(); return true; }
    return false;
  }

  /** 被点了：挥手、说句话、打开换装面板 */
  onClick() {
    const ch = this.ch, v = this.v;
    if (!ch) return;
    ch.play('wave');
    const cam = v.isoCam.position;
    const p = new THREE.Vector3();
    ch.root.getWorldPosition(p);
    ch.root.rotation.y = Math.atan2(cam.x - p.x, cam.z - p.z);
    this.path = [];
    const tip = t(TIPS[Math.floor(Math.random() * TIPS.length)]);
    this.say(html`${rich(t('<b>{name}</b>：{tip}', { name: escapeHtml(this.petName), tip: escapeHtml(tip) }))}`, 5200);
    this.togglePanel(true);
  }

  /** 每帧；返回 true 表示需要继续渲染 */
  update(dt: number): boolean {
    this.time += dt;
    const v = this.v;

    // 如果在岛屿层级且尚未创建，或者切换了岛屿，确保创建
    if (v.level === 'town' && !v.far) {
      if (!this.ch || this.activeRegionId !== v.region?.id) {
        this.ensureWorldCompanion();
      }
    }

    const ch = this.ch;
    if (!ch) return false;

    const show = !this.hidden && (v.level === 'town' ? !v.far : (v.level === 'palace' && !v.editor.active));
    if (ch.root.visible !== show) { ch.root.visible = show; v.invalidate(1); }
    if (!show) return false;

    let busy = false;
    if (this.bubble && this.bubbleUntil && this.time > this.bubbleUntil) {
      this.bubbleUntil = 0;
      this.bubble.element.classList.add('kp-hidden');
      busy = true;
    }
    // 走路
    if (this.path.length) {
      const [tx, tz] = this.path[0];
      const p = ch.root.position;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      const step = SPEED * dt;
      if (d <= step) {
        p.x = tx; p.z = tz;
        this.path.shift();
      } else {
        p.x += dx / d * step; p.z += dz / d * step;
      }
      if (d > 1e-3) ch.root.rotation.y = turn(ch.root.rotation.y, Math.atan2(dx, dz), dt * 10);
      if (!this.path.length) {
        ch.play('idle');
        const f = this.faceAfter;
        if (typeof f === 'number') ch.root.rotation.y = f;
        else if (f) ch.root.rotation.y = Math.atan2(f[0] - p.x, f[1] - p.z);
        this.faceAfter = null;
      }
      busy = true;
    } else if (v.mode === 'walk') {
      busy = this.follow(dt) || busy;
    } else {
      // 闲着：隔一会儿东张西望，或者在岛上溜达
      this.idleFor += dt;
      if (this.idleFor > this.nextIdle) {
        this.idleFor = 0;
        this.nextIdle = 5 + Math.random() * 7;
        if (Math.random() < .4) ch.play('look');
        else if (Math.random() < .25) ch.play('hop');
        else this.wander();
      }
    }
    if (ch.update(dt)) busy = true;
    return busy;
  }

  /** 第一人称：跟在身后一米左右 */
  private follow(dt: number): boolean {
    const ch = this.ch, v = this.v;
    this.followCheck -= dt;
    if (this.followCheck > 0) return false;
    this.followCheck = .4;
    const me = v.walkPosition();
    if (!me) return false;
    const p = ch.root.position;
    const d = Math.hypot(me.x - p.x, me.z - p.z);
    if (d < 1.6) {
      const yaw = Math.atan2(me.x - p.x, me.z - p.z);
      if (Math.abs(angleDiff(ch.root.rotation.y, yaw)) > .3) { ch.root.rotation.y = yaw; return true; }
      return false;
    }
    const k = 1 - 1 / d;
    const g = this.walkGrid();
    const t = g?.nearestFree(p.x + (me.x - p.x) * k, p.z + (me.z - p.z) * k, 1) || [me.x, me.z];
    this.walkTo(t[0], t[1], [me.x, me.z]);
    return true;
  }

  /** 溜达：在岛上或房间里挑一个附近的点走过去 */
  private wander() {
    const ch = this.ch, v = this.v;
    if (!ch) return;

    if (v.level === 'town') {
      const layer = v.region ? v.town.regions.get(v.region.id) : undefined;
      if (!layer) return;

      const p = ch.root.position;
      // 倾向于在当前位置周围 2~6 米内找合法陆地点
      for (let attempt = 0; attempt < 8; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = 2.5 + Math.random() * 4.5;
        const tx = p.x + Math.cos(ang) * dist;
        const tz = p.z + Math.sin(ang) * dist;

        if (layer.onLand(tx, tz, 2.0)) {
          this.walkTo(tx, tz);
          return;
        }
      }
      // 如果尝试失败，走向岛中心附近
      const cx = layer.center[0] + (Math.random() - .5) * 4;
      const cz = layer.center[1] + (Math.random() - .5) * 4;
      if (layer.onLand(cx, cz, 1.5)) {
        this.walkTo(cx, cz);
      }
      return;
    }

    const b = this.v.built;
    if (!b) return;
    const items = [...b.itemObjects.values()];
    if (!items.length) return;
    const obj = items[Math.floor(Math.random() * items.length)];
    const c = ownBox(obj).getCenter(new THREE.Vector3());
    const a = Math.random() * Math.PI * 2;
    const p = this.walkGrid()?.nearestFree(c.x + Math.sin(a) * .7, c.z + Math.cos(a) * .7, 1.2);
    if (!p) return;
    const here = ch.root.position;
    if (Math.hypot(p[0] - here.x, p[1] - here.z) > 7) return;
    this.walkTo(p[0], p[1], [c.x, c.z]);
  }

  // =====================================================================
  // 换装面板
  // =====================================================================

  togglePanel(open = !this.panelOpen) {
    this.panelOpen = open;
    this.v.ui.petPanel.classList.toggle('kp-hidden', !open);
    if (open) this.render();
  }

  private thumb(look: Look) {
    const key = JSON.stringify(look);
    let url = this.thumbs.get(key);
    if (!url) {
      try { url = renderLookThumb(this.v.renderer, look, 96); } catch { url = ''; }
      this.thumbs.set(key, url);
      this.v.invalidate(1);
    }
    return url;
  }

  render() {
    if (!this.panelOpen) return;
    const el = this.v.ui.petPanel, pet = this.pet, look = cleanLook(pet.look);
    const head = html`<div class="kp-routes-head"><b>${t('小管家')}</b><button class="kp-close" data-act="petClose">×</button></div>`;
    const colors = look.colors;
    const sp = SPECIES.find(s => s.id === look.species);
    const swatch = (field: 'body' | 'accent', list: string[]) => [...new Set(list.map(c => c.toLowerCase()))].map(c => html`<button class="kp-pet-sw${colors[field] === c ? ' kp-on' : ''}" style="background:${c}" data-act="petColor" data-field="${field}" data-color="${c}" title="${c}"></button>`);
    el.replaceChildren(html`${head}
      <div class="kp-pet-hero"><img src="${this.thumb(look)}" alt="">
        <div><input class="kp-route-name" data-field="petName" maxlength="20" spellcheck="false" value="${this.petName}"><small>${t(sp.name)}${look.accessories?.length ? ' · ' + look.accessories.map(a => t(ACCESSORIES.find(x => x.id === a)?.name)).join(t('、')) : ''}</small></div></div>
      <div class="kp-route-sub">${t('物种')}</div>
      <div class="kp-pet-species">${SPECIES.map(s => {
        const l = cleanLook({ species: s.id, accessories: look.accessories });
        return html`<button class="${s.id === look.species ? 'kp-on' : ''}" data-act="petSpecies" data-id="${s.id}"><img src="${this.thumb(l)}" alt=""><span>${t(s.name)}</span></button>`;
      })}</div>
      <div class="kp-route-sub">${t('毛色')}</div>
      <div class="kp-pet-swatches">${swatch('body', [sp.colors.body, '#8b6a4f', '#d9682e', '#e3a15c', '#efe9e2', '#5a5550', '#9fb4c7', '#c79bc4'])}</div>
      <div class="kp-route-sub">${t('点缀色')}</div>
      <div class="kp-pet-swatches">${swatch('accent', [sp.colors.accent, '#f0a33c', '#f2a7a0', '#3a2a22', '#4f86c6', '#4f9a78', '#c4453a', '#e8b93c'])}</div>
      <div class="kp-route-sub">${t('配饰（最多 4 件）')}</div>
      <div class="kp-pet-acc">${ACCESSORIES.map(a => html`<button class="${look.accessories?.includes(a.id) ? 'kp-on' : ''}" data-act="petAcc" data-id="${a.id}">${t(a.name)}</button>`)}</div>
      <div class="kp-route-tools"><button data-act="petRandom">${t('随机一身')}</button><button data-act="petHide">${t('先让它休息')}</button></div>`);
  }

  private save(pet: { name: string; look: Look; hidden?: boolean }) {
    const v = this.v;
    if (v.readonly) return;
    v.world.pet = { name: pet.name, look: cleanLook(pet.look), ...(pet.hidden ? { hidden: true } : {}) };
    v.world.updatedAt = Date.now();
    v.host.onWorldChange?.(v.world);
  }

  private setLook(look: Look) {
    const pet = this.pet;
    this.save({ name: pet.name, look });
    this.ch?.setLook(this.pet.look);
    this.ch?.play('hop');
    this.render();
    this.v.invalidate(2);
  }

  onAction(act: string, el: HTMLElement): boolean {
    if (!act.startsWith('pet')) return false;
    const pet = this.pet, look = cleanLook(pet.look);
    switch (act) {
      case 'petClose': this.togglePanel(false); return true;
      case 'petSpecies': {
        const sp = SPECIES.find(s => s.id === el.dataset.id);
        if (sp) this.setLook({ species: sp.id, colors: { ...sp.colors }, accessories: look.accessories });
        return true;
      }
      case 'petColor': {
        const f = el.dataset.field as 'body' | 'accent';
        this.setLook({ ...look, colors: { ...look.colors, [f]: el.dataset.color } });
        return true;
      }
      case 'petAcc': {
        const id = el.dataset.id, cur = look.accessories || [];
        const next = cur.includes(id) ? cur.filter(a => a !== id) : [...cur, id].slice(-4);
        this.setLook({ ...look, accessories: next });
        return true;
      }
      case 'petRandom': {
        const sp = SPECIES[Math.floor(Math.random() * SPECIES.length)];
        const acc = ACCESSORIES.filter(() => Math.random() < .3).map(a => a.id).slice(0, 2);
        this.setLook({ species: sp.id, colors: { ...sp.colors }, accessories: acc });
        return true;
      }
      case 'petHide':
        this.save({ ...pet, hidden: true });
        this.togglePanel(false);
        this.remove();
        this.v.host.notify?.(t('{name} 去休息了。想它的时候在右上角「设置」里叫它回来', { name: petDisplayName(pet.name) }));
        this.v.invalidate(2);
        return true;
      case 'petCall':
        this.save({ ...pet, hidden: false });
        if (this.v.level === 'palace') this.onPalaceLoaded();
        return true;
    }
    return false;
  }

  onInput(e: Event, commit: boolean): boolean {
    const inp = e.target as HTMLInputElement;
    if (inp?.dataset?.field !== 'petName') return false;
    if (commit) {
      const name = inp.value.trim().slice(0, 20) || PET_NAME;
      // 输入框里显示的是翻译后的默认名字：没改就不算改名
      if (name !== this.pet.name && name !== this.petName) { this.save({ ...this.pet, name }); this.say(html`${rich(t('我现在叫 <b>{name}</b> 啦！', { name: escapeHtml(petDisplayName(name)) }))}`, 2500); }
    }
    return true;
  }
}

function angleDiff(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turn(a: number, b: number, k: number) {
  return a + angleDiff(a, b) * Math.min(1, k);
}
