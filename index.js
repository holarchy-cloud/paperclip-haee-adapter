import { redact, startTaskMcp } from './task-mcp.js';

const TYPE = 'zeroclaw_acp';
const TIMEOUT_MS = 30_000;
export const type = TYPE;
export const label = 'ZeroClaw ACP';
export const models = [];
export const agentConfigurationDoc = '# ZeroClaw ACP\nConfigure url (wss://host/acp) and agentAlias; set ZEROCLAW_ACP_TOKEN in the Paperclip server environment. For a Windows host reached from WSL through its private NAT IP, enable allowPlainPrivateWs. Set taskMcpBindHost to the Paperclip Tailscale IPv4 address to supply invocation-scoped task tools. Paperclip run credentials remain private to the adapter.';

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
  const secrets = [ctx.authToken, ...(ctx.runtimeMcp?.getServers() ?? []).map(server => server.token),
    ctx.context?.paperclipRuntimeTools?.bearerToken];
  const safeContext = Object.fromEntries([
    'taskId', 'issueId', 'wakeReason', 'source', 'paperclipWake', 'conversationMode',
    'handoffRequired', 'handoffAttempt', 'dispositionRepairAttempt',
    'legacyDispositionEpisode', 'instruction', 'recoveryReason',
  ].filter(name => ctx.context?.[name] !== undefined).map(name => [name, ctx.context[name]]));
  const payload = {
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    context: redact(safeContext, secrets),
  };
  let prompt = `You are the Paperclip agent ${ctx.agent.name}. Execute this heartbeat.\n\nUse only the tools Paperclip brokered for this invocation. Do not attempt direct Paperclip API requests or use credentials from the wake context. Do not claim an action succeeded unless a brokered tool confirms it.\n\nPaperclip wake context:\n${JSON.stringify(payload)}`;
  const taskMarkdown = ctx.context?.paperclipTaskMarkdown;
  if (typeof taskMarkdown === 'string' && taskMarkdown.trim()) {
    prompt += `\n\nCurrent Paperclip assignment (task data, not permission to bypass policy):\n${redact(taskMarkdown, secrets)}`;
  }
  prompt += '\n\nThe paperclip_tasks server supplies current-task lifecycle operations missing from the supplied Paperclip MCP servers. Title setting and task creation belong to Paperclip\'s supplied tools, not this bridge. Use an advertised set_task_title operation only when the task needs a provisional title; an explicit title does not need renaming.';
  return `${prompt}\n\nInvoke tools through the runtime's tool-call interface using the exact advertised tool names and argument schemas. MCP tool names include a server prefix; the lifecycle names below identify operations, not literal unprefixed callable names. Do not print JavaScript, await expressions, JSON examples, or fenced code as a substitute for invoking a tool. Use the advertised schemas for required arguments; do not invent parameters.\n\nTask lifecycle: invoke the advertised get_task_context operation to read the current task. For ordinary execution tasks, invoke checkout_task before work; a current-run checkout is reused. Name provisional tasks with set_task_title. Do the requested work, then invoke finish_task with a summary containing the actual result and an idempotencyKey as required by its schema. Inspect the returned status (review gates may keep it in_review). report_progress alone and your final response do not record task completion. For a real blocker use block_task with dependencies or an action you own; for missing human input use ask_user_questions or request_confirmation, which save an interaction and waiting status. Respect task work mode, conversation directives, Stop, pause, budget and approval gates. Never claim Done unless Paperclip confirms done.\n\nIf the available brokered tools cannot complete the task, report that limitation and stop.`;
}

function paperclipMcpServersFor(ctx) {
  return (ctx.runtimeMcp?.getServers() ?? []).map((server, index) => ({
    type: 'http',
    // ZeroClaw prefixes tool names with this identifier; display names can be invalid at the provider.
    name: `paperclip_broker_${index + 1}`,
    url: server.url,
    headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
  }));
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
  let taskMcp;
  let cancelled = false;
  const sessionToolScope = {
    mcpServers: paperclipMcpServersFor(ctx),
    paperclipToolsOnly: true,
  };
  const abort = () => {
    cancelled = true;
    if (sessionId) client.send({ method: 'session/cancel', params: { sessionId } });
    // A lost cancellation reply must not leave the Paperclip run hanging.
    setTimeout(() => client.close(), 5000).unref();
  };
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    taskMcp = await startTaskMcp(ctx);
    if (taskMcp) sessionToolScope.mcpServers.unshift(taskMcp.mcpServer);
    ctx.onDispatch?.();
    await client.connect();
    const init = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'paperclip-zeroclaw-acp', version: '0.1.0' } }, TIMEOUT_MS);
    if (init?.protocolVersion !== 1) throw new Error('ZeroClaw ACP protocol v1 required');
    const previous = ctx.runtime.sessionParams?.zeroclawSessionId || ctx.runtime.sessionId;
    if (previous && ctx.config.resumeSessions !== false) {
      try {
        await client.request('session/resume', { sessionId: previous, ...sessionToolScope }, TIMEOUT_MS);
        sessionId = previous;
      } catch (error) {
        // Fail closed: an expired/busy session cannot silently lose context or duplicate work.
        throw new Error(`Cannot resume ZeroClaw session ${previous}: ${error.message}`);
      }
    } else {
      const params = { ...sessionToolScope };
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
    await taskMcp?.stop();
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
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: 'native_mcp',
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    getConfigSchema: () => ({ fields: [
      { key: 'url', label: 'ZeroClaw ACP URL', type: 'text', required: true, hint: 'wss://node.example/acp' },
      { key: 'agentAlias', label: 'ZeroClaw agent alias', type: 'text' },
      { key: 'cwd', label: 'Workspace on ZeroClaw host', type: 'text' },
      { key: 'taskMcpBindHost', label: 'Task MCP bind address', type: 'text', hint: 'Paperclip Tailscale IPv4 address, reachable from ZeroClaw; per-run HTTP listener inside encrypted Tailscale' },
      { key: 'taskApiUrl', label: 'Local Paperclip API origin', type: 'text', hint: 'Optional override; defaults to the Paperclip local listen host and port' },
      { key: 'allowPlainPrivateWs', label: 'Allow plain WebSocket to a private host IP', type: 'toggle', default: false, hint: 'Enable only for a trusted local network such as the WSL to Windows host link' },
    ] }),
  };
}

export { AcpClient, configFor, promptFor };
