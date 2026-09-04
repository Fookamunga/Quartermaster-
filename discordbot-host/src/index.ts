import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Events, type Message } from "discord.js";
import { WORKSPACES_DIR } from "./config.js";
import { ensureWorkspaceDirs, runContainerAgent, takeProposedAction } from "./containerRunner.js";
import { connectDiscord, getChannelKeyForId, sendChannelMessage } from "./discord.js";
import { logger } from "./logger.js";
import { startNeverTrackedSentry } from "./neverTrackedSentry.js";
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

async function saveIncomingAttachments(message: Message, channelKey: ChannelKey): Promise<string[]> {
  const images = [...message.attachments.values()].filter((a) => a.contentType?.startsWith("image/"));
  if (images.length === 0) return [];

  const incomingDir = path.join(WORKSPACES_DIR, channelKey, "incoming");
  mkdirSync(incomingDir, { recursive: true });

  const saved: string[] = [];
  for (const att of images) {
    try {
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${Date.now()}-${(att.name || "photo").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      writeFileSync(path.join(incomingDir, filename), buf);
      saved.push(`incoming/${filename}`);
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

  const timestamp = new Date().toISOString();
  const promptParts = [
    `Message from ${message.author.username} at ${timestamp} (message_id=${message.id}):`,
    content || "(no text content)",
  ];
  if (savedFiles.length > 0) {
    promptParts.push(`Attached image file(s) saved at: ${savedFiles.join(", ")}`);
  }
  const prompt = promptParts.join("\n\n");

  logger.info("Processing message", { channelKey, channelId: message.channelId });
  await sendChannelMessage(channelKey, "I am looking into that").catch((err) =>
    logger.error("Failed to send acknowledgment", { err: String(err) }),
  );

  const sessionId = getSessionId(channelKey);
  const output = await runContainerAgent(channelKey, prompt, sessionId);

  if (output.newSessionId) {
    saveSessionId(channelKey, output.newSessionId);
  }

  if (output.status === "error") {
    logger.error("Container agent error", { channelKey, error: output.error });
    await sendChannelMessage(channelKey, `Something went wrong: ${output.error}`).catch(() => {});
    return;
  }

  if (output.result) {
    await sendChannelMessage(channelKey, output.result);
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
