import { create } from 'zustand';
import type { AgentConnection } from '../client.js';

/**
 * Holds the one-time connection bundles (token, files written, launch hint)
 * returned by createSession, until the human confirms the agents are in the
 * room. Tokens are never shown again after this is cleared.
 */
interface OnboardingStore {
  connections: AgentConnection[] | null;
  set(connections: AgentConnection[]): void;
  clear(): void;
}

export const useOnboarding = create<OnboardingStore>((update) => ({
  connections: null,
  set(connections) {
    update({ connections });
  },
  clear() {
    update({ connections: null });
  },
}));
