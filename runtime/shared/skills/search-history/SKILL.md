---
name: search-history
description: "Search past conversations and knowledge: full-text (FTS) and semantic search over the history archive, plus memory files and Mattermost. Use when asked 'what did we discuss/decide about X', 'have we talked about this before', when recalling facts from weeks/months ago, when a thread references old context you don't have, or before answering 'I don't know'. Triggers on: remember, recall, history, 'did we', 'last time', 'previously', knowledgebase."
---

# Searching past conversations

Layered recall, cheapest first:

1. `rg -i "<term>" MEMORY.md memory/` — curated facts
2. `search_posts` MCP tool — chat history, always current (`from:`/`in:` modifiers)
3. The archive (everything, incl. tool outputs that never reached chat):

```bash
python3 search_history.py "exact AND terms"            # FTS, instant, free
python3 search_history.py "..." --agent <you> --k 10   # narrow to your sessions
python3 search_history.py "vague idea" --semantic      # by meaning (1 API call; needs VOYAGE_API_KEY)
python3 search_history.py --context <conv_id>          # read around a hit
```

`--help` for all flags. The archive refreshes every few hours — the last few
hours of chat live in `search_posts` only.
