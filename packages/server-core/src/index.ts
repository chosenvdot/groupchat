export const SERVER_CORE_VERSION = '0.1.0';

export { openDatabase, openMemoryDatabase, type DB } from './db/database.js';
export { Store, type StoreOptions } from './db/store.js';
export * from './db/types.js';

export { EventBus, type WaitOptions } from './wake/eventBus.js';
export { StopPollRegistry, type StopPollResponse } from './wake/stopPollRegistry.js';
export { NoticeBoard } from './wake/notices.js';

export { ProtocolEngine, type EngineDeps, type StopPollInput } from './engine/protocolEngine.js';
export { ProtocolError } from './engine/errors.js';
export { buildDigest, obligationsFor, type DigestOptions } from './engine/digest.js';
export { assertTransition, type IssueTrigger } from './engine/issueStateMachine.js';

export { registerTools } from './mcp/tools.js';
export { McpEndpoint, bearerToken } from './mcp/mcpEndpoint.js';
export { buildHttpApp } from './http/app.js';

export {
  provisionSession,
  provisionAgent,
  rotateAgentToken,
  type ProvisionInput,
  type ProvisionAgentInput,
  type ProvisionResult,
  type ProvisionedAgent,
} from './session/provision.js';

export { startServer, type StartServerOptions, type ServerHandle } from './server.js';

export {
  GuiApi,
  type AgentView,
  type ContractView,
  type BlockedOn,
  type IssueView,
  type SessionSnapshot,
  type AddAgentResult,
  type Onboarder,
} from './gui/api.js';
export { buildFileTree, readRepoFile, type FileNode, type RepoFile } from './repo/fsRead.js';
export { readGitStatus, type GitStatus } from './repo/gitRead.js';

export {
  applyToolPacks,
  configureAntigravityCli,
  configureClaudeCode,
  configureCodexCli,
  configureCursorCli,
  removeAgentConfig,
  upsertTomlSection,
  TOOL_PACKS,
  type ConfigureInput,
  type ConfigureOutput,
} from './onboarding/configGen.js';
export { ensureGitExcludes, tokenFilePreflight, EXCLUDED_PATHS } from './onboarding/gitExclude.js';
export { writeConstitution } from './onboarding/constitution.js';
export { createOnboarder } from './onboarding/onboarder.js';
export { getOrCreateMachineToken, rotateMachineToken, removeMachineCreds, type MachineCreds } from './onboarding/credentials.js';
export { getGroupChatHome, setGroupChatHome, ensureGroupChatDirs, tokenEnvVar } from './home.js';
export { writeContextSnapshot } from './snapshots/contextWriter.js';
