import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  packSkillDirectory,
  packageSha256Hex,
  skillPackBindHostFor,
  startSkillPacks,
  SKILL_MEDIA_TYPE,
} from './skill-packs.js';
import { buildRunEnvelope, createServerAdapter, promptFor } from './index.js';

async function skillFixture(t, { runtimeName = 'issue-triage', withScript = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'haee-skill-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'SKILL.md'), `# ${runtimeName}\n\nHarmless lab skill.\n`, 'utf8');
  if (withScript) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'install.sh'), '#!/bin/sh\ntouch RAN_ON_INSTALL\n', 'utf8');
  }
  return root;
}

test('skill pack bind host matches task MCP private-bind rules', () => {
  assert.equal(skillPackBindHostFor({ config: {} }), null);
  assert.equal(skillPackBindHostFor({ config: { taskMcpBindHost: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(skillPackBindHostFor({ config: { taskMcpBindHost: '100.64.1.2' } }), '100.64.1.2');
  assert.throws(() => skillPackBindHostFor({ config: { taskMcpBindHost: '0.0.0.0' } }), /Tailscale/);
  assert.throws(() => skillPackBindHostFor({ config: { taskMcpBindHost: '192.168.1.1' } }), /Tailscale/);
});

test('packSkillDirectory builds tar with SKILL.md root and stable sha256', async t => {
  const source = await skillFixture(t);
  const bytes = await packSkillDirectory(source);
  assert.ok(bytes.length > 512);
  assert.equal(packageSha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  // ustar name field for first file should be SKILL.md (sorted first among files).
  const name = bytes.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
  assert.equal(name, 'SKILL.md');
  assert.match(bytes.toString('utf8'), /Harmless lab skill/);
  assert.match(bytes.toString('utf8'), /install\.sh/);
});

test('startSkillPacks serves path-token packs and revokes on stop', async t => {
  const source = await skillFixture(t);
  const logs = [];
  const bridge = await startSkillPacks({
    runId: 'run-skill-1',
    config: {
      taskMcpBindHost: '127.0.0.1',
      paperclipRuntimeSkills: [{
        key: 'paperclipai/paperclip/issue-triage',
        runtimeName: 'issue-triage',
        versionId: 'sv_test_001',
        source,
        always: true,
      }],
    },
    onLog: async (stream, chunk) => logs.push({ stream, chunk }),
  });
  assert.ok(bridge);
  assert.equal(bridge.skills.length, 1);
  const skill = bridge.skills[0];
  assert.equal(skill.key, 'paperclipai/paperclip/issue-triage');
  assert.equal(skill.runtimeName, 'issue-triage');
  assert.equal(skill.versionId, 'sv_test_001');
  assert.equal(skill.mediaType, SKILL_MEDIA_TYPE);
  assert.equal(skill.scope, 'session');
  assert.equal(skill.always, true);
  assert.match(skill.uri, /^http:\/\/127\.0\.0\.1:\d+\/skill-packs\/[0-9a-f]{64}\/issue-triage\.tar$/);
  assert.equal(skill.integrity.sha256.length, 64);
  assert.equal(skill.integrity.sizeMax > 0, true);
  // Path token authorizes GET (HAEE skill fetch has no SkillRef headers yet).
  assert.equal(bridge.secrets.length, 1);
  assert.ok(skill.uri.includes(bridge.secrets[0]));
  assert.ok(logs.some(entry => entry.stream === 'stdout' && entry.chunk.includes('skill-packs')));

  const ok = await fetch(skill.uri);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), SKILL_MEDIA_TYPE);
  const body = Buffer.from(await ok.arrayBuffer());
  assert.equal(packageSha256Hex(body), skill.integrity.sha256);
  assert.equal(body.length, skill.integrity.sizeMax);

  const badToken = skill.uri.replace(/\/skill-packs\/[0-9a-f]{64}\//, '/skill-packs/0000000000000000000000000000000000000000000000000000000000000000/');
  assert.equal((await fetch(badToken)).status, 401);
  assert.equal((await fetch(skill.uri, { method: 'POST' })).status, 404);

  await bridge.stop();
  await assert.rejects(fetch(skill.uri));
});

test('startSkillPacks omits bad sources and returns null without bind host', async t => {
  const good = await skillFixture(t, { runtimeName: 'good-skill' });
  const badRoot = await mkdtemp(join(tmpdir(), 'haee-skill-bad-'));
  t.after(async () => { await rm(badRoot, { recursive: true, force: true }); });
  await writeFile(join(badRoot, 'README.md'), 'no skill md\n', 'utf8');

  assert.equal(await startSkillPacks({
    runId: 'r',
    config: {
      paperclipRuntimeSkills: [{ key: 'k', runtimeName: 'good-skill', source: good }],
    },
    onLog: async () => {},
  }), null);

  const logs = [];
  const bridge = await startSkillPacks({
    runId: 'r2',
    config: {
      taskMcpBindHost: '127.0.0.1',
      paperclipRuntimeSkills: [
        { key: 'good', runtimeName: 'good-skill', source: good },
        { key: 'bad', runtimeName: 'bad-skill', source: badRoot },
        { key: 'missing', runtimeName: 'missing-skill', source: good, sourceStatus: 'missing' },
      ],
    },
    onLog: async (stream, chunk) => logs.push({ stream, chunk }),
  });
  assert.equal(bridge.skills.length, 1);
  assert.equal(bridge.skills[0].key, 'good');
  assert.ok(logs.some(entry => entry.stream === 'stderr' && entry.chunk.includes('omit key=bad')));
  await bridge.stop();
});

test('buildRunEnvelope accepts skills[] with uri+integrity+scope', () => {
  const skill = {
    key: 'paperclipai/paperclip/issue-triage',
    runtimeName: 'issue-triage',
    uri: 'http://127.0.0.1:9/skill-packs/token/issue-triage.tar',
    integrity: { sha256: 'a'.repeat(64), sizeMax: 128 },
    mediaType: SKILL_MEDIA_TYPE,
    scope: 'session',
  };
  const envelope = buildRunEnvelope({
    runId: 'r1',
    authToken: 'tok',
    agent: { id: 'a1', companyId: 'c1', name: 'Lab' },
    config: { paperclipApiBaseUrl: 'http://paperclip.example' },
    context: { taskId: 'issue-1', taskSummary: 'skill pack test' },
  }, { skills: [skill] });
  assert.deepEqual(envelope.skills, [skill]);
  assert.equal(envelope.tools.paperclipToolsOnly, true);
});

test('execute publishes skills on session/new and stops packs; prompt omits pack tokens', async t => {
  const source = await skillFixture(t);
  const previous = globalThis.WebSocket;
  let advertised;
  class Socket extends EventTarget {
    constructor() {
      super();
      this.sent = [];
      Socket.latest = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const request = JSON.parse(raw);
      this.sent.push(request);
      const reply = result => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      }));
      void (async () => {
        if (request.method === 'initialize') return reply({ protocolVersion: 1 });
        if (request.method === 'session/new') {
          advertised = request.params.envelope.skills;
          assert.equal(Object.hasOwn(request.params, 'mcpServers'), false);
          assert.equal(advertised.length, 1);
          assert.equal(advertised[0].runtimeName, 'issue-triage');
          assert.match(advertised[0].uri, /^http:\/\/127\.0\.0\.1:\d+\/skill-packs\//);
          const response = await fetch(advertised[0].uri);
          assert.equal(response.status, 200);
          return reply({ sessionId: 's-skill' });
        }
        if (request.method === 'session/prompt') {
          const prompt = request.params.prompt;
          const tokenMatch = advertised[0].uri.match(/\/skill-packs\/([0-9a-f]{64})\//);
          assert.ok(tokenMatch);
          assert.ok(!prompt.includes(tokenMatch[1]));
          assert.ok(!prompt.includes(advertised[0].uri));
          return reply({ stopReason: 'end_turn', content: 'done' });
        }
        if (request.method === 'session/close') return reply({});
      })().catch(error => {
        this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }),
        }));
      });
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = previous; });

  const result = await createServerAdapter().execute({
    config: {
      url: 'ws://localhost/acp',
      taskMcpBindHost: '127.0.0.1',
      paperclipApiBaseUrl: 'http://paperclip.example',
      paperclipRuntimeSkills: [{
        key: 'paperclipai/paperclip/issue-triage',
        runtimeName: 'issue-triage',
        source,
      }],
    },
    runId: 'run-skill-exec',
    authToken: 'private-run-token',
    agent: { id: 'a1', companyId: 'c1', name: 'Lab' },
    context: { taskId: 'issue-1' },
    runtime: {},
    onLog: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.ok(advertised?.[0]?.uri);
  await assert.rejects(fetch(advertised[0].uri));
});

test('promptFor redacts skill pack path tokens when provided as extra secrets', () => {
  const token = 'ab'.repeat(32);
  const prompt = promptFor({
    runId: 'r',
    authToken: 'private-run-token',
    agent: { id: 'a', companyId: 'c', name: 'Lab' },
    context: {
      taskId: 'issue-1',
      paperclipTaskMarkdown: `Do not fetch http://127.0.0.1:9/skill-packs/${token}/x.tar`,
    },
  }, { extraSecrets: [token] });
  assert.ok(!prompt.includes(token));
  assert.match(prompt, /skill-packs\/<REDACTED>\//);
});
