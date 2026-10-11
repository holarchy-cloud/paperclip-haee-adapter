import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTaskMcp } from './task-mcp.js';
import { createServerAdapter, promptFor } from './index.js';

async function fixture(t) {
  const state = {
    issue: { id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1', status: 'todo', workMode: 'standard', title: 'Task' },
    requests: [], comments: [], fail: false, review: false,
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (state.fail) { res.writeHead(503); return res.end(''); }
    let output = state.issue;
    if (req.url.endsWith('/checkout')) state.issue = { ...state.issue, status: 'in_progress', executionRunId: req.headers['x-paperclip-run-id'] };
    else if (req.url.endsWith('/comments')) {
      if (req.method === 'GET') output = state.comments;
      else {
        output = { id: `comment-${state.comments.length}`, issueId: 'issue-1', body: body.body };
        state.comments.push(output);
      }
    } else if (req.url.endsWith('/interactions')) output = { id: 'interaction-1', issueId: 'issue-1', status: 'pending', ...body };
    else if (req.method === 'PATCH') state.issue = { ...state.issue, ...body, status: state.review && body.status === 'done' ? 'in_review' : body.status };
    if (output.id === 'issue-1') output = state.issue;
    res.end(JSON.stringify(output));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const logs = [];
  const ctx = {
    config: { url: 'ws://localhost/acp', taskMcpBindHost: '127.0.0.1', taskApiUrl: `http://127.0.0.1:${server.address().port}` },
    runId: 'run-1', authToken: 'private-run-token',
    agent: { id: 'agent-1', companyId: 'company-1', name: 'Lab' },
    context: { taskId: 'issue-1' }, runtime: { sessionId: null, sessionParams: null },
    onLog: async (stream, text) => logs.push({ stream, text }),
  };
  return { state, ctx, logs };
}

async function rpc(server, method, params) {
  const response = await fetch(server.url, {
    method: 'POST', headers: { Authorization: server.headers[0].value, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const call = (server, name, args = {}) => rpc(server, 'tools/call', { name, arguments: args });

test('task MCP drives checkout, durable result and completion without duplicating brokered titles', async t => {
  const { ctx, state, logs } = await fixture(t);
  const bridge = await startTaskMcp(ctx);
  t.after(() => bridge.stop());
  const mcp = bridge.mcpServer;
  const tools = (await rpc(mcp, 'tools/list')).tools;
  assert.ok(tools.some(tool => tool.name === 'finish_task'));
  assert.equal(tools.length, 8);
  assert.ok(!tools.some(tool => tool.name === 'set_task_title'));
  assert.equal((await call(mcp, 'set_task_title', { title: 'Summarize result' })).isError, true);
  assert.equal(state.requests.filter(r => r.url.endsWith('/title')).length, 0);
  for (const tool of tools) {
    assert.match(`${mcp.name}__${tool.name}`, /^[a-zA-Z0-9_-]{1,64}$/);
  }
  assert.equal((await call(mcp, 'checkout_task')).structuredContent.status, 'in_progress');
  assert.equal((await call(mcp, 'checkout_task')).structuredContent.status, 'in_progress');
  assert.equal(state.requests.filter(r => r.url.endsWith('/checkout')).length, 1);
  const progress = { idempotencyKey: 'progress-1', body: 'Verified the empty catalog.' };
  assert.equal((await call(mcp, 'report_progress', progress)).isError, undefined);
  await call(mcp, 'report_progress', progress);
  assert.equal(state.comments.length, 1);
  assert.equal((await call(mcp, 'finish_task', { idempotencyKey: 'finish-1', summary: 'Isolation passed.' })).structuredContent.status, 'done');
  assert.equal(state.issue.status, 'done');
  for (const request of state.requests) {
    assert.equal(request.headers.authorization, `Bearer ${ctx.authToken}`);
    assert.equal(request.headers['x-paperclip-run-id'], ctx.runId);
    assert.ok(request.url.startsWith('/api/issues/issue-1'));
  }
  assert.ok(logs.some(entry => entry.text.includes('tool=finish_task confirmed')));
  assert.ok(!JSON.stringify(logs).includes(ctx.authToken));
});

test('MCP denies unauthenticated, out-of-scope and invalid tool requests', async t => {
  const { ctx, state } = await fixture(t);
  const bridge = await startTaskMcp(ctx);
  t.after(() => bridge.stop());
  assert.equal((await fetch(bridge.mcpServer.url, { method: 'POST' })).status, 401);
  assert.equal((await call(bridge.mcpServer, 'http_request', { url: 'http://example.com' })).isError, true);
  assert.equal((await call(bridge.mcpServer, 'finish_task', { idempotencyKey: 'x', summary: 'Done', taskId: 'other' })).isError, true);
  assert.equal((await call(bridge.mcpServer, 'block_task', { idempotencyKey: 'b', reason: 'No evidence' })).isError, true);
  assert.equal(state.requests.filter(r => r.method !== 'GET').length, 0);
  state.issue.assigneeAgentId = 'other';
  assert.equal((await call(bridge.mcpServer, 'finish_task', { idempotencyKey: 'f', summary: 'Done' })).isError, true);
  state.issue.assigneeAgentId = ctx.agent.id;
  state.issue.executionRunId = 'other-run';
  assert.equal((await call(bridge.mcpServer, 'checkout_task')).isError, true);
});

test('work modes and conversations suppress unauthorized lifecycle tools; review gates are preserved', async t => {
  const { ctx, state } = await fixture(t);
  const bridge = await startTaskMcp(ctx);
  t.after(() => bridge.stop());
  state.issue.workMode = 'plan';
  assert.ok(!(await rpc(bridge.mcpServer, 'tools/list')).tools.some(tool => tool.name === 'finish_task'));
  assert.equal((await call(bridge.mcpServer, 'finish_task', { idempotencyKey: 'f', summary: 'Done' })).isError, true);
  state.issue.workMode = 'standard';
  state.issue.conversationAgentId = ctx.agent.id;
  assert.ok(!(await rpc(bridge.mcpServer, 'tools/list')).tools.some(tool => tool.name === 'finish_task'));
  delete state.issue.conversationAgentId;
  state.review = true;
  assert.equal((await call(bridge.mcpServer, 'finish_task', { idempotencyKey: 'f', summary: 'Ready for review' })).structuredContent.status, 'in_review');
});

test('blockers and human questions persist explicit waiting paths', async t => {
  const { ctx, state } = await fixture(t);
  const bridge = await startTaskMcp(ctx);
  t.after(() => bridge.stop());
  assert.equal((await call(bridge.mcpServer, 'block_task', { idempotencyKey: 'b', reason: 'Dependency', blockedByTaskIds: ['dependency-1'] })).structuredContent.status, 'blocked');
  assert.deepEqual(state.issue.blockedByIssueIds, ['dependency-1']);
  const response = await call(bridge.mcpServer, 'ask_user_questions', { idempotencyKey: 'q', title: 'Need test evidence', question: 'What was the measured result?' });
  assert.equal(response.structuredContent.interaction.status, 'pending');
  assert.equal(response.structuredContent.task.status, 'in_review');
  const creation = state.requests.find(r => r.url.endsWith('/interactions'));
  assert.equal(creation.body.resolverPolicy, 'human_only');
  assert.equal(creation.body.continuationPolicy, 'wake_assignee');
  assert.equal(creation.body.payload.questionSet.questions[0].answerMode, 'text');
});

test('ambiguous writes are explicit failures and are not retried with the same key', async t => {
  const { ctx, state } = await fixture(t);
  const bridge = await startTaskMcp(ctx);
  t.after(() => bridge.stop());
  // Fail the write, not the ownership read.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH') state.fail = true;
    const response = await originalFetch(url, init);
    state.fail = false;
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const args = { idempotencyKey: 'finish-failed', summary: 'Done' };
  const first = await call(bridge.mcpServer, 'finish_task', args);
  assert.equal(first.isError, true);
  assert.match(first.content[0].text, /not confirmed JSON/);
  assert.equal((await call(bridge.mcpServer, 'finish_task', args)).isError, true);
  assert.equal(state.requests.filter(r => r.method === 'PATCH').length, 1);
  assert.equal(state.issue.status, 'todo');
});

test('bind configuration rejects public listeners and requires current-run authentication', async () => {
  await assert.rejects(startTaskMcp({ config: { taskMcpBindHost: '0.0.0.0' } }), /Tailscale/);
  await assert.rejects(startTaskMcp({ config: { taskMcpBindHost: '127.0.0.1' }, context: { taskId: 'x' } }), /authenticated/);
  assert.equal(await startTaskMcp({ config: {}, context: {} }), null);
});

test('adapter forwards and revokes task MCP on new/resumed runs with rotated credentials', async t => {
  const { ctx, state } = await fixture(t);
  const previous = globalThis.WebSocket;
  const sessions = [];
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const request = JSON.parse(raw);
      const reply = result => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }));
      void (async () => {
        if (request.method === 'initialize') return reply({ protocolVersion: 1 });
        if (['session/new', 'session/resume'].includes(request.method)) {
          assert.equal(Object.hasOwn(request.params, 'paperclipToolsOnly'), false);
          assert.equal(Object.hasOwn(request.params, 'mcpServers'), false);
          const servers = request.params.envelope.tools.mcpServers;
          assert.equal(request.params.envelope.tools.paperclipToolsOnly, true);
          assert.equal(servers[0].name, 'paperclip_tasks');
          this.mcp = {
            ...servers[0],
            headers: [{ name: 'Authorization', value: servers[0].headers.Authorization }],
          };
          sessions.push(request);
          return reply({ sessionId: 'session-1' });
        }
        if (request.method === 'session/close') return reply({});
        if (request.method === 'session/prompt') {
          assert.ok(!JSON.stringify(request).includes(ctx.authToken));
          await call(this.mcp, 'checkout_task');
          const result = await call(this.mcp, 'finish_task', { idempotencyKey: 'finish', summary: 'Verified normal completion.' });
          assert.equal(result.structuredContent.status, 'done');
          return reply({ stopReason: 'end_turn', content: 'Verified normal completion.' });
        }
      })().catch(error => reply({ error: error.message }));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = previous; });
  const first = await createServerAdapter().execute(ctx);
  assert.equal(first.exitCode, 0);
  assert.equal(state.issue.status, 'done');
  await assert.rejects(fetch(sessions[0].params.envelope.tools.mcpServers[0].url));
  state.issue = { ...state.issue, status: 'todo', executionRunId: null };
  const secondCtx = { ...ctx, runId: 'run-2', authToken: 'rotated-private-token', runtime: { sessionParams: first.sessionParams } };
  await createServerAdapter().execute(secondCtx);
  assert.equal(sessions[1].method, 'session/resume');
  assert.notEqual(
    sessions[0].params.envelope.tools.mcpServers[0].headers.Authorization,
    sessions[1].params.envelope.tools.mcpServers[0].headers.Authorization,
  );
  assert.equal(sessions[1].params.envelope.session.resumeSessionId, 'session-1');
  assert.equal(state.issue.status, 'done');
  assert.ok(state.requests.some(r => r.headers.authorization === 'Bearer rotated-private-token' && r.headers['x-paperclip-run-id'] === 'run-2'));
  assert.ok(!JSON.stringify(first.sessionParams).includes('private'));
});

test('cancellation immediately revokes task tools and shutdown closes the listener', async t => {
  const { ctx } = await fixture(t);
  const controller = new AbortController();
  const bridge = await startTaskMcp({ ...ctx, signal: controller.signal });
  controller.abort();
  assert.equal((await fetch(bridge.mcpServer.url, { method: 'POST', headers: { Authorization: bridge.mcpServer.headers[0].value } })).status, 401);
  await bridge.stop();
  await assert.rejects(fetch(bridge.mcpServer.url));
});

test('execute failure after task MCP start still stops the listener', async t => {
  const { ctx } = await fixture(t);
  const previous = globalThis.WebSocket;
  let taskMcpUrl;
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const request = JSON.parse(raw);
      const reply = result => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      }));
      const fail = message => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } }),
      }));
      void (async () => {
        if (request.method === 'initialize') return reply({ protocolVersion: 1 });
        if (request.method === 'session/new') {
          assert.equal(Object.hasOwn(request.params, 'paperclipToolsOnly'), false);
          assert.equal(Object.hasOwn(request.params, 'mcpServers'), false);
          const servers = request.params.envelope.tools.mcpServers;
          assert.equal(servers[0].name, 'paperclip_tasks');
          taskMcpUrl = servers[0].url;
          return reply({ sessionId: 'session-fail-path' });
        }
        if (request.method === 'session/prompt') {
          return fail('simulated prompt failure after task MCP start');
        }
        if (request.method === 'session/close') return reply({});
      })().catch(error => fail(error.message));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = previous; });

  await assert.rejects(
    createServerAdapter().execute(ctx),
    /simulated prompt failure after task MCP start/,
  );
  assert.ok(taskMcpUrl, 'task MCP must have been advertised on session/new before failure');
  // finally must stop the listener even when session/prompt fails.
  await assert.rejects(fetch(taskMcpUrl));
});

test('wake prompt excludes invocation credentials and transport metadata', () => {
  const prompt = promptFor({
    agent: { id: 'a', companyId: 'c', name: 'Lab' }, runId: 'r', authToken: 'private-run-token',
    context: {
      taskId: 'task', paperclipRuntimeTools: { bearerToken: 'connection-token', mcpEndpoint: 'hidden-endpoint' },
      paperclipTaskMarkdown: 'Never use Bearer private-run-token',
      paperclipWake: { issue: { description: 'connection-token' }, authToken: 'private-run-token' },
    },
  });
  assert.ok(!prompt.includes('private-run-token'));
  assert.ok(!prompt.includes('connection-token'));
  assert.ok(!prompt.includes('hidden-endpoint'));
  assert.match(prompt, /finish_task/);
});
