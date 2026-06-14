import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ProtocolEngine } from '../engine/protocolEngine.js';
import { registerTools } from './tools.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentId: string;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * MCP streamable HTTP endpoint. One McpServer + transport pair per MCP
 * session, each bound to exactly one agent (resolved from the bearer token at
 * initialize time and re-verified on every request).
 */
export class McpEndpoint {
  private sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly engine: ProtocolEngine,
    private readonly getAllowedHosts: () => string[],
  ) {}

  async handle(req: Request, res: Response): Promise<void> {
    const token = bearerToken(req);
    const agent = token ? this.engine.agentByToken(token) : null;
    if (!agent) {
      res.status(404).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = new McpServer({ name: 'avorant-group-chat', version: '0.1.0' });
      registerTools(server, this.engine, agent.id);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: this.getAllowedHosts(),
        onsessioninitialized: (sid) => {
          this.sessions.set(sid, { transport, server, agentId: agent.id });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!entry || entry.agentId !== agent.id) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad or expired MCP session — re-initialize.' },
        id: null,
      });
      return;
    }
    await entry.transport.handleRequest(req, res, req.body);
  }

  async closeAll(): Promise<void> {
    for (const { transport } of [...this.sessions.values()]) {
      try {
        await transport.close();
      } catch {
        // closing is best-effort
      }
    }
    this.sessions.clear();
  }
}
