import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerAdapter, configFor, promptFor } from './index.js';

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super(); this.url = url; this.sent = []; queueMicrotask(() => this.dispatchEvent(new Event('open')));
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

test('new run and resumed run use ACP v1, preserve session and stream output', async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  try {
    const adapter = createServerAdapter();
    const log = [];
    const ctx = { config: { url: 'ws://localhost/acp', agentAlias: 'coder' }, runId: 'r1', agent: { id: 'a1', companyId: 'co1', name: 'Coder' }, context: { taskId: 'issue-1' }, runtime: { sessionId: null, sessionParams: null }, onLog: async (_, chunk) => log.push(chunk) };
    const first = await adapter.execute(ctx);
    assert.equal(first.exitCode, 0);
    assert.equal(first.sessionParams.zeroclawSessionId, 's-test');
    assert.deepEqual(log, ['done']);
    const second = await adapter.execute({ ...ctx, runtime: { sessionId: null, sessionParams: first.sessionParams } });
    assert.equal(second.sessionId, 's-test');
  } finally { globalThis.WebSocket = previous; }
});

test('rejects insecure remote ACP URL', () => {
  assert.throws(() => configFor({ url: 'ws://example.org/acp' }), /wss/);
  assert.throws(() => configFor({ url: 'ws://172.27.80.1:42617/acp' }), /allowPlainPrivateWs/);
  assert.throws(() => configFor({ url: 'ws://8.8.8.8/acp', allowPlainPrivateWs: true }), /wss/);
  assert.equal(configFor({ url: 'ws://172.27.80.1:42617/acp', allowPlainPrivateWs: true }).host, '172.27.80.1:42617');
});

test('wake prompt identifies the dedicated Paperclip credential and issue update', () => {
  const prompt = promptFor({ config: { paperclipApiUrl: 'http://127.0.0.1:3100/' }, runId: 'run-42', agent: { id: 'agent-1', companyId: 'company-1', name: 'Delia' }, context: { taskId: 'issue-1' } });
  assert.match(prompt, /auth_secret "paperclip"/);
  assert.match(prompt, /X-Paperclip-Run-Id.*run-42/);
  assert.match(prompt, /PATCH http:\/\/127\.0\.0\.1:3100\/api\/issues\/\{issueId\}/);
  assert.match(prompt, /"taskId":"issue-1"/);
});
