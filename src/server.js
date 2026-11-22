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

const defaultCfg = {
  port: 5240,
  defaultCorpus: 'demo-chronicles',
  chatBase: 'https://api.openai.com/v1',
  chatKey: '',
  chatModel: 'deepseek-chat',
  disableThinking: true,
};

let runtimeCfg = { ...defaultCfg };
if (fs.existsSync(CFG_FILE)) {
  try {
    runtimeCfg = { ...defaultCfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch (err) {
    console.warn('[server] failed to parse config.json:', err.message);
  }
}

if (process.env.PORT) runtimeCfg.port = Number(process.env.PORT) || runtimeCfg.port;
if (process.env.CHAT_BASE) runtimeCfg.chatBase = process.env.CHAT_BASE;
if (process.env.CHAT_KEY) runtimeCfg.chatKey = process.env.CHAT_KEY;
if (process.env.CHAT_MODEL) runtimeCfg.chatModel = process.env.CHAT_MODEL;
if (process.env.DEFAULT_CORPUS) runtimeCfg.defaultCorpus = process.env.DEFAULT_CORPUS;
if (process.env.DISABLE_THINKING !== undefined) {
  runtimeCfg.disableThinking = process.env.DISABLE_THINKING !== 'false';
}
if (cli.port && Number.isFinite(cli.port)) runtimeCfg.port = cli.port;
if (cli.defaultCorpus) runtimeCfg.defaultCorpus = cli.defaultCorpus;

const PORT = Number(runtimeCfg.port) || 5240;
const HOST = String(cli.host || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';

function normalizeBaseUrl(u) {
  return String(u || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isLocalOrAllowedOrigin(origin) {
  if (!origin) return true;
  const o = String(origin).trim();
  const extra = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes('*') || extra.includes(o)) return true;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(o);
}

function saveCfg(patch) {
  if (!patch || typeof patch !== 'object') return;
  const prevBase = normalizeBaseUrl(runtimeCfg.chatBase);
  const hasNewKey =
    typeof patch.chatKey === 'string' && Boolean(patch.chatKey.trim()) && !/^\*+$/.test(patch.chatKey.trim());
  for (const k of ['chatBase', 'chatKey', 'chatModel', 'defaultCorpus']) {
    if (typeof patch[k] === 'string') {
      const v = patch[k].trim();
      if (v && !/^\*+$/.test(v)) runtimeCfg[k] = v;
    }
  }
  if (typeof patch.chatBase === 'string' && normalizeBaseUrl(runtimeCfg.chatBase) !== prevBase && !hasNewKey) {
    runtimeCfg.chatKey = '';
  }
  if (typeof patch.disableThinking === 'boolean') {
    runtimeCfg.disableThinking = patch.disableThinking;
  }
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
        const v = patch[k].trim();
        if (v && !/^\*+$/.test(v)) out[k] = v;
      }
    }
    if (typeof patch.chatBase === 'string' && normalizeBaseUrl(out.chatBase) !== prevBase && !hasNewKey) {
      out.chatKey = '';
    }
    if (typeof patch.disableThinking === 'boolean') {
      out.disableThinking = patch.disableThinking;
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
      activeStateHints: String(payload?.activeStateHints || '').slice(0, 600),
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
}) {
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const safeName = path.basename(String(filename || 'upload.txt')).replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_') || 'upload.txt';
  const jobTmpDir = path.join(TMP_UPLOADS_DIR, jobId);
  fs.mkdirSync(jobTmpDir, { recursive: true });
  const uploadPath = path.join(jobTmpDir, safeName);
  fs.writeFileSync(uploadPath, fileBuffer);

  const targetCorpusId = kind === 'lore' && mergeInto ? mergeInto : corpusId;
  const job = {
    id: jobId,
    status: 'running',
    kind,
    corpusId: targetCorpusId,
    filename: safeName,
    bytes: fileBuffer.length,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [`[import] queued ${kind} build for "${targetCorpusId}" (${safeName}, ${fileBuffer.length} bytes)`],
    error: '',
  };

  importJobs.unshift(job);
  if (importJobs.length > 20) {
    const removed = importJobs.pop();
    if (removed) importJobMap.delete(removed.id);
  }
  importJobMap.set(jobId, job);

  let scriptPath = '';
  let args = [];
  if (kind === 'novel') {
    scriptPath = path.join(ROOT_DIR, 'builders', 'build_novel.py');
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
  } else {
    scriptPath = path.join(ROOT_DIR, 'builders', 'build_lore.py');
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

  const child = spawn(detectPythonBin(), args, {
    cwd: ROOT_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  child.stdout.on('data', (d) => pushJobLogs(job, d.toString('utf8')));
  child.stderr.on('data', (d) => pushJobLogs(job, d.toString('utf8')));

  const cleanupTmp = () => {
    try {
      fs.rmSync(jobTmpDir, { recursive: true, force: true });
    } catch (_) {}
  };

  child.on('error', (err) => {
    cleanupTmp();
    job.status = 'error';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    pushJobLogs(job, `[error] spawn failed: ${err.message}`);
  });

  child.on('close', (code) => {
    cleanupTmp();
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      try {
        corpusManager.reload();
        job.status = 'done';
        pushJobLogs(job, `[import] completed and reloaded corpora (${corpusManager.listCorpora().length} packs)`);
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/ui' || pathname === '/ui/')) {
    try {
      const html = fs.readFileSync(UI_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      return send({ error: 'ui/index.html not found: ' + e.message }, 404);
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/ui/')) {
    let rel = '';
    try {
      rel = decodeURIComponent(pathname.slice('/ui/'.length));
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
      version: '2.0.0',
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
    if (!isLocalOrAllowedOrigin(req.headers.origin)) {
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
      });
      return send({ ok: true, job }, 202);
    } catch (e) {
      return send({ error: e.message }, e.statusCode || 400);
    }
  }

  const corpusCfgMatch = pathname.match(/^\/corpora\/([^/]+)\/config$/);
  if (req.method === 'POST' && corpusCfgMatch) {
    if (!isLocalOrAllowedOrigin(req.headers.origin)) {
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
    if (!isLocalOrAllowedOrigin(req.headers.origin)) {
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
    if (!isLocalOrAllowedOrigin(req.headers.origin)) {
      return send({ ok: false, error: 'origin not allowed' }, 403);
    }
    try {
      const { baseUrl, apiKey } = await readJsonBody(req);
      const b = String(baseUrl || runtimeCfg.chatBase || '').replace(/\/+$/, '');
      const hasExplicitKey =
        typeof apiKey === 'string' && Boolean(apiKey.trim()) && !/^\*+$/.test(apiKey.trim());
      const reqBase = normalizeBaseUrl(baseUrl);
      const curBase = normalizeBaseUrl(runtimeCfg.chatBase);
      if (reqBase && reqBase !== curBase && !hasExplicitKey) {
        return send({ ok: false, error: 'custom baseUrl requires an explicit apiKey' }, 400);
      }
      const k = hasExplicitKey ? apiKey.trim() : runtimeCfg.chatKey;
      if (!b || !k) return send({ ok: false, error: 'chatBase or chatKey is missing' }, 400);
      const r = await fetch(b + '/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return send({ ok: true, models: (j.data || []).map((x) => x.id) });
    } catch (e) {
      return send({ ok: false, error: e.message }, e.statusCode || 400);
    }
  }

  send({ error: 'not found' }, 404);
});

server.listen(PORT, HOST, () => {
  console.log(`[lorecodex] listening on http://${HOST}:${PORT} (active=${bootAgent ? bootCorpus : 'none'})`);
});
