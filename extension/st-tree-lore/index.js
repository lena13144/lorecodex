import {
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    setExtensionPrompt,
    eventSource,
    event_types,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'st_tree_lore';
const PROMPT_TAG = 'lorecodex_context';

const defaultSettings = {
    enabled: true,
    ragServer: 'http://127.0.0.1:5240',
    corpus: '',
    maxOrder: 0,
    recentTurns: 5,
    maxScenes: 0,
    pov: '',
    depth: 1,
    chatBase: '',
    chatKey: '',
    chatModel: '',
    customXmlTag: '',
    customHeader: '',
    customPriorityRule: '',
    customFollowUpHint: '',
    customBoilerplateRegex: '',
    customSummaryPriorityRegex: '',
    charBindings: {},
};

let corporaCache = [];
const corporaMap = new Map();
let serverDefaultCorpus = '';
let lastHealthInfo = null;
let lastInjectionSnapshot = null;

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));
}

function normalizeMaxScenes(val) {
    const n = Number(val);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 12) : 0;
}

function normalizeMaxOrder(val) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        const legacyActive = Boolean(extension_settings?.gf2_rag_bridge?.enabled);
        extension_settings[MODULE_NAME] = {
            ...defaultSettings,
            enabled: !legacyActive,
            charBindings: {},
        };
    } else {
        for (const [k, v] of Object.entries(defaultSettings)) {
            if (extension_settings[MODULE_NAME][k] === undefined) {
                extension_settings[MODULE_NAME][k] = k === 'charBindings' ? {} : v;
            }
        }
        if (!extension_settings[MODULE_NAME].charBindings || typeof extension_settings[MODULE_NAME].charBindings !== 'object') {
            extension_settings[MODULE_NAME].charBindings = {};
        }
    }
    return extension_settings[MODULE_NAME];
}

function cleanMessage(mes) {
    if (!mes) return '';
    let s = String(mes)
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<details>[\s\S]*?<\/details>/gi, '')
        .replace(/<(?:gf2_source_reference|lore_source_reference|chronicles_source_reference|[a-z0-9_]+_source_reference)>[\s\S]*?<\/(?:gf2_source_reference|lore_source_reference|chronicles_source_reference|[a-z0-9_]+_source_reference)>/gi, '')
        .replace(/```html[\s\S]*?```/gi, '')
        .replace(/<[^>]+>/g, '');
    const wrapped = s.match(/以下是用户的本轮输入[：:]\s*([\s\S]*?)(?:\n\s*以下输入的代码为|$)/);
    if (wrapped) s = wrapped[1];
    return s
        .replace(/\[时间约束词\][\s\S]*$/i, '')
        .replace(/# 记忆召回[\s\S]*$/i, '')
        .trim();
}

function extractDbRecallHints(mes) {
    if (!mes) return '';
    const m = String(mes).match(/# 记忆召回([\s\S]*)/);
    if (!m) return '';
    return cleanMessage(m[1]).replace(/\s+/g, ' ').trim().slice(0, 450);
}

function collectRecentChat(chat, maxTurns) {
    const turns = Math.max(1, Number(maxTurns) || 5);
    return (chat || [])
        .filter(m => m && !m.is_system && m.mes && !String(m.mes).startsWith('[Pi 工作流]'))
        .slice(-(turns * 2))
        .map(m => ({
            role: m.is_user ? 'user' : 'assistant',
            name: m.name || '',
            text: cleanMessage(m.mes).slice(0, 500),
        }))
        .filter(m => m.text);
}

function buildApiConfig(cfg) {
    const out = {};
    if (cfg.chatBase) out.chatBase = cfg.chatBase.trim();
    if (cfg.chatKey) out.chatKey = cfg.chatKey.trim();
    if (cfg.chatModel) out.chatModel = cfg.chatModel.trim();
    return out;
}

function collectActivatedEntries(loreData) {
    const texts = [];
    const push = (x) => {
        if (!x) return;
        if (typeof x === 'string' && x.trim()) texts.push(x);
        else if (x.content && typeof x.content === 'string') texts.push(x.content);
    };
    const walk = (obj) => {
        if (!obj) return;
        if (Array.isArray(obj)) { obj.forEach(push); return; }
        if (obj instanceof Set || obj instanceof Map) { walk([...obj]); return; }
        if (typeof obj === 'object') {
            if (Array.isArray(obj.entries)) obj.entries.forEach(walk);
            else if (obj.entries instanceof Set || obj.entries instanceof Map) walk([...obj.entries]);
            if (Array.isArray(obj.allActivatedEntries)) obj.allActivatedEntries.forEach(walk);
            else if (obj.allActivatedEntries instanceof Set) walk([...obj.allActivatedEntries]);
        }
    };
    for (const key of ['globalLore', 'characterLore', 'charLore', 'chatLore', 'personaLore', 'entries']) walk(loreData?.[key]);
    if (!texts.length) walk(loreData);
    return texts;
}

function compilePatternList(patterns) {
    const out = [];
    for (const p of patterns || []) {
        if (!p || !String(p).trim()) continue;
        try {
            out.push(new RegExp(String(p).trim(), 'i'));
        } catch (e) {
            console.warn('[LoreCodex] invalid regex skipped:', p, e);
        }
    }
    return out;
}

function buildActiveStateHints(entryTexts, dbRecallHints, corpusMeta, cfg) {
    const boilerSources = cfg.customBoilerplateRegex && cfg.customBoilerplateRegex.trim()
        ? cfg.customBoilerplateRegex.split(/\n+/).map(s => s.trim()).filter(Boolean)
        : (corpusMeta?.db_scrubber?.boilerplate_patterns || []);

    const summarySources = cfg.customSummaryPriorityRegex && cfg.customSummaryPriorityRegex.trim()
        ? cfg.customSummaryPriorityRegex.split(/\n+/).map(s => s.trim()).filter(Boolean)
        : (corpusMeta?.db_scrubber?.summary_priority_patterns || []);

    const boilerRegexes = compilePatternList(boilerSources);
    const summaryRegexes = compilePatternList(summarySources);

    const isBoilerplate = (raw) => boilerRegexes.some(re => re.test(raw));
    const isDbSummary = (raw) => summaryRegexes.some(re => re.test(raw));

    const dbPriority = [];
    const charOrOther = [];
    if (dbRecallHints) dbPriority.push('[DB召回] ' + dbRecallHints);

    for (const raw of (entryTexts || [])) {
        const s = String(raw || '');
        if (!s.trim() || isBoilerplate(s)) continue;
        const cleaned = cleanMessage(s).replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;
        if (isDbSummary(s)) dbPriority.push(cleaned.slice(0, 260));
        else charOrOther.push(cleaned.slice(0, 180));
    }

    const ordered = [...dbPriority.slice(-6), ...charOrOther.slice(0, 4)];
    return ordered.join('\n').slice(0, 1200);
}

function getServerBase(cfg) {
    return (cfg.ragServer || 'http://127.0.0.1:5240').replace(/\/+$/, '');
}

async function fetchCorporaAndHealth(cfg) {
    const srv = getServerBase(cfg);
    try {
        const [hr, cr] = await Promise.all([
            fetch(`${srv}/health`).then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${srv}/corpora`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        lastHealthInfo = hr;
        if (!cr) return false;
        corporaCache = Array.isArray(cr.corpora) ? cr.corpora : [];
        serverDefaultCorpus = String(cr.defaultCorpus || '');
        corporaMap.clear();
        for (const c of corporaCache) corporaMap.set(c.id, c);
        if (!cfg.corpus && serverDefaultCorpus) {
            cfg.corpus = serverDefaultCorpus;
            saveSettingsDebounced();
        }
        return true;
    } catch (_) {
        lastHealthInfo = null;
        return false;
    }
}

function getEffectiveFraming(corpusMeta, cfg) {
    const pf = corpusMeta?.prompt_framing || {};
    const cName = corpusMeta?.name || cfg.corpus || '当前典籍';
    const rawTag = (cfg.customXmlTag || pf.xml_tag || 'lore_source_reference').trim();
    const xmlTag = rawTag.replace(/[^a-zA-Z0-9_-]/g, '') || 'lore_source_reference';
    const header = (cfg.customHeader || pf.header || `以下为《${cName}》中检索并核实的过往剧情原文与设定片段。请将其作为角色回忆或既有经历自然融入扮演，不要机械复读旁白。`).trim();
    const priorityRule = (cfg.customPriorityRule || pf.priority_rule || '【事实优先级】若原作片段细节与当前世界书/角色卡设定或本局对话已确认的新发展存在冲突，一律以本局当前时间线为准。').trim();
    const followUpHint = (cfg.customFollowUpHint || pf.follow_up_hint || '如仍需追查其他特定过往台词或细节，可在回复末尾附带【查原文：具体问题或人物事件】。').trim();
    return { xmlTag, header, priorityRule, followUpHint };
}

function renderLastPreview(cfg) {
    const box = $('#lorecodex_last_preview');
    if (!box.length) return;
    if (!lastInjectionSnapshot) {
        box.html('<div class="lorecodex-muted">本会话尚未执行检索。生成对话或使用下方测试检索后，将在此显示实际注入预览。</div>');
        return;
    }
    const snap = lastInjectionSnapshot;
    const statusPill = snap.skip
        ? `<span class="lorecodex-pill skip">跳过注入</span>`
        : `<span class="lorecodex-pill ok">注入 ${snap.scenes.length} 幕${snap.outlines?.length ? ` · ${snap.outlines.length}大纲` : ''}</span>`;
    const orderPill = snap.max_order ? `<span class="lorecodex-pill accent">序 &lt;= ${snap.max_order}</span>` : '';
    const scenesHtml = (snap.scenes || []).map(s => `
        <div class="lorecodex-scene-item">
            <span><code>${escHtml(s.node_id)}</code> ${escHtml(s.arc_title)} · ${escHtml(s.title)}</span>
            <span class="lorecodex-muted">${s.chars}字</span>
        </div>
    `).join('');
    const wbUrl = snap.run_id
        ? `${getServerBase(cfg)}/#run=${encodeURIComponent(snap.run_id)}`
        : getServerBase(cfg);

    box.html(`
        <div class="lorecodex-row" style="justify-content:space-between;">
            <div class="lorecodex-row" style="gap:5px;">
                ${statusPill}
                <span class="lorecodex-pill">${escHtml(snap.corpus_name || snap.corpus_id || '-')}</span>
                ${orderPill}
            </div>
            <span class="lorecodex-muted">${snap.took_ms}ms · ${snap.turns}轮</span>
        </div>
        ${snap.skip ? `<div class="lorecodex-muted">原因：${escHtml(snap.reason || '无命中')}</div>` : `
            ${snap.guide ? `<details style="font-size:0.84em;"><summary style="cursor:pointer;">记忆导读（${snap.prompt_chars || 0} 字符）</summary><div style="margin-top:5px;line-height:1.5;white-space:pre-line;">${escHtml(snap.guide)}</div></details>` : ''}
            ${scenesHtml ? `<div class="lorecodex-preview-scenes">${scenesHtml}</div>` : ''}
        `}
        <div class="lorecodex-row">
            <a href="${escHtml(wbUrl)}" target="_blank" rel="noopener" class="menu_button" style="text-decoration:none;flex:1;text-align:center;">在书阁查看完整轨迹</a>
        </div>
    `);
}

async function runTreeRetrieval(cfg, ctx, chat, entryTexts, { query, onDemand, dbRecallHints, clear }) {
    const server = getServerBase(cfg);
    const depth = Number.isFinite(Number(cfg.depth)) ? Number(cfg.depth) : 1;
    const recentChat = collectRecentChat(chat, cfg.recentTurns || 5);
    const corpusId = (cfg.corpus || serverDefaultCorpus || '').trim();
    const corpusMeta = corporaMap.get(corpusId) || null;
    const activeStateHints = buildActiveStateHints(entryTexts, dbRecallHints, corpusMeta, cfg);
    const maxOrder = normalizeMaxOrder(cfg.maxOrder);

    const resp = await fetch(`${server}/tree-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            corpus: corpusId || undefined,
            query,
            onDemand,
            recentChat,
            sceneAnchor: {
                charName: ctx?.name2 || '',
                userName: ctx?.name1 || '指挥官',
                pov: cfg.pov || '',
            },
            activeStateHints,
            maxScenes: normalizeMaxScenes(cfg.maxScenes),
            maxOrder: maxOrder || undefined,
            pov: cfg.pov || '',
            apiConfig: buildApiConfig(cfg),
        }),
    });
    if (!resp.ok) {
        console.warn('[LoreCodex] HTTP', resp.status);
        return;
    }

    const data = await resp.json();
    const scenes = Array.isArray(data.scenes) ? data.scenes : [];
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const outlines = Array.isArray(data.outlines) ? data.outlines : [];

    if (data.skip || (!scenes.length && !chunks.length && !outlines.length && !data.guide)) {
        lastInjectionSnapshot = {
            corpus_id: data.corpus_id || corpusId,
            corpus_name: data.corpus_name || corpusMeta?.name || corpusId,
            skip: true,
            reason: data.reason || 'no hit',
            took_ms: data.took_ms,
            turns: data.turns,
            max_order: data.max_order,
            run_id: data.run_id || '',
            scenes: [],
            outlines: [],
        };
        renderLastPreview(cfg);
        console.debug(`[LoreCodex] skipped (${data.took_ms}ms): ${data.reason || 'no hit'}`);
        clear();
        return;
    }

    const wbText = (entryTexts || []).join('\n');
    const profLines = (data.profiles || []).filter(p => !(p.tag && wbText.includes(String(p.tag).slice(0, 30)))).slice(0, 3);
    const profBlock = profLines.length
        ? `\n\n【角色档案参考】\n` + profLines.map(p => `《${p.tag}》\n${String(p.text || '').slice(0, 700)}`).join('\n\n')
        : '';
    const relLines = (data.relations || []).slice(0, 8);
    const relBlock = relLines.length ? `\n\n【实体关系图谱】\n${relLines.join('\n')}` : '';

    const guideBlock = data.guide
        ? `\n\n【记忆导读${data.timeline_note ? ' | ' + data.timeline_note : ''}】\n${data.guide}`
        : '';

    const outlineBlock = outlines.length
        ? `\n\n【跨篇章宏观脉络大纲】\n` + outlines.map(o =>
            `《${o.title} [${o.arc_id}]》（${o.category} · ${o.scene_count}幕）\n概要：${o.description || ''}\n${o.outline_text}`
        ).join('\n\n')
        : '';

    const sceneBlock = scenes.length
        ? '\n\n' + scenes.map((s, i) => {
            const povNote = (cfg.pov && s.present === false) ? ` | 注：${cfg.pov}当时不在场，仅作背景或转述记忆` : '';
            const cat = s.category ? ` (${s.category})` : '';
            const st = s.title ? ` | ${s.title}` : '';
            const ord = s.order !== null && s.order !== undefined ? ` | 序${s.order}` : '';
            return `【原著场景 ${i + 1} | ${s.arc_title || ''}${cat}${st}${ord} [node:${s.node_id}]${povNote}】\n${s.text}`;
        }).join('\n\n')
        : '';

    const chunkBlock = chunks.length
        ? '\n\n' + chunks.map((c, i) =>
            `【设定/补全词条 ${i + 1} | ${c.era || ''}${c.tag || c.group}${c.chapter ? ' | 所属：' + c.chapter : ''}】\n${c.text}`
        ).join('\n\n')
        : '';

    const activeMeta = corporaMap.get(data.corpus_id || corpusId) || corpusMeta;
    const framing = getEffectiveFraming(activeMeta, cfg);
    const spoilerNote = data.max_order ? `\n【防剧透进度锁定】当前仅解锁至进度序 <= ${data.max_order} 的已知章节，请严守角色当下认知边界。` : '';

    const promptText = `<${framing.xmlTag}>\n${framing.header}\n${framing.priorityRule}${spoilerNote}${guideBlock}${outlineBlock}${profBlock}${sceneBlock}${chunkBlock}${relBlock}\n\n${framing.followUpHint}\n</${framing.xmlTag}>`;

    lastInjectionSnapshot = {
        corpus_id: data.corpus_id || corpusId,
        corpus_name: data.corpus_name || activeMeta?.name || corpusId,
        skip: false,
        took_ms: data.took_ms,
        turns: data.turns,
        max_order: data.max_order,
        guide: data.guide || '',
        scenes,
        outlines,
        run_id: data.run_id || '',
        prompt_chars: promptText.length,
    };
    renderLastPreview(cfg);

    console.log(`[LoreCodex] Injected [${data.corpus_id}] ${scenes.length} scenes, ${outlines.length} outlines (${data.took_ms}ms, turns=${data.turns})`, data.trace);
    setExtensionPrompt(PROMPT_TAG, promptText, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);
}

let loreRagRunning = false;
async function runLoreRetrieval(loreData) {
    const cfg = getSettings();
    if (!cfg.enabled || loreRagRunning) return;
    loreRagRunning = true;
    const clear = () => setExtensionPrompt(
        PROMPT_TAG,
        '',
        extension_prompt_types.IN_CHAT,
        Number.isFinite(Number(cfg.depth)) ? Number(cfg.depth) : 1,
        false,
        extension_prompt_roles.SYSTEM
    );
    try {
        const ctx = getContext();
        const chat = ctx?.chat || [];
        const lastUserMsg = chat.filter(m => m.is_user && m.mes).slice(-1)[0];
        const query = lastUserMsg ? cleanMessage(lastUserMsg.mes).slice(0, 500) : '';
        if (!query) { clear(); return; }

        const lastAiMsg = chat.filter(m => !m.is_user && m.mes).slice(-1)[0];
        const entryTexts = collectActivatedEntries(loreData);
        const markerSource = (lastAiMsg ? String(lastAiMsg.mes) : '') + '\n' + entryTexts.join('\n');
        const marker = markerSource.match(/【(?:查原文|翻目录|读场景)[：:](.+?)】|<lore_query>([\s\S]*?)<\/lore_query>|<rag_query>([\s\S]*?)<\/rag_query>/i);
        const userWantsQuote = /原话|台词|原文|说过什么|那句|那句话|怎么说的|引文|还记得.*说|ta当时说|具体说了/.test(query);
        const onDemand = (marker ? (marker[1] || marker[2] || marker[3] || '').trim().slice(0, 300) : '') || (userWantsQuote ? query : '');
        const dbRecallHints = lastUserMsg ? extractDbRecallHints(lastUserMsg.mes) : '';

        await runTreeRetrieval(cfg, ctx, chat, entryTexts, { query, onDemand, dbRecallHints, clear });
    } catch (err) {
        console.warn('[LoreCodex] retrieval failed:', err);
    } finally {
        loreRagRunning = false;
    }
}

let pendingGeneration = false;
eventSource.on(event_types.GENERATION_STARTED, (type, _opts, dryRun) => {
    if (!dryRun && type !== 'quiet') pendingGeneration = true;
});
eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, async (loreData) => {
    if (!pendingGeneration) return;
    pendingGeneration = false;
    try { await runLoreRetrieval(loreData); }
    catch (e) { console.warn('[LoreCodex]', e); }
});

function getActiveCharKey() {
    const ctx = getContext();
    return String(ctx?.name2 || '').trim();
}

jQuery(async () => {
    const cfg = getSettings();
    const initialOk = await fetchCorporaAndHealth(cfg);

    const syncUiFromCfg = () => {
        $('#lorecodex_enabled').prop('checked', Boolean(cfg.enabled));
        $('#lorecodex_server').val(cfg.ragServer || '');
        $('#lorecodex_corpus').val(cfg.corpus || '');
        $('#lorecodex_max_order').val(cfg.maxOrder ?? 0);
        $('#lorecodex_recent_turns').val(cfg.recentTurns ?? 5);
        $('#lorecodex_max_scenes').val(cfg.maxScenes ?? 0);
        $('#lorecodex_pov').val(cfg.pov || '');
        $('#lorecodex_depth').val(cfg.depth ?? 1);
        $('#lorecodex_chat_base').val(cfg.chatBase || '');
        $('#lorecodex_chat_key').val(cfg.chatKey || '');
        $('#lorecodex_chat_model').val(cfg.chatModel || '');
        $('#lorecodex_xml_tag').val(cfg.customXmlTag || '');
        $('#lorecodex_header').val(cfg.customHeader || '');
        $('#lorecodex_priority_rule').val(cfg.customPriorityRule || '');
        $('#lorecodex_followup_hint').val(cfg.customFollowUpHint || '');
        $('#lorecodex_boiler_re').val(cfg.customBoilerplateRegex || '');
        $('#lorecodex_summary_re').val(cfg.customSummaryPriorityRegex || '');
    };

    const renderConnStatus = (ok) => {
        const dot = $('#lorecodex_conn_dot');
        const txt = $('#lorecodex_conn_text');
        if (!dot.length) return;
        dot.removeClass('ok err wait');
        if (ok && lastHealthInfo?.ok) {
            dot.addClass('ok');
            txt.text(`已连接 · ${corporaCache.length} 个书库 · ${lastHealthInfo.mode || 'tree-only'} (${lastHealthInfo.boot_ms ?? '-'}ms)`);
        } else {
            dot.addClass('err');
            txt.text(`未连接到 ${getServerBase(cfg)}`);
        }
    };

    const renderCorpusDropdown = () => {
        const sel = $('#lorecodex_corpus').empty();
        if (!corporaCache.length) {
            sel.append(`<option value="${escHtml(cfg.corpus || '')}">${escHtml(cfg.corpus || '（未连接服务端或无书库）')}</option>`);
            return;
        }
        for (const c of corporaCache) {
            sel.append(`<option value="${escHtml(c.id)}">${escHtml(c.name)} (${c.stats.arcs}卷 / ${c.stats.scenes}幕)</option>`);
        }
        if (cfg.corpus) sel.val(cfg.corpus);
    };

    const updateBindingLabel = () => {
        const charKey = getActiveCharKey();
        const b = charKey ? cfg.charBindings?.[charKey] : null;
        const el = $('#lorecodex_binding_info');
        if (!el.length) return;
        if (!charKey) {
            el.text('当前未进入角色对话（可切换角色后绑定专属书库与进度）');
        } else if (b) {
            el.text(`当前角色卡「${charKey}」已绑定：书库=${b.corpus || '默认'} | 防剧透序=${b.maxOrder || 0} | 视角=${b.pov || '无'}`);
        } else {
            el.text(`当前角色卡「${charKey}」未单独绑定（沿用当前全局书库）`);
        }
    };

    const refreshLegacyBanner = () => {
        const legacyOn = Boolean(extension_settings?.gf2_rag_bridge?.enabled);
        $('#lorecodex_migrate_banner').toggle(legacyOn);
    };

    eventSource.on(event_types.CHAT_CHANGED, () => {
        pendingGeneration = false;
        const charKey = getActiveCharKey();
        const b = charKey ? cfg.charBindings?.[charKey] : null;
        if (b) {
            if (b.corpus !== undefined) cfg.corpus = b.corpus;
            if (b.maxOrder !== undefined) cfg.maxOrder = normalizeMaxOrder(b.maxOrder);
            if (b.pov !== undefined) cfg.pov = b.pov;
            saveSettingsDebounced();
            syncUiFromCfg();
        }
        updateBindingLabel();
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lorecodex',
        returns: 'LoreCodex 检索开关状态',
        callback: (_args, value) => {
            const v = String(value || '').trim().toLowerCase();
            if (v === 'on' || v === '1' || v === 'true') cfg.enabled = true;
            else if (v === 'off' || v === '0' || v === 'false') cfg.enabled = false;
            else cfg.enabled = !cfg.enabled;
            saveSettingsDebounced();
            $('#lorecodex_enabled').prop('checked', cfg.enabled);
            toastr.info(`LoreCodex 树检索：${cfg.enabled ? '已开启' : '已关闭'}`);
            return cfg.enabled ? 'on' : 'off';
        },
        helpString: 'LoreCodex 检索开关：/lorecodex on|off（不带参数切换）',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lorecorpus',
        returns: '当前挂载语料 ID',
        callback: async (_args, value) => {
            const id = String(value || '').trim();
            if (!id) return cfg.corpus || serverDefaultCorpus || '';
            cfg.corpus = id;
            saveSettingsDebounced();
            $('#lorecodex_corpus').val(id);
            toastr.info(`LoreCodex 已切换书库：${corporaMap.get(id)?.name || id}`);
            return id;
        },
        helpString: '切换当前挂载书库：/lorecorpus <corpus_id>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'loreorder',
        returns: '防剧透章节序上限',
        callback: (_args, value) => {
            const raw = String(value || '').trim().toLowerCase();
            cfg.maxOrder = raw === 'off' || raw === 'none' || raw === '0' ? 0 : normalizeMaxOrder(raw);
            saveSettingsDebounced();
            $('#lorecodex_max_order').val(cfg.maxOrder);
            toastr.info(`LoreCodex 防剧透上限：${cfg.maxOrder > 0 ? '序 <= ' + cfg.maxOrder : '已关闭（全库开放）'}`);
            return String(cfg.maxOrder);
        },
        helpString: '设置防剧透章节序上限：/loreorder 3（仅检索序<=3）；/loreorder off（关闭限制）',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lorepov',
        returns: '检索视角角色名',
        callback: (_args, value) => {
            cfg.pov = String(value || '').trim();
            saveSettingsDebounced();
            $('#lorecodex_pov').val(cfg.pov);
            toastr.info(`LoreCodex 检索视角：${cfg.pov || '（无）'}`);
            return cfg.pov;
        },
        helpString: '设置检索视角角色：/lorepov 角色名（空值清除）',
    }));

    try {
        const r = await fetch(`${getServerBase(cfg)}/config`);
        if (r.ok) {
            const srvCfg = await r.json();
            if (!cfg.chatKey && srvCfg.chatKey && !/^\*+$/.test(srvCfg.chatKey)) cfg.chatKey = srvCfg.chatKey;
            if (!cfg.chatBase && srvCfg.chatBase) cfg.chatBase = srvCfg.chatBase;
            if (!cfg.chatModel && srvCfg.chatModel) cfg.chatModel = srvCfg.chatModel;
        }
    } catch (_) {}

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>LoreCodex 树形典籍检索 (st-tree-lore)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content lorecodex-drawer">
            <div id="lorecodex_migrate_banner" class="lorecodex-migrate-banner" style="display:none;">
                <div><b>检测到旧版插件 gf2-rag-bridge 正在启用中</b>：为避免双倍注入上下文，本插件首次已保持暂停状态。</div>
                <button id="lorecodex_migrate_btn" class="menu_button" style="width:100%;">一键迁移旧配置并停用旧版 gf2-rag-bridge</button>
            </div>

            <div class="lorecodex-card">
                <div class="lorecodex-conn-bar">
                    <div class="lorecodex-conn-left">
                        <span id="lorecodex_conn_dot" class="lorecodex-dot wait"></span>
                        <span id="lorecodex_conn_text" class="lorecodex-conn-text">正在检测服务...</span>
                    </div>
                    <button id="lorecodex_open_ui" class="menu_button" style="width:auto;padding:3px 9px;">打开书阁</button>
                </div>
                <label class="checkbox_label">
                    <input id="lorecodex_enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''} />
                    <span><b>启用生成前树形记忆检索注入</b></span>
                </label>
                <div class="lorecodex-row">
                    <div style="flex:1;min-width:150px;">
                        <small>服务端地址：</small>
                        <input id="lorecodex_server" class="text_pole" type="text" value="${escHtml(cfg.ragServer)}" />
                    </div>
                    <div style="flex:1;min-width:160px;">
                        <small>挂载典籍书库：</small>
                        <select id="lorecodex_corpus" class="text_pole"></select>
                    </div>
                    <button id="lorecodex_refresh_corpora" class="menu_button" style="width:auto;margin-top:16px;padding:4px 8px;">刷新</button>
                </div>
                <div class="lorecodex-grid-4">
                    <div title="0 = 全库开放不拦截；>0 时拦截所有 order 大于该值的后续章节">
                        <small>防剧透序</small>
                        <input id="lorecodex_max_order" class="text_pole" type="number" min="0" value="${cfg.maxOrder ?? 0}" />
                    </div>
                    <div title="0 = 由 Agent 按场景与字数预算自决">
                        <small>幕数(0自决)</small>
                        <input id="lorecodex_max_scenes" class="text_pole" type="number" min="0" max="12" value="${cfg.maxScenes ?? 0}" />
                    </div>
                    <div>
                        <small>对话轮数</small>
                        <input id="lorecodex_recent_turns" class="text_pole" type="number" min="1" max="15" value="${cfg.recentTurns ?? 5}" />
                    </div>
                    <div>
                        <small>注入深度</small>
                        <input id="lorecodex_depth" class="text_pole" type="number" min="0" max="10" value="${cfg.depth ?? 1}" />
                    </div>
                </div>
                <div>
                    <small>检索视角 POV（可选，缺席场景标注转述）：</small>
                    <input id="lorecodex_pov" class="text_pole" type="text" value="${escHtml(cfg.pov || '')}" placeholder="留空表示全景视角" />
                </div>
            </div>

            <div class="lorecodex-card">
                <div style="font-weight:bold;font-size:0.88em;">角色卡自动绑定</div>
                <div id="lorecodex_binding_info" class="lorecodex-muted"></div>
                <div class="lorecodex-row">
                    <button id="lorecodex_bind_char" class="menu_button" style="flex:1;">绑定当前角色卡</button>
                    <button id="lorecodex_unbind_char" class="menu_button" style="flex:1;">解除当前绑定</button>
                </div>
            </div>

            <div class="lorecodex-card">
                <div style="font-weight:bold;font-size:0.88em;">上次注入实时预览</div>
                <div id="lorecodex_last_preview" style="display:flex;flex-direction:column;gap:6px;"></div>
            </div>

            <details class="lorecodex-card">
                <summary style="cursor:pointer;font-weight:bold;font-size:0.88em;">内嵌测试检索（无需弹窗）</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <div class="lorecodex-row">
                        <input id="lorecodex_test_query" class="text_pole" type="text" style="flex:1;" placeholder="输入测试检索问题，如：苏璃的真实身份" />
                        <button id="lorecodex_test_btn" class="menu_button" style="width:auto;padding:4px 10px;">执行测试</button>
                    </div>
                    <div id="lorecodex_status" class="lorecodex-status"></div>
                </div>
            </details>

            <details class="lorecodex-card">
                <summary style="cursor:pointer;font-weight:bold;font-size:0.88em;">旁路推理 Agent 模型配置（留空沿用服务端 config.json）</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <div>
                        <small>API Base URL (OpenAI 兼容)：</small>
                        <input id="lorecodex_chat_base" class="text_pole" type="text" value="${escHtml(cfg.chatBase || '')}" placeholder="https://api.openai.com/v1" />
                    </div>
                    <div>
                        <small>API Key：</small>
                        <input id="lorecodex_chat_key" class="text_pole" type="password" value="${escHtml(cfg.chatKey || '')}" placeholder="留空沿用服务端密钥" />
                    </div>
                    <div class="lorecodex-row">
                        <div style="flex:1;">
                            <small>模型名称：</small>
                            <input id="lorecodex_chat_model" class="text_pole" type="text" value="${escHtml(cfg.chatModel || '')}" list="lorecodex_model_list" />
                            <datalist id="lorecodex_model_list"></datalist>
                        </div>
                        <button id="lorecodex_fetch_models" class="menu_button" style="width:auto;margin-top:16px;padding:4px 8px;">拉取模型</button>
                    </div>
                    <button id="lorecodex_save_srv" class="menu_button" style="width:100%;">保存当前模型与默认书库到服务端</button>
                </div>
            </details>

            <details class="lorecodex-card">
                <summary style="cursor:pointer;font-size:0.86em;opacity:0.85;">高级覆盖：注入包装与数据库状态清洗正则</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <div>
                        <small>XML 标签名：</small>
                        <input id="lorecodex_xml_tag" class="text_pole" type="text" value="${escHtml(cfg.customXmlTag || '')}" placeholder="默认随当前语料 corpus.json" />
                    </div>
                    <div>
                        <small>注入导语 Header：</small>
                        <textarea id="lorecodex_header" class="text_pole" rows="2" placeholder="留空使用当前语料 prompt_framing.header"></textarea>
                    </div>
                    <div>
                        <small>事实优先级规则：</small>
                        <textarea id="lorecodex_priority_rule" class="text_pole" rows="2" placeholder="留空使用当前语料 prompt_framing.priority_rule"></textarea>
                    </div>
                    <div>
                        <small>追查指令尾注：</small>
                        <input id="lorecodex_followup_hint" class="text_pole" type="text" value="${escHtml(cfg.customFollowUpHint || '')}" placeholder="留空使用当前语料 follow_up_hint" />
                    </div>
                    <div>
                        <small>跳过样板条目正则（每行一条）：</small>
                        <textarea id="lorecodex_boiler_re" class="text_pole" rows="2" placeholder="留空使用当前语料 db_scrubber.boilerplate_patterns"></textarea>
                    </div>
                    <div>
                        <small>优先保留数据库摘要正则（每行一条）：</small>
                        <textarea id="lorecodex_summary_re" class="text_pole" rows="2" placeholder="留空使用当前语料 db_scrubber.summary_priority_patterns"></textarea>
                    </div>
                </div>
            </details>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    renderConnStatus(initialOk);
    renderCorpusDropdown();
    syncUiFromCfg();
    updateBindingLabel();
    refreshLegacyBanner();
    renderLastPreview(cfg);

    const bind = (sel, key, fn) => {
        $(sel).on('change input', function () {
            cfg[key] = fn ? fn($(this)) : $(this).val();
            saveSettingsDebounced();
        });
    };

    bind('#lorecodex_enabled', 'enabled', el => el.prop('checked'));
    bind('#lorecodex_server', 'ragServer');
    bind('#lorecodex_corpus', 'corpus');
    bind('#lorecodex_max_order', 'maxOrder', el => normalizeMaxOrder(el.val()));
    bind('#lorecodex_max_scenes', 'maxScenes', el => normalizeMaxScenes(el.val()));
    bind('#lorecodex_recent_turns', 'recentTurns', el => Math.max(1, Number(el.val()) || 5));
    bind('#lorecodex_depth', 'depth', el => Math.max(0, Number(el.val()) || 0));
    bind('#lorecodex_pov', 'pov');
    bind('#lorecodex_chat_base', 'chatBase');
    bind('#lorecodex_chat_key', 'chatKey');
    bind('#lorecodex_chat_model', 'chatModel');
    bind('#lorecodex_xml_tag', 'customXmlTag');
    bind('#lorecodex_header', 'customHeader');
    bind('#lorecodex_priority_rule', 'customPriorityRule');
    bind('#lorecodex_followup_hint', 'customFollowUpHint');
    bind('#lorecodex_boiler_re', 'customBoilerplateRegex');
    bind('#lorecodex_summary_re', 'customSummaryPriorityRegex');

    $('#lorecodex_migrate_btn').on('click', async () => {
        const old = extension_settings?.gf2_rag_bridge || {};
        if (old.ragServer) cfg.ragServer = old.ragServer;
        if (old.chatBase) cfg.chatBase = old.chatBase;
        if (old.chatKey) cfg.chatKey = old.chatKey;
        if (old.chatModel) cfg.chatModel = old.chatModel;
        if (old.depth !== undefined) cfg.depth = old.depth;
        if (old.recentTurns !== undefined) cfg.recentTurns = old.recentTurns;
        if (old.maxScenes !== undefined) cfg.maxScenes = normalizeMaxScenes(old.maxScenes);
        if (old.pov !== undefined) cfg.pov = old.pov;
        const ok = await fetchCorporaAndHealth(cfg);
        if (corporaMap.has('gf2')) cfg.corpus = 'gf2';
        cfg.enabled = true;

        if (extension_settings?.gf2_rag_bridge) {
            extension_settings.gf2_rag_bridge.enabled = false;
        }
        setExtensionPrompt('gf2_rag_context', '', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
        if ($('#gf2_rag_enabled').length) $('#gf2_rag_enabled').prop('checked', false);

        saveSettingsDebounced();
        renderConnStatus(ok);
        renderCorpusDropdown();
        syncUiFromCfg();
        refreshLegacyBanner();
        toastr.success('已迁移旧版 gf2-rag-bridge 配置并停用旧插件，避免双倍注入！');
    });

    $('#lorecodex_open_ui').on('click', () => {
        window.open(getServerBase(cfg), '_blank');
    });

    $('#lorecodex_refresh_corpora').on('click', async () => {
        const dot = $('#lorecodex_conn_dot');
        dot.removeClass('ok err').addClass('wait');
        $('#lorecodex_conn_text').text('正在刷新服务与书库...');
        try {
            await fetch(`${getServerBase(cfg)}/corpora/reload`, { method: 'POST' }).catch(() => null);
            const ok = await fetchCorporaAndHealth(cfg);
            renderConnStatus(ok);
            renderCorpusDropdown();
        } catch (_) {
            renderConnStatus(false);
        }
    });

    $('#lorecodex_bind_char').on('click', () => {
        const charKey = getActiveCharKey();
        if (!charKey) {
            toastr.warning('当前没有打开的角色卡对话');
            return;
        }
        cfg.charBindings[charKey] = {
            corpus: cfg.corpus || serverDefaultCorpus || '',
            maxOrder: normalizeMaxOrder(cfg.maxOrder),
            pov: cfg.pov || '',
        };
        saveSettingsDebounced();
        updateBindingLabel();
        toastr.success(`已为角色卡「${charKey}」绑定书库 ${cfg.charBindings[charKey].corpus}`);
    });

    $('#lorecodex_unbind_char').on('click', () => {
        const charKey = getActiveCharKey();
        if (charKey && cfg.charBindings[charKey]) {
            delete cfg.charBindings[charKey];
            saveSettingsDebounced();
            updateBindingLabel();
            toastr.info(`已解除「${charKey}」的专属绑定`);
        }
    });

    $('#lorecodex_fetch_models').on('click', async () => {
        const st = $('#lorecodex_status');
        st.text('正在拉取模型列表...');
        try {
            const r = await fetch(`${getServerBase(cfg)}/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: cfg.chatBase, apiKey: cfg.chatKey }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || 'failed');
            const dl = $('#lorecodex_model_list').empty();
            for (const m of j.models) dl.append(`<option value="${escHtml(m)}"></option>`);
            st.text(`已拉取 ${j.models.length} 个模型`);
        } catch (e) {
            st.text('拉取失败: ' + e.message);
        }
    });

    $('#lorecodex_save_srv').on('click', async () => {
        const st = $('#lorecodex_status');
        try {
            const body = buildApiConfig(cfg);
            if (cfg.corpus) body.defaultCorpus = cfg.corpus;
            const r = await fetch(`${getServerBase(cfg)}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const j = await r.json();
            st.text(j.ok ? '已保存配置到 LoreCodex 服务端 config.json' : ('保存失败: ' + j.error));
        } catch (e) {
            st.text('连接服务端失败: ' + e.message);
        }
    });

    $('#lorecodex_test_btn').on('click', async () => {
        const q = String($('#lorecodex_test_query').val() || '').trim();
        if (!q) {
            $('#lorecodex_status').text('请输入测试检索问题');
            return;
        }
        const st = $('#lorecodex_status');
        st.text('正在执行树形 Agent 检索...');
        try {
            const ctx = getContext();
            const r = await fetch(`${getServerBase(cfg)}/tree-search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    corpus: cfg.corpus || undefined,
                    query: q,
                    onDemand: q,
                    recentChat: collectRecentChat(ctx?.chat || [], cfg.recentTurns || 5),
                    sceneAnchor: { charName: ctx?.name2 || '', userName: ctx?.name1 || '指挥官', pov: cfg.pov || '' },
                    maxScenes: normalizeMaxScenes(cfg.maxScenes),
                    maxOrder: normalizeMaxOrder(cfg.maxOrder) || undefined,
                    pov: cfg.pov || '',
                    apiConfig: buildApiConfig(cfg),
                }),
            });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
            lastInjectionSnapshot = {
                corpus_id: j.corpus_id || cfg.corpus,
                corpus_name: j.corpus_name || cfg.corpus,
                skip: Boolean(j.skip),
                reason: j.reason || '',
                took_ms: j.took_ms,
                turns: j.turns,
                max_order: j.max_order,
                guide: j.guide || '',
                scenes: j.scenes || [],
                outlines: j.outlines || [],
                run_id: j.run_id || '',
                prompt_chars: (j.guide || '').length + (j.scenes || []).reduce((a, s) => a + (s.chars || 0), 0),
            };
            renderLastPreview(cfg);
            const lines = [
                `[${j.corpus_name || j.corpus_id}] 耗时: ${j.took_ms}ms | 轮次: ${j.turns} | skip=${j.skip}${j.max_order ? ' | 序<=' + j.max_order : ''}`,
            ];
            for (const t of j.trace || []) lines.push('  ' + t);
            if (j.guide) lines.push('导读: ' + j.guide);
            for (const s of j.scenes || []) lines.push(`[scene ${s.node_id} | ${s.arc_title}] ${s.title} (${s.chars}字)`);
            st.text(lines.join('\n'));
        } catch (e) {
            st.text('检索失败: ' + e.message);
        }
    });
});
