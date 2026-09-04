import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  TextChannel,
} from "discord.js";
import { DISCORD_BOT_TOKEN, ORDER_IMPORT_CHANNEL_NAME, WOOLWORTHS_ORDERING_CHANNEL_NAME } from "./config.js";
import { logger } from "./logger.js";
import type { ChannelKey } from "./types.js";

let client: Client | null = null;
const channelIds = new Map<ChannelKey, string>();

export function getDiscordClient(): Client {
  if (!client) throw new Error("Discord client not connected yet");
  return client;
}

export function getChannelId(key: ChannelKey): string | undefined {
  return channelIds.get(key);
}

export function getChannelKeyForId(channelId: string): ChannelKey | undefined {
  for (const [key, id] of channelIds) {
    if (id === channelId) return key;
  }
  return undefined;
}

// Both channels already exist in the Discord server -- resolved by name at
// startup, never created. See CLAUDE.md's discordbot-host Trigger section.
async function resolveChannels(c: Client): Promise<void> {
  const wanted: [ChannelKey, string][] = [
    ["woolworths-ordering", WOOLWORTHS_ORDERING_CHANNEL_NAME],
    ["order-import", ORDER_IMPORT_CHANNEL_NAME],
  ];

  for (const guild of c.guilds.cache.values()) {
    const channels = await guild.channels.fetch();
    for (const [key, name] of wanted) {
      if (channelIds.has(key)) continue;
      const match = channels.find(
        (ch) => ch !== null && ch.isTextBased() && !ch.isThread() && ch.name === name,
      );
      if (match) {
        channelIds.set(key, match.id);
        logger.info("Resolved channel", { key, name, channelId: match.id, guild: guild.name });
      }
    }
  }

  for (const [key, name] of wanted) {
    if (!channelIds.has(key)) {
      throw new Error(
        `Channel "#${name}" not found in any guild this bot is in. It must already ` +
          `exist -- discordbot-host never creates channels.`,
      );
    }
  }
}

export async function connectDiscord(): Promise<Client> {
  const c = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User],
  });

  await new Promise<void>((resolve, reject) => {
    c.once(Events.ClientReady, () => resolve());
    c.once(Events.Error, reject);
    c.login(DISCORD_BOT_TOKEN).catch(reject);
  });

  logger.info("Discord client ready", { user: c.user?.tag });
  await resolveChannels(c);

  client = c;
  return c;
}

export async function sendChannelMessage(channelKey: ChannelKey, content: string): Promise<void> {
  const c = getDiscordClient();
  const channelId = getChannelId(channelKey);
  if (!channelId) {
    logger.error("Cannot send message: channel not resolved", { channelKey });
    return;
  }
  const channel = await c.channels.fetch(channelId);
  if (!channel || !(channel instanceof TextChannel) || !channel.isSendable()) {
    logger.error("Channel not found or not sendable", { channelKey, channelId });
    return;
  }
  const truncated = content.length > 2000 ? `${content.slice(0, 1980)}\n...(truncated)` : content;
  await channel.send(truncated);
}
