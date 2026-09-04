import path from "node:path";
import { DATA_DIR } from "./config.js";
import { loadJson, saveJson } from "./jsonStore.js";
import type { ChannelKey } from "./types.js";

const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

type SessionStore = Partial<Record<ChannelKey, string>>;

let sessions: SessionStore = loadJson(SESSIONS_FILE, {});

export function getSessionId(channelKey: ChannelKey): string | undefined {
  return sessions[channelKey];
}

export function saveSessionId(channelKey: ChannelKey, sessionId: string): void {
  sessions = { ...sessions, [channelKey]: sessionId };
  saveJson(SESSIONS_FILE, sessions);
}
