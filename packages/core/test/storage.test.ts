// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openAppDb, idbGet, idbSet, idbDel, idbClear, STORE_MEDIA, STORE_DOCS } from '../app/storage';

/**
 * 最小化 IDB 模拟器，用于在无原生 indexedDB 的 happy-dom / Node 测试环境中
 * 验证 app/storage 的 open、get、set、del、clear 逻辑
 */
class FakeIDBStore {
  map = new Map<string, unknown>();
  get(k: string) {
    const req = { result: this.map.get(k), error: null, onsuccess: null as any, onerror: null as any };
    queueMicrotask(() => req.onsuccess?.({ target: req }));
    return req;
  }
  put(v: unknown, k: string) {
    this.map.set(k, v);
    const req = { result: k, error: null, onsuccess: null as any, onerror: null as any };
    queueMicrotask(() => req.onsuccess?.({ target: req }));
    return req;
  }
  delete(k: string) {
    this.map.delete(k);
    const req = { result: undefined, error: null, onsuccess: null as any, onerror: null as any };
    queueMicrotask(() => req.onsuccess?.({ target: req }));
    return req;
  }
  clear() {
    this.map.clear();
    const req = { result: undefined, error: null, onsuccess: null as any, onerror: null as any };
    queueMicrotask(() => req.onsuccess?.({ target: req }));
    return req;
  }
}

class FakeIDBDatabase {
  stores = new Map<string, FakeIDBStore>();
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  createObjectStore(name: string) {
    const s = new FakeIDBStore();
    this.stores.set(name, s);
    return s;
  }
  transaction(storeNames: string | string[], _mode: string) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    let s = this.stores.get(name);
    if (!s) {
      s = new FakeIDBStore();
      this.stores.set(name, s);
    }
    const tx = {
      objectStore: () => s,
      onabort: null as any,
      error: null,
    };
    return tx;
  }
}

function installFakeIndexedDB() {
  const fakeDb = new FakeIDBDatabase();
  fakeDb.createObjectStore(STORE_MEDIA);
  fakeDb.createObjectStore(STORE_DOCS);

  const fakeFactory = {
    open(_name: string, _version?: number) {
      const req = {
        result: fakeDb,
        error: null,
        onupgradeneeded: null as any,
        onsuccess: null as any,
        onerror: null as any,
        onblocked: null as any,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
  (globalThis as any).indexedDB = fakeFactory;
}

describe('app/storage IndexedDB 助手', () => {
  beforeEach(async () => {
    installFakeIndexedDB();
    await idbClear(STORE_MEDIA);
    await idbClear(STORE_DOCS);
  });

  it('支持写入与读取数据到 STORE_MEDIA', async () => {
    const key = 'media-123';
    const testData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await idbSet(STORE_MEDIA, key, testData);
    const read = await idbGet<string>(STORE_MEDIA, key);
    expect(read).toBe(testData);

    await idbDel(STORE_MEDIA, key);
    const afterDel = await idbGet(STORE_MEDIA, key);
    expect(afterDel).toBeUndefined();
  });

  it('支持文档备份到 STORE_DOCS 与清空', async () => {
    const doc = { id: 'palace-abc', name: '测试宫殿', rooms: [] };
    await idbSet(STORE_DOCS, doc.id, doc);

    const read = await idbGet<typeof doc>(STORE_DOCS, doc.id);
    expect(read).toEqual(doc);

    await idbClear(STORE_DOCS);
    expect(await idbGet(STORE_DOCS, doc.id)).toBeUndefined();
  });

  it('若环境中 indexedDB 不可用则优雅返回 null/undefined 而不崩溃', async () => {
    (globalThis as any).indexedDB = undefined;
    expect(await idbGet(STORE_MEDIA, 'not-exists')).toBeUndefined();
  });
});
