import { PalaceView, setLocale, createHomePalace, createFromTemplate, normalizePalace, normalizeWorld, createWorld, createRegion, findFreeSpot, findRegionSpot, NOTE_FS, type HostAdapter, type PalaceDoc, type PalaceWorld } from '../src';
import { samplePalaces, L } from './samples';
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

import { openAppDb, idbGet, idbSet, idbDel, idbClear, STORE_MEDIA, STORE_DOCS } from './storage';

function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: string; code?: number };
  return err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22
    || err.code === 1014;
}

function handleStorageError(action: string, e: unknown) {
  console.warn(`[island-palace] Failed to save ${action}:`, e);
  if (isQuotaError(e)) {
    host.notify?.(
      L('本地存储空间已满，数据未能保存。请尝试清理浏览器缓存或删除部分宫殿/图片。',
        'Local storage quota exceeded; unable to save. Please free up browser storage space or remove some palaces/photos.'),
      'error'
    );
  } else {
    host.notify?.(
      L('保存失败：{msg}', 'Failed to save: {msg}').replace('{msg}', String((e as Error)?.message || e)),
      'error'
    );
  }
}

function saveDoc(doc: PalaceDoc) {
  try {
    store.setItem(K.doc(doc.id), JSON.stringify(doc));
    const ids: string[] = JSON.parse(store.getItem(K.ids) || '[]');
    if (!ids.includes(doc.id)) store.setItem(K.ids, JSON.stringify([...ids, doc.id]));
  } catch (e) {
    handleStorageError(`doc:${doc.id}`, e);
  }
  // 异步写入 IndexedDB 作为备份，避免未来 localStorage 丢失或超出配额
  idbSet(STORE_DOCS, doc.id, doc).catch(err => {
    console.warn('[island-palace] Failed to backup doc to IndexedDB:', err);
  });
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
  // 第一次打开：纯净的岛屿世界（海岛、森林、雪山、浮空岛），没有室内宫殿，小管家自由漫步
  const docs: PalaceDoc[] = [];
  const map = new Map<string, PalaceDoc>();
  const world = createWorld();
  world.regions = [];
  const groups: [string, string, number][] = [
    [L('海滨小岛', 'Coastal Isle'), 'island', 101],
    [L('林间小岛', 'Forest Isle'), 'forest', 202],
    [L('雪山小岛', 'Snowy Isle'), 'snow', 303],
    [L('浮空小岛', 'Sky Isle'), 'sky', 404],
  ];
  for (const [name, theme, seedN] of groups) {
    const r = createRegion(name, theme);
    r.seed = seedN;
    r.origin = findRegionSpot(world, map, r);
    world.regions.push(r);
  }
  // 在第一座岛上放一张欢迎便签
  if (world.regions[0]) {
    world.regions[0].notes = [
      {
        id: 'welcome-note',
        pos: [0, 2],
        w: 3.2,
        h: 2.2,
        color: 0,
        fs: NOTE_FS.def,
        html: L(
          '<p><strong>欢迎来到海岛世界！</strong></p><p>在这里漫步看风景、写便签、布置岛屿，还有小动物陪伴你的每一天。</p>',
          '<p><strong>Welcome to the Island World!</strong></p><p>Stroll around, write notes, arrange your islands, and enjoy life with your companion.</p>'
        ),
      },
    ];
  }
  return { world, docs, fresh: true };
}

const host: HostAdapter = {
  prefs: {
    get: (k) => {
      try { return store.getItem(k); } catch { return null; }
    },
    set: (k, v) => {
      try { store.setItem(k, v); } catch (e) { handleStorageError(`pref:${k}`, e); }
    },
  },
  onDocChange: saveDoc,
  onWorldChange(world) {
    try {
      store.setItem(K.world, JSON.stringify(world));
    } catch (e) {
      handleStorageError('world', e);
    }
    // 异步同步到 IndexedDB 备份
    idbSet(STORE_DOCS, 'world', world).catch(err => {
      console.warn('[island-palace] Failed to backup world to IndexedDB:', err);
    });
  },
  onDocDelete(id) {
    try {
      store.removeItem(K.doc(id));
      const ids: string[] = JSON.parse(store.getItem(K.ids) || '[]');
      store.setItem(K.ids, JSON.stringify(ids.filter(x => x !== id)));
    } catch (e) {
      handleStorageError(`delete:${id}`, e);
    }
    idbDel(STORE_DOCS, id).catch(() => {});
  },
  onLocationChange(id, name) { document.title = `${name} · ${L('海岛宫殿', 'Island Palace')}`; void id; },
  notify(msg, type = 'info') {
    if (type === 'error') console.error('[island-palace]', msg);
    else console.info('[island-palace]', msg);
  },
  async saveMedia(blob, id) {
    // 优先尝试存入 IndexedDB（原生二进制 Blob，不受 5MB localStorage 限制）
    let savedToIdb = false;
    try {
      const db = await openAppDb();
      if (db) {
        await idbSet(STORE_MEDIA, id, blob);
        savedToIdb = true;
      }
    } catch (e) {
      console.warn('[island-palace] Failed to save media to IndexedDB:', e);
    }

    // 若 IndexedDB 成功，清理 localStorage 中的旧同名 base64 记录（如果存在）以释放配额
    if (savedToIdb) {
      try { store.removeItem(K.media(id)); } catch {}
      return;
    }

    // 降级：转为 data URL 存入 localStorage，妥善捕获 QuotaExceededError
    const url = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });

    try {
      store.setItem(K.media(id), url);
    } catch (e) {
      handleStorageError(`media:${id}`, e);
      throw e;
    }
  },
  async loadMedia(id) {
    // 1. 优先从 IndexedDB 读取二进制 Blob
    try {
      const val = await idbGet<Blob | string>(STORE_MEDIA, id);
      if (val instanceof Blob) {
        return URL.createObjectURL(val);
      }
      if (typeof val === 'string') {
        return val;
      }
    } catch (e) {
      console.warn('[island-palace] Failed to load media from IndexedDB:', e);
    }

    // 2. 降级 / 兼容检查：从 localStorage 读取已有的 base64 字符串
    const legacyUrl = store.getItem(K.media(id));
    if (legacyUrl) {
      // 读到旧数据后，在后台异步迁移到 IndexedDB，并从 localStorage 中移除以释放宝贵的 5MB 配额
      (async () => {
        try {
          const db = await openAppDb();
          if (db) {
            await idbSet(STORE_MEDIA, id, legacyUrl);
            store.removeItem(K.media(id));
          }
        } catch {}
      })();
      return legacyUrl;
    }

    throw new Error(L('照片不存在', 'Photo not found'));
  },
};

const { world, docs, fresh } = load();
const view = new PalaceView(document.getElementById('app'), { world, docs, host, enter: params.get('enter'), locale: LANG });
if (!world || fresh) host.onWorldChange(view.world);

// 调试用：控制台里可以拿到的句柄
window.palaceView = view;
window.resetPalace = async () => {
  Object.keys(store).filter(k => k.startsWith(P)).forEach(k => store.removeItem(k));
  try {
    await idbClear(STORE_MEDIA);
    await idbClear(STORE_DOCS);
  } catch {}
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
  const first = [...view.docs.values()].sort((a, b) => b.items.length - a.items.length)[1] || [...view.docs.values()][0];
  if (demo === 'card' && first) c.select(first.id);
  if (demo === 'list') c.toggleList(true);
  if (demo === 'build') c.openBuild();
  if (demo === 'palette') { c.openPalette(); const i = view.ui.paletteInput as HTMLInputElement; i.value = params.get('q') || '岛'; i.dispatchEvent(new Event('input')); }
  if (demo === 'edit') { c.setEditing(true); if (first) c.select(first.id); }
  if (demo === 'night') view.toggleNight();
  if (demo === 'inside' && first) view.enterPalace(first.id, { instant: true });
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
