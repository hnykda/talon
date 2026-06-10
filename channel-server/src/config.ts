/**
 * Configuration loading. Env vars are primary; an optional JSON file
 * (CONFIG_FILE) can override individual keys using the same key names
 * (e.g. {"CHANNEL_MODE": "all", "LISTEN_CHANNELS": ["town-square"]}).
 */
import { readFileSync } from 'node:fs';

export type ChannelMode = 'mention' | 'all';

export interface Config {
  /** Base URL of the Mattermost server, no trailing slash. */
  mmUrl: string;
  /** Bot account access token. */
  botToken: string;
  /** Channel names or ids the agent is bound to. Empty = DMs only. */
  listenChannels: string[];
  /** 'mention': forward channel posts only on @-mention or thread-follow. 'all': forward everything. */
  channelMode: ChannelMode;
  /**
   * Per-channel overrides of channelMode, keyed by the channel ref exactly as
   * given in LISTEN_CHANNELS. Written as a `:mention` / `:all` suffix on the
   * entry, e.g. LISTEN_CHANNELS="work-chan,test-chan:mention" with
   * CHANNEL_MODE=all.
   */
  channelModeOverrides: Record<string, ChannelMode>;
  /** Mattermost usernames or user ids allowed to reach Claude. First entry is the permission-relay admin. */
  allowedUsers: string[];
  /**
   * Bot accounts (usernames or user ids) whose posts may reach Claude —
   * agent-to-agent messaging. Bot senders are ALWAYS mention-gated (their
   * posts forward only when they @-mention this bot, regardless of
   * CHANNEL_MODE, and they never get thread-follow) as a reply-loop damper.
   * Empty (default) = posts from other bots are dropped.
   */
  allowedBots: string[];
  /** Forward DMs from allowed users. */
  dmEnabled: boolean;
  /**
   * TEST ONLY: route the bot's own posts as if they came from a foreign sender
   * (the bot must also be in ALLOWED_USERS). Posts created by THIS instance
   * (reply tool / relay DMs) are always skipped to prevent reply loops.
   * Enables end-to-end testing without a second human/bot account.
   */
  includeOwnPosts: boolean;
  /** Path to the persisted state file. */
  stateFile: string;
  /** Maximum characters per outgoing Mattermost post; longer replies are chunked. */
  postChunkLimit: number;
  /** Show the native "X is typing..." indicator while the agent processes a forwarded message. */
  typingEnabled: boolean;
  /** Hard cap on a single typing run (the agent may never reply; the indicator must self-expire). */
  typingMaxSeconds: number;
  /** Emoji name reacted onto each forwarded post as a pickup ack. Empty = disabled. */
  ackReaction: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const KNOWN_KEYS = [
  'MM_URL',
  'MM_BOT_TOKEN',
  'LISTEN_CHANNELS',
  'CHANNEL_MODE',
  'ALLOWED_USERS',
  'ALLOWED_BOTS',
  'DM_ENABLED',
  'STATE_FILE',
  'POST_CHUNK_LIMIT',
  'INCLUDE_OWN_POSTS',
  'TYPING_INDICATOR',
  'TYPING_MAX_SECONDS',
  'ACK_REACTION',
] as const;

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseBool(value: string | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const s = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new ConfigError(`${key} must be a boolean (got "${value}")`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Partial<Record<(typeof KNOWN_KEYS)[number], string>> = {};
  for (const key of KNOWN_KEYS) {
    const v = env[key];
    if (v !== undefined) raw[key] = v;
  }

  const configFile = env.CONFIG_FILE;
  if (configFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Failed to read CONFIG_FILE "${configFile}": ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`CONFIG_FILE "${configFile}" must contain a JSON object`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(`Unknown key "${key}" in CONFIG_FILE (known keys: ${KNOWN_KEYS.join(', ')})`);
      }
      raw[key as (typeof KNOWN_KEYS)[number]] = Array.isArray(value) ? value.join(',') : String(value);
    }
  }

  const mmUrl = raw.MM_URL?.trim().replace(/\/+$/, '');
  if (!mmUrl) throw new ConfigError('MM_URL is required (e.g. https://mattermost.example.com)');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mmUrl);
  } catch {
    throw new ConfigError(`MM_URL is not a valid URL: "${mmUrl}"`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigError(`MM_URL must use http(s), got "${parsedUrl.protocol}"`);
  }

  const botToken = raw.MM_BOT_TOKEN?.trim();
  if (!botToken) throw new ConfigError('MM_BOT_TOKEN is required');

  const channelModeRaw = (raw.CHANNEL_MODE ?? 'mention').trim().toLowerCase();
  if (channelModeRaw !== 'mention' && channelModeRaw !== 'all') {
    throw new ConfigError(`CHANNEL_MODE must be "mention" or "all" (got "${raw.CHANNEL_MODE}")`);
  }

  // LISTEN_CHANNELS entries may carry a per-channel mode suffix
  // ("<ref>:mention" / "<ref>:all") overriding CHANNEL_MODE for that channel.
  // Mattermost channel names/ids never contain ":", so the split is safe.
  const listenChannels: string[] = [];
  const channelModeOverrides: Record<string, ChannelMode> = {};
  for (const entry of parseList(raw.LISTEN_CHANNELS)) {
    const idx = entry.indexOf(':');
    if (idx === -1) {
      listenChannels.push(entry);
      continue;
    }
    const ref = entry.slice(0, idx).trim();
    const mode = entry.slice(idx + 1).trim().toLowerCase();
    if (!ref || (mode !== 'mention' && mode !== 'all')) {
      throw new ConfigError(
        `LISTEN_CHANNELS entry "${entry}" is invalid: expected "<channel>" or "<channel>:mention|all"`,
      );
    }
    listenChannels.push(ref);
    channelModeOverrides[ref] = mode;
  }

  const allowedUsers = parseList(raw.ALLOWED_USERS);
  if (allowedUsers.length === 0) {
    throw new ConfigError(
      'ALLOWED_USERS must be a non-empty comma-separated list of Mattermost usernames or user ids. ' +
        'It gates every inbound message and its first entry is the permission-relay admin.',
    );
  }

  let postChunkLimit = 4000;
  if (raw.POST_CHUNK_LIMIT !== undefined && raw.POST_CHUNK_LIMIT.trim() !== '') {
    postChunkLimit = Number(raw.POST_CHUNK_LIMIT);
    if (!Number.isInteger(postChunkLimit) || postChunkLimit < 100 || postChunkLimit > 16000) {
      throw new ConfigError(`POST_CHUNK_LIMIT must be an integer between 100 and 16000 (got "${raw.POST_CHUNK_LIMIT}")`);
    }
  }

  let typingMaxSeconds = 120;
  if (raw.TYPING_MAX_SECONDS !== undefined && raw.TYPING_MAX_SECONDS.trim() !== '') {
    typingMaxSeconds = Number(raw.TYPING_MAX_SECONDS);
    if (!Number.isInteger(typingMaxSeconds) || typingMaxSeconds < 5 || typingMaxSeconds > 3600) {
      throw new ConfigError(`TYPING_MAX_SECONDS must be an integer between 5 and 3600 (got "${raw.TYPING_MAX_SECONDS}")`);
    }
  }

  let ackReaction = 'eyes';
  if (raw.ACK_REACTION !== undefined) {
    const v = raw.ACK_REACTION.trim().toLowerCase();
    if (v === '' || v === 'none') {
      ackReaction = '';
    } else if (/^[a-z0-9_+-]+$/.test(v)) {
      ackReaction = v;
    } else {
      throw new ConfigError(`ACK_REACTION must be an emoji name like "eyes" (or "none" to disable; got "${raw.ACK_REACTION}")`);
    }
  }

  return {
    mmUrl,
    botToken,
    listenChannels,
    channelMode: channelModeRaw,
    channelModeOverrides,
    allowedUsers,
    allowedBots: parseList(raw.ALLOWED_BOTS),
    dmEnabled: parseBool(raw.DM_ENABLED, true, 'DM_ENABLED'),
    includeOwnPosts: parseBool(raw.INCLUDE_OWN_POSTS, false, 'INCLUDE_OWN_POSTS'),
    stateFile: raw.STATE_FILE?.trim() || './state.json',
    postChunkLimit,
    typingEnabled: parseBool(raw.TYPING_INDICATOR, true, 'TYPING_INDICATOR'),
    typingMaxSeconds,
    ackReaction,
  };
}
