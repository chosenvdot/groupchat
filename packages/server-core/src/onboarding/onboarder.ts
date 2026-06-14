import type { AgentRow } from '../db/types.js';
import type { Onboarder } from '../gui/api.js';
import { configureAntigravityCli, configureClaudeCode, configureCodexCli, configureCursorCli, removeAgentConfig } from './configGen.js';

export interface OnboarderOptions {
  /** Absolute node executable hooks should use (the app's bundled runtime). */
  nodePath?: string;
  /** App-bundled runtime dir with codex.cmd / claude.cmd — zero-dependency launch hints. */
  runtimeDir?: string;
}

/**
 * The production Onboarder wired into GuiApi: dispatches per CLI kind and
 * writes all config files when an agent is added or its key rotates.
 */
export function createOnboarder(hookBundlePath: string, options: OnboarderOptions = {}): Onboarder {
  return {
    configureAgent({ repoPath, port, agent, token }) {
      const input = { repoPath, port, agent, token, hookBundlePath, ...options };
      if (agent.kind === 'claude_code') return configureClaudeCode(input);
      if (agent.kind === 'codex_cli') return configureCodexCli(input);
      if (agent.kind === 'cursor_cli') return configureCursorCli(input);
      if (agent.kind === 'antigravity_cli') return configureAntigravityCli(input);
      return {
        filesWritten: [],
        launchHint: `Connect an MCP client to the avorant server with this agent's bearer token.`,
        warnings: [],
      };
    },
    removeAgent({ repoPath, agent }: { repoPath: string; agent: AgentRow }) {
      removeAgentConfig(repoPath, agent);
    },
  };
}
