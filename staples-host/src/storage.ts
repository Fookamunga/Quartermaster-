import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DB_PATH } from "./config.js";
import type { Database, Item, PurchaseEvent } from "./types.js";

function emptyDb(): Database {
  return {
    items: [],
    purchase_events: [],
    lastWeeklyReportSentAt: null,
    lastPurchaseHistorySyncedAt: null,
    lastPurchaseHistoryScheduledSyncDate: null,
  };
}

// Serializes writes so concurrent tool calls can't interleave read-modify-write
// cycles and clobber each other. Fine for a single-process MCP server backed
// by a flat JSON file; would need a real lock (or SQLite) across processes.
let writeQueue: Promise<unknown> = Promise.resolve();

async function loadDb(): Promise<Database> {
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<Database>;
    return {
      items: parsed.items ?? [],
      purchase_events: parsed.purchase_events ?? [],
      lastWeeklyReportSentAt: parsed.lastWeeklyReportSentAt ?? null,
      lastPurchaseHistorySyncedAt: parsed.lastPurchaseHistorySyncedAt ?? null,
      lastPurchaseHistoryScheduledSyncDate: parsed.lastPurchaseHistoryScheduledSyncDate ?? null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDb();
    }
    throw err;
  }
}

async function saveDb(db: Database): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmpPath = path.join(DATA_DIR, `.db.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(db, null, 2), "utf8");
  await rename(tmpPath, DB_PATH); // atomic on POSIX and NTFS
}

/**
 * Run `fn` against the current database, persisting whatever it returns.
 * All reads/writes go through this so callers never see a stale copy that
 * a concurrent mutation is about to overwrite.
 */
export async function withDb<T>(
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  const run = async () => {
    const db = await loadDb();
    const result = await fn(db);
    await saveDb(db);
    return result;
  };
  const resultPromise = writeQueue.then(run, run);
  // Swallow errors in the queue chain itself so one failed call doesn't
  // permanently wedge the queue for subsequent calls.
  writeQueue = resultPromise.catch(() => undefined);
  return resultPromise;
}

export async function readDb(): Promise<Database> {
  return loadDb();
}

export function newItemId(): string {
  return `item_${randomUUID()}`;
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

export type { Database, Item, PurchaseEvent };
