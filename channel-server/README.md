# talon channel-server

A Mattermost channel server for Claude Code: a single Node 22 TypeScript
service (run via `tsx`) acting as an MCP stdio channel server that bridges
one Mattermost bot account to one interactive Claude Code session.

Protocol: see [`../docs/channels-contract.md`](../docs/channels-contract.md).
Requires Claude Code v2.1.80+ (permission relay: v2.1.81+).

## How it works

- Connects to Mattermost (REST + WebSocket, API v4) as a bot account.
- Forwards selected inbound posts to Claude as
  `notifications/claude/channel` events; Claude sees them as
  `<channel source="mattermost" channel_id=".." ...>text</channel>`.
- Claude replies through the `reply` tool (threaded via `root_id`), and can
  pull more context with `read_channel_history`, `read_thread` and
  `search_posts`.
- Claude Code permission prompts are relayed to an admin DM; the admin
  answers `yes <id>` / `no <id>` and the verdict is sent back as a
  `notifications/claude/channel/permission` notification.
- On startup and after every WebSocket reconnect, missed posts in bound
  channels are caught up via `GET /channels/{id}/posts?since=...` using a
  persisted per-channel watermark.

## Configuration

Env vars are primary. An optional JSON file (`CONFIG_FILE=/path/to.json`)
can override individual keys using the same names, e.g.
`{"CHANNEL_MODE": "all", "LISTEN_CHANNELS": ["town-square", "ops"]}`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MM_URL` | yes | — | Mattermost base URL, e.g. `https://mattermost.example.com` |
| `MM_BOT_TOKEN` | yes | — | Bot account access token |
| `LISTEN_CHANNELS` | no | empty | Comma-separated channel names or ids the agent is bound to. Empty = DMs only. An entry may carry a per-channel mode suffix (`work-chan,test-chan:mention`) overriding `CHANNEL_MODE` for that channel |
| `CHANNEL_MODE` | no | `mention` | `mention`: forward channel posts only when the bot is @-mentioned or the post is in a thread the bot participates in (thread-follow). `all`: forward every allowed post in bound channels |
| `ALLOWED_USERS` | yes | — | Comma-separated Mattermost usernames or user ids allowed to reach Claude. Gates **every** inbound message (sender-id gating, never room gating). The **first entry is the permission-relay admin** |
| `DM_ENABLED` | no | `true` | Forward DMs from allowed users |
| `ALLOWED_BOTS` | no | empty | Bot accounts (usernames or ids) allowed for agent-to-agent messaging. Bot posts forward only on an explicit @-mention in a bound channel (no thread-follow, no DMs, regardless of `CHANNEL_MODE`) — a reply-loop damper |
| `STATE_FILE` | no | `./state.json` | Persisted state: per-channel `last_seen` watermark + participating thread roots |
| `POST_CHUNK_LIMIT` | no | `4000` | Max characters per outgoing post; longer replies are split (at newline/space boundaries) into a thread |
| `TYPING_INDICATOR` | no | `true` | Show the native "X is typing..." indicator while a forwarded message awaits the agent's reply |
| `TYPING_MAX_SECONDS` | no | `120` | Hard cap per typing run (5–3600). The agent may legitimately never reply, so the indicator self-expires |
| `ACK_REACTION` | no | `eyes` | Emoji name reacted onto each forwarded post as pickup proof. `none` or empty disables |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` (stderr only) |

Notes:

- `ALLOWED_USERS` entries that look like Mattermost ids (26 chars,
  `[a-z0-9]`) are treated as user ids; everything else as usernames
  (case-insensitive).
- All logging goes to **stderr**. stdout is the MCP transport — never print
  to it.

## Running with Claude Code

`.mcp.json` in the project Claude Code runs from:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["--import", "tsx", "./channel-server/src/index.ts"],
      "env": {
        "MM_URL": "https://mattermost.example.com",
        "MM_BOT_TOKEN": "<bot token — use an env reference or secret manager, do not commit>",
        "LISTEN_CHANNELS": "town-square",
        "CHANNEL_MODE": "mention",
        "ALLOWED_USERS": "your-username",
        "STATE_FILE": "./channel-server/state.json"
      }
    }
  }
}
```

Then start the session (channels are a research preview):

```bash
claude --dangerously-load-development-channels server:mattermost
```

### Tools exposed to Claude

| Tool | Args | Purpose |
|---|---|---|
| `reply` | `channel_id`, `text`, `root_id?` | Post a (threaded) reply; long text is chunked |
| `read_channel_history` | `channel_id`, `limit?=50`, `before_post_id?` | Recent messages, `[time] user: text`, oldest first |
| `read_thread` | `root_id` | Full thread |
| `search_posts` | `query`, `channel_id?` | Server-side Mattermost search |

### Permission relay

When Claude Code asks for tool permission, the request is posted to the DM
between the bot and the **first** `ALLOWED_USERS` entry:

> Claude wants to run `Bash`: ... — reply 'yes abcde' or 'no abcde'

DMs from that user matching `^(y|yes|n|no) <5 letters>$` are intercepted
(never forwarded as chat) and emitted as permission verdicts.

## Probe mode (integration testing without Claude Code)

```bash
# watch: prints every event that WOULD be forwarded, as JSON lines on stdout
npm run probe

# post a one-off message
npm run probe -- --say town-square "hello from talon"
npm run probe -- --say 8a9bc1d2e3f4g5h6i7j8k9l0m1 "hello by channel id"
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (router unit tests)
npm start           # run the MCP server on stdio (for Claude Code)
```

## Behavior details & limitations

- **Typing indicator semantics**: `user_typing` is sent over the WebSocket on
  forward and refreshed every 4s (clients display each event for 5s —
  `TimeBetweenUserTypingUpdatesMilliseconds`). It stops when the agent calls
  `reply` for that channel, but Mattermost has **no stop-typing event**, so
  the indicator can linger 1–5s after the reply (client TTL). The 👀 ack
  reaction is intentionally delayed 750ms — reacting within ~20ms of the post
  races the client's ingestion of the `posted` event and the reaction only
  renders after a later refetch.
- **First run baseline**: when a bound channel has no `last_seen` watermark
  yet, catch-up sets it to "now" rather than replaying the whole channel
  history.
- **Catch-up scope**: only bound channels are caught up after downtime. DMs
  are realtime-only — a DM sent while the server is down is not replayed
  (visible to Claude via `read_channel_history` on demand).
- **Thread-follow**: a thread counts as "participated in" once the bot has
  posted in it (including via the `reply` tool) or once a post from it was
  forwarded after an @-mention. The set is persisted and capped at 1000
  threads (oldest evicted).
- **Group DMs** (`G` channels) are not treated as DMs; bind them via
  `LISTEN_CHANNELS` if needed.
- **Search scope**: `search_posts` searches the team of the given channel,
  or the bot's first team when no channel is given.
- **Single session**: one bot account ↔ one Claude Code session. Running two
  instances against the same bot/state file will double-process messages.
- **Permission relay requires the admin's DM**: verdicts are only accepted
  from the first `ALLOWED_USERS` entry, via DM, in the exact
  `yes <id>` / `no <id>` shape. Pending requests do not survive a server
  restart.
