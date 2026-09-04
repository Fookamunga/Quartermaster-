import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function loadJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Atomic write (write-temp-then-rename) so a crash mid-write never leaves a
// truncated/corrupt store file behind.
export function saveJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}
