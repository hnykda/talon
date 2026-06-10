import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypingManager } from '../src/typing.js';

const REFRESH_MS = 4000;
const MAX_MS = 120_000;

describe('TypingManager', () => {
  let sent: Array<{ channelId: string; parentId: string }>;
  let manager: TypingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    manager = new TypingManager((channelId, parentId) => sent.push({ channelId, parentId }), {
      refreshMs: REFRESH_MS,
      maxMs: MAX_MS,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends immediately on start with the given channel and parent', () => {
    manager.start('chan1', 'root1');
    expect(sent).toEqual([{ channelId: 'chan1', parentId: 'root1' }]);
  });

  it('refreshes every refreshMs while active', () => {
    manager.start('chan1', '');
    vi.advanceTimersByTime(3 * REFRESH_MS);
    expect(sent).toHaveLength(4); // immediate + 3 refreshes
    expect(sent.every((s) => s.channelId === 'chan1' && s.parentId === '')).toBe(true);
  });

  it('stop() halts refreshes', () => {
    manager.start('chan1', '');
    manager.stop('chan1');
    vi.advanceTimersByTime(10 * REFRESH_MS);
    expect(sent).toHaveLength(1);
  });

  it('self-expires at maxMs and a later start works again', () => {
    manager.start('chan1', '');
    vi.advanceTimersByTime(MAX_MS + REFRESH_MS);
    const afterExpiry = sent.length;
    vi.advanceTimersByTime(10 * REFRESH_MS);
    expect(sent.length).toBe(afterExpiry); // no sends past the deadline

    manager.start('chan1', 'root2');
    vi.advanceTimersByTime(REFRESH_MS);
    expect(sent.length).toBe(afterExpiry + 2);
    expect(sent.at(-1)).toEqual({ channelId: 'chan1', parentId: 'root2' });
  });

  it('restart on the same channel replaces parentId and resets the deadline', () => {
    manager.start('chan1', 'rootA');
    vi.advanceTimersByTime(MAX_MS - REFRESH_MS);
    manager.start('chan1', 'rootB');
    const beforeAdvance = sent.length;
    // Past the original deadline but within the new one: still ticking, all with rootB.
    vi.advanceTimersByTime(2 * REFRESH_MS);
    const newSends = sent.slice(beforeAdvance);
    expect(newSends).toHaveLength(2);
    expect(newSends.every((s) => s.parentId === 'rootB')).toBe(true);
  });

  it('tracks channels independently', () => {
    manager.start('chan1', '');
    manager.start('chan2', 'root2');
    manager.stop('chan1');
    vi.advanceTimersByTime(2 * REFRESH_MS);
    const chan1Sends = sent.filter((s) => s.channelId === 'chan1');
    const chan2Sends = sent.filter((s) => s.channelId === 'chan2');
    expect(chan1Sends).toHaveLength(1); // only the immediate send
    expect(chan2Sends).toHaveLength(3); // immediate + 2 refreshes
  });

  it('stopAll() clears everything; stop() on an unknown channel is a no-op', () => {
    manager.start('chan1', '');
    manager.start('chan2', '');
    manager.stopAll();
    manager.stop('never-started');
    vi.advanceTimersByTime(10 * REFRESH_MS);
    expect(sent).toHaveLength(2);
  });

  it('a throwing sender does not kill the refresh loop', () => {
    let calls = 0;
    const throwing = new TypingManager(
      () => {
        calls += 1;
        throw new Error('ws hiccup');
      },
      { refreshMs: REFRESH_MS, maxMs: MAX_MS },
    );
    expect(() => throwing.start('chan1', '')).not.toThrow();
    vi.advanceTimersByTime(2 * REFRESH_MS);
    expect(calls).toBe(3);
  });
});
