'use strict';

const fs = require('fs');
const path = require('path');
const { stripMarkup, extractJsonObject, normalizeOrder, isOrderAllowed, formatCharCount } = require('./utils');
const { createGraphEngine } = require('./graph_engine');
const { createGrepEngine } = require('./grep_engine');
const {
  normalizeCorpusConfig,
  buildTools,
  buildSystemPrompt,
  buildUserMessage,
} = require('./prompt_builder');

function resolveCorpusFiles(corpusDir) {
  const idxCandidates = ['tree_index.json', 'full_tree_index.json'].map((f) => path.join(corpusDir, f));
  const txtCandidates = ['tree_texts.json', 'full_tree_texts.json'].map((f) => path.join(corpusDir, f));
  const indexPath = idxCandidates.find((p) => fs.existsSync(p)) || null;
  const textsPath = txtCandidates.find((p) => fs.existsSync(p)) || null;
  const graphPath = ['graph.json', 'graph-compact.json']
    .map((f) => path.join(corpusDir, f))
    .find((p) => fs.existsSync(p)) || null;
  return { indexPath, textsPath, graphPath };
}

function createTreeAgent({ corpusId, corpusDir, corpusConfig: rawConfig, fallbackSearchFn = null }) {
  const corpusConfig = normalizeCorpusConfig(rawConfig, corpusId);
  const { indexPath, textsPath, graphPath } = resolveCorpusFiles(corpusDir);

  if (!indexPath || !textsPath) {
    console.warn(`[tree-agent:${corpusId}] tree_index.json or tree_texts.json missing in ${corpusDir}`);
    return {
      loaded: false,
      corpusId,
      corpusConfig,
      stats: { arcs: 0, scenes: 0, total_chars: 0, max_order: 0 },
      categories: [],
      seriesList: [],
      toneTags: [],
      getTreeIndex() {
        return null;
      },
      getSceneText() {
        return null;
      },
      getAliases() {
        return corpusConfig.aliases || [];
      },
      grepScenes() {
        return { took_ms: 0, total: 0, cameo_count: 0, all_matched: false, hits: [] };
      },
      async search() {
        throw new Error(`Tree index files not found for corpus "${corpusId}" in ${corpusDir}`);
      },
    };
  }

  const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const textsData = JSON.parse(fs.readFileSync(textsPath, 'utf8'));
  const graphEngine = createGraphEngine(graphPath);
  const seriesSummaries =
    indexData.series_summaries && typeof indexData.series_summaries === 'object'
      ? indexData.series_summaries
      : {};

  const arcMap = new Map();
  const sceneMetaMap = new Map();
  const searchableScenes = [];
  const categorySet = new Set();
  const toneSet = new Set();
  const seriesStatsMap = new Map();
  let maxOrderAvailable = 0;

  const effectiveSceneOrder = (sc, arc) => {
    if (sc && sc.order !== undefined && sc.order !== null && sc.order !== '') return Number(sc.order);
    if (arc && arc.order !== undefined && arc.order !== null && arc.order !== '') return Number(arc.order);
    return null;
  };

  for (const arc of indexData.arcs || []) {
    arcMap.set(arc.arc_id, arc);
    const arcSeries = String(arc.series || '').trim();
    const arcCat = String(arc.category || '').trim();
    if (arcCat) categorySet.add(arcCat);
    const arcTones = Array.isArray(arc.tone_tags) ? arc.tone_tags.map(String).filter(Boolean) : [];
    for (const t of arcTones) toneSet.add(t);
    if (arc.order !== null && arc.order !== undefined && Number.isFinite(Number(arc.order))) {
      maxOrderAvailable = Math.max(maxOrderAvailable, Number(arc.order));
    }

    const serKey = arcSeries || arcCat || '默认分卷';
    if (!seriesStatsMap.has(serKey)) {
      seriesStatsMap.set(serKey, {
        series: serKey,
        arcs: 0,
        scenes: 0,
        total_chars: 0,
        min_order: null,
        max_order: null,
        categories: new Set(),
      });
    }
    const ss = seriesStatsMap.get(serKey);
    ss.arcs += 1;
    ss.scenes += (arc.scenes || []).length;
    ss.total_chars += Number(arc.total_chars) || 0;
    if (arcCat) ss.categories.add(arcCat);
    if (arc.order !== null && arc.order !== undefined && Number.isFinite(Number(arc.order))) {
      const ord = Number(arc.order);
      ss.min_order = ss.min_order === null ? ord : Math.min(ss.min_order, ord);
      ss.max_order = ss.max_order === null ? ord : Math.max(ss.max_order, ord);
    }

    const arcMetaHay = [
      arc.title,
      arc.description,
      arcSeries,
      ...(arc.characters || []),
      ...(arc.key_items || []),
      ...arcTones,
    ]
      .join(' ')
      .toLowerCase();

    for (const sc of arc.scenes || []) {
      const scOrder = effectiveSceneOrder(sc, arc);
      if (scOrder !== null && Number.isFinite(scOrder)) {
        maxOrderAvailable = Math.max(maxOrderAvailable, scOrder);
      }
      const scTones = Array.isArray(sc.tone_tags) && sc.tone_tags.length ? sc.tone_tags.map(String).filter(Boolean) : arcTones;
      for (const t of scTones) toneSet.add(t);

      sceneMetaMap.set(sc.node_id, {
        ...sc,
        arc_id: arc.arc_id,
        arc_title: arc.title,
        arc_series: arcSeries,
        arc_category: arcCat,
        arc_characters: arc.characters || [],
        effective_order: scOrder,
        effective_tones: scTones,
      });

      const item = textsData[sc.node_id];
      if (!item) continue;
      const clean = stripMarkup(item.text);
      searchableScenes.push({
        node_id: sc.node_id,
        arc_id: arc.arc_id,
        arc_title: arc.title,
        series: arcSeries,
        category: arcCat,
        title: sc.title || sc.group_title || '',
        lowerTitle: String(sc.title || sc.group_title || '').toLowerCase(),
        order: scOrder,
        tone_tags: scTones,
        chars: clean.length,
        cleanText: clean,
        lowerText: clean.toLowerCase(),
        lines: clean
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
        metaHay: `${arcMetaHay} ${String(sc.title || '').toLowerCase()} ${String(sc.summary || '').toLowerCase()}`,
      });
    }
  }

  const totalChars = (indexData.arcs || []).reduce((acc, a) => acc + (Number(a.total_chars) || 0), 0);
  const stats = {
    arcs: arcMap.size,
    scenes: sceneMetaMap.size,
    total_chars: indexData.stats?.total_chars || totalChars,
    max_order: maxOrderAvailable,
    graph_edges: graphEngine.edgeCount,
    llm_scenes: Number(indexData.stats?.llm_scenes || 0),
    llm_arcs: Number(indexData.stats?.llm_arcs || 0),
  };
  const categories = [...categorySet];
  const toneTags = [...toneSet];
  const seriesList = [...seriesStatsMap.values()].map((s) => ({
    series: s.series,
    arcs: s.arcs,
    scenes: s.scenes,
    total_chars: s.total_chars,
    min_order: s.min_order,
    max_order: s.max_order,
    categories: [...s.categories],
    summary: String(seriesSummaries[s.series] || '').trim(),
  }));

  const grepEngine = createGrepEngine(searchableScenes, corpusConfig);
  console.log(
    `[tree-agent:${corpusId}] loaded ${stats.arcs} arcs, ${stats.scenes} scenes (${formatCharCount(stats.total_chars)}, graph=${graphEngine.edgeCount})`
  );

  function resolveMaxOrder(rawMaxOrder) {
    if (rawMaxOrder === undefined || rawMaxOrder === null || rawMaxOrder === '') {
      return corpusConfig.spoiler_gate?.enabled
        ? normalizeOrder(corpusConfig.spoiler_gate.default_max_order)
        : null;
    }
    return normalizeOrder(rawMaxOrder);
  }

  function getVisibleArcs(maxOrder) {
    const out = [];
    for (const arc of indexData.arcs || []) {
      if (!isOrderAllowed(arc.order, maxOrder)) continue;
      const rawScenes = arc.scenes || [];
      const visScenes = rawScenes.filter((s) => isOrderAllowed(effectiveSceneOrder(s, arc), maxOrder));
      if (rawScenes.length > 0 && visScenes.length === 0) continue;
      out.push({ arc, scenes: visScenes });
    }
    return out;
  }

  function computeSeriesOverview(visibleArcEntries) {
    const map = new Map();
    for (const { arc, scenes } of visibleArcEntries) {
      const ser = String(arc.series || arc.category || '默认分卷').trim();
      if (!map.has(ser)) {
        map.set(ser, {
          series: ser,
          arcs: 0,
          scenes: 0,
          total_chars: 0,
          min_order: null,
          max_order: null,
          categories: new Set(),
          characters: new Map(),
        });
      }
      const entry = map.get(ser);
      entry.arcs += 1;
      entry.scenes += scenes.length;
      entry.total_chars += scenes.reduce((acc, s) => acc + (Number(s.chars) || 0), 0) || Number(arc.total_chars) || 0;
      if (arc.category) entry.categories.add(arc.category);
      if (arc.order !== null && arc.order !== undefined && Number.isFinite(Number(arc.order))) {
        const ord = Number(arc.order);
        entry.min_order = entry.min_order === null ? ord : Math.min(entry.min_order, ord);
        entry.max_order = entry.max_order === null ? ord : Math.max(entry.max_order, ord);
      }
      for (const ch of arc.characters || []) {
        entry.characters.set(ch, (entry.characters.get(ch) || 0) + 1);
      }
    }
    return [...map.values()].map((e) => ({
      series: e.series,
      arcs: e.arcs,
      scenes: e.scenes,
      total_chars: e.total_chars,
      min_order: e.min_order,
      max_order: e.max_order,
      categories: [...e.categories],
      top_characters: [...e.characters.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((x) => x[0]),
      summary: String(seriesSummaries[e.series] || '').trim(),
    }));
  }

  function grepScenes(rawQuery, opts = {}) {
    const normalizedOpts = typeof opts === 'number' ? { limit: opts } : { ...(opts || {}) };
    normalizedOpts.maxOrder = resolveMaxOrder(normalizedOpts.maxOrder);
    return grepEngine.grepScenes(rawQuery, normalizedOpts);
  }

  async function callChat({ base, key, model, messages, tools, maxTokens = null }) {
    const url = String(base || '').replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model,
      messages,
      temperature: 0.1,
    };
    const parsedMaxTokens = Number(maxTokens);
    if (Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0) {
      body.max_tokens = Math.floor(parsedMaxTokens);
    }
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const payloadStr = JSON.stringify(body);

    const maxAttempts = 2;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
          },
          body: payloadStr,
          signal: AbortSignal.timeout(45000),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          if ([429, 502, 503, 504].includes(resp.status) && attempt + 1 < maxAttempts) {
            console.warn(`[tree-agent:${corpusId}] transient HTTP ${resp.status}, retrying in 1.5s...`);
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw new Error(`chat HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        }
        return resp.json();
      } catch (err) {
        lastErr = err;
        const isTransient =
          err?.name === 'TimeoutError' ||
          err?.name === 'AbortError' ||
          /timeout|aborted|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || ''));
        if (isTransient && attempt + 1 < maxAttempts) {
          console.warn(`[tree-agent:${corpusId}] transient error (${err.message}), retrying in 1.5s...`);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  async function execTool(name, args, state, effectiveCfg) {
    const maxOrder = state.maxOrder;
    const autoThreshold = corpusConfig.hierarchy?.auto_series_threshold || 250;

    if (name === 'list_series') {
      const kw = String(args?.keyword || '').trim().toLowerCase();
      const visible = getVisibleArcs(maxOrder);
      let items = computeSeriesOverview(visible);
      if (kw) {
        items = items.filter(
          (x) =>
            x.series.toLowerCase().includes(kw) ||
            x.categories.some((c) => c.toLowerCase().includes(kw)) ||
            x.top_characters.some((c) => c.toLowerCase().includes(kw)) ||
            String(x.summary || '').toLowerCase().includes(kw)
        );
      }
      const lines = items.map((s) => {
        const range = s.min_order !== null ? ` | 序:${s.min_order}~${s.max_order}` : '';
        const chars = s.top_characters.length ? ` | 核心人物:${s.top_characters.join(',')}` : '';
        const sumStr = s.summary ? ` | 简介:${s.summary}` : '';
        return `[${s.series}] ${s.arcs}卷 ${s.scenes}幕 (${formatCharCount(s.total_chars)})${range}${chars}${sumStr}`;
      });
      return {
        text: lines.length ? lines.join('\n') : '未匹配到任何分部',
        meta: { count: items.length, summary: `返回 ${items.length} 个分部概览` },
      };
    }

    if (name === 'list_story_arcs') {
      const ser = String(args?.series || '').trim();
      const cat = String(args?.category || '').trim();
      const ch = String(args?.character || '').trim();
      const kw = String(args?.keyword || '').trim();
      const tone = String(args?.tone || '').trim().toLowerCase();

      const visibleArcs = getVisibleArcs(maxOrder);
      const seriesOverview = computeSeriesOverview(visibleArcs);

      // 3-tier protection: fold into Level-0 series when huge unfiltered catalog
      if (!ser && !cat && !ch && !kw && !tone && visibleArcs.length > autoThreshold && seriesOverview.length >= 2) {
        const lines = [
          `[目录规模提示] 当前可见篇章共 ${visibleArcs.length} 卷，超过首轮直铺阈值 (${autoThreshold})，已自动折叠为 Level-0 分部概览。请传 series、character、keyword 或 tone 参数调用 list_story_arcs 细查，或在 Turn 2 调用 grep_scenes：`,
          ...seriesOverview.map((s) => {
            const range = s.min_order !== null ? ` | 序:${s.min_order}~${s.max_order}` : '';
            const chars = s.top_characters.length ? ` | 人物:${s.top_characters.join(',')}` : '';
            const sumStr = s.summary ? ` | 简介:${s.summary}` : '';
            return `- [${s.series}] ${s.arcs}卷 ${s.scenes}幕 (${formatCharCount(s.total_chars)})${range}${chars}${sumStr}`;
          }),
        ];
        return {
          text: lines.join('\n'),
          meta: { count: seriesOverview.length, folded: true, summary: `篇章数 ${visibleArcs.length} > ${autoThreshold}，返回 ${seriesOverview.length} 个分部概览` },
        };
      }

      const chTerms = grepEngine.expandAliases(ch);
      const kwTerms = grepEngine.expandAliases(kw);
      const arcHasTerm = (arc, visScenes, terms) =>
        terms.some((term) => {
          const low = term.toLowerCase();
          return (
            (arc.characters || []).some((c) => String(c).toLowerCase().includes(low)) ||
            String(arc.title || '').toLowerCase().includes(low) ||
            String(arc.description || '').toLowerCase().includes(low) ||
            String(arc.series || '').toLowerCase().includes(low) ||
            (arc.key_items || []).some((k) => String(k).toLowerCase().includes(low)) ||
            visScenes.some(
              (s) =>
                String(s.title || '').toLowerCase().includes(low) ||
                String(s.group_title || '').toLowerCase().includes(low) ||
                String(s.summary || '').toLowerCase().includes(low)
            )
          );
        });

      const rows = [];
      const matchedArcIds = [];

      for (const { arc, scenes: visScenes } of visibleArcs) {
        if (ser && String(arc.series || arc.category || '') !== ser && !String(arc.series || '').includes(ser)) continue;
        if (cat && arc.category !== cat) continue;
        if (tone) {
          const arcToneHit = (arc.tone_tags || []).some((t) => String(t).toLowerCase().includes(tone));
          const scToneHit = visScenes.some((s) => (s.tone_tags || []).some((t) => String(t).toLowerCase().includes(tone)));
          if (!arcToneHit && !scToneHit) continue;
        }
        if (chTerms.length && !arcHasTerm(arc, visScenes, chTerms)) continue;
        if (kwTerms.length && !arcHasTerm(arc, visScenes, kwTerms)) continue;

        matchedArcIds.push(arc.arc_id);
        state.traversal.listedArcs.add(arc.arc_id);
        const keyPreview = (arc.key_items || []).slice(0, 3).join(' / ');
        let hitSceneNote = '';
        const qTerms = kwTerms.length ? kwTerms : chTerms;
        if (qTerms.length) {
          const hitTitles = visScenes
            .filter((s) =>
              qTerms.some((t) => {
                const low = t.toLowerCase();
                return (
                  String(s.title || '').toLowerCase().includes(low) ||
                  String(s.summary || '').toLowerCase().includes(low) ||
                  String(s.group_title || '').toLowerCase().includes(low)
                );
              })
            )
            .map((s) => s.title)
            .filter(Boolean)
            .slice(0, 2);
          if (hitTitles.length) {
            hitSceneNote = ` | 命中片段:${hitTitles.join(' / ')}`;
          }
        }
        const orderStr = arc.order !== null && arc.order !== undefined ? `序${arc.order}·` : '';
        const toneStr = (arc.tone_tags || []).length ? ` | 氛围:${arc.tone_tags.slice(0, 2).join(',')}` : '';
        const keyStr = keyPreview ? ` | 节选:${keyPreview}` : '';
        rows.push(
          `[${arc.arc_id}] ${orderStr}${arc.title} | 人物:${(arc.characters || []).slice(0, 5).join(',')}${toneStr}${keyStr}${hitSceneNote} | ${String(arc.description || '').slice(0, 48)}`
        );
      }

      if (!rows.length) {
        const text = `未找到匹配(series=${ser}, category=${cat}, character=${ch}, keyword=${kw}, tone=${tone})的篇章，请更换同义词或放宽过滤条件重查，或在 Turn 2 使用 grep_scenes 扫描全库正文。`;
        return {
          text,
          meta: { count: 0, arc_ids: [], summary: '未命中任何篇章' },
        };
      }

      return {
        text: rows.join('\n'),
        meta: {
          count: matchedArcIds.length,
          arc_ids: matchedArcIds.slice(0, 30),
          summary: `返回 ${matchedArcIds.length} 个篇章 (${matchedArcIds.slice(0, 6).join(', ')}${matchedArcIds.length > 6 ? '...' : ''})`,
        },
      };
    }

    if (name === 'get_arc_scenes') {
      const rawAids = args?.arc_ids ?? args?.arc_id ?? [];
      const aids = (Array.isArray(rawAids) ? rawAids : [rawAids]).map((x) => String(x)).filter(Boolean).slice(0, 5);
      const out = [];
      let sceneCount = 0;

      for (const aid of aids) {
        const a = arcMap.get(aid);
        if (!a) {
          out.push({ arc_id: aid, error: 'not found' });
          continue;
        }
        if (!isOrderAllowed(a.order, maxOrder)) {
          out.push({ arc_id: aid, error: 'blocked by spoiler gate' });
          continue;
        }
        const visScenes = (a.scenes || []).filter((s) => isOrderAllowed(effectiveSceneOrder(s, a), maxOrder));
        if (!visScenes.length && (a.scenes || []).length > 0) {
          out.push({ arc_id: aid, error: 'blocked by spoiler gate' });
          continue;
        }
        state.traversal.expandedArcs.add(aid);
        const scenes = visScenes.map((s) => ({
          node_id: s.node_id,
          group: s.group,
          title: s.title,
          order: effectiveSceneOrder(s, a),
          tone_tags: s.tone_tags || a.tone_tags || [],
          chars: s.chars,
          summary: s.summary,
        }));
        sceneCount += scenes.length;
        out.push({
          arc_id: aid,
          series: a.series || '',
          title: a.title,
          category: a.category,
          order: a.order ?? null,
          scenes,
        });
      }

      return {
        text: JSON.stringify(out),
        meta: {
          arc_ids: aids,
          scene_count: sceneCount,
          summary: `展开 ${out.filter((x) => !x.error).length} 个篇章，共 ${sceneCount} 幕`,
        },
      };
    }

    if (name === 'read_scene') {
      const rawSids =
        args?.scene_node_ids ?? args?.node_ids ?? args?.scene_ids ?? args?.node_id ?? args?.scene_id ?? args?.id ?? [];
      const sids = (Array.isArray(rawSids) ? rawSids : [rawSids]).map((x) => String(x)).filter(Boolean).slice(0, 10);
      const out = [];
      let totalChars = 0;
      let blockedCount = 0;

      for (const sid of sids) {
        const item = textsData[sid];
        if (!item) continue;
        const sm = sceneMetaMap.get(sid) || {};
        const scOrder = sm.effective_order ?? null;
        if (!isOrderAllowed(scOrder, maxOrder)) {
          blockedCount += 1;
          out.push({ node_id: sid, error: 'blocked by spoiler gate' });
          continue;
        }
        const cleanText = stripMarkup(item.text);
        const rec = {
          node_id: sid,
          arc_id: item.arc_id,
          arc_title: item.arc_title || sm.arc_title || '',
          series: sm.arc_series || '',
          category: sm.arc_category || '',
          group: item.group,
          title: sm.title || item.group_title || '',
          order: scOrder,
          tone_tags: sm.effective_tones || [],
          chars: cleanText.length,
          characters: sm.arc_characters || [],
          text: cleanText,
        };
        state.readScenes.set(sid, rec);
        state.traversal.readScenes.add(sid);
        totalChars += cleanText.length;
        out.push({
          node_id: sid,
          arc: rec.arc_title,
          group: item.group,
          title: rec.title,
          order: scOrder,
          tone_tags: rec.tone_tags,
          text: cleanText,
        });
      }

      const okList = out.filter((x) => !x.error);
      return {
        text: JSON.stringify(out),
        meta: {
          node_ids: okList.map((x) => x.node_id),
          chars: totalChars,
          blocked: blockedCount,
          summary: `读取 ${okList.length} 幕正文 (${totalChars} 字)${blockedCount ? `，拦截 ${blockedCount} 幕超进度片段` : ''}: ${okList.map((x) => `${x.node_id}《${x.title}》`).join(', ')}`,
        },
      };
    }

    if (name === 'grep_scenes') {
      const q = String(args?.query || '').trim();
      const cat = String(args?.category || '').trim();
      const tone = String(args?.tone || '').trim();
      if (!q) {
        return { text: '未提供扫描关键词', meta: { count: 0, node_ids: [], summary: '空查询' } };
      }
      const res = grepEngine.grepScenes(q, { limit: 20, maxOrder, category: cat, tone });
      if (!res.hits.length) {
        return {
          text: `[全文扫描 ${res.took_ms}ms] 未在${maxOrder ? `当前进度(order<=${maxOrder})内的` : ''}全库正文与档案中找到 "${q}"（含别名）的字面出现记录。`,
          meta: { count: 0, took_ms: res.took_ms, node_ids: [], summary: `全文扫描 "${q}" 零命中 (${res.took_ms}ms)` },
        };
      }
      const head = `[全文扫描 ${res.took_ms}ms | 共命中 ${res.total} 幕，其中目录未标客串 ${res.cameo_count} 幕${!res.all_matched ? ' | 注：无单幕同时包含全部词，以下为单词部分命中' : ''}]`;
      const lines = res.hits.map((h) => {
        const ordTag = h.order !== null && h.order !== undefined ? `·序${h.order}` : '';
        return `- [${h.node_id}|${h.arc_id}${ordTag}] ${h.arc_title} · ${h.title}${h.cameo ? ' [目录未标·客串]' : ''} (命中${h.match_count}处)\n  上下文：${h.snippet}`;
      });
      return {
        text: [head, ...lines].join('\n'),
        meta: {
          count: res.total,
          cameo_count: res.cameo_count,
          took_ms: res.took_ms,
          node_ids: res.hits.map((h) => h.node_id),
          arc_ids: [...new Set(res.hits.map((h) => h.arc_id))],
          summary: `全文扫描 "${q}" 命中 ${res.total} 幕（客串 ${res.cameo_count} 幕，${res.took_ms}ms）`,
        },
      };
    }

    if (name === 'fallback_search') {
      const q = String(args?.query || '').trim();
      if (!q || !fallbackSearchFn) {
        return { text: '[]', meta: { count: 0, chunk_ids: [], summary: '跳过（未启用混合检索通道）' } };
      }
      const hits = await fallbackSearchFn(q, effectiveCfg);
      for (const h of hits) {
        state.fallbackHits.set(String(h.id), h);
      }
      return {
        text: JSON.stringify(hits),
        meta: {
          count: hits.length,
          chunk_ids: hits.map((h) => String(h.id)),
          summary: `混合检索 "${q}" 命中 ${hits.length} 条`,
        },
      };
    }

    return {
      text: JSON.stringify({ error: `unknown tool ${name}` }),
      meta: { error: true, summary: `未知工具 ${name}` },
    };
  }

  function buildArcOutlines(wantedArcIds, maxOrder) {
    const ids = [...new Set((wantedArcIds || []).map((x) => String(x).trim()).filter((id) => arcMap.has(id)))].slice(0, 10);
    const allowedIds = ids.filter((aid) => isOrderAllowed(arcMap.get(aid)?.order, maxOrder));
    if (!allowedIds.length) return [];
    const perArcBudget = Math.max(800, Math.floor(10000 / allowedIds.length));

    return allowedIds
      .map((aid) => {
        const arc = arcMap.get(aid);
        const scenes = (arc.scenes || []).filter((s) => isOrderAllowed(effectiveSceneOrder(s, arc), maxOrder));
        if (!scenes.length && (arc.scenes || []).length > 0) return null;
        const lines = [];
        let used = 0;
        const sumCap = scenes.length > 18 ? 70 : 120;
        for (let i = 0; i < scenes.length; i++) {
          const s = scenes[i];
          const sum = String(s.summary || '').replace(/\s+/g, ' ').trim();
          const shortSum = sum.length > sumCap ? sum.slice(0, sumCap) + '…' : sum;
          const line = `${i + 1}. [${s.node_id}] ${s.title}${shortSum ? `：${shortSum}` : ''}`;
          if (used + line.length > perArcBudget && lines.length >= 3) {
            lines.push(`…（本卷共 ${scenes.length} 幕，后续 ${scenes.length - i} 幕从略）`);
            break;
          }
          lines.push(line);
          used += line.length + 1;
        }
        return {
          arc_id: aid,
          title: arc.title,
          series: arc.series || '',
          category: arc.category,
          order: arc.order ?? null,
          description: arc.description || '',
          scene_count: scenes.length,
          total_chars: arc.total_chars || 0,
          outline_text: lines.join('\n'),
        };
      })
      .filter(Boolean);
  }

  function buildResponse({
    t0,
    turns,
    trace,
    steps,
    usage,
    prompts,
    rawAnswer,
    state,
    maxScenes,
    maxChars = 36000,
    maxOrder = null,
    pov,
    query,
  }) {
    const parsed = extractJsonObject(rawAnswer);
    const took_ms = Date.now() - t0;

    const explicitlySkipped =
      parsed?.skip === true ||
      (trace.length === 0 && /^\s*NO_RECALL\s*$/i.test(String(rawAnswer || '').trim()));

    const makeTraversal = (selectedNodes = [], rawWanted = [], selectedArcs = []) => ({
      listed_arcs: [...state.traversal.listedArcs],
      expanded_arcs: [...state.traversal.expandedArcs],
      read_scenes: [...state.traversal.readScenes],
      raw_selected_nodes: rawWanted,
      selected_nodes: selectedNodes,
      selected_arcs: selectedArcs,
      fallback_hits: [...state.fallbackHits.keys()],
    });

    if (explicitlySkipped) {
      return {
        ok: true,
        corpus_id: corpusId,
        corpus_name: corpusConfig.name,
        max_order: maxOrder,
        used_fallback: false,
        skip: true,
        reason: String(parsed?.reason || '无需或在当前语料库中未检索到对应记忆'),
        took_ms,
        turns,
        trace,
        steps,
        prompts,
        raw_answer: String(rawAnswer || ''),
        traversal: makeTraversal([], [], []),
        usage,
        timeline_note: '',
        guide: '',
        outlines: [],
        scenes: [],
        chunks: [],
        profiles: [],
        relations: [],
      };
    }

    const hydrateScene = (id) => {
      const item = textsData[id];
      if (!item) return null;
      const sm = sceneMetaMap.get(id) || {};
      const scOrder = sm.effective_order ?? null;
      if (!isOrderAllowed(scOrder, maxOrder)) return null;
      const cleanText = stripMarkup(item.text);
      return {
        node_id: id,
        arc_id: item.arc_id,
        arc_title: item.arc_title || sm.arc_title || '',
        series: sm.arc_series || '',
        category: sm.arc_category || '',
        group: item.group,
        title: sm.title || item.group_title || '',
        order: scOrder,
        tone_tags: sm.effective_tones || [],
        chars: cleanText.length,
        characters: sm.arc_characters || [],
        text: cleanText,
      };
    };

    const wantedNodes = Array.isArray(parsed?.selected_nodes) ? parsed.selected_nodes.map(String) : [];
    const orderedScenes = [];
    const pickedIds = new Set();

    for (const id of wantedNodes) {
      if (pickedIds.has(id)) continue;
      const sc = state.readScenes.get(id) || hydrateScene(id);
      if (sc && isOrderAllowed(sc.order, maxOrder)) {
        orderedScenes.push(sc);
        pickedIds.add(id);
      }
    }
    if (!wantedNodes.length) {
      for (const [id, sc] of state.readScenes.entries()) {
        if (orderedScenes.length >= maxScenes) break;
        if (!pickedIds.has(id) && isOrderAllowed(sc.order, maxOrder)) {
          orderedScenes.push(sc);
          pickedIds.add(id);
        }
      }
    }

    let charBudget = maxChars;
    const finalScenes = [];
    for (const sc of orderedScenes.slice(0, maxScenes)) {
      if (charBudget <= 400) break;
      let txt = sc.text;
      if (txt.length > charBudget) {
        const cut = txt.slice(0, charBudget);
        const lastNl = cut.lastIndexOf('\n');
        txt = (lastNl > 400 ? cut.slice(0, lastNl) : cut) + '\n…（后文略）';
      }
      charBudget -= txt.length;
      const present = pov
        ? sc.text.includes(pov) || (sc.characters || []).some((c) => c.includes(pov))
        : null;
      finalScenes.push({
        node_id: sc.node_id,
        arc_id: sc.arc_id,
        arc_title: sc.arc_title,
        series: sc.series || '',
        category: sc.category,
        group: sc.group,
        title: sc.title,
        order: sc.order ?? null,
        tone_tags: sc.tone_tags || [],
        chars: txt.length,
        present,
        text: txt,
      });
    }

    const wantedChunks = Array.isArray(parsed?.selected_chunks) ? parsed.selected_chunks.map(String) : [];
    const finalChunks = [];
    const pickedChunkIds = new Set();
    if (fallbackSearchFn) {
      for (const id of wantedChunks) {
        if (state.fallbackHits.has(id) && !pickedChunkIds.has(id)) {
          finalChunks.push(state.fallbackHits.get(id));
          pickedChunkIds.add(id);
        }
      }
      for (const [id, ch] of state.fallbackHits.entries()) {
        if (finalChunks.length >= 4) break;
        if (!pickedChunkIds.has(id)) {
          finalChunks.push(ch);
          pickedChunkIds.add(id);
        }
      }
    }

    const guide =
      parsed && typeof parsed.guide === 'string'
        ? parsed.guide.trim()
        : String(rawAnswer || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, 600);
    const timeline_note =
      parsed && typeof parsed.timeline_note === 'string' ? parsed.timeline_note.trim() : '';
    const outlines = buildArcOutlines(Array.isArray(parsed?.selected_arcs) ? parsed.selected_arcs : [], maxOrder);
    const usedFallback = finalChunks.length > 0 || state.fallbackHits.size > 0;

    if (!finalScenes.length && !finalChunks.length && !outlines.length && !guide) {
      return {
        ok: true,
        corpus_id: corpusId,
        corpus_name: corpusConfig.name,
        max_order: maxOrder,
        used_fallback: usedFallback,
        skip: true,
        reason: '未在当前语料库与允许进度范围内检索到可直接对应的过往片段',
        took_ms,
        turns,
        trace,
        steps,
        prompts,
        raw_answer: String(rawAnswer || ''),
        traversal: makeTraversal([], wantedNodes, []),
        usage,
        timeline_note: '',
        guide: '',
        outlines: [],
        scenes: [],
        chunks: [],
        profiles: [],
        relations: [],
      };
    }

    const graphQuery = [
      query || '',
      guide,
      ...outlines.map((o) => o.title),
      ...finalScenes.map((s) => `${s.arc_title} ${s.title}`),
    ].join(' ');

    return {
      ok: true,
      corpus_id: corpusId,
      corpus_name: corpusConfig.name,
      max_order: maxOrder,
      used_fallback: usedFallback,
      skip: false,
      reason: '',
      took_ms,
      turns,
      trace,
      steps,
      prompts,
      raw_answer: String(rawAnswer || ''),
      traversal: makeTraversal(
        finalScenes.map((s) => s.node_id),
        wantedNodes,
        outlines.map((o) => o.arc_id)
      ),
      usage,
      timeline_note,
      guide,
      outlines,
      scenes: finalScenes,
      chunks: finalChunks,
      profiles: [],
      relations: graphEngine.lookup(graphQuery),
    };
  }

  async function search(payload, effectiveCfg) {
    const t0 = Date.now();
    const query = String(payload.query || '').trim();
    const onDemand = String(payload.onDemand || '').trim();
    const recentChat = Array.isArray(payload.recentChat) ? payload.recentChat : [];
    const sceneAnchor = payload.sceneAnchor || {};
    const activeStateHints = String(payload.activeStateHints || '').trim();
    const pov = String(sceneAnchor.pov || payload.pov || '').trim();
    const maxTurns = Math.min(Math.max(Number(payload.maxTurns) || 8, 2), 12);
    const rawMaxScenes = payload.maxScenes;
    const maxScenes =
      rawMaxScenes === undefined || rawMaxScenes === null || Number(rawMaxScenes) === 0
        ? 10
        : Math.min(Math.max(Math.round(Number(rawMaxScenes)) || 10, 1), 12);
    const maxChars = Math.min(Math.max(Math.round(Number(payload.maxChars)) || 36000, 8000), 60000);
    const maxOrder = resolveMaxOrder(payload.maxOrder);

    if (!query && !onDemand && !recentChat.length) {
      throw new Error('empty query and recentChat');
    }
    if (!effectiveCfg?.chatBase || !effectiveCfg?.chatKey) {
      throw new Error('chatBase or chatKey not configured');
    }

    const visibleArcs = getVisibleArcs(maxOrder);
    const hasFallback = typeof fallbackSearchFn === 'function';
    const hasSeriesTool = seriesList.length >= 2;
    const tools = buildTools({
      corpusConfig,
      stats,
      categories,
      seriesList,
      toneTags,
      hasSeriesTool,
      hasFallback,
    });

    const sysPrompt = buildSystemPrompt({
      corpusConfig,
      stats,
      categories,
      seriesList,
      toneTags,
      onDemand: Boolean(onDemand),
      maxScenes,
      maxChars,
      maxOrder,
      hasSeriesTool,
      hasFallback,
      visibleArcsCount: visibleArcs.length,
    });

    const userPrompt = buildUserMessage({
      query,
      recentChat,
      sceneAnchor: { ...sceneAnchor, pov },
      activeStateHints,
      onDemand,
      corpusConfig,
      maxOrder,
    });

    const messages = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ];

    const state = {
      maxOrder,
      readScenes: new Map(),
      fallbackHits: new Map(),
      traversal: {
        listedArcs: new Set(),
        expandedArcs: new Set(),
        readScenes: new Set(),
      },
    };
    const trace = [];
    const steps = [];
    const usage = { prompt: 0, completion: 0 };

    for (let turn = 1; turn <= maxTurns; turn++) {
      const tReq = Date.now();
      const resp = await callChat({
        base: effectiveCfg.chatBase,
        key: effectiveCfg.chatKey,
        model: effectiveCfg.chatModel,
        messages,
        tools: turn < maxTurns ? tools : undefined,
        maxTokens: effectiveCfg.maxTokens,
      });
      const reqMs = Date.now() - tReq;
      const u = resp.usage || {};
      usage.prompt += u.prompt_tokens || 0;
      usage.completion += u.completion_tokens || 0;

      const msg = resp?.choices?.[0]?.message;
      if (!msg) throw new Error('empty LLM choice');
      messages.push(msg);
      const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim();

      const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!tcs.length) {
        steps.push({
          turn,
          kind: 'final',
          llm_ms: reqMs,
          tool_ms: 0,
          usage: { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0 },
          reasoning,
          calls: [],
        });
        return buildResponse({
          t0,
          turns: turn,
          trace,
          steps,
          usage,
          prompts: { system: sysPrompt, user: userPrompt },
          rawAnswer: msg.content || '',
          state,
          maxScenes,
          maxChars,
          maxOrder,
          pov,
          query: onDemand || query,
        });
      }

      const tTool0 = Date.now();
      const callsLog = [];
      const stepCalls = [];
      for (const tc of tcs) {
        const fnName = tc?.function?.name || '';
        let args = {};
        try {
          args = JSON.parse(tc?.function?.arguments || '{}');
        } catch (_) {}
        callsLog.push(`${fnName}(${JSON.stringify(args)})`);
        const res = await execTool(fnName, args, state, effectiveCfg);
        const toolResult = typeof res === 'string' ? res : res.text;
        const meta = typeof res === 'object' && res ? res.meta || {} : {};
        stepCalls.push({
          name: fnName,
          args,
          summary: meta.summary || `${toolResult.length} chars`,
          meta,
          result_chars: toolResult.length,
          result_preview: toolResult.slice(0, 1200),
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
      const toolMs = Date.now() - tTool0;
      trace.push(`T${turn}(llm=${reqMs}ms, tool=${toolMs}ms): ${callsLog.join(' ; ')}`);
      steps.push({
        turn,
        kind: 'tools',
        llm_ms: reqMs,
        tool_ms: toolMs,
        usage: { prompt: u.prompt_tokens || 0, completion: u.completion_tokens || 0 },
        reasoning,
        calls: stepCalls,
      });
    }

    messages.push({
      role: 'user',
      content:
        '已达到最大工具轮次，请立即停止调用工具，直接输出最终严格 JSON 对象（若未查到匹配原文请输出 {"skip":true,"reason":"..."}）。',
    });
    const tFinal = Date.now();
    const finalResp = await callChat({
      base: effectiveCfg.chatBase,
      key: effectiveCfg.chatKey,
      model: effectiveCfg.chatModel,
      messages,
      tools: undefined,
      maxTokens: effectiveCfg.maxTokens,
    });
    const finalMs = Date.now() - tFinal;
    const fu = finalResp.usage || {};
    usage.prompt += fu.prompt_tokens || 0;
    usage.completion += fu.completion_tokens || 0;
    const fMsg = finalResp?.choices?.[0]?.message;
    const fReasoning = String(fMsg?.reasoning_content || fMsg?.reasoning || '').trim();
    steps.push({
      turn: maxTurns + 1,
      kind: 'final_forced',
      llm_ms: finalMs,
      tool_ms: 0,
      usage: { prompt: fu.prompt_tokens || 0, completion: fu.completion_tokens || 0 },
      reasoning: fReasoning,
      calls: [],
    });

    return buildResponse({
      t0,
      turns: maxTurns + 1,
      trace,
      steps,
      usage,
      prompts: { system: sysPrompt, user: userPrompt },
      rawAnswer: fMsg?.content || '',
      state,
      maxScenes,
      maxChars,
      maxOrder,
      pov,
      query: onDemand || query,
    });
  }

  return {
    loaded: true,
    corpusId,
    corpusConfig,
    stats,
    categories,
    seriesList,
    toneTags,
    getTreeIndex({ maxOrder: rawMaxOrder } = {}) {
      const maxOrder = resolveMaxOrder(rawMaxOrder);
      const visible = getVisibleArcs(maxOrder);
      const arcs = visible.map(({ arc, scenes }) => ({
        ...arc,
        scenes,
      }));
      const visScenesCount = arcs.reduce((acc, a) => acc + (a.scenes || []).length, 0);
      const visChars = arcs.reduce(
        (acc, a) => acc + (a.scenes || []).reduce((sAcc, s) => sAcc + (Number(s.chars) || 0), 0),
        0
      );
      return {
        corpus_id: corpusId,
        corpus_name: corpusConfig.name,
        version: indexData.version || 2,
        source: indexData.source || '',
        built_at: indexData.built_at || '',
        max_order: maxOrder,
        stats:
          maxOrder !== null
            ? {
                arcs: arcs.length,
                scenes: visScenesCount,
                total_chars: visChars,
                max_order: stats.max_order,
                llm_scenes: stats.llm_scenes,
                llm_arcs: stats.llm_arcs,
              }
            : stats,
        categories,
        series: seriesList,
        series_summaries: seriesSummaries,
        tone_tags: toneTags,
        arcs,
        aliases: corpusConfig.aliases || [],
        corpus: {
          id: corpusId,
          name: corpusConfig.name,
          description: corpusConfig.description,
          spoiler_gate: corpusConfig.spoiler_gate,
          ui: corpusConfig.ui,
        },
      };
    },
    getSceneText(nodeId, { maxOrder: rawMaxOrder } = {}) {
      const id = String(nodeId || '').trim();
      const item = textsData[id];
      if (!item) return null;
      const sm = sceneMetaMap.get(id) || {};
      const arc = arcMap.get(item.arc_id) || {};
      const scOrder = sm.effective_order ?? null;
      const maxOrder = resolveMaxOrder(rawMaxOrder);
      if (!isOrderAllowed(scOrder, maxOrder)) {
        return { blocked: true, order: scOrder, max_order: maxOrder };
      }
      const clean = stripMarkup(item.text);
      return {
        node_id: id,
        arc_id: item.arc_id,
        arc_title: item.arc_title || arc.title || '',
        series: sm.arc_series || arc.series || '',
        category: sm.arc_category || arc.category || '',
        group: item.group,
        group_title: item.group_title || sm.group_title || '',
        title: sm.title || item.group_title || '',
        order: scOrder,
        tone_tags: sm.effective_tones || [],
        summary: sm.summary || '',
        chars: clean.length,
        characters: sm.arc_characters || arc.characters || [],
        text: clean,
      };
    },
    getAliases() {
      return corpusConfig.aliases || [];
    },
    grepScenes,
    search,
  };
}

module.exports = { createTreeAgent, resolveCorpusFiles };
