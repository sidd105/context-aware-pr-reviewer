import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../config/schema.js';
import type { Logger } from '../core/logger.js';
import type { McpClientPool } from '../core/plugin.js';

// Starts each configured MCP server on first use and keeps it for the run.
export class StdioMcpPool implements McpClientPool {
  private clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly logger: Logger,
  ) {}

  serverConfig(server: string): McpServerConfig {
    const config = this.servers[server];
    if (!config) throw new Error(`Unknown MCP server "${server}". Configured: ${Object.keys(this.servers).join(', ') || 'none'}`);
    return config;
  }

  private client(server: string): Promise<Client> {
    let c = this.clients.get(server);
    if (!c) {
      const config = this.serverConfig(server);
      c = (async () => {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          // Only the variables the config names are passed, plus PATH, so a
          // server doesn't inherit every credential in the CI environment.
          env: { PATH: process.env.PATH ?? '', ...config.env },
          ...(config.cwd ? { cwd: config.cwd } : {}),
          stderr: 'pipe',
        });
        const client = new Client({ name: 'context-aware-pr-reviewer', version: '0.2.0' });
        await client.connect(transport);
        this.logger.debug(`connected to MCP server ${server}`);
        return client;
      })();
      this.clients.set(server, c);
    }
    return c;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.client(server);
    const result = await client.callTool({ name: tool, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n');
    if (result.isError) throw new Error(`MCP ${server}.${tool} returned an error: ${text.slice(0, 500)}`);
    return text;
  }

  async close() {
    for (const c of this.clients.values()) {
      try {
        await (await c).close();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}

// Used when no MCP servers are configured, and in tests.
export class StaticMcpPool implements McpClientPool {
  constructor(
    private readonly handlers: Record<string, (tool: string, args: Record<string, unknown>) => string | Promise<string>> = {},
    private readonly configs: Record<string, McpServerConfig> = {},
  ) {}

  serverConfig(server: string): McpServerConfig {
    return this.configs[server] ?? { command: 'static', args: [], env: {}, trust: 'agentic' };
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const handler = this.handlers[server];
    if (!handler) throw new Error(`Unknown MCP server "${server}"`);
    return handler(tool, args);
  }
}
