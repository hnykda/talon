/**
 * Bridge between one Mattermost bot account and one Claude Code session,
 * plus the MCP channel-server wiring per docs/channels-contract.md.
 *
 * - MattermostBridge: identity resolution, catch-up, ws event pipeline,
 *   routing, thread bookkeeping, permission relay over an admin DM.
 * - createChannelServer(): the MCP Server (capabilities, instructions,
 *   tools, notification emission) on top of a bridge.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Notification,
  type Request,
  type Result,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ChannelMode, Config } from './config.js';
import { log } from './log.js';
import {
  MM_ID_RE,
  MattermostClient,
  MattermostError,
  type MMChannel,
  type MMPost,
  type MMUser,
} from './mattermost.js';
import { route, type RouterConfig } from './router.js';
import type { StateStore } from './state.js';
import { TypingManager } from './typing.js';

/** Verdict shape per the channels contract (request ids: 5 lowercase letters, no 'l'). */
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
/** meta keys must be identifiers; everything else is silently dropped by Claude Code. */
const META_KEY_RE = /^[A-Za-z0-9_]+$/;

const PROCESSED_LRU_SIZE = 1000;
const SEARCH_RESULT_CAP = 50;
/** Below the 5000ms client display TTL for user_typing events, so the indicator never flickers. */
const TYPING_REFRESH_MS = 4000;
/**
 * Reacting within ~20ms of the post races the client: reaction_added can
 * arrive before the client finished ingesting the posted event, and the
 * reaction only renders after a later refetch. A short delay makes the ack
 * land visibly on the first render.
 */
const ACK_REACTION_DELAY_MS = 750;

export interface ForwardEvent {
  content: string;
  meta: Record<string, string>;
}

export interface BridgeSink {
  onEvent: (event: ForwardEvent) => void | Promise<void>;
  /** When set, verdict-shaped admin DMs are intercepted and routed here instead of being forwarded as chat. */
  onPermissionVerdict?: (requestId: string, behavior: 'allow' | 'deny') => void | Promise<void>;
}

export interface PermissionRequestParams {
  request_id: string;
  tool_name: string;
  description?: string;
  input_preview?: string;
}

/** Split text into chunks of at most `limit` chars, preferring newline then space boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[ \n]/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function sanitizeMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (META_KEY_RE.test(key)) {
      out[key] = value;
    } else {
      log('warn', `Dropping meta key that is not an identifier: "${key}"`);
    }
  }
  return out;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export class MattermostBridge {
  /** Replaceable event sink. index.ts wires this to MCP notifications; probe.ts to stdout JSON lines. */
  sink: BridgeSink = { onEvent: () => undefined };

  readonly pendingPermissions = new Set<string>();

  private queue: Promise<void> = Promise.resolve();
  private readonly processedIds: string[] = [];
  private readonly processedSet = new Set<string>();
  /** Post ids created by THIS instance (reply tool, relay DMs). Never routed, even with includeOwnPosts. */
  private readonly selfCreatedIds: string[] = [];
  private readonly selfCreatedSet = new Set<string>();
  private readonly typing: TypingManager;

  private constructor(
    readonly config: Config,
    readonly mm: MattermostClient,
    readonly state: StateStore,
    readonly me: MMUser,
    readonly boundChannels: ReadonlyMap<string, MMChannel>,
    readonly routerConfig: RouterConfig,
    readonly admin: MMUser,
    readonly adminDmChannelId: string,
  ) {
    this.typing = new TypingManager((channelId, parentId) => this.mm.sendTyping(channelId, parentId), {
      refreshMs: TYPING_REFRESH_MS,
      maxMs: config.typingMaxSeconds * 1000,
    });
  }

  static async init(config: Config, mm: MattermostClient, state: StateStore): Promise<MattermostBridge> {
    const me = await mm.getMe();
    log('info', `Authenticated as bot @${me.username} (${me.id})`);

    const boundChannels = new Map<string, MMChannel>();
    const channelModes = new Map<string, ChannelMode>();
    for (const ref of config.listenChannels) {
      const channel = await mm.resolveChannel(ref);
      boundChannels.set(channel.id, channel);
      const mode = config.channelModeOverrides[ref] ?? config.channelMode;
      channelModes.set(channel.id, mode);
      log('info', `Bound to channel "${channel.name || channel.display_name}" (${channel.id}, type ${channel.type}, mode ${mode})`);
    }
    if (boundChannels.size === 0) {
      log('info', 'No LISTEN_CHANNELS configured; DMs only');
    }

    // Allowed senders: id-shaped entries gate by id, everything else by username.
    const allowedUserIds = new Set<string>();
    const allowedUsernames = new Set<string>();
    for (const entry of config.allowedUsers) {
      if (MM_ID_RE.test(entry)) allowedUserIds.add(entry);
      else allowedUsernames.add(entry.toLowerCase());
    }
    const allowedBotIds = new Set<string>();
    const allowedBotUsernames = new Set<string>();
    for (const entry of config.allowedBots) {
      if (MM_ID_RE.test(entry)) allowedBotIds.add(entry);
      else allowedBotUsernames.add(entry.toLowerCase());
    }

    // The first ALLOWED_USERS entry is the permission-relay admin.
    const firstEntry = config.allowedUsers[0];
    if (!firstEntry) throw new Error('ALLOWED_USERS is empty (config validation should have caught this)');
    let admin: MMUser;
    if (MM_ID_RE.test(firstEntry)) {
      try {
        admin = await mm.getUser(firstEntry);
      } catch (err) {
        if (err instanceof MattermostError && err.status === 404) {
          admin = await mm.getUserByUsername(firstEntry);
        } else {
          throw err;
        }
      }
    } else {
      admin = await mm.getUserByUsername(firstEntry);
    }
    allowedUserIds.add(admin.id);
    const adminDm = await mm.createDirectChannel(me.id, admin.id);
    log('info', `Permission-relay admin: @${admin.username} (${admin.id}), DM channel ${adminDm.id}`);

    const routerConfig: RouterConfig = {
      botUserId: me.id,
      botUsername: me.username,
      boundChannelIds: new Set(boundChannels.keys()),
      channelMode: config.channelMode,
      channelModes,
      allowedUserIds,
      allowedUsernames,
      allowedBotIds,
      allowedBotUsernames,
      dmEnabled: config.dmEnabled,
      includeOwnPosts: config.includeOwnPosts,
    };

    return new MattermostBridge(config, mm, state, me, boundChannels, routerConfig, admin, adminDm.id);
  }

  /** Catch-up + websocket. Call after the MCP transport is connected. */
  async start(): Promise<void> {
    await this.catchUp();
    this.mm.startWebSocket({
      onPost: (post, hint) => this.enqueuePost(post, hint.channel_type),
      onReconnect: () => {
        this.catchUp().catch((err) => log('error', `Catch-up after reconnect failed: ${(err as Error).message}`));
      },
    });
  }

  stop(): void {
    this.typing.stopAll();
    this.mm.stop();
    this.state.saveNow();
  }

  /** Fetch missed posts per bound channel and process them in order. */
  async catchUp(): Promise<void> {
    for (const [channelId, channel] of this.boundChannels) {
      const since = this.state.getLastSeen(channelId);
      if (since === 0) {
        // First run for this channel: set the watermark to "now" instead of
        // replaying the entire channel history.
        this.state.noteSeen(channelId, Date.now());
        log('info', `Catch-up baseline set for "${channel.name || channelId}" (no prior watermark)`);
        continue;
      }
      try {
        const list = await this.mm.getPostsSince(channelId, since);
        const posts = list.order
          .map((id) => list.posts[id])
          .filter((p): p is MMPost => p !== undefined && p.create_at > since)
          .sort((a, b) => a.create_at - b.create_at);
        if (posts.length > 0) {
          log('info', `Catch-up for "${channel.name || channelId}": processing ${posts.length} missed post(s)`);
        }
        for (const post of posts) this.enqueuePost(post);
      } catch (err) {
        log('error', `Catch-up failed for channel ${channelId}: ${(err as Error).message}`);
      }
    }
  }

  /** Serialize post processing so catch-up and live events stay ordered. */
  enqueuePost(post: MMPost, channelTypeHint?: string): void {
    this.queue = this.queue
      .then(() => this.processPost(post, channelTypeHint))
      .catch((err) => log('error', `Error processing post ${post.id}: ${(err as Error).stack ?? String(err)}`));
  }

  private rememberSelfCreated(id: string): void {
    this.selfCreatedSet.add(id);
    this.selfCreatedIds.push(id);
    if (this.selfCreatedIds.length > 500) {
      const old = this.selfCreatedIds.shift();
      if (old) this.selfCreatedSet.delete(old);
    }
  }

  private rememberProcessed(id: string): void {
    this.processedSet.add(id);
    this.processedIds.push(id);
    while (this.processedIds.length > PROCESSED_LRU_SIZE) {
      const evicted = this.processedIds.shift();
      if (evicted !== undefined) this.processedSet.delete(evicted);
    }
  }

  private async processPost(post: MMPost, channelTypeHint?: string): Promise<void> {
    if (!post.id || this.processedSet.has(post.id)) return;
    this.rememberProcessed(post.id);

    // Advance the catch-up watermark for bound channels regardless of routing outcome.
    if (this.boundChannels.has(post.channel_id)) {
      this.state.noteSeen(post.channel_id, post.create_at);
    }

    // Our own posts: record thread participation (covers replies the agent
    // makes via the reply tool, echoed back over the websocket), then stop —
    // unless INCLUDE_OWN_POSTS (test mode) is on, in which case posts NOT
    // created by this instance fall through to the router.
    if (post.user_id === this.me.id) {
      this.state.addParticipatingThread(post.root_id || post.id);
      if (!this.config.includeOwnPosts || this.selfCreatedSet.has(post.id)) return;
    }

    // Fast path: not a DM (per ws hint) and not a bound channel -> guaranteed drop, skip lookups.
    if (channelTypeHint && channelTypeHint !== 'D' && !this.boundChannels.has(post.channel_id)) return;

    let sender: MMUser;
    let channel: MMChannel;
    try {
      sender = await this.mm.getUser(post.user_id);
      channel = await this.mm.getChannel(post.channel_id);
    } catch (err) {
      log('warn', `Failed to resolve sender/channel for post ${post.id}: ${(err as Error).message}`);
      return;
    }

    // Permission verdicts: verdict-shaped DMs from the admin are intercepted
    // and emitted as permission notifications instead of being forwarded.
    if (this.sink.onPermissionVerdict && channel.type === 'D' && sender.id === this.admin.id) {
      const match = VERDICT_RE.exec(post.message ?? '');
      if (match) {
        const requestId = match[2]!.toLowerCase();
        const behavior = match[1]![0]!.toLowerCase() === 'y' ? 'allow' : 'deny';
        this.pendingPermissions.delete(requestId);
        log('info', `Permission verdict from @${sender.username}: ${behavior} ${requestId}`);
        await this.sink.onPermissionVerdict(requestId, behavior);
        return;
      }
    }

    const decision = route(
      post,
      { id: sender.id, username: sender.username, isBot: sender.is_bot === true },
      channel,
      this.routerConfig,
      { participatingThreads: this.state.participatingThreads },
    );

    if (decision.action === 'drop') {
      log('debug', `Dropped post ${post.id} (${decision.reason})`);
      return;
    }

    // Thread-follow: once a channel post is forwarded (e.g. via @-mention),
    // the bot is engaged in that thread and follow-ups flow without mentions.
    if (channel.type !== 'D') {
      this.state.addParticipatingThread(post.root_id || post.id);
    }

    await this.sink.onEvent({ content: post.message, meta: sanitizeMeta(decision.meta) });
    log('info', `Forwarded post ${post.id} from @${sender.username} in ${channel.type === 'D' ? 'DM' : `"${channel.name}"`}`);

    // Pickup acks, only after a successful emit (a failed emit means the agent
    // never saw the message — no indicator, no reaction). Typing stops on
    // sendReply for this channel or self-expires after typingMaxSeconds; the
    // reaction is permanent ("picked up", not "done"). Catch-up replays take
    // this path too, which is correct: the agent is about to process them.
    if (this.config.typingEnabled) {
      this.typing.start(post.channel_id, post.root_id || '');
    }
    if (this.config.ackReaction) {
      setTimeout(() => {
        this.mm
          .addReaction(this.me.id, post.id, this.config.ackReaction)
          .catch((err) => log('warn', `Ack reaction failed for post ${post.id}: ${(err as Error).message}`));
      }, ACK_REACTION_DELAY_MS).unref();
    }
  }

  // ---------- operations used by the MCP tools ----------

  async sendReply(channelId: string, text: string, rootId?: string): Promise<{ postIds: string[]; rootId: string }> {
    this.typing.stop(channelId); // before the first post, so chunked replies don't race a refresh tick
    const chunks = splitMessage(text, this.config.postChunkLimit);
    const postIds: string[] = [];
    let effectiveRoot = rootId ?? '';
    for (const chunk of chunks) {
      const post = await this.mm.createPost(channelId, chunk, effectiveRoot || undefined);
      this.rememberSelfCreated(post.id);
      postIds.push(post.id);
      // No explicit thread: chunk 2+ threads under the first chunk.
      if (!effectiveRoot) effectiveRoot = post.id;
    }
    if (effectiveRoot) this.state.addParticipatingThread(effectiveRoot);
    return { postIds, rootId: effectiveRoot };
  }

  private async formatPosts(posts: MMPost[], withChannel = false): Promise<string> {
    const lines: string[] = [];
    for (const post of posts) {
      if (post.type) continue; // skip system posts
      let username = post.user_id;
      try {
        username = (await this.mm.getUser(post.user_id)).username;
      } catch {
        /* keep raw id */
      }
      let channelLabel = '';
      if (withChannel) {
        try {
          const ch = await this.mm.getChannel(post.channel_id);
          channelLabel = ` (${ch.type === 'D' ? 'dm' : ch.name || ch.id})`;
        } catch {
          channelLabel = ` (${post.channel_id})`;
        }
      }
      lines.push(`[${formatTime(post.create_at)}]${channelLabel} ${username}: ${post.message}`);
    }
    return lines.length > 0 ? lines.join('\n') : '(no messages)';
  }

  async readChannelHistory(channelRef: string, limit: number, beforePostId?: string): Promise<string> {
    const channel = await this.mm.resolveChannel(channelRef);
    const list = await this.mm.getPostsPage(channel.id, limit, beforePostId);
    const posts = list.order
      .map((id) => list.posts[id])
      .filter((p): p is MMPost => p !== undefined)
      .sort((a, b) => a.create_at - b.create_at);
    return this.formatPosts(posts);
  }

  async readThread(rootId: string): Promise<string> {
    const list = await this.mm.getThread(rootId);
    const posts = Object.values(list.posts).sort((a, b) => a.create_at - b.create_at);
    return this.formatPosts(posts);
  }

  async searchPosts(query: string, channelRef?: string): Promise<string> {
    let teamId: string | undefined;
    let channelId: string | undefined;
    if (channelRef) {
      const channel = await this.mm.resolveChannel(channelRef);
      channelId = channel.id;
      if (channel.team_id) teamId = channel.team_id; // DM channels have an empty team_id
    }
    if (!teamId) {
      const teams = await this.mm.getMyTeams();
      const first = teams[0];
      if (!first) throw new MattermostError('Bot is not a member of any team; cannot search');
      teamId = first.id;
    }
    const list = await this.mm.searchPosts(teamId, query);
    let posts = list.order.map((id) => list.posts[id]).filter((p): p is MMPost => p !== undefined);
    if (channelId) posts = posts.filter((p) => p.channel_id === channelId);
    posts.sort((a, b) => a.create_at - b.create_at);
    if (posts.length > SEARCH_RESULT_CAP) posts = posts.slice(-SEARCH_RESULT_CAP);
    return this.formatPosts(posts, true);
  }

  async sendPermissionRequest(params: PermissionRequestParams): Promise<void> {
    this.pendingPermissions.add(params.request_id);
    const lines = [
      `Claude wants to run \`${params.tool_name}\`${params.description ? `: ${params.description}` : ''}` +
        ` — reply 'yes ${params.request_id}' or 'no ${params.request_id}'`,
    ];
    if (params.input_preview) {
      lines.push('```', params.input_preview, '```');
    }
    const relayPost = await this.mm.createPost(this.adminDmChannelId, lines.join('\n'));
    this.rememberSelfCreated(relayPost.id);
    log('info', `Relayed permission request ${params.request_id} (${params.tool_name}) to @${this.admin.username}`);
  }
}

// ---------- MCP server wiring ----------

/** Custom notifications this server sends, per the channels contract. */
type OutboundNotification =
  | { method: 'notifications/claude/channel'; params: { content: string; meta: Record<string, string> } }
  | { method: 'notifications/claude/channel/permission'; params: { request_id: string; behavior: 'allow' | 'deny' } };

const PermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z
    .object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string().optional(),
      input_preview: z.string().optional(),
    })
    .passthrough(),
});

const ReplyArgs = z.object({
  channel_id: z.string().min(1),
  text: z.string().min(1),
  root_id: z.string().optional(),
});

const HistoryArgs = z.object({
  channel_id: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  before_post_id: z.string().optional(),
});

const ThreadArgs = z.object({ root_id: z.string().min(1) });

const SearchArgs = z.object({
  query: z.string().min(1),
  channel_id: z.string().optional(),
});

const TOOLS: Tool[] = [
  {
    name: 'reply',
    description:
      'Post a reply to a Mattermost channel or DM. Always pass the channel_id from the incoming event, and ' +
      'root_id (the incoming root_id, or the incoming post_id when root_id is empty) so the reply lands in the ' +
      'correct thread. Long messages are split into multiple posts automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id from the incoming <channel> event meta.' },
        text: { type: 'string', description: 'Message text in Mattermost-flavored markdown.' },
        root_id: {
          type: 'string',
          description: 'Thread root post id: the incoming root_id, or the incoming post_id if root_id was empty.',
        },
      },
      required: ['channel_id', 'text'],
    },
  },
  {
    name: 'read_channel_history',
    description:
      'Read recent messages from a channel (formatted as "[time] user: text", oldest first). ' +
      'Use before_post_id to page further back.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel id (or channel name).' },
        limit: { type: 'number', description: 'Number of messages, 1-200. Default 50.' },
        before_post_id: { type: 'string', description: 'Only return messages older than this post id.' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'read_thread',
    description: 'Read the full thread for a root post id (oldest first).',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { type: 'string', description: 'Root post id of the thread.' },
      },
      required: ['root_id'],
    },
  },
  {
    name: 'search_posts',
    description:
      'Search Mattermost posts (server-side search; supports modifiers like from: and in:). ' +
      'Optionally restrict results to one channel.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        channel_id: { type: 'string', description: 'Restrict results to this channel id (or name).' },
      },
      required: ['query'],
    },
  },
];

function buildInstructions(botUsername: string): string {
  return [
    `You are connected to Mattermost as the bot @${botUsername} through this channel server.`,
    '',
    'Incoming Mattermost messages arrive as channel events that look like:',
    '<channel source="mattermost" channel_id=".." channel_name=".." root_id=".." post_id=".." sender_name=".." is_dm="..">message text</channel>',
    '',
    'Rules:',
    '- ALWAYS respond to a channel event by calling the `reply` tool, passing the SAME channel_id from the event.',
    '- ALWAYS pass root_id to `reply`: use the incoming root_id, or the incoming post_id if root_id is empty.',
    '  This keeps the conversation in its thread — never reply outside the thread.',
    '- Write replies in Mattermost-flavored markdown (code blocks, tables, lists and @mentions are supported).',
    '- Use read_channel_history, read_thread or search_posts when you need more context before answering.',
    '- Never echo the <channel ...> tag syntax back to users.',
  ].join('\n');
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Build the MCP server on top of a bridge and wire the bridge sink to emit
 * channel/permission notifications. Connect the returned server to a
 * StdioServerTransport BEFORE calling bridge.start().
 */
export function createChannelServer(bridge: MattermostBridge): Server<Request, OutboundNotification, Result> {
  const server = new Server<Request, OutboundNotification, Result>(
    { name: 'mattermost', version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions: buildInstructions(bridge.me.username),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case 'reply': {
          const a = ReplyArgs.parse(args);
          const result = await bridge.sendReply(a.channel_id, a.text, a.root_id);
          return textResult(
            `Posted ${result.postIds.length} message(s) to ${a.channel_id}` +
              (result.rootId ? ` (thread root: ${result.rootId})` : ''),
          );
        }
        case 'read_channel_history': {
          const a = HistoryArgs.parse(args);
          return textResult(await bridge.readChannelHistory(a.channel_id, a.limit ?? 50, a.before_post_id));
        }
        case 'read_thread': {
          const a = ThreadArgs.parse(args);
          return textResult(await bridge.readThread(a.root_id));
        }
        case 'search_posts': {
          const a = SearchArgs.parse(args);
          return textResult(await bridge.searchPosts(a.query, a.channel_id));
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
          : (err as Error).message;
      log('warn', `Tool ${name} failed: ${message}`);
      return errorResult(`Error: ${message}`);
    }
  });

  // Outbound permission requests (Claude Code -> server -> admin DM).
  server.setNotificationHandler(PermissionRequestNotificationSchema, async (notification) => {
    const { request_id, tool_name, description, input_preview } = notification.params;
    try {
      await bridge.sendPermissionRequest({ request_id, tool_name, description, input_preview });
    } catch (err) {
      log('error', `Failed to relay permission request ${request_id}: ${(err as Error).message}`);
    }
  });

  bridge.sink = {
    onEvent: async (event) => {
      try {
        await server.notification({ method: 'notifications/claude/channel', params: event });
      } catch (err) {
        log('error', `Failed to emit channel notification: ${(err as Error).message}`);
      }
    },
    onPermissionVerdict: async (requestId, behavior) => {
      try {
        await server.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: requestId, behavior },
        });
      } catch (err) {
        log('error', `Failed to emit permission verdict ${requestId}: ${(err as Error).message}`);
      }
    },
  };

  return server;
}
