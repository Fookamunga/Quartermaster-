import path from "node:path";
import type {
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { DATA_DIR, STAPLES_HOST_URL } from "./config.js";
import { getChannelKeyForId, getDiscordClient } from "./discord.js";
import { loadJson, saveJson } from "./jsonStore.js";
import { logger } from "./logger.js";
import { callTool, toolResultText } from "./mcpClient.js";
import type { CandidateOption } from "./types.js";

// Single-item disambiguation flow only (e.g. "add milk") -- one reaction per
// candidate staples-host returned, generalizing the same tick/decline
// reaction-confirm pattern pendingActions.ts already uses for the weekly
// staples-order nudge. Recipe/multi-item shopping-list replies are
// explicitly out of scope: a longer list, especially one covering several
// ingredients each with their own candidate set, would render as an
// unusable wall of reactions on a phone screen -- those stay on the
// existing typed-reply flow untouched.
//
// Reaction assignment is role-based, not positional -- a real rendering bug
// (confirmed live, message 1546641091296497794) numbered every candidate
// uniformly, including top_pick and best_value, when only the plain
// other_candidates should ever get a number:
//   top_pick         -> ✅ only, never a number
//   other_candidates -> 1️⃣.. up to MAX_OTHER_CANDIDATES, in order
//   best_value       -> 💰 only, never a number -- and never omitted just
//                        because it duplicates another entry's sku (that
//                        entry is represented by top_pick/best_value's own
//                        field instead, see types.ts)
//   decline          -> ❌, always
// Max reactions on one message: ✅ + 5 numbered + 💰 + ❌ = 8. This is a
// relabeling of which emoji goes on which line, not a change to how many
// slots exist -- MAX_OTHER_CANDIDATES already matches suggest_alternatives'
// own MAX_CANDIDATES cap on other_candidates, so hitting more than 5 there
// should not happen in normal operation; it's a defensive guard, not a
// commonly-hit fallback trigger.
export const MAX_OTHER_CANDIDATES = 5;

const CHECK_EMOJI = "✅";
const MONEY_EMOJI = "💰";
export const DECLINE_EMOJI = "❌"; // x -- same meaning as pendingActions.ts's own

// Standard Discord keycap number emoji, 1-5 -- covers MAX_OTHER_CANDIDATES
// exactly. Index i corresponds to otherCandidates[i].
const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

const PENDING_FILE = path.join(DATA_DIR, "pending-candidate-reactions.json");
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000; // matches pendingActions.ts

interface PendingCandidates {
  channelId: string;
  topPick: CandidateOption | null;
  otherCandidates: CandidateOption[];
  bestValue: CandidateOption | null;
  action: "add" | "remove";
  createdAt: string;
}

type PendingCandidatesStore = Record<string, PendingCandidates>;

function load(): PendingCandidatesStore {
  return loadJson<PendingCandidatesStore>(PENDING_FILE, {});
}

function save(store: PendingCandidatesStore): void {
  saveJson(PENDING_FILE, store);
}

/**
 * Posts the candidate summary, attaches ✅ (if topPick given), one numbered
 * reaction per otherCandidates entry (in order, so they render in the same
 * order the summary text lists them), 💰 (if bestValue given), and a
 * decline reaction -- then tracks the message for handleCandidateReaction to
 * act on. Truncates otherCandidates to MAX_OTHER_CANDIDATES defensively
 * (logging a warning) rather than trusting the caller never to exceed it --
 * see this file's header comment for why that should be rare in practice.
 *
 * `action` defaults to "add" -- every call site written before the removal-
 * confirmation flow existed omits it and keeps behaving identically.
 */
export async function postAndTrackCandidates(
  channelId: string,
  summary: string,
  topPick: CandidateOption | null,
  otherCandidates: CandidateOption[],
  bestValue: CandidateOption | null,
  action: "add" | "remove" = "add",
): Promise<{ messageId: string }> {
  let truncated = otherCandidates;
  if (otherCandidates.length > MAX_OTHER_CANDIDATES) {
    logger.error("candidate-options.json exceeded MAX_OTHER_CANDIDATES -- truncating", {
      channelId,
      received: otherCandidates.length,
      max: MAX_OTHER_CANDIDATES,
    });
    truncated = otherCandidates.slice(0, MAX_OTHER_CANDIDATES);
  }

  const client = getDiscordClient();
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) {
    throw new Error(`Channel ${channelId} not found or not sendable`);
  }

  const truncatedSummary = summary.length > 2000 ? `${summary.slice(0, 1980)}\n...(truncated)` : summary;
  const message = await channel.send(truncatedSummary);

  if (topPick) await message.react(CHECK_EMOJI);
  for (let i = 0; i < truncated.length; i++) {
    await message.react(NUMBER_EMOJI[i]);
  }
  if (bestValue) await message.react(MONEY_EMOJI);
  await message.react(DECLINE_EMOJI);

  const pending = load();
  pending[message.id] = {
    channelId,
    topPick,
    otherCandidates: truncated,
    bestValue,
    action,
    createdAt: new Date().toISOString(),
  };
  save(pending);

  logger.info("Candidate options posted and tracked", {
    messageId: message.id,
    channelId,
    action,
    hasTopPick: !!topPick,
    otherCount: truncated.length,
    hasBestValue: !!bestValue,
  });
  return { messageId: message.id };
}

export async function handleCandidateReaction(
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
  const numberIndex = emojiName ? NUMBER_EMOJI.indexOf(emojiName) : -1;
  const isRecognized =
    numberIndex !== -1 || emojiName === CHECK_EMOJI || emojiName === MONEY_EMOJI || emojiName === DECLINE_EMOJI;
  if (!isRecognized) return;

  const messageId = reaction.message.id;
  const pending = load();
  const entry = pending[messageId];
  if (!entry) return;

  // Reactions only ever land on messages this codebase itself posted for
  // this flow (all in woolworths-ordering, per postAndTrackCandidates'
  // only caller) -- confirm that rather than trusting the pending store
  // blindly, same defensive check pendingActions.ts's own handler uses.
  if (getChannelKeyForId(entry.channelId) !== "woolworths-ordering") {
    logger.error("Pending candidate reaction for unexpected channel", { messageId, channelId: entry.channelId });
    return;
  }

  let message: Message = reaction.message as Message;
  try {
    if (message.partial) message = await message.fetch();
  } catch (err) {
    logger.error("Failed to fetch partial message for candidate reaction", { err: String(err), messageId });
    return;
  }

  const ageMs = Date.now() - new Date(entry.createdAt).getTime();
  if (ageMs > MAX_PENDING_AGE_MS) {
    delete pending[messageId];
    save(pending);
    logger.info("Ignoring reaction on expired candidate options", { messageId, ageMs });
    return;
  }

  // action defaults to "add" for entries persisted before this field existed
  // (none should remain in practice -- pending entries don't survive a
  // restart across a deploy that changes the shape -- but never crash on an
  // old record instead of treating it as "add", the same default the type
  // itself uses).
  const action = entry.action ?? "add";

  if (emojiName === DECLINE_EMOJI) {
    delete pending[messageId];
    save(pending);
    const declineVerb = action === "remove" ? "removed from" : "added to";
    await message.reply(`Skipped — nothing was ${declineVerb} the cart.`).catch((err) =>
      logger.error("Failed to send decline confirmation", { err: String(err), messageId }),
    );
    return;
  }

  const chosen =
    emojiName === CHECK_EMOJI ? entry.topPick : emojiName === MONEY_EMOJI ? entry.bestValue : entry.otherCandidates[numberIndex];
  if (!chosen) return; // e.g. ✅ reacted on a message with no topPick -- shouldn't happen since the reaction wasn't attached, but never guess

  // Executing on a reaction is a plain host-side MCP call to staples-host's
  // own set_cart_quantity tool, not a fresh Claude invocation -- the
  // decision was already made by the reaction, nothing left to reason
  // about. Reuses the same tool the typed-reply flow calls (via the
  // agent), not a separate cart-write code path -- staples-host resolves
  // the purchasing unit itself, so no pricingUnit is needed here. quantity
  // is the only thing that differs between add and remove: 1 to add
  // (unchanged from before this field existed), 0 to remove the line
  // entirely (set_cart_quantity's own "0 removes it" semantics).
  const quantity = action === "remove" ? 0 : 1;
  const verbPast = action === "remove" ? "Removed from cart" : "Added to cart";
  const verbInfinitive = action === "remove" ? "remove" : "add";

  try {
    const result = await callTool("discordbot-candidate-reactions", STAPLES_HOST_URL, "set_cart_quantity", {
      sku: chosen.sku,
      quantity,
    });
    if (result.isError) {
      throw new Error(toolResultText(result));
    }
    delete pending[messageId];
    save(pending);
    await message.reply(`${verbPast}: ${chosen.name}`).catch((err) =>
      logger.error("Failed to send cart-write confirmation", { err: String(err), messageId }),
    );
    logger.info("Candidate reaction confirmed", { messageId, sku: chosen.sku, action });
  } catch (err) {
    logger.error("Failed to set cart quantity for candidate reaction", { err: String(err), messageId, action });
    await message
      .reply(`Failed to ${verbInfinitive} ${chosen.name}${action === "remove" ? " from" : " to"} the cart: ${String(err)}. React the same way again to retry.`)
      .catch(() => {});
    // Leave the pending entry in place so removing + re-adding the reaction
    // can retry rather than silently losing the resolved action -- same
    // retry-on-failure behavior as pendingActions.ts's own handler.
  }
}
