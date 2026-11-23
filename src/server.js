'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCorpusManager } = require('./corpus_manager');
const { detectPythonBin } = require('./utils');

const ROOT_DIR = path.resolve(__dirname, '..');
const UI_DIR = path.resolve(ROOT_DIR, 'ui');
const UI_FILE = path.join(UI_DIR, 'index.html');
const CFG_FILE = path.join(ROOT_DIR, 'config.json');
const TMP_UPLOADS_DIR = path.join(ROOT_DIR, '.tmp-uploads');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const out = { treeOnly: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tree-only') out.treeOnly = true;
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--host' && argv[i + 1]) out.host = String(argv[++i]);
    else if (a === '--corpora-dir' && argv[i + 1]) out.corporaDir = path.resolve(argv[++i]);
    else if (a === '--corpus' && argv[i + 1]) out.defaultCorpus = String(argv[++i]);
  }
  return out;
}

const cli = parseArgs(process.argv);
const CORPORA_DIR = cli.corporaDir || path.resolve(process.env.CORPORA_DIR || path.join(ROOT_DIR, 'corpora'));

function parseOptionalMaxTokens(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function parseOptionalTemperature(val) {
  if (val === null || val === undefined || String(val).trim() === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : null;
}

function parseOptionalReasoningEffort(val) {
  const s = String(val || '').trim().toLowerCase();
  return s || null;
}

const defaultCfg = {
  port: 5240,
  defaultCorpus: 'demo-chronicles',
  chatBase: 'https://api.openai.com/v1',
  chatKey: '',
  chatModel: 'deepseek-chat',
  maxTokens: null,
  temperature: null,
  reasoningEffort: null,
};

let runtimeCfg = { ...defaultCfg };
if (fs.existsSync(CFG_FILE)) {
  try {
    runtimeCfg = { ...defaultCfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch (err) {
    console.warn('[server] failed to parse config.json:', err.message);
  }
}
runtimeCfg.maxTokens = parseOptionalMaxTokens(runtimeCfg.maxTokens ?? runtimeCfg.max_tokens);
runtimeCfg.temperature = parseOptionalTemperature(runtimeCfg.temperature);
runtimeCfg.reasoningEffort = parseOptionalReasoningEffort(runtimeCfg.reasoningEffort ?? runtimeCfg.reasoning_effort);

if (process.env.PORT) runtimeCfg.port = Number(process.env.PORT) || runtimeCfg.port;
if (process.env.CHAT_BASE) runtimeCfg.chatBase = process.env.CHAT_BASE;
if (process.env.CHAT_KEY) runtimeCfg.chatKey = process.env.CHAT_KEY;
if (process.env.CHAT_MODEL) runtimeCfg.chatModel = process.env.CHAT_MODEL;
if (process.env.CHAT_MAX_TOKENS !== undefined) runtimeCfg.maxTokens = parseOptionalMaxTokens(process.env.CHAT_MAX_TOKENS);
if (process.env.CHAT_TEMPERATURE !== undefined) runtimeCfg.temperature = parseOptionalTemperature(process.env.CHAT_TEMPERATURE);
if (process.env.CHAT_REASONING_EFFORT !== undefined) runtimeCfg.reasoningEffort = parseOptionalReasoningEffort(process.env.CHAT_REASONING_EFFORT);
if (process.env.DEFAULT_CORPUS) runtimeCfg.defaultCorpus = process.env.DEFAULT_CORPUS;
if (cli.port && Number.isFinite(cli.port)) runtimeCfg.port = cli.port;
if (cli.defaultCorpus) runtimeCfg.defaultCorpus = cli.defaultCorpus;

const PORT = Number(runtimeCfg.port) || 5240;
const HOST = String(cli.host || process.env.HOST || runtimeCfg.host || '127.0.0.1').trim() || '127.0.0.1';

function cleanApiBaseUrl(u) {
  return String(u || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '')
    .replace(/\/+$/, '');
}

function normalizeBaseUrl(u) {
  return cleanApiBaseUrl(u).toLowerCase();
}

function isPrivateOrLocalHostname(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.ts.net')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h)) return true;
  if (/^(?:fc|fd|fe80)[0-9a-f]*:/i.test(h)) return true;
  return false;
}

function isLocalOrAllowedOrigin(origin, req = null) {
  if (!origin || origin === 'null') return true;
  const o = String(origin).trim();
  const extra = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes('*') || extra.includes(o)) return true;
  if (/^(?:tauri|capacitor|app):\/\/localhost(?::\d+)?$/i.test(o)) return true;
  try {
    const u = new URL(o);
    if (!/^(?:https?|tauri|capacitor|app):$/i.test(u.protocol)) return false;
    const reqHost = String(req?.headers?.host || '').trim().toLowerCase();
    if (reqHost && u.host.toLowerCase() === reqHost) return true;
    return isPrivateOrLocalHostname(u.hostname);
  } catch (_) {
    return false;
  }
}

function saveCfg(patch) {
  if (!patch || typeof patch !== 'object') return;
  const prevBase = normalizeBaseUrl(runtimeCfg.chatBase);
  const hasNewKey =
    typeof patch.chatKey === 'string' && Boolean(patch.chatKey.trim()) && !/^\*+$/.test(patch.chatKey.trim());
  for (const k of ['chatBase', 'chatKey', 'chatModel', 'defaultCorpus']) {
    if (typeof patch[k] === 'string') {
      const v = k === 'chatBase' ? cleanApiBaseUrl(patch[k]) : patch[k].trim();
      if (v && !/^\*+$/.test(v)) runtimeCfg[k] = v;
    }
  }
  if (typeof patch.chatBase === 'string' && normalizeBaseUrl(runtimeCfg.chatBase) !== prevBase && !hasNewKey) {
    runtimeCfg.chatKey = '';
  }
  if ('maxTokens' in patch || 'max_tokens' in patch) {
    runtimeCfg.maxTokens = parseOptionalMaxTokens(patch.maxTokens ?? patch.max_tokens);
  }
  if ('temperature' in patch) {
    runtimeCfg.temperature = parseOptionalTemperature(patch.temperature);
  }
  if ('reasoningEffort' in patch || 'reasoning_effort' in patch) {
    runtimeCfg.reasoningEffort = parseOptionalReasoningEffort(patch.reasoningEffort ?? patch.reasoning_effort);
  }
  delete runtimeCfg.disableThinking;
  delete runtimeCfg.max_tokens;
  delete runtimeCfg.reasoning_effort;
  try {
    fs.writeFileSync(CFG_FILE, JSON.stringify(runtimeCfg, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('[server] failed to write config.json:', err.message);
  }
}

function mergeCfg(patch) {
  const out = { ...runtimeCfg };
  if (patch && typeof patch === 'object') {
    const prevBase = normalizeBaseUrl(runtimeCfg.chatBase);
    const hasNewKey =
      typeof patch.chatKey === 'string' && Boolean(patch.chatKey.trim()) && !/^\*+$/.test(patch.chatKey.trim());
    for (const k of ['chatBase', 'chatKey', 'chatModel', 'defaultCorpus']) {
      if (typeof patch[k] === 'string') {
        const v = k === 'chatBase' ? cleanApiBaseUrl(patch[k]) : patch[k].trim();
        if (v && !/^\*+$/.test(v)) out[k] = v;
      }
    }
    if (typeof patch.chatBase === 'string' && normalizeBaseUrl(out.chatBase) !== prevBase && !hasNewKey) {
      out.chatKey = '';
    }
    if ('maxTokens' in patch || 'max_tokens' in patch) {
      out.maxTokens = parseOptionalMaxTokens(patch.maxTokens ?? patch.max_tokens);
    }
    if ('temperature' in patch) {
      out.temperature = parseOptionalTemperature(patch.temperature);
    }
    if ('reasoningEffort' in patch || 'reasoning_effort' in patch) {
      out.reasoningEffort = parseOptionalReasoningEffort(patch.reasoningEffort ?? patch.reasoning_effort);
    }
  }
  return out;
}

function safeCfg() {
  const out = { ...runtimeCfg };
  if (out.chatKey) out.chatKey = '***';
  return out;
}

const tBoot = Date.now();
const corpusManager = createCorpusManager(CORPORA_DIR);

function resolveDefaultCorpusId() {
  if (corpusManager.hasCorpus(runtimeCfg.defaultCorpus)) return runtimeCfg.defaultCorpus;
  const list = corpusManager.listCorpora();
  if (list.length) return list[0].id;
  return runtimeCfg.defaultCorpus;
}

function pickCorpusId(reqCorpus) {
  const requested = String(reqCorpus || '').trim();
  if (requested) return requested;
  return resolveDefaultCorpusId();
}

const bootCorpus = resolveDefaultCorpusId();
const bootAgent = corpusManager.hasCorpus(bootCorpus) ? corpusManager.getAgent(bootCorpus) : null;
const bootMs = Date.now() - tBoot;
console.log(
  `[lorecodex] booted in ${bootMs}ms (mode=tree-only, corpora=${corpusManager.listCorpora().length}, active=${bootCorpus})`
);

const recentTreeRuns = [];
function recordTreeRun(payload, out) {
  const entry = {
    id: 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    corpus_id: out.corpus_id || '',
    corpus_name: out.corpus_name || '',
    max_order: out.max_order ?? null,
    input: {
      corpus: out.corpus_id || '',
      query: String(payload?.query || '').slice(0, 500),
      onDemand: String(payload?.onDemand || '').slice(0, 300),
      sceneAnchor: payload?.sceneAnchor || {},
      maxOrder: payload?.maxOrder ?? null,
      recentCount: Array.isArray(payload?.recentChat) ? payload.recentChat.length : 0,
      recentChat: Array.isArray(payload?.recentChat) ? payload.recentChat.slice(-6) : [],
      sessionRecall: Array.isArray(payload?.sessionRecall) ? payload.sessionRecall.slice(0, 30) : [],
      maxScenes: payload?.maxScenes ?? 0,
    },
    output: out,
  };
  recentTreeRuns.unshift(entry);
  if (recentTreeRuns.length > 40) recentTreeRuns.length = 40;
  return entry;
}

const importJobs = [];
const importJobMap = new Map();

function pushJobLogs(job, chunk) {
  const lines = String(chunk || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  for (const l of lines) {
    job.logs.push(l);
    if (job.logs.length > 200) job.logs.shift();
  }
}

function runBuilderJob({ kind, corpusId, filename, bytes = 0, initLog, scriptArgs, cleanupFn = null }) {
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const job = {
    id: jobId,
    status: 'running',
    kind,
    corpusId,
    filename,
    bytes,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [initLog],
    error: '',
  };

  importJobs.unshift(job);
  if (importJobs.length > 20) {
    const removed = importJobs.pop();
    if (removed) importJobMap.delete(removed.id);
  }
  importJobMap.set(jobId, job);

  const child = spawn(detectPythonBin(), scriptArgs, {
    cwd: ROOT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  child.stdout.on('data', (d) => pushJobLogs(job, d.toString('utf8')));
  child.stderr.on('data', (d) => pushJobLogs(job, d.toString('utf8')));

  const doCleanup = () => {
    if (typeof cleanupFn === 'function') {
      try {
        cleanupFn();
      } catch (_) {}
    }
  };

  child.on('error', (err) => {
    doCleanup();
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    pushJobLogs(job, `[error] spawn failed: ${err.message}`);
  });

  child.on('close', (code) => {
    doCleanup();
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      try {
        corpusManager.reload();
        job.status = 'done';
        pushJobLogs(job, `[${kind}] completed and reloaded corpora (${corpusManager.listCorpora().length} packs)`);
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
        pushJobLogs(job, `[error] reload failed: ${err.message}`);
      }
    } else {
      job.status = 'error';
      job.error = `builder exited with code ${code}`;
      pushJobLogs(job, `[error] ${job.error}`);
    }
  });

  return job;
}

function startImportJob({
  kind,
  corpusId,
  name,
  filename,
  fileBuffer,
  category,
  series,
  mergeInto,
  useLlm,
  filterGameStats,
  overwriteConfig,
  cleanAds = true,
  stripBlocks = [],
}) {
  const prepId = 'prep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const safeName = path.basename(String(filename || 'upload.txt')).replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_') || 'upload.txt';
  const jobTmpDir = path.join(TMP_UPLOADS_DIR, prepId);
  fs.mkdirSync(jobTmpDir, { recursive: true });
  const uploadPath = path.join(jobTmpDir, safeName);
  fs.writeFileSync(uploadPath, fileBuffer);

  const targetCorpusId = kind === 'lore' && mergeInto ? mergeInto : corpusId;
  let args = [];
  if (kind === 'novel') {
    const scriptPath = path.join(ROOT_DIR, 'builders', 'build_novel.py');
    args = [
      scriptPath,
      '--input',
      uploadPath,
      '--corpus-id',
      corpusId,
      '--name',
      name || corpusId,
      '--out-dir',
      CORPORA_DIR,
      '--config',
      CFG_FILE,
    ];
    if (category) args.push('--category', category);
    if (!useLlm) args.push('--no-llm');
    if (overwriteConfig) args.push('--overwrite-config');
    if (!cleanAds) args.push('--no-clean-ads');
    for (const spec of stripBlocks) args.push('--strip-block', spec);
  } else {
    const scriptPath = path.join(ROOT_DIR, 'builders', 'build_lore.py');
    args = [
      scriptPath,
      '--input',
      uploadPath,
      '--corpus-id',
      corpusId,
      '--out-dir',
      CORPORA_DIR,
    ];
    if (name) args.push('--name', name);
    if (category) args.push('--category', category);
    if (series) args.push('--series', series);
    if (mergeInto) args.push('--merge-into', path.join(CORPORA_DIR, mergeInto));
    if (filterGameStats) args.push('--filter-game-stats');
    if (!useLlm) args.push('--no-llm');
  }

  return runBuilderJob({
    kind,
    corpusId: targetCorpusId,
    filename: safeName,
    bytes: fileBuffer.length,
    initLog: `[import] queued ${kind} build for "${targetCorpusId}" (${safeName}, ${fileBuffer.length} bytes)`,
    scriptArgs: args,
    cleanupFn: () => fs.rmSync(jobTmpDir, { recursive: true, force: true }),
  });
}

function startUpgradeJob({ corpusId, series = '', limitArcs = 0, startArc = 1, workers = 10, skipMeta = false, force = false }) {
  const scriptPath = path.join(ROOT_DIR, 'builders', 'build_novel.py');
  const args = [
    scriptPath,
    '--upgrade',
    '--corpus-id',
    corpusId,
    '--out-dir',
    CORPORA_DIR,
    '--config',
    CFG_FILE,
  ];
  const ser = String(series || '').trim();
  if (ser) args.push('--series', ser);
  const w = Math.min(Math.max(Number(workers) || 10, 1), 24);
  args.push('--workers', String(w));
  const sa = Math.max(1, Number(startArc) || 1);
  if (sa > 1) args.push('--start-arc', String(sa));
  const la = Math.max(0, Number(limitArcs) || 0);
  if (la > 0) args.push('--limit-arcs', String(la));
  if (skipMeta) args.push('--skip-meta');
  if (force) args.push('--force');

  return runBuilderJob({
    kind: 'upgrade',
    corpusId,
    filename: ser ? `upgrade:${ser}` : 'upgrade:all',
    bytes: 0,
    initLog: `[upgrade] queued in-place LLM summary upgrade for "${corpusId}"${ser ? ` (series=${ser})` : ''}${la > 0 ? ` limit=${la}` : ''}`,
    scriptArgs: args,
  });
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error(`payload exceeds limit (${maxBytes} bytes)`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const send = (obj, code = 200) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && (pathname === '/ui' || pathname === '/ui/')) {
    res.writeHead(302, { Location: '/' + parsedUrl.search });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      return send({ error: 'ui/index.html not found: ' + e.message }, 404);
    }
  }

  if (req.method === 'GET' && (pathname.startsWith('/ui/') || pathname === '/styles.css' || pathname.startsWith('/js/'))) {
    const rawRel = pathname.startsWith('/ui/') ? pathname.slice('/ui/'.length) : pathname.slice(1);
    let rel = '';
    try {
      rel = decodeURIComponent(rawRel);
    } catch (_) {
      return send({ error: 'invalid path encoding' }, 400);
    }
    if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.startsWith('\\')) {
      return send({ error: 'forbidden' }, 403);
    }
    const resolved = path.resolve(UI_DIR, rel);
    const uiPrefix = UI_DIR.endsWith(path.sep) ? UI_DIR : UI_DIR + path.sep;
    if (!resolved.startsWith(uiPrefix)) {
      return send({ error: 'forbidden' }, 403);
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return send({ error: 'asset not found' }, 404);
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(resolved));
  }

  if (req.method === 'GET' && pathname === '/health') {
    const activeId = resolveDefaultCorpusId();
    const activeMeta = corpusManager.getCorpusMeta(activeId);
    const activeAgent = corpusManager.hasCorpus(activeId) ? corpusManager.getAgent(activeId) : null;
    return send({
      ok: true,
      engine: 'lorecodex',
      version: '2.2.0',
      mode: 'tree-only',
      boot_ms: bootMs,
      defaultCorpus: activeId,
      corpora: corpusManager.listCorpora().map((c) => ({
        id: c.id,
        name: c.name,
        arcs: c.stats.arcs,
        scenes: c.stats.scenes,
        total_chars: c.stats.total_chars,
        max_order: c.stats.max_order,
      })),
      treeLoaded: Boolean(activeAgent?.loaded),
      treeArcs: activeMeta?.stats?.arcs || 0,
      treeScenes: activeMeta?.stats?.scenes || 0,
      config: safeCfg(),
    });
  }

  if (req.method === 'GET' && pathname === '/corpora') {
    return send({
      defaultCorpus: resolveDefaultCorpusId(),
      corpora: corpusManager.listCorpora(),
    });
  }

  if (req.method === 'POST' && pathname === '/corpora/reload') {
    const list = corpusManager.reload();
    return send({ ok: true, defaultCorpus: resolveDefaultCorpusId(), corpora: list });
  }

  if (req.method === 'POST' && pathname === '/corpora/import') {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ error: 'origin not allowed' }, 403);
    }
    try {
      const payload = await readJsonBody(req, 40 * 1024 * 1024);
      const kind = payload.kind === 'lore' ? 'lore' : 'novel';
      const corpusId = String(payload.corpusId || '').trim();
      const mergeInto = String(payload.mergeInto || '').trim();
      const idRe = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
      if (!idRe.test(corpusId)) {
        return send({ error: 'corpusId 仅允许字母、数字、下划线或连字符（1~48位）' }, 400);
      }
      if (mergeInto && !idRe.test(mergeInto)) {
        return send({ error: 'mergeInto ID 格式不合法' }, 400);
      }
      if (kind === 'lore' && mergeInto && !corpusManager.hasCorpus(mergeInto)) {
        return send({ error: `目标合并书库 "${mergeInto}" 不存在` }, 404);
      }
      const rawB64 = String(payload.contentBase64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
      if (!rawB64) {
        return send({ error: '上传文件内容为空' }, 400);
      }
      const fileBuffer = Buffer.from(rawB64, 'base64');
      if (!fileBuffer.length) {
        return send({ error: '文件解码为空' }, 400);
      }

      const job = startImportJob({
        kind,
        corpusId,
        name: String(payload.name || '').trim(),
        filename: payload.filename || (kind === 'lore' ? 'worldbook.json' : 'novel.txt'),
        fileBuffer,
        category: String(payload.category || '').trim(),
        series: String(payload.series || '').trim(),
        mergeInto,
        useLlm: Boolean(payload.useLlm),
        filterGameStats: Boolean(payload.filterGameStats),
        overwriteConfig: Boolean(payload.overwriteConfig),
        cleanAds: payload.cleanAds !== false,
        stripBlocks: String(payload.stripBlocks || '')
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter((x) => x && !x.startsWith('#'))
          .slice(0, 50),
      });
      return send({ ok: true, job }, 202);
    } catch (e) {
      return send({ error: e.message }, e.statusCode || 400);
    }
  }

  const corpusCfgMatch = pathname.match(/^\/corpora\/([^/]+)\/config$/);
  if (req.method === 'POST' && corpusCfgMatch) {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ error: 'origin not allowed' }, 403);
    }
    try {
      const cid = decodeURIComponent(corpusCfgMatch[1]);
      const patch = await readJsonBody(req);
      const updated = corpusManager.updateCorpusConfig(cid, patch);
      return send({ ok: true, corpus: updated });
    } catch (e) {
      return send({ error: e.message }, e.statusCode || 400);
    }
  }

  const corpusUpgradeMatch = pathname.match(/^\/corpora\/([^/]+)\/upgrade$/);
  if (req.method === 'POST' && corpusUpgradeMatch) {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ error: 'origin not allowed' }, 403);
    }
    try {
      const cid = decodeURIComponent(corpusUpgradeMatch[1]).trim();
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(cid)) {
        return send({ error: 'invalid corpus id' }, 400);
      }
      if (!corpusManager.hasCorpus(cid)) {
        return send({ error: `corpus "${cid}" not found` }, 404);
      }
      if (!runtimeCfg.chatBase || !runtimeCfg.chatKey) {
        return send({ error: '请先在服务配置中填好 chatBase 与 chatKey 后再执行 LLM 目录补全' }, 400);
      }
      const payload = await readJsonBody(req);
      const job = startUpgradeJob({
        corpusId: cid,
        series: payload.series || '',
        limitArcs: payload.limitArcs || 0,
        startArc: payload.startArc || 1,
        workers: payload.workers || 10,
        skipMeta: Boolean(payload.skipMeta),
        force: Boolean(payload.force),
      });
      return send({ ok: true, job }, 202);
    } catch (e) {
      return send({ error: e.message }, e.statusCode || 400);
    }
  }

  const corpusExportMatch = pathname.match(/^\/corpora\/([^/]+)\/export$/);
  if (req.method === 'GET' && corpusExportMatch) {
    const cid = decodeURIComponent(corpusExportMatch[1]).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(cid) || !corpusManager.hasCorpus(cid)) {
      return send({ error: `corpus "${cid}" not found` }, 404);
    }
    const meta = corpusManager.getCorpusMeta(cid);
    const corpusDir = path.join(CORPORA_DIR, cid);
    const idxFile = ['tree_index.json', 'full_tree_index.json'].map((f) => path.join(corpusDir, f)).find((p) => fs.existsSync(p));
    const txtFile = ['tree_texts.json', 'full_tree_texts.json'].map((f) => path.join(corpusDir, f)).find((p) => fs.existsSync(p));
    const graphFile = ['graph.json', 'graph-compact.json'].map((f) => path.join(corpusDir, f)).find((p) => fs.existsSync(p));
    if (!idxFile || !txtFile) return send({ error: 'corpus index/texts missing' }, 404);
    let graphData = [];
    if (graphFile) {
      try {
        const loadedGraph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
        if (Array.isArray(loadedGraph)) graphData = loadedGraph;
      } catch (_) {}
    }
    const pack = {
      format: 'lorecodex-pack-v2',
      id: cid,
      config: meta?.config || {},
      indexData: JSON.parse(fs.readFileSync(idxFile, 'utf8')),
      textsData: JSON.parse(fs.readFileSync(txtFile, 'utf8')),
      graphData,
      exportedAt: new Date().toISOString(),
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${cid}.lorepack.json"`,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(pack));
  }

  if (req.method === 'DELETE' && pathname.startsWith('/corpora/') && !pathname.slice('/corpora/'.length).includes('/')) {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ error: 'origin not allowed' }, 403);
    }
    const cid = decodeURIComponent(pathname.slice('/corpora/'.length)).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(cid)) {
      return send({ error: 'invalid corpus id' }, 400);
    }
    if (!corpusManager.hasCorpus(cid)) {
      return send({ error: `corpus "${cid}" not found` }, 404);
    }
    const activeJob = importJobs.find((j) => j.status === 'running' && j.corpusId === cid);
    if (activeJob) {
      return send({ error: `书库 "${cid}" 正在执行任务 (${activeJob.id})，请先暂停或等待完成后再删除` }, 409);
    }
    const targetDir = path.resolve(CORPORA_DIR, cid);
    const corporaPrefix = CORPORA_DIR.endsWith(path.sep) ? CORPORA_DIR : CORPORA_DIR + path.sep;
    if (!targetDir.startsWith(corporaPrefix) || targetDir === CORPORA_DIR) {
      return send({ error: 'forbidden' }, 403);
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      const list = corpusManager.reload();
      return send({ ok: true, deleted: cid, defaultCorpus: resolveDefaultCorpusId(), corpora: list });
    } catch (e) {
      return send({ error: e.message }, 500);
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/corpora/')) {
    const id = decodeURIComponent(pathname.slice('/corpora/'.length));
    const meta = corpusManager.getCorpusMeta(id);
    if (!meta) return send({ error: `corpus "${id}" not found` }, 404);
    return send(meta);
  }

  if (req.method === 'GET' && pathname === '/jobs') {
    return send({
      jobs: importJobs.map((j) => ({
        id: j.id,
        status: j.status,
        kind: j.kind,
        corpusId: j.corpusId,
        filename: j.filename,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        error: j.error,
        logCount: j.logs.length,
      })),
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/jobs/')) {
    const jid = decodeURIComponent(pathname.slice('/jobs/'.length));
    const job = importJobMap.get(jid);
    if (!job) return send({ error: 'job not found' }, 404);
    return send({ ok: true, job });
  }

  if (req.method === 'GET' && pathname === '/tree-index') {
    const cid = pickCorpusId(parsedUrl.searchParams.get('corpus'));
    const agent = corpusManager.getAgent(cid);
    if (!agent || !agent.loaded) return send({ error: `corpus "${cid}" not found or not loaded` }, 404);
    const maxOrder = parsedUrl.searchParams.get('maxOrder');
    return send(agent.getTreeIndex({ maxOrder }));
  }

  if (req.method === 'GET' && pathname === '/tree-scene') {
    const cid = pickCorpusId(parsedUrl.searchParams.get('corpus'));
    const agent = corpusManager.getAgent(cid);
    if (!agent || !agent.loaded) return send({ error: `corpus "${cid}" not found or not loaded` }, 404);
    const sid = parsedUrl.searchParams.get('id');
    const maxOrder = parsedUrl.searchParams.get('maxOrder');
    const sc = agent.getSceneText(sid, { maxOrder });
    if (!sc) return send({ error: 'scene not found' }, 404);
    if (sc.blocked) {
      return send(
        { error: `blocked by spoiler gate (order=${sc.order} > maxOrder=${sc.max_order})`, blocked: true },
        403
      );
    }
    return send(sc);
  }

  if (req.method === 'GET' && pathname === '/tree-grep') {
    const cid = pickCorpusId(parsedUrl.searchParams.get('corpus'));
    const agent = corpusManager.getAgent(cid);
    if (!agent || !agent.loaded) return send({ error: `corpus "${cid}" not found or not loaded` }, 404);
    const q = parsedUrl.searchParams.get('q') || '';
    const limit = Math.min(Math.max(Number(parsedUrl.searchParams.get('limit')) || 30, 1), 60);
    const category = parsedUrl.searchParams.get('category') || '';
    const tone = parsedUrl.searchParams.get('tone') || '';
    const maxOrder = parsedUrl.searchParams.get('maxOrder');
    return send(agent.grepScenes(q, { limit, category, tone, maxOrder }));
  }

  if (req.method === 'GET' && pathname === '/tree-runs') {
    const cid = String(parsedUrl.searchParams.get('corpus') || '').trim();
    const runs = cid ? recentTreeRuns.filter((r) => r.corpus_id === cid) : recentTreeRuns;
    return send({ runs });
  }

  if (req.method === 'POST' && pathname === '/tree-search') {
    try {
      const payload = await readJsonBody(req);
      const cid = pickCorpusId(payload.corpus);
      const agent = corpusManager.getAgent(cid);
      if (!agent || !agent.loaded) {
        return send({ error: `corpus "${cid}" not found or not loaded` }, 404);
      }
      const effCfg = mergeCfg(payload.apiConfig || {});
      const out = await agent.search(payload, effCfg);
      const run = recordTreeRun(payload, out);
      console.log(
        `[${new Date().toISOString()}] /tree-search corpus=${cid} maxOrder=${out.max_order ?? '-'} skip=${out.skip} turns=${out.turns} scenes=${out.scenes.length} took=${out.took_ms}ms tokens=${out.usage?.prompt || 0}+${out.usage?.completion || 0}`
      );
      return send({ ...out, run_id: run.id });
    } catch (e) {
      console.error('[tree-search error]', e);
      return send({ error: e.message }, e.statusCode || 500);
    }
  }

  if (req.method === 'GET' && pathname === '/config') {
    return send(safeCfg());
  }

  if (req.method === 'POST' && pathname === '/config') {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ error: 'origin not allowed' }, 403);
    }
    try {
      const patch = await readJsonBody(req);
      saveCfg(patch);
      return send({ ok: true, config: safeCfg() });
    } catch (e) {
      return send({ error: e.message }, e.statusCode || 400);
    }
  }

  if (req.method === 'POST' && pathname === '/models') {
    if (!isLocalOrAllowedOrigin(req.headers.origin, req)) {
      return send({ ok: false, error: 'origin not allowed' }, 403);
    }
    try {
      const { baseUrl, apiKey } = await readJsonBody(req);
      const b = cleanApiBaseUrl(baseUrl || runtimeCfg.chatBase || '');
      const hasExplicitKey =
        typeof apiKey === 'string' && Boolean(apiKey.trim()) && !/^\*+$/.test(apiKey.trim());
      const reqBase = normalizeBaseUrl(baseUrl);
      const curBase = normalizeBaseUrl(runtimeCfg.chatBase);
      if (reqBase && reqBase !== curBase && !hasExplicitKey) {
        return send({ ok: false, error: '修改 API Base URL 时请同时输入对应的 API Key（防止旧密钥发送至新地址）' }, 400);
      }
      const k = hasExplicitKey ? apiKey.trim() : runtimeCfg.chatKey;
      if (!b || !k) return send({ ok: false, error: '请先填写 API Base URL 与 API Key' }, 400);
      const r = await fetch(b + '/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) {
        const errTxt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${errTxt ? ': ' + errTxt.slice(0, 120) : ''}`);
      }
      const j = await r.json();
      const rawList = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      const models = [
        ...new Set(
          rawList
            .map((x) => (typeof x === 'string' ? x : x?.id || String(x?.name || '').replace(/^models\//, '')))
            .map((s) => String(s || '').trim())
            .filter(Boolean)
        ),
      ];
      return send({ ok: true, models });
    } catch (e) {
      return send({ ok: false, error: e.message }, e.statusCode || 400);
    }
  }

  send({ error: 'not found' }, 404);
});

server.listen(PORT, HOST, () => {
  console.log(`[lorecodex] listening on http://${HOST}:${PORT} (active=${bootAgent ? bootCorpus : 'none'})`);
});
