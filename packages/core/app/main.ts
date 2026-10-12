import { PalaceView, setLocale, createHomePalace, createFromTemplate, normalizePalace, normalizeWorld, createWorld, createRegion, findFreeSpot, findRegionSpot, type HostAdapter, type PalaceDoc, type PalaceWorld } from '../src';
import { samplePalaces, L } from './samples';
import { createAiClient, loadAiSettings, openAiSettingsDialog } from './settings';
import './app.css';

// 独立网页版：用 localStorage 当宿主（世界 + 每座宫殿一份数据），不依赖任何笔记软件
// ?lang=en 用英文界面（不给时按浏览器语言）；?demo=… 打开后直接进入某个界面状态，方便无头浏览器截图
const params = new URLSearchParams(location.search);
const store = window.localStorage;
// 演示数据按语言生成，所以在建数据之前就定下语言
const LANG = params.get('lang') || undefined;
setLocale(LANG ?? navigator.language);
const P = 'island-palace:app:';
const K = {
  world: P + 'world',
  ids: P + 'ids',
  doc: (id: string) => `${P}doc:${id}`,
  media: (id: string) => `${P}media:${id}`,
};

function saveDoc(doc: PalaceDoc) {
  store.setItem(K.doc(doc.id), JSON.stringify(doc));
  const ids: string[] = JSON.parse(store.getItem(K.ids) || '[]');
  if (!ids.includes(doc.id)) store.setItem(K.ids, JSON.stringify([...ids, doc.id]));
}

function load(): { world?: PalaceWorld; docs: PalaceDoc[]; fresh?: boolean } {
  try {
    const ids: string[] = JSON.parse(store.getItem(K.ids) || '[]');
    if (ids.length) {
      const docs = ids.map(id => store.getItem(K.doc(id))).filter(Boolean).map(s => normalizePalace(JSON.parse(s)));
      const raw = store.getItem(K.world);
      return { world: raw ? normalizeWorld(JSON.parse(raw)) : undefined, docs };
    }
  } catch (e) { console.warn(e); }
  // 第一次打开：我的家 + 几座演示宫殿
  const home = createHomePalace();
  home.color ??= '#c46d4d';
  const [roots, rust, apt, history] = samplePalaces();
  const sky = Object.assign(createFromTemplate('twoRooms', L('云端书屋', 'Cloud Library')), { color: '#4f7f8a' });
  const docs = [home, roots, rust, apt, history, sky];
  docs.forEach(saveDoc);
  // 四座岛：海岛 / 森林 / 雪山 / 浮空岛（固定种子，截图可复现）
  const map = new Map(docs.map(d => [d.id, d]));
  const world = createWorld();
  world.regions = [];
  const groups: [string, string, number, PalaceDoc[]][] = [
    [L('岛上小镇', 'Island Town'), 'island', 101, [home, apt]],
    [L('林间小岛', 'Forest Isle'), 'forest', 202, [rust, roots]],
    [L('雪山小岛', 'Snowy Isle'), 'snow', 303, [history]],
    [L('浮空岛', 'Sky Isle'), 'sky', 404, [sky]],
  ];
  for (const [name, theme, seedN, list] of groups) {
    const r = createRegion(name, theme);
    r.seed = seedN;
    for (const d of list) r.palaces.push({ palaceId: d.id, pos: findFreeSpot(r, map, d), rot: 0 });
    r.origin = findRegionSpot(world, map, r);
    world.regions.push(r);
  }
  return { world, docs, fresh: true };
}

const host: HostAdapter = {
  prefs: { get: (k) => store.getItem(k), set: (k, v) => store.setItem(k, v) },
  onDocChange: saveDoc,
  onWorldChange(world) { store.setItem(K.world, JSON.stringify(world)); },
  onDocDelete(id) {
    store.removeItem(K.doc(id));
    const ids: string[] = JSON.parse(store.getItem(K.ids) || '[]');
    store.setItem(K.ids, JSON.stringify(ids.filter(x => x !== id)));
  },
  onLocationChange(id, name) { document.title = `${name} · ${L('海岛宫殿', 'Island Palace')}`; void id; },
  notify(msg) { console.info('[island-palace]', msg); },
  async saveMedia(blob, id) {
    const url = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(blob); });
    store.setItem(K.media(id), url);
  },
  async loadMedia(id) {
    const url = store.getItem(K.media(id));
    if (!url) throw new Error(L('照片不存在', 'Photo not found'));
    return url;
  },
  ai: createAiClient(loadAiSettings),
  openSettings: openAiSettingsDialog,
};

const { world, docs, fresh } = load();
const view = new PalaceView(document.getElementById('app'), { world, docs, host, enter: params.get('enter'), locale: LANG });
if (!world || fresh) host.onWorldChange(view.world);

// 页面右上角的设置按钮：填大模型接口（拍照识物要用）
const gear = document.createElement('button');
gear.type = 'button';
gear.className = 'ip-gear';
gear.textContent = L('AI 设置', 'AI settings');
gear.addEventListener('click', () => openAiSettingsDialog());
document.body.appendChild(gear);

// 调试用：控制台里可以拿到的句柄
window.palaceView = view;
window.resetPalace = () => {
  Object.keys(store).filter(k => k.startsWith(P)).forEach(k => store.removeItem(k));
  location.reload();
};

// 调试用：推进若干帧、渲染并把画面发给 vite 写到 .snapshots/（浏览器窗口隐藏时也能看效果）
window.step = (frames = 30, dt = 1 / 30) => { for (let i = 0; i < frames; i++) view.tick(dt); view.render(); };
window.snapshot = async (name = 'snap', frames = 0) => {
  for (let i = 0; i < frames; i++) view.tick(1 / 30);
  view.render();
  const blob = await new Promise<Blob>(r => view.renderer.domElement.toBlob(r, 'image/jpeg', .88));
  return (await fetch(`/__snapshot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })).text();
};

/**
 * 小镇控制器的这几个入口是 private，只有调试用的 ?demo= 才需要直接调它们，
 * 所以在这里按需要的形状收窄一次，而不是把整个 townCtl 当成 any。
 */
interface DemoTown {
  select(id: string | null): void;
  selectRegion(id: string | null): void;
  toggleList(on?: boolean): void;
  openBuild(): void;
  openPalette(): void;
  setEditing(on: boolean): void;
  openNewIsland(): void;
}

// 调试用：?demo=card|list|build|palette|edit|night|inside|far|planet|region|island|go:N —— 打开页面后直接进入某个界面状态
const demo = params.get('demo');
if (demo) window.setTimeout(() => {
  const c = view.townCtl as unknown as DemoTown;
  const first = [...view.docs.values()].sort((a, b) => b.items.length - a.items.length)[1];
  if (demo === 'card') c.select(first.id);
  if (demo === 'list') c.toggleList(true);
  if (demo === 'build') c.openBuild();
  if (demo === 'palette') { c.openPalette(); const i = view.ui.paletteInput as HTMLInputElement; i.value = params.get('q') || '法'; i.dispatchEvent(new Event('input')); }
  if (demo === 'edit') { c.setEditing(true); c.select(first.id); }
  if (demo === 'night') view.toggleNight();
  if (demo === 'inside') view.enterPalace(first.id, { instant: true });
  if (demo === 'far') view.flyToWorld(.01);
  if (demo === 'planet') view.flyToPlanet(.01);
  if (demo === 'region') { view.flyToWorld(.01); window.setTimeout(() => c.selectRegion(view.world.regions[1].id), 600); }
  if (demo === 'island') { view.flyToWorld(.01); window.setTimeout(() => c.openNewIsland(), 600); }
  if (demo.startsWith('go:')) view.flyToRegion(view.world.regions[Number(demo.slice(3))].id, .01);
}, 2400);

declare global {
  interface Window {
    /** 调试用：当前的视图实例 */
    palaceView?: PalaceView;
    /** 调试用：清空本机的全部数据后重新加载 */
    resetPalace?: () => void;
    /** 调试用：推进若干帧并渲染 */
    step?: (frames?: number, dt?: number) => void;
    /** 调试用：渲染截图并把画面交给 vite 的 /__snapshot 中间件 */
    snapshot?: (name?: string, frames?: number) => Promise<string>;
  }
}
