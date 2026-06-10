/**
 * Entrypoint: load config, resolve Mattermost identities, create the MCP
 * channel server, connect stdio, then start catch-up + websocket.
 *
 * stdout belongs to the MCP transport; all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createChannelServer, MattermostBridge } from './channel.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { log } from './log.js';
import { MattermostClient, MattermostError } from './mattermost.js';
import { StateStore } from './state.js';

/**
 * Backoff schedule for transient init failures (network/DNS not ready at pod
 * boot, Mattermost mid-restart). Dying here permanently kills the MCP server
 * for the whole Claude session — Claude Code does not relaunch it — so retry
 * hard. The stdio transport is only connected after init succeeds, and Claude
 * Code's MCP connect timeout caps the total budget: 30s by default, raise it
 * to 120s via MCP_TIMEOUT in the pod env. This schedule sums to ~100s,
 * staying inside that. Seen live: a pod-boot network race left fetch failing
 * for >20s, outlasting a shorter schedule — every agent lost its bridge until
 * the sessions were restarted.
 */
const INIT_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 13000, 21000, 21000, 26000];

function isTransientInitError(err: unknown): boolean {
  if (!(err instanceof MattermostError)) return false;
  // Network errors carry no HTTP status; 5xx = Mattermost up but unhealthy.
  return err.status === undefined || err.status >= 500;
}

async function initWithRetry(config: Config, mm: MattermostClient, state: StateStore): Promise<MattermostBridge> {
  for (const delayMs of INIT_RETRY_DELAYS_MS) {
    try {
      return await MattermostBridge.init(config, mm, state);
    } catch (err) {
      if (!isTransientInitError(err)) throw err;
      log('warn', `Bridge init failed (${(err as Error).message}); retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return MattermostBridge.init(config, mm, state);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const mm = new MattermostClient(config.mmUrl, config.botToken);
  const state = new StateStore(config.stateFile);
  state.load();

  const bridge = await initWithRetry(config, mm, state);
  const server = createChannelServer(bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'MCP channel server connected on stdio');

  server.onclose = () => {
    log('info', 'MCP transport closed; shutting down');
    bridge.stop();
    process.exit(0);
  };

  const shutdown = (signal: string): void => {
    log('info', `Received ${signal}; shutting down`);
    bridge.stop();
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bridge.start();
  log('info', 'Bridge started (catch-up done, websocket connecting)');
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log('error', `Config error: ${err.message}`);
  } else {
    log('error', `Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  process.exit(1);
});
