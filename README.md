# talon

Run a fleet of persistent **Claude Code** agents bridged to **Mattermost**.

talon is a minimal reconstruction of the part of the OpenClaw harness its
author actually used, rebuilt on **native Claude Code**. The reason it
exists: a claude.ai flat-rate (Max) subscription only allows agentic use
through Claude Code itself, so a fleet built on stock Claude Code runs on
the subscription instead of metered API billing. Background story:
[OpenClaw Is Dead, Long Live Claude Code Talon](https://danielhnyk.cz/openclaw-is-dead-long-live-claude-code-talon).

One pod (or container) runs N persistent, *interactive* Claude Code sessions,
one per agent, each kept alive in tmux and connected to its own Mattermost
bot account through an MCP **channel server**. Because the sessions are
interactive Claude Code sessions authenticated with a claude.ai Max
subscription, usage is **flat-rate**: no per-token API billing, while every
agent keeps the full Claude Code toolbelt (Bash, file tools, MCP, skills).

Two halves:

- **`channel-server/`**: TypeScript MCP server implementing the Claude Code
  [channels protocol](docs/channels-contract.md): forwards Mattermost posts
  into the session as channel events, exposes `reply` /
  `read_channel_history` / `read_thread` / `search_posts` tools, optional
  permission relay, typing indicator + ack reaction, catch-up after downtime.
  See [its README](channel-server/README.md) for the full env reference.
- **`runtime/`**: everything that turns that into a deployable service:
  the agent registry, per-agent config skeletons, the tmux supervisor,
  Dockerfile, Helm chart, cron scheduler, history archiver, CI example.

## Architecture

```
            ┌───────────────────────────  pod: talon (1 replica)  ───────────────────────────┐
            │                                                                                │
            │  supervisor (runtime/supervisor/entrypoint.sh)                                 │
            │   • reconciles managed symlinks → /app (git-controlled config)                 │
            │   • health loop → /tmp/healthy (liveness), restarts dead sessions w/ backoff   │
            │   • timers: transcript archive (+ semantic index), cron scheduler              │
            │                                                                                │
            │  tmux: agent-assistant                     tmux: agent-ops                     │
            │  ┌────────────────────────────────┐        ┌────────────────────────────────┐  │
            │  │ claude --agent assistant       │        │ claude --agent ops             │  │
            │  │   ▲ channel events │ reply     │        │   own workdir, own bot token   │  │
            │  │   └─── stdio MCP ──┘           │        │                                │  │
            │  │ channel-server (node/tsx)      │        │ channel-server (per agent)     │  │
            │  │  MM_BOT_TOKEN_ASSISTANT        │        │  MM_BOT_TOKEN_OPS              │  │
            │  │  LISTEN_CHANNELS=assistant     │        │  LISTEN_CHANNELS=ops,…         │  │
            │  └───────────┬────────────────────┘        └───────────┬────────────────────┘  │
            │              │                                         │                       │
            │  PVC /home/claude: ~/.claude* creds + transcripts, agents/<name>/ workdirs     │
            └──────────────┼─────────────────────────────────────────┼───────────────────────┘
                           ▼                                         ▼
                       Mattermost REST/WS  (MM_URL)
                           ▲
                    humans: alice, bob   (per-agent bot account, per-agent channels)
```

Routing lives in `runtime/agents.yaml`: it maps each agent to
its bot token env var, channels, mode (`mention`/`all`), and allowed users.
Each agent gets its own Mattermost bot identity and its own channel-server
process, so conversations, permissions, and personalities stay isolated.

### Managed configuration is git-controlled (read-only symlinks)

Everything under `runtime/agents/<name>/` and `runtime/shared/` is baked into
the image at `/app/runtime/...`. On every boot the supervisor symlinks the
managed entries into place (per agent: `CLAUDE.md`, `.mcp.json`,
`.claude/settings.json`, `.claude/agents`, `.claude/skills`; shared:
`~/.claude/CLAUDE.md`, `~/.claude/skills`) and moves aside any pre-existing
real file as `*.pre-symlink.<ts>`. Changing a persona, skill, or shared rule
= PR to this repo → rebuild → redeploy. Agents cannot hot-edit their own
configuration (by design); runtime state (`MEMORY.md`, `memory/`, working
files) stays writable on the persistent volume and is never touched by the
supervisor.

## Repo layout

```
talon/
├── README.md                      <- you are here
├── docs/channels-contract.md      <- condensed Claude Code channels protocol
├── channel-server/                <- Mattermost MCP channel server (own deps, own tests)
├── ci/woodpecker.yaml.example     <- example build+deploy pipeline
└── runtime/
    ├── agents.yaml                <- agent registry consumed by the supervisor
    ├── agents/<name>/             <- managed config per agent (assistant, ops)
    │   ├── .claude/agents/<name>.md   (agent definition: persona, model)
    │   ├── .claude/settings.json      (auto-approve project .mcp.json servers)
    │   ├── .mcp.json                  (mattermost channel server, ${VAR} expansion)
    │   └── CLAUDE.md                  (workspace instructions, etiquette)
    ├── shared/                    <- shared across all agents (symlinked to ~/.claude)
    │   ├── CLAUDE.md                  (shared rules -> ~/.claude/CLAUDE.md)
    │   └── skills/                    (shared skills -> ~/.claude/skills)
    │       ├── scheduling/            (create/manage cron jobs)
    │       └── search-history/        (FTS + semantic search over the archive)
    ├── tools/                     <- archive/semantic/cron python tools + uv lockfile
    ├── supervisor/entrypoint.sh   <- tmux supervisor (container entrypoint)
    ├── cron.yaml                  <- git-managed scheduled jobs
    ├── Dockerfile                 <- node:22-bookworm + claude CLI + tool venv (uid 1000)
    └── chart/                     <- minimal Helm chart (no Service/Ingress)
```

## Prerequisites

1. **A Mattermost server** you control, reachable from wherever talon runs.
   Tested against the standard Team Edition (`MM_URL` like
   `http://mattermost-team-edition.apps:8065` in-cluster, or any https URL).
2. **One bot account per agent** (+ optionally one for `cron`):
   *System Console → Integrations → Bot Accounts → Add Bot Account.* Name the
   bot exactly like the agent (`assistant`, `ops`, `cron`), copy each access
   token. Then add each bot to the channels it should listen to (or let it
   self-join public channels by inviting `@assistant` etc.).
3. **Claude Code v2.1.80+** in the image (the Dockerfile installs latest).
   The channels feature is a research preview behind
   `--dangerously-load-development-channels`.
4. **Anthropic auth**, one of:
   - claude.ai **Max subscription** login seeded once on the persistent
     volume (`claude login` via `kubectl exec`, see "First-boot auth"), or
   - a long-lived `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`
     (also subscription-backed), or
   - `ANTHROPIC_API_KEY` (works, but then you're paying per token, that
     defeats half the point).
5. **Somewhere to run it**: a Kubernetes cluster (Helm chart included) or any
   Docker host (quickstart below).

## Quickstart (plain Docker, no Kubernetes)

```bash
git clone https://github.com/hnykda/talon && cd talon
docker build -f runtime/Dockerfile -t talon:dev .

docker run -d --name talon \
  -v talon-home:/home/claude \
  -e MM_URL="https://mattermost.example.com" \
  -e MM_BOT_TOKEN_ASSISTANT="<assistant bot token>" \
  -e MM_BOT_TOKEN_OPS="<ops bot token>" \
  -e TALON_CHANNELS_AUTOCONFIRM=1 \
  talon:dev

# one-time auth (Max subscription):
docker exec -it talon claude login        # follow the URL/code flow
docker exec -it talon tmux kill-server    # supervisor respawns the sessions, now authed

docker logs -f talon                      # supervisor log
docker exec -it talon tmux attach -t agent-assistant   # watch a session (detach: Ctrl-b d)
```

Edit `runtime/agents.yaml` (channels, your usernames in `ALLOWED_USERS`)
before building, it's baked into the image. Then @-mention `@assistant` in
its channel, or DM it.

## Configuration reference: `runtime/agents.yaml`

One entry per agent:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Agent name. Must match the skeleton dir `runtime/agents/<name>/` and the agent definition `.claude/agents/<name>.md`. The tmux session is `agent-<name>`. |
| `enabled` | yes | Only enabled agents are started. |
| `workdir` | no | Workspace on the persistent volume; defaults to `/home/claude/agents/<name>`. |
| `effort` | no | Per-session thinking effort: `low\|medium\|high\|xhigh\|max`, passed as `claude --effort`. Keep routers at `medium`; substantive work belongs in subagents. |
| `botTokenEnvVar` | yes | Name of the pod env var holding this agent's Mattermost bot token (from the chart's `secrets.extra`). The supervisor exposes it to the session as `MM_BOT_TOKEN`. |
| `env` | no | Extra environment for the session, written to `.agent-env` and sourced at launch. See below. |

`env` keys consumed by the channel server (via `.mcp.json` `${VAR}` expansion):

| Key | Meaning |
|---|---|
| `LISTEN_CHANNELS` | Comma-separated channel **names or ids** the agent is bound to (ids are required for private channels). Empty = DMs only. Any entry may carry a per-channel mode suffix: `ops,incidents:mention` binds `ops` with the default mode and `incidents` mention-only. `:all` works the same way. |
| `CHANNEL_MODE` | Default mode for entries without a suffix. `mention` (default): forward channel posts only when the bot is @-mentioned or the post is in a thread the bot participates in. `all`: forward every allowed post in bound channels. |
| `ALLOWED_USERS` | Comma-separated Mattermost usernames or user ids allowed to reach the agent. This gates **every** inbound message, sender gating, never room gating. The **first entry is the permission-relay admin**: if you run without `--dangerously-skip-permissions`, permission prompts are DM'd to that user, who answers `yes <id>` / `no <id>`. |
| `DM_ENABLED` | Forward DMs from allowed users (`true` default). |
| `ALLOWED_BOTS` | Bot accounts allowed for **agent-to-agent** messaging. Bot posts forward only on an explicit @-mention in a bound channel, no thread-follow, no bot DMs, regardless of mode. That asymmetry is the reply-loop damper: every round of a bot exchange requires a deliberate mention. List `cron` here to receive scheduled jobs. |

Any other `env` key passes through to the session environment. Values of the
exact form `"$NAME"` / `"${NAME}"` are **dereferenced against the pod env at
render time**, so you can alias shared secrets per agent, e.g.
`GH_TOKEN: "$GH_TOKEN_OPS"` gives this agent's `gh` the ops token while
another agent gets a different one. Note this is aliasing, not isolation,
tmux sessions inherit the full pod environment (see Limitations).

The full channel-server variable list (typing indicator, ack reaction, chunk
limit, state file...) is in [channel-server/README.md](channel-server/README.md).

## The two default agents (binding walkthrough)

**`assistant`**: a general helper:

```yaml
- name: assistant
  enabled: true
  effort: medium
  botTokenEnvVar: MM_BOT_TOKEN_ASSISTANT
  env:
    LISTEN_CHANNELS: "assistant"      # one public channel, by name
    CHANNEL_MODE: "mention"           # speaks only when @assistant is mentioned
    ALLOWED_USERS: "alice,bob"        # alice (first) is the permission-relay admin
    DM_ENABLED: "true"                # alice and bob can DM it
    ALLOWED_BOTS: "ops,cron"          # @ops can hand things off; @cron delivers jobs
```

**`ops`**: shows the rest of the knobs:

```yaml
- name: ops
  enabled: true
  effort: high                        # per-session effort
  botTokenEnvVar: MM_BOT_TOKEN_OPS
  env:
    LISTEN_CHANNELS: "ops,incidents:mention"  # per-channel mode suffix
    CHANNEL_MODE: "all"               # hears EVERY message in #ops...
    ALLOWED_USERS: "alice"            # ...but only from alice
    DM_ENABLED: "true"
    ALLOWED_BOTS: "assistant,cron"    # @assistant can @-mention it
```

`ops` reads everything in `#ops` (ambient context; its CLAUDE.md tells it
when to stay silent), answers only mentions in `#incidents`, and can be
called by `@assistant` from any channel both bots are bound to.

### Adding a third agent

1. **Skeleton:** copy `runtime/agents/assistant/` to `runtime/agents/<name>/`;
   rename `.claude/agents/assistant.md` → `<name>.md` and edit the persona
   (frontmatter `name:` must match); adjust `CLAUDE.md`; fix the two
   per-agent values in `.mcp.json` (`LISTEN_CHANNELS` default and the
   `STATE_FILE` path, it must point at `/home/claude/agents/<name>/...`).
2. **Registry:** add an entry to `runtime/agents.yaml` with
   `botTokenEnvVar: MM_BOT_TOKEN_<NAME>` and its routing `env`.
3. **Bot account:** create the `<name>` bot in the Mattermost System Console,
   add it to its channels, copy the token.
4. **Secret:** add `MM_BOT_TOKEN_<NAME>: "..."` to `secrets.extra` in your
   deploy values (or `-e` for plain Docker).
5. **Rebuild + redeploy.** The supervisor picks the new agent up on boot.

## Deploying on Kubernetes

### Build & push

```bash
docker build --platform linux/amd64 -f runtime/Dockerfile -t ghcr.io/<you>/talon:sha-$(git rev-parse --short HEAD) .
docker push ghcr.io/<you>/talon:sha-$(git rev-parse --short HEAD)
```

(Or wire up CI, `ci/woodpecker.yaml.example` is a working Woodpecker
pipeline to adapt.)

### Install

Create `values-secrets.yaml` (gitignored, never commit it):

```yaml
secrets:
  # EITHER set a token from `claude setup-token`...
  claudeCodeOAuthToken: ""
  # ...or leave it empty and do the one-time `claude login` below.
  extra:
    MM_BOT_TOKEN_ASSISTANT: "xxxxxxxxxxxxxxxxxxxxxxxxxx"
    MM_BOT_TOKEN_OPS: "xxxxxxxxxxxxxxxxxxxxxxxxxx"
    # optional:
    # MM_BOT_TOKEN_CRON: "xxxxxxxxxxxxxxxxxxxxxxxxxx"   # enables the cron scheduler
    # VOYAGE_API_KEY: "..."                              # enables semantic search
```

```bash
helm upgrade --install talon ./runtime/chart \
  --namespace talon --create-namespace \
  --set image.repository=ghcr.io/<you>/talon \
  --set image.tag=sha-xxxxxxxx \
  --set env.MM_URL=http://mattermost-team-edition.apps:8065 \
  --set 'supervisor.TALON_CHANNELS_AUTOCONFIRM=1' \
  -f values-secrets.yaml
```

The chart creates a Deployment (replicas 1, `Recreate`), a PVC mounted at
`/home/claude` (credentials, transcripts, agent workdirs, annotated
`helm.sh/resource-policy: keep`), the `talon-secrets` Secret, and a
ServiceAccount. No Service, no Ingress, talon only dials out to Mattermost.
`sandbox.enabled` (optional RBAC for cluster-operating agents) is **off** by
default since the stock image ships no kubectl.

### First-boot auth (claude.ai Max login), once

Skip this if you set `claudeCodeOAuthToken`. Otherwise the credentials live
in `~/.claude*` on the PVC, seeded interactively one time:

```bash
kubectl -n talon exec -it deploy/talon -- claude login   # URL/code flow
kubectl -n talon exec -it deploy/talon -- tmux kill-server  # supervisor respawns, now authed
```

First boot of a fresh workdir can also show interactive prompts inside the
tmux pane (notably the dev-channels confirmation). Either set
`supervisor.TALON_CHANNELS_AUTOCONFIRM=1` (blindly accepts it shortly
after start) or attach once and accept by hand:

```bash
kubectl -n talon exec -it deploy/talon -- tmux attach -t agent-assistant
# accept prompts, then DETACH with Ctrl-b d   (Ctrl-c would kill claude)
```

### Day-2 ops

```bash
kubectl -n talon logs deploy/talon                                  # supervisor log
kubectl -n talon exec -it deploy/talon -- tmux ls                   # session list
kubectl -n talon exec -it deploy/talon -- tmux attach -t agent-ops  # watch an agent live
```

- Channel-server (MCP) logs per agent:
  `~/.cache/claude-cli-nodejs/<munged-workdir>/mcp-logs-mattermost/`.
- Restarts are cheap: the supervisor passes `--continue` when a previous
  session transcript exists, so agents resume with context; if a `--continue`
  start crashes immediately, it falls back to a fresh session for that agent.
- A dead agent is restarted in-pod with exponential backoff; the liveness
  probe (`cat /tmp/healthy`) tracks the supervisor, not individual agents.
- Catch-up: posts that arrived in bound channels while the pod was down are
  replayed on reconnect (per-channel watermark in
  `.mattermost-state.json`). DMs are realtime-only.

## Features beyond the bridge

**How context works** (parallel conversations, compaction, what's recoverable,
why it could be made lossless): [docs/context-management.md](docs/context-management.md).


- **Thread-per-subagent router pattern.** Each agent session is one context
  window shared by all its conversations. The shipped CLAUDE.md files steer
  the main session into acting as a *router*: busy channel threads get
  delegated to subagents (Agent tool) with their own clean context, and the
  router only relays replies. Prompt-level, not enforced, adapt the
  instructions to taste.
- **History archives.** The supervisor periodically (default 6h,
  `TALON_ARCHIVE_INTERVAL` seconds, `0` disables) runs
  `runtime/tools/archive_transcripts.py`, incrementally ingesting all session
  transcripts (`~/.claude/projects/*/*.jsonl`) into an SQLite FTS5 archive at
  `/home/claude/shared/talon-archive.db` with per-agent attribution, so
  context compaction never permanently loses history. Agents query it via the
  shared `search-history` skill.
- **Semantic search (optional).** With `VOYAGE_API_KEY` set, new archive
  content is also embedded (Voyage API) into a sqlite-vec index on the same
  timer; `search_history.py "vague idea" --semantic` finds meaning, not just
  words. Capped per run (`TALON_SEMANTIC_MAX_PER_RUN`, default 2000) so a
  backlog drains gradually.
- **Cron scheduler.** With `MM_BOT_TOKEN_CRON` set (create a `cron` bot), the
  supervisor runs `runtime/tools/cron_scheduler.py` in its own tmux session.
  At fire time it posts the job prompt into the job's channel as `@cron`,
  @-mentioning the target agent, delivery rides the normal A2A path
  (the agent must list `cron` in `ALLOWED_BOTS`), including catch-up replay
  if the agent was down. Durable jobs live in `runtime/cron.yaml` (git);
  agents self-schedule quick jobs by writing
  `/home/claude/shared/cron.d/*.yaml` (the `scheduling` skill). Heartbeats
  are just another job. Scheduler log:
  `/home/claude/shared/cron-scheduler.log`.
- **Per-session effort.** `effort:` in the registry maps to `claude
  --effort`, so a router can idle cheaply while a specialist thinks harder.
- **Agent-to-agent messaging.** `ALLOWED_BOTS` + mention-only forwarding for
  bot senders (the loop damper described above). The shared CLAUDE.md ships
  the matching discipline rules (answer without re-mentioning, max two
  rounds).

## Limitations (honest ones)

- **Text-only bridge.** Mattermost file uploads/attachments are not forwarded
  in either direction; agents can still fetch files via the Mattermost REST
  API by hand.
- **Single pod, RWO volume, `Recreate`.** Every deploy is a short outage;
  sessions resume via `--continue`. Don't scale replicas.
- **Channels are a research preview.** Everything rides
  `--dangerously-load-development-channels`, which is experimental and may
  prompt for confirmation on every start (hence `TALON_CHANNELS_AUTOCONFIRM`,
  which blindly types `y`, crude but effective). Flag semantics can change
  under you with Claude Code releases.
- **No secret isolation between agents.** All sessions run as the same user
  in one container and inherit the full pod env. The per-agent env aliasing
  is convenience, not a security boundary, an agent that goes looking can
  read its siblings' tokens. Don't co-host mutually untrusted agents.
- **Permissions are skipped by default.** The supervisor launches sessions
  with `--dangerously-skip-permissions` (headless sessions can't answer
  prompts). The channel server implements a permission relay over DM if you
  want to remove that flag, but that flow is the least battle-tested part.
- **Tested at exactly one installation** (the author's). Mattermost Team
  Edition, single-node Kubernetes, a handful of agents. Expect rough edges
  elsewhere; issues and PRs welcome.

## Development

```bash
cd channel-server
npm install
npx tsc --noEmit     # strict typecheck
npx vitest run       # unit tests (router/config/typing)
npm run probe        # full Mattermost pipeline WITHOUT Claude: prints would-forward events
npm run probe -- --say <channel> "hello"   # post as the bot
```

Channel-server rule #1: **stdout is the MCP transport, all logging goes to
stderr** (`LOG_LEVEL=debug` for verbose). Routing decisions are pure
functions in `src/router.ts`; extend rules there and add vitest cases.

Run a single agent on your laptop against a real Mattermost:

```bash
cd runtime/agents/assistant
export MM_URL=https://mattermost.example.com MM_BOT_TOKEN=<token> \
       LISTEN_CHANNELS=assistant CHANNEL_MODE=mention \
       ALLOWED_USERS=<your-username> DM_ENABLED=true \
       STATE_FILE=/tmp/mm-state.json
# .mcp.json points at /app/channel-server; for laptop runs symlink it:
#   sudo ln -s "$(git rev-parse --show-toplevel)" /app   # or edit .mcp.json
claude --agent assistant --dangerously-load-development-channels server:mattermost
```

## License

MIT. See [LICENSE](LICENSE).
