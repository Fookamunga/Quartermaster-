import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Events, type Message } from "discord.js";
import { WORKSPACES_DIR } from "./config.js";
import { ensureWorkspaceDirs, runContainerAgent, takeProposedAction } from "./containerRunner.js";
import { connectDiscord, getChannelKeyForId, sendChannelMessage } from "./discord.js";
import { logger } from "./logger.js";
import { startNeverTrackedSentry } from "./neverTrackedSentry.js";
import { formatIngestReceiptResult, ingestReceiptPhoto } from "./orderImportPhotos.js";
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

  // order-import photos relay straight to staples-host's ingest_receipt --
  // no cold session, no agent reasoning. All receipt-processing logic
  // (vision extraction, fuzzy-matching, recording) lives entirely in
  // staples-host; this is pure plumbing, not something Claude needs to be
  // in the loop for. Replaces an earlier design where the cold session's
  // own agent base64-encoded the file and called the tool itself, which
  // broke at realistic photo sizes. See CLAUDE.md's order-import section.
  if (channelKey === "order-import" && savedFiles.length > 0) {
    for (const file of savedFiles) {
      try {
        const result = await ingestReceiptPhoto(file.absPath, file.originalName);
        await sendChannelMessage(channelKey, formatIngestReceiptResult(result));
        logger.info("Photo ingested", { channelKey, elapsedMs: Date.now() - receivedAt });
      } catch (err) {
        logger.error("ingest_receipt failed", { channelKey, err: String(err) });
        await sendChannelMessage(channelKey, `Couldn't process that receipt photo: ${String(err)}`).catch(() => {});
      }
    }
    if (!content) return; // nothing text-based left to hand to a cold session
  }

  const promptParts = [
    `Message from ${message.author.username} at ${new Date().toISOString()} (message_id=${message.id}):`,
    content || "(no text content)",
  ];
  if (savedFiles.length > 0 && channelKey !== "order-import") {
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

  // Only woolworths-ordering uses the propose/confirm flow -- order-import
  // executes record_purchase/ingest_receipt directly, no proposal file to
  // check for. See CLAUDE.md.
  if (channelKey === "woolworths-ordering") {
    const proposal = takeProposedAction(channelKey);
    if (proposal) {
      await postAndTrackAction(message.channelId, proposal.summary, proposal.items).catch((err) =>
        logger.error("Failed to post proposed action", { err: String(err) }),
      );
    }
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
