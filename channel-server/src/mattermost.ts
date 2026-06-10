/**
 * Mattermost API v4 client: REST via fetch, realtime via WebSocket (ws).
 * All logging goes to stderr via log().
 */
import WebSocket from 'ws';
import { log } from './log.js';

export interface MMUser {
  id: string;
  username: string;
  is_bot?: boolean;
}

export interface MMTeam {
  id: string;
  name: string;
}

export interface MMChannel {
  id: string;
  type: string; // 'D' | 'G' | 'O' | 'P'
  name: string;
  display_name: string;
  team_id: string;
}

export interface MMPost {
  id: string;
  channel_id: string;
  root_id: string;
  message: string;
  user_id: string;
  create_at: number;
  type?: string;
  props?: Record<string, unknown>;
}

export interface MMPostList {
  order: string[];
  posts: Record<string, MMPost>;
}

export interface PostedEventHint {
  channel_type?: string;
}

export interface WsHandlers {
  onPost: (post: MMPost, hint: PostedEventHint) => void;
  /** Called after every successful re-connect (not the first connect). */
  onReconnect: () => void;
}

export const MM_ID_RE = /^[a-z0-9]{26}$/;

export class MattermostError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MattermostError';
  }
}

export class MattermostClient {
  private readonly userCache = new Map<string, MMUser>();
  private readonly channelCache = new Map<string, MMChannel>();
  private ws: WebSocket | undefined;
  private wsStopped = false;
  private wsAttempt = 0;
  private wsEverConnected = false;
  private wsSeq = 1;
  private wsAuthenticated = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  // ---------- REST ----------

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new MattermostError(`${method} ${path}: network error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { message?: string };
        if (typeof j.message === 'string') detail = j.message;
      } catch {
        /* non-JSON error body */
      }
      throw new MattermostError(`${method} ${path}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`, res.status);
    }
    return (await res.json()) as T;
  }

  getMe(): Promise<MMUser> {
    return this.request<MMUser>('GET', '/users/me');
  }

  async getUser(userId: string): Promise<MMUser> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    const user = await this.request<MMUser>('GET', `/users/${userId}`);
    this.userCache.set(userId, user);
    return user;
  }

  async getUserByUsername(username: string): Promise<MMUser> {
    const user = await this.request<MMUser>('GET', `/users/username/${encodeURIComponent(username)}`);
    this.userCache.set(user.id, user);
    return user;
  }

  getMyTeams(): Promise<MMTeam[]> {
    return this.request<MMTeam[]>('GET', '/users/me/teams');
  }

  async getChannel(channelId: string): Promise<MMChannel> {
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;
    const channel = await this.request<MMChannel>('GET', `/channels/${channelId}`);
    this.channelCache.set(channelId, channel);
    return channel;
  }

  async getChannelByName(teamId: string, name: string): Promise<MMChannel> {
    const channel = await this.request<MMChannel>(
      'GET',
      `/teams/${teamId}/channels/name/${encodeURIComponent(name)}`,
    );
    this.channelCache.set(channel.id, channel);
    return channel;
  }

  /**
   * Resolve a channel reference that may be an id or a channel name.
   * Id-shaped refs are tried as ids first, then as names across the
   * bot's teams.
   */
  async resolveChannel(nameOrId: string): Promise<MMChannel> {
    if (MM_ID_RE.test(nameOrId)) {
      try {
        return await this.getChannel(nameOrId);
      } catch (err) {
        if (!(err instanceof MattermostError && (err.status === 404 || err.status === 403))) throw err;
      }
    }
    const teams = await this.getMyTeams();
    for (const team of teams) {
      try {
        return await this.getChannelByName(team.id, nameOrId);
      } catch (err) {
        if (!(err instanceof MattermostError && (err.status === 404 || err.status === 403))) throw err;
      }
    }
    throw new MattermostError(`Channel not found (as id or name in any of the bot's teams): ${nameOrId}`);
  }

  createPost(channelId: string, message: string, rootId?: string): Promise<MMPost> {
    return this.request<MMPost>('POST', '/posts', {
      body: { channel_id: channelId, message, ...(rootId ? { root_id: rootId } : {}) },
    });
  }

  /** Posts created/updated after `since` (ms epoch). */
  getPostsSince(channelId: string, since: number): Promise<MMPostList> {
    return this.request<MMPostList>('GET', `/channels/${channelId}/posts`, { query: { since } });
  }

  /** One page of channel history, newest first; optionally before a given post id. */
  getPostsPage(channelId: string, perPage: number, beforePostId?: string): Promise<MMPostList> {
    return this.request<MMPostList>('GET', `/channels/${channelId}/posts`, {
      query: { per_page: perPage, before: beforePostId },
    });
  }

  getThread(rootId: string): Promise<MMPostList> {
    return this.request<MMPostList>('GET', `/posts/${rootId}/thread`);
  }

  searchPosts(teamId: string, terms: string): Promise<MMPostList> {
    return this.request<MMPostList>('POST', `/teams/${teamId}/posts/search`, {
      body: { terms, is_or_search: false },
    });
  }

  createDirectChannel(userIdA: string, userIdB: string): Promise<MMChannel> {
    return this.request<MMChannel>('POST', '/channels/direct', { body: [userIdA, userIdB] });
  }

  /** React to a post (emojiName without colons, e.g. "eyes"). */
  async addReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    await this.request('POST', '/reactions', {
      body: { user_id: userId, post_id: postId, emoji_name: emojiName, create_at: 0 },
    });
  }

  // ---------- WebSocket ----------

  startWebSocket(handlers: WsHandlers): void {
    this.wsStopped = false;
    this.connectWs(handlers);
  }

  private connectWs(handlers: WsHandlers): void {
    if (this.wsStopped) return;
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
    log('info', `WebSocket connecting (attempt ${this.wsAttempt + 1})`);
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.wsSeq = 1;
      this.wsAuthenticated = false;
      ws.send(JSON.stringify({ seq: this.wsSeq++, action: 'authentication_challenge', data: { token: this.token } }));
    });

    ws.on('message', (raw) => {
      let msg: { event?: string; data?: Record<string, unknown>; status?: string; seq_reply?: number };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.status === 'FAIL' && msg.seq_reply !== undefined) {
        log('debug', `WebSocket request seq ${msg.seq_reply} failed: ${JSON.stringify(msg.data ?? {})}`);
        return;
      }
      if (msg.event === 'hello') {
        log('info', 'WebSocket authenticated');
        this.wsAttempt = 0;
        this.wsAuthenticated = true;
        if (this.wsEverConnected) {
          try {
            handlers.onReconnect();
          } catch (err) {
            log('error', `onReconnect handler failed: ${(err as Error).message}`);
          }
        }
        this.wsEverConnected = true;
        return;
      }
      if (msg.event === 'posted' && msg.data && typeof msg.data.post === 'string') {
        let post: MMPost;
        try {
          post = JSON.parse(msg.data.post) as MMPost;
        } catch (err) {
          log('warn', `Failed to parse posted event payload: ${(err as Error).message}`);
          return;
        }
        const hint: PostedEventHint = {
          channel_type: typeof msg.data.channel_type === 'string' ? msg.data.channel_type : undefined,
        };
        try {
          handlers.onPost(post, hint);
        } catch (err) {
          log('error', `onPost handler failed: ${(err as Error).message}`);
        }
      }
    });

    // Heartbeat: ping every 30s, terminate if no pong before the next ping.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        log('warn', 'WebSocket heartbeat timeout; terminating connection');
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);
    this.heartbeatTimer.unref();

    ws.on('error', (err) => {
      log('warn', `WebSocket error: ${err.message}`);
    });

    ws.on('close', (code) => {
      this.wsAuthenticated = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.wsStopped) return;
      this.wsAttempt += 1;
      const delay = Math.min(1000 * 2 ** Math.min(this.wsAttempt - 1, 6), 60_000) + Math.floor(Math.random() * 1000);
      log('warn', `WebSocket closed (code ${code}); reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.connectWs(handlers), delay);
      this.reconnectTimer.unref();
    });
  }

  /**
   * Broadcast a native "is typing" event. Best-effort: silently no-ops when
   * the socket is not open+authenticated (e.g. mid-reconnect — once `hello`
   * arrives again, the caller's next refresh resumes the indicator).
   * parentId scopes the indicator to a thread view; '' shows it under the
   * channel message box.
   */
  sendTyping(channelId: string, parentId = ''): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.wsAuthenticated) return;
    try {
      ws.send(
        JSON.stringify({
          action: 'user_typing',
          seq: this.wsSeq++,
          data: { channel_id: channelId, parent_id: parentId },
        }),
      );
    } catch (err) {
      log('debug', `sendTyping failed for ${channelId}: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.wsStopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }
}
