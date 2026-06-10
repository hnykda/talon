import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MM_URL: 'https://mm.example.com',
    MM_BOT_TOKEN: 'token',
    ALLOWED_USERS: 'alice',
    ...overrides,
  };
}

describe('loadConfig ack/typing settings', () => {
  it('defaults: typing on, 120s cap, eyes reaction', () => {
    const config = loadConfig(baseEnv());
    expect(config.typingEnabled).toBe(true);
    expect(config.typingMaxSeconds).toBe(120);
    expect(config.ackReaction).toBe('eyes');
  });

  it('TYPING_INDICATOR=false disables typing', () => {
    expect(loadConfig(baseEnv({ TYPING_INDICATOR: 'false' })).typingEnabled).toBe(false);
  });

  it('accepts a custom TYPING_MAX_SECONDS', () => {
    expect(loadConfig(baseEnv({ TYPING_MAX_SECONDS: '300' })).typingMaxSeconds).toBe(300);
  });

  it.each(['0', '4', '3601', 'abc', '12.5'])('rejects TYPING_MAX_SECONDS=%s', (value) => {
    expect(() => loadConfig(baseEnv({ TYPING_MAX_SECONDS: value }))).toThrow(ConfigError);
  });

  it('accepts a custom ACK_REACTION emoji name', () => {
    expect(loadConfig(baseEnv({ ACK_REACTION: 'robot_face' })).ackReaction).toBe('robot_face');
  });

  it.each(['', 'none', 'NONE'])('ACK_REACTION=%j disables the reaction', (value) => {
    expect(loadConfig(baseEnv({ ACK_REACTION: value })).ackReaction).toBe('');
  });

  it('rejects ACK_REACTION values that are not emoji names', () => {
    expect(() => loadConfig(baseEnv({ ACK_REACTION: ':eyes:' }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ ACK_REACTION: 'two words' }))).toThrow(ConfigError);
  });
});

describe('loadConfig per-channel mode suffixes', () => {
  it('parses bare entries with no overrides', () => {
    const config = loadConfig(baseEnv({ LISTEN_CHANNELS: 'alpha,beta', CHANNEL_MODE: 'all' }));
    expect(config.listenChannels).toEqual(['alpha', 'beta']);
    expect(config.channelModeOverrides).toEqual({});
  });

  it('parses :mention / :all suffixes into overrides', () => {
    const config = loadConfig(
      baseEnv({ LISTEN_CHANNELS: 'work-chan,test-chan:mention,loud-chan:all', CHANNEL_MODE: 'all' }),
    );
    expect(config.listenChannels).toEqual(['work-chan', 'test-chan', 'loud-chan']);
    expect(config.channelModeOverrides).toEqual({ 'test-chan': 'mention', 'loud-chan': 'all' });
  });

  it('suffix is case-insensitive and trimmed', () => {
    const config = loadConfig(baseEnv({ LISTEN_CHANNELS: 'chan: MENTION ' }));
    expect(config.channelModeOverrides).toEqual({ chan: 'mention' });
  });

  it.each(['chan:sometimes', ':mention', 'chan:'])('rejects invalid entry "%s"', (entry) => {
    expect(() => loadConfig(baseEnv({ LISTEN_CHANNELS: entry }))).toThrow(ConfigError);
  });
});

describe('loadConfig ALLOWED_BOTS', () => {
  it('defaults to empty (a2a off)', () => {
    expect(loadConfig(baseEnv()).allowedBots).toEqual([]);
  });
  it('parses a comma-separated list', () => {
    expect(loadConfig(baseEnv({ ALLOWED_BOTS: 'peer1, peer2,peer3' })).allowedBots).toEqual(['peer1', 'peer2', 'peer3']);
  });
});
