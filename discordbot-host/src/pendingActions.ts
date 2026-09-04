import path from "node:path";
import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { DATA_DIR, WOOLIES_MCP_URL } from "./config.js";
import { getChannelKeyForId, getDiscordClient } from "./discord.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { logger } from "./logger.js";
import { callTool, toolResultText } from "./mcpClient.js";
import type { PendingActionItem } from "./types.js";

export const CONFIRM_EMOJI = "✅"; // white_check_mark
export const DECLINE_EMOJI = "❌"; // x
const PENDING_ACTIONS_FILE = path.join(DATA_DIR, "pending-actions.json");
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingAction {
  channelId: string;
  items: PendingActionItem[];
  createdAt: string;
}

type PendingActionsStore = Record<string, PendingAction>;

function load(): PendingActionsStore {
  return loadJson<PendingActionsStore>(PENDING_ACTIONS_FILE, {});
}

function save(store: PendingActionsStore): void {
  saveJson(PENDING_ACTIONS_FILE, store);
}

// Posts a proposal, reacts with confirm/decline, and records it as pending --
// all before returning, so by the time this resolves the message is fully
// set up for a human to act on. Only used for woolworths-ordering;
// order-import never proposes (see CLAUDE.md).
export async function postAndTrackAction(
  channelId: string,
  content: string,
  items: PendingActionItem[],
): Promise<{ messageId: string }> {
  const client = getDiscordClient();
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) {
    throw new Error(`Channel ${channelId} not found or not sendable`);
  }

  const truncated = content.length > 2000 ? `${content.slice(0, 1980)}\n...(truncated)` : content;
  const message = await channel.send(truncated);
  await message.react(CONFIRM_EMOJI);
  await message.react(DECLINE_EMOJI);

  const pending = load();
  pending[message.id] = { channelId, items, createdAt: new Date().toISOString() };
  save(pending);

  logger.info("Action proposed and tracked", { messageId: message.id, channelId, itemCount: items.length });
  return { messageId: message.id };
}

export async function handlePendingActionReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  try {
    if (user.partial) user = await user.fetch();
  } catch (err) {
    logger.error("Failed to fetch partial reaction user", { err: String(err) });
    return;
  }
  if (user.bot) return;

  try {
    if (reaction.partial) reaction = await reaction.fetch();
  } catch (err) {
    logger.error("Failed to fetch partial reaction", { err: String(err) });
    return;
  }

  const emojiName = reaction.emoji.name;
  if (emojiName !== CONFIRM_EMOJI && emojiName !== DECLINE_EMOJI) return;

  const messageId = reaction.message.id;
  const pending = load();
  const entry = pending[messageId];
  if (!entry) return;

  // Reactions only ever land on messages this codebase itself posted as a
  // proposal (all in woolworths-ordering, per postAndTrackAction's callers) --
  // confirm that rather than trusting the pending store blindly.
  if (getChannelKeyForId(entry.channelId) !== "woolworths-ordering") {
    logger.error("Pending action for unexpected channel", { messageId, channelId: entry.channelId });
    return;
  }

  let message: Message = reaction.message as Message;
  try {
    if (message.partial) message = await message.fetch();
  } catch (err) {
    logger.error("Failed to fetch partial message for pending action", { err: String(err), messageId });
    return;
  }

  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  if (ageMs > MAX_PENDING_AGE_MS) {
    delete pending[messageId];
    save(pending);
    logger.info("Ignoring reaction on expired pending action", { messageId, ageMs });
    return;
  }

  if (emojiName === DECLINE_EMOJI) {
    delete pending[messageId];
    save(pending);
    await message.reply("Skipped - nothing was added to the cart.").catch((err) =>
      logger.error("Failed to send skip confirmation", { err: String(err), messageId }),
    );
    return;
  }

  // Executing on (checkmark) is a plain host-side MCP call, not a fresh
  // Claude invocation -- the decision was already made, nothing left to
  // reason about. See CLAUDE.md.
  try {
    const result = await callTool("discordbot-pending-actions", WOOLIES_MCP_URL, "set_cart_quantities", {
      items: entry.items.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        pricingUnit: item.pricingUnit,
      })),
    });
    delete pending[messageId];
    save(pending);
    const itemLines = entry.items.map((item) => `• ${item.name || item.sku} x${item.quantity}`).join("\n");
    await message.reply(`Added to cart:\n${itemLines}`).catch((err) =>
      logger.error("Failed to send add-to-cart confirmation", { err: String(err), messageId }),
    );
    logger.info("Pending action confirmed", { messageId, raw: toolResultText(result) });
  } catch (err) {
    logger.error("Failed to set cart quantities for pending action", { err: String(err), messageId });
    await message
      .reply(`Failed to add items to cart: ${String(err)}. React ✅ again to retry.`)
      .catch(() => {});
    // Leave the pending entry in place so removing + re-adding the reaction
    // can retry rather than silently losing the resolved action.
  }
}
