import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Events, type Message } from "discord.js";
import { WORKSPACES_DIR } from "./config.js";
import { ensureWorkspaceDirs, runContainerAgent, takeProposedAction } from "./containerRunner.js";
import { connectDiscord, getChannelKeyForId, sendChannelMessage } from "./discord.js";
import { logger } from "./logger.js";
import { startNeverTrackedSentry } from "./neverTrackedSentry.js";
import { ingestReceiptPhoto } from "./orderImportPhotos.js";
import { formatIngestResult } from "./orderImportRelay.js";
import { ingestOrderText } from "./orderImportText.js";
import { handlePendingActionReaction, postAndTrackAction } from "./pendingActions.js";
import { getSessionId, saveSessionId } from "./sessions.js";
import type { ChannelKey } from "./types.js";
import { startWooliesHealthSentry } from "./wooliesHealthSentry.js";

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

  // Only woolworths-ordering reaches a cold session at this point.
  const promptParts = [
    `Message from ${message.author.username} at ${new Date().toISOString()} (message_id=${message.id}):`,
    content || "(no text content)",
  ];
  if (savedFiles.length > 0) {
    promptParts.push(`Attached image file(s) saved at: ${savedFiles.map((f) => f.relPath).join(", ")}`);
  }
  const prompt = promptParts.join("\n\n");

  const sessionId = getSessionId(channelKey);
  const output = await runContainerAgent(channelKey, prompt, sessionId);

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
}

async function main(): Promise<void> {
  ensureDockerRunning();
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

  logger.info("discordbot-host running");
}

main().catch((err) => {
  logger.error("Failed to start discordbot-host", { err: String(err) });
  process.exit(1);
});
