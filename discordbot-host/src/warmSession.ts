import { mkdirSync } from "node:fs";
import path from "node:path";
import { query, type McpServerConfig, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DATA_DIR,
  STAPLES_HOST_URL,
  WARM_HEALTH_CHECK_TIMEOUT_MS,
  WARM_MCP_TOOL_TIMEOUT_MS,
  WARM_PROMPT_TIMEOUT_MS,
  WOOLIES_MCP_URL,
  WORKSPACES_DIR,
} from "./config.js";
import { logger } from "./logger.js";
import { saveSessionId } from "./sessions.js";
import type { ChannelKey, ContainerOutput } from "./types.js";

/**
 * Warm (persistent, streaming-input) Claude Agent SDK sessions -- one
 * long-lived `query()` call per opted-in channel, kept alive in this
 * process across Discord messages instead of spawning a fresh container
 * per message. See CLAUDE.md's warm-session section for the full context:
 * this used to be flatly prohibited project-wide after a nanoclaw-discord
 * investigation initially diagnosed it as an unfixable upstream Agent SDK
 * defect. It turned out to be two bugs in nanoclaw's own application code:
 *
 *   1. A health check that polled for warm-worker health without ever
 *      delivering a prompt first -- structurally guaranteed to hang, since
 *      the SDK's streaming generator only produces messages in response to
 *      something written to the async-iterable it's blocked reading from.
 *   2. An MCP-call bridge timeout (20s) too short for a fresh connection
 *      handshake under real network conditions.
 *
 * The two rules this module exists to bake in from day one, so this
 * category of bug can't quietly reappear:
 *
 *   - NEVER check a warm session's health by waiting for a signal (e.g.
 *     `system`/`init`) alone. Always push a real (or lightweight synthetic)
 *     prompt onto the queue first, then wait for its result. See
 *     `sendPrompt` / `HEALTH_CHECK_PROMPT` below -- there is no code path
 *     in this file that waits on the session without enqueueing a prompt.
 *   - Size MCP/timeout values generously (see config.ts's
 *     WARM_MCP_TOOL_TIMEOUT_MS / WARM_HEALTH_CHECK_TIMEOUT_MS /
 *     WARM_PROMPT_TIMEOUT_MS comments) rather than reusing arbitrary SDK
 *     defaults, since a fresh MCP connection handshake after a restart is
 *     the exact scenario that bit nanoclaw.
 *
 * UNTESTED UNDER REAL USAGE: Quartermaster has no live Discord traffic yet.
 * Everything in this file has only been exercised synthetically (manual
 * health-check calls, a manual forced restart) -- see this module's
 * `README.md` section for what that does and doesn't prove. The same
 * category of bug that hit nanoclaw (a check that can never pass, a
 * timeout that's fine synthetically but too tight under real network
 * conditions) could in principle still be lurking here until it's actually
 * exercised by real messages over a real period of time.
 */

const HEALTH_CHECK_PROMPT =
  "(Quartermaster warm-session health check -- no action needed, just reply with exactly: OK)";

type PendingResolver = (output: ContainerOutput) => void;

interface WarmSessionState {
  channelKey: ChannelKey;
  handle: Query;
  push: (message: SDKUserMessage) => void;
  close: () => void;
  consumerTask: Promise<void>;
  sessionId?: string;
  pendingResolve?: PendingResolver;
  pendingTimer?: NodeJS.Timeout;
  /** Serializes sendPrompt calls against this session -- one turn in flight at a time. */
  mutex: Promise<unknown>;
  restarting: boolean;
}

const sessions = new Map<ChannelKey, WarmSessionState>();

/**
 * Minimal async queue backing the SDK's streaming-input `prompt` iterable.
 * `push` never blocks; `close` ends the iterator so the underlying `query()`
 * generator (and the CLI subprocess it manages) can shut down cleanly.
 */
function createPromptQueue(): {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (message: SDKUserMessage) => void;
  close: () => void;
} {
  const buffered: SDKUserMessage[] = [];
  const waiting: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  let closed = false;

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (buffered.length > 0) {
              return Promise.resolve({ value: buffered.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => waiting.push(resolve));
          },
        };
      },
    },
    push(message: SDKUserMessage) {
      const resolver = waiting.shift();
      if (resolver) {
        resolver({ value: message, done: false });
      } else {
        buffered.push(message);
      }
    },
    close() {
      closed = true;
      while (waiting.length > 0) {
        waiting.shift()!({ value: undefined, done: true });
      }
    },
  };
}

function warmMcpServers(): Record<string, McpServerConfig> {
  // Full custom-tool surface, same servers a cold woolworths-ordering
  // session gets -- there's no need to strip MCP registration from a warm
  // session, that was a real but unnecessary workaround nanoclaw built
  // before finding the actual bug. Generous per-server tool-call timeout:
  // see WARM_MCP_TOOL_TIMEOUT_MS's comment in config.ts.
  return {
    woolies: { type: "http", url: WOOLIES_MCP_URL, timeout: WARM_MCP_TOOL_TIMEOUT_MS },
    staples: { type: "http", url: STAPLES_HOST_URL, timeout: WARM_MCP_TOOL_TIMEOUT_MS },
  };
}

function claudeHomeDir(channelKey: ChannelKey): string {
  const dir = path.join(DATA_DIR, "sessions", channelKey, ".claude-home");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

function settleResult(session: WarmSessionState, output: ContainerOutput): void {
  if (session.pendingTimer) clearTimeout(session.pendingTimer);
  const resolve = session.pendingResolve;
  session.pendingResolve = undefined;
  session.pendingTimer = undefined;
  resolve?.(output);
}

async function consume(session: WarmSessionState): Promise<void> {
  try {
    for await (const message of session.handle) {
      if (message.type === "system" && message.subtype === "init") {
        session.sessionId = message.session_id;
        saveSessionId(session.channelKey, session.sessionId);
        logger.info("Warm session initialized", { channelKey: session.channelKey, sessionId: session.sessionId });
        continue;
      }
      if (message.type === "result") {
        if (message.subtype === "success") {
          settleResult(session, { status: "success", result: message.result, newSessionId: session.sessionId });
        } else {
          settleResult(session, {
            status: "error",
            result: null,
            newSessionId: session.sessionId,
            error: `Warm session turn failed: ${message.subtype}`,
          });
        }
      }
    }
    // The generator only ends if the CLI subprocess exited or the queue was
    // closed. A queue close is always paired with deleting the session
    // below first, so reaching here with the session still registered
    // means the subprocess died unexpectedly -- restart it.
    if (sessions.get(session.channelKey) === session) {
      logger.error("Warm session generator ended unexpectedly", { channelKey: session.channelKey });
      settleResult(session, {
        status: "error",
        result: null,
        error: "Warm session ended unexpectedly before a result was produced",
      });
      scheduleRestart(session.channelKey, "generator ended unexpectedly");
    }
  } catch (err) {
    logger.error("Warm session consumer loop errored", { channelKey: session.channelKey, err: String(err) });
    settleResult(session, { status: "error", result: null, error: `Warm session error: ${String(err)}` });
    if (sessions.get(session.channelKey) === session) {
      scheduleRestart(session.channelKey, `consumer error: ${String(err)}`);
    }
  }
}

function startWarmSession(channelKey: ChannelKey): WarmSessionState {
  const workspaceDir = path.join(WORKSPACES_DIR, channelKey);
  mkdirSync(workspaceDir, { recursive: true });

  const mcpServers = warmMcpServers();
  const remoteServerNames = Object.keys(mcpServers);
  const allowedTools = ["Bash", "Read", "Write", "Glob", "Grep", ...remoteServerNames.map((name) => `mcp__${name}__*`)];
  const model = process.env.CLAUDE_MODEL || undefined;

  const queue = createPromptQueue();

  const handle = query({
    prompt: queue.iterable,
    options: {
      ...(model ? { model } : {}),
      cwd: workspaceDir,
      allowedTools,
      // NOT allowDangerouslySkipPermissions here (unlike the cold-session
      // runner): that option forces the CLI's literal --dangerously-skip-
      // permissions flag, which the CLI refuses outright when running as
      // root -- and this process (unlike the cold runner's own container,
      // which runs as a non-root `node` user) runs as root, since it needs
      // docker.sock access to spawn sibling containers. permissionMode:
      // "bypassPermissions" alone gives the same no-interactive-prompts
      // behavior via a different, sanctioned CLI flag that isn't blocked
      // under root. Found live: enabling warm mode crashed the CLI
      // immediately with "cannot be used with root/sudo privileges", which
      // fed straight into an unthrottled restart loop (89 attempts/2min,
      // climbing CPU load) since scheduleRestart has no backoff -- see the
      // TODO below.
      permissionMode: "bypassPermissions",
      settingSources: ["project"],
      mcpServers,
      // Replaces the subprocess env entirely (per SDK docs) -- spread
      // process.env so PATH/Claude-auth vars still reach it, then pin HOME
      // to a per-channel dir so this channel's warm session keeps its own
      // Claude Code session/transcript state, isolated the same way the
      // cold path's mounted .claude directory isolates it per channel.
      env: { ...process.env, HOME: claudeHomeDir(channelKey) },
      stderr: (data: string) => logger.info(`[warm:${channelKey}] ${data.trimEnd()}`),
    },
  });

  const session: WarmSessionState = {
    channelKey,
    handle,
    push: queue.push,
    close: queue.close,
    consumerTask: Promise.resolve(),
    mutex: Promise.resolve(),
    restarting: false,
  };
  session.consumerTask = consume(session);
  sessions.set(channelKey, session);
  logger.info("Warm session starting", { channelKey });
  return session;
}

/**
 * Sends one prompt to the channel's warm session and waits for its result,
 * serialized against any other in-flight prompt for the same channel (a
 * warm session processes one turn at a time; Discord messages for a
 * channel are already handled sequentially, so this mutex is a safety net,
 * not the primary serialization point).
 */
function sendPrompt(session: WarmSessionState, text: string, timeoutMs: number): Promise<ContainerOutput> {
  const run = () =>
    new Promise<ContainerOutput>((resolve) => {
      session.pendingTimer = setTimeout(() => {
        session.pendingResolve = undefined;
        session.pendingTimer = undefined;
        resolve({ status: "error", result: null, error: `Warm session prompt timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      session.pendingResolve = resolve;
      session.push(userMessage(text));
    });

  const result = session.mutex.then(run, run);
  session.mutex = result.catch(() => {});
  return result;
}

// Consecutive-failure count per channel, purely to size restart backoff --
// survives across restarts since each one replaces the WarmSessionState
// object. Found live: a session that crashes immediately on every restart
// (e.g. the root/--dangerously-skip-permissions bug below) fed straight back
// into scheduleRestart with no delay, hitting 89 restart attempts in 2
// minutes and climbing CPU load before it was caught -- this exists so any
// future immediate-crash cause degrades into a slow retry instead of a tight
// loop, without needing that specific cause diagnosed first.
const restartFailureCounts = new Map<ChannelKey, number>();

function backoffDelayMs(channelKey: ChannelKey): number {
  const failures = restartFailureCounts.get(channelKey) ?? 0;
  return Math.min(1000 * 2 ** failures, 60000); // 1s, 2s, 4s, ... capped at 60s
}

function scheduleRestart(channelKey: ChannelKey, reason: string): void {
  const session = sessions.get(channelKey);
  if (!session || session.restarting) return;
  session.restarting = true;
  sessions.delete(channelKey);
  const delayMs = backoffDelayMs(channelKey);
  logger.warn("Scheduling warm session restart", { channelKey, reason, delayMs });
  // Same restart path regardless of trigger (crash here, periodic refresh,
  // or a manual call) -- deliberately the single code path, so exercising
  // any one of them exercises all of them. See CLAUDE.md / README: this is
  // specifically the path that caught nanoclaw's health-check bug, and it
  // still needs a real trigger (not just this synthetic one) once
  // Quartermaster is live to be considered proven.
  setTimeout(() => {
    void restartWarmSession(channelKey, reason, session);
  }, delayMs);
}

async function restartWarmSession(
  channelKey: ChannelKey,
  reason: string,
  previous: WarmSessionState | undefined,
): Promise<boolean> {
  if (previous) {
    try {
      await previous.handle.interrupt?.();
    } catch {
      // best-effort; the subprocess may already be gone
    }
    previous.close();
  }
  const fresh = startWarmSession(channelKey);
  const healthy = await healthCheck(fresh);
  if (!healthy) {
    const failures = (restartFailureCounts.get(channelKey) ?? 0) + 1;
    restartFailureCounts.set(channelKey, failures);
    logger.error("Warm session restart failed health check", { channelKey, reason, consecutiveFailures: failures });
  } else {
    restartFailureCounts.delete(channelKey);
    logger.info("Warm session restarted and healthy", { channelKey, reason });
  }
  return healthy;
}

/**
 * The fix for nanoclaw's root-cause bug, made structurally impossible to
 * skip: this is the ONLY health-check entry point in this file, and it
 * always pushes HEALTH_CHECK_PROMPT and waits for a real result before
 * returning -- never a bare wait on `system`/`init` or any other signal.
 */
async function healthCheck(session: WarmSessionState): Promise<boolean> {
  const output = await sendPrompt(session, HEALTH_CHECK_PROMPT, WARM_HEALTH_CHECK_TIMEOUT_MS);
  return output.status === "success";
}

/**
 * Ensures a healthy warm session exists for this channel, starting (or
 * restarting) one if needed. Safe to call both eagerly at boot and lazily
 * on first message.
 */
export async function ensureWarmSession(channelKey: ChannelKey): Promise<boolean> {
  const existing = sessions.get(channelKey);
  if (existing && !existing.restarting) return true;
  if (existing?.restarting) return false; // a restart is already in flight
  const session = startWarmSession(channelKey);
  return healthCheck(session);
}

export async function runWarmSessionPrompt(channelKey: ChannelKey, prompt: string): Promise<ContainerOutput> {
  let session = sessions.get(channelKey);
  if (!session || session.restarting) {
    const ok = await ensureWarmSession(channelKey);
    if (!ok) {
      return { status: "error", result: null, error: "Warm session is not healthy (failed startup health check)" };
    }
    session = sessions.get(channelKey);
  }
  if (!session) {
    return { status: "error", result: null, error: "Warm session unavailable after startup" };
  }
  return sendPrompt(session, prompt, WARM_PROMPT_TIMEOUT_MS);
}

/** Manual/periodic restart trigger -- routes through the same path as crash recovery. */
export async function forceRestartWarmSession(channelKey: ChannelKey, reason: string): Promise<boolean> {
  const previous = sessions.get(channelKey);
  sessions.delete(channelKey);
  return restartWarmSession(channelKey, reason, previous);
}
