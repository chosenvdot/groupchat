import type { Express, Request, Response } from 'express';
import { STOP_POLL_MAX_HOLD_MS } from '@avorant/shared';
import type { ProtocolEngine } from '../engine/protocolEngine.js';
import { bearerToken } from '../mcp/mcpEndpoint.js';

/**
 * Routes for the hook script (avorant-hook.cjs). Auth: the agent's own bearer
 * token. These are the park/wake lifecycle (stop-poll), the activity feed
 * (posttool), and SessionStart digest injection.
 */
export function registerHookRoutes(app: Express, engine: ProtocolEngine): void {
  const requireAgent = (req: Request, res: Response) => {
    const token = bearerToken(req);
    const agent = token ? engine.agentByToken(token) : null;
    if (!agent) {
      res.status(404).end();
      return null;
    }
    return agent;
  };

  app.post('/api/hooks/stop-poll', (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const body = req.body ?? {};
    const holdMs = Math.max(1_000, Math.min(STOP_POLL_MAX_HOLD_MS, Number(body.holdMs) || STOP_POLL_MAX_HOLD_MS));
    void engine
      .stopPoll(agent.id, {
        cliSessionId: typeof body.cliSessionId === 'string' ? body.cliSessionId : null,
        stopHookActive: Boolean(body.stopHookActive),
        standby: Boolean(body.standby),
        holdMs,
      })
      .then((response) => res.json(response))
      .catch(() => {
        if (!res.headersSent) res.json({ action: 'release', reason: 'server error' });
      });
  });

  app.post('/api/hooks/pretool', (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const body = req.body ?? {};
    const paths = Array.isArray(body.paths) ? body.paths.filter((p: unknown) => typeof p === 'string').slice(0, 50) : [];
    try {
      res.json(engine.preToolGate(agent.id, paths));
    } catch {
      res.json({ allow: true }); // the gate must never break an agent
    }
  });

  app.post('/api/hooks/activity', (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const body = req.body ?? {};
    const toolName = typeof body.toolName === 'string' ? body.toolName : 'unknown';
    const paths = Array.isArray(body.paths) ? body.paths.filter((p: unknown) => typeof p === 'string').slice(0, 50) : [];
    try {
      engine.recordActivity(agent.id, toolName, paths);
      res.json({ ok: true });
    } catch {
      res.json({ ok: false });
    }
  });

  app.post('/api/hooks/session-start', (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const body = req.body ?? {};
    try {
      if (typeof body.cliSessionId === 'string') engine.store.agents.setCliSessionId(agent.id, body.cliSessionId);
      const digest = engine.sessionStartDigest(agent.id);
      res.json({ digest });
    } catch (err) {
      res.json({ digest: 'Avorant room unavailable — call the avorant `join` tool to connect.' });
    }
  });
}
