import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Events, type Message } from "discord.js";
import { isPersistentWorkerEnabled, runAgent } from "./agentDispatch.js";
import { WARM_SESSION_REFRESH_INTERVAL_MS, WORKSPACES_DIR } from "./config.js";
import { ensureWorkspaceDirs, takeProposedAction } from "./containerRunner.js";
import { connectDiscord, getChannelKeyForId, sendChannelMessage } from "./discord.js";
import { logger } from "./logger.js";
import { startNeverTrackedSentry } from "./neverTrackedSentry.js";
import { nzTimestamp } from "./nzTime.js";
import { ingestReceiptPhoto } from "./orderImportPhotos.js";
import { formatIngestResult } from "./orderImportRelay.js";
import { ingestOrderText } from "./orderImportText.js";
import { handlePendingActionReaction, postAndTrackAction } from "./pendingActions.js";
import { getSessionId, saveSessionId } from "./sessions.js";
import type { ChannelKey } from "./types.js";
import { ensureWarmSession, forceRestartWarmSession } from "./warmSession.js";
import { startWooliesHealthSentry } from "./wooliesHealthSentry.js";

const WARM_SESSION_CHANNELS: ChannelKey[] = ["woolworths-ordering"];

// Serializes woolworths-ordering agent turns per channel. This NAS cannot run
// more than one cold Claude Agent SDK session at a time without thrashing
// into swap -- confirmed during deployment when 3 near-simultaneous messages
// spawned 3 concurrent sibling containers and all 3 timed out without a
// single reply. Doesn't fix the underlying RAM limit or make anything
// faster; it just stops concurrent sessions competing for it, so a burst of
// messages gets answered in order, one at a time, instead of all thrashing
// together. See CLAUDE.md's discordbot-host section.
const channelTurnQueues = new Map<ChannelKey, Promise<void>>();

function enqueueChannelTurn(channelKey: ChannelKey, turn: () => Promise<void>): Promise<void> {
  const previous = channelTurnQueues.get(channelKey) ?? Promise.resolve();
  // Chain off the previous turn regardless of whether it succeeded or
  // failed, so one bad turn doesn't wedge the queue for this channel forever.
  const run = previous.catch(() => {}).then(turn);
  channelTurnQueues.set(channelKey, run.catch(() => {}));
  return run;
}

function ensureDockerRunning(): void {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10000 });
  } catch {
    throw new Error(
      "Docker is not running. discordbot-host cannot spawn cold sessions without it.",
    );
  }
}

interface SavedAttachment {
  relPath: string;
  absPath: string;
  originalName: string;
}

async function saveIncomingAttachments(message: Message, channelKey: ChannelKey): Promise<SavedAttachment[]> {
  const images = [...message.attachments.values()].filter((a) => a.contentType?.startsWith("image/"));
  if (images.length === 0) return [];

  const incomingDir = path.join(WORKSPACES_DIR, channelKey, "incoming");
  mkdirSync(incomingDir, { recursive: true });

  const saved: SavedAttachment[] = [];
  for (const att of images) {
    try {
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const originalName = att.name || "photo";
      const filename = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const absPath = path.join(incomingDir, filename);
      writeFileSync(absPath, buf);
      saved.push({ relPath: `incoming/${filename}`, absPath, originalName });
    } catch (err) {
      logger.error("Failed to download attachment", { channelKey, err: String(err) });
    }
  }
  return saved;
}

// #order-import is a pure relay, for both photos and text: everything here
// calls a staples-host tool directly and relays its structured result back
// to Discord. No cold session, no agent, no Claude reasoning anywhere in
// this path -- all receipt/order-processing logic (vision extraction, text
// extraction, fuzzy-matching, recording) lives entirely in staples-host, so
// the identical capability stays triggerable from any other front end via
// the same staples-host tools. See CLAUDE.md's order-import section.
async function handleOrderImportMessage(
  content: string,
  savedFiles: SavedAttachment[],
  receivedAt: number,
): Promise<void> {
  for (const file of savedFiles) {
    try {
      const result = await ingestReceiptPhoto(file.absPath, file.originalName);
      await sendChannelMessage("order-import", formatIngestResult(result));
      logger.info("Photo ingested", { channelKey: "order-import", elapsedMs: Date.now() - receivedAt });
    } catch (err) {
      logger.error("ingest_receipt failed", { channelKey: "order-import", err: String(err) });
      await sendChannelMessage("order-import", `Couldn't process that receipt photo: ${String(err)}`).catch(() => {});
    }
  }

  if (!content) return;

  try {
    const result = await ingestOrderText(content);
    await sendChannelMessage("order-import", formatIngestResult(result));
    logger.info("Order text ingested", { channelKey: "order-import", elapsedMs: Date.now() - receivedAt });
  } catch (err) {
    logger.error("ingest_order_text failed", { channelKey: "order-import", err: String(err) });
    await sendChannelMessage("order-import", `Couldn't process that order text: ${String(err)}`).catch(() => {});
  }
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const channelKey = getChannelKeyForId(message.channelId);
  if (!channelKey) return; // not one of the two channels we watch

  const content = (message.content || "").trim();
  const savedFiles = await saveIncomingAttachments(message, channelKey);
  if (!content && savedFiles.length === 0) return;

  const receivedAt = Date.now();
  logger.info("Processing message", { channelKey, channelId: message.channelId });
  await sendChannelMessage(channelKey, "I am looking into that").catch((err) =>
    logger.error("Failed to send acknowledgment", { err: String(err) }),
  );

  if (channelKey === "order-import") {
    await handleOrderImportMessage(content, savedFiles, receivedAt);
    return;
  }

  // Only woolworths-ordering reaches a cold session at this point. Queued per
  // channel (see enqueueChannelTurn above) -- the session-ID read/save and
  // reply/proposal handling all happen inside the queued turn so a later
  // message can never read a stale session ID from one still in flight.
  const promptParts = [
    `Message from ${message.author.username} at ${nzTimestamp()} (NZ local time; message_id=${message.id}):`,
    content || "(no text content)",
  ];
  if (savedFiles.length > 0) {
    promptParts.push(`Attached image file(s) saved at: ${savedFiles.map((f) => f.relPath).join(", ")}`);
  }
  const prompt = promptParts.join("\n\n");

  await enqueueChannelTurn(channelKey, async () => {
    const sessionId = getSessionId(channelKey);
    const output = await runAgent(channelKey, prompt, sessionId);

    if (output.newSessionId) {
      saveSessionId(channelKey, output.newSessionId);
    }

    if (output.status === "error") {
      logger.error("Container agent error", { channelKey, error: output.error, elapsedMs: Date.now() - receivedAt });
      await sendChannelMessage(channelKey, `Something went wrong: ${output.error}`).catch(() => {});
      return;
    }

    if (output.result) {
      await sendChannelMessage(channelKey, output.result);
      logger.info("Reply sent", { channelKey, elapsedMs: Date.now() - receivedAt });
    }

    const proposal = takeProposedAction(channelKey);
    if (proposal) {
      await postAndTrackAction(message.channelId, proposal.summary, proposal.items).catch((err) =>
        logger.error("Failed to post proposed action", { err: String(err) }),
      );
    }
  });
}

// woolworths-ordering is the only channel that can ever reach an agent
// session, cold or warm (order-import is a pure relay, see
// handleOrderImportMessage). Docker is only needed for the cold path, so a
// channel fully switched to warm mode doesn't need it -- but since
// WOOLWORTHS_ORDERING_PERSISTENT_WORKER defaults to false, Docker stays
// required in practice until that flag is flipped on.
function coldPathInUse(): boolean {
  return !isPersistentWorkerEnabled("woolworths-ordering");
}

async function startConfiguredWarmSessions(): Promise<void> {
  for (const channelKey of WARM_SESSION_CHANNELS) {
    if (!isPersistentWorkerEnabled(channelKey)) continue;
    logger.info("Starting warm session at boot", { channelKey });
    const healthy = await ensureWarmSession(channelKey);
    if (!healthy) {
      logger.error(
        "Warm session failed its startup health check -- messages to this channel will fail until it recovers",
        { channelKey },
      );
    }
  }
}

function startWarmSessionRefreshLoop(): void {
  if (WARM_SESSION_REFRESH_INTERVAL_MS <= 0) return;
  for (const channelKey of WARM_SESSION_CHANNELS) {
    if (!isPersistentWorkerEnabled(channelKey)) continue;
    setInterval(() => {
      forceRestartWarmSession(channelKey, "periodic refresh").catch((err) =>
        logger.error("Periodic warm session refresh failed", { channelKey, err: String(err) }),
      );
    }, WARM_SESSION_REFRESH_INTERVAL_MS);
    logger.info("Warm session periodic refresh scheduled", {
      channelKey,
      intervalMs: WARM_SESSION_REFRESH_INTERVAL_MS,
    });
  }
}

async function main(): Promise<void> {
  if (coldPathInUse()) ensureDockerRunning();
  ensureWorkspaceDirs();

  const client = await connectDiscord();

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => logger.error("Message handling failed", { err: String(err) }));
  });

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    handlePendingActionReaction(reaction, user).catch((err) =>
      logger.error("Reaction handling failed", { err: String(err) }),
    );
  });

  startWooliesHealthSentry();
  startNeverTrackedSentry();
  await startConfiguredWarmSessions();
  startWarmSessionRefreshLoop();

  logger.info("discordbot-host running");
}

main().catch((err) => {
  logger.error("Failed to start discordbot-host", { err: String(err) });
  process.exit(1);
});
