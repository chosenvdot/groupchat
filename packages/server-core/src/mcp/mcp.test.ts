import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionSession } from '../session/provision.js';
import { startServer, type ServerHandle } from '../server.js';

let handle: ServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

async function boot() {
  handle = await startServer({ port: 0 });
  const provisioned = provisionSession(handle.store, {
    repoPath: 'C:/tmp/fixture',
    title: 'MCP test',
    goal: 'Verify the MCP endpoint end to end',
    port: handle.port,
    agents: [
      { slug: 'claude', kind: 'claude_code' },
      { slug: 'codex', kind: 'codex_cli' },
    ],
    leadSlug: 'claude',
  });
  return { handle, provisioned };
}

async function connect(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'fake-agent', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

describe('MCP endpoint', () => {
  it('rejects unknown tokens', async () => {
    const { handle } = await boot();
    await expect(connect(handle.port, 'not-a-real-token')).rejects.toThrow();
  });

  it('lists 12 tools and join returns a digest naming the goal', async () => {
    const { handle, provisioned } = await boot();
    const claudeToken = provisioned.agents.get('claude')!.token;
    const client = await connect(handle.port, claudeToken);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(14);
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'catch_up',
        'claim_paths',
        'close_issue',
        'create_issue',
        'join',
        'post_message',
        'post_review',
        'propose_contract',
        'propose_plan',
        'release_claims',
        'request_review',
        'respond_contract',
        'update_task',
        'wait_for_updates',
      ].sort(),
    );

    const res = (await client.callTool({ name: 'join', arguments: {} })) as any;
    const body = res.content[0].text as string;
    expect(body).toContain('Verify the MCP endpoint end to end');
    expect(body).toContain('@claude (claude_code, lead)');
    expect(body).toContain('@codex (codex_cli)');
    await client.close();
  });

  it('runs a verb round-trip and renders protocol errors as teaching tool errors', async () => {
    const { handle, provisioned } = await boot();
    const claude = await connect(handle.port, provisioned.agents.get('claude')!.token);

    const created = (await claude.callTool({
      name: 'create_issue',
      arguments: { title: 'Try the endpoint', body: 'end to end issue' },
    })) as any;
    expect(created.content[0].text).toContain('Created #1');
    const issueId = /issue_id: (\S+)\)/.exec(created.content[0].text)![1]!;

    const closed = (await claude.callTool({ name: 'close_issue', arguments: { issue_id: issueId, summary: 'closing way too early' } })) as any;
    expect(closed.isError).toBe(true);
    expect(closed.content[0].text).toMatch(/Refused|negotiating/);
    await claude.close();
  });

  it('keeps agent identities separate across two concurrent clients', async () => {
    const { handle, provisioned } = await boot();
    const claude = await connect(handle.port, provisioned.agents.get('claude')!.token);
    const codex = await connect(handle.port, provisioned.agents.get('codex')!.token);

    await claude.callTool({ name: 'create_issue', arguments: { title: 'Identity test', body: 'who is who' } });
    const digest = (await codex.callTool({ name: 'catch_up', arguments: {} })) as any;
    expect(digest.content[0].text).toContain('Identity test');

    // codex (not lead) cannot post a decision — identity is enforced server-side
    const issue = handle.store.issues.byNumber(handle.store.sessions.active()!.id, 1)!;
    const denied = (await codex.callTool({
      name: 'post_message',
      arguments: { issue_id: issue.id, type: 'decision', body: 'I decide!' },
    })) as any;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('Only the lead');
    await claude.close();
    await codex.close();
  });
});
