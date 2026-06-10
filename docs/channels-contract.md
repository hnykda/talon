# Claude Code channels protocol — condensed contract (from code.claude.com/docs/en/channels-reference, fetched 2026-06-10)

A channel = MCP server spawned by Claude Code as a stdio subprocess. Requires Claude Code v2.1.80+.
Run during research preview: `claude --dangerously-load-development-channels server:<name-in-.mcp.json>`

## Server constructor (capabilities)
```ts
new Server({ name: 'mattermost', version: '0.1.0' }, {
  capabilities: {
    experimental: {
      'claude/channel': {},            // REQUIRED: registers notification listener
      'claude/channel/permission': {}, // optional: permission relay (v2.1.81+)
    },
    tools: {},                         // for two-way (reply tool + history tools)
  },
  instructions: '...',  // injected into Claude's system prompt: explain <channel> tags + how to reply
})
```
Connect via StdioServerTransport. Package: @modelcontextprotocol/sdk.

## Inbound events (server → Claude)
```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: string, meta: Record<string,string> }
})
```
- Arrives as `<channel source="mattermost" key="val">content</channel>`
- meta keys MUST be identifiers (letters/digits/underscores only); others silently dropped.
- Not acknowledged; dropped silently if channel not loaded. Events queue; delivered as a group next turn if Claude busy.

## Reply tool (Claude → server)
Standard MCP tool via ListToolsRequestSchema/CallToolRequestSchema handlers.

## Permission relay
Outbound (Claude Code → server): notification `notifications/claude/channel/permission_request`,
params: { request_id (5 lowercase letters, no 'l'), tool_name, description, input_preview }.
Inbound verdict (server → Claude Code): notification `notifications/claude/channel/permission`,
params: { request_id, behavior: 'allow'|'deny' }.
Inbound handler should match /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i on messages from allowlisted senders and emit verdict instead of forwarding as chat.
SECURITY: only declare permission capability if sender-gated. Gate on sender id, NOT room id.

## .mcp.json registration
```json
{ "mcpServers": { "mattermost": { "command": "node", "args": ["--import","tsx","./channel-server/src/index.ts"], "env": {...} } } }
```
