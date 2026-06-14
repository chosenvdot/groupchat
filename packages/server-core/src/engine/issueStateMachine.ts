import type { IssueState } from '@avorant/shared';
import { ProtocolError } from './errors.js';
import type { IssueRow } from '../db/types.js';

export type IssueTrigger =
  | 'proposal'
  | 'decision'
  | 'propose_contract'
  | 'respond_contract'
  | 'claim'
  | 'request_review'
  | 'post_review'
  | 'close'
  | 'force_close'
  | 'abandon'
  | 'discuss'; // update/question/answer

/** States from which each trigger is legal. The single gate-enforcement point. */
const ALLOWED: Record<IssueTrigger, IssueState[]> = {
  proposal: ['negotiating'],
  decision: ['negotiating'],
  propose_contract: ['negotiating', 'contracting'],
  respond_contract: ['contracting'],
  claim: ['in_progress'],
  request_review: ['in_progress'],
  post_review: ['in_review'],
  close: ['approved'],
  force_close: ['negotiating', 'contracting', 'in_progress', 'in_review', 'approved'],
  abandon: ['negotiating', 'contracting', 'in_progress', 'in_review', 'approved'],
  discuss: ['negotiating', 'contracting', 'in_progress', 'in_review', 'approved'],
};

const HINTS: Partial<Record<IssueTrigger, (issue: IssueRow) => string>> = {
  proposal: (i) =>
    `Proposals only count while an issue is negotiating; #${i.number} is ${i.state}. Use type:'update' for progress notes.`,
  decision: (i) => `Decisions settle negotiation; #${i.number} is ${i.state}.`,
  propose_contract: (i) =>
    `Contracts are proposed during negotiation; #${i.number} is ${i.state}. If work already started, finish the current cycle or ask the human.`,
  respond_contract: (i) => `#${i.number} is ${i.state}; there is no contract awaiting approval.`,
  claim: (i) =>
    `Claims on an issue require an approved contract (state in_progress); #${i.number} is ${i.state}. Get the contract approved first.`,
  request_review: (i) =>
    `request_review is only valid while work is in progress; #${i.number} is ${i.state}.`,
  post_review: (i) => `#${i.number} is ${i.state}; there is no review in flight. Use request_review to start one.`,
  close: (i) =>
    i.state === 'in_review'
      ? `Refused: issue #${i.number} is in_review with no APPROVE yet. Address open CHANGES items and request_review again, or ask the human to override from the GUI.`
      : `Refused: issue #${i.number} is ${i.state}, not approved. The peer model must post_review with verdict 'approve' before close_issue.`,
  discuss: (i) => `#${i.number} is ${i.state} — closed issues are read-only. Open a new issue if more work is needed.`,
};

export function assertTransition(issue: IssueRow, trigger: IssueTrigger): void {
  const allowed = ALLOWED[trigger];
  if (allowed.includes(issue.state)) return;
  const hint = HINTS[trigger];
  throw new ProtocolError(hint ? hint(issue) : `Action '${trigger}' is not valid while #${issue.number} is ${issue.state}.`);
}
