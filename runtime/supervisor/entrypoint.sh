#!/usr/bin/env bash
# talon supervisor — runs one persistent *interactive* Claude Code session per
# enabled agent (from agents.yaml), each in its own tmux session, bridged to
# Mattermost via the channel-server MCP server declared in the agent's
# .mcp.json.
#
# Lifecycle:
#   1. For each enabled agent: ensure its workdir exists on the PVC, then
#      reconcile MANAGED entries as read-only symlinks into the image
#      (git-controlled: CLAUDE.md, .mcp.json, .claude/settings.json,
#      .claude/agents/, .claude/skills/ -> /app/runtime/agents/<name>/...).
#      Shared entries are linked once per boot (~/.claude/CLAUDE.md and
#      ~/.claude/skills -> /app/runtime/shared/...). Everything else in the
#      workdir is runtime state (MEMORY.md, memory/, scratch/, ...) and is
#      NEVER overwritten (agent state is precious). Pre-existing real files at
#      managed paths are moved aside as *.pre-symlink.<ts>, never deleted.
#   2. Render the per-agent env file (.agent-env, mode 600) and launch script
#      (.agent-launch.sh). Values in the registry's env map of the exact form
#      "$NAME" / "${NAME}" are dereferenced against the pod environment at
#      render time (lets agents.yaml alias secrets, e.g. GH_TOKEN:
#      "$GH_TOKEN_OPS"). If a .mcp.json.tmpl exists in the workdir it is
#      rendered with envsubst; otherwise the plain .mcp.json relies on Claude
#      Code's native ${VAR}/${VAR:-default} expansion (documented behavior).
#   3. Start tmux session "agent-<name>" running:
#        claude --agent <name> [--continue] \
#          --dangerously-load-development-channels server:mattermost \
#          --dangerously-skip-permissions
#   4. Health loop (every HEALTH_INTERVAL seconds): restart dead sessions with
#      exponential backoff, touch /tmp/healthy (k8s liveness probe runs
#      `cat /tmp/healthy`). The probe checks supervisor health, not agent
#      health — a crash-looping agent is restarted in-pod and must not nuke
#      its siblings' sessions via a pod restart.
#   5. SIGTERM: remove the health file, kill the tmux server, exit 0.
#
# --continue policy (documented choice): we detect a previous session by
# looking for transcripts under ~/.claude/projects/<munged-workdir>/*.jsonl
# and pass --continue only when one exists, so a fresh PVC boots cleanly.
# If a --continue start dies within FAST_FAIL_SECS we assume the stored
# session is unusable, log it, and permanently (until next pod start) fall
# back to a fresh session for that agent instead of crash-looping.

set -euo pipefail

AGENTS_FILE="${TALON_AGENTS_FILE:-/app/runtime/agents.yaml}"
SKELETON_ROOT="${TALON_SKELETON_ROOT:-/app/runtime/agents}"
SHARED_ROOT="${TALON_SHARED_ROOT:-/app/runtime/shared}"
AGENT_HOME_DEFAULT="${TALON_AGENT_HOME:-/home/claude/agents}"
HEALTH_FILE="${TALON_HEALTH_FILE:-/tmp/healthy}"
HEALTH_INTERVAL="${TALON_HEALTH_INTERVAL:-30}"
BACKOFF_BASE="${TALON_BACKOFF_BASE:-5}"
BACKOFF_MAX="${TALON_BACKOFF_MAX:-300}"
# A session that dies sooner than this after a --continue start is treated as
# a broken stored session (must be > HEALTH_INTERVAL so the first health tick
# after the death still falls inside the window).
FAST_FAIL_SECS="${TALON_FAST_FAIL_SECS:-45}"
# A session alive longer than this resets its failure/backoff counter.
STABLE_SECS="${TALON_STABLE_SECS:-120}"
# Transcript archival loop: every ARCHIVE_INTERVAL seconds, ingest new
# session-transcript content into the FTS archive on the PVC (so compaction
# never permanently loses history). 0 disables.
ARCHIVE_INTERVAL="${TALON_ARCHIVE_INTERVAL:-21600}"
ARCHIVE_SCRIPT="${TALON_ARCHIVE_SCRIPT:-/app/runtime/tools/archive_transcripts.py}"
# After each archive ingest, embed new entries into the semantic index
# (skipped when VOYAGE_API_KEY is absent).
SEMANTIC_SCRIPT="${TALON_SEMANTIC_SCRIPT:-/app/runtime/tools/semantic_search.py}"
# Cron scheduler (skipped when MM_BOT_TOKEN_CRON is absent): posts scheduled
# prompts to agents via Mattermost as the `cron` bot. Runs in its own tmux
# session, restarted by the health loop like the agents.
CRON_SCRIPT="${TALON_CRON_SCRIPT:-/app/runtime/tools/cron_scheduler.py}"
# How long to wait for Mattermost before starting agents (pod boot races
# cluster DNS/Mattermost; an unreachable MM kills each session's MCP channel
# server permanently, since Claude Code never relaunches a failed MCP server).
MM_WAIT_SECS="${TALON_MM_WAIT_SECS:-120}"

log() { printf '[supervisor] %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

wait_for_mattermost() {
  local url="${MM_URL:-http://mattermost-team-edition.apps:8065}"
  local deadline=$(( $(date +%s) + MM_WAIT_SECS ))
  while ! curl -sf --max-time 3 "$url/api/v4/system/ping" >/dev/null 2>&1; do
    if (( $(date +%s) >= deadline )); then
      log "WARNING: Mattermost not reachable at $url after ${MM_WAIT_SECS}s; starting agents anyway (channel servers will retry briefly)"
      return 0
    fi
    log "waiting for Mattermost at $url ..."
    sleep 3
  done
  log "Mattermost reachable at $url"
}

# ---------------------------------------------------------------------------
# Registry parsing (mikefarah yq v4)
# ---------------------------------------------------------------------------
declare -a AGENT_NAME=() AGENT_WORKDIR=() AGENT_TOKEN_VAR=() AGENT_IDX=() AGENT_EFFORT=()
declare -a AGENT_STARTED_AT=() AGENT_FAILS=() AGENT_NEXT_TRY=()
declare -a AGENT_USED_CONTINUE=() AGENT_NO_CONTINUE=()

load_registry() {
  if [[ ! -f "$AGENTS_FILE" ]]; then
    log "FATAL: agents file not found: $AGENTS_FILE"
    exit 1
  fi
  local total i name enabled workdir token_var
  total="$(yq '.agents | length' "$AGENTS_FILE")"
  if [[ -z "$total" || "$total" == "null" || "$total" -eq 0 ]]; then
    log "FATAL: no agents defined in $AGENTS_FILE"
    exit 1
  fi
  for ((i = 0; i < total; i++)); do
    enabled="$(yq ".agents[$i].enabled // false" "$AGENTS_FILE")"
    name="$(yq ".agents[$i].name // \"\"" "$AGENTS_FILE")"
    if [[ "$enabled" != "true" ]]; then
      log "skipping disabled agent: ${name:-<unnamed #$i>}"
      continue
    fi
    if [[ -z "$name" ]]; then
      log "FATAL: agent #$i is enabled but has no name"
      exit 1
    fi
    workdir="$(yq ".agents[$i].workdir // \"\"" "$AGENTS_FILE")"
    [[ -z "$workdir" ]] && workdir="$AGENT_HOME_DEFAULT/$name"
    token_var="$(yq ".agents[$i].botTokenEnvVar // \"\"" "$AGENTS_FILE")"
    AGENT_NAME+=("$name")
    AGENT_WORKDIR+=("$workdir")
    AGENT_TOKEN_VAR+=("$token_var")
    AGENT_IDX+=("$i")
    # optional per-session thinking effort (low|medium|high|xhigh|max),
    # passed to claude as --effort
    AGENT_EFFORT+=("$(yq ".agents[$i].effort // \"\"" "$AGENTS_FILE")")
    AGENT_STARTED_AT+=(0)
    AGENT_FAILS+=(0)
    AGENT_NEXT_TRY+=(0)
    AGENT_USED_CONTINUE+=(0)
    AGENT_NO_CONTINUE+=(0)
  done
  if [[ "${#AGENT_NAME[@]}" -eq 0 ]]; then
    log "FATAL: no enabled agents in $AGENTS_FILE"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Claude Code onboarding pre-seed
# ---------------------------------------------------------------------------
# Interactive claude prompts for theme/trust/onboarding on first run, which
# would leave headless tmux sessions stuck on a dialog. Seed ~/.claude.json
# before launch: global onboarding flags once, plus a trusted-project entry
# per agent workdir. Existing user keys are preserved (merge, agent entries
# only added when missing). Verified working on Claude Code 2.1.170.
seed_claude_config() {
  local cfg="$HOME/.claude.json"
  python3 - "$cfg" "${AGENT_WORKDIR[@]}" <<'PYEOF'
import json, os, sys
cfg, workdirs = sys.argv[1], sys.argv[2:]
data = {}
if os.path.exists(cfg):
    try:
        with open(cfg) as f: data = json.load(f)
    except Exception: data = {}
data.setdefault("hasCompletedOnboarding", True)
data.setdefault("theme", "dark")
data.setdefault("bypassPermissionsModeAccepted", True)
projects = data.setdefault("projects", {})
for wd in workdirs:
    p = projects.setdefault(wd, {})
    p.setdefault("hasTrustDialogAccepted", True)
    p.setdefault("hasCompletedProjectOnboarding", True)
    p.setdefault("enableAllProjectMcpServers", True)
tmp = cfg + ".tmp"
with open(tmp, "w") as f: json.dump(data, f, indent=1)
os.replace(tmp, cfg)
print(f"[supervisor] seeded {cfg} ({len(workdirs)} project(s))", file=sys.stderr)
PYEOF
}

# ---------------------------------------------------------------------------
# Workdir provisioning — managed symlinks into the image (git-controlled)
# ---------------------------------------------------------------------------
# link_managed <target-in-image> <link-path>
# Idempotent. Managed paths are an explicit allowlist; anything else in the
# workdir is runtime state and is never touched. Pre-existing real files/dirs
# at a managed path (old seed-once copies, migrated state) are moved aside
# with a timestamped suffix — recoverable, never deleted.
link_managed() {
  local src="$1" dst="$2"
  if [[ ! -e "$src" ]]; then
    log "WARNING: managed source missing in image: $src (leaving $dst alone)"
    return 0
  fi
  if [[ -L "$dst" ]]; then
    [[ "$(readlink "$dst")" == "$src" ]] && return 0
    ln -sfn "$src" "$dst"
    log "repointed managed link $dst -> $src"
    return 0
  fi
  if [[ -e "$dst" ]]; then
    local bak
    bak="$dst.pre-symlink.$(date +%Y%m%d%H%M%S)"
    mv "$dst" "$bak"
    log "NOTICE: moved aside pre-existing $dst -> $bak"
  fi
  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  log "linked $dst -> $src"
}

ensure_workdir() {
  local name="$1" workdir="$2"
  local skeleton="$SKELETON_ROOT/$name"
  # Real directories the agent writes into; .claude/ itself must stay a real
  # dir (settings.local.json and other runtime files live next to the links).
  mkdir -p "$workdir/.claude" "$workdir/memory" "$workdir/scratch"
  if [[ ! -d "$skeleton" ]]; then
    log "WARNING: no skeleton at $skeleton; workdir for $name has no managed config"
    return 0
  fi
  link_managed "$skeleton/CLAUDE.md"               "$workdir/CLAUDE.md"
  link_managed "$skeleton/.mcp.json"               "$workdir/.mcp.json"
  link_managed "$skeleton/.claude/settings.json"   "$workdir/.claude/settings.json"
  link_managed "$skeleton/.claude/agents"          "$workdir/.claude/agents"
  if [[ -d "$skeleton/.claude/skills" ]]; then
    link_managed "$skeleton/.claude/skills"        "$workdir/.claude/skills"
  fi
}

# Shared, user-level config: HOME is one PVC shared by all agents, so
# ~/.claude/CLAUDE.md (global memory) and ~/.claude/skills apply to every
# session. ~/.claude itself is NEVER managed (credentials, projects/ live
# there); only these two entries inside it are.
reconcile_shared_links() {
  mkdir -p "$HOME/.claude"
  link_managed "$SHARED_ROOT/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  link_managed "$SHARED_ROOT/skills"    "$HOME/.claude/skills"
}

write_env_file() {
  local name="$1" workdir="$2" token_var="$3" reg_idx="$4"
  local env_file="$workdir/.agent-env" tmp pair key val
  tmp="$env_file.tmp"
  : > "$tmp"
  chmod 600 "$tmp"
  {
    printf '# generated by talon supervisor — do not edit\n'
    printf 'MM_URL=%q\n' "${MM_URL:-http://mattermost-team-edition.apps:8065}"
    if [[ -n "$token_var" ]]; then
      printf 'MM_BOT_TOKEN=%q\n' "${!token_var:-}"
    fi
    printf 'STATE_FILE=%q\n' "$workdir/.mattermost-state.json"
    while IFS= read -r pair; do
      [[ -z "$pair" ]] && continue
      key="${pair%%=*}"
      val="${pair#*=}"
      # Values of the exact form "$NAME" / "${NAME}" are dereferenced against
      # the pod env at render time (%q below would otherwise escape the "$"
      # and deliver the literal string). Anything else passes through as-is.
      if [[ "$val" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
        if [[ -z "${!BASH_REMATCH[1]:-}" ]]; then
          log "WARNING: $name env $key references unset pod var \$${BASH_REMATCH[1]}"
        fi
        val="${!BASH_REMATCH[1]:-}"
      fi
      printf '%s=%q\n' "$key" "$val"
    done < <(yq ".agents[$reg_idx].env // {} | to_entries[] | \"\(.key)=\(.value)\"" "$AGENTS_FILE")
  } >> "$tmp"
  mv "$tmp" "$env_file"
}

render_mcp_json() {
  # Optional escape hatch: if the workdir contains .mcp.json.tmpl, render it
  # with envsubst. Normally not needed — Claude Code expands ${VAR} and
  # ${VAR:-default} in .mcp.json env/command/args natively.
  local workdir="$1"
  if [[ -f "$workdir/.mcp.json.tmpl" ]]; then
    if [[ -L "$workdir/.mcp.json" ]]; then
      log "WARNING: $workdir/.mcp.json is a managed symlink; skipping .mcp.json.tmpl rendering"
      return 0
    fi
    (
      set -a
      # shellcheck disable=SC1091
      . "$workdir/.agent-env"
      set +a
      envsubst < "$workdir/.mcp.json.tmpl" > "$workdir/.mcp.json"
    )
    log "rendered .mcp.json from template in $workdir"
  fi
}

# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------
has_previous_session() {
  # Claude Code stores transcripts under ~/.claude/projects/<munged-cwd>/,
  # where the cwd path has '/' and '.' replaced by '-'.
  local workdir="$1" munged
  munged="${workdir//\//-}"
  munged="${munged//./-}"
  local dir="$HOME/.claude/projects/$munged"
  [[ -d "$dir" ]] && compgen -G "$dir/*.jsonl" > /dev/null
}

write_launch_script() {
  local name="$1" workdir="$2" continue_flag="$3" effort="$4"
  local effort_flag=""
  [[ -n "$effort" ]] && effort_flag="--effort $effort "
  local script="$workdir/.agent-launch.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf '# generated by talon supervisor — do not edit\n'
    printf 'set -a\n'
    printf '. ./.agent-env\n'
    printf 'set +a\n'
    # shellcheck disable=SC2016  # single-quoted on purpose: runs in the generated script
    printf 'exec claude --agent %q %s%s--dangerously-load-development-channels server:mattermost --dangerously-skip-permissions\n' \
      "$name" "$continue_flag" "$effort_flag"
  } > "$script"
  chmod 700 "$script"
}

maybe_autoconfirm() {
  # Best effort, OFF by default. The first boot of a fresh workdir can show
  # interactive dialogs in the tmux pane (workspace trust; dev-channels
  # confirmation — the flag is documented to prompt). The supported path is
  # to do this once manually: kubectl exec -it ... tmux attach (see README).
  # With TALON_CHANNELS_AUTOCONFIRM=1 we blindly send "y"+Enter a few times
  # shortly after start, which usually accepts those dialogs but can leak a
  # stray "y" into the prompt box. VERIFY before relying on it.
  local name="$1"
  [[ "${TALON_CHANNELS_AUTOCONFIRM:-0}" == "1" ]] || return 0
  (
    sleep "${TALON_AUTOCONFIRM_DELAY:-10}"
    local _i
    for _i in 1 2 3; do
      tmux send-keys -t "agent-$name" y Enter 2>/dev/null || true
      sleep 3
    done
  ) &
}

start_agent() {
  local i="$1"
  local name="${AGENT_NAME[$i]}" workdir="${AGENT_WORKDIR[$i]}"
  local token_var="${AGENT_TOKEN_VAR[$i]}" reg_idx="${AGENT_IDX[$i]}"
  local continue_flag=""

  ensure_workdir "$name" "$workdir"
  write_env_file "$name" "$workdir" "$token_var" "$reg_idx"
  render_mcp_json "$workdir"

  if [[ "${AGENT_NO_CONTINUE[$i]}" != "1" ]] && has_previous_session "$workdir"; then
    continue_flag="--continue "
    AGENT_USED_CONTINUE[i]=1
  else
    AGENT_USED_CONTINUE[i]=0
  fi
  write_launch_script "$name" "$workdir" "$continue_flag" "${AGENT_EFFORT[$i]}"

  tmux new-session -d -s "agent-$name" -c "$workdir" "$workdir/.agent-launch.sh"
  AGENT_STARTED_AT[i]="$(date +%s)"
  log "started tmux session agent-$name (workdir=$workdir continue=${AGENT_USED_CONTINUE[$i]})"
  maybe_autoconfirm "$name"
}

# ---------------------------------------------------------------------------
# Cron scheduler
# ---------------------------------------------------------------------------
start_cron_scheduler() {
  [[ -n "${MM_BOT_TOKEN_CRON:-}" && -f "$CRON_SCRIPT" ]] || return 0
  tmux has-session -t talon-cron 2>/dev/null && return 0
  # Log to the PVC (tmux pane output is not visible in pod logs).
  tmux new-session -d -s talon-cron \
    "python3 '$CRON_SCRIPT' >> /home/claude/shared/cron-scheduler.log 2>&1"
  log "started tmux session talon-cron (scheduler; log: /home/claude/shared/cron-scheduler.log)"
}

# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------
shutdown() {
  log "caught termination signal; shutting down"
  rm -f "$HEALTH_FILE"
  # Graceful-ish: kill the tmux server, which sends SIGHUP to the claude
  # processes. Sessions are resumable later via --continue from the PVC.
  tmux kill-server 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  log "talon supervisor starting (agents file: $AGENTS_FILE)"
  load_registry
  reconcile_shared_links
  seed_claude_config
  wait_for_mattermost

  local i now backoff name
  for i in "${!AGENT_NAME[@]}"; do
    if ! start_agent "$i"; then
      log "ERROR: initial start of agent-${AGENT_NAME[$i]} failed; health loop will retry"
      AGENT_FAILS[i]=1
      AGENT_NEXT_TRY[i]="$(($(date +%s) + BACKOFF_BASE))"
    fi
  done
  touch "$HEALTH_FILE"

  start_cron_scheduler

  local last_archive=0
  while true; do
    # Sleep in the background so the TERM trap fires immediately.
    sleep "$HEALTH_INTERVAL" &
    wait "$!" || true

    now="$(date +%s)"
    start_cron_scheduler  # no-op while the session is alive

    # Periodic transcript archival + semantic indexing (backgrounded;
    # incremental, cheap; python3 is the talon-tools venv via PATH).
    if (( ARCHIVE_INTERVAL > 0 && now - last_archive >= ARCHIVE_INTERVAL )); then
      last_archive="$now"
      if [[ -f "$ARCHIVE_SCRIPT" ]]; then
        (
          python3 "$ARCHIVE_SCRIPT" 2>&1 | while IFS= read -r l; do log "archive: $l"; done
          if [[ -n "${VOYAGE_API_KEY:-}" && -f "$SEMANTIC_SCRIPT" ]]; then
            python3 "$SEMANTIC_SCRIPT" index 2>&1 | while IFS= read -r l; do log "semantic: $l"; done
          fi
        ) &
      fi
    fi
    for i in "${!AGENT_NAME[@]}"; do
      name="${AGENT_NAME[$i]}"
      if tmux has-session -t "agent-$name" 2>/dev/null; then
        if (( AGENT_FAILS[i] > 0 && now - AGENT_STARTED_AT[i] > STABLE_SECS )); then
          AGENT_FAILS[i]=0
          log "agent-$name stable for ${STABLE_SECS}s; backoff reset"
        fi
        continue
      fi

      # Session is dead.
      if (( AGENT_USED_CONTINUE[i] == 1 && now - AGENT_STARTED_AT[i] < FAST_FAIL_SECS )); then
        AGENT_NO_CONTINUE[i]=1
        log "agent-$name died within ${FAST_FAIL_SECS}s of a --continue start; falling back to a fresh session"
      fi

      if (( now >= AGENT_NEXT_TRY[i] )); then
        AGENT_FAILS[i]="$((AGENT_FAILS[i] + 1))"
        backoff="$((BACKOFF_BASE * (2 ** (AGENT_FAILS[i] - 1))))"
        (( backoff > BACKOFF_MAX )) && backoff="$BACKOFF_MAX"
        AGENT_NEXT_TRY[i]="$((now + backoff))"
        log "agent-$name is dead; restarting (failure #${AGENT_FAILS[$i]}, next backoff ${backoff}s)"
        if ! start_agent "$i"; then
          log "ERROR: restart of agent-$name failed; will retry after backoff"
        fi
      fi
    done

    # Liveness: the supervisor loop is running. Per-agent recovery is handled
    # above; a pod restart would kill healthy sibling agents, so agent death
    # alone must not fail the probe.
    touch "$HEALTH_FILE"
  done
}

main "$@"
