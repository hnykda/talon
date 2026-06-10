import { describe, expect, it } from 'vitest';
import {
  mentionsUser,
  route,
  type RouterChannelInfo,
  type RouterConfig,
  type RouterPost,
  type RouterSender,
  type RouterState,
} from '../src/router.js';

const BOT_ID = 'botbotbotbotbotbotbotbot01';
const ADMIN_ID = 'adminadminadminadminadmin1';
const STRANGER_ID = 'strangerstrangerstranger01';
const BOUND_CHANNEL = 'boundboundboundboundbound1';
const OTHER_CHANNEL = 'otherotherotherotherother1';
const DM_CHANNEL = 'dmdmdmdmdmdmdmdmdmdmdmdm01';

function makeConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    botUserId: BOT_ID,
    botUsername: 'talon',
    boundChannelIds: new Set([BOUND_CHANNEL]),
    channelMode: 'mention',
    allowedUserIds: new Set([ADMIN_ID]),
    allowedUsernames: new Set(['alice']),
    dmEnabled: true,
    ...overrides,
  };
}

function makePost(overrides: Partial<RouterPost> = {}): RouterPost {
  return {
    id: 'post0000000000000000000001',
    channel_id: BOUND_CHANNEL,
    root_id: '',
    message: 'hello there',
    user_id: ADMIN_ID,
    create_at: 1_700_000_000_000,
    ...overrides,
  };
}

const admin: RouterSender = { id: ADMIN_ID, username: 'alice', isBot: false };
const allowedByName: RouterSender = { id: 'someothervaliduserid00001', username: 'Alice', isBot: false };
const stranger: RouterSender = { id: STRANGER_ID, username: 'mallory', isBot: false };
const botSelf: RouterSender = { id: BOT_ID, username: 'talon', isBot: true };
const otherBot: RouterSender = { id: 'otherbototherbototherbot01', username: 'webhook-bot', isBot: true };

const boundChannel: RouterChannelInfo = { id: BOUND_CHANNEL, type: 'O', name: 'ops', display_name: 'Ops' };
const otherChannel: RouterChannelInfo = { id: OTHER_CHANNEL, type: 'O', name: 'random', display_name: 'Random' };
const dmChannel: RouterChannelInfo = { id: DM_CHANNEL, type: 'D', name: `${ADMIN_ID}__${BOT_ID}`, display_name: 'alice' };

const noThreads: RouterState = { participatingThreads: new Set<string>() };

describe('mentionsUser', () => {
  it('matches plain @mention', () => {
    expect(mentionsUser('hey @talon what is up', 'talon')).toBe(true);
  });
  it('matches at start and end of message, case-insensitively', () => {
    expect(mentionsUser('@talon hi', 'talon')).toBe(true);
    expect(mentionsUser('ping @Talon', 'talon')).toBe(true);
  });
  it('does not match prefixes of longer usernames', () => {
    expect(mentionsUser('hey @talon2 hello', 'talon')).toBe(false);
    expect(mentionsUser('hey @talon-bot hello', 'talon')).toBe(false);
    expect(mentionsUser('hey @talon.dev hello', 'talon')).toBe(false);
  });
  it('does not match bare username without @', () => {
    expect(mentionsUser('talon is a god', 'talon')).toBe(false);
  });
  it('matches mention followed by punctuation', () => {
    expect(mentionsUser('@talon, run the deploy', 'talon')).toBe(true);
    expect(mentionsUser('(@talon)', 'talon')).toBe(true);
  });
});

describe('route: own posts and bots', () => {
  it('drops the bot\'s own posts', () => {
    const d = route(makePost({ user_id: BOT_ID }), botSelf, boundChannel, makeConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'own_post' });
  });

  it('drops posts from other bot accounts', () => {
    const d = route(makePost({ user_id: otherBot.id }), otherBot, boundChannel, makeConfig({ channelMode: 'all' }), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'bot_sender' });
  });

  it('drops posts flagged with props.from_bot', () => {
    const d = route(
      makePost({ props: { from_bot: 'true' } }),
      admin,
      boundChannel,
      makeConfig({ channelMode: 'all' }),
      noThreads,
    );
    expect(d).toEqual({ action: 'drop', reason: 'bot_sender' });
  });

  it('drops system posts', () => {
    const d = route(
      makePost({ type: 'system_join_channel' }),
      admin,
      boundChannel,
      makeConfig({ channelMode: 'all' }),
      noThreads,
    );
    expect(d).toEqual({ action: 'drop', reason: 'system_post' });
  });
});

describe('route: sender gating', () => {
  it('drops disallowed senders even in a bound channel with a mention', () => {
    const d = route(makePost({ message: '@talon hi', user_id: STRANGER_ID }), stranger, boundChannel, makeConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'sender_not_allowed' });
  });

  it('drops disallowed senders in DMs (gates on sender, not channel)', () => {
    const d = route(makePost({ channel_id: DM_CHANNEL, user_id: STRANGER_ID }), stranger, dmChannel, makeConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'sender_not_allowed' });
  });

  it('allows senders by user id', () => {
    const d = route(makePost({ message: '@talon hi' }), admin, boundChannel, makeConfig(), noThreads);
    expect(d.action).toBe('forward');
  });

  it('allows senders by username, case-insensitively', () => {
    const d = route(
      makePost({ message: '@talon hi', user_id: allowedByName.id }),
      allowedByName,
      boundChannel,
      makeConfig(),
      noThreads,
    );
    expect(d.action).toBe('forward');
  });
});

describe('route: DMs', () => {
  it('forwards DMs from allowed users when DM_ENABLED', () => {
    const d = route(makePost({ channel_id: DM_CHANNEL }), admin, dmChannel, makeConfig(), noThreads);
    expect(d.action).toBe('forward');
    if (d.action === 'forward') {
      expect(d.meta.is_dm).toBe('true');
      expect(d.meta.channel_id).toBe(DM_CHANNEL);
      expect(d.meta.sender_name).toBe('alice');
    }
  });

  it('drops DMs when DM_ENABLED is false', () => {
    const d = route(makePost({ channel_id: DM_CHANNEL }), admin, dmChannel, makeConfig({ dmEnabled: false }), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'dm_disabled' });
  });

  it('forwards DMs without requiring a mention even in mention mode', () => {
    const d = route(
      makePost({ channel_id: DM_CHANNEL, message: 'no mention here' }),
      admin,
      dmChannel,
      makeConfig({ channelMode: 'mention' }),
      noThreads,
    );
    expect(d.action).toBe('forward');
  });
});

describe('route: channel binding', () => {
  it('drops posts in unbound channels even with a mention from an allowed user', () => {
    const d = route(
      makePost({ channel_id: OTHER_CHANNEL, message: '@talon hi' }),
      admin,
      otherChannel,
      makeConfig({ channelMode: 'all' }),
      noThreads,
    );
    expect(d).toEqual({ action: 'drop', reason: 'channel_not_bound' });
  });
});

describe('route: mode=all', () => {
  it('forwards any allowed message in a bound channel', () => {
    const d = route(makePost({ message: 'no mention' }), admin, boundChannel, makeConfig({ channelMode: 'all' }), noThreads);
    expect(d.action).toBe('forward');
  });
});

describe('route: mode=mention', () => {
  it('forwards on @-mention', () => {
    const d = route(makePost({ message: 'hey @talon do a thing' }), admin, boundChannel, makeConfig(), noThreads);
    expect(d.action).toBe('forward');
  });

  it('drops messages without a mention outside participating threads', () => {
    const d = route(makePost({ message: 'just chatting' }), admin, boundChannel, makeConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'no_mention_or_thread' });
  });

  it('forwards thread replies when the bot participates in the thread (thread-follow)', () => {
    const state: RouterState = { participatingThreads: new Set(['rootpost00000000000000001']) };
    const d = route(
      makePost({ message: 'follow-up, no mention', root_id: 'rootpost00000000000000001' }),
      admin,
      boundChannel,
      makeConfig(),
      state,
    );
    expect(d.action).toBe('forward');
  });

  it('drops thread replies in threads the bot does not participate in', () => {
    const state: RouterState = { participatingThreads: new Set(['someotherroot000000000001']) };
    const d = route(
      makePost({ message: 'unrelated thread', root_id: 'rootpost00000000000000001' }),
      admin,
      boundChannel,
      makeConfig(),
      state,
    );
    expect(d).toEqual({ action: 'drop', reason: 'no_mention_or_thread' });
  });
});

describe('route: forwarded meta', () => {
  it('attaches identifier-keyed meta with channel, post, thread and sender info', () => {
    const d = route(
      makePost({ message: '@talon hi', root_id: 'rootpost00000000000000001' }),
      admin,
      boundChannel,
      makeConfig(),
      { participatingThreads: new Set(['rootpost00000000000000001']) },
    );
    expect(d.action).toBe('forward');
    if (d.action === 'forward') {
      expect(d.meta).toEqual({
        channel_id: BOUND_CHANNEL,
        channel_name: 'ops',
        root_id: 'rootpost00000000000000001',
        post_id: 'post0000000000000000000001',
        sender_name: 'alice',
        is_dm: 'false',
      });
      for (const key of Object.keys(d.meta)) {
        expect(key).toMatch(/^[A-Za-z0-9_]+$/);
      }
    }
  });

  it('leaves root_id empty for top-level posts (Claude uses post_id as thread root)', () => {
    const d = route(makePost({ message: '@talon hi', root_id: '' }), admin, boundChannel, makeConfig(), noThreads);
    expect(d.action).toBe('forward');
    if (d.action === 'forward') {
      expect(d.meta.root_id).toBe('');
      expect(d.meta.post_id).toBe('post0000000000000000000001');
    }
  });
});

describe('per-channel mode overrides', () => {
  it('mode=all agent stays mention-gated in an overridden channel', () => {
    const config = makeConfig({
      channelMode: 'all',
      channelModes: new Map([[BOUND_CHANNEL, 'mention']]),
    });
    const noMention = route(makePost({ message: 'hello there' }), admin, boundChannel, config, noThreads);
    expect(noMention.action).toBe('drop');
    const mention = route(makePost({ message: '@talon hello' }), admin, boundChannel, config, noThreads);
    expect(mention.action).toBe('forward');
  });

  it('channels without an override fall back to the global mode', () => {
    const config = makeConfig({
      channelMode: 'all',
      channelModes: new Map([['someotherchannelid0000000000', 'mention']]),
    });
    const d = route(makePost({ message: 'no mention here' }), admin, boundChannel, config, noThreads);
    expect(d.action).toBe('forward');
  });
});

describe('agent-to-agent (ALLOWED_BOTS)', () => {
  const peerBot: RouterSender = { id: 'peerbotid0000000000000000ab', username: 'peer2', isBot: true };
  const a2aConfig = (overrides: Partial<RouterConfig> = {}) =>
    makeConfig({
      channelMode: 'all',
      allowedBotUsernames: new Set(['peer2']),
      ...overrides,
    });

  it('allowlisted bot + mention -> forward with sender_is_bot meta', () => {
    const d = route(makePost({ message: '@talon can you check X', user_id: peerBot.id }), peerBot, boundChannel, a2aConfig(), noThreads);
    expect(d.action).toBe('forward');
    if (d.action === 'forward') expect(d.meta.sender_is_bot).toBe('true');
  });

  it('allowlisted bot WITHOUT mention -> drop even in mode=all', () => {
    const d = route(makePost({ message: 'no mention here', user_id: peerBot.id }), peerBot, boundChannel, a2aConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'bot_no_mention' });
  });

  it('allowlisted bot gets no thread-follow', () => {
    const threads = { participatingThreads: new Set(['rootpost0000000000000000000']) };
    const d = route(
      makePost({ message: 'thread reply, no mention', user_id: peerBot.id, root_id: 'rootpost0000000000000000000' }),
      peerBot, boundChannel, a2aConfig(), threads,
    );
    expect(d).toEqual({ action: 'drop', reason: 'bot_no_mention' });
  });

  it('non-allowlisted bot -> drop as before', () => {
    const stranger: RouterSender = { id: 'otherbotid000000000000000ab', username: 'rando', isBot: true };
    const d = route(makePost({ message: '@talon hi', user_id: stranger.id }), stranger, boundChannel, a2aConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'bot_sender' });
  });

  it('allowlisted bot DM -> drop', () => {
    const d = route(makePost({ channel_id: DM_CHANNEL, message: '@talon hi', user_id: peerBot.id }), peerBot, dmChannel, a2aConfig(), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'bot_dm' });
  });
});

describe('agent-to-agent edge cases', () => {
  const peerBot: RouterSender = { id: 'peerbotid0000000000000000ab', username: 'peer2', isBot: true };

  it('allowlisted bot in an UNBOUND channel -> drop', () => {
    const config = makeConfig({ allowedBotUsernames: new Set(['peer2']) });
    const d = route(makePost({ channel_id: OTHER_CHANNEL, message: '@talon hi', user_id: peerBot.id }), peerBot, otherChannel, config, noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'channel_not_bound' });
  });

  it('allowlisted bot by user ID -> forward on mention', () => {
    const config = makeConfig({ allowedBotIds: new Set([peerBot.id]) });
    const d = route(makePost({ message: '@talon hi', user_id: peerBot.id }), peerBot, boundChannel, config, noThreads);
    expect(d.action).toBe('forward');
  });

  it('allowlisted bot system post -> drop', () => {
    const config = makeConfig({ allowedBotUsernames: new Set(['peer2']) });
    const d = route(
      makePost({ message: '@talon joined', user_id: peerBot.id, type: 'system_join_channel' }),
      peerBot, boundChannel, config, noThreads,
    );
    expect(d).toEqual({ action: 'drop', reason: 'system_post' });
  });
});

describe('includeOwnPosts test mode', () => {
  it('routes the bot\'s own posts as foreign when enabled (and bot is allowlisted as user)', () => {
    const config = makeConfig({
      includeOwnPosts: true,
      channelMode: 'all',
      allowedUserIds: new Set([ADMIN_ID, BOT_ID]),
    });
    const d = route(makePost({ user_id: BOT_ID }), botSelf, boundChannel, config, noThreads);
    expect(d.action).toBe('forward');
  });

  it('still drops own posts when disabled', () => {
    const d = route(makePost({ user_id: BOT_ID }), botSelf, boundChannel, makeConfig({ channelMode: 'all' }), noThreads);
    expect(d).toEqual({ action: 'drop', reason: 'own_post' });
  });
});
