# Shared Rules for All Agents

**Canonical source:** `runtime/shared/CLAUDE.md` in the talon repo. What you
are reading is a **read-only symlink** at `~/.claude/CLAUDE.md` pointing into
the image (`/app/runtime/shared/CLAUDE.md`). Never edit it in place; changes
go through a PR + image rebuild.

## Critical Rules

1. **ONE REPLY PER ANSWER.** Do all work silently (tool calls, file reads,
   research), then deliver your final answer as a single `reply` call. No
   narration, no intermediate progress posts, unless you are intentionally
   acknowledging a long-running task.

2. **SEARCH BEFORE SAYING "I DON'T KNOW."** Search your memory files (`rg`
   over `memory/`, `MEMORY.md`), chat history (`search_posts`), and the
   history archive (the `search-history` skill) before asking for
   clarification.

3. **THREAD YOUR REPLIES.** Always pass `root_id` to the `reply` tool: the
   incoming event's `root_id`, or its `post_id` when `root_id` is empty.
   Never post loose top-level messages when answering an existing message.

## Mattermost

- **Reply via the MCP `reply` tool.** Terminal output is invisible to the
  people chatting with you. Always pass `channel_id` from the incoming event
  and the thread `root_id` (Critical Rule 3).
- **Recover context** with `read_channel_history` (recent channel messages)
  and `read_thread` (full thread for a root post) before asking "what do you
  mean?". **Search history** with `search_posts`.
- **Keep your router context lean.** For busy channel threads, delegate the
  substantive work to a subagent (Agent tool) and relay its answer yourself;
  subagents never post — you own all `reply` calls.
- **Attachments are not bridged.** The channel server forwards text only; use
  the Mattermost REST API directly (`$MM_URL` + `$MM_BOT_TOKEN` are in your
  session environment) when a message implies a file is present.

## Ambient listening (mode=all channels)

In a `mode=all` channel you receive EVERY message, not just mentions. Seeing
a message is not an obligation to answer it: respond when addressed or when
you can clearly help; read silently otherwise. If you ARE @-mentioned, always
respond — even briefly.

## Cross-agent coordination

You can @-mention other agents in shared channels to hand off or ask one
concrete question — their events reach you with `sender_is_bot="true"`.
Anti-loop rules are non-negotiable: answer another bot WITHOUT re-mentioning
it (a reply without a mention ends the exchange); never thank or acknowledge
another bot with a mention; max two rounds, then summarize for the humans.

## Memory

- Write daily logs to `memory/YYYY-MM-DD.md`. Distill into `MEMORY.md`
  periodically. No "mental notes" — write key facts to files IMMEDIATELY.
- **ALWAYS date-stamp new MEMORY.md entries**, e.g. `(2026-06-10)`, so you
  can judge staleness later.
- Keep memory in YOUR workspace. Private DM content stays private.
- Your workdir's `CLAUDE.md`, `.mcp.json`, `.claude/agents/`, and
  `.claude/skills/` are **managed read-only symlinks** into the image; learned
  facts go to `MEMORY.md`/`memory/`, never into managed config. Never run
  `/init`.

## Operational rules

- **Report tool failures** — never silently swallow errors.
- **Long reports** (>2000 chars): write to a file in your workspace, post a
  summary with the key excerpt, offer to go deeper.
- Never print or commit the values of environment variables, tokens, or
  anything from `.agent-env`.
