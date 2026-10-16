// Thin IndexedDB layer. Every write promise resolves on transaction complete, never on request success.
import { STORES } from './logic.js';

let dbp;
export function open(h = {}) {   // called once from boot() with banner callbacks; later calls reuse the promise
  return dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open('gym-tracker', 1);
    r.onupgradeneeded = e => {
      if (e.oldVersion < 1) for (const s of STORES) r.result.createObjectStore(s, { keyPath: 'id' });
      // future versions: add `if (e.oldVersion < 2) {…}` below, never edit an existing block
    };
    r.onblocked = () => h.onBlocked?.();
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); h.onVersionChange?.(); };
      ok(db);
    };
    r.onerror = () => no(r.error);
  });
}

const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

async function write(stores, fn) {
  const t = (await open()).transaction(stores, 'readwrite', { durability: 'strict' });
  const done = new Promise((ok, no) => {
    t.oncomplete = () => ok();
    t.onerror = t.onabort = () => no(t.error ?? new Error('Transaction aborted'));
  });
  try { fn(t); } catch (e) { done.catch(() => {}); t.abort(); throw e; }   // a sync DataCloneError must not half-commit
  return done;
}

export const getAll = async s => req((await open()).transaction(s).objectStore(s).getAll());
export const put = (s, v) => write([s], t => t.objectStore(s).put(v));
export const del = (s, id) => write([s], t => t.objectStore(s).delete(id));
export const replaceAll = data => write(STORES, t => {
  for (const s of STORES) { const os = t.objectStore(s); os.clear(); for (const v of data[s]) os.put(v); }
});
