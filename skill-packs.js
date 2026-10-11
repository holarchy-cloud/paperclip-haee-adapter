import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const SKILL_MEDIA_TYPE = 'application/vnd.paperclip.skill.v1+tar';
const RUNTIME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PACK_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;

/** Same private-bind rule as task MCP: Tailscale CGNAT or loopback. */
export function skillPackBindHostFor(ctx) {
  const host = ctx.config?.taskMcpBindHost ?? process.env.ZEROCLAW_TASK_MCP_BIND_HOST;
  if (!host) return null;
  const parts = String(host).split('.').map(Number);
  const tailscale = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  if (!tailscale && host !== '127.0.0.1') {
    throw new Error('Skill packs must bind to a Tailscale IPv4 address or 127.0.0.1');
  }
  return String(host);
}

function runtimeSkillsFrom(ctx) {
  const configured = ctx.config?.paperclipRuntimeSkills;
  if (!Array.isArray(configured)) return [];
  const out = [];
  for (const raw of configured) {
    if (!raw || typeof raw !== 'object') continue;
    const key = String(raw.key ?? raw.name ?? '').trim();
    const runtimeName = String(raw.runtimeName ?? raw.name ?? '').trim();
    const source = String(raw.source ?? '').trim();
    if (!key || !runtimeName || !source) continue;
    if (raw.sourceStatus === 'missing') continue;
    const entry = { key, runtimeName, source };
    if (typeof raw.versionId === 'string' && raw.versionId.trim()) entry.versionId = raw.versionId.trim();
    else if (typeof raw.currentVersionId === 'string' && raw.currentVersionId.trim()) {
      entry.versionId = raw.currentVersionId.trim();
    }
    if (typeof raw.always === 'boolean') entry.always = raw.always;
    out.push(entry);
  }
  return out;
}

async function collectSkillFiles(sourceRoot) {
  const rootStat = await stat(sourceRoot);
  if (!rootStat.isDirectory()) throw new Error('skill source is not a directory');

  const files = [];
  const queue = [sourceRoot];
  while (queue.length) {
    const dir = queue.shift();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(sourceRoot, full).split(sep).join('/');
      if (!rel || rel.startsWith('../') || rel.includes('/../')) {
        throw new Error(`refusing path outside skill root: ${rel}`);
      }
      const fileStat = await stat(full);
      if (fileStat.size > MAX_FILE_BYTES) {
        throw new Error(`skill file exceeds ${MAX_FILE_BYTES} bytes: ${rel}`);
      }
      files.push({ rel, full, size: fileStat.size });
      if (files.length > MAX_FILES) throw new Error(`skill package exceeds ${MAX_FILES} files`);
    }
  }
  if (!files.some(file => file.rel === 'SKILL.md')) {
    throw new Error('skill package missing SKILL.md at source root');
  }
  // SKILL.md first for stable archive root inspection; remaining paths ASCII-sorted.
  files.sort((a, b) => {
    if (a.rel === 'SKILL.md') return -1;
    if (b.rel === 'SKILL.md') return 1;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  return files;
}

function tarHeader(name, size, type = '0') {
  const buf = Buffer.alloc(512, 0);
  // ustar numeric fields are fixed-width and often fill the whole slot (e.g. mode "0000644\0").
  const write = (value, offset, length) => {
    const text = Buffer.from(String(value), 'utf8');
    if (text.length > length) throw new Error(`tar field too long: ${value}`);
    text.copy(buf, offset, 0, length);
  };
  write(name, 0, 100);
  write('0000644\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12);
  write('        ', 148, 8); // checksum placeholder (spaces)
  write(type, 156, 1);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const byte of buf) sum += byte;
  write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return buf;
}

/** Build a ustar archive with SKILL.md at archive root (no install scripts run). */
export async function packSkillDirectory(sourceRoot) {
  const files = await collectSkillFiles(sourceRoot);
  const chunks = [];
  let total = 0;
  for (const file of files) {
    if (file.rel.length > 100) throw new Error(`skill path too long for ustar: ${file.rel}`);
    const body = await readFile(file.full);
    if (body.length !== file.size) throw new Error(`skill file size changed while packing: ${file.rel}`);
    const header = tarHeader(file.rel, body.length, '0');
    chunks.push(header, body);
    total += header.length + body.length;
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) {
      chunks.push(Buffer.alloc(pad, 0));
      total += pad;
    }
    if (total > MAX_PACK_BYTES) throw new Error(`skill package exceeds ${MAX_PACK_BYTES} bytes`);
  }
  chunks.push(Buffer.alloc(1024, 0));
  total += 1024;
  if (total > MAX_PACK_BYTES) throw new Error(`skill package exceeds ${MAX_PACK_BYTES} bytes`);
  return Buffer.concat(chunks, total);
}

export function packageSha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toSkillRef(entry, { uri, bytes }) {
  const ref = {
    key: entry.key,
    runtimeName: entry.runtimeName,
    uri,
    integrity: {
      sha256: packageSha256Hex(bytes),
      sizeMax: bytes.length,
    },
    mediaType: SKILL_MEDIA_TYPE,
    scope: 'session',
  };
  if (entry.versionId) ref.versionId = entry.versionId;
  if (typeof entry.always === 'boolean') ref.always = entry.always;
  return ref;
}

/**
 * Pack materialized paperclipRuntimeSkills and serve short-lived private HTTP URLs.
 * Path tokens authorize GET (HAEE skill fetch has no SkillRef headers yet).
 * Returns null when there is nothing to serve or no bind host.
 */
export async function startSkillPacks(ctx) {
  const entries = runtimeSkillsFrom(ctx);
  if (!entries.length) return null;
  const host = skillPackBindHostFor(ctx);
  if (!host) {
    await ctx.onLog?.('stderr', `\n[skill-packs run=${ctx.runId ?? 'unknown'} omitted] taskMcpBindHost required to publish skill packs\n`);
    return null;
  }

  const token = randomBytes(32).toString('hex');
  const packs = new Map(); // path -> Buffer
  const skills = [];
  const secrets = [token];

  for (const entry of entries) {
    if (!RUNTIME_NAME_RE.test(entry.runtimeName)) {
      await ctx.onLog?.('stderr', `\n[skill-packs omit key=${entry.key}] invalid runtimeName\n`);
      continue;
    }
    try {
      const bytes = await packSkillDirectory(entry.source);
      const path = `/skill-packs/${token}/${encodeURIComponent(entry.runtimeName)}.tar`;
      if (packs.has(path)) {
        await ctx.onLog?.('stderr', `\n[skill-packs omit key=${entry.key}] duplicate runtimeName ${entry.runtimeName}\n`);
        continue;
      }
      packs.set(path, bytes);
      // URL is built after listen; placeholder filled below.
      skills.push({ entry, bytes, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.onLog?.('stderr', `\n[skill-packs omit key=${entry.key}] ${message}\n`);
    }
  }
  if (!skills.length) return null;

  let active = true;
  const server = createServer((req, res) => {
    const fail = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (!active || req.method !== 'GET') return fail(404, 'Not found');
    const path = new URL(req.url || '/', `http://${host}`).pathname;
    const prefix = '/skill-packs/';
    if (!path.startsWith(prefix)) return fail(404, 'Not found');
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return fail(404, 'Not found');
    const suppliedToken = rest.slice(0, slash);
    const supplied = Buffer.from(suppliedToken);
    const expected = Buffer.from(token);
    // Constant-time token compare on the path segment before the filename.
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return fail(401, 'Unauthorized');
    }
    const body = packs.get(path);
    if (!body) return fail(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': SKILL_MEDIA_TYPE,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  const stop = async () => {
    active = false;
    ctx.signal?.removeEventListener('abort', cancel);
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    packs.clear();
  };
  const cancel = () => { active = false; server.closeAllConnections(); };

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    ctx.signal?.addEventListener('abort', cancel, { once: true });
    if (ctx.signal?.aborted) throw new Error('Cancelled while starting skill packs');
    const port = server.address().port;
    const skillRefs = skills.map(({ entry, bytes, path }) => toSkillRef(entry, {
      uri: `http://${host}:${port}${path}`,
      bytes,
    }));
    await ctx.onLog?.('stdout', `\n[skill-packs run=${ctx.runId ?? 'unknown'} ready count=${skillRefs.length}]\n`);
    return {
      skills: skillRefs,
      secrets,
      stop,
    };
  } catch (error) {
    if (server.listening) await stop();
    throw error;
  }
}
