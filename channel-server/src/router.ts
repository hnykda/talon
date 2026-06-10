/**
 * Pure routing logic: decide for each incoming post whether to drop it or
 * forward it to Claude, and what meta to attach. No I/O — fully testable.
 *
 * Rules, in order:
 *  1. ignore the bot's own posts; posts from other bots are dropped unless
 *     the sender is in ALLOWED_BOTS — and then forwarded only from bound
 *     channels on an explicit @-mention (never DMs, never thread-follow,
 *     regardless of CHANNEL_MODE): every step of a bot-to-bot exchange needs
 *     a deliberate mention, which damps reply loops
 *  2. sender gating: drop silently if the sender is not in ALLOWED_USERS
 *     (gate on sender identity, never on channel/room)
 *  3. DM -> forward if DM_ENABLED
 *  4. bound channel + mode=all -> forward
 *  5. bound channel + mode=mention -> forward if the message @-mentions the
 *     bot username, or post.root_id is a thread the bot participates in
 *  6. otherwise drop
 */
import type { ChannelMode } from './config.js';

export interface RouterPost {
  id: string;
  channel_id: string;
  root_id: string;
  message: string;
  user_id: string;
  create_at: number;
  /** Mattermost post type; non-empty means a system post. */
  type?: string;
  props?: Record<string, unknown>;
}

export interface RouterSender {
  id: string;
  username: string;
  isBot: boolean;
}

export interface RouterChannelInfo {
  id: string;
  /** Mattermost channel type: 'D' direct, 'G' group, 'O' public, 'P' private. */
  type: string;
  name: string;
  display_name: string;
}

export interface RouterConfig {
  botUserId: string;
  botUsername: string;
  boundChannelIds: ReadonlySet<string>;
  channelMode: ChannelMode;
  /** Per-channel mode overrides, keyed by resolved channel id. Falls back to channelMode. */
  channelModes?: ReadonlyMap<string, ChannelMode>;
  /** Allowed sender user ids. */
  allowedUserIds: ReadonlySet<string>;
  /** Allowed sender usernames, lowercased. */
  allowedUsernames: ReadonlySet<string>;
  /** Bot senders allowed for agent-to-agent messaging (ids). */
  allowedBotIds?: ReadonlySet<string>;
  /** Bot senders allowed for agent-to-agent messaging (usernames, lowercased). */
  allowedBotUsernames?: ReadonlySet<string>;
  dmEnabled: boolean;
  /** TEST ONLY: treat the bot's own posts as foreign senders (see Config.includeOwnPosts). */
  includeOwnPosts?: boolean;
}

export interface RouterState {
  /** Root post ids of threads the bot participates in. */
  participatingThreads: ReadonlySet<string>;
}

export type RouteDecision =
  | { action: 'drop'; reason: string }
  | { action: 'forward'; meta: Record<string, string> };

/** Word-boundary-ish @-mention check that respects Mattermost username chars (a-z 0-9 . - _). */
export function mentionsUser(message: string, username: string): boolean {
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._-])@${escaped}(?![A-Za-z0-9._-])`, 'i').test(message);
}

function buildMeta(post: RouterPost, sender: RouterSender, channel: RouterChannelInfo, isDm: boolean): Record<string, string> {
  return {
    channel_id: post.channel_id,
    channel_name: isDm ? 'dm' : channel.name || channel.display_name || '',
    root_id: post.root_id ?? '',
    post_id: post.id,
    sender_name: sender.username,
    is_dm: isDm ? 'true' : 'false',
  };
}

export function route(
  post: RouterPost,
  sender: RouterSender,
  channel: RouterChannelInfo,
  config: RouterConfig,
  state: RouterState,
): RouteDecision {
  // 1. own posts and other bots
  const isSelf = sender.id === config.botUserId;
  if (isSelf && !config.includeOwnPosts) return { action: 'drop', reason: 'own_post' };
  const isBotSender =
    !isSelf && (sender.isBot || post.props?.from_bot === 'true' || post.props?.from_bot === true);
  if (isBotSender) {
    const botAllowed =
      config.allowedBotIds?.has(sender.id) ||
      config.allowedBotUsernames?.has(sender.username.toLowerCase());
    if (!botAllowed) return { action: 'drop', reason: 'bot_sender' };
    // Agent-to-agent: ALWAYS mention-gated (regardless of channel mode), no
    // thread-follow, no DMs — each exchange step needs an explicit @-mention,
    // which damps reply loops between bots.
    if (channel.type === 'D') return { action: 'drop', reason: 'bot_dm' };
    if (!config.boundChannelIds.has(channel.id)) return { action: 'drop', reason: 'channel_not_bound' };
    if (post.type) return { action: 'drop', reason: 'system_post' };
    if (!mentionsUser(post.message, config.botUsername)) {
      return { action: 'drop', reason: 'bot_no_mention' };
    }
    return { action: 'forward', meta: { ...buildMeta(post, sender, channel, false), sender_is_bot: 'true' } };
  }
  // system posts (joins, headers changes, ...) are never conversational input
  if (post.type) return { action: 'drop', reason: 'system_post' };

  // 2. sender gating (sender identity, never room)
  const allowed =
    config.allowedUserIds.has(sender.id) || config.allowedUsernames.has(sender.username.toLowerCase());
  if (!allowed) return { action: 'drop', reason: 'sender_not_allowed' };

  // 3. DMs
  const isDm = channel.type === 'D';
  if (isDm) {
    if (!config.dmEnabled) return { action: 'drop', reason: 'dm_disabled' };
    return { action: 'forward', meta: buildMeta(post, sender, channel, true) };
  }

  // 4/5. bound channels only
  if (!config.boundChannelIds.has(channel.id)) return { action: 'drop', reason: 'channel_not_bound' };

  const mode = config.channelModes?.get(channel.id) ?? config.channelMode;
  if (mode === 'all') {
    return { action: 'forward', meta: buildMeta(post, sender, channel, false) };
  }

  // mode = mention
  if (mentionsUser(post.message, config.botUsername)) {
    return { action: 'forward', meta: buildMeta(post, sender, channel, false) };
  }
  if (post.root_id && state.participatingThreads.has(post.root_id)) {
    return { action: 'forward', meta: buildMeta(post, sender, channel, false) };
  }
  return { action: 'drop', reason: 'no_mention_or_thread' };
}
