import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const text = { type: 'string', minLength: 1, maxLength: 20000 };
const key = { type: 'string', minLength: 1, maxLength: 200 };
const tool = (name, description, properties = {}, required = [], standardOnly = false) => ({
  name, description, inputSchema: { ...object(properties), required }, standardOnly,
});
// Names and payloads follow Paperclip's semantic catalog and heartbeat skill.
const TOOLS = [
  tool('get_task_context', 'Read the current assigned task and its lifecycle state.'),
  tool('get_task_history', 'Read bounded comments on the current task.', { limit: { type: 'integer', minimum: 1, maximum: 200 } }),
  tool('checkout_task', 'Check out the current task before doing work; an existing current-run checkout is reused.', {}, [], true),
  tool('report_progress', 'Post a durable progress or result comment. This alone does not complete the task.', { idempotencyKey: key, body: text }, ['idempotencyKey', 'body']),
  tool('finish_task', 'Record completed work with a durable summary. Paperclip review gates still apply; inspect the returned status.', { idempotencyKey: key, summary: text }, ['idempotencyKey', 'summary'], true),
  tool('block_task', 'Record a real blocker, with task dependencies or an action this agent owns. For missing human input use ask_user_questions.', {
    idempotencyKey: key, reason: text,
    blockedByTaskIds: { type: 'array', minItems: 1, maxItems: 100, items: key },
    action: text,
  }, ['idempotencyKey', 'reason'], true),
  tool('ask_user_questions', 'Save one open-ended human question and leave the task waiting in review; the answer wakes the assignee.', {
    idempotencyKey: key, title: { ...text, maxLength: 240 }, question: text,
  }, ['idempotencyKey', 'title', 'question']),
  tool('request_confirmation', 'Save a human yes/no decision and leave the task waiting in review. Not an approval bypass.', {
    idempotencyKey: key, title: { ...text, maxLength: 240 }, prompt: text,
  }, ['idempotencyKey', 'title', 'prompt']),
];

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer <REDACTED>');
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, '<REDACTED>');
    return result;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !/token|secret|password|authorization|api.?key|headers/i.test(name))
    .map(([name, item]) => [name, redact(item, secrets)]));
  return value;
}

function validate(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const name of Object.keys(args)) {
    const spec = schema.properties[name];
    if (!spec) throw new Error(`Unknown argument: ${name}`);
    const value = args[name];
    if (spec.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > spec.maxLength)) throw new Error(`Invalid ${name}`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${name}`);
    if (spec.type === 'integer' && (!Number.isInteger(value) || value < spec.minimum || value > spec.maximum)) throw new Error(`Invalid ${name}`);
    if (spec.type === 'array' && (!Array.isArray(value) || value.length < spec.minItems || value.length > spec.maxItems ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200))) throw new Error(`Invalid ${name}`);
  }
  for (const name of schema.required) if (!(name in args)) throw new Error(`Missing ${name}`);
}

async function readJson(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('JSON body exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bindHostFor(ctx) {
  const host = ctx.config.taskMcpBindHost ?? process.env.ZEROCLAW_TASK_MCP_BIND_HOST;
  if (!host) return null;
  const parts = String(host).split('.').map(Number);
  const tailscale = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  if (!tailscale && host !== '127.0.0.1') throw new Error('Task MCP must bind to a Tailscale IPv4 address or 127.0.0.1');
  return String(host);
}

export async function startTaskMcp(ctx) {
  const host = bindHostFor(ctx);
  if (!host) return null;
  const issueId = ctx.context?.taskId ?? ctx.context?.issueId;
  if (!issueId) return null;
  const missing = [
    ['ctx.authToken', ctx.authToken],
    ['ctx.runId', ctx.runId],
    ['ctx.agent.id', ctx.agent?.id],
    ['ctx.agent.companyId', ctx.agent?.companyId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    const guidance = missing.includes('ctx.authToken')
      ? ' Paperclip must load createServerAdapter() with supportsLocalAgentJwt=true and supply a current-run JWT. Verify the loaded adapter version and Paperclip server signing configuration (PAPERCLIP_AGENT_JWT_SECRET or BETTER_AUTH_SECRET); do not put credentials in task prompts or adapter config.'
      : ' Paperclip must supply the current run and agent identity in AdapterExecutionContext.';
    throw new Error(`Task MCP requires authenticated task/run identity: missing ${missing.join(', ')}.${guidance}`);
  }
  // Match the existing callback bridge: relay locally, not through a browser-authenticated edge.
  const listenHost = process.env.PAPERCLIP_LISTEN_HOST || '127.0.0.1';
  const localHost = ['0.0.0.0', '::'].includes(listenHost) ? '127.0.0.1' : listenHost;
  const origin = new URL(ctx.config.taskApiUrl || `http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || 3100}`);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash ||
    !['/', '/api', '/api/'].includes(origin.pathname)) throw new Error('Task API URL must be an HTTP(S) origin, optionally ending in /api');
  const apiBase = `${origin.origin}/api/issues/${encodeURIComponent(issueId)}`;
  const token = randomBytes(32).toString('hex');
  const controller = new AbortController();
  const secrets = [ctx.authToken, token];
  const receipts = new Map();
  let active = true;

  const api = async (method, suffix = '', body) => {
    if (!active) throw new Error('Task invocation has ended');
    const response = await fetch(`${apiBase}${suffix}`, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${ctx.authToken}`, 'X-Paperclip-Run-Id': ctx.runId, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    let result;
    try { result = await readJson(response.body); }
    catch { throw new Error(`Paperclip ${method} response was not confirmed JSON (HTTP ${response.status}); inspect task state before retrying a write`); }
    if (!response.ok) throw new Error(`Paperclip ${method} failed (HTTP ${response.status}): ${JSON.stringify(redact(result, secrets))}`);
    return result;
  };
  const boundTask = async () => {
    const issue = await api('GET');
    if (issue.id !== issueId || issue.companyId !== ctx.agent.companyId ||
      (issue.assigneeAgentId !== ctx.agent.id && issue.conversationAgentId !== ctx.agent.id) ||
      (issue.executionRunId && issue.executionRunId !== ctx.runId)) throw new Error('Task is no longer owned by this invocation');
    return issue;
  };
  const verifyIssue = (issue, allowedStatuses) => {
    if (issue?.id !== issueId || issue.companyId !== ctx.agent.companyId || !allowedStatuses.includes(issue.status)) {
      throw new Error('Paperclip task write did not confirm the requested lifecycle outcome; read current task state');
    }
    return issue;
  };
  const definitions = issue => TOOLS.filter(t => !t.standardOnly || ['standard', 'skill_test'].includes(issue.workMode))
    .filter(t => !issue.conversationAgentId || !['checkout_task', 'finish_task', 'block_task', 'ask_user_questions', 'request_confirmation'].includes(t.name));
  const execute = async (name, args, issue) => {
    switch (name) {
      case 'get_task_context': return issue;
      case 'get_task_history': {
        const comments = await api('GET', '/comments');
        if (!Array.isArray(comments)) throw new Error('Paperclip comment history was not an array');
        return comments.slice(-(args.limit ?? 50));
      }
      case 'checkout_task':
        if (issue.executionRunId === ctx.runId && issue.status === 'in_progress') return issue;
        return verifyIssue(await api('POST', '/checkout', { agentId: ctx.agent.id, expectedStatuses: ['todo', 'backlog', 'blocked', 'in_review'] }), ['in_progress']);
      case 'report_progress': {
        const comment = await api('POST', '/comments', { body: args.body });
        if (!comment?.id || comment.issueId !== issueId || comment.body !== args.body) throw new Error('Paperclip comment write was not confirmed');
        return comment;
      }
      case 'finish_task':
        return verifyIssue(await api('PATCH', '', { status: 'done', comment: args.summary }), ['done', 'in_review']);
      case 'block_task': {
        if (!args.blockedByTaskIds?.length && !args.action) throw new Error('A blocker requires dependencies or a concrete agent-owned action; human input requires a saved interaction');
        return verifyIssue(await api('PATCH', '', {
          status: 'blocked', comment: args.reason,
          ...(args.blockedByTaskIds ? { blockedByIssueIds: args.blockedByTaskIds } : {}),
          ...(args.action ? { unblockDescriptor: { owner: { agentId: ctx.agent.id }, action: args.action } } : {}),
        }), ['blocked']);
      }
      case 'ask_user_questions':
      case 'request_confirmation': {
        const interaction = await api('POST', '/interactions', {
          kind: name, title: args.title, idempotencyKey: `acp:${issueId}:${args.idempotencyKey}`,
          resolverPolicy: 'human_only', continuationPolicy: 'wake_assignee',
          payload: name === 'ask_user_questions'
            ? { version: 1, questionSet: { schema: 'paperclip.question_set.v1', questions: [{ id: 'question', prompt: args.question, required: true, answerMode: 'text' }] } }
            : { version: 1, prompt: args.prompt, acceptLabel: 'Confirm', rejectLabel: 'Decline' },
        });
        const saved = interaction.interaction ?? interaction;
        if (!saved?.id || saved.issueId !== issueId || saved.status !== 'pending') throw new Error('Paperclip did not confirm a pending interaction');
        const updated = verifyIssue(await api('PATCH', '', { status: 'in_review', comment: `Waiting for human input: ${args.title}` }), ['in_review']);
        return { interaction: saved, task: updated };
      }
      default: throw new Error('Unknown task tool');
    }
  };
  const call = async (name, args) => {
    const issue = await boundTask();
    const definition = definitions(issue).find(t => t.name === name);
    if (!definition) throw new Error('Task tool is unavailable for this task/mode');
    validate(args, definition.inputSchema);
    if (!args.idempotencyKey) return execute(name, args, issue);
    // Hold even failed receipts: an ambiguous HTTP failure must not duplicate a write.
    const receiptKey = args.idempotencyKey;
    const fingerprint = JSON.stringify([name, args]);
    const prior = receipts.get(receiptKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Idempotency key reused with different arguments');
      return prior.result;
    }
    if (receipts.size >= 256) throw new Error('Invocation write limit reached');
    const result = execute(name, args, issue);
    receipts.set(receiptKey, { fingerprint, result });
    return result;
  };
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (!active || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'Unauthorized' });
    if (req.url !== '/mcp' || req.method !== 'POST') return send(404, { error: 'Not found' });
    let id = null;
    try {
      const message = await readJson(req);
      id = message.id ?? null;
      if (message.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'paperclip-task-tools', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: definitions(await boundTask()).map(({ standardOnly, ...t }) => t) };
      else if (message.method === 'tools/call') {
        try {
          const output = redact(await call(message.params?.name, message.params?.arguments ?? {}), secrets);
          result = { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
          await ctx.onLog('stdout', `\n[task-mcp run=${ctx.runId} tool=${message.params.name} confirmed]\n`);
        } catch (error) {
          const description = redact(error.message, secrets);
          await ctx.onLog('stderr', `\n[task-mcp run=${ctx.runId} tool=${String(message.params?.name)} failed] ${description}\n`);
          result = { isError: true, content: [{ type: 'text', text: description }] };
        }
      } else return send(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      send(200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      const description = redact(error.message, secrets);
      await ctx.onLog('stderr', `\n[task-mcp run=${ctx.runId} request failed] ${description}\n`);
      send(400, { jsonrpc: '2.0', id, error: { code: -32600, message: description } });
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  const stop = async () => {
    active = false;
    controller.abort();
    ctx.signal?.removeEventListener('abort', cancel);
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    receipts.clear();
  };
  const cancel = () => { active = false; controller.abort(); server.closeAllConnections(); };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    if (ctx.signal?.aborted) throw new Error('Cancelled while starting task MCP');
    await ctx.onLog('stdout', `\n[task-mcp run=${ctx.runId} ready task=${issueId}]\n`);
    return {
      mcpServer: { type: 'http', name: 'paperclip_tasks', url: `http://${host}:${server.address().port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
      stop,
    };
  } catch (error) {
    if (server.listening) await stop();
    throw error;
  }
}
