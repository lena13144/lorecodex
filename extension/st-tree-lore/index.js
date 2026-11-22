const stRootUrl = new URL(
    import.meta.url.includes('/scripts/extensions/')
        ? import.meta.url.slice(0, import.meta.url.indexOf('/scripts/extensions/') + 1)
        : '../../../../',
    import.meta.url,
);

const [
    {
        extension_prompt_types,
        extension_prompt_roles,
        saveSettingsDebounced,
        setExtensionPrompt,
        eventSource,
        event_types,
    },
    { extension_settings, getContext },
    { SlashCommand },
    { SlashCommandParser },
    {
        idbListCorpora,
        idbSaveCorpus,
        idbDeleteCorpus,
        idbGetMeta,
        idbSetMeta,
        idbRecordRun,
        decodeTextBufferAuto,
        extractEpubTextInBrowser,
        buildNovelCorpusInBrowser,
        buildLoreCorpusInBrowser,
        createBrowserTreeAgent,
        upgradeBrowserCorpusWithLLM,
    },
] = await Promise.all([
    import(new URL('script.js', stRootUrl).href),
    import(new URL('scripts/extensions.js', stRootUrl).href),
    import(new URL('scripts/slash-commands/SlashCommand.js', stRootUrl).href),
    import(new URL('scripts/slash-commands/SlashCommandParser.js', stRootUrl).href),
    import(new URL('browser_engine.js', import.meta.url).href),
]);

const MODULE_NAME = 'st_tree_lore';
const PROMPT_TAG = 'lorecodex_context';

const defaultSettings = {
    enabled: true,
    localMode: true,
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
    maxTokens: '',
    temperature: '',
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
let localPacksCache = [];
const localPacksMap = new Map();
const localAgentsCache = new Map();
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

function normalizeTemperature(val) {
    if (val === null || val === undefined || String(val).trim() === '') return '';
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 && n <= 2 ? n : '';
}

function optionalTempOrNull(val) {
    const v = normalizeTemperature(val);
    return v === '' ? null : v;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {
            ...defaultSettings,
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
        .replace(/<([a-z0-9_]+_source_reference)>[\s\S]*?<\/\1>/gi, '')
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
    const mt = Number(cfg.maxTokens);
    if (Number.isFinite(mt) && mt > 0) out.maxTokens = Math.floor(mt);
    const t = normalizeTemperature(cfg.temperature);
    if (t !== '') out.temperature = t;
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

let resolvedServerBase = '';

function getConfiguredServerBase(cfg) {
    return (cfg.ragServer || 'http://127.0.0.1:5240').trim().replace(/\/+$/, '');
}

function getServerBase(cfg) {
    return resolvedServerBase || getConfiguredServerBase(cfg);
}

function getLanFallbackBase(rawBase) {
    try {
        const u = new URL(rawBase);
        const h = u.hostname.toLowerCase();
        const pageHost = String(window?.location?.hostname || '').trim();
        const pageLower = pageHost.toLowerCase();
        if (
            pageHost &&
            (h === '127.0.0.1' || h === 'localhost') &&
            pageLower !== '127.0.0.1' &&
            pageLower !== 'localhost'
        ) {
            u.hostname = pageHost;
            return u.origin;
        }
    } catch (_) {}
    return '';
}

let onWorkbenchClosedHook = null;

function buildWorkbenchUrls(cfg, { runId = '', corpusId = '' } = {}) {
    const cid = String(corpusId || cfg.corpus || serverDefaultCorpus || '').trim();
    const useLocalUi = Boolean(cfg.localMode) || !lastHealthInfo?.ok || (cid && localPacksMap.has(cid) && !corporaCache.some(c => c.id === cid));
    const qEmbed = new URLSearchParams();
    qEmbed.set('embed', '1');
    if (useLocalUi) qEmbed.set('local', '1');
    if (cid) qEmbed.set('corpus', cid);
    const qStandalone = new URLSearchParams();
    if (useLocalUi) qStandalone.set('local', '1');
    if (cid) qStandalone.set('corpus', cid);
    const hash = runId ? `#run=${encodeURIComponent(runId)}` : '';
    const qsStandalone = qStandalone.toString();

    if (useLocalUi) {
        const localUiUrl = new URL('./ui/index.html', import.meta.url);
        const baseHref = localUiUrl.href.split('?')[0].split('#')[0];
        return {
            embedUrl: `${baseHref}?${qEmbed.toString()}${hash}`,
            standaloneUrl: `${baseHref}${qsStandalone ? '?' + qsStandalone : ''}${hash}`,
            isLocalUi: true,
        };
    }

    const base = getServerBase(cfg);
    return {
        embedUrl: `${base}/?${qEmbed.toString()}${hash}`,
        standaloneUrl: `${base}/${qsStandalone ? '?' + qsStandalone : ''}${hash}`,
        isLocalUi: false,
    };
}

function openWorkbenchModal(cfg, { runId = '', corpusId = '' } = {}) {
    if (cfg.chatBase || cfg.chatKey || cfg.chatModel) {
        idbSetMeta('local_api_config', {
            defaultCorpus: cfg.corpus || '',
            chatBase: cfg.chatBase || '',
            chatKey: cfg.chatKey || '',
            chatModel: cfg.chatModel || 'deepseek-chat',
            maxTokens: Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : null,
            temperature: optionalTempOrNull(cfg.temperature),
        }).catch(() => {});
    }
    const { embedUrl, standaloneUrl } = buildWorkbenchUrls(cfg, { runId, corpusId });
    const cid = String(corpusId || cfg.corpus || serverDefaultCorpus || '').trim();
    const cName = corporaMap.get(cid)?.name || cid || 'LoreCodex';

    let backdrop = $('#lorecodex_wb_modal');
    if (!backdrop.length) {
        const modalHtml = `
        <div id="lorecodex_wb_modal" class="lorecodex-wb-backdrop" role="dialog" aria-modal="true" aria-label="LoreCodex 工作台">
            <div class="lorecodex-wb-modal">
                <div class="lorecodex-wb-head">
                    <div class="lorecodex-wb-title">
                        <span>LoreCodex 典籍与追踪工作台</span>
                        <span id="lorecodex_wb_corpus_pill" class="lorecodex-pill accent"></span>
                    </div>
                    <div class="lorecodex-wb-actions">
                        <a id="lorecodex_wb_extlink" class="menu_button" target="_blank" rel="noopener" style="text-decoration:none;width:auto;padding:4px 10px;">新窗口打开</a>
                        <button type="button" id="lorecodex_wb_close" class="menu_button" style="width:auto;padding:4px 10px;">关闭</button>
                    </div>
                </div>
                <iframe id="lorecodex_wb_iframe" class="lorecodex-wb-frame" src="about:blank"></iframe>
            </div>
        </div>`;
        $('body').append(modalHtml);
        backdrop = $('#lorecodex_wb_modal');

        const closeModal = () => {
            if (!backdrop.hasClass('open')) return;
            backdrop.removeClass('open');
            $('#lorecodex_wb_iframe').attr('src', 'about:blank');
            if (typeof onWorkbenchClosedHook === 'function') {
                Promise.resolve(onWorkbenchClosedHook()).catch(() => {});
            }
        };

        $('#lorecodex_wb_close').on('click', closeModal);
        backdrop.on('click', (e) => {
            if (e.target === backdrop[0]) closeModal();
        });
        $(document).on('keydown.lorecodexWb', (e) => {
            if (e.key === 'Escape' && backdrop.hasClass('open')) closeModal();
        });
    }

    $('#lorecodex_wb_corpus_pill').text(cName);
    $('#lorecodex_wb_extlink').attr('href', standaloneUrl);
    $('#lorecodex_wb_iframe').attr('src', embedUrl);
    backdrop.addClass('open');
}

async function probeServerHealthAndCorpora(base) {
    const [hr, cr] = await Promise.all([
        fetch(`${base}/health`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`${base}/corpora`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return { hr, cr };
}

async function refreshLocalPacks() {
    try {
        let rows = await idbListCorpora();
        if (!rows.length) {
            try {
                const demoUrl = new URL('./ui/demo-chronicles.lorepack.json', import.meta.url).href;
                const r = await fetch(demoUrl);
                if (r.ok) {
                    const rawPack = await r.json();
                    const demoPack = buildLoreCorpusInBrowser({
                        rawJson: rawPack,
                        corpusId: rawPack.id || rawPack.corpus_id || 'demo-chronicles',
                        name: rawPack.corpus_name || rawPack.indexData?.corpus_name || '苍穹残响·灰烬星港编年史',
                    });
                    await idbSaveCorpus(demoPack);
                    rows = await idbListCorpora();
                }
            } catch (_) {}
        }
        localPacksCache = rows;
        localPacksMap.clear();
        localAgentsCache.clear();
        for (const p of rows) {
            localPacksMap.set(p.id, p);
        }
    } catch (e) {
        console.warn('[LoreCodex] IndexedDB unavailable:', e);
    }
}

function isUsingLocalEngine(cfg) {
    if (cfg.localMode) return true;
    if (!lastHealthInfo?.ok && localPacksMap.size > 0) return true;
    if (cfg.corpus && localPacksMap.has(cfg.corpus) && !corporaCache.some(c => c.id === cfg.corpus)) return true;
    return false;
}

function getLocalAgent(corpusId) {
    const id = String(corpusId || '').trim() || (localPacksCache[0]?.id || '');
    if (!id || !localPacksMap.has(id)) return null;
    if (!localAgentsCache.has(id)) {
        localAgentsCache.set(id, createBrowserTreeAgent(localPacksMap.get(id)));
    }
    return localAgentsCache.get(id);
}

async function fetchCorporaAndHealth(cfg) {
    await refreshLocalPacks();
    let srvOk = false;
    if (!cfg.localMode) {
        const primary = getConfiguredServerBase(cfg);
        try {
            let { hr, cr } = await probeServerHealthAndCorpora(primary);
            if (cr && hr?.ok) {
                resolvedServerBase = primary;
                srvOk = true;
            } else {
                const lanAlt = getLanFallbackBase(primary);
                if (lanAlt) {
                    const altRes = await probeServerHealthAndCorpora(lanAlt);
                    if (altRes.cr && altRes.hr?.ok) {
                        hr = altRes.hr;
                        cr = altRes.cr;
                        resolvedServerBase = lanAlt;
                        srvOk = true;
                    }
                }
            }
            lastHealthInfo = hr;
            if (cr) {
                corporaCache = Array.isArray(cr.corpora) ? cr.corpora : [];
                serverDefaultCorpus = String(cr.defaultCorpus || '');
            } else {
                corporaCache = [];
            }
        } catch (_) {
            lastHealthInfo = null;
            corporaCache = [];
        }
    } else {
        lastHealthInfo = null;
        corporaCache = [];
    }

    corporaMap.clear();
    if (!cfg.localMode) {
        for (const c of corporaCache) corporaMap.set(c.id, c);
    }
    for (const p of localPacksCache) {
        if (!corporaMap.has(p.id)) {
            const st = p.indexData?.stats || {
                arcs: (p.indexData?.arcs || []).length,
                scenes: Object.keys(p.textsData || {}).length,
                total_chars: 0,
            };
            corporaMap.set(p.id, {
                id: p.id,
                name: `${p.config?.name || p.id}`,
                stats: st,
                prompt_framing: p.config?.prompt_framing,
                db_scrubber: p.config?.db_scrubber,
                isLocal: true,
            });
        }
    }

    const allIds = [...corporaMap.keys()];
    if (allIds.length > 0 && (!cfg.corpus || !corporaMap.has(cfg.corpus))) {
        cfg.corpus = corporaMap.has(serverDefaultCorpus) ? serverDefaultCorpus : allIds[0];
        saveSettingsDebounced();
    }
    return srvOk;
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
    const { standaloneUrl } = buildWorkbenchUrls(cfg, {
        runId: snap.run_id || '',
        corpusId: snap.corpus_id || cfg.corpus,
    });

    box.html(`
        <div class="lorecodex-row" style="justify-content:space-between;">
            <div class="lorecodex-row" style="gap:5px;">
                ${statusPill}
                <span class="lorecodex-pill">${escHtml(snap.corpus_name || snap.corpus_id || '-')}</span>
                ${orderPill}
            </div>
            <span class="lorecodex-muted">${snap.took_ms ?? 0}ms · ${snap.turns ?? 0}轮</span>
        </div>
        ${snap.skip ? `<div class="lorecodex-muted">原因：${escHtml(snap.reason || '无命中')}</div>` : `
            ${snap.guide ? `<details style="font-size:0.84em;"><summary style="cursor:pointer;">记忆导读（${snap.prompt_chars || 0} 字符）</summary><div style="margin-top:5px;line-height:1.5;white-space:pre-line;">${escHtml(snap.guide)}</div></details>` : ''}
            ${scenesHtml ? `<div class="lorecodex-preview-scenes">${scenesHtml}</div>` : ''}
        `}
        <div class="lorecodex-row">
            <button type="button" id="lorecodex_preview_open_wb" class="menu_button" style="flex:1;">在酒馆内查看完整轨迹</button>
            <a href="${escHtml(standaloneUrl)}" target="_blank" rel="noopener" class="menu_button" style="text-decoration:none;width:auto;padding:4px 9px;">新窗口</a>
        </div>
    `);
    $('#lorecodex_preview_open_wb').on('click', () =>
        openWorkbenchModal(cfg, { runId: snap.run_id || '', corpusId: snap.corpus_id || cfg.corpus })
    );
}

async function executeTreeSearchRequest(cfg, payload) {
    const cid = payload.corpus || cfg.corpus || serverDefaultCorpus || '';
    if (isUsingLocalEngine(cfg) || (cid && localPacksMap.has(cid) && !corporaCache.some(c => c.id === cid))) {
        const localAgent = getLocalAgent(cid);
        if (!localAgent) {
            throw new Error(`内置免服务端引擎中尚未导入书库 "${cid || '空'}"，请在下方「免服务端内置书库管理」导入小说或世界书`);
        }
        const out = await localAgent.search(payload, buildApiConfig(cfg));
        const run = await idbRecordRun(payload, out).catch(() => null);
        return run ? { ...out, run_id: run.id } : out;
    }
    const server = getServerBase(cfg);
    const resp = await fetch(`${server}/tree-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${resp.status}`);
    }
    return await resp.json();
}

async function runTreeRetrieval(cfg, ctx, chat, entryTexts, { query, onDemand, dbRecallHints, clear }) {
    const depth = Number.isFinite(Number(cfg.depth)) ? Number(cfg.depth) : 1;
    const recentChat = collectRecentChat(chat, cfg.recentTurns || 5);
    const corpusId = (cfg.corpus || serverDefaultCorpus || '').trim();
    const corpusMeta = corporaMap.get(corpusId) || null;
    const activeStateHints = buildActiveStateHints(entryTexts, dbRecallHints, corpusMeta, cfg);
    const maxOrder = normalizeMaxOrder(cfg.maxOrder);

    let data;
    try {
        data = await executeTreeSearchRequest(cfg, {
            corpus: corpusId || undefined,
            query,
            onDemand,
            recentChat,
            sceneAnchor: {
                charName: ctx?.name2 || '',
                userName: ctx?.name1 || '旅人',
                pov: cfg.pov || '',
            },
            activeStateHints,
            maxScenes: normalizeMaxScenes(cfg.maxScenes),
            maxOrder: maxOrder || undefined,
            pov: cfg.pov || '',
            apiConfig: buildApiConfig(cfg),
        });
    } catch (err) {
        const errMsg = err?.message || String(err);
        console.warn('[LoreCodex] tree-search failed:', errMsg);
        clear();
        lastInjectionSnapshot = {
            corpus_id: corpusId,
            corpus_name: corpusMeta?.name || corpusId,
            skip: true,
            reason: `检索请求异常: ${errMsg}`,
            took_ms: 0,
            turns: 0,
            max_order: maxOrder || null,
            run_id: '',
            scenes: [],
            outlines: [],
        };
        renderLastPreview(cfg);
        if (typeof toastr !== 'undefined') toastr.warning(`LoreCodex 检索失败: ${errMsg}`);
        return;
    }
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
        clear();
        const cid = (cfg.corpus || serverDefaultCorpus || '').trim();
        lastInjectionSnapshot = {
            corpus_id: cid,
            corpus_name: corporaMap.get(cid)?.name || cid,
            skip: true,
            reason: `连接服务端失败: ${err?.message || err}`,
            took_ms: 0,
            turns: 0,
            max_order: normalizeMaxOrder(cfg.maxOrder) || null,
            run_id: '',
            scenes: [],
            outlines: [],
        };
        renderLastPreview(cfg);
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
        $('#lorecodex_local_mode').prop('checked', Boolean(cfg.localMode));
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
        $('#lorecodex_max_tokens').val(Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : '');
        $('#lorecodex_temperature').val(normalizeTemperature(cfg.temperature));
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
        const isTauri = typeof window !== 'undefined' && (Boolean(window.__TAURITAVERN__) || Boolean(window.__TAURI_INTERNALS__));
        const tauriTag = isTauri ? ' · TauriTavern' : '';
        if (!cfg.localMode && ok && lastHealthInfo?.ok) {
            dot.addClass('ok');
            txt.text(`已连接外部服务端${tauriTag} · ${corporaCache.length} 个服务端书库 · ${lastHealthInfo.boot_ms ?? '-'}ms`);
        } else if (cfg.localMode || localPacksCache.length > 0) {
            dot.addClass('ok');
            txt.text(`内置书阁引擎就绪 (IndexedDB 免后台)${tauriTag} · 已挂载 ${localPacksCache.length} 个典籍`);
        } else {
            dot.addClass('err');
            txt.text(`未连接到外部服务端 ${getServerBase(cfg)}（建议勾选纯前端免后台模式）`);
        }
    };

    const renderLocalSeriesOptions = () => {
        const sel = $('#lorecodex_local_upg_series').empty();
        const pack = localPacksMap.get(cfg.corpus);
        if (!pack) {
            sel.append('<option value="">（请先选择或导入一个内置书库）</option>');
            return;
        }
        const arcs = pack.indexData?.arcs || [];
        const totalDone = arcs.filter((a) => a._llm_done).length;
        sel.append(`<option value="">全部章节 (${totalDone}/${arcs.length} 章已构建 LLM 目录)</option>`);
        const seriesMap = new Map();
        for (const a of arcs) {
            const sk = String(a.series || a.category || '默认分卷').trim();
            if (!seriesMap.has(sk)) seriesMap.set(sk, { total: 0, done: 0 });
            const st = seriesMap.get(sk);
            st.total += 1;
            if (a._llm_done) st.done += 1;
        }
        for (const [sk, st] of seriesMap.entries()) {
            sel.append(`<option value="${escHtml(sk)}">${escHtml(sk)} (${st.done}/${st.total} 章已构建)</option>`);
        }
    };

    const renderCorpusDropdown = () => {
        const sel = $('#lorecodex_corpus').empty();
        const entries = [...corporaMap.values()];
        if (!entries.length) {
            sel.append(`<option value="${escHtml(cfg.corpus || '')}">${escHtml(cfg.corpus || '（请连接服务端或在下方导入内置书库）')}</option>`);
            renderLocalSeriesOptions();
            return;
        }
        for (const c of entries) {
            const llmTag = c.stats?.llm_arcs ? ` · LLM:${c.stats.llm_arcs}章` : '';
            sel.append(`<option value="${escHtml(c.id)}">${escHtml(c.name)} (${c.stats?.arcs || 0}卷 / ${c.stats?.scenes || 0}幕${llmTag})</option>`);
        }
        if (cfg.corpus && corporaMap.has(cfg.corpus)) sel.val(cfg.corpus);
        renderLocalSeriesOptions();
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'loreui',
        returns: '打开 LoreCodex 内嵌工作台',
        callback: () => {
            openWorkbenchModal(cfg);
            return 'opened';
        },
        helpString: '在 SillyTavern 内全屏打开 LoreCodex 典籍与轨迹工作台：/loreui',
    }));

    const syncConfigFromServer = async ({ overwriteExisting = false } = {}) => {
        if (cfg.localMode) {
            const localCfg = await idbGetMeta('local_api_config', null);
            if (localCfg && typeof localCfg === 'object') {
                if ((overwriteExisting || !cfg.chatBase) && localCfg.chatBase) cfg.chatBase = localCfg.chatBase;
                if ((overwriteExisting || !cfg.chatKey) && localCfg.chatKey && !/^\*+$/.test(localCfg.chatKey)) cfg.chatKey = localCfg.chatKey;
                if ((overwriteExisting || !cfg.chatModel) && localCfg.chatModel) cfg.chatModel = localCfg.chatModel;
                if (overwriteExisting) {
                    cfg.maxTokens = Number(localCfg.maxTokens) > 0 ? Number(localCfg.maxTokens) : '';
                    cfg.temperature = normalizeTemperature(localCfg.temperature);
                } else {
                    if ((cfg.maxTokens === '' || cfg.maxTokens === undefined || cfg.maxTokens === null) && Number(localCfg.maxTokens) > 0) {
                        cfg.maxTokens = Number(localCfg.maxTokens);
                    }
                    if (normalizeTemperature(cfg.temperature) === '' && normalizeTemperature(localCfg.temperature) !== '') {
                        cfg.temperature = normalizeTemperature(localCfg.temperature);
                    }
                }
            }
            return;
        }
        try {
            const r = await fetch(`${getServerBase(cfg)}/config`);
            if (!r.ok) return;
            const srvCfg = await r.json();
            if (!cfg.chatKey && srvCfg.chatKey && !/^\*+$/.test(srvCfg.chatKey)) cfg.chatKey = srvCfg.chatKey;
            if ((overwriteExisting || !cfg.chatBase) && srvCfg.chatBase) cfg.chatBase = srvCfg.chatBase;
            if ((overwriteExisting || !cfg.chatModel) && srvCfg.chatModel) cfg.chatModel = srvCfg.chatModel;
            if (overwriteExisting) {
                cfg.maxTokens = Number(srvCfg.maxTokens) > 0 ? Number(srvCfg.maxTokens) : '';
                cfg.temperature = normalizeTemperature(srvCfg.temperature);
            } else {
                if ((cfg.maxTokens === '' || cfg.maxTokens === undefined || cfg.maxTokens === null) && Number(srvCfg.maxTokens) > 0) {
                    cfg.maxTokens = Number(srvCfg.maxTokens);
                }
                if (normalizeTemperature(cfg.temperature) === '' && normalizeTemperature(srvCfg.temperature) !== '') {
                    cfg.temperature = normalizeTemperature(srvCfg.temperature);
                }
            }
        } catch (_) {}
    };

    const syncConfigToServer = async ({ silent = false } = {}) => {
        const st = $('#lorecodex_model_status');
        await idbSetMeta('local_api_config', {
            defaultCorpus: cfg.corpus || '',
            chatBase: cfg.chatBase || '',
            chatKey: cfg.chatKey || '',
            chatModel: cfg.chatModel || 'deepseek-chat',
            maxTokens: Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : null,
            temperature: optionalTempOrNull(cfg.temperature),
        }).catch(() => {});

        if (cfg.localMode || !lastHealthInfo?.ok) {
            if (!silent) {
                st.text('已保存模型配置到浏览器内置书阁 (IndexedDB)');
                if (typeof toastr !== 'undefined') toastr.success('已保存模型配置');
            }
            return true;
        }
        try {
            const body = buildApiConfig(cfg);
            body.maxTokens = Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : null;
            body.temperature = optionalTempOrNull(cfg.temperature);
            if (cfg.corpus) body.defaultCorpus = cfg.corpus;
            const r = await fetch(`${getServerBase(cfg)}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const j = await r.json();
            if (!silent) {
                st.text(j.ok ? '已保存配置到内置书阁与外部服务端 config.json' : ('保存失败: ' + j.error));
                if (j.ok && typeof toastr !== 'undefined') toastr.success('已保存模型配置到服务端');
            }
            return Boolean(j.ok);
        } catch (e) {
            if (!silent) st.text('已保存到本地内置书阁（外部服务端未连接）');
            return false;
        }
    };

    await syncConfigFromServer();

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>LoreCodex 树形典籍检索 (st-tree-lore)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content lorecodex-drawer">
            <div class="lorecodex-card">
                <div class="lorecodex-conn-bar">
                    <div class="lorecodex-conn-left">
                        <span id="lorecodex_conn_dot" class="lorecodex-dot wait"></span>
                        <span id="lorecodex_conn_text" class="lorecodex-conn-text">正在初始化内置书阁...</span>
                    </div>
                    <button id="lorecodex_open_ui" class="menu_button" style="width:auto;padding:3px 9px;">打开书阁</button>
                </div>
                <label class="checkbox_label">
                    <input id="lorecodex_enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''} />
                    <span><b>启用生成前树形记忆检索注入</b></span>
                </label>
                <div class="lorecodex-row">
                    <div style="flex:1;min-width:160px;">
                        <small>当前挂载典籍书库：</small>
                        <select id="lorecodex_corpus" class="text_pole"></select>
                    </div>
                    <button id="lorecodex_refresh_corpora" class="menu_button" style="width:auto;margin-top:16px;padding:4px 10px;">刷新书库</button>
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

            <details class="lorecodex-card" open>
                <summary style="cursor:pointer;font-weight:bold;font-size:0.88em;">典籍书库导入与 LLM 目录构建（纯前端免后台 · 支持 TXT / EPUB / 世界书 / 角色卡）</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <div class="lorecodex-muted">支持直接选择小说 (<b>.txt</b> 自动识别 UTF-8/GB18030、<b>.epub</b>、<b>.md</b>)、世界书/V2角色卡 (<b>.json</b>) 或单文件书库包 (<b>.lorepack.json</b>) 存入浏览器 IndexedDB。<b>三层树检索依赖高质量 LLM 目录摘要与人物别名表，导入原始小说后请执行 LLM 智能目录构建（支持按卷构建与断点续传）。</b></div>
                    <input id="lorecodex_local_file" class="text_pole" type="file" accept=".txt,.md,.epub,.json" />
                    <div class="lorecodex-row">
                        <div style="flex:1;">
                            <small>书库 ID（英文/数字/连字符）：</small>
                            <input id="lorecodex_local_id" class="text_pole" type="text" placeholder="my-book" />
                        </div>
                        <div style="flex:1;">
                            <small>书库显示名称：</small>
                            <input id="lorecodex_local_name" class="text_pole" type="text" placeholder="例如：才不是魔女" />
                        </div>
                    </div>
                    <label class="checkbox_label">
                        <input id="lorecodex_local_auto_llm" type="checkbox" checked />
                        <span>导入后立即启动 LLM 智能目录构建（自动生成分幕摘要、卷总览、人物别名与术语表）</span>
                    </label>
                    <div class="lorecodex-row">
                        <button id="lorecodex_local_import_btn" type="button" class="menu_button" style="flex:2;">导入并建树到书阁</button>
                        <button id="lorecodex_local_export_btn" type="button" class="menu_button" style="flex:1;">导出 .lorepack</button>
                        <button id="lorecodex_local_delete_btn" type="button" class="menu_button" style="width:auto;padding:4px 8px;">删除</button>
                    </div>
                    <div style="border-top:1px solid rgba(128,128,128,0.25);padding-top:6px;margin-top:2px;display:flex;flex-direction:column;gap:6px;">
                        <div style="font-weight:bold;font-size:0.84em;">当前书库 LLM 目录构建 / 原地补全（支持 IndexedDB 断点续传）</div>
                        <div class="lorecodex-row">
                            <div style="flex:2;min-width:140px;">
                                <small>目标分卷（推荐按卷逐卷构建）：</small>
                                <select id="lorecodex_local_upg_series" class="text_pole">
                                    <option value="">全部未完成章节</option>
                                </select>
                            </div>
                            <div style="flex:1;min-width:70px;">
                                <small>并发数：</small>
                                <input id="lorecodex_local_upg_workers" class="text_pole" type="number" min="1" max="12" value="4" />
                            </div>
                            <div style="flex:1;min-width:80px;" title="0 = 所选分卷全部章节">
                                <small>本批章数(0全卷)：</small>
                                <input id="lorecodex_local_upg_limit" class="text_pole" type="number" min="0" value="0" />
                            </div>
                        </div>
                        <div class="lorecodex-row">
                            <button id="lorecodex_local_upg_btn" type="button" class="menu_button" style="flex:2;">开始 / 继续 LLM 目录构建</button>
                            <button id="lorecodex_local_upg_stop_btn" type="button" class="menu_button" style="flex:1;display:none;">暂停并保存进度</button>
                        </div>
                    </div>
                    <div id="lorecodex_local_status" class="lorecodex-status"></div>
                </div>
            </details>

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
                <summary style="cursor:pointer;font-weight:bold;font-size:0.88em;">旁路推理 Agent 模型配置</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <div>
                        <small>API Base URL (OpenAI 兼容)：</small>
                        <input id="lorecodex_chat_base" class="text_pole" type="text" value="${escHtml(cfg.chatBase || '')}" placeholder="https://api.openai.com/v1" />
                    </div>
                    <div>
                        <small>API Key：</small>
                        <input id="lorecodex_chat_key" class="text_pole" type="password" value="${escHtml(cfg.chatKey || '')}" placeholder="填入用于旁路翻树与建库的 API Key" />
                    </div>
                    <div class="lorecodex-row">
                        <div style="flex:1;">
                            <small>模型名称：</small>
                            <input id="lorecodex_chat_model" class="text_pole" type="text" value="${escHtml(cfg.chatModel || '')}" placeholder="可手动输入或点击右侧拉取后在下拉框选择" />
                        </div>
                        <button id="lorecodex_fetch_models" class="menu_button" style="width:auto;margin-top:16px;padding:4px 8px;">拉取模型</button>
                    </div>
                    <select id="lorecodex_model_select" class="text_pole" style="display:none;"></select>
                    <div style="display:flex;gap:8px;">
                        <div style="flex:1;">
                            <small>Max Tokens（留空 = 默认）：</small>
                            <input id="lorecodex_max_tokens" class="text_pole" type="number" min="0" step="256" value="${Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : ''}" placeholder="沿用模型默认" />
                        </div>
                        <div style="flex:1;">
                            <small>Temperature（留空 = 不传）：</small>
                            <input id="lorecodex_temperature" class="text_pole" type="number" min="0" max="2" step="0.1" value="${normalizeTemperature(cfg.temperature)}" placeholder="沿用模型默认（留空不传）" />
                        </div>
                    </div>
                    <button id="lorecodex_save_srv" class="menu_button" style="width:100%;">保存当前模型与默认书库配置</button>
                    <div id="lorecodex_model_status" class="lorecodex-status"></div>
                </div>
            </details>

            <details class="lorecodex-card">
                <summary style="cursor:pointer;font-size:0.86em;opacity:0.85;">高级可选：连接外部独立 Node 服务端 & 注入包装正则</summary>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                    <label class="checkbox_label">
                        <input id="lorecodex_local_mode" type="checkbox" ${cfg.localMode ? 'checked' : ''} />
                        <span><b>使用纯前端免后台引擎（默认推荐；取消勾选则连接下方外部 Node 服务端）</b></span>
                    </label>
                    <div>
                        <small>外部 Node 服务端地址（仅在取消上方勾选、需与电脑本地磁盘 corpora/ 或 MCP 共享时使用）：</small>
                        <input id="lorecodex_server" class="text_pole" type="text" value="${escHtml(cfg.ragServer)}" />
                    </div>
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
    renderLastPreview(cfg);

    const bind = (sel, key, fn) => {
        $(sel).on('change input', function () {
            cfg[key] = fn ? fn($(this)) : $(this).val();
            saveSettingsDebounced();
        });
    };

    bind('#lorecodex_enabled', 'enabled', el => el.prop('checked'));
    $('#lorecodex_local_mode').on('change', async function () {
        cfg.localMode = $(this).prop('checked');
        saveSettingsDebounced();
        const ok = await fetchCorporaAndHealth(cfg);
        renderConnStatus(ok);
        renderCorpusDropdown();
    });

    $('#lorecodex_local_file').on('change', function (e) {
        const f = e.target.files?.[0];
        if (!f) return;
        const stem = f.name.replace(/\.lorepack\.json$/i, '').replace(/\.[^.]+$/, '');
        const slug = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'local-book';
        if (!$('#lorecodex_local_id').val().trim()) $('#lorecodex_local_id').val(slug);
        if (!$('#lorecodex_local_name').val().trim()) $('#lorecodex_local_name').val(stem);
    });

    let localUpgAbortCtrl = null;

    const runLocalLlmUpgrade = async (targetCorpusId) => {
        const st = $('#lorecodex_local_status');
        const pack = localPacksMap.get(targetCorpusId);
        if (!pack) {
            st.text(`内置书库 "${targetCorpusId}" 不存在（请先导入或选中一个内置书库）`);
            return;
        }
        const apiCfg = buildApiConfig(cfg);
        if (!apiCfg.chatBase || !apiCfg.chatKey) {
            st.text('请先在下方「旁路推理 Agent 模型配置」填写 API Base URL 与 API Key 后再启动 LLM 目录构建');
            if (typeof toastr !== 'undefined') toastr.warning('请先填写旁路推理 API Base URL 与 API Key');
            return;
        }
        if (localUpgAbortCtrl) {
            st.text('LLM 目录构建正在进行中...');
            return;
        }
        const series = String($('#lorecodex_local_upg_series').val() || '').trim();
        const workers = Math.min(Math.max(Number($('#lorecodex_local_upg_workers').val()) || 4, 1), 12);
        const limitArcs = Math.max(0, Number($('#lorecodex_local_upg_limit').val()) || 0);

        localUpgAbortCtrl = new AbortController();
        $('#lorecodex_local_upg_btn').prop('disabled', true);
        $('#lorecodex_local_upg_stop_btn').show();
        st.text(`正在启动「${pack.config.name}」LLM 目录构建 (并发=${workers}${series ? `, 分卷=${series}` : ''})...`);

        try {
            const res = await upgradeBrowserCorpusWithLLM(pack, apiCfg, {
                series,
                workers,
                limitArcs,
                signal: localUpgAbortCtrl.signal,
                onProgress(prog) {
                    if (prog.phase === 'series_meta') {
                        st.text(`正在提炼「${prog.series}」全卷大纲、人物别名对照表与专有术语...`);
                    } else {
                        st.text(`LLM 目录构建中：已完成 ${prog.done}/${prog.total} 章 (${prog.series ? prog.series + ' · ' : ''}${prog.arcTitle}) [进度已实时写入 IndexedDB]`);
                    }
                },
                async onSave(updatedPack) {
                    await idbSaveCorpus(updatedPack);
                    localAgentsCache.delete(updatedPack.id);
                },
            });
            await idbSaveCorpus(pack);
            localAgentsCache.delete(pack.id);
            const ok = await fetchCorporaAndHealth(cfg);
            renderConnStatus(ok);
            renderCorpusDropdown();
            if (res.message) {
                st.text(res.message);
            } else {
                const msg = `LLM 目录构建完成：升级 ${res.upgradedArcs} 章 / ${res.upgradedScenes} 幕，合成 ${res.synthesizedSeries} 卷总览，累计 ${res.aliasesCount} 组人物别名、${res.glossaryCount} 条术语`;
                st.text(msg);
                if (typeof toastr !== 'undefined') toastr.success(msg);
            }
        } catch (err) {
            await idbSaveCorpus(pack).catch(() => {});
            localAgentsCache.delete(pack.id);
            await fetchCorporaAndHealth(cfg);
            renderCorpusDropdown();
            const errMsg = err?.message || String(err);
            st.text(`LLM 构建已中断（已完成章节均已保存在 IndexedDB，可随时点击继续）: ${errMsg}`);
            if (typeof toastr !== 'undefined') toastr.info(`LLM 构建已暂停/中断: ${errMsg}`);
        } finally {
            localUpgAbortCtrl = null;
            $('#lorecodex_local_upg_btn').prop('disabled', false);
            $('#lorecodex_local_upg_stop_btn').hide();
        }
    };

    $('#lorecodex_local_upg_btn').on('click', () => runLocalLlmUpgrade(cfg.corpus));
    $('#lorecodex_local_upg_stop_btn').on('click', () => {
        if (localUpgAbortCtrl) localUpgAbortCtrl.abort();
    });

    $('#lorecodex_local_import_btn').on('click', async () => {
        const fileEl = $('#lorecodex_local_file')[0];
        const file = fileEl?.files?.[0];
        const st = $('#lorecodex_local_status');
        if (!file) {
            st.text('请先选择一个 .txt / .md / .epub / .json / .lorepack.json 文件');
            return;
        }
        const cid = ($('#lorecodex_local_id').val().trim() || 'local-book').replace(/[^a-zA-Z0-9_-]/g, '-');
        const cName = $('#lorecodex_local_name').val().trim() || cid;
        const autoLlm = $('#lorecodex_local_auto_llm').prop('checked');
        st.text(`正在浏览器内读取并切分「${cName}」...`);
        try {
            const ab = await file.arrayBuffer();
            const fnameLower = file.name.toLowerCase();
            const isEpub = fnameLower.endsWith('.epub');
            const isJson = fnameLower.endsWith('.json') || fnameLower.endsWith('.jsonl');
            const isLorepack = fnameLower.endsWith('.lorepack.json');
            const text = isEpub ? await extractEpubTextInBrowser(ab) : decodeTextBufferAuto(ab);
            const pack = isJson
                ? buildLoreCorpusInBrowser({
                      rawJson: text,
                      corpusId: cid,
                      name: cName,
                      existingPack: localPacksMap.get(cid) || null,
                  })
                : buildNovelCorpusInBrowser({
                      rawText: text,
                      corpusId: cid,
                      name: cName,
                  });
            await idbSaveCorpus(pack);
            cfg.corpus = pack.id;
            saveSettingsDebounced();
            const ok = await fetchCorporaAndHealth(cfg);
            renderConnStatus(ok);
            renderCorpusDropdown();
            const stats = pack.indexData?.stats || {};
            st.text(`已存入浏览器 IndexedDB：${pack.config.name} (${stats.arcs || 0}卷 / ${stats.scenes || 0}幕 / ${(stats.total_chars || 0).toLocaleString()}字)`);
            if (typeof toastr !== 'undefined') toastr.success(`本地书库「${pack.config.name}」切分入库完成`);

            if (autoLlm && !isLorepack) {
                const apiCfg = buildApiConfig(cfg);
                if (apiCfg.chatBase && apiCfg.chatKey) {
                    await runLocalLlmUpgrade(pack.id);
                } else {
                    st.text(`已切分入库 (${stats.arcs || 0}章)。请先在下方填写旁路 API Base URL 与 API Key，再点击「开始 / 继续 LLM 目录构建」补全目录摘要与别名表。`);
                }
            }
        } catch (err) {
            st.text('本地建树失败: ' + (err?.message || err));
            if (typeof toastr !== 'undefined') toastr.error('本地建树失败: ' + (err?.message || err));
        }
    });

    $('#lorecodex_local_export_btn').on('click', () => {
        const cid = cfg.corpus;
        const pack = localPacksMap.get(cid);
        const st = $('#lorecodex_local_status');
        if (!pack) {
            if (!isUsingLocalEngine(cfg) && cid) {
                window.open(`${getServerBase(cfg)}/corpora/${encodeURIComponent(cid)}/export`, '_blank');
                return;
            }
            st.text('当前选中的书库不在本地 IndexedDB 中');
            return;
        }
        const blob = new Blob([JSON.stringify({ format: 'lorecodex-pack-v2', ...pack })], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${pack.id}.lorepack.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        st.text(`已导出 ${pack.id}.lorepack.json`);
    });

    $('#lorecodex_local_delete_btn').on('click', async () => {
        const cid = cfg.corpus;
        const st = $('#lorecodex_local_status');
        if (!localPacksMap.has(cid)) {
            st.text(`书库 "${cid}" 不是本地 IndexedDB 书库`);
            return;
        }
        await idbDeleteCorpus(cid);
        cfg.corpus = '';
        saveSettingsDebounced();
        const ok = await fetchCorporaAndHealth(cfg);
        renderConnStatus(ok);
        renderCorpusDropdown();
        st.text(`已从浏览器 IndexedDB 删除本地书库 "${cid}"`);
    });
    bind('#lorecodex_server', 'ragServer');
    $('#lorecodex_corpus').on('change input', function () {
        cfg.corpus = $(this).val();
        saveSettingsDebounced();
        renderLocalSeriesOptions();
    });
    bind('#lorecodex_max_order', 'maxOrder', el => normalizeMaxOrder(el.val()));
    bind('#lorecodex_max_scenes', 'maxScenes', el => normalizeMaxScenes(el.val()));
    bind('#lorecodex_recent_turns', 'recentTurns', el => Math.max(1, Number(el.val()) || 5));
    bind('#lorecodex_depth', 'depth', el => Math.max(0, Number(el.val()) || 0));
    bind('#lorecodex_pov', 'pov');
    bind('#lorecodex_chat_base', 'chatBase');
    bind('#lorecodex_chat_key', 'chatKey');
    bind('#lorecodex_chat_model', 'chatModel');
    bind('#lorecodex_max_tokens', 'maxTokens', el => {
        const n = Number(el.val());
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : '';
    });
    bind('#lorecodex_temperature', 'temperature', el => normalizeTemperature(el.val()));
    bind('#lorecodex_xml_tag', 'customXmlTag');
    bind('#lorecodex_header', 'customHeader');
    bind('#lorecodex_priority_rule', 'customPriorityRule');
    bind('#lorecodex_followup_hint', 'customFollowUpHint');
    bind('#lorecodex_boiler_re', 'customBoilerplateRegex');
    bind('#lorecodex_summary_re', 'customSummaryPriorityRegex');

    onWorkbenchClosedHook = async () => {
        const ok = await fetchCorporaAndHealth(cfg);
        if (ok && !cfg.localMode) {
            await syncConfigFromServer({ overwriteExisting: true });
        } else {
            const localCfg = await idbGetMeta('local_api_config', null);
            if (localCfg && typeof localCfg === 'object') {
                if (localCfg.chatBase) cfg.chatBase = localCfg.chatBase;
                if (localCfg.chatKey && !/^\*+$/.test(localCfg.chatKey)) cfg.chatKey = localCfg.chatKey;
                if (localCfg.chatModel) cfg.chatModel = localCfg.chatModel;
                if (localCfg.defaultCorpus && corporaMap.has(localCfg.defaultCorpus)) cfg.corpus = localCfg.defaultCorpus;
                cfg.maxTokens = Number(localCfg.maxTokens) > 0 ? Number(localCfg.maxTokens) : '';
                cfg.temperature = normalizeTemperature(localCfg.temperature);
            }
        }
        saveSettingsDebounced();
        renderConnStatus(ok);
        renderCorpusDropdown();
        syncUiFromCfg();
        updateBindingLabel();
    };

    $('#lorecodex_open_ui').on('click', () => {
        openWorkbenchModal(cfg);
    });

    $('#lorecodex_server').on('change', async () => {
        resolvedServerBase = '';
        const ok = await fetchCorporaAndHealth(cfg);
        renderConnStatus(ok);
        renderCorpusDropdown();
    });

    $('#lorecodex_refresh_corpora').on('click', async () => {
        const dot = $('#lorecodex_conn_dot');
        dot.removeClass('ok err').addClass('wait');
        $('#lorecodex_conn_text').text('正在刷新服务与书库...');
        try {
            resolvedServerBase = '';
            await fetch(`${getServerBase(cfg)}/corpora/reload`, { method: 'POST' }).catch(() => null);
            const ok = await fetchCorporaAndHealth(cfg);
            await syncConfigFromServer();
            renderConnStatus(ok);
            renderCorpusDropdown();
            syncUiFromCfg();
            updateBindingLabel();
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

    $('#lorecodex_chat_model').on('input', function () {
        const val = String($(this).val() || '').trim();
        const sel = $('#lorecodex_model_select');
        if (sel.is(':visible')) {
            const hasOpt = sel.find('option').toArray().some(o => o.value === val);
            sel.val(hasOpt ? val : '');
        }
    });

    $('#lorecodex_model_select').on('change', async function () {
        const picked = String($(this).val() || '').trim();
        if (!picked) return;
        cfg.chatModel = picked;
        $('#lorecodex_chat_model').val(picked);
        saveSettingsDebounced();
        const synced = await syncConfigToServer({ silent: true });
        $('#lorecodex_model_status').text(
            synced
                ? `已切换模型为：${picked}（已自动同步到服务端 config.json）`
                : `已选择模型：${picked}（本地已生效）`
        );
    });

    $('#lorecodex_fetch_models').on('click', async () => {
        const btn = $('#lorecodex_fetch_models');
        const st = $('#lorecodex_model_status');
        btn.prop('disabled', true);
        st.text('正在拉取模型列表...');
        try {
            let models = [];
            if (!isUsingLocalEngine(cfg) && lastHealthInfo?.ok) {
                const r = await fetch(`${getServerBase(cfg)}/models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ baseUrl: cfg.chatBase, apiKey: cfg.chatKey }),
                });
                const j = await r.json();
                if (!j.ok) throw new Error(j.error || 'failed');
                models = Array.isArray(j.models) ? j.models : [];
            } else {
                const cleanBase = String(cfg.chatBase || '')
                    .trim()
                    .replace(/\/+$/, '')
                    .replace(/\/(?:chat\/completions|models)$/i, '')
                    .replace(/\/+$/, '');
                if (!cleanBase || !cfg.chatKey) {
                    throw new Error('请先填写 API Base URL 与 API Key');
                }
                const r = await fetch(`${cleanBase}/models`, {
                    headers: { Authorization: `Bearer ${cfg.chatKey.trim()}` },
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const j = await r.json();
                const rawList = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
                models = [
                    ...new Set(
                        rawList
                            .map((x) => (typeof x === 'string' ? x : x?.id || String(x?.name || '').replace(/^models\//, '')))
                            .map((s) => String(s || '').trim())
                            .filter(Boolean)
                    ),
                ];
            }
            const sel = $('#lorecodex_model_select').empty();
            sel.append(`<option value="">-- 点击此处从已拉取的 ${models.length} 个模型中选择 --</option>`);
            for (const m of models) {
                sel.append(`<option value="${escHtml(m)}" ${m === cfg.chatModel ? 'selected' : ''}>${escHtml(m)}</option>`);
            }
            if (models.length > 0) {
                sel.show();
                if (!cfg.chatModel || !models.includes(cfg.chatModel)) {
                    cfg.chatModel = models[0];
                    $('#lorecodex_chat_model').val(models[0]);
                    sel.val(models[0]);
                    saveSettingsDebounced();
                    if (!isUsingLocalEngine(cfg) && lastHealthInfo?.ok) {
                        await syncConfigToServer({ silent: true });
                    }
                }
            }
            st.text(
                models.length > 0
                    ? `已拉取 ${models.length} 个模型，可在上方下拉框直接切换（当前：${cfg.chatModel || '未选'}）`
                    : '接口返回了 0 个模型，请直接在输入框填写模型名称'
            );
            if (typeof toastr !== 'undefined') toastr.success(`已拉取 ${models.length} 个模型`);
        } catch (e) {
            st.text('拉取失败: ' + e.message);
            if (typeof toastr !== 'undefined') toastr.error('拉取模型失败: ' + e.message);
        } finally {
            btn.prop('disabled', false);
        }
    });

    $('#lorecodex_save_srv').on('click', async () => {
        await syncConfigToServer({ silent: false });
    });

    $('#lorecodex_test_query').on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            $('#lorecodex_test_btn').trigger('click');
        }
    });

    $('#lorecodex_test_btn').on('click', async () => {
        const btn = $('#lorecodex_test_btn');
        if (btn.prop('disabled')) return;
        const q = String($('#lorecodex_test_query').val() || '').trim();
        if (!q) {
            $('#lorecodex_status').text('请输入测试检索问题');
            return;
        }
        const st = $('#lorecodex_status');
        btn.prop('disabled', true);
        st.text('正在执行树形 Agent 检索...');
        try {
            const ctx = getContext();
            const j = await executeTreeSearchRequest(cfg, {
                corpus: cfg.corpus || undefined,
                query: q,
                onDemand: q,
                recentChat: collectRecentChat(ctx?.chat || [], cfg.recentTurns || 5),
                sceneAnchor: { charName: ctx?.name2 || '', userName: ctx?.name1 || '旅人', pov: cfg.pov || '' },
                maxScenes: normalizeMaxScenes(cfg.maxScenes),
                maxOrder: normalizeMaxOrder(cfg.maxOrder) || undefined,
                pov: cfg.pov || '',
                apiConfig: buildApiConfig(cfg),
            });
            lastInjectionSnapshot = {
                corpus_id: j.corpus_id || cfg.corpus,
                corpus_name: j.corpus_name || corporaMap.get(j.corpus_id || cfg.corpus)?.name || cfg.corpus,
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
        } finally {
            btn.prop('disabled', false);
        }
    });
});
