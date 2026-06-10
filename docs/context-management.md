# How talon handles context

The questions everyone asks: how does an agent keep parallel conversations
apart? What happens when the context window fills? Does it forget things?
This page is the honest answer.

## The base model: one agent = one session = one context window

Each agent is a single persistent `claude` session. Everything it sees lands
in that one transcript: a DM, a message in channel A, a reply in thread B,
interleaved in arrival order. There is no per-conversation session.

Separation comes from **metadata, not isolation**. Every Mattermost post the
channel server forwards arrives as a tagged event:

```
<channel source="mattermost" channel_name="ops" is_dm="false"
         root_id="abc..." post_id="def..." sender_name="alice">
  the actual message text
</channel>
```

`root_id` is the conversation key: the thread root. DMs carry `is_dm="true"`
and have no threads, so a DM is one lane. The agent's standing rules require
every reply to go through the `reply` tool with the incoming `root_id`, so
conversations stay cleanly separated as threads on the Mattermost side, and
inside the transcript every message is labeled with where it belongs.

## Thread isolation: the router pattern

Labeled-but-interleaved works, but on busy days topics can bleed and one
long task delays everything else. So the main session acts as a **router**:

- A channel-thread message gets delegated to a **subagent dedicated to that
  thread**, spawned in the background with the full thread content prefetched
  (`read_thread`). The subagent has its own clean context window and the full
  toolbelt; it returns reply text, the router posts it with the right
  `root_id`. With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in the chart
  values) these subagents are continuable, so a thread keeps its internal
  working state between messages.
- DMs stay in the router's own lane (heavy DM work can also be delegated).
- The router tracks thread → subagent in `.threads.json` in its workdir, and
  stays lean: route, ack, relay. Background spawning means a slow thread
  never blocks the agent's other conversations.

This is prompt-level orchestration (see `runtime/shared/CLAUDE.md` and the
thread protocol it references), not a hard architectural wall. In practice
the model follows it reliably because every event is explicitly labeled.

## When the window fills: compaction, and why it doesn't matter much

Claude Code auto-compacts the session as it approaches the limit
(`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75` in the chart values): older content is
summarized in place. That is lossy by design. Talon compensates with layered,
recoverable ground truth:

1. **Mattermost is the canonical record.** A thread is durable: when an old
   conversation wakes up, the agent calls `read_thread(root_id)` and gets the
   complete history back verbatim, regardless of what compaction ate.
   `read_channel_history` and `search_posts` cover the rest of the chat.
2. **Memory files.** Agents distill durable facts into `MEMORY.md` and daily
   `memory/YYYY-MM-DD.md` logs in their workdir (writable PVC state, survives
   everything).
3. **The transcript archive.** A supervisor timer runs
   `runtime/tools/archive_transcripts.py`, which incrementally ingests every
   session transcript (including tool outputs that never reached chat) into a
   FTS5-indexed SQLite at `/home/claude/shared/archive.db`, with per-agent
   attribution. The `search-history` skill teaches agents to query it. So
   compaction loses nothing permanently; it only evicts from working memory.
4. **Optional semantic layer.** With `VOYAGE_API_KEY` set,
   `semantic_search.py` embeds archive content into a sqlite-vec index so
   agents can search by meaning when they don't remember the wording.

Raw pre-compaction transcripts also persist as JSONL under
`~/.claude/projects/<munged-workdir>/` on the PVC, as a last resort.

## Across restarts

The supervisor passes `--continue` when a previous session transcript exists,
so agents resume with their working context after a pod roll or deploy. If a
stored session is corrupt (start dies within a fast-fail window), the
supervisor falls back to a fresh session, and the layers above mean a fresh
session can rebuild context on demand.

## Could this be lossless?

Very likely yes. The archive already captures everything append-only; what
compaction loses is only *in-window presence*, not data. A lossless-context
engine in the style of
[lossless-claw](https://github.com/Martian-Engineering/lossless-claw)
(hierarchical summarization with expand-on-demand over the full history)
could be built on top of the existing archive: the FTS/semantic indexes are
the retrieval half, and a summarize-and-link pass over `archive.db` would be
the other half, exposed to agents as one more skill. Nothing in the
architecture blocks it; it just hasn't been needed badly enough yet.
