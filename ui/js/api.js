const IS_LOCAL_QUERY = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('local') === '1';
let forceLocalMode = IS_LOCAL_QUERY;
let browserEnginePromise = null;
const localJobsMap = new Map();
const localAgentsCache = new Map();

async function getBrowserEngine() {
  if (!browserEnginePromise) {
    browserEnginePromise = import(new URL('../../browser_engine.js', import.meta.url).href).catch(() =>
      import(new URL('../../extension/st-tree-lore/browser_engine.js', import.meta.url).href)
    );
  }
  return browserEnginePromise;
}

async function ensureLocalDemoSeeded(be) {
  const rows = await be.idbListCorpora();
  if (rows.length > 0) return rows;
  try {
    const demoUrl = new URL('../demo-chronicles.lorepack.json', import.meta.url).href;
    const r = await fetch(demoUrl);
    if (r.ok) {
      const rawPack = await r.json();
      const pack = be.buildLoreCorpusInBrowser({
        rawJson: rawPack,
        corpusId: rawPack.id || rawPack.corpus_id || 'demo-chronicles',
        name: rawPack.corpus_name || rawPack.indexData?.corpus_name || '苍穹残响·灰烬星港编年史',
      });
      await be.idbSaveCorpus(pack);
      return await be.idbListCorpora();
    }
  } catch (_) {}
  return rows;
}

async function getLocalAgentAndPack(corpusId) {
  const be = await getBrowserEngine();
  const rows = await ensureLocalDemoSeeded(be);
  const pack = rows.find((p) => p.id === corpusId) || rows[0];
  if (!pack) {
    throw new Error('内置免服务端书库为空，请先点击顶栏「导入建树」导入小说 (.txt / .md)、世界书 (.json) 或 .lorepack.json');
  }
  const cacheKey = `${pack.id}:${pack.updatedAt || ''}`;
  if (!localAgentsCache.has(cacheKey)) {
    localAgentsCache.set(cacheKey, be.createBrowserTreeAgent(pack));
  }
  return { be, pack, agent: localAgentsCache.get(cacheKey), rows };
}

async function getLocalApiConfig(be) {
  const cfg = (await be.idbGetMeta('local_api_config', null)) || {};
  return {
    defaultCorpus: cfg.defaultCorpus || 'demo-chronicles',
    chatBase: cfg.chatBase || 'https://api.openai.com/v1',
    chatKey: cfg.chatKey || '',
    chatModel: cfg.chatModel || 'deepseek-chat',
    maxTokens: Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : null,
  };
}

function decodeBase64Utf8(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function reqJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json().catch(() => ({})) : {};
  if (!r.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  if (!ct.includes('application/json')) {
    throw new Error('Non-JSON response');
  }
  return data;
}

export async function fetchHealth() {
  if (!forceLocalMode) {
    try {
      const h = await reqJson('/health');
      if (h && h.ok) return h;
    } catch (_) {
      forceLocalMode = true;
    }
  }
  const be = await getBrowserEngine();
  const rows = await ensureLocalDemoSeeded(be);
  const cfg = await getLocalApiConfig(be);
  const active = rows.find((p) => p.id === cfg.defaultCorpus) || rows[0];
  return {
    ok: true,
    engine: 'lorecodex-browser',
    version: '2.1.0',
    mode: 'browser-idb',
    boot_ms: 1,
    defaultCorpus: active?.id || 'demo-chronicles',
    corpora: rows.map((p) => ({
      id: p.id,
      name: p.config?.name || p.id,
      arcs: p.indexData?.stats?.arcs || (p.indexData?.arcs || []).length,
      scenes: p.indexData?.stats?.scenes || Object.keys(p.textsData || {}).length,
      total_chars: p.indexData?.stats?.total_chars || 0,
      max_order: p.indexData?.stats?.max_order || 0,
    })),
    treeLoaded: Boolean(active),
    treeArcs: active?.indexData?.stats?.arcs || 0,
    treeScenes: active?.indexData?.stats?.scenes || 0,
    config: { ...cfg, chatKey: cfg.chatKey ? '***' : '' },
  };
}

export async function fetchCorpora() {
  if (!forceLocalMode) {
    try {
      return await reqJson('/corpora');
    } catch (_) {
      forceLocalMode = true;
    }
  }
  const be = await getBrowserEngine();
  const rows = await ensureLocalDemoSeeded(be);
  const cfg = await getLocalApiConfig(be);
  const corpora = rows.map((p) => {
    const agent = be.createBrowserTreeAgent(p);
    return {
      id: p.id,
      name: p.config?.name || p.id,
      description: p.config?.description || '',
      language: p.config?.language || 'zh-CN',
      stats: agent.stats,
      categories: agent.categories,
      series: agent.seriesList.map((s) => s.series),
      tone_tags: agent.toneTags,
      spoiler_gate: p.config?.spoiler_gate || {},
      prompt_framing: p.config?.prompt_framing || {},
      db_scrubber: p.config?.db_scrubber || {},
    };
  });
  return {
    defaultCorpus: corpora.some((c) => c.id === cfg.defaultCorpus) ? cfg.defaultCorpus : corpora[0]?.id || '',
    corpora,
  };
}

export async function reloadCorpora() {
  if (!forceLocalMode) {
    try {
      return await reqJson('/corpora/reload', { method: 'POST' });
    } catch (_) {
      forceLocalMode = true;
    }
  }
  localAgentsCache.clear();
  const res = await fetchCorpora();
  return { ok: true, ...res };
}

export async function fetchCorpusDetail(id) {
  if (!forceLocalMode) {
    return reqJson(`/corpora/${encodeURIComponent(id)}`);
  }
  const { pack, agent } = await getLocalAgentAndPack(id);
  return {
    id: pack.id,
    name: pack.config?.name || pack.id,
    description: pack.config?.description || '',
    stats: agent.stats,
    categories: agent.categories,
    series: agent.seriesList.map((s) => s.series),
    tone_tags: agent.toneTags,
    config: pack.config,
  };
}

export async function saveCorpusConfig(id, patch) {
  if (!forceLocalMode) {
    return reqJson(`/corpora/${encodeURIComponent(id)}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  const { be, pack } = await getLocalAgentAndPack(id);
  pack.config = be.normalizeCorpusConfig({ ...(pack.config || {}), ...(patch || {}), id: pack.id }, pack.id);
  if (pack.config.name) pack.indexData.corpus_name = pack.config.name;
  await be.idbSaveCorpus(pack);
  localAgentsCache.clear();
  return { ok: true, corpus: await fetchCorpusDetail(pack.id) };
}

export async function fetchTreeIndex(corpusId, maxOrder = 0) {
  if (!forceLocalMode) {
    const mo = maxOrder > 0 ? `&maxOrder=${maxOrder}` : '';
    return reqJson(`/tree-index?corpus=${encodeURIComponent(corpusId)}${mo}`);
  }
  const { agent } = await getLocalAgentAndPack(corpusId);
  return agent.getTreeIndex({ maxOrder: maxOrder > 0 ? maxOrder : null });
}

export async function fetchSceneText(corpusId, nodeId, maxOrder = 0) {
  if (!forceLocalMode) {
    const mo = maxOrder > 0 ? `&maxOrder=${maxOrder}` : '';
    return reqJson(`/tree-scene?corpus=${encodeURIComponent(corpusId)}&id=${encodeURIComponent(nodeId)}${mo}`);
  }
  const { agent } = await getLocalAgentAndPack(corpusId);
  const sc = agent.getSceneText(nodeId, { maxOrder: maxOrder > 0 ? maxOrder : null });
  if (!sc) throw new Error('scene not found');
  if (sc.blocked) throw new Error(`blocked by spoiler gate (order=${sc.order} > maxOrder=${sc.max_order})`);
  return sc;
}

export async function fetchGrep(corpusId, { q, limit = 40, category = '', tone = '', maxOrder = 0 }) {
  if (!forceLocalMode) {
    const params = new URLSearchParams({
      corpus: corpusId,
      q: q || '',
      limit: String(limit),
    });
    if (category && category !== '全部') params.set('category', category);
    if (tone && tone !== '全部') params.set('tone', tone);
    if (maxOrder > 0) params.set('maxOrder', String(maxOrder));
    return reqJson(`/tree-grep?${params.toString()}`);
  }
  const { agent } = await getLocalAgentAndPack(corpusId);
  return agent.grepScenes(q || '', {
    limit,
    category: category && category !== '全部' ? category : '',
    tone: tone && tone !== '全部' ? tone : '',
    maxOrder: maxOrder > 0 ? maxOrder : null,
  });
}

export async function fetchRuns() {
  if (!forceLocalMode) {
    try {
      return await reqJson('/tree-runs');
    } catch (_) {
      forceLocalMode = true;
    }
  }
  const be = await getBrowserEngine();
  const runs = await be.idbListRuns();
  return { runs };
}

export async function runTreeSearch(payload) {
  if (!forceLocalMode) {
    return reqJson('/tree-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  const { be, agent } = await getLocalAgentAndPack(payload.corpus);
  const cfg = await getLocalApiConfig(be);
  const out = await agent.search(payload, cfg);
  const run = await be.idbRecordRun(payload, out);
  return { ...out, run_id: run.id };
}

export async function fetchConfig() {
  if (!forceLocalMode) {
    return reqJson('/config');
  }
  const be = await getBrowserEngine();
  const cfg = await getLocalApiConfig(be);
  return {
    ...cfg,
    chatKey: cfg.chatKey ? '***' : '',
  };
}

export async function saveConfig(patch) {
  if (!forceLocalMode) {
    return reqJson('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  const be = await getBrowserEngine();
  const cur = await getLocalApiConfig(be);
  const next = {
    defaultCorpus: patch.defaultCorpus || cur.defaultCorpus,
    chatBase: patch.chatBase !== undefined ? String(patch.chatBase).trim() : cur.chatBase,
    chatKey:
      patch.chatKey !== undefined && String(patch.chatKey).trim() && !/^\*+$/.test(String(patch.chatKey).trim())
        ? String(patch.chatKey).trim()
        : cur.chatKey,
    chatModel: patch.chatModel !== undefined ? String(patch.chatModel).trim() : cur.chatModel,
    maxTokens:
      patch.maxTokens !== undefined
        ? Number(patch.maxTokens) > 0
          ? Math.floor(Number(patch.maxTokens))
          : null
        : cur.maxTokens,
  };
  await be.idbSetMeta('local_api_config', next);
  return { ok: true, config: { ...next, chatKey: next.chatKey ? '***' : '' } };
}

export async function fetchModels(baseUrl, apiKey) {
  if (!forceLocalMode) {
    return reqJson('/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
  }
  const be = await getBrowserEngine();
  const cur = await getLocalApiConfig(be);
  const cleanBase = String(baseUrl || cur.chatBase || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|models)$/i, '')
    .replace(/\/+$/, '');
  const key = apiKey && !/^\*+$/.test(String(apiKey).trim()) ? String(apiKey).trim() : cur.chatKey;
  if (!cleanBase || !key) {
    return { ok: false, error: '请先填写 API Base URL 与 API Key' };
  }
  try {
    const r = await fetch(`${cleanBase}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status}${txt ? ': ' + txt.slice(0, 120) : ''}` };
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
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function importCorpus(payload) {
  if (!forceLocalMode) {
    return reqJson('/corpora/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  const be = await getBrowserEngine();
  const jobId = 'job_local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const job = {
    id: jobId,
    status: 'running',
    kind: payload.kind || 'novel',
    corpusId: payload.corpusId,
    filename: payload.filename || 'upload.txt',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [`[browser-idb] 正在浏览器内解析与切分「${payload.name || payload.corpusId}」...`],
    error: '',
  };
  localJobsMap.set(jobId, job);

  (async () => {
    try {
      const rawText = decodeBase64Utf8(payload.contentBase64);
      const isJson =
        payload.kind === 'lore' || String(payload.filename || '').toLowerCase().endsWith('.json');
      const existingRows = await be.idbListCorpora();
      const mergeTarget = payload.mergeInto
        ? existingRows.find((r) => r.id === payload.mergeInto) || null
        : null;
      const pack = isJson
        ? be.buildLoreCorpusInBrowser({
            rawJson: rawText,
            corpusId: payload.corpusId,
            name: payload.name || payload.corpusId,
            category: payload.category || '档案设定',
            existingPack: mergeTarget,
          })
        : be.buildNovelCorpusInBrowser({
            rawText,
            corpusId: payload.corpusId,
            name: payload.name || payload.corpusId,
            category: payload.category || '正文',
          });
      await be.idbSaveCorpus(pack);
      localAgentsCache.clear();
      const st = pack.indexData?.stats || {};
      job.logs.push(`[browser-idb] 切分完成：${st.arcs || 0} 章 / ${st.scenes || 0} 幕 (${st.total_chars || 0} 字)`);

      if (payload.useLlm && !String(payload.filename || '').toLowerCase().endsWith('.lorepack.json')) {
        const apiCfg = await getLocalApiConfig(be);
        if (apiCfg.chatBase && apiCfg.chatKey) {
          job.logs.push('[browser-idb] 正在启动纯前端 LLM 智能目录构建 (含断点续传)...');
          const res = await be.upgradeBrowserCorpusWithLLM(pack, apiCfg, {
            workers: 4,
            onProgress(prog) {
              if (prog.phase === 'series_meta') {
                job.logs.push(`[series_meta] 正在提炼「${prog.series}」全卷总览、人物别名与设定术语...`);
              } else {
                job.logs.push(`[${prog.done}/${prog.total}] 已完成《${prog.arcTitle}》`);
              }
            },
            async onSave(updatedPack) {
              await be.idbSaveCorpus(updatedPack);
              localAgentsCache.clear();
            },
          });
          job.logs.push(
            `[browser-idb] LLM 目录构建完成：${res.upgradedArcs} 章 / ${res.upgradedScenes} 幕，${res.aliasesCount} 组别名，${res.glossaryCount} 条术语`
          );
        } else {
          job.logs.push('[提示] 尚未配置 API Key，已先保存结构树；请在右上角「模型」配置 API Key 后打开「语料配置 -> LLM 目录补全」');
        }
      }
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.logs.push(`[error] ${job.error}`);
      job.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true, job };
}

export async function upgradeCorpus(id, payload = {}) {
  if (!forceLocalMode) {
    return reqJson(`/corpora/${encodeURIComponent(id)}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }
  const { be, pack } = await getLocalAgentAndPack(id);
  const apiCfg = await getLocalApiConfig(be);
  if (!apiCfg.chatBase || !apiCfg.chatKey) {
    throw new Error('请先点击右上角「模型」配置 API Base URL 与 API Key 后再执行 LLM 目录补全');
  }
  const jobId = 'job_upg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const job = {
    id: jobId,
    status: 'running',
    kind: 'upgrade',
    corpusId: pack.id,
    filename: payload.series ? `upgrade:${payload.series}` : 'upgrade:all',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [`[browser-idb] 开始原地补全「${pack.config?.name || pack.id}」LLM 目录...`],
    error: '',
  };
  localJobsMap.set(jobId, job);

  (async () => {
    try {
      const res = await be.upgradeBrowserCorpusWithLLM(pack, apiCfg, {
        series: payload.series || '',
        limitArcs: Number(payload.limitArcs) || 0,
        force: Boolean(payload.force),
        workers: 4,
        onProgress(prog) {
          if (prog.phase === 'series_meta') {
            job.logs.push(`[series_meta] 正在提炼「${prog.series}」全卷总览、人物别名与设定术语...`);
          } else {
            job.logs.push(`[${prog.done}/${prog.total}] 已补全《${prog.arcTitle}》`);
          }
        },
        async onSave(updatedPack) {
          await be.idbSaveCorpus(updatedPack);
          localAgentsCache.clear();
        },
      });
      if (res.message) {
        job.logs.push(res.message);
      } else {
        job.logs.push(
          `[browser-idb] 完成：升级 ${res.upgradedArcs} 章 / ${res.upgradedScenes} 幕，合成 ${res.synthesizedSeries} 卷总览，累计 ${res.aliasesCount} 组别名、${res.glossaryCount} 条术语`
        );
      }
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.logs.push(`[error] ${job.error}`);
      job.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true, job };
}

export async function fetchJob(jobId) {
  if (!forceLocalMode && !String(jobId).startsWith('job_local_') && !String(jobId).startsWith('job_upg_')) {
    return reqJson(`/jobs/${encodeURIComponent(jobId)}`);
  }
  const job = localJobsMap.get(jobId);
  if (!job) throw new Error('job not found');
  return { ok: true, job };
}

export async function exportCorpusLorepack(id) {
  if (!forceLocalMode) {
    window.open(`/corpora/${encodeURIComponent(id)}/export`, '_blank');
    return;
  }
  const { pack } = await getLocalAgentAndPack(id);
  const blob = new Blob([JSON.stringify({ format: 'lorecodex-pack-v2', ...pack }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${pack.id}.lorepack.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
