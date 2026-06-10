/**
 * Sustains the native Mattermost "X is typing..." indicator for channels
 * where a forwarded message is awaiting the agent's reply.
 *
 * Pure timer bookkeeping — no I/O. The caller injects the actual send
 * function (MattermostClient.sendTyping). Clients display the indicator for
 * TimeBetweenUserTypingUpdatesMilliseconds (default 5000ms) after each
 * user_typing event, so refreshing every 4000ms keeps it lit without flicker.
 */
import { log } from './log.js';

export type TypingSendFn = (channelId: string, parentId: string) => void;

export interface TypingManagerOptions {
  /** Interval between user_typing refreshes. Must stay below the client display TTL (5000ms default). */
  refreshMs: number;
  /** Hard cap per start(); the agent may legitimately never reply, so the indicator must self-expire. */
  maxMs: number;
}

interface Entry {
  timer: NodeJS.Timeout;
  deadline: number;
  parentId: string;
}

export class TypingManager {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly send: TypingSendFn,
    private readonly opts: TypingManagerOptions,
  ) {}

  /**
   * Begin (or restart) typing in a channel. One entry per channel: a newer
   * forwarded post replaces the previous parentId and resets the deadline.
   */
  start(channelId: string, parentId: string): void {
    this.stop(channelId);
    const deadline = Date.now() + this.opts.maxMs;
    this.trySend(channelId, parentId);
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        this.stop(channelId);
        return;
      }
      this.trySend(channelId, parentId);
    }, this.opts.refreshMs);
    timer.unref();
    this.entries.set(channelId, { timer, deadline, parentId });
  }

  stop(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.entries.delete(channelId);
  }

  stopAll(): void {
    for (const channelId of [...this.entries.keys()]) this.stop(channelId);
  }

  private trySend(channelId: string, parentId: string): void {
    try {
      this.send(channelId, parentId);
    } catch (err) {
      log('debug', `typing send failed for ${channelId}: ${(err as Error).message}`);
    }
  }
}
