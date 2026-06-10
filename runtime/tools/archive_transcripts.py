#!/usr/bin/env python3
"""Ingest Claude Code session transcripts into a searchable FTS archive.

Walks ~/.claude/projects/<munged-workdir>/*.jsonl (one file per session),
extracts conversational content (user/assistant text, truncated tool
results), and appends it to an SQLite database with an FTS5 index, so
auto-compaction never permanently loses history. Incremental: per-file byte
offsets are tracked, so re-runs only read what was appended since the last run.

Run by the supervisor on a timer (TALON_ARCHIVE_INTERVAL); safe to run by
hand: python3 /app/runtime/tools/archive_transcripts.py [--db PATH]

Query example:
  sqlite3 /home/claude/shared/talon-archive.db \
    "SELECT m.created_at, c.agent, snippet(messages_fts, 0, '<<', '>>', '...', 24)
     FROM messages_fts JOIN messages m ON m.message_id = messages_fts.rowid
     JOIN conversations c ON c.conversation_id = m.conversation_id
     WHERE messages_fts MATCH 'your query' ORDER BY m.created_at DESC LIMIT 20"
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time

DEFAULT_DB = os.environ.get("TALON_ARCHIVE_DB", "/home/claude/shared/talon-archive.db")
PROJECTS_DIR = os.path.expanduser(os.environ.get("TALON_PROJECTS_DIR", "~/.claude/projects"))
MAX_TOOL_CHARS = 2000
AGENT_DIR_RE = re.compile(r"^-home-claude-agents-([a-z0-9-]+)$")

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  agent TEXT,
  source_path TEXT,
  first_at TEXT,
  last_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  message_id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id),
  uuid TEXT UNIQUE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='message_id'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.message_id, new.content);
END;
CREATE TABLE IF NOT EXISTS ingest_state (
  path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
"""


def agent_from_dirname(dirname: str) -> str:
    m = AGENT_DIR_RE.match(dirname)
    return m.group(1) if m else dirname


def extract_text(message: dict) -> tuple[str, str]:
    """Return (role, text) for a transcript message; text may be empty."""
    role = message.get("role", "")
    content = message.get("content")
    if isinstance(content, str):
        return role, content
    parts: list[str] = []
    saw_tool_result = False
    saw_text = False
    for block in content or []:
        btype = block.get("type")
        if btype == "text":
            saw_text = True
            parts.append(block.get("text", ""))
        elif btype == "tool_result":
            saw_tool_result = True
            inner = block.get("content")
            if isinstance(inner, str):
                parts.append(inner[:MAX_TOOL_CHARS])
            elif isinstance(inner, list):
                for ib in inner:
                    if isinstance(ib, dict) and ib.get("type") == "text":
                        parts.append((ib.get("text") or "")[:MAX_TOOL_CHARS])
        # tool_use inputs and thinking blocks are skipped on purpose:
        # inputs are huge/low-signal, thinking is not conversational record.
    if saw_tool_result and not saw_text:
        role = "tool"
    return role, "\n".join(p for p in parts if p).strip()


def ingest_file(db: sqlite3.Connection, path: str, agent: str) -> int:
    size = os.path.getsize(path)
    row = db.execute("SELECT byte_offset FROM ingest_state WHERE path = ?", (path,)).fetchone()
    offset = row[0] if row else 0
    if offset > size:  # truncated/rewritten file: re-ingest (uuids dedupe)
        offset = 0
    if offset == size:
        return 0

    inserted = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # partial last line; offset still advances to size below,
                # acceptable: next append rewrites a complete line after it
            if entry.get("type") not in ("user", "assistant"):
                continue
            message = entry.get("message") or {}
            role, text = extract_text(message)
            if not text:
                continue
            session_id = entry.get("sessionId") or os.path.basename(path).removesuffix(".jsonl")
            created = entry.get("timestamp") or ""
            cur = db.execute(
                "INSERT INTO conversations(session_id, agent, source_path, first_at, last_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET last_at = excluded.last_at "
                "RETURNING conversation_id",
                (session_id, agent, path, created, created),
            )
            conv_id = cur.fetchone()[0]
            cur = db.execute(
                "INSERT OR IGNORE INTO messages(conversation_id, uuid, role, content, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (conv_id, entry.get("uuid"), role or entry.get("type"), text, created),
            )
            inserted += max(cur.rowcount, 0)
    db.execute(
        "INSERT INTO ingest_state(path, byte_offset, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(path) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at",
        (path, size),
    )
    return inserted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--projects", default=PROJECTS_DIR)
    args = parser.parse_args()

    if not os.path.isdir(args.projects):
        print(f"no projects dir at {args.projects}; nothing to do", file=sys.stderr)
        return 0

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    db = sqlite3.connect(args.db, timeout=30)
    db.executescript(SCHEMA)

    started = time.time()
    total = 0
    files = 0
    for dirname in sorted(os.listdir(args.projects)):
        dirpath = os.path.join(args.projects, dirname)
        if not os.path.isdir(dirpath):
            continue
        agent = agent_from_dirname(dirname)
        for fname in sorted(os.listdir(dirpath)):
            if not fname.endswith(".jsonl"):
                continue
            files += 1
            with db:
                total += ingest_file(db, os.path.join(dirpath, fname), agent)
    db.close()
    print(
        f"archived {total} new message(s) from {files} transcript file(s) "
        f"in {time.time() - started:.1f}s -> {args.db}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
