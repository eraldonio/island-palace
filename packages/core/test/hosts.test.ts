import { describe, it, expect } from 'vitest';
import { PALACE_FORMAT, PALACE_VERSION } from '../src/schema';
import { WORLD_FORMAT } from '../src/world';
import { PalaceStore, type StorageAdapter } from '../src/store';

// 存储的防抖用 window.setTimeout；Node 里没有 window
(globalThis as { window?: unknown }).window ??= globalThis;

interface IndexFile {
  version: number;
  palaces: { id: string; name: string; updatedAt: number }[];
}
interface DocFile { name?: string }

function memStorage(files: Record<string, unknown> = {}): StorageAdapter & { files: Record<string, unknown> } {
  return {
    files,
    load: async (f) => (f in files ? JSON.parse(JSON.stringify(files[f])) : null),
    save: async (f, d) => { files[f] = JSON.parse(JSON.stringify(d)); },
    remove: async (f) => { delete files[f]; },
  };
}

describe('宫殿存储', () => {
  it('空存储：建「我的家」；保存防抖、flush 写盘', async () => {
    const st = memStorage();
    const store = new PalaceStore(st, (m) => { throw new Error(m); });
    const { docs, world } = await store.loadAll();
    expect(docs.map(d => d.name)).toEqual(['我的家']);
    expect(Object.keys(st.files).sort()).toEqual(['index.json', `palaces/${docs[0].id}.json`]);
    docs[0].name = '新名字';
    store.saveDoc(docs[0]);
    store.saveWorld(world);
    await store.flush();
    // 写盘的是 JSON，读回来时按已知的磁盘结构看（memStorage.files 的值是 unknown）
    const savedDoc = st.files[`palaces/${docs[0].id}.json`] as DocFile;
    const savedIndex = st.files['index.json'] as IndexFile;
    expect(savedDoc.name).toBe('新名字');
    expect(savedIndex.palaces[0].name).toBe('新名字');
    expect(st.files['world.json']).toBeTruthy();
  });

  it('旧版本数据：读取时留备份；更新版本的数据：跳过并提示，世界文件不被覆盖', async () => {
    const old = { format: PALACE_FORMAT, version: 3, id: 'p-old', name: '旧宫殿', createdAt: 0, updatedAt: 0, rooms: [], walls: [], items: [] };
    const future = { ...old, id: 'p-new', name: '未来宫殿', version: 99, compat: 99 };
    const worldFuture = { format: WORLD_FORMAT, version: 99, compat: 99, id: 'w', name: 'w', createdAt: 0, updatedAt: 0, regions: [] };
    const st = memStorage({
      'index.json': { version: 1, palaces: [{ id: 'p-old', name: '旧宫殿', updatedAt: 0 }, { id: 'p-new', name: '未来宫殿', updatedAt: 0 }] },
      'palaces/p-old.json': old, 'palaces/p-new.json': future, 'world.json': worldFuture,
    });
    const errs: string[] = [];
    const store = new PalaceStore(st, (m) => errs.push(m));
    const { docs, world } = await store.loadAll();
    expect(docs.map(d => [d.name, d.version])).toEqual([['旧宫殿', PALACE_VERSION]]);
    expect(st.files['backups/p-old.v3.json']).toEqual(old);
    expect(errs.join()).toMatch(/未来宫殿.*升级/);
    expect(errs.join()).toMatch(/世界数据/);
    store.saveWorld(world);
    await store.flush();
    expect(st.files['world.json']).toEqual(worldFuture);
    expect(st.files['palaces/p-new.json']).toEqual(future);
  });
});
