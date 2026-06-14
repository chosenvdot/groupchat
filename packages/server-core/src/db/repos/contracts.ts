import { newId } from '@avorant/shared/node';
import type { ContractStatus, ContractVerdict } from '@avorant/shared';
import type { DB } from '../database.js';
import type { ContractApprovalRow, ContractRow } from '../types.js';

function map(r: any): ContractRow {
  return {
    id: r.id,
    issueId: r.issue_id,
    version: r.version,
    specMd: r.spec_md,
    proposedBy: r.proposed_by,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function mapApproval(r: any): ContractApprovalRow {
  return {
    contractId: r.contract_id,
    agentId: r.agent_id,
    verdict: r.verdict,
    comment: r.comment,
    createdAt: r.created_at,
  };
}

export class ContractsRepo {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  /** Supersedes any pending contract on the issue and inserts the next version. */
  insert(input: { issueId: string; specMd: string; proposedBy: string }): ContractRow {
    const t = this.now();
    this.db
      .prepare(`UPDATE contracts SET status = 'superseded', resolved_at = ? WHERE issue_id = ? AND status = 'proposed'`)
      .run(t, input.issueId);
    const version = (
      this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM contracts WHERE issue_id = ?`).get(input.issueId) as any
    ).v as number;
    const id = newId('ctr');
    this.db
      .prepare(
        `INSERT INTO contracts (id, issue_id, version, spec_md, proposed_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(id, input.issueId, version, input.specMd, input.proposedBy, t);
    return this.byIdOrThrow(id);
  }

  byId(id: string): ContractRow | null {
    const r = this.db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id);
    return r ? map(r) : null;
  }

  byIdOrThrow(id: string): ContractRow {
    const row = this.byId(id);
    if (!row) throw new Error(`contract not found: ${id}`);
    return row;
  }

  latestForIssue(issueId: string): ContractRow | null {
    const r = this.db.prepare(`SELECT * FROM contracts WHERE issue_id = ? ORDER BY version DESC LIMIT 1`).get(issueId);
    return r ? map(r) : null;
  }

  pendingForIssue(issueId: string): ContractRow | null {
    const r = this.db.prepare(`SELECT * FROM contracts WHERE issue_id = ? AND status = 'proposed' LIMIT 1`).get(issueId);
    return r ? map(r) : null;
  }

  listForIssue(issueId: string): ContractRow[] {
    return this.db.prepare(`SELECT * FROM contracts WHERE issue_id = ? ORDER BY version`).all(issueId).map(map);
  }

  setStatus(id: string, status: ContractStatus): void {
    this.db.prepare(`UPDATE contracts SET status = ?, resolved_at = ? WHERE id = ?`).run(status, this.now(), id);
  }

  recordApproval(contractId: string, agentId: string, verdict: ContractVerdict, comment: string | null): void {
    this.db
      .prepare(
        `INSERT INTO contract_approvals (contract_id, agent_id, verdict, comment, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (contract_id, agent_id) DO UPDATE SET verdict = excluded.verdict, comment = excluded.comment, created_at = excluded.created_at`,
      )
      .run(contractId, agentId, verdict, comment, this.now());
  }

  approvals(contractId: string): ContractApprovalRow[] {
    return this.db.prepare(`SELECT * FROM contract_approvals WHERE contract_id = ?`).all(contractId).map(mapApproval);
  }
}
