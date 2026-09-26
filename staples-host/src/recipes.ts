import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, RECIPES_PATH } from "./config.js";
import { todayIso } from "./replenishment.js";

export interface Recipe {
  recipe_id: string;
  title: string;
  // Free-form: the pasted method, an ingredient list, a note, or nothing at
  // all when the title plus a link says everything. Deliberately unstructured
  // -- a recipe arrives as whatever someone happened to paste into Discord,
  // and forcing it into ingredients/steps up front would reject most of them.
  body: string | null;
  source_url: string | null;
  added_at: string; // ISO datetime
}

/** Recipes keyed by the ISO date of the Sunday that starts their week. */
export interface RecipeBook {
  weeks: Record<string, Recipe[]>;
}

// ---------------------------------------------------------------------------
// Week maths
//
// A week runs Sunday 00:00 to Saturday 23:59, NZ local, and is identified
// throughout by the ISO date of its Sunday. All arithmetic below is done on
// plain YYYY-MM-DD calendar dates parsed as UTC midnight -- never on a local
// Date -- so a DST transition (NZ shifts in late September, i.e. right now)
// can't move a date across a boundary. The NZ-ness comes from todayIso(),
// which reads NZ wall-clock; once we have that calendar date, treating it as
// a timezone-free label is exactly correct. Same reasoning as nzTime.ts.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return formatIsoDate(new Date(parseIsoDate(iso).getTime() + days * MS_PER_DAY));
}

/** The Sunday on or before `iso` -- i.e. the start of the week `iso` falls in. */
export function weekStartFor(iso: string): string {
  // getUTCDay(): 0 = Sunday, so this is already the offset back to Sunday.
  return addDays(iso, -parseIsoDate(iso).getUTCDay());
}

export function thisWeekStart(): string {
  return weekStartFor(todayIso());
}

export function nextWeekStart(): string {
  return addDays(thisWeekStart(), 7);
}

/** The Saturday closing the week that starts on `weekStart`. */
export function weekEndFor(weekStart: string): string {
  return addDays(weekStart, 6);
}

/**
 * Resolve the week a tool call means. "next" is add_recipe's default (you
 * plan the week ahead, per the feature's whole premise) and "this" is
 * get_recipes' default (you ask what you're eating now). An explicit
 * YYYY-MM-DD is snapped back to its Sunday, so a caller can pass any day in
 * the target week without having to work out the Sunday itself.
 */
export function resolveWeek(week: string | undefined, fallback: "this" | "next"): string {
  const value = week?.trim().toLowerCase() || fallback;
  if (value === "this" || value === "current") return thisWeekStart();
  if (value === "next") return nextWeekStart();
  if (value === "last" || value === "previous") return addDays(thisWeekStart(), -7);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return weekStartFor(value);
  throw new Error(
    `Unrecognized week "${week}". Use "this", "next", "last", or a YYYY-MM-DD date within the week.`,
  );
}

// ---------------------------------------------------------------------------
// Storage
//
// A separate file from db.json rather than another key inside it: recipes
// have no relationship to the staples/purchase-event data, are written on a
// completely different cadence, and keeping them apart means a corrupt or
// hand-edited recipe file can never take the replenishment data down with it.
// Mirrors storage.ts's write discipline exactly -- serialized queue plus
// atomic temp-file rename -- for the same read-modify-write reasons.
// ---------------------------------------------------------------------------

let writeQueue: Promise<unknown> = Promise.resolve();

function emptyBook(): RecipeBook {
  return { weeks: {} };
}

async function loadBook(): Promise<RecipeBook> {
  try {
    const raw = await readFile(RECIPES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<RecipeBook>;
    return { weeks: parsed.weeks ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyBook();
    throw err;
  }
}

async function saveBook(book: RecipeBook): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmpPath = path.join(DATA_DIR, `.recipes.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, JSON.stringify(book, null, 2), "utf8");
  await rename(tmpPath, RECIPES_PATH); // atomic on POSIX and NTFS
}

export async function withRecipes<T>(fn: (book: RecipeBook) => T | Promise<T>): Promise<T> {
  const run = async () => {
    const book = await loadBook();
    const result = await fn(book);
    await saveBook(book);
    return result;
  };
  const resultPromise = writeQueue.then(run, run);
  // Swallow errors in the queue chain itself so one failed call can't
  // permanently wedge the queue -- same guard as storage.ts's withDb.
  writeQueue = resultPromise.catch(() => undefined);
  return resultPromise;
}

export async function readRecipes(): Promise<RecipeBook> {
  return loadBook();
}

export function recipesForWeek(book: RecipeBook, weekStart: string): Recipe[] {
  return book.weeks[weekStart] ?? [];
}

export function newRecipeId(): string {
  return `rcp_${randomUUID()}`;
}
