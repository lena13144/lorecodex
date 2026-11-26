'use strict';

const { compilePatterns, normalizeOrder, formatCharCount } = require('./utils');

const DEFAULT_STAGE_PATTERNS = [
  '(?:世界|城市|模拟器|舞台|总览|合集|世界书|沙盒|sandbox|world|city|simulator)',
];

function normalizeCorpusConfig(raw, corpusId) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const name = String(cfg.name || corpusId || 'LoreCodex').trim();
  const pf = cfg.prompt_framing && typeof cfg.prompt_framing === 'object' ? cfg.prompt_framing : {};
  const sg = cfg.spoiler_gate && typeof cfg.spoiler_gate === 'object' ? cfg.spoiler_gate : {};
  const ug = cfg.user_identity_guard && typeof cfg.user_identity_guard === 'object' ? cfg.user_identity_guard : {};
  const hier = cfg.hierarchy && typeof cfg.hierarchy === 'object' ? cfg.hierarchy : {};
  const grep = cfg.grep && typeof cfg.grep === 'object' ? cfg.grep : {};
  const ui = cfg.ui && typeof cfg.ui === 'object' ? cfg.ui : {};

  return {
    id: String(cfg.id || corpusId || 'default').trim(),
    name,
    description: String(cfg.description || '').trim(),
    language: String(cfg.language || 'zh-CN').trim(),
    world_premise:
      String(cfg.world_premise || '').trim() ||
      `当前语料库收录了《${name}》的完整故事章节与设定档案。你负责消解对话中的模糊指代（如“她/那件事/当年/那个约定/某项设定”），从目录树中定位并核实原始文本片段，供正文模型直接衔接。`,
    active_recall_triggers:
      String(cfg.active_recall_triggers || '').trim() ||
      '追忆往昔、今昔对比、角色心结暗涌、提及人物过往相处与旧事、或询问/涉及世界观设定、组织机构、器物装备与特定台词细节',
    skip_criteria:
      String(cfg.skip_criteria || '').trim() ||
      '完全属于与原著过往/世界观设定无关的纯日常琐事、普通闲聊且没有任何怀旧或设定查阅需求',
    aliases: Array.isArray(cfg.aliases) ? cfg.aliases : [],
    glossary: Array.isArray(cfg.glossary) ? cfg.glossary.map(String).filter(Boolean) : [],
    stage_card_patterns:
      Array.isArray(cfg.stage_card_patterns) && cfg.stage_card_patterns.length
        ? cfg.stage_card_patterns
        : DEFAULT_STAGE_PATTERNS,
    user_identity_guard: {
      enabled: ug.enabled !== false,
      note: String(ug.note || '用户身份（玩家本尊，严禁将其误判为同名或谐音角色去检索）').trim(),
    },
    oc_examples: Array.isArray(cfg.oc_examples) ? cfg.oc_examples.map(String).filter(Boolean) : [],
    tone_routing_hints: String(cfg.tone_routing_hints || '').trim(),
    spoiler_gate: {
      enabled: Boolean(sg.enabled),
      order_label: String(sg.order_label || '章节进度').trim(),
      default_max_order: normalizeOrder(sg.default_max_order),
    },
    hierarchy: {
      auto_series_threshold: Math.max(20, Number(hier.auto_series_threshold) || 250),
    },
    grep: {
      english_exclude_terms: Array.isArray(grep.english_exclude_terms)
        ? grep.english_exclude_terms.map(String).filter(Boolean)
        : [],
    },
    prompt_framing: {
      xml_tag: String(pf.xml_tag || 'lore_source_reference').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'lore_source_reference',
      header:
        String(pf.header || '').trim() ||
        `以下为《${name}》典籍中检索并核实的过往剧情原文与设定片段。请将其作为角色回忆、既有经历或背景常识自然融入扮演，不要机械复读旁白。`,
      priority_rule:
        String(pf.priority_rule || '').trim() ||
        '【事实优先级】若原作片段细节与当前世界书/角色卡设定或本局对话已确认的新发展存在冲突，一律以本局当前时间线为准；早期阶段片段仅作回忆对照，请留意章节与时间标记，勿误当成当下未解开的旧态度。',
    },
    ui: {
      subtitle: String(ui.subtitle || '典籍阅读与树检索工作台').trim(),
      default_char: String(ui.default_char || '').trim(),
      default_user: String(ui.default_user || '旅人').trim(),
      presets: Array.isArray(ui.presets) ? ui.presets : [],
    },
  };
}

function isStageCardName(name, corpusConfig) {
  const s = String(name || '').trim();
  if (!s) return false;
  const regexes = compilePatterns(corpusConfig?.stage_card_patterns, DEFAULT_STAGE_PATTERNS);
  return regexes.some((re) => re.test(s));
}

function buildTools({ corpusConfig, stats, categories, seriesList, toneTags, hasSeriesTool, hasFallback }) {
  const name = corpusConfig?.name || 'LoreCodex';
  const catDesc = categories.length ? categories.join(' / ') : '全部分类';
  const toneDesc = toneTags.length ? toneTags.join(' / ') : '战斗/危机 / 温情/日常 / 设定/档案 / 心理/独白 / 权谋/悬疑';
  const tools = [];

  if (hasSeriesTool) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_series',
        description: `列出 Level-0 分部总览（共 ${seriesList.length} 个分部），用于大书库先定范围。`,
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选分部/关键词过滤' },
          },
          required: [],
        },
      },
    });
  }

  const arcProps = {
    category: { type: 'string', description: `可选分类：${catDesc}` },
    character: { type: 'string', description: '可选人物名（自动展开别名）' },
    keyword: { type: 'string', description: '可选主题/组织/地点/事件词' },
    tone: { type: 'string', description: `可选氛围：${toneDesc}` },
  };
  if (seriesList.length) {
    arcProps.series = {
      type: 'string',
      description: `可选分部：${seriesList.slice(0, 12).map((s) => s.series).join(' / ')}`,
    };
  }

  tools.push({
    type: 'function',
    function: {
      name: 'list_story_arcs',
      description: '按条件列出目录树篇章；无过滤且篇章过多时自动折叠为分部概览。',
      parameters: {
        type: 'object',
        properties: arcProps,
        required: [],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'get_arc_scenes',
      description: '展开 1~5 个篇章的分幕摘要目录（不含正文）。',
      parameters: {
        type: 'object',
        properties: {
          arc_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'arc_id 列表（最多 5 个）',
          },
        },
        required: ['arc_ids'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'read_scene',
      description: '批量读取 1~10 个场景节点的完整无截断正文。',
      parameters: {
        type: 'object',
        properties: {
          scene_node_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'scene node_id 数组（1~10 个，尽量合并批量读取）',
          },
          focus_query: {
            type: 'string',
            description: '可选聚焦词（空格分隔，自动展开别名）：仅返回命中行上下文窗口',
          },
        },
        required: ['scene_node_ids'],
      },
    },
  });

  tools.push({
    type: 'function',
    function: {
      name: 'grep_scenes',
      description: '全库正文毫秒级精确扫描（自动展开别名、发现客串/原句/跨卷词条；多词空格分隔优先同幕共现）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '人名/别名、原句或空格分隔的共现词' },
          category: { type: 'string', description: `可选分类：${catDesc}` },
          tone: { type: 'string', description: `可选氛围：${toneDesc}` },
          sort_by: {
            type: 'string',
            enum: ['relevance', 'diversity', 'rarity'],
            description: 'relevance(默认) | diversity(跨进度分桶防刷屏) | rarity(低频稀有优先)',
          },
          offset: {
            type: 'integer',
            description: '分页偏移量（默认 0）',
          },
        },
        required: ['query'],
      },
    },
  });

  if (hasFallback) {
    tools.push({
      type: 'function',
      function: {
        name: 'fallback_search',
        description: '兜底检索；仅当目录与 grep 均未命中时从 Turn 2 起按需调用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词或短句' },
          },
          required: ['query'],
        },
      },
    });
  }

  return tools;
}

function buildSystemPrompt({
  corpusConfig,
  stats,
  categories,
  seriesList,
  toneTags,
  onDemand,
  maxScenes = 10,
  maxChars = null,
  maxOrder = null,
  hasSeriesTool = false,
  hasFallback = false,
  visibleArcsCount = 0,
  queryContext = '',
}) {
  const autoThreshold = corpusConfig?.hierarchy?.auto_series_threshold || 250;
  const needSeriesFirst = hasSeriesTool && visibleArcsCount > autoThreshold;

  const gateRule = onDemand
    ? '1. 跳过判定：本次为显式检索请求，必须查证并给出核实后的场景或设定节点。'
    : `1. 跳过判定：仅当对话属于【${corpusConfig.skip_criteria}】时，才直接输出 {"skip":true,"reason":"简述原因"}；涉及【${corpusConfig.active_recall_triggers}】时主动调工具查证原文。`;

  const spoilerBlock =
    maxOrder !== null
      ? `\n【防剧透锁定（${corpusConfig.spoiler_gate.order_label} <= ${maxOrder}）】工具已自动过滤超前章节，guide 与 timeline_note 严禁泄露或暗示超过 ${maxOrder} 的后续真相。\n`
      : '';

  const rawGlossary = Array.isArray(corpusConfig.glossary) ? corpusConfig.glossary : [];
  const lowCtx = String(queryContext || '').toLowerCase();
  const activeGlossary =
    rawGlossary.length > 15 && lowCtx
      ? rawGlossary
          .filter((entry) => {
            const prefix = String(entry || '').split(/[:：]/)[0].trim().toLowerCase();
            return prefix && (lowCtx.includes(prefix) || prefix.split(/[\s/／,，、()（）]+/).some((t) => t.length >= 2 && lowCtx.includes(t)));
          })
          .slice(0, 15)
      : rawGlossary;
  const glossaryBlock = activeGlossary.length
    ? `\n【编制 / 势力 / 术语速查】\n${activeGlossary.join('\n')}\n`
    : '';

  const turn1Rule = needSeriesFirst
    ? '首轮先调 `list_series` 或带过滤的 `list_story_arcs`，也可并发调用 `grep_scenes` 扫专有名词与别名'
    : '首轮可并发组合 `list_story_arcs`' +
      (hasSeriesTool ? '、`list_series`' : '') +
      ' 与 `grep_scenes`';

  const ocHint = corpusConfig.oc_examples.length
    ? `（如“${corpusConfig.oc_examples.join('”“')}”）`
    : '';

  const toneRoutingExtra = corpusConfig.tone_routing_hints
    ? `（氛围分流：${corpusConfig.tone_routing_hints}）`
    : '';

  const fallbackStep = hasFallback
    ? '；前两者未命中再用 `fallback_search` 兜底'
    : '';

  const fallbackFieldLine = hasFallback
    ? '\n  "selected_chunks": ["可选 chunk_id，否则 []"],'
    : '';

  return `你是《${corpusConfig.name}》树形记忆检索 Agent，负责核实原著文本供正文衔接（${stats.arcs} 卷 / ${stats.scenes} 幕 / ${formatCharCount(stats.total_chars)}；分类：${categories.join('、') || '通用'}${toneTags.length ? `；tone：${toneTags.join('、')}` : ''}）。
${corpusConfig.world_premise}
${spoilerBlock}${glossaryBlock}
【规则】
${gateRule}未收录原创/外部设定${ocHint}直接 skip。
2. 寻路：若【图书馆管理员笔记】与当前问题相关，首轮直接 \`read_scene\` 核实所列节点；否则${turn1Rule}${fallbackStep}。\`read_scene\` 尽量批量读（最多 10 个），\`selected_nodes\` 必须经 \`read_scene\` 核实，严禁编造。
3. 选幕（上限 ${maxScenes} 幕${maxChars ? ` / ${maxChars.toLocaleString()} 字` : ''}）：定点查证 1~3 幕（注意连读相邻幕）；宏观/群像/势力过往 4~10 幕并跨阶段全分支覆盖，宏观脉络可填 \`selected_arcs\`（1~10 个）${toneRoutingExtra}。
4. 原作未载：对话提及的往事可能来自同人、角色卡或本局经历。\`grep_scenes\` 未命中先翻相关人物目录（\`list_story_arcs\` + \`get_arc_scenes\`）一轮；仍找不到即停搜，最多再 \`read_scene\` 一次补原作人物/地点背景后输出（无背景则 skip）。\`guide\` 只写“此事原作未载”及原作能对上的部分，不否定或纠正用户。
5. 停止调工具后仅输出单个严格 JSON：
{
  "skip": false,
  "selected_nodes": ["经 read_scene 核实的 node_id"],
  "selected_arcs": ["可选宏观 arc_id，否则 []"],${fallbackFieldLine}
  "timeline_note": "时间线阶段或跨度",
  "guide": "结构化导读并标注 [node_id]",
  "memory_note": {"topic": "可选：8~24字主题（仅核实有复用价值的原文时填）", "triggers": ["3~6个角色+场景线索词"], "summary": "1句话路标"}
}`;
}

/** 本局记忆召回：数据库插件附在用户消息里的「编号(摘要)」条目，由扩展端提取后传入。 */
function normalizeSessionRecall(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  let total = 0;
  for (const item of list) {
    const line = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!line) continue;
    if (total + line.length > 1200 || out.length >= 30) break;
    out.push(line);
    total += line.length;
  }
  return out;
}

function buildUserMessage({ query, recentChat, sceneAnchor, sessionRecall, librarianHints, onDemand, corpusConfig, maxOrder }) {
  const parts = [];
  const anchorBits = [];

  if (sceneAnchor?.charName) {
    if (isStageCardName(sceneAnchor.charName, corpusConfig)) {
      anchorBits.push(
        `当前舞台/群像卡：${sceneAnchor.charName}（场景舞台名，非具体角色，严禁拿该词搜目录，请从对话正文识别出场人物）`
      );
    } else {
      anchorBits.push(`当前角色：${sceneAnchor.charName}`);
    }
  }
  if (sceneAnchor?.userName) {
    const label = corpusConfig?.user_identity_guard?.enabled
      ? '用户身份（玩家本尊，严禁当作同名或谐音角色检索）'
      : '用户身份';
    anchorBits.push(`${label}：${sceneAnchor.userName}`);
  }
  if (sceneAnchor?.pov) {
    anchorBits.push(`检索视角(POV)：${sceneAnchor.pov}`);
  }
  if (maxOrder !== null && maxOrder !== undefined) {
    anchorBits.push(`防剧透进度上限(${corpusConfig?.spoiler_gate?.order_label || 'order'} <= ${maxOrder})`);
  }

  if (anchorBits.length) {
    parts.push(`【当前对话锚点】\n${anchorBits.join(' | ')}`);
  }

  const recall = normalizeSessionRecall(sessionRecall);
  if (recall.length) {
    parts.push(`【本局记忆召回】（本局已发生的事，不是原作内容；只用于理解对话里的指代，不要据此去原作里找本局独有的事件）\n${recall.join('\n')}`);
  }

  if (librarianHints) {
    parts.push(String(librarianHints).trim());
  }

  if (Array.isArray(recentChat) && recentChat.length) {
    const lines = recentChat
      .slice(-10)
      .map((m) => {
        const who = m.name || (m.role === 'user' ? sceneAnchor?.userName || '用户' : sceneAnchor?.charName || '角色');
        const rawTxt = String(m.text || '').replace(/\s+/g, ' ').trim();
        const txt = rawTxt.length <= 3500 ? rawTxt : `${rawTxt.slice(0, 1200)} … ${rawTxt.slice(-2300)}`;
        return txt ? `[${who}]: ${txt}` : '';
      })
      .filter(Boolean);
    if (lines.length) {
      parts.push(`【最近对话流（用于消解指代与判断氛围语境）】\n${lines.join('\n')}`);
    }
  }

  if (onDemand) {
    parts.push(`【显式检索要求】\n${String(onDemand).trim()}`);
  }
  if (query) {
    parts.push(`【当前最新输入】\n${String(query).trim()}`);
  }

  parts.push('请判断是否需要检索典籍与设定；需要则按流程翻阅目录树并返回最终严格 JSON。');
  return parts.join('\n\n');
}

module.exports = {
  normalizeSessionRecall,
  normalizeCorpusConfig,
  isStageCardName,
  buildTools,
  buildSystemPrompt,
  buildUserMessage,
};
