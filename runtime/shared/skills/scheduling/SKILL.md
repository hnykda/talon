---
name: scheduling
description: "Create, list, and manage scheduled jobs (cron) for yourself or other agents: reminders, daily briefings, recurring checks, heartbeats. Use when someone asks to 'remind me', 'every day at', 'schedule', 'weekly', 'recurring', or asks what jobs are scheduled. Jobs are delivered as Mattermost posts from the @cron bot mentioning the target agent."
---

# Scheduling (cron jobs)

A scheduler posts job prompts into Mattermost as **@cron**, @-mentioning the
target agent at fire time; replies thread under the post. If the agent was
down, catch-up delivers on reconnect.

```bash
python3 /app/runtime/tools/cron_scheduler.py --list     # all jobs, on/OFF
tail -20 /home/claude/shared/cron-scheduler.log         # recent firings
```

**Create a quick/personal job** (effective within ~30s): copy
`JOB_TEMPLATE.yaml` from this skill directory to
`/home/claude/shared/cron.d/<job-name>.yaml` and edit it. Stop a job: set
`enabled: false` or delete the file. Durable/system jobs live in git
(`runtime/cron.yaml` in the talon repo, changed by PR + image rebuild) —
promote a personal job there once proven.

Notes: the @cron bot must be in the target channel (it can self-join public
ones); `misfire: skip` for reminders, `fire_late` for idempotent work; write
prompts as complete instructions to your future self; confirm schedules in
the human's timezone.
