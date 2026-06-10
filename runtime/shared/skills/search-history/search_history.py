#!/usr/bin/env python3
"""Search past conversations in the history archive.

Usage:
  search_history.py "QUERY" [--agent NAME] [--k N]
  search_history.py "QUERY" --semantic [--agent NAME] [--k N]
  search_history.py --context CONV_ID [--around MESSAGE_ID]

Default: FTS5 full-text search over the archive (instant, free).
--semantic: meaning-based search via the shared semantic index (one Voyage
API call). --context: print a conversation's messages (after a hit).

FTS5 query syntax applies: words AND words, "exact phrase", OR, NEAR(a b, 10).
"""

import argparse
import os
import sqlite3
import subprocess
import sys

ARCHIVE_DB = os.environ.get("TALON_ARCHIVE_DB", "/home/claude/shared/talon-archive.db")
SEMANTIC = "/app/runtime/tools/semantic_search.py"


def fts(query: str, agent: str | None, k: int) -> list[str]:
    if not os.path.exists(ARCHIVE_DB):
        return []
    db = sqlite3.connect(f"file:{ARCHIVE_DB}?mode=ro", uri=True)
    out = []
    try:
        where = "AND c.agent = ?" if agent else ""
        params = [query] + ([agent] if agent else []) + [k]
        rows = db.execute(
            f"""SELECT m.created_at, c.agent, m.role, m.conversation_id,
                       snippet(messages_fts, 0, '<<', '>>', '...', 28)
                FROM messages_fts JOIN messages m ON m.message_id = messages_fts.rowid
                JOIN conversations c ON c.conversation_id = m.conversation_id
                WHERE messages_fts MATCH ? {where}
                ORDER BY rank LIMIT ?""", params).fetchall()
        out = [f"[{r[1] or '?'} conv={r[3]} {(r[0] or '?')[:16]} {r[2]}] {r[4]}" for r in rows]
    except sqlite3.OperationalError as e:
        out = [f"(query error: {e} — check FTS5 syntax)"]
    db.close()
    return out


def context(conv_id: int, around: int | None) -> None:
    db = sqlite3.connect(f"file:{ARCHIVE_DB}?mode=ro", uri=True)
    where, params = "conversation_id = ?", [conv_id]
    if around:
        where += " AND message_id BETWEEN ? AND ?"
        params += [around - 6, around + 6]
    for mid, role, content in db.execute(
        f"SELECT message_id, role, content FROM messages WHERE {where} ORDER BY message_id", params):
        print(f"--- #{mid} {role}:\n{content[:600]}\n")
    db.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("query", nargs="?")
    ap.add_argument("--agent")
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--semantic", action="store_true")
    ap.add_argument("--context", type=int, metavar="CONV_ID")
    ap.add_argument("--around", type=int, metavar="MESSAGE_ID")
    a = ap.parse_args()

    if a.context:
        context(a.context, a.around)
        return 0
    if not a.query:
        ap.print_help()
        return 1
    if a.semantic:
        cmd = [sys.executable, SEMANTIC, "search", a.query, "--k", str(a.k)]
        if a.agent:
            cmd += ["--agent", a.agent]
        return subprocess.call(cmd)

    hits = fts(a.query, a.agent, a.k)
    print("\n".join(hits) if hits else "(no hits — try fewer/different terms, or --semantic)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
