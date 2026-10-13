import * as THREE from 'three';
import { GRASS_Y } from './themes/common';
import type { Kit } from './kit';
import type { PlacedNote } from './world';

/* =====================================================================
 * 便签（sticky note）：平铺在地面上的 w×h 米卡片。
 *
 *   纸和字都画进一张 canvas 贴图，再由 NoteLayer 做成一整块贴地的平面挂到岛图层上。
 *   内容是一小段富文本；这里自带一个很小的解析器（parseNote）：
 *     清洗（sanitizeNoteHtml）与绘制（drawNote）共用同一棵树，保证存盘的、看到的是同一份。
 *
 *   这一层不 import world（运行时），PlacedNote 只做类型引用（会被擦掉），
 *   所以 world.ts 可以反过来 import 这里的颜色与清洗函数，不会形成运行时循环。
 * ===================================================================== */

/** 便签的纸色（浅色：和固定深色墨水搭配，保证可读）；world.ts 再导出一次，存盘用序号 */
export const NOTE_COLORS = ['#f7f4ec', '#f5e6a3', '#cfe3c2', '#c9dcf0', '#f0cfd8', '#f3d3b0'];
/** 便签固定的深色墨水 */
export const NOTE_INK = '#2b2b2b';
/** 便签贴在地面上抬起的量（米），避免和地面 z-fighting */
export const NOTE_LIFT = .02;
/** 贴图分辨率：每米多少像素（决定地面预览的清晰度） */
export const NOTE_PPM = 384;

const DEG = Math.PI / 180;
const LINK = '#1a5fb4';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

// =====================================================================
// 富文本子集：解析 / 序列化
// =====================================================================

export interface NoteRun { text: string; b?: boolean; i?: boolean; u?: boolean; href?: string }
export interface NoteBlock { type: 'p' | 'h1' | 'h2' | 'h3' | 'li'; order?: number; runs: NoteRun[] }

/** 允许的标签：其余一律丢掉（只留下里面的文字） */
const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'a']);
/** 链接只允许这些前缀，防止 javascript: 之类的地址 */
const SAFE_HREF = /^(https?:|mailto:|\/|#)/i;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 标签里找 href="…"（单引号 / 无引号也认） */
function attrHref(rest: string): string {
  const m = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rest);
  const raw = (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim().replace(/[\u0000-\u001f]/g, '');
  return SAFE_HREF.test(raw) ? raw : '';
}

/**
 * 把一段（可能不干净的）HTML 解析成块 / run 树。
 * 不认识的表情 / 标签都丢掉，只处理白名单里的那几个。
 */
export function parseNote(html: unknown): NoteBlock[] {
  const src = String(html ?? '');
  const blocks: NoteBlock[] = [];
  let cur: NoteBlock | null = null;
  let bold = 0, ital = 0, und = 0, link = '';
  let list: { ordered: boolean; n: number } | null = null;

  const block = (): NoteBlock => (cur ??= push({ type: 'p', runs: [] }));
  const push = (b: NoteBlock) => { blocks.push(b); cur = b; return b; };
  const addText = (raw: string) => {
    const text = raw
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    if (!text) return;
    const runs = block().runs;
    const run: NoteRun = { text };
    if (bold > 0) run.b = true;
    if (ital > 0) run.i = true;
    if (und > 0) run.u = true;
    if (link) run.href = link;
    runs.push(run);
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(src.slice(i)); break; }
    if (lt > i) addText(src.slice(i, lt));
    const gt = src.indexOf('>', lt);
    if (gt < 0) { addText(src.slice(lt)); break; }
    const raw = src.slice(lt + 1, gt).trim();
    i = gt + 1;
    const m = /^(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    // script / style 连内容一起丢掉
    if (tag === 'script' || tag === 'style') {
      const close = src.toLowerCase().indexOf('</' + tag, i);
      const end = close < 0 ? -1 : src.indexOf('>', close);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (!ALLOWED.has(tag)) continue;
    switch (tag) {
      case 'br': block().runs.push({ text: '\n' }); break;
      case 'p': if (!closing) push({ type: 'p', runs: [] }); break;
      case 'h1': case 'h2': case 'h3': if (!closing) push({ type: tag, runs: [] }); break;
      case 'strong': case 'b': bold = Math.max(0, bold + (closing ? -1 : 1)); break;
      case 'em': case 'i': ital = Math.max(0, ital + (closing ? -1 : 1)); break;
      case 'u': und = Math.max(0, und + (closing ? -1 : 1)); break;
      case 'a': link = closing ? '' : attrHref(m[3]); break;
      case 'ul': case 'ol': list = closing ? null : { ordered: tag === 'ol', n: 0 }; break;
      case 'li': if (!closing) push({ type: 'li', order: list?.ordered ? ++list.n : undefined, runs: [] }); break;
    }
  }
  return blocks.filter(b => b.runs.length);
}

/** 块 / run 树 → 白名单里的 HTML（存盘用）：连续的 li 收进一个 ul / ol */
export function serializeNote(blocks: NoteBlock[]): string {
  const runs = (list: NoteRun[]) => list.map(r => {
    if (r.text === '\n') return '<br>';
    let s = esc(r.text);
    if (r.u) s = `<u>${s}</u>`;
    if (r.i) s = `<em>${s}</em>`;
    if (r.b) s = `<strong>${s}</strong>`;
    if (r.href) s = `<a href="${esc(r.href).replaceAll('"', '&quot;')}">${s}</a>`;
    return s;
  }).join('');
  let out = '', list: 'ul' | 'ol' | null = null;
  for (const b of blocks) {
    if (b.type === 'li') {
      const tag = b.order ? 'ol' : 'ul';
      if (list !== tag) { if (list) out += `</${list}>`; out += `<${tag}>`; list = tag; }
      out += `<li>${runs(b.runs)}</li>`;
      continue;
    }
    if (list) { out += `</${list}>`; list = null; }
    out += `<${b.type}>${runs(b.runs)}</${b.type}>`;
  }
  return list ? out + `</${list}>` : out;
}

/** 清洗一段便签内容：只留下白名单标签 / 属性 */
export function sanitizeNoteHtml(html: unknown): string {
  return serializeNote(parseNote(html));
}

/**
 * 把便签内容还原成可编辑的 DOM（原地编辑用）。
 * 逐块建节点，不经过 innerHTML；读回来时再用 sanitizeNoteHtml 收一遍。
 */
export function noteToDom(html: unknown): DocumentFragment {
  const frag = document.createDocumentFragment();
  const runs = (parent: Node, list: NoteRun[]) => {
    for (const run of list) {
      if (run.text === '\n') { parent.appendChild(document.createElement('br')); continue; }
      let node: Node = document.createTextNode(run.text);
      if (run.href) { const a = document.createElement('a'); a.setAttribute('href', run.href); a.appendChild(node); node = a; }
      if (run.u) { const u = document.createElement('u'); u.appendChild(node); node = u; }
      if (run.i) { const em = document.createElement('em'); em.appendChild(node); node = em; }
      if (run.b) { const s = document.createElement('strong'); s.appendChild(node); node = s; }
      parent.appendChild(node);
    }
  };
  let list: HTMLElement | null = null;
  for (const b of parseNote(html)) {
    if (b.type === 'li') {
      const tag = b.order ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = document.createElement(tag); frag.appendChild(list); }
      const li = document.createElement('li');
      runs(li, b.runs);
      list.appendChild(li);
      continue;
    }
    list = null;
    const el = document.createElement(b.type);
    runs(el, b.runs);
    frag.appendChild(el);
  }
  return frag;
}

// =====================================================================
// 画到 canvas
// =====================================================================

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** 折行用的 token：中日韩按字断，西文按词断，空白单独成 token */
const TOKEN = /[\u2e80-\u9fff\uff00-\uffef]|[^\s\u2e80-\u9fff\uff00-\uffef]+|\s+/g;
const fontOf = (size: number, run: NoteRun, heading: boolean) =>
  `${run.i ? 'italic ' : ''}${run.b || heading ? '700' : '400'} ${size}px ${FONT}`;

/**
 * 把一张便签画进 canvas：纸面 + 墨迹。
 * 文字在宽度内折行、超出卡片高度就裁掉（内容不会漏到卡片外面）。
 * text: false 只画纸面——原地编辑时文字由 DOM 画在便签上（那样才清晰），贴图上就不重复画。
 */
export function drawNote(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, note: PlacedNote, opts: { text?: boolean } = {}) {
  const W = canvas.width, H = canvas.height;
  const r = Math.min(W, H) * .06;
  g.clearRect(0, 0, W, H);
  // 纸面：圆角、内缩一点。圆角外的透明像素靠材质的 alphaTest 裁掉（不然会画成黑角）。
  const line = Math.max(1, Math.round(NOTE_PPM * .012));
  roundRect(g, line / 2, line / 2, W - line, H - line, r);
  g.fillStyle = notePaper(note);
  g.fill();
  g.strokeStyle = 'rgba(60, 45, 25, .16)';
  g.lineWidth = line;
  g.stroke();
  if (opts.text === false) return;

  const pad = Math.max(4, Math.round(NOTE_PPM * .14));
  const maxW = W - pad * 2;
  const base = Math.max(6, note.fs * NOTE_PPM);
  g.save();
  roundRect(g, 0, 0, W, H, r);
  g.clip();
  g.textBaseline = 'top';
  g.textAlign = 'left';
  let y = pad;
  for (const b of parseNote(note.html)) {
    const heading = b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
    const size = b.type === 'h1' ? base * 1.6 : b.type === 'h2' ? base * 1.32 : b.type === 'h3' ? base * 1.14 : base;
    const lineH = size * 1.34;
    if (b.type === 'li') y += lineH * .12;
    // 先折行，再逐行画（每行是若干带样式的片段）
    const lines: { text: string; run: NoteRun }[][] = [[]];
    let x = 0;
    const prefix = b.type === 'li' ? (b.order ? `${b.order}. ` : '• ') : '';
    const startRun: NoteRun = { text: '' };
    if (prefix) { lines[0].push({ text: prefix, run: startRun }); g.font = fontOf(size, startRun, heading); x = g.measureText(prefix).width; }
    for (const run of b.runs) {
      for (const tok of run.text.match(TOKEN) || []) {
        if (tok === '\n') { lines.push([]); x = 0; continue; }
        g.font = fontOf(size, run, heading);
        const w = g.measureText(tok).width;
        if (x > 0 && x + w > maxW) { lines.push([]); x = 0; if (/^\s+$/.test(tok)) continue; }
        const line = lines[lines.length - 1];
        const last = line[line.length - 1];
        if (last && last.run === run) last.text += tok;
        else line.push({ text: tok, run });
        x += w;
      }
    }
    for (const line of lines) {
      if (!line.length) { y += lineH; continue; }
      if (y > H) break;
      // 画到整像素：亚像素落点会让字发虚
      const ly = Math.round(y);
      let cx = pad;
      for (const seg of line) {
        g.font = fontOf(size, seg.run, heading);
        g.fillStyle = seg.run.href ? LINK : NOTE_INK;
        g.fillText(seg.text, Math.round(cx), ly);
        const w = g.measureText(seg.text).width;
        if (seg.run.u || seg.run.href) g.fillRect(Math.round(cx), ly + Math.round(size * 1.06), w, Math.max(1, size * .06));
        cx += w;
      }
      y += lineH;
    }
    y += lineH * .12;
  }
  g.restore();
}

// =====================================================================
// 便签的几何：局部坐标 ↔ 区域局部坐标（和渲染时的摆放一致）
// =====================================================================

/** 便签的纸色 */
export function notePaper(note: PlacedNote): string {
  const i = ((note.color | 0) % NOTE_COLORS.length + NOTE_COLORS.length) % NOTE_COLORS.length;
  return NOTE_COLORS[i];
}

/**
 * 便签局部坐标 → 区域局部坐标。X 沿宽度、Z 沿深度，原点在便签中心（note.pos 就是中心）。
 * 和渲染时 holder.rotation.y = rot 的约定一致：x = cx + X·cos + Z·sin，z = cz − X·sin + Z·cos。
 */
export function noteToWorld(note: PlacedNote, X: number, Z: number): [number, number] {
  const a = (note.rot || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
  return [note.pos[0] + X * c + Z * s, note.pos[1] - X * s + Z * c];
}

/** 区域局部坐标 → 便签局部坐标（noteToWorld 的逆） */
export function noteLocal(note: PlacedNote, x: number, z: number): [number, number] {
  const a = (note.rot || 0) * DEG, c = Math.cos(a), s = Math.sin(a);
  const dx = x - note.pos[0], dz = z - note.pos[1];
  return [dx * c - dz * s, dx * s + dz * c];
}

/** 四个角的局部坐标，顺序固定：[−X−Z, +X−Z, −X+Z, +X+Z]（用它的顺序去算贴地 DOM 的仿射矩阵） */
export function noteCorners(note: PlacedNote): [number, number][] {
  const hw = note.w / 2, hh = note.h / 2;
  return [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]];
}

// =====================================================================
// 图层：一堆便签平面
// =====================================================================

export interface NoteHit { noteId: string; point: THREE.Vector3 }

interface NoteEntry { holder: THREE.Group; box: THREE.Box3; w: number; h: number; note: PlacedNote }

/**
 * 一座岛上的便签。每张便签是自己的网格（贴图各不相同，没法合批），
 * 挂在岛的 group 下（跟着岛移动）；拾取和选中标记都用一块扁扁的 AABB，和摆设一致。
 */
export class NoteLayer {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, NoteEntry>();
  private readonly owned: (THREE.Texture | THREE.Material | THREE.BufferGeometry)[] = [];

  constructor(private readonly K: Kit) {
    this.group.name = 'notes';
  }

  /** 按数据整批重建（内容 / 颜色 / 尺寸 / 位置变了都走这里） */
  rebuild(notes: PlacedNote[]) {
    const keep = new Set(notes.map(n => n.id));
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.remove(id);
    for (const n of notes) this.upsert(n);
  }

  /**
   * 只重画一张便签的贴图：on = true 时只画纸面（原地编辑中，文字由 DOM 画在便签上）。
   * 内容 / 纸色一变就走 rebuild；这里只服务于「编辑中」这一个状态。
   */
  paper(id: string, on: boolean) {
    const e = this.entries.get(id);
    if (!e) return;
    const mesh = e.holder.children[0] as THREE.Mesh | undefined;
    if (!mesh) return;
    const { canvas, g } = this.canvasFor(e.note);
    drawNote(g, canvas, e.note, { text: !on });
    const tex = (mesh.material as THREE.MeshStandardMaterial).map as THREE.CanvasTexture;
    tex.image = canvas;
    tex.needsUpdate = true;
  }

  private canvasFor(note: PlacedNote) {
    const w = Math.max(.2, note.w), h = Math.max(.2, note.h);
    const cw = Math.max(8, Math.round(w * NOTE_PPM)), ch = Math.max(8, Math.round(h * NOTE_PPM));
    const [canvas, g] = this.K.makeCanvas(cw, ch);
    return { canvas, g };
  }

  private upsert(note: PlacedNote) {
    this.remove(note.id);
    const w = Math.max(.2, note.w), h = Math.max(.2, note.h);
    const { canvas, g } = this.canvasFor(note);
    drawNote(g, canvas, note);
    const tex = this.K.toTex(canvas) as THREE.CanvasTexture;
    // 圆角外的像素是透明的：靠 alphaTest 裁掉，不能让它画出黑角
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: .95, metalness: 0, side: THREE.DoubleSide, transparent: true, alphaTest: .5 });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.userData.noteId = note.id;
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.position.set(note.pos[0], GRASS_Y + NOTE_LIFT, note.pos[1]);
    if (note.rot) holder.rotation.y = note.rot * DEG;
    this.group.add(holder);
    this.owned.push(tex, mat, geo);
    this.entries.set(note.id, { holder, w, h, note, box: this.boxAt(note.pos, note.rot || 0, w, h) });
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.holder.removeFromParent();
    this.entries.delete(id);
  }

  /** 数据坐标下的扁包围盒（不贴到世界坐标）：拾取和拖动都照它走 */
  private boxAt(pos: [number, number], rot: number, w: number, h: number): THREE.Box3 {
    const hw = w / 2, hh = h / 2;
    const local = new THREE.Box3(new THREE.Vector3(-hw, -.02, -hh), new THREE.Vector3(hw, .06, hh));
    return local.applyMatrix4(new THREE.Matrix4().makeRotationY(rot * DEG).setPosition(pos[0], GRASS_Y + NOTE_LIFT, pos[1]));
  }

  /** 拖动预览：只挪这块平面和它的包围盒 */
  move(id: string, pos: [number, number], rot: number) {
    const e = this.entries.get(id);
    if (!e) return;
    e.holder.position.set(pos[0], GRASS_Y + NOTE_LIFT, pos[1]);
    e.holder.rotation.y = rot * DEG;
    e.box.copy(this.boxAt(pos, rot, e.w, e.h));
  }

  /** 区域局部坐标的一条射线打中的最近便签 */
  pick(ray: THREE.Ray): NoteHit | null {
    let out: NoteHit | null = null;
    let best = Infinity;
    const p = new THREE.Vector3();
    for (const [noteId, e] of this.entries) {
      if (!ray.intersectBox(e.box, p)) continue;
      const d = ray.origin.distanceToSquared(p);
      if (d >= best) continue;
      best = d;
      out = { noteId, point: p.clone() };
    }
    return out;
  }

  /** 世界坐标下的包围盒（选中标记用） */
  worldBox(id: string, groupMatrix: THREE.Matrix4): THREE.Box3 | null {
    const e = this.entries.get(id);
    return e ? e.box.clone().applyMatrix4(groupMatrix) : null;
  }

  clear() {
    for (const e of this.entries.values()) e.holder.removeFromParent();
    this.entries.clear();
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}
