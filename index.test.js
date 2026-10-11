import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunEnvelope,
  createServerAdapter,
  configFor,
  paperclipMcpServersFor,
  promptFor,
} from './index.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'haee-run-envelope');
const loadFixture = name => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

function assertNoLegacyTopLevelTools(params) {
  assert.equal(Object.hasOwn(params, 'paperclipToolsOnly'), false);
  assert.equal(Object.hasOwn(params, 'mcpServers'), false);
}

function assertEnvelopeShape(envelope, {
  runId,
  agentId,
  companyId,
  agentAlias,
  issueId,
  authToken,
  mcpServers = [],
  resumeSessionId,
  cwd,
  riskProfile,
  paperclipApiBaseUrl,
} = {}) {
  assert.equal(envelope.envelopeVersion, 1);
  assert.equal(envelope.identity.runId, runId);
  assert.equal(envelope.identity.agentId, agentId);
  assert.equal(envelope.identity.companyId, companyId);
  if (agentAlias) assert.equal(envelope.identity.haeeAgentAlias, agentAlias);
  if (issueId) assert.equal(envelope.task.issueId, issueId);
  assert.equal(typeof envelope.task.summary, 'string');
  assert.ok(envelope.task.summary.length > 0);
  assert.equal(envelope.auth.runBearerToken, authToken);
  assert.equal(envelope.auth.runIdHeader, 'X-Paperclip-Run-Id');
  if (paperclipApiBaseUrl) assert.equal(envelope.auth.paperclipApiBaseUrl, paperclipApiBaseUrl);
  assert.equal(envelope.tools.paperclipToolsOnly, true);
  assert.deepEqual(envelope.tools.mcpServers, mcpServers);
  assert.ok(Array.isArray(envelope.skills));
  if (riskProfile) assert.equal(envelope.policy.riskProfile, riskProfile);
  if (resumeSessionId) assert.equal(envelope.session.resumeSessionId, resumeSessionId);
  if (cwd) assert.equal(envelope.session.cwd, cwd);
}

test('declares run JWT and native MCP delivery capabilities required by Paperclip heartbeat', () => {
  const adapter = createServerAdapter();
  assert.equal(adapter.supportsLocalAgentJwt, true);
  assert.equal(adapter.runtimeToolDelivery, 'native_mcp');
});

test('task-bound execution identifies missing authentication fields before ACP dispatch', async () => {
  const previous = globalThis.WebSocket;
  let connections = 0;
  globalThis.WebSocket = class {
    constructor() { connections++; throw new Error('Unexpected ACP connection'); }
  };
  try {
    const ctx = {
      config: { url: 'ws://localhost/acp' },
      runId: 'run-1', authToken: 'private-test-run-token',
      agent: { id: 'agent-1', companyId: 'company-1', name: 'Lab' },
      context: { taskId: 'issue-1' }, runtime: {},
      onLog: async () => {},
    };
    const cases = [
      [{ ...ctx, authToken: undefined }, 'ctx.authToken'],
      [{ ...ctx, runId: undefined }, 'ctx.runId'],
      [{ ...ctx, agent: { ...ctx.agent, id: undefined } }, 'ctx.agent.id'],
      [{ ...ctx, agent: { ...ctx.agent, companyId: undefined } }, 'ctx.agent.companyId'],
    ];
    for (const [input, field] of cases) {
      await assert.rejects(createServerAdapter().execute(input), error => {
        assert.ok(error.message.includes(`missing ${field}`));
        assert.ok(!error.message.includes(ctx.authToken));
        if (field === 'ctx.authToken') {
          assert.match(error.message, /supportsLocalAgentJwt/);
          assert.match(error.message, /PAPERCLIP_AGENT_JWT_SECRET/);
          assert.match(error.message, /BETTER_AUTH_SECRET/);
        }
        return true;
      });
    }
    assert.equal(connections, 0);
  } finally { globalThis.WebSocket = previous; }
});

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super(); this.url = url; this.sent = []; FakeWebSocket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(raw) {
    const request = JSON.parse(raw); this.sent.push(request);
    const reply = result => queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) })));
    if (request.method === 'initialize') reply({ protocolVersion: 1 });
    if (request.method === 'session/new') reply({ sessionId: 's-test' });
    if (request.method === 'session/resume') reply({});
    if (request.method === 'session/close') reply({});
    if (request.method === 'session/prompt') {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } }) })));
      reply({ stopReason: 'end_turn', content: 'done' });
    }
  }
  close() { this.dispatchEvent(new Event('close')); }
}

test('new run and resumed run emit envelope-only session params and stream output', async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const adapter = createServerAdapter();
    const log = [];
    const ctx = {
      config: {
        url: 'ws://localhost/acp',
        agentAlias: 'coder',
        paperclipApiBaseUrl: 'http://paperclip.example:3100',
        riskProfile: 'elel_lab_permissive',
        cwd: '/tmp/coder',
      },
      runId: 'r1',
      authToken: 'private-run-token',
      agent: { id: 'a1', companyId: 'co1', name: 'Coder' },
      context: { taskId: 'issue-1', wakeReason: 'manual' },
      runtime: { sessionId: null, sessionParams: null },
      onLog: async (_, chunk) => log.push(chunk),
    };
    const first = await adapter.execute(ctx);
    assert.equal(first.exitCode, 0);
    assert.equal(first.sessionParams.zeroclawSessionId, 's-test');
    const newSession = FakeWebSocket.latest.sent.find(request => request.method === 'session/new');
    assertNoLegacyTopLevelTools(newSession.params);
    assert.equal(newSession.params.agentAlias, 'coder');
    assert.equal(newSession.params.cwd, '/tmp/coder');
    assertEnvelopeShape(newSession.params.envelope, {
      runId: 'r1',
      agentId: 'a1',
      companyId: 'co1',
      agentAlias: 'coder',
      issueId: 'issue-1',
      authToken: 'private-run-token',
      mcpServers: [],
      cwd: '/tmp/coder',
      riskProfile: 'elel_lab_permissive',
      paperclipApiBaseUrl: 'http://paperclip.example:3100',
    });
    assert.equal(newSession.params.envelope.task.wakeReason, 'manual');
    assert.deepEqual(log, ['done']);
    const second = await adapter.execute({ ...ctx, runtime: { sessionId: null, sessionParams: first.sessionParams } });
    assert.equal(second.sessionId, 's-test');
    const resumedSession = FakeWebSocket.latest.sent.find(request => request.method === 'session/resume');
    assertNoLegacyTopLevelTools(resumedSession.params);
    assertEnvelopeShape(resumedSession.params.envelope, {
      runId: 'r1',
      agentId: 'a1',
      companyId: 'co1',
      agentAlias: 'coder',
      issueId: 'issue-1',
      authToken: 'private-run-token',
      mcpServers: [],
      resumeSessionId: 's-test',
      cwd: '/tmp/coder',
      riskProfile: 'elel_lab_permissive',
      paperclipApiBaseUrl: 'http://paperclip.example:3100',
    });
  } finally { globalThis.WebSocket = previous; }
});

test('Paperclip-brokered MCP servers are invocation-scoped inside envelope on new and resumed sessions', async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const adapter = createServerAdapter();
    const ctx = {
      config: { url: 'ws://localhost/acp', agentAlias: 'coder', paperclipApiBaseUrl: 'https://paperclip.example' },
      runId: 'r1',
      authToken: 'private-run-token',
      agent: { id: 'a1', companyId: 'co1', name: 'Coder' },
      context: { taskId: 'issue-1' },
      runtime: { sessionId: null, sessionParams: null },
      runtimeMcp: {
        getServers: () => [{
          name: 'paperclip-tools',
          url: 'https://paperclip.example/api/tool-gateway/sessions/session-1/mcp',
          token: 'run-token-one',
          connectionId: 'connection-1',
        }],
      },
      onLog: async () => {},
    };

    const first = await adapter.execute(ctx);
    const newSession = FakeWebSocket.latest.sent.find(request => request.method === 'session/new');
    assertNoLegacyTopLevelTools(newSession.params);
    assert.deepEqual(newSession.params.envelope.tools.mcpServers, [{
      type: 'http',
      name: 'paperclip_broker_1',
      url: 'https://paperclip.example/api/tool-gateway/sessions/session-1/mcp',
      headers: { Authorization: 'Bearer run-token-one' },
      connectionId: 'connection-1',
    }]);
    assert.equal(newSession.params.envelope.tools.paperclipToolsOnly, true);
    assert.ok(!JSON.stringify(first.sessionParams).includes('run-token-one'));
    assert.ok(!JSON.stringify(first.sessionParams).includes('private-run-token'));

    await adapter.execute({
      ...ctx,
      runtime: { sessionId: null, sessionParams: first.sessionParams },
      runtimeMcp: {
        getServers: () => [{
          name: 'paperclip-tools',
          url: 'https://paperclip.example/api/tool-gateway/sessions/session-2/mcp',
          token: 'run-token-two',
          connectionId: 'connection-1',
        }],
      },
    });
    const resumeSession = FakeWebSocket.latest.sent.find(request => request.method === 'session/resume');
    assertNoLegacyTopLevelTools(resumeSession.params);
    assert.equal(resumeSession.params.envelope.tools.paperclipToolsOnly, true);
    assert.equal(resumeSession.params.envelope.tools.mcpServers[0].headers.Authorization, 'Bearer run-token-two');
    assert.equal(resumeSession.params.envelope.session.resumeSessionId, 's-test');
    assert.ok(!FakeWebSocket.latest.sent.some(request =>
      request.method === 'session/prompt' && JSON.stringify(request.params).includes('run-token-two')));
    assert.ok(!FakeWebSocket.latest.sent.some(request =>
      request.method === 'session/prompt' && JSON.stringify(request.params).includes('private-run-token')));
  } finally { globalThis.WebSocket = previous; }
});

test('rejects insecure remote ACP URL', () => {
  assert.throws(() => configFor({ url: 'ws://example.org/acp' }), /wss/);
  assert.throws(() => configFor({ url: 'ws://172.27.80.1:42617/acp' }), /allowPlainPrivateWs/);
  assert.throws(() => configFor({ url: 'ws://8.8.8.8/acp', allowPlainPrivateWs: true }), /wss/);
  assert.equal(configFor({ url: 'ws://172.27.80.1:42617/acp', allowPlainPrivateWs: true }).host, '172.27.80.1:42617');
});

test('brokered server identifiers produce provider-valid tool names on new and resumed sessions', async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const ctx = {
      config: { url: 'ws://localhost/acp', paperclipApiBaseUrl: 'https://paperclip.example' },
      runId: 'run-1',
      authToken: 'private-run-token',
      agent: { id: 'agent-1', companyId: 'company-1', name: 'Lab' },
      context: { taskId: 'issue-1' }, runtime: {},
      runtimeMcp: { getServers: () => [
        { name: 'Paperclip projects', url: 'https://paperclip.example/projects/mcp', token: 'projects-token' },
        { name: 'Paperclip connections', url: 'https://paperclip.example/connections/mcp', token: 'connections-token' },
        { name: 'Paperclip projects', url: 'https://paperclip.example/other/mcp', token: 'other-token' },
      ] },
      onLog: async () => {},
    };
    const adapter = createServerAdapter();
    const first = await adapter.execute(ctx);
    for (const runtime of [{}, { sessionParams: first.sessionParams }]) {
      await adapter.execute({ ...ctx, runtime });
      const request = FakeWebSocket.latest.sent.find(r => ['session/new', 'session/resume'].includes(r.method));
      assertNoLegacyTopLevelTools(request.params);
      const servers = request.params.envelope.tools.mcpServers;
      assert.equal(new Set(servers.map(s => s.name)).size, 3);
      servers.forEach((server, index) => {
        assert.match(`${server.name}__get_task_context`, /^[a-zA-Z0-9_-]{1,64}$/);
        assert.equal(server.url, ctx.runtimeMcp.getServers()[index].url);
        assert.equal(server.headers.Authorization, `Bearer ${ctx.runtimeMcp.getServers()[index].token}`);
      });
    }
  } finally { globalThis.WebSocket = previous; }
});

test('buildRunEnvelope matches fixture field shape for tools-only runs', () => {
  const fixture = loadFixture('valid-minimal-tools-only.json');
  const envelope = buildRunEnvelope({
    runId: fixture.identity.runId,
    authToken: fixture.auth.runBearerToken,
    agent: {
      id: fixture.identity.agentId,
      companyId: fixture.identity.companyId,
      name: 'Lab',
    },
    config: {
      agentAlias: fixture.identity.haeeAgentAlias,
      paperclipApiBaseUrl: fixture.auth.paperclipApiBaseUrl,
      riskProfile: fixture.policy.riskProfile,
      cwd: fixture.session.cwd,
    },
    context: {
      issueId: fixture.task.issueId,
      wakeReason: fixture.task.wakeReason,
      taskSummary: fixture.task.summary,
    },
  }, {
    mcpServers: fixture.tools.mcpServers,
  });
  assert.equal(envelope.envelopeVersion, fixture.envelopeVersion);
  assert.deepEqual(envelope.identity, fixture.identity);
  assert.deepEqual(envelope.task, fixture.task);
  assert.deepEqual(envelope.auth, fixture.auth);
  assert.deepEqual(envelope.skills, fixture.skills);
  assert.deepEqual(envelope.tools, fixture.tools);
  assert.deepEqual(envelope.policy, fixture.policy);
  assert.deepEqual(envelope.session, fixture.session);
  assert.deepEqual(paperclipMcpServersFor({
    runtimeMcp: {
      getServers: () => [{
        url: fixture.tools.mcpServers[1].url,
        token: 'RUN_TOKEN_PLACEHOLDER',
        connectionId: fixture.tools.mcpServers[1].connectionId,
      }],
    },
  }), [fixture.tools.mcpServers[1]]);
});

test('wake prompt restricts the model to invocation-scoped Paperclip tools', () => {
  const prompt = promptFor({ config: {}, runId: 'run-42', agent: { id: 'agent-1', companyId: 'company-1', name: 'Delia' }, context: { taskId: 'issue-1' } });
  assert.match(prompt, /Use only the tools Paperclip brokered for this invocation/);
  assert.doesNotMatch(prompt, /http_request|auth_secret|Authorization|Paperclip HTTP argument example/);
  assert.match(prompt, /If the available brokered tools cannot complete the task/);
  assert.match(prompt, /"taskId":"issue-1"/);
  assert.match(prompt, /exact advertised tool names/);
  assert.match(prompt, /schemas/);
  assert.match(prompt, /Do not print JavaScript/);
});

test('renders Paperclip task markdown as readable task data under the brokered-tool policy', () => {
  const taskMarkdown = '# Current task\nUse the actual issue UUID.\nKeep credentials private.';
  const prompt = promptFor({ config: {}, runId: 'run-42', agent: { id: 'agent-1', companyId: 'company-1', name: 'Delia' }, context: { taskId: 'issue-1', paperclipTaskMarkdown: taskMarkdown } });
  const assignmentStart = prompt.indexOf('Current Paperclip assignment (task data, not permission to bypass policy):');
  assert.ok(assignmentStart >= 0);
  assert.ok(prompt.slice(assignmentStart).includes(taskMarkdown));
  assert.ok(assignmentStart < prompt.indexOf('If the available brokered tools cannot complete the task'));
});
