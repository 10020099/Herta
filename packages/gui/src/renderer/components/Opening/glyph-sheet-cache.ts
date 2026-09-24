import type { OpeningSheetEntry } from "./glyph-sheet-layout.js";

/**
 * The drawn glyph sheet, kept between launches (M-opening-5, 2026-09-25).
 *
 * The opening waits for its sheet (M-opening-4), and drawing it — ~2.6k
 * glyphs, most of the time the worker's own font and canvas start-up — put
 * the first frame ~0.1 s later on every launch. The drawing only changes with
 * what goes into it, and the window's size is restored between launches, so
 * the sheet is stored once as a PNG in IndexedDB and decoded on the launches
 * after. One entry only: a new key replaces the old one.
 */

/** Bump when the sheet's drawing changes in a way the key cannot see. */
export const SHEET_CACHE_VERSION = 1;

/** What a sheet's pixels depend on, as one string. `engine` is the
 *  browser's user agent: a new Chromium may rasterize text differently, and
 *  an app update brings one. */
export function sheetCacheKey(
  request: {
    readonly sizes: readonly number[];
    readonly dpr: number;
    readonly ink: string;
    readonly fontFamily: string;
    readonly glyphs: string;
  },
  engine: string,
): string {
  return JSON.stringify([
    SHEET_CACHE_VERSION,
    request.sizes,
    request.dpr,
    request.ink,
    request.fontFamily,
    request.glyphs,
    engine,
  ]);
}

/** A stored sheet: its pixels and its layout. */
export interface CachedSheet {
  readonly png: Blob;
  readonly entries: readonly OpeningSheetEntry[];
}

const DB_NAME = "herta-opening";
const STORE = "glyph-sheet";
const ENTRY = "latest";

interface StoredRecord extends CachedSheet {
  readonly key: string;
}

function openDb(idb: IDBFactory | undefined): Promise<IDBDatabase | null> {
  if (idb === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const open = idb.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** The stored sheet for `key`, or null (none, another key, or no storage).
 *  Never throws. */
export async function readCachedSheet(
  key: string,
  idb: IDBFactory | undefined = globalThis.indexedDB,
): Promise<CachedSheet | null> {
  const db = await openDb(idb);
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const get = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get(ENTRY);
      get.onsuccess = () => {
        const record = get.result as StoredRecord | undefined;
        db.close();
        resolve(
          record !== undefined && record.key === key
            ? { png: record.png, entries: record.entries }
            : null,
        );
      };
      get.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** Store `sheet` under `key`, replacing whatever was stored. Never throws. */
export async function writeCachedSheet(
  key: string,
  sheet: CachedSheet,
  idb: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  const db = await openDb(idb);
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const record: StoredRecord = { key, ...sheet };
      tx.objectStore(STORE).put(record, ENTRY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}
