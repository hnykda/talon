/**
 * Persisted state: last_seen create_at per channel (for catch-up) and the
 * set of thread root ids the bot participates in (for thread-follow).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';

const MAX_THREADS = 1000;
const SAVE_DEBOUNCE_MS = 500;

interface PersistedState {
  lastSeen?: Record<string, number>;
  participatingThreads?: string[];
}

export class StateStore {
  private lastSeen = new Map<string, number>();
  private threads: string[] = []; // insertion order, for eviction
  private threadSet = new Set<string>();
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log('info', `No state file at ${this.filePath}; starting fresh`);
        return;
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      for (const [channelId, ts] of Object.entries(parsed.lastSeen ?? {})) {
        if (typeof ts === 'number' && Number.isFinite(ts)) this.lastSeen.set(channelId, ts);
      }
      for (const rootId of parsed.participatingThreads ?? []) {
        if (typeof rootId === 'string' && rootId && !this.threadSet.has(rootId)) {
          this.threads.push(rootId);
          this.threadSet.add(rootId);
        }
      }
      log('info', `Loaded state: ${this.lastSeen.size} channel watermark(s), ${this.threads.length} thread(s)`);
    } catch (err) {
      log('warn', `State file ${this.filePath} is corrupt, starting fresh: ${(err as Error).message}`);
      this.lastSeen.clear();
      this.threads = [];
      this.threadSet.clear();
    }
  }

  getLastSeen(channelId: string): number {
    return this.lastSeen.get(channelId) ?? 0;
  }

  noteSeen(channelId: string, createAt: number): void {
    if (!Number.isFinite(createAt)) return;
    if (createAt > (this.lastSeen.get(channelId) ?? 0)) {
      this.lastSeen.set(channelId, createAt);
      this.markDirty();
    }
  }

  get participatingThreads(): ReadonlySet<string> {
    return this.threadSet;
  }

  addParticipatingThread(rootId: string): void {
    if (!rootId || this.threadSet.has(rootId)) return;
    this.threads.push(rootId);
    this.threadSet.add(rootId);
    while (this.threads.length > MAX_THREADS) {
      const evicted = this.threads.shift();
      if (evicted !== undefined) this.threadSet.delete(evicted);
    }
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  /** Synchronous flush; safe to call on shutdown. */
  saveNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const data: PersistedState = {
      lastSeen: Object.fromEntries(this.lastSeen),
      participatingThreads: [...this.threads],
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.filePath);
    } catch (err) {
      log('error', `Failed to persist state to ${this.filePath}: ${(err as Error).message}`);
    }
  }
}
