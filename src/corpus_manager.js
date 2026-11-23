'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeCorpusConfig } = require('./prompt_builder');
const { createTreeAgent, resolveCorpusFiles } = require('./tree_agent');

function readCorpusDescriptor(corpusId, corpusDir) {
  const { indexPath, textsPath } = resolveCorpusFiles(corpusDir);
  if (!indexPath || !textsPath) return null;

  let rawCfg = {};
  const cfgPath = path.join(corpusDir, 'corpus.json');
  if (fs.existsSync(cfgPath)) {
    try {
      rawCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      console.warn(`[corpus-manager] invalid corpus.json in ${corpusDir}:`, err.message);
    }
  }
  const config = normalizeCorpusConfig(rawCfg, corpusId);

  let stats = { arcs: 0, scenes: 0, total_chars: 0, max_order: 0 };
  let categories = [];
  let series = [];
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const arcs = Array.isArray(idx.arcs) ? idx.arcs : [];
    const catSet = new Set();
    const serSet = new Set();
    let totalScenes = 0;
    let totalChars = 0;
    let maxOrd = 0;
    let summarizedScenes = 0;
    let summarizedArcs = 0;
    for (const a of arcs) {
      if (a.category) catSet.add(a.category);
      if (a.series) serSet.add(a.series);
      const aScenes = a.scenes || [];
      totalScenes += aScenes.length;
      totalChars += Number(a.total_chars) || 0;
      if (a.order !== null && a.order !== undefined && Number.isFinite(Number(a.order))) {
        maxOrd = Math.max(maxOrd, Number(a.order));
      }
      let arcHasDone = aScenes.length > 0;
      for (const s of aScenes) {
        if (s.order !== null && s.order !== undefined && Number.isFinite(Number(s.order))) {
          maxOrd = Math.max(maxOrd, Number(s.order));
        }
        const sDone = s._llm_done === true || (s._llm_done !== false && Boolean(String(s.summary || '').trim()));
        if (sDone) summarizedScenes += 1;
        else arcHasDone = false;
      }
      if (a._llm_done === true || (a._llm_done !== false && arcHasDone && aScenes.length > 0)) {
        summarizedArcs += 1;
      }
    }
    const explicitLlmScenes = typeof idx.stats?.llm_scenes === 'number' ? idx.stats.llm_scenes : null;
    const explicitLlmArcs = typeof idx.stats?.llm_arcs === 'number' ? idx.stats.llm_arcs : null;
    const resolvedLlmScenes = explicitLlmScenes !== null
      ? explicitLlmScenes
      : (explicitLlmArcs === 0 ? 0 : summarizedScenes);
    const resolvedLlmArcs = explicitLlmArcs !== null
      ? explicitLlmArcs
      : (explicitLlmScenes === 0 ? 0 : summarizedArcs);
    stats = {
      arcs: idx.stats?.arcs || arcs.length,
      scenes: idx.stats?.scenes || totalScenes,
      llm_arcs: resolvedLlmArcs,
      llm_scenes: resolvedLlmScenes,
      total_chars: idx.stats?.total_chars || totalChars,
      max_order: maxOrd,
    };
    categories = [...catSet];
    series = [...serSet];
  } catch (err) {
    console.warn(`[corpus-manager] failed to peek index in ${corpusDir}:`, err.message);
  }

  return {
    id: corpusId,
    dir: corpusDir,
    config,
    stats,
    categories,
    series,
  };
}

function createCorpusManager(corporaDir, { fallbackSearchFn = null } = {}) {
  const descriptors = new Map();
  const agentCache = new Map();

  function scan() {
    descriptors.clear();
    if (!fs.existsSync(corporaDir)) return;
    const entries = fs.readdirSync(corporaDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      const dir = path.join(corporaDir, ent.name);
      const desc = readCorpusDescriptor(ent.name, dir);
      if (desc) descriptors.set(ent.name, desc);
    }
  }

  function reload() {
    agentCache.clear();
    scan();
    return listCorpora();
  }

  function listCorpora() {
    return [...descriptors.values()].map((d) => ({
      id: d.id,
      name: d.config.name,
      description: d.config.description,
      language: d.config.language,
      stats: d.stats,
      categories: d.categories,
      series: d.series,
      spoiler_gate: d.config.spoiler_gate,
      prompt_framing: d.config.prompt_framing,
      ui: d.config.ui,
      loaded: agentCache.has(d.id),
    }));
  }

  function hasCorpus(id) {
    return descriptors.has(String(id || '').trim());
  }

  function getCorpusMeta(id) {
    const key = String(id || '').trim();
    const d = descriptors.get(key);
    if (!d) return null;
    return {
      id: d.id,
      name: d.config.name,
      description: d.config.description,
      language: d.config.language,
      stats: d.stats,
      categories: d.categories,
      series: d.series,
      config: d.config,
      loaded: agentCache.has(d.id),
    };
  }

  function getAgent(id) {
    const key = String(id || '').trim();
    const desc = descriptors.get(key);
    if (!desc) return null;
    if (!agentCache.has(key)) {
      const agent = createTreeAgent({
        corpusId: desc.id,
        corpusDir: desc.dir,
        corpusConfig: desc.config,
        fallbackSearchFn,
      });
      agentCache.set(key, agent);
    }
    return agentCache.get(key);
  }

  function updateCorpusConfig(id, patch) {
    const key = String(id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(key)) {
      const err = new Error('invalid corpus id');
      err.statusCode = 400;
      throw err;
    }
    const desc = descriptors.get(key);
    if (!desc) {
      const err = new Error(`corpus "${key}" not found`);
      err.statusCode = 404;
      throw err;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      const err = new Error('invalid config payload');
      err.statusCode = 400;
      throw err;
    }

    const cfgPath = path.join(desc.dir, 'corpus.json');
    let existing = {};
    if (fs.existsSync(cfgPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch (_) {}
    }

    const scalarAndArrayKeys = [
      'name',
      'description',
      'language',
      'world_premise',
      'active_recall_triggers',
      'skip_criteria',
      'aliases',
      'glossary',
      'stage_card_patterns',
      'oc_examples',
      'tone_routing_hints',
    ];
    const objectKeys = [
      'user_identity_guard',
      'spoiler_gate',
      'hierarchy',
      'grep',
      'prompt_framing',
      'ui',
    ];

    const merged = { ...existing, id: key };
    for (const k of scalarAndArrayKeys) {
      if (patch[k] !== undefined) merged[k] = patch[k];
    }
    for (const k of objectKeys) {
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
        merged[k] = { ...(existing[k] && typeof existing[k] === 'object' ? existing[k] : {}), ...patch[k] };
      }
    }

    const normalized = normalizeCorpusConfig(merged, key);
    fs.writeFileSync(cfgPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');

    agentCache.delete(key);
    const refreshed = readCorpusDescriptor(key, desc.dir);
    if (refreshed) descriptors.set(key, refreshed);
    return getCorpusMeta(key);
  }

  scan();

  return {
    corporaDir,
    listCorpora,
    hasCorpus,
    getCorpusMeta,
    getAgent,
    updateCorpusConfig,
    reload,
  };
}

module.exports = { createCorpusManager };
