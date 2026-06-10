/**
 * Standalone probe mode — runs the full Mattermost pipeline WITHOUT Claude
 * Code. Events that would be forwarded to Claude are printed to stdout as
 * JSON lines (stdout is safe here: there is no MCP transport).
 *
 *   npm run probe                                  # watch mode
 *   npm run probe -- --say <channel_id_or_name> <text...>   # post once and exit
 */
import { MattermostBridge } from './channel.js';
import { ConfigError, loadConfig } from './config.js';
import { log } from './log.js';
import { MattermostClient } from './mattermost.js';
import { StateStore } from './state.js';

function printLine(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const mm = new MattermostClient(config.mmUrl, config.botToken);

  if (argv[0] === '--say') {
    const channelRef = argv[1];
    const text = argv.slice(2).join(' ');
    if (!channelRef || !text) {
      process.stderr.write('Usage: npm run probe -- --say <channel_id_or_name> <text...>\n');
      process.exit(2);
    }
    const channel = await mm.resolveChannel(channelRef);
    const post = await mm.createPost(channel.id, text);
    printLine({ type: 'posted', post_id: post.id, channel_id: channel.id, channel_name: channel.name });
    return;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown argument: ${argv[0]}\nUsage: npm run probe [-- --say <channel> <text...>]\n`);
    process.exit(2);
  }

  const state = new StateStore(config.stateFile);
  state.load();

  const bridge = await MattermostBridge.init(config, mm, state);
  bridge.sink = {
    onEvent: (event) => {
      printLine({ type: 'channel_event', content: event.content, meta: event.meta });
    },
    onPermissionVerdict: (requestId, behavior) => {
      printLine({ type: 'permission_verdict', request_id: requestId, behavior });
    },
  };

  await bridge.start();
  log('info', 'Probe running: would-forward events are printed to stdout as JSON lines. Ctrl-C to exit.');

  const shutdown = (): void => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log('error', `Config error: ${err.message}`);
  } else {
    log('error', `Probe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  process.exit(1);
});
