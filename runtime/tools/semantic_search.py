#!/usr/bin/env python3
"""Semantic (embedding) search over the history archive.

Two subcommands:

  index   Embed new content into the vector index (incremental). Source:
          talon-archive.db user/assistant messages >= MIN_CHARS.
          Embeddings via the Voyage REST API (VOYAGE_API_KEY env), stored in
          a sqlite-vec vec0 table in /home/claude/shared/semantic-index.db.
          Per-run cap (--max-items) keeps each tick bounded; reruns resume.

  search  Embed the query and return the K nearest archive entries.
            semantic_search.py search "what did we decide about backups" \
                [--agent assistant] [--k 10]

Run inside the talon pod (the talon-tools venv has sqlite-vec):
  python3 /app/runtime/tools/semantic_search.py search "..."

FTS (the search-history skill) finds exact words; this finds meaning. Use FTS
first, this when wording is unknown.
"""

import argparse
import json
import os
import sqlite3
import struct
import sys
import time
import urllib.request

INDEX_DB = os.environ.get("TALON_SEMANTIC_DB", "/home/claude/shared/semantic-index.db")
ARCHIVE_DB = os.environ.get("TALON_ARCHIVE_DB", "/home/claude/shared/talon-archive.db")
VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = os.environ.get("VOYAGE_MODEL", "voyage-4")
MIN_CHARS = 80
EMBED_CHARS = 4000  # truncate long entries before embedding
BATCH = 96


def die(msg: str) -> "NoReturn":  # noqa: F821
    print(msg, file=sys.stderr)
    sys.exit(1)


def embed(texts: list[str], input_type: str) -> list[list[float]]:
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        die("VOYAGE_API_KEY not set")
    req = urllib.request.Request(
        VOYAGE_URL,
        data=json.dumps(
            {"model": VOYAGE_MODEL, "input": [t[:EMBED_CHARS] for t in texts], "input_type": input_type}
        ).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.load(resp)
            return [d["embedding"] for d in data["data"]]
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 4:
                time.sleep(2 ** (attempt + 1))
                continue
            die(f"Voyage API error {e.code}: {e.read()[:300]!r}")
        except OSError as e:
            if attempt < 4:
                time.sleep(2 ** (attempt + 1))
                continue
            die(f"Voyage API unreachable: {e}")
    raise AssertionError("unreachable")


def serialize(vec: list[float]) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def open_index(dim: int | None = None) -> sqlite3.Connection:
    import sqlite_vec

    db = sqlite3.connect(INDEX_DB, timeout=30)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        """CREATE TABLE IF NOT EXISTS entries (
             entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
             source TEXT NOT NULL,            -- 'archive'
             source_rowid INTEGER NOT NULL,   -- messages.message_id
             agent TEXT,
             created_at TEXT,
             preview TEXT,
             UNIQUE (source, source_rowid)
           )"""
    )
    if dim is not None:
        db.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(embedding float[{dim}])")
    return db


def pending_archive(db: sqlite3.Connection, limit: int) -> list[tuple]:
    return db.execute(
        f"""SELECT m.message_id, c.agent, m.created_at, m.content
            FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
            WHERE m.role IN ('user', 'assistant') AND length(m.content) >= {MIN_CHARS}
              AND m.message_id NOT IN
                  (SELECT source_rowid FROM idx.entries WHERE source = 'archive')
            ORDER BY m.message_id LIMIT {limit}"""
    ).fetchall()


def cmd_index(args: argparse.Namespace) -> int:
    open_index().close()  # ensure entries table exists before ATTACH queries
    if not os.path.exists(ARCHIVE_DB):
        print(f"no archive at {ARCHIVE_DB}; nothing to index", file=sys.stderr)
        return 0
    src = sqlite3.connect(f"file:{ARCHIVE_DB}?mode=ro", uri=True, timeout=30)
    src.execute("ATTACH DATABASE ? AS idx", (INDEX_DB,))
    rows = pending_archive(src, args.max_items)
    src.close()
    total = 0
    idx = None
    for i in range(0, len(rows), BATCH):
        chunk = rows[i : i + BATCH]
        vectors = embed([r[3] for r in chunk], "document")
        if idx is None:
            idx = open_index(dim=len(vectors[0]))
        with idx:
            for (rowid, agent, created, content), vec in zip(chunk, vectors):
                cur = idx.execute(
                    "INSERT OR IGNORE INTO entries(source, source_rowid, agent, created_at, preview) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ("archive", rowid, agent, created, content[:200]),
                )
                if cur.rowcount > 0:
                    idx.execute(
                        "INSERT INTO vectors(rowid, embedding) VALUES (?, ?)",
                        (cur.lastrowid, serialize(vec)),
                    )
                    total += 1
    if idx is not None:
        idx.close()
    print(f"indexed {total} new entries -> {INDEX_DB}", file=sys.stderr)
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    if not os.path.exists(INDEX_DB):
        die(f"no semantic index at {INDEX_DB} (run `index` first)")
    vec = embed([args.query], "query")[0]
    idx = open_index()
    where = "AND e.agent = ?" if args.agent else ""
    params: list = [serialize(vec), args.k * (3 if args.agent else 1)]
    if args.agent:
        params.append(args.agent)
    rows = idx.execute(
        f"""SELECT e.source, e.agent, e.created_at, e.preview, v.distance
            FROM vectors v JOIN entries e ON e.entry_id = v.rowid
            WHERE v.embedding MATCH ? AND v.k = ? {where}
            ORDER BY v.distance LIMIT {args.k}""",
        params,
    ).fetchall()
    idx.close()
    for source, agent, created, preview, dist in rows:
        print(f"[{dist:.3f}] ({source}{'/' + agent if agent else ''}, {created or '?'}) {preview}")
    if not rows:
        print("(no results)", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_index = sub.add_parser("index", help="embed new archive content (incremental)")
    p_index.add_argument("--max-items", type=int, default=int(os.environ.get("TALON_SEMANTIC_MAX_PER_RUN", "2000")))
    p_index.set_defaults(fn=cmd_index)
    p_search = sub.add_parser("search", help="semantic search over the index")
    p_search.add_argument("query")
    p_search.add_argument("--agent", default=None)
    p_search.add_argument("--k", type=int, default=10)
    p_search.set_defaults(fn=cmd_search)
    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
