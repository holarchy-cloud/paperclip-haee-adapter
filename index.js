const TYPE = 'zeroclaw_acp';
const TIMEOUT_MS = 30_000;
export const type = TYPE;
export const label = 'ZeroClaw ACP';
export const models = [];
export const agentConfigurationDoc = '# ZeroClaw ACP\nConfigure url (wss://host/acp) and agentAlias; set ZEROCLAW_ACP_TOKEN in the Paperclip server environment. For a Windows host reached from WSL through its private NAT IP, enable allowPlainPrivateWs. Configure the ZeroClaw agent with Paperclip API access through its own secret mechanism.';

function configFor(config) {
  const url = new URL(String(config.url || ''));
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('ZeroClaw ACP requires ws:// or wss://');
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const parts = url.hostname.split('.').map(Number);
    const privateIpv4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168));
    if (!privateIpv4 || config.allowPlainPrivateWs !== true) {
      throw new Error('Remote ZeroClaw ACP requires wss://; for a trusted private Windows host, enable allowPlainPrivateWs');
    }
  }
  if (url.pathname !== '/acp') throw new Error('ZeroClaw ACP URL must end in /acp');
  if (config.agentAlias) url.searchParams.set('agent', String(config.agentAlias));
  if (process.env.ZEROCLAW_ACP_TOKEN) url.searchParams.set('token', process.env.ZEROCLAW_ACP_TOKEN);
  return url;
}

class AcpClient {
  constructor(url, onUpdate, onPermission) {
    this.url = url;
    this.onUpdate = onUpdate;
    this.onPermission = onPermission;
    this.pending = new Map();
    this.nextId = 1;
    this.chain = Promise.resolve();
    this.closed = false;
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACP connection timed out')), TIMEOUT_MS);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ACP WebSocket connection failed')); }, { once: true });
      this.ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('ACP WebSocket closed before connecting')); }, { once: true });
    });
    this.ws.addEventListener('message', event => {
      this.chain = this.chain.then(() => this.receive(JSON.parse(event.data))).catch(error => this.fail(error));
    });
    this.ws.addEventListener('close', () => this.fail(new Error('ACP connection closed')));
    this.ws.addEventListener('error', () => this.fail(new Error('ACP connection failed')));
  }
  send(message) { this.ws.send(JSON.stringify({ jsonrpc: '2.0', ...message })); }
  request(method, params = {}, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async receive(message) {
    if ('id' in message && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`ACP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    } else if (message.method === 'session/update') {
      await this.onUpdate(message.params);
    } else if (message.method === 'session/request_permission' && 'id' in message) {
      // Never grant tool permission merely because the runtime requested it.
      const outcome = await this.onPermission(message.params);
      this.send({ id: message.id, result: { outcome } });
    } else if ('id' in message && message.method) {
      this.send({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
    }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  close() { this.fail(new Error('ACP client closed')); this.ws?.close(); }
}

function promptFor(ctx) {
  const payload = {
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    context: ctx.context,
  };
  const apiUrl = String(ctx.config.paperclipApiUrl || 'http://127.0.0.1:3100').replace(/\/+$/, '');
  let prompt = `You are the Paperclip agent ${ctx.agent.name}. Execute this heartbeat.\n\nPaperclip API base URL (reachable from this ZeroClaw host): ${apiUrl}\nUse ZeroClaw's http_request tool for Paperclip API calls. Set auth_secret to "paperclip" on EVERY request; this supplies the dedicated Paperclip agent API key as Authorization. Never use a token from the wake context or runtime-tools MCP for /api/*, and never display a credential. Set the X-Paperclip-Run-Id header to ${ctx.runId} on every mutating request. For JSON requests set Content-Type to application/json and pass a JSON string as body.\n\nFor an assigned issue, follow its instruction, then PATCH ${apiUrl}/api/issues/{issueId} with auth_secret "paperclip", headers {"X-Paperclip-Run-Id":"${ctx.runId}","Content-Type":"application/json"}, and body {"status":"done"} when complete. Use the actual issue UUID from the wake context, not its MAT- identifier. If the API denies a write, report the HTTP status and error without claiming the issue changed state. A final report or issue comment does not itself mark the issue done.\n\nPaperclip wake context:\n${JSON.stringify(payload)}`;
  return prompt;
}

async function execute(ctx) {
  const url = configFor(ctx.config);
  if (ctx.signal?.aborted) return { exitCode: null, signal: 'SIGINT', timedOut: false, errorMessage: 'Cancelled before dispatch' };
  const client = new AcpClient(url, async params => {
    const update = params?.update || {};
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      await ctx.onLog('stdout', update.content.text);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      await ctx.onLog('stdout', `\n[${update.sessionUpdate}: ${update.title || update.toolCallId || ''} ${update.status || ''}]\n`);
    }
  }, async () => ({ outcome: 'cancelled' }));
  let sessionId;
  let cancelled = false;
  const abort = () => {
    cancelled = true;
    if (sessionId) client.send({ method: 'session/cancel', params: { sessionId } });
    // A lost cancellation reply must not leave the Paperclip run hanging.
    setTimeout(() => client.close(), 5000).unref();
  };
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    ctx.onDispatch?.();
    await client.connect();
    const init = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'paperclip-zeroclaw-acp', version: '0.1.0' } }, TIMEOUT_MS);
    if (init?.protocolVersion !== 1) throw new Error('ZeroClaw ACP protocol v1 required');
    const previous = ctx.runtime.sessionParams?.zeroclawSessionId || ctx.runtime.sessionId;
    if (previous && ctx.config.resumeSessions !== false) {
      try {
        await client.request('session/resume', { sessionId: previous }, TIMEOUT_MS);
        sessionId = previous;
      } catch (error) {
        // Fail closed: an expired/busy session cannot silently lose context or duplicate work.
        throw new Error(`Cannot resume ZeroClaw session ${previous}: ${error.message}`);
      }
    } else {
      const params = {};
      if (ctx.config.agentAlias) params.agentAlias = String(ctx.config.agentAlias);
      if (ctx.config.cwd) params.cwd = String(ctx.config.cwd);
      const created = await client.request('session/new', params, TIMEOUT_MS);
      sessionId = created?.sessionId;
      if (!sessionId) throw new Error('ZeroClaw did not return a sessionId');
    }
    if (cancelled) return { exitCode: null, signal: 'SIGINT', timedOut: false, sessionId };
    const result = await client.request('session/prompt', { sessionId, prompt: promptFor(ctx) });
    const completedSessionId = sessionId;
    // Persisted history remains available after deactivating the live session.
    await client.request('session/close', { sessionId }, TIMEOUT_MS);
    sessionId = null;
    const wasCancelled = cancelled || result?.stopReason === 'cancelled';
    return {
      exitCode: wasCancelled ? null : 0,
      signal: wasCancelled ? 'SIGINT' : null,
      timedOut: false,
      sessionId: completedSessionId,
      sessionParams: { zeroclawSessionId: completedSessionId },
      sessionDisplayId: completedSessionId,
      summary: wasCancelled ? 'ZeroClaw turn cancelled' : String(result?.content || 'ZeroClaw turn completed').slice(0, 2000),
      provider: 'zeroclaw',
      resultJson: { stopReason: result?.stopReason || null },
    };
  } finally {
    ctx.signal?.removeEventListener('abort', abort);
    client.close();
  }
}

async function testEnvironment(ctx) {
  const checks = [];
  try {
    const url = configFor(ctx.config);
    const client = new AcpClient(url, async () => {}, async () => ({ outcome: 'cancelled' }));
    try {
      await client.connect();
      const result = await client.request('initialize', { protocolVersion: 1 }, TIMEOUT_MS);
      if (result?.protocolVersion !== 1) throw new Error('ACP v1 unavailable');
      checks.push({ code: 'acp_ready', level: 'info', message: 'ZeroClaw ACP v1 reachable' });
    } finally { client.close(); }
  } catch (error) {
    checks.push({ code: 'acp_unavailable', level: 'error', message: error.message });
  }
  return { adapterType: TYPE, status: checks[0].level === 'info' ? 'pass' : 'fail', checks, testedAt: new Date().toISOString() };
}

export function createServerAdapter() {
  return {
    type: TYPE,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    getConfigSchema: () => ({ fields: [
      { key: 'url', label: 'ZeroClaw ACP URL', type: 'text', required: true, hint: 'wss://node.example/acp' },
      { key: 'agentAlias', label: 'ZeroClaw agent alias', type: 'text' },
      { key: 'cwd', label: 'Workspace on ZeroClaw host', type: 'text' },
      { key: 'paperclipApiUrl', label: 'Paperclip API base URL reachable from ZeroClaw', type: 'text', default: 'http://127.0.0.1:3100', hint: 'Use the URL reachable from the Windows ZeroClaw host' },
      { key: 'allowPlainPrivateWs', label: 'Allow plain WebSocket to a private host IP', type: 'toggle', default: false, hint: 'Enable only for a trusted local network such as the WSL to Windows host link' },
    ] }),
  };
}

export { AcpClient, configFor, promptFor };
