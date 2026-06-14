import { z } from 'zod';
import {
  AGENT_MESSAGE_TYPES,
  CLAIM_TTL_MAX_MINUTES,
  CLAIM_TTL_MIN_MINUTES,
  CONTRACT_VERDICTS,
  DEFAULT_CLAIM_TTL_MINUTES,
  MAX_CLAIM_PATHS,
  REVIEW_VERDICTS,
} from './protocol.js';

/**
 * Input schemas for the 12 MCP tools. Exported as raw shapes (ZodRawShape)
 * because `McpServer.registerTool` consumes shapes, with z.object wrappers
 * for everything else (tests, fake agents, server-side validation).
 */

export const joinShape = {
  cli_session_id: z.string().max(200).optional(),
};

export const catchUpShape = {
  issue_id: z.string().optional(),
};

export const postMessageShape = {
  issue_id: z.string().optional(),
  type: z.enum(AGENT_MESSAGE_TYPES),
  body: z.string().min(1).max(4000),
  reply_to: z.string().optional(),
};

export const createIssueShape = {
  title: z.string().min(3).max(120),
  body: z.string().max(8000),
  assignees: z.array(z.string()).max(8).optional(),
};

export const proposeContractShape = {
  issue_id: z.string(),
  spec_md: z.string().min(20).max(8000),
};

export const respondContractShape = {
  contract_id: z.string(),
  verdict: z.enum(CONTRACT_VERDICTS),
  comment: z.string().max(2000).optional(),
};

export const claimPathsShape = {
  issue_id: z.string().optional(),
  paths: z.array(z.string().min(1).max(500)).min(1).max(MAX_CLAIM_PATHS),
  reason: z.string().min(1).max(300),
  ttl_minutes: z
    .number()
    .int()
    .min(CLAIM_TTL_MIN_MINUTES)
    .max(CLAIM_TTL_MAX_MINUTES)
    .default(DEFAULT_CLAIM_TTL_MINUTES),
};

export const releaseClaimsShape = {
  claim_ids: z.array(z.string()).max(50).optional(),
  all: z.boolean().optional(),
};

export const requestReviewShape = {
  issue_id: z.string(),
  summary: z.string().min(30).max(6000),
  files: z.array(z.string()).max(100).optional(),
};

export const reviewSpecificSchema = z.object({
  path: z.string().max(500).optional(),
  problem: z.string().min(5).max(2000),
  suggestion: z.string().max(2000).optional(),
});
export type ReviewSpecific = z.infer<typeof reviewSpecificSchema>;

export const postReviewShape = {
  issue_id: z.string(),
  verdict: z.enum(REVIEW_VERDICTS),
  body: z.string().min(20).max(8000),
  specifics: z.array(reviewSpecificSchema).max(50).optional(),
};

export const closeIssueShape = {
  issue_id: z.string(),
  summary: z.string().min(10).max(4000),
};

export const proposePlanShape = {
  issue_id: z.string(),
  tasks: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        owner: z.string().min(1).max(60),
        depends_on: z.array(z.number().int().min(0)).max(10).optional(),
      }),
    )
    .min(1)
    .max(20),
};

export const updateTaskShape = {
  task_id: z.string(),
  status: z.enum(['doing', 'done']),
  note: z.string().max(1000).optional(),
};

export const waitForUpdatesShape = {
  cursor: z.number().int().min(0).optional(),
  timeout_sec: z.number().int().min(5).max(240).default(120),
};

export const toolSchemas = {
  join: z.object(joinShape),
  catch_up: z.object(catchUpShape),
  post_message: z.object(postMessageShape),
  create_issue: z.object(createIssueShape),
  propose_contract: z.object(proposeContractShape),
  respond_contract: z.object(respondContractShape),
  claim_paths: z.object(claimPathsShape),
  release_claims: z.object(releaseClaimsShape),
  request_review: z.object(requestReviewShape),
  post_review: z.object(postReviewShape),
  close_issue: z.object(closeIssueShape),
  propose_plan: z.object(proposePlanShape),
  update_task: z.object(updateTaskShape),
  wait_for_updates: z.object(waitForUpdatesShape),
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]>;
