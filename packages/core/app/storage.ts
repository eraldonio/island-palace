/* =====================================================================
 * IndexedDB 存储助手：用于独立网页版持久化大体积媒体（照片、模型）与数据
 * 纯原生 IndexedDB 实现，无需第三方依赖；降级与迁移兼容 localStorage。
 * ===================================================================== */

const DB_NAME = 'island-palace-db';
const DB_VERSION = 1;
export const STORE_MEDIA = 'media';
export const STORE_DOCS = 'docs';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function isIdbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** 打开或获取数据库实例（单例 Promise） */
export function openAppDb(): Promise<IDBDatabase | null> {
  if (!isIdbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          db.createObjectStore(STORE_MEDIA);
        }
        if (!db.objectStoreNames.contains(STORE_DOCS)) {
          db.createObjectStore(STORE_DOCS);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => {
        console.warn('[island-palace] Failed to open IndexedDB:', req.error || e);
        resolve(null);
      };
      req.onblocked = () => {
        console.warn('[island-palace] IndexedDB open blocked');
        resolve(null);
      };
    } catch (err) {
      console.warn('[island-palace] IndexedDB error:', err);
      resolve(null);
    }
  });

  return dbPromise;
}

/** 从指定的 objectStore 中读取单条数据 */
export async function idbGet<T = unknown>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openAppDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

/** 向指定的 objectStore 写入单条数据 */
export async function idbSet<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openAppDb();
  if (!db) throw new Error('IndexedDB unavailable');
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    } catch (err) {
      reject(err);
    }
  });
}

/** 从指定的 objectStore 删除单条数据 */
export async function idbDel(storeName: string, key: string): Promise<void> {
  const db = await openAppDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    } catch (err) {
      reject(err);
    }
  });
}

/** 清空指定的 objectStore */
export async function idbClear(storeName: string): Promise<void> {
  const db = await openAppDb();
  if (!db) return;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    } catch (err) {
      reject(err);
    }
  });
}
