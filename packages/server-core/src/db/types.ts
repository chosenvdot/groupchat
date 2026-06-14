import type {
  AgentKind,
  ClaimStatus,
  CloseReason,
  ContractStatus,
  ContractVerdict,
  IssueState,
  MessageType,
  Presence,
  ReviewSpecific,
  ReviewVerdict,
  SessionStatus,
} from '@avorant/shared';

export interface SessionRow {
  id: string;
  repoPath: string;
  title: string;
  goal: string;
  status: SessionStatus;
  leadAgentId: string | null;
  negotiationTurnCap: number;
  autoMode: boolean;
  port: number;
  createdAt: number;
  endedAt: number | null;
}

export interface AgentRow {
  id: string;
  sessionId: string;
  slug: string;
  kind: AgentKind;
  displayName: string;
  role: string | null;
  tokenHash: string | null;
  presence: Presence;
  consecutiveStandbys: number;
  cliSessionId: string | null;
  lastSeenAt: number | null;
  createdAt: number;
}

export interface IssueRow {
  id: string;
  sessionId: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  createdBy: string;
  assignees: string[];
  labels: string[];
  negotiationTurnsUsed: number;
  reviewRound: number;
  closeReason: CloseReason | null;
  closedBy: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface MessageRow {
  id: string;
  ord: number;
  sessionId: string;
  issueId: string | null;
  authorId: string;
  type: MessageType;
  body: string;
  replyTo: string | null;
  turnIndex: number | null;
  createdAt: number;
}

export interface ContractRow {
  id: string;
  issueId: string;
  version: number;
  specMd: string;
  proposedBy: string;
  status: ContractStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ContractApprovalRow {
  contractId: string;
  agentId: string;
  verdict: ContractVerdict;
  comment: string | null;
  createdAt: number;
}

export interface ClaimRow {
  id: string;
  sessionId: string;
  issueId: string | null;
  agentId: string;
  pathPrefix: string;
  reason: string;
  status: ClaimStatus;
  expiresAt: number;
  createdAt: number;
  releasedAt: number | null;
}

export interface ReviewRow {
  id: string;
  issueId: string;
  round: number;
  requestedBy: string;
  reviewerId: string;
  requestNote: string;
  files: string[] | null;
  verdict: ReviewVerdict | null;
  body: string | null;
  specifics: ReviewSpecific[] | null;
  nudgeCount: number;
  lastNudgeAt: number | null;
  createdAt: number;
  completedAt: number | null;
}
