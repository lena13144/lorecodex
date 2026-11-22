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
  const scrub = cfg.db_scrubber && typeof cfg.db_scrubber === 'object' ? cfg.db_scrubber : {};
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
      follow_up_hint:
        String(pf.follow_up_hint || '').trim() ||
        '如仍需追查其他特定过往台词或细节，可在回复末尾附带【查原文：具体问题或人物事件】。',
    },
    db_scrubber: {
      boilerplate_patterns: Array.isArray(scrub.boilerplate_patterns) ? scrub.boilerplate_patterns : [],
      summary_priority_patterns: Array.isArray(scrub.summary_priority_patterns) ? scrub.summary_priority_patterns : [],
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
        description: `列出《${name}》的 Level-0 卷宗/分部总览（共 ${seriesList.length} 个分部，${stats.arcs} 个篇章，${stats.scenes} 幕）。当篇章总数庞大或需先定大方向时，可先按分部缩小范围。`,
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
    character: { type: 'string', description: '可选人物/实体名（自动按别名表展开）' },
    keyword: { type: 'string', description: '可选主题/组织/地点/事件关键词（匹配标题、简介、key_items 与子幕摘要）' },
    tone: { type: 'string', description: `可选场景氛围标签：${toneDesc}` },
  };
  if (seriesList.length) {
    arcProps.series = {
      type: 'string',
      description: `可选分部/卷宗名：${seriesList.slice(0, 12).map((s) => s.series).join(' / ')}`,
    };
  }

  tools.push({
    type: 'function',
    function: {
      name: 'list_story_arcs',
      description: `列出《${name}》目录树篇章（共 ${stats.arcs} 卷，${stats.scenes} 幕，${formatCharCount(stats.total_chars)}）。可按 series、category、character、keyword 或 tone 过滤；若篇章过多且无过滤参数，会自动折叠返回 Level-0 分部概览。`,
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
      description: '展开 1~5 个篇章下的全部分幕目录（node_id、title、order、tone_tags、chars、summary），不含正文。',
      parameters: {
        type: 'object',
        properties: {
          arc_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '篇章 arc_id 列表（最多 5 个），例如 ["0001"]',
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
      description: '批量读取 1~10 个场景节点的完整无截断正文（推荐一次传入多个 scene_node_ids 批量核实，节省轮次）。',
      parameters: {
        type: 'object',
        properties: {
          scene_node_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'scene node_id 数组（单次最多 10 个，强烈建议将候选节点合并在一次调用中批量读取）',
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
      description: `全库 ${formatCharCount(stats.total_chars)} 正文与档案毫秒级精确扫描（自动展开人物别名）。专门解决“非主要角色在别人篇章里只客串说了几句话、目录未标出”的盲区，以及原句定位、跨卷时间线关键词（如“十年前”“解散”）、两角色同框、专有设定词条直查。多个词用空格分隔（默认优先同幕共现），支持按 category/tone 过滤，可从第一轮起随时与目录工具并发调用。`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '待扫描的人名/别名、原句片段或空格分隔的共现关键词' },
          category: { type: 'string', description: `可选限定分类：${catDesc}` },
          tone: { type: 'string', description: `可选限定氛围标签：${toneDesc}` },
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
        description: '可选混合检索兜底通道。仅当目录树与 grep_scenes 均无法定位冷门概念时从 Turn 2 起按需调用，禁止在第一轮调用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或短句' },
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
  maxChars = 36000,
  maxOrder = null,
  hasSeriesTool = false,
  hasFallback = false,
  visibleArcsCount = 0,
}) {
  const autoThreshold = corpusConfig?.hierarchy?.auto_series_threshold || 250;
  const needSeriesFirst = hasSeriesTool && visibleArcsCount > autoThreshold;

  const gateRule = onDemand
    ? '1. 本次为【显式点菜 / 强制检索】请求，禁止跳过，必须执行检索并返回核实后的场景或设定节点。'
    : `1. 【主动检索 vs 日常跳过】只要对话流露或涉及【${corpusConfig.active_recall_triggers}】，即便轻量化状态线索中已有简短备注，也应当主动调工具核实原文与细节，供正文模型丰富表现。只有当对话属于【${corpusConfig.skip_criteria}】时，才不调用工具直接输出：{"skip":true,"reason":"简述原因"}。`;

  const spoilerBlock =
    maxOrder !== null
      ? `\n【防剧透门控已生效（当前${corpusConfig.spoiler_gate.order_label}上限：${maxOrder}）】\n- 系统已在索引和工具层锁定：只能查看并引用 order <= ${maxOrder} 的章节内容及无剧透限制的通用背景设定。\n- 严禁在 guide 或 timeline_note 中泄露、暗示或推测任何超过 ${maxOrder} 进度的后续真相或剧情转折！\n`
      : '';

  const glossaryBlock = corpusConfig.glossary.length
    ? `\n【编制 / 势力 / 实体速查（遇到统称或简称时可按对应成员展开检索）】\n${corpusConfig.glossary.join('\n')}\n`
    : '';

  const turn1Rule = needSeriesFirst
    ? '第一轮（Turn 1）可调用 `list_series`（查看分部概览）、带过滤参数的 `list_story_arcs`，或直接并发调用 `grep_scenes` 扫描跨卷专有名词/时间线线索。'
    : '第一轮（Turn 1）可按问题类型自由组合或并发调用 `list_story_arcs`' +
      (hasSeriesTool ? '、`list_series`' : '') +
      ' 与 `grep_scenes`（例如同时翻阅篇章目录并用 `grep_scenes` 毫秒级直扫核心词条、台词、人物别名或时间线关键词）。';

  const ocHint = corpusConfig.oc_examples.length
    ? `（例如类似“${corpusConfig.oc_examples.join('”“')}”等未在本语料收录的角色）`
    : '';

  const toneRoutingExtra = corpusConfig.tone_routing_hints
    ? `\n     * 【本语料氛围分流指引】${corpusConfig.tone_routing_hints}`
    : '';

  const fallbackStep = hasFallback
    ? '\n   - 若目录树与 `grep_scenes` 仍查不到冷门细节，再调用 `fallback_search` 兜底。'
    : '';

  const fallbackFieldLine = hasFallback
    ? '\n  "selected_chunks": ["如调用过 fallback_search 且有命中，可填 chunk_id，否则 []"],'
    : '';

  return `你是《${corpusConfig.name}》RP（角色扮演）与长文本资料库的后台记忆检索 Agent，服务于正文生成模型。

【语料概况与世界观前提】
- 语料规模：${stats.arcs} 卷 / ${stats.scenes} 幕 / ${formatCharCount(stats.total_chars)}（分类：${categories.join('、') || '通用'}${toneTags.length ? `；可用氛围标签 tone：${toneTags.join('、')}` : ''}）。
- ${corpusConfig.world_premise}
${spoilerBlock}${glossaryBlock}
【检索策略（严格遵守）】
${gateRule}
2. 【首轮并发寻路与锚点消歧】${turn1Rule}
   - 若当前角色卡为【城市 / 群像 / 沙盒大舞台卡】，**严禁拿舞台卡名去搜目录树**，请从最近对话流与状态线索识别实际出场人物和事件进行检索；
   - ${corpusConfig.user_identity_guard.enabled ? `**${corpusConfig.user_identity_guard.note}**，绝对禁止把玩家 ID 当作角色去检索！` : '注意区分玩家 ID 与语料人物名，避免误检索。'}
3. 【检索毅力与批量效率（PERSISTENCE & BATCHING）】一旦决定需要检索，若首次过滤未命中或不够贴切，**严禁直接放弃或臆断“库里没有”**：
   - 善用多工具并发：可在一轮内同时发起多个不同维度的 \`grep_scenes\` 或 \`list_story_arcs\`；
   - 凡遇**跨卷时间线梳理（如“这十年发生了什么”）、世界观大设定汇总、次要角色客串、原话台词核对、多角色同框、特定器物/势力/技术名词**，积极使用 \`grep_scenes\` 毫秒级扫全库正文并自动展开别名${fallbackStep}
   - 调用 \`read_scene\` 时，**尽量在一次调用的 \`scene_node_ids\` 数组里批量传入多个候选节点（单次最多 10 个）**，避免拆成多轮逐个读取耗尽轮次。
4. 【按查询拓扑自决选幕（安全上限 ${maxScenes} 幕，总字数预算约 ${maxChars.toLocaleString()} 字）】
   用 \`get_arc_scenes\` 或 \`grep_scenes\` 定位候选幕后，调用 \`read_scene\` 批量精读完整原文核实（单次最多 10 幕），按询问形状决定最终放入 \`selected_nodes\` 与 \`selected_arcs\` 的内容：
   - **拓扑 A · 定点事件 / 词条查证**：克制选 **1~3 幕**最核心原幕即可；若关键剧情横跨连续相邻的下一幕 \`node_id\`，注意连读相邻幕避免漏掉收尾台词。
   - **拓扑 B · 宏观长跨度回顾 / 全局大设定与编年史**：当询问跨越多个篇章甚至全书的时间线（如“这十年发生了什么”“完整的大设定”“全主线脉络”）时，在 \`selected_arcs\` 填入 **1~10 个关键 \`arc_id\`**（系统会自动附带逐幕脉络大纲），并在 \`selected_nodes\` 中跨越不同阶段与设定档案精选 **4~10 幕**最具全局代表性的核心原文；同时在 \`guide\` 中融合已读原幕、篇章脉络及 \`grep_scenes\` 命中的真实原文摘录，按【时代起点/核心设定 → 阶段演进与各方势力动向 → 当前主线格局】输出详实完整的结构化宏观综述（篇幅不设死板上封顶，以讲清完整设定版图与各节点切入点为准）。
   - **拓扑 C · 单角色立体塑人 / 泛回忆与小队过往全覆盖（防单篇偏食 & 防漏分队）**：当追忆某角色或某角色与所属小队/组织的过往经历而非指明单一事件时，推荐自决选出 **4~10 幕**，跨越不同分类/阶段/氛围维度交叉采样；**若涉及小队/组织（如 404 小队等），请对照上方【编制 / 势力 / 实体速查】及目录人物表，确保同时覆盖初代/离队前辈、一队新入队成员（如安朵丝、比悠卡）及二队/分队全体成员（如维克托、维尔德、哈卜茜、乌琪）并在 guide 中点明完整名单与经历，严禁只写一队而漏掉二队或扩编成员**。
   - **拓扑 D · 群像与多声部齐聚（防锚点粘连 + 按氛围 \`tone\` 分流）**：当对话表达对多位旧部/众人不同声音的怀念或多人同场对照时，**严禁被最近一轮的单一在场角色吸住视野**！应主动抽离单角色锚点，结合当前语境情绪（\`tone\`：战火危机 vs 温情日常 vs 心理独白 vs 设定档案），在预算内横向抽取 **4~10 个不同人物/视角的片段**。${toneRoutingExtra}
   - **放入 \`selected_nodes\` 的节点必须经 \`read_scene\` 核实；在撰写宏观大设定 \`guide\` 时，可将 \`read_scene\` 精读内容与 \`grep_scenes\` 命中的真实原文上下文摘录一并纳入综述，严禁凭空捏造原著未出现的事实！**
5. 【防幻觉与虚假前提澄清铁律】
   a) 若语料外存在原创角色或外部设定${ocHint}，且 \`list_story_arcs\` 与 \`grep_scenes\` 均未在正文中找到该实体，**绝对禁止**因单字相似强行张冠李戴，直接输出 \`{"skip":true,"reason":"本语料库中未收录该角色或实体，属原创或外部设定"}\`。
   b) 若用户输入将真实官方角色绑定到了**未曾发生的虚假前提**，在 \`read_scene\` 核实原文后，**必须在 \`guide\` 开头明确澄清并驳斥虚假前提**，仅据已读原文陈述事实。
6. 【输出规范】
   核实完毕后立即停止调工具，只输出一个严格 JSON 对象（不要额外解释）：
{
  "skip": false,
  "selected_nodes": ["经 read_scene 核实过的 node_id 列表"],
  "selected_arcs": ["可选，宏观多章或全局设定梳理时可填 1~10 个关键 arc_id，否则 []"],${fallbackFieldLine}
  "timeline_note": "一句话标注命中片段所属阶段或时间线跨度",
  "guide": "结构化记忆导读：单幕查证保持精炼；多幕或全局大设定/编年史回顾则分阶段、分势力维度完整梳理核心事实，并标出各 [node_id] 与关键设定线索的对应关系，供正文模型直接引用。"
}`;
}

function buildUserMessage({ query, recentChat, sceneAnchor, activeStateHints, onDemand, corpusConfig, maxOrder }) {
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

  if (activeStateHints && String(activeStateHints).trim()) {
    parts.push(`【当前世界书 / 数据库轻量线索】\n${String(activeStateHints).trim().slice(0, 1200)}`);
  }

  if (Array.isArray(recentChat) && recentChat.length) {
    const lines = recentChat
      .slice(-10)
      .map((m) => {
        const who = m.name || (m.role === 'user' ? sceneAnchor?.userName || '用户' : sceneAnchor?.charName || '角色');
        const txt = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
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
  normalizeCorpusConfig,
  isStageCardName,
  buildTools,
  buildSystemPrompt,
  buildUserMessage,
};
