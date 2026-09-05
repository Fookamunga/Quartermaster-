import { WOOLWORTHS_ORDERING_PERSISTENT_WORKER } from "./config.js";
import { runContainerAgent } from "./containerRunner.js";
import type { ChannelKey, ContainerOutput } from "./types.js";
import { runWarmSessionPrompt } from "./warmSession.js";

/**
 * Per-channel opt-in switch between the cold, one-shot container path
 * (default) and a warm, persistent Agent SDK session. See CLAUDE.md's
 * warm-session section and warmSession.ts's file header for why warm mode
 * is now allowed at all (it was a flat prohibition until a nanoclaw-discord
 * investigation found the real, fixable root cause) and why it stays
 * scoped per channel behind an explicit flag defaulting to off, rather than
 * a fleet-wide switch -- so a real issue that only shows up under actual
 * usage can be isolated to one channel instead of forcing an all-or-nothing
 * rollback.
 */
function isPersistentWorkerEnabled(channelKey: ChannelKey): boolean {
  if (channelKey === "woolworths-ordering") return WOOLWORTHS_ORDERING_PERSISTENT_WORKER;
  return false; // order-import never reaches this dispatcher at all -- see index.ts
}

export async function runAgent(
  channelKey: ChannelKey,
  prompt: string,
  sessionId: string | undefined,
): Promise<ContainerOutput> {
  if (isPersistentWorkerEnabled(channelKey)) {
    return runWarmSessionPrompt(channelKey, prompt);
  }
  return runContainerAgent(channelKey, prompt, sessionId);
}

export { isPersistentWorkerEnabled };
