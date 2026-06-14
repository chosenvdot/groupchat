import { type AgentKind } from '@avorant/shared';
import { newToken, sha256Hex } from '@avorant/shared/node';
import type { Store } from '../db/store.js';
import type { AgentRow, SessionRow } from '../db/types.js';

export interface ProvisionAgentInput {
  slug: string;
  kind: Exclude<AgentKind, 'human'>;
  displayName?: string;
  role?: string;
}

/** Supplies the bearer token for a slug — machine-level creds (D-210) plug in here. */
export type TokenProvider = (slug: string) => string;

export interface ProvisionInput {
  repoPath: string;
  title: string;
  goal: string;
  port: number;
  negotiationTurnCap?: number;
  agents: ProvisionAgentInput[];
  leadSlug: string;
  tokenProvider?: TokenProvider;
}

export interface ProvisionedAgent {
  agent: AgentRow;
  /** Plaintext bearer token — written into CLI configs, never stored in the DB. */
  token: string;
}

export interface ProvisionResult {
  session: SessionRow;
  human: AgentRow;
  agents: Map<string, ProvisionedAgent>;
}

/**
 * Create a session with its human row and tokened CLI agents. Used by the GUI
 * session-creation flow and by tests; config-file generation (onboarding)
 * builds on the returned tokens.
 */
export function provisionSession(store: Store, input: ProvisionInput): ProvisionResult {
  return store.transaction(() => {
    const session = store.sessions.create({
      repoPath: input.repoPath,
      title: input.title,
      goal: input.goal,
      negotiationTurnCap: input.negotiationTurnCap,
      port: input.port,
    });
    const human = store.agents.create({ sessionId: session.id, slug: 'human', kind: 'human', displayName: 'You' });

    const agents = new Map<string, ProvisionedAgent>();
    for (const a of input.agents) {
      const token = input.tokenProvider?.(a.slug.toLowerCase()) ?? newToken();
      const agent = store.agents.create({
        sessionId: session.id,
        slug: a.slug.toLowerCase(),
        kind: a.kind,
        displayName: a.displayName ?? a.slug,
        role: a.role ?? null,
        tokenHash: sha256Hex(token),
      });
      agents.set(agent.slug, { agent, token });
      store.events.insert({
        sessionId: session.id,
        kind: 'agent',
        agentId: agent.id,
        payload: { type: 'added', agent: { id: agent.id, slug: agent.slug, kind: agent.kind, displayName: agent.displayName } },
      });
    }

    const lead = agents.get(input.leadSlug.toLowerCase());
    if (!lead) throw new Error(`leadSlug '${input.leadSlug}' is not among the provisioned agents`);
    store.sessions.setLead(session.id, lead.agent.id);

    store.events.insert({ sessionId: session.id, kind: 'session', payload: { type: 'created', title: session.title } });
    return { session: store.sessions.byIdOrThrow(session.id), human, agents };
  });
}

/** Add one agent to an existing session (GUI "Add agent"). */
export function provisionAgent(
  store: Store,
  sessionId: string,
  input: ProvisionAgentInput,
  tokenProvider?: TokenProvider,
): ProvisionedAgent {
  return store.transaction(() => {
    const token = tokenProvider?.(input.slug.toLowerCase()) ?? newToken();
    const agent = store.agents.create({
      sessionId,
      slug: input.slug.toLowerCase(),
      kind: input.kind,
      displayName: input.displayName ?? input.slug,
      role: input.role ?? null,
      tokenHash: sha256Hex(token),
    });
    store.events.insert({
      sessionId,
      kind: 'agent',
      agentId: agent.id,
      payload: { type: 'added', agent: { id: agent.id, slug: agent.slug, kind: agent.kind, displayName: agent.displayName } },
    });
    return { agent, token };
  });
}

/** Rotate an agent's bearer token (GUI "Regenerate connection"). */
export function rotateAgentToken(store: Store, agentId: string, newTokenValue?: string): ProvisionedAgent {
  const token = newTokenValue ?? newToken();
  store.agents.setTokenHash(agentId, sha256Hex(token));
  return { agent: store.agents.byIdOrThrow(agentId), token };
}
