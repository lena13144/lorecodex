#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCorpusManager } = require('./corpus_manager');
const { detectPythonBin, formatCharCount } = require('./utils');

const ROOT_DIR = path.resolve(__dirname, '..');
const CFG_FILE = path.join(ROOT_DIR, 'config.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpora-dir' && argv[i + 1]) out.corporaDir = path.resolve(argv[++i]);
    else if (a === '--corpus' && argv[i + 1]) out.defaultCorpus = String(argv[++i]);
    else if (a === '--config' && argv[i + 1]) out.configFile = path.resolve(argv[++i]);
  }
  return out;
}

const cli = parseArgs(process.argv);
const CORPORA_DIR = cli.corporaDir || path.resolve(process.env.CORPORA_DIR || path.join(ROOT_DIR, 'corpora'));
const CONFIG_PATH = cli.configFile || CFG_FILE;

function loadRuntimeConfig() {
  const base = {
    defaultCorpus: 'demo-chronicles',
    chatBase: process.env.CHAT_BASE || 'https://api.openai.com/v1',
    chatKey: process.env.CHAT_KEY || '',
    chatModel: process.env.CHAT_MODEL || 'deepseek-chat',
    maxTokens: process.env.CHAT_MAX_TOKENS ? Number(process.env.CHAT_MAX_TOKENS) || null : null,
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      Object.assign(base, fileCfg);
    } catch (_) {}
  }
  if (cli.defaultCorpus) base.defaultCorpus = cli.defaultCorpus;
  if (process.env.DEFAULT_CORPUS) base.defaultCorpus = process.env.DEFAULT_CORPUS;
  return base;
}

const corpusManager = createCorpusManager(CORPORA_DIR);

function resolveCorpusId(requested) {
  const req = String(requested || '').trim();
  if (req && corpusManager.hasCorpus(req)) return req;
  if (req && !corpusManager.hasCorpus(req)) {
    throw new Error(
      `Corpus "${req}" not found. Available corpora: ${corpusManager
        .listCorpora()
        .map((c) => c.id)
        .join(', ')}`
    );
  }
  const cfg = loadRuntimeConfig();
  if (corpusManager.hasCorpus(cfg.defaultCorpus)) return cfg.defaultCorpus;
  const list = corpusManager.listCorpora();
  if (list.length) return list[0].id;
  throw new Error('No corpora found in ' + CORPORA_DIR);
}

const MCP_TOOLS = [
  {
    name: 'lorecodex_list_corpora',
    description:
      'List all mounted LoreCodex corpora (novels, worldbooks, game lore archives) with their 3-tier hierarchy statistics (volumes/series, chapters/arcs, scenes, total characters, and spoiler-gate max_order). Call this first to discover available corpus IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        reload: {
          type: 'boolean',
          description: 'If true, rescan the corpora directory on disk before listing.',
        },
      },
      required: [],
    },
  },
  {
    name: 'lorecodex_list_series',
    description:
      'List Level-0 volume / series overview of a corpus, including chapter counts, order ranges, top recurring characters, and LLM-distilled volume summaries. Ideal as the first step for large novels or multi-part game archives.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        keyword: { type: 'string', description: 'Optional keyword to filter series by name, character, or summary' },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling (only show chapters <= max_order)' },
      },
      required: [],
    },
  },
  {
    name: 'lorecodex_list_arcs',
    description:
      'List Level-1 story arcs / chapters in the corpus catalog. Supports filtering by series (volume), category, character (automatically expands character aliases), keyword, tone tag, and spoiler-gate max_order.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        series: { type: 'string', description: 'Optional volume / series name filter' },
        category: { type: 'string', description: 'Optional category filter' },
        character: { type: 'string', description: 'Optional character / entity name (auto-expands aliases)' },
        keyword: { type: 'string', description: 'Optional keyword matching chapter title, description, key_items, or scene summaries' },
        tone: { type: 'string', description: 'Optional tone tag filter' },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling' },
      },
      required: [],
    },
  },
  {
    name: 'lorecodex_expand_arc',
    description:
      'Expand 1 to 10 story arcs (chapters) into their Level-2 scene catalog (node_id, title, order, tone_tags, character count, and scene summary) without loading raw scene prose.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        arc_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of arc_id strings to expand (up to 10, e.g. ["0001", "0002"])',
        },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling' },
      },
      required: ['arc_ids'],
    },
  },
  {
    name: 'lorecodex_grep_scenes',
    description:
      'Millisecond in-RAM full-text alias & cameo scanner across all scenes in the corpus. Automatically expands character aliases, detects unindexed cameo appearances, supports multi-term co-occurrence (space-separated terms), and returns surrounding dialogue snippets with node_id and arc_id.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        query: {
          type: 'string',
          description: 'Search query: character name/alias, exact quote, or space-separated co-occurring keywords',
        },
        category: { type: 'string', description: 'Optional category filter' },
        tone: { type: 'string', description: 'Optional tone tag filter' },
        limit: { type: 'number', description: 'Max hits to return (default 20, max 60)' },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lorecodex_read_scenes',
    description:
      'Batch read the full, lossless Level-3 original text of 1 to 10 scene nodes by node_id. Use this after locating candidate scenes via lorecodex_expand_arc or lorecodex_grep_scenes.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        scene_node_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of scene node_id strings to read (max 10 per call, e.g. ["0001", "0002"])',
        },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling' },
      },
      required: ['scene_node_ids'],
    },
  },
  {
    name: 'lorecodex_ask_agent',
    description:
      'Delegate a complex lore or plot question to LoreCodex’s autonomous multi-turn Tree Agent. The sidecar agent flips through the 3-tier tree and full-text grep in its own isolated context and returns a distilled memory guide, macro arc outlines, and verified scene quotes. Requires chatBase/chatKey configured in config.json or environment variables.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: { type: 'string', description: 'Corpus ID (omit to use default corpus)' },
        query: { type: 'string', description: 'Question, plot topic, or macro timeline query to investigate' },
        max_order: { type: 'number', description: 'Optional spoiler-gate order ceiling' },
        max_scenes: { type: 'number', description: 'Max verified scenes to return (0 = auto up to 10)' },
        pov: { type: 'string', description: 'Optional POV character name (marks scenes where POV character was absent)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'lorecodex_build_corpus',
    description:
      'Build a new 3-tier LoreCodex corpus from a local novel (.txt, .md, .epub) or SillyTavern worldbook / character card V2 (.json, .jsonl), or run an in-place LLM summary upgrade on an existing corpus, then hot-reload the server.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['build_novel', 'build_lore', 'upgrade'],
          description: 'Action: "build_novel" (.txt/.md/.epub), "build_lore" (.json/.jsonl worldbook/card), or "upgrade" (in-place LLM summary & alias synthesis)',
        },
        corpus_id: { type: 'string', description: 'Target corpus ID (alphanumeric/hyphens, e.g. "my-novel")' },
        input_path: { type: 'string', description: 'Absolute path to source file (required for build_novel / build_lore)' },
        name: { type: 'string', description: 'Display name of the work' },
        merge_into: { type: 'string', description: 'For build_lore: optional existing corpus_id to merge lore entries into' },
        use_llm: { type: 'boolean', description: 'For build_novel/build_lore: whether to run LLM summarization during build (default false = instant heuristic build)' },
        series: { type: 'string', description: 'For upgrade: optional volume/series name to upgrade selectively' },
        limit_arcs: { type: 'number', description: 'For upgrade: optional max number of chapters to upgrade in this batch' },
      },
      required: ['action', 'corpus_id'],
    },
  },
];

async function handleToolCall(name, args = {}) {
  if (name === 'lorecodex_list_corpora') {
    if (args.reload) corpusManager.reload();
    const list = corpusManager.listCorpora();
    const cfg = loadRuntimeConfig();
    const defId = corpusManager.hasCorpus(cfg.defaultCorpus) ? cfg.defaultCorpus : list[0]?.id || '';
    const lines = [
      `LoreCodex Mounted Corpora (${list.length} total, default="${defId}"):`,
      ...list.map(
        (c) =>
          `- [${c.id}] 《${c.name}》: ${c.stats.arcs} arcs, ${c.stats.scenes} scenes, ${formatCharCount(
            c.stats.total_chars
          )}${c.stats.max_order ? `, max_order=${c.stats.max_order}` : ''}${
            c.series?.length ? ` | series(${c.series.length}): ${c.series.slice(0, 8).join(', ')}` : ''
          }`
      ),
    ];
    return lines.join('\n');
  }

  if (name === 'lorecodex_list_series') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const idx = agent.getTreeIndex({ maxOrder: args.max_order });
    const kw = String(args.keyword || '').trim().toLowerCase();
    const seriesMap = new Map();
    for (const a of idx.arcs || []) {
      const sk = String(a.series || a.category || '默认分卷').trim();
      if (!seriesMap.has(sk)) {
        seriesMap.set(sk, { series: sk, arcs: 0, scenes: 0, chars: 0, minOrder: null, maxOrder: null, charsCount: new Map() });
      }
      const st = seriesMap.get(sk);
      st.arcs += 1;
      st.scenes += (a.scenes || []).length;
      st.chars += Number(a.total_chars) || 0;
      if (a.order != null) {
        st.minOrder = st.minOrder === null ? a.order : Math.min(st.minOrder, a.order);
        st.maxOrder = st.maxOrder === null ? a.order : Math.max(st.maxOrder, a.order);
      }
      for (const ch of a.characters || []) st.charsCount.set(ch, (st.charsCount.get(ch) || 0) + 1);
    }
    let list = [...seriesMap.values()].map((s) => {
      const topChars = [...s.charsCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((x) => x[0]);
      const summary = String(idx.series_summaries?.[s.series] || '').trim();
      return { ...s, topChars, summary };
    });
    if (kw) {
      list = list.filter(
        (s) =>
          s.series.toLowerCase().includes(kw) ||
          s.summary.toLowerCase().includes(kw) ||
          s.topChars.some((c) => c.toLowerCase().includes(kw))
      );
    }
    const lines = [
      `[${cid}] 《${idx.corpus_name}》 Level-0 Series Overview (${list.length} series):`,
      ...list.map((s) => {
        const ord = s.minOrder !== null ? ` | order:${s.minOrder}~${s.maxOrder}` : '';
        const tc = s.topChars.length ? ` | cast:${s.topChars.join(',')}` : '';
        const sum = s.summary ? ` | summary:${s.summary}` : '';
        return `- [${s.series}] ${s.arcs} arcs, ${s.scenes} scenes (${formatCharCount(s.chars)})${ord}${tc}${sum}`;
      }),
    ];
    return lines.join('\n');
  }

  if (name === 'lorecodex_list_arcs') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const idx = agent.getTreeIndex({ maxOrder: args.max_order });
    const ser = String(args.series || '').trim().toLowerCase();
    const cat = String(args.category || '').trim().toLowerCase();
    const ch = String(args.character || '').trim().toLowerCase();
    const kw = String(args.keyword || '').trim().toLowerCase();
    const tone = String(args.tone || '').trim().toLowerCase();

    const expandTerms = (term) => {
      if (!term) return [];
      const out = new Set([term]);
      for (const grp of idx.aliases || []) {
        if (grp.some((g) => g.toLowerCase() === term || g.toLowerCase().includes(term) || term.includes(g.toLowerCase()))) {
          for (const g of grp) out.add(g.toLowerCase());
        }
      }
      return [...out];
    };
    const charTerms = expandTerms(ch);
    const kwTerms = expandTerms(kw);

    const matched = (idx.arcs || []).filter((a) => {
      if (ser && !String(a.series || a.category || '').toLowerCase().includes(ser)) return false;
      if (cat && !String(a.category || '').toLowerCase().includes(cat)) return false;
      if (tone) {
        const hitTone =
          (a.tone_tags || []).some((t) => String(t).toLowerCase().includes(tone)) ||
          (a.scenes || []).some((s) => (s.tone_tags || []).some((t) => String(t).toLowerCase().includes(tone)));
        if (!hitTone) return false;
      }
      const hay = [
        a.arc_id,
        a.title,
        a.series,
        a.category,
        a.description,
        ...(a.characters || []),
        ...(a.key_items || []),
        ...(a.scenes || []).flatMap((s) => [s.title, s.summary]),
      ]
        .join(' ')
        .toLowerCase();
      if (charTerms.length && !charTerms.some((t) => hay.includes(t))) return false;
      if (kwTerms.length && !kwTerms.some((t) => hay.includes(t))) return false;
      return true;
    });

    const shown = matched.slice(0, 80);
    const lines = [
      `[${cid}] Matched ${matched.length} arcs${matched.length > shown.length ? ` (showing first ${shown.length})` : ''}:`,
      ...shown.map((a) => {
        const ord = a.order != null ? ` | order:${a.order}` : '';
        const serTag = a.series ? `${a.series}·` : '';
        const cast = (a.characters || []).length ? ` | cast:${a.characters.slice(0, 8).join(',')}` : '';
        return `- [arc_id=${a.arc_id}] (${serTag}${a.category}${ord}) 《${a.title}》 (${(a.scenes || []).length} scenes, ${a.total_chars} chars)${cast}\n  desc: ${a.description || '-'}`;
      }),
    ];
    return lines.join('\n');
  }

  if (name === 'lorecodex_expand_arc') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const idx = agent.getTreeIndex({ maxOrder: args.max_order });
    const arcMap = new Map((idx.arcs || []).map((a) => [String(a.arc_id), a]));
    const wanted = (Array.isArray(args.arc_ids) ? args.arc_ids : []).map((x) => String(x).trim()).slice(0, 10);
    const blocks = [];
    for (const aid of wanted) {
      const a = arcMap.get(aid);
      if (!a) {
        blocks.push(`[arc_id=${aid}] not found or blocked by max_order`);
        continue;
      }
      const scLines = (a.scenes || []).map(
        (s) =>
          `  * [node_id=${s.node_id}] (${s.chars} chars${s.order != null ? `, order=${s.order}` : ''}${
            (s.tone_tags || []).length ? `, tone=${s.tone_tags.join('/')}` : ''
          }) 《${s.title || s.group_title}》: ${s.summary || ''}`
      );
      blocks.push(
        `[arc_id=${a.arc_id}] 《${a.title}》 (${a.series ? a.series + ' · ' : ''}${a.category}, ${(a.scenes || []).length} scenes):\n  desc: ${
          a.description || ''
        }\n${scLines.join('\n')}`
      );
    }
    return blocks.join('\n\n') || 'No arc_ids provided.';
  }

  if (name === 'lorecodex_grep_scenes') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 60);
    const res = agent.grepScenes(String(args.query || ''), {
      limit,
      category: args.category || '',
      tone: args.tone || '',
      maxOrder: args.max_order,
    });
    if (!res.hits.length) {
      return `[${cid}] Full-text grep (${res.took_ms}ms): 0 hits for "${args.query}"`;
    }
    const head = `[${cid}] Full-text grep (${res.took_ms}ms): ${res.total} scenes matched (${res.cameo_count} cameo scenes)${
      !res.all_matched ? ' [partial token match]' : ''
    }`;
    const rows = res.hits.map(
      (h) =>
        `- [node_id=${h.node_id} | arc_id=${h.arc_id}${h.order != null ? ` | order=${h.order}` : ''}] ${h.arc_title} · 《${h.title}》${
          h.cameo ? ' [CAMEO]' : ''
        } (${h.match_count} matches, ${h.chars} chars)\n  snippet: ${h.snippet}`
    );
    return [head, ...rows].join('\n');
  }

  if (name === 'lorecodex_read_scenes') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const ids = (Array.isArray(args.scene_node_ids) ? args.scene_node_ids : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 10);
    const blocks = [];
    for (const nid of ids) {
      const sc = agent.getSceneText(nid, { maxOrder: args.max_order });
      if (!sc) {
        blocks.push(`[node_id=${nid}] not found`);
      } else if (sc.blocked) {
        blocks.push(`[node_id=${nid}] blocked by spoiler gate (order=${sc.order} > max_order=${sc.max_order})`);
      } else {
        blocks.push(
          `=== [node_id=${sc.node_id} | arc_id=${sc.arc_id}] ${sc.arc_title} (${sc.category}${
            sc.order != null ? ` · order=${sc.order}` : ''
          }) · 《${sc.title}》 (${sc.chars} chars) ===\n${sc.text}`
        );
      }
    }
    return blocks.join('\n\n') || 'No scene_node_ids provided.';
  }

  if (name === 'lorecodex_ask_agent') {
    const cid = resolveCorpusId(args.corpus);
    const agent = corpusManager.getAgent(cid);
    const cfg = loadRuntimeConfig();
    if (!cfg.chatBase || !cfg.chatKey) {
      throw new Error(
        'chatBase or chatKey is not configured in config.json / environment. Use atomic tools (lorecodex_list_series, lorecodex_grep_scenes, lorecodex_read_scenes) directly, or configure config.json.'
      );
    }
    const out = await agent.search(
      {
        corpus: cid,
        query: String(args.query || ''),
        onDemand: String(args.query || ''),
        maxOrder: args.max_order,
        maxScenes: Number(args.max_scenes) || 0,
        pov: args.pov || '',
      },
      cfg
    );
    const parts = [
      `[${out.corpus_name || cid}] Sidecar Agent completed in ${out.took_ms}ms (${out.turns} turns, skip=${out.skip})`,
    ];
    if (out.timeline_note) parts.push(`Timeline: ${out.timeline_note}`);
    if (out.guide) parts.push(`\n【Distilled Guide】\n${out.guide}`);
    if (out.outlines?.length) {
      parts.push(
        `\n【Selected Arc Outlines (${out.outlines.length})】\n` +
          out.outlines.map((o) => `《${o.title} [${o.arc_id}]》\n${o.outline_text}`).join('\n\n')
      );
    }
    if (out.scenes?.length) {
      parts.push(
        `\n【Verified Original Scenes (${out.scenes.length})】\n` +
          out.scenes
            .map((s) => `=== [node:${s.node_id} | arc:${s.arc_id}] ${s.arc_title} · ${s.title} (${s.chars} chars) ===\n${s.text}`)
            .join('\n\n')
      );
    }
    return parts.join('\n');
  }

  if (name === 'lorecodex_build_corpus') {
    const action = String(args.action || 'build_novel').trim();
    const corpusId = String(args.corpus_id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(corpusId)) {
      throw new Error('corpus_id must be 1-48 alphanumeric, underscore, or hyphen characters');
    }
    const pyBin = detectPythonBin();
    if (action === 'upgrade') {
      const pyArgs = [
        path.join(ROOT_DIR, 'builders', 'build_novel.py'),
        '--upgrade',
        '--corpus-id',
        corpusId,
        '--out-dir',
        CORPORA_DIR,
        '--config',
        CONFIG_PATH,
      ];
      if (args.series) pyArgs.push('--series', String(args.series));
      if (Number(args.limit_arcs) > 0) pyArgs.push('--limit-arcs', String(Number(args.limit_arcs)));
      const stdout = execFileSync(pyBin, pyArgs, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      corpusManager.reload();
      return `Upgraded and reloaded corpus "${corpusId}":\n${stdout.trim()}`;
    }

    const inputPath = path.resolve(String(args.input_path || ''));
    if (!args.input_path || !fs.existsSync(inputPath)) {
      throw new Error(`input_path does not exist: ${inputPath}`);
    }
    if (action === 'build_lore') {
      const pyArgs = [
        path.join(ROOT_DIR, 'builders', 'build_lore.py'),
        '--input',
        inputPath,
        '--corpus-id',
        corpusId,
        '--out-dir',
        CORPORA_DIR,
        '--filter-game-stats',
      ];
      if (args.name) pyArgs.push('--name', String(args.name));
      if (args.merge_into) pyArgs.push('--merge-into', path.join(CORPORA_DIR, String(args.merge_into)));
      if (!args.use_llm) pyArgs.push('--no-llm');
      const stdout = execFileSync(pyBin, pyArgs, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      corpusManager.reload();
      return `Built lore corpus "${args.merge_into || corpusId}":\n${stdout.trim()}`;
    }

    const pyArgs = [
      path.join(ROOT_DIR, 'builders', 'build_novel.py'),
      '--input',
      inputPath,
      '--corpus-id',
      corpusId,
      '--name',
      String(args.name || corpusId),
      '--out-dir',
      CORPORA_DIR,
      '--config',
      CONFIG_PATH,
    ];
    if (!args.use_llm) pyArgs.push('--no-llm');
    const stdout = execFileSync(pyBin, pyArgs, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    corpusManager.reload();
    return `Built novel corpus "${corpusId}":\n${stdout.trim()}`;
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

let useHeaderFraming = false;

function sendRpcMessage(obj) {
  const json = JSON.stringify(obj);
  if (useHeaderFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function handleRpcRequest(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const clientProto = params?.protocolVersion || '2024-11-05';
      return sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientProto,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'lorecodex-mcp',
            version: '2.0.0',
          },
        },
      });
    }

    if (method === 'ping') {
      return sendRpcMessage({ jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      return sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name || '';
      const toolArgs = params?.arguments || {};
      try {
        const text = await handleToolCall(toolName, toolArgs);
        return sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(text) }],
            isError: false,
          },
        });
      } catch (toolErr) {
        return sendRpcMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${toolErr.message}` }],
            isError: true,
          },
        });
      }
    }

    if (method === 'resources/list') {
      return sendRpcMessage({ jsonrpc: '2.0', id, result: { resources: [] } });
    }

    if (method === 'prompts/list') {
      return sendRpcMessage({ jsonrpc: '2.0', id, result: { prompts: [] } });
    }

    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  } catch (err) {
    return sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err.message || 'Internal error',
      },
    });
  }
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

  while (inputBuffer.length > 0) {
    const preview = inputBuffer.slice(0, Math.min(inputBuffer.length, 64)).toString('utf8');
    if (/^Content-Length:/i.test(preview)) {
      useHeaderFraming = true;
      const sepIdx = inputBuffer.indexOf('\r\n\r\n');
      const altSepIdx = inputBuffer.indexOf('\n\n');
      const headerEnd = sepIdx >= 0 ? sepIdx : altSepIdx;
      const sepLen = sepIdx >= 0 ? 4 : 2;
      if (headerEnd < 0) break;

      const headerStr = inputBuffer.slice(0, headerEnd).toString('utf8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.slice(headerEnd + sepLen);
        continue;
      }
      const bodyLen = Number(match[1]);
      const totalLen = headerEnd + sepLen + bodyLen;
      if (inputBuffer.length < totalLen) break;

      const bodyStr = inputBuffer.slice(headerEnd + sepLen, totalLen).toString('utf8');
      inputBuffer = inputBuffer.slice(totalLen);
      try {
        const parsed = JSON.parse(bodyStr);
        handleRpcRequest(parsed);
      } catch (_) {}
    } else {
      const nlIdx = inputBuffer.indexOf('\n');
      if (nlIdx < 0) break;
      const line = inputBuffer.slice(0, nlIdx).toString('utf8').trim();
      inputBuffer = inputBuffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        handleRpcRequest(parsed);
      } catch (_) {}
    }
  }
});
