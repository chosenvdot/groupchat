import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

/**
 * A scripted stand-in for a real CLI agent: same MCP transport, same bearer
 * auth, same tools — driven by test code instead of a model. The protocol
 * cannot tell the difference, which is the point.
 */
export class FakeAgent {
  private client: Client | null = null;

  constructor(
    readonly name: string,
    private readonly port: number,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${this.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    this.client = new Client({ name: `fake-${this.name}`, version: '0.0.1' });
    await this.client.connect(transport);
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    if (!this.client) throw new Error(`${this.name} is not connected`);
    const res = (await this.client.callTool({ name: tool, arguments: args })) as any;
    const text = (res.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    return { text, isError: Boolean(res.isError) };
  }

  /** Call a tool and throw if the server rejected it — for steps that must succeed. */
  async must(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.call(tool, args);
    if (res.isError) throw new Error(`${this.name}.${tool} failed: ${res.text}`);
    return res.text;
  }

  /** Simulate this agent's Stop hook parking on the server. Resolves when woken/held/released. */
  async stopPoll(opts: { holdMs?: number; standby?: boolean } = {}): Promise<{ action: string; reason?: string }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/hooks/stop-poll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ holdMs: opts.holdMs ?? 5_000, standby: opts.standby ?? false }),
    });
    return (await res.json()) as { action: string; reason?: string };
  }

  async postActivity(toolName: string, paths: string[]): Promise<void> {
    await fetch(`http://127.0.0.1:${this.port}/api/hooks/activity`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ toolName, paths }),
    });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
