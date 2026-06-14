import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { ProtocolEngine } from '../engine/protocolEngine.js';
import type { McpEndpoint } from '../mcp/mcpEndpoint.js';
import { registerHookRoutes } from './hookRoutes.js';

/**
 * The HTTP surface exists ONLY for external processes: the agent CLIs (/mcp)
 * and their hook scripts (/api/hooks/*). The renderer talks to the main
 * process over Electron IPC and never touches this server.
 */
export function buildHttpApp(engine: ProtocolEngine, mcp: McpEndpoint): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Host-header guard on every route (localhost bind + this = DNS-rebinding defense).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host.startsWith('127.0.0.1') || host.startsWith('localhost')) {
      next();
      return;
    }
    res.status(404).end();
  });

  app.get('/health', (_req, res) => {
    const session = engine.activeSession();
    res.json({ ok: true, session: session ? { id: session.id, title: session.title, status: session.status } : null });
  });

  app.all('/mcp', (req, res) => {
    void mcp.handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err?.message ?? err) }, id: null });
      }
    });
  });

  registerHookRoutes(app, engine);

  return app;
}
