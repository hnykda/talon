#!/usr/bin/env python3
"""Cron scheduler for talon agents — Mattermost is the delivery bus.

Reads job definitions from two places:
  - /app/runtime/cron.yaml          (git-managed, baked into the image)
  - /home/claude/shared/cron.d/*.yaml  (PVC, agent-writable: quick schedules)

At fire time, posts the job's prompt into its Mattermost channel as the
`cron` bot, @-mentioning the target agent. Delivery then rides the normal
channel pipeline: the mention-gated agent-to-agent path (`cron` must be in
the agent's ALLOWED_BOTS), catch-up replay if the agent was down, threaded
replies as the audit trail.

Job schema (one `jobs:` list per file):
  jobs:
    - name: morning-briefing       # unique key (state is tracked per name)
      agent: assistant             # who gets @-mentioned
      channel: assistant           # channel NAME the cron bot posts into
      schedule: "0 8 * * 1-5"      # 5-field cron expression
      tz: Europe/London            # IANA timezone (default UTC)
      prompt: |
        Post the morning briefing: ...
      enabled: true
      misfire: skip                # skip (default) | fire_late — what to do
                                   # when a fire time passed while the
                                   # scheduler was down (> grace window)

State (last fire per job) lives in /home/claude/shared/cron-state.json.
The loop ticks every 30s; runs forever (supervised via tmux by entrypoint.sh).
Env: MM_URL, MM_BOT_TOKEN_CRON. One-shot test: --once --force-job <name>.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import yaml
from croniter import croniter

MANAGED_FILE = os.environ.get("TALON_CRON_FILE", "/app/runtime/cron.yaml")
RUNTIME_DIR = os.environ.get("TALON_CRON_DIR", "/home/claude/shared/cron.d")
STATE_FILE = os.environ.get("TALON_CRON_STATE", "/home/claude/shared/cron-state.json")
MM_URL = os.environ.get("MM_URL", "http://mattermost-team-edition.apps:8065").rstrip("/")
TOKEN = os.environ.get("MM_BOT_TOKEN_CRON", "")
TICK_SECS = 30
GRACE = timedelta(minutes=10)  # a fire older than this is a misfire
DEFAULT_TZ = os.environ.get("TALON_CRON_TZ", "UTC")

_channel_cache: dict[str, str] = {}


def log(msg: str) -> None:
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}", flush=True)


def api(method: str, path: str, body: dict | None = None) -> dict | list:
    req = urllib.request.Request(
        f"{MM_URL}/api/v4{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def resolve_channel(name: str) -> str | None:
    if name in _channel_cache:
        return _channel_cache[name]
    try:
        for team in api("GET", "/users/me/teams"):
            try:
                ch = api("GET", f"/teams/{team['id']}/channels/name/{urllib.parse.quote(name)}")
                if isinstance(ch, dict) and ch.get("type"):
                    _channel_cache[name] = ch["id"]
                    return ch["id"]
            except urllib.error.HTTPError:
                continue
    except OSError as e:
        log(f"WARN channel resolution failed for {name}: {e}")
    return None


def load_jobs() -> list[dict]:
    jobs: list[dict] = []
    paths = [MANAGED_FILE]
    if os.path.isdir(RUNTIME_DIR):
        paths += sorted(
            os.path.join(RUNTIME_DIR, f) for f in os.listdir(RUNTIME_DIR) if f.endswith((".yaml", ".yml"))
        )
    seen: set[str] = set()
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            data = yaml.safe_load(open(path)) or {}
        except yaml.YAMLError as e:
            log(f"WARN skipping unparseable {path}: {e}")
            continue
        for job in data.get("jobs") or []:
            name = job.get("name")
            if not name or not job.get("agent") or not job.get("channel") or not job.get("schedule") or not job.get("prompt"):
                log(f"WARN skipping malformed job in {path}: {job.get('name', '<unnamed>')}")
                continue
            if name in seen:
                log(f"WARN duplicate job name '{name}' in {path}; first definition wins")
                continue
            seen.add(name)
            if not croniter.is_valid(str(job["schedule"])):
                log(f"WARN job '{name}': invalid schedule '{job['schedule']}'")
                continue
            jobs.append(job)
    return jobs


def load_state() -> dict:
    try:
        return json.load(open(STATE_FILE))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=1)
    os.replace(tmp, STATE_FILE)


def fire(job: dict) -> bool:
    channel_id = resolve_channel(str(job["channel"]))
    if not channel_id:
        log(f"ERROR job '{job['name']}': channel '{job['channel']}' not resolvable; skipping")
        return False
    message = f"@{job['agent']} {str(job['prompt']).strip()}\n\n_(cron: {job['name']})_"
    try:
        api("POST", "/posts", {"channel_id": channel_id, "message": message})
        log(f"fired '{job['name']}' -> @{job['agent']} in {job['channel']}")
        return True
    except (OSError, urllib.error.HTTPError) as e:
        log(f"ERROR job '{job['name']}': post failed: {e}")
        return False


def due_fire_time(job: dict, last_fire: datetime | None, now: datetime) -> datetime | None:
    """Most recent scheduled time <= now that hasn't been fired yet, or None."""
    tz = ZoneInfo(str(job.get("tz", DEFAULT_TZ)))
    prev = croniter(str(job["schedule"]), now.astimezone(tz)).get_prev(datetime)
    prev_utc = prev.astimezone(timezone.utc)
    if last_fire is not None and prev_utc <= last_fire:
        return None  # already fired this slot
    if now - prev_utc > GRACE and str(job.get("misfire", "skip")) != "fire_late":
        return None  # missed while down; policy says skip (state advances below)
    return prev_utc


def tick(state: dict, force_job: str | None = None) -> None:
    now = datetime.now(timezone.utc)
    for job in load_jobs():
        name = str(job["name"])
        if force_job and name == force_job:
            if fire(job):
                state[name] = now.isoformat()
            continue
        if not job.get("enabled", False):
            continue
        last_raw = state.get(name)
        last = datetime.fromisoformat(last_raw) if last_raw else None
        due = due_fire_time(job, last, now)
        tz = ZoneInfo(str(job.get("tz", DEFAULT_TZ)))
        prev_utc = croniter(str(job["schedule"]), now.astimezone(tz)).get_prev(datetime).astimezone(timezone.utc)
        if due is None:
            # advance state past skipped misfires so they don't re-trigger debate
            if last is None or prev_utc > last:
                if last is not None and now - prev_utc > GRACE:
                    log(f"misfire skipped for '{name}' (slot {prev_utc.isoformat()})")
                state[name] = prev_utc.isoformat()
            continue
        if fire(job):
            state[name] = due.isoformat()
    save_state(state)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true", help="single tick, then exit")
    parser.add_argument("--force-job", help="fire this job name immediately (with --once)")
    parser.add_argument("--list", action="store_true", help="list loaded jobs and exit")
    args = parser.parse_args()

    if args.list:
        for job in load_jobs():
            print(
                f"{'on ' if job.get('enabled') else 'OFF'} {job['name']}: "
                f"'{job['schedule']}' tz={job.get('tz', DEFAULT_TZ)} -> @{job['agent']} in {job['channel']}"
            )
        return 0

    if not TOKEN:
        log("FATAL: MM_BOT_TOKEN_CRON not set")
        return 1

    state = load_state()
    if args.once:
        tick(state, force_job=args.force_job)
        return 0

    log(f"cron scheduler started ({len(load_jobs())} job(s) loaded)")
    while True:
        try:
            tick(state)
        except Exception as e:  # never die on a bad tick; supervisor restarts on crash anyway
            log(f"ERROR tick failed: {e}")
        time.sleep(TICK_SECS)


if __name__ == "__main__":
    sys.exit(main())
