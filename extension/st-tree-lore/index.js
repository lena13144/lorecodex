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
        isArcLlmDone,
        upgradeBrowserCorpusWithLLM,
        estimateBrowserLlmUpgradePlan,
        inspectCorpusStructure,
        acquireCorpusBuildLock,
        formatDurationZh,
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
    reasoningEffort: '',
    customXmlTag: '',
    customHeader: '',
    customPriorityRule: '',
    charBindings: {},
    uiTheme: 'lamp',
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

function normalizeReasoningEffort(val) {
    return String(val || '').trim().toLowerCase();
}

function optionalReasoningOrNull(val) {
    const v = normalizeReasoningEffort(val);
    return v || null;
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

/**
 * 从用户消息里的数据库「# 记忆召回」块提取本局记忆。
 * 只保留自带括号摘要的条目，例如 AM0022(芙拉米尔交代委托规则)；纯编号（AM0057）的正文在世界书里，
 * 检索模型看不懂，直接丢弃。<supplement> 等其余部分不读。
 * @returns {string[]}
 */
function extractSessionRecall(mes) {
    const s = String(mes || '');
    const start = s.indexOf('# 记忆召回');
    if (start < 0) return [];
    const rest = s.slice(start);
    const end = rest.search(/<\/recall>|\n-{3,}|合计[：:]|<supplement>/);
    const block = end >= 0 ? rest.slice(0, end) : rest.slice(0, 4000);
    const out = [];
    let total = 0;
    const re = /\b(AM\d{2,})\s*[（(]([^()（）]{2,200})[)）]/g;
    let m;
    while ((m = re.exec(block))) {
        const line = `${m[1]} ${m[2].trim().slice(0, 100)}`;
        if (total + line.length > 1200) break;
        out.push(line);
        total += line.length;
    }
    return out;
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
    const re = normalizeReasoningEffort(cfg.reasoningEffort);
    if (re) out.reasoningEffort = re;
    return out;
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

function buildWorkbenchUrls(cfg, { runId = '', corpusId = '', action = '' } = {}) {
    const cid = String(corpusId || cfg.corpus || serverDefaultCorpus || '').trim();
    const useLocalUi = Boolean(cfg.localMode) || !lastHealthInfo?.ok || (cid && localPacksMap.has(cid) && !corporaCache.some(c => c.id === cid));
    const qEmbed = new URLSearchParams();
    qEmbed.set('embed', '1');
    if (useLocalUi) qEmbed.set('local', '1');
    if (cid) qEmbed.set('corpus', cid);
    if (action) qEmbed.set('action', action);
    if (cfg.uiTheme === 'paper' || cfg.uiTheme === 'lamp') qEmbed.set('theme', cfg.uiTheme);
    const qStandalone = new URLSearchParams();
    if (useLocalUi) qStandalone.set('local', '1');
    if (cid) qStandalone.set('corpus', cid);
    if (action) qStandalone.set('action', action);
    if (cfg.uiTheme === 'paper' || cfg.uiTheme === 'lamp') qStandalone.set('theme', cfg.uiTheme);
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

function openWorkbenchModal(cfg, { runId = '', corpusId = '', action = '' } = {}) {
    if (cfg.chatBase || cfg.chatKey || cfg.chatModel) {
        idbSetMeta('local_api_config', {
            defaultCorpus: cfg.corpus || '',
            chatBase: cfg.chatBase || '',
            chatKey: cfg.chatKey || '',
            chatModel: cfg.chatModel || 'deepseek-chat',
            maxTokens: Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : null,
            temperature: optionalTempOrNull(cfg.temperature),
            reasoningEffort: optionalReasoningOrNull(cfg.reasoningEffort),
        }).catch(() => {});
    }
    const { embedUrl, standaloneUrl } = buildWorkbenchUrls(cfg, { runId, corpusId, action });
    const cid = String(corpusId || cfg.corpus || serverDefaultCorpus || '').trim();
    const cName = corporaMap.get(cid)?.name || cid || 'LoreCodex';

    let backdrop = $('#lorecodex_wb_modal');
    if (!backdrop.length) {
        const modalHtml = `
        <div id="lorecodex_wb_modal" class="lorecodex-wb-backdrop" role="dialog" aria-modal="true" aria-label="LoreCodex 工作台">
            <div class="lorecodex-wb-modal">
                <div class="lorecodex-wb-head">
                    <div class="lorecodex-wb-title">
                        <span>LoreCodex 典籍工作台</span>
                        <span id="lorecodex_wb_corpus_pill" class="lorecodex-pill accent"></span>
                    </div>
                    <div class="lorecodex-wb-actions">
                        <a id="lorecodex_wb_extlink" class="menu_button" target="_blank" rel="noopener" style="text-decoration:none;width:auto;padding:4px 10px;">新窗口</a>
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
    backdrop.attr('data-lc-theme', cfg.uiTheme === 'paper' ? 'paper' : 'lamp');
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
            const arcs = p.indexData?.arcs || [];
            const rawSt = p.indexData?.stats || {};
            let totalScenes = 0;
            let sumScenes = 0;
            let sumArcs = 0;
            for (const a of arcs) {
                const aScenes = a.scenes || [];
                totalScenes += aScenes.length;
                let allDone = aScenes.length > 0;
                for (const s of aScenes) {
                    const sDone = s._llm_done === true || (s._llm_done !== false && Boolean(String(s.summary || '').trim()));
                    if (sDone) sumScenes += 1;
                    else allDone = false;
                }
                if (a._llm_done === true || (a._llm_done !== false && allDone && aScenes.length > 0)) {
                    sumArcs += 1;
                }
            }
            const resolvedLlmScenes = typeof rawSt.llm_scenes === 'number'
                ? rawSt.llm_scenes
                : (rawSt.llm_arcs === 0 ? 0 : sumScenes);
            const resolvedLlmArcs = typeof rawSt.llm_arcs === 'number'
                ? rawSt.llm_arcs
                : (rawSt.llm_scenes === 0 ? 0 : sumArcs);
            const st = {
                ...rawSt,
                arcs: rawSt.arcs || arcs.length,
                scenes: rawSt.scenes || totalScenes || Object.keys(p.textsData || {}).length,
                llm_arcs: resolvedLlmArcs,
                llm_scenes: resolvedLlmScenes,
                total_chars: rawSt.total_chars || 0,
            };
            corporaMap.set(p.id, {
                id: p.id,
                name: `${p.config?.name || p.id}`,
                stats: st,
                prompt_framing: p.config?.prompt_framing,
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
    return { xmlTag, header, priorityRule };
}

function renderLastPreview(cfg) {
    const box = $('#lorecodex_last_preview');
    if (!box.length) return;
    if (!lastInjectionSnapshot) {
        box.html('<div class="lorecodex-last-empty">尚未触发检索 · 发送对话后将在此显示命中状态</div>');
        return;
    }
    const snap = lastInjectionSnapshot;
    const statusPill = snap.skip
        ? `<span class="lorecodex-pill skip">跳过注入</span>`
        : `<span class="lorecodex-pill ok">命中 ${snap.scenes.length} 幕${snap.outlines?.length ? ` · ${snap.outlines.length}大纲` : ''}</span>`;
    const orderPill = snap.max_order ? `<span class="lorecodex-pill accent">序≤${snap.max_order}</span>` : '';
    const scenesHtml = (snap.scenes || []).map(s => `
        <div class="lorecodex-scene-item">
            <span><code>${escHtml(s.node_id)}</code> ${escHtml(s.arc_title)} · ${escHtml(s.title)}</span>
            <span class="lorecodex-muted">${s.chars}字</span>
        </div>
    `).join('');

    box.html(`
        <details class="lorecodex-last-details">
            <summary class="lorecodex-last-summary">
                <span class="lorecodex-row" style="gap:5px;flex-wrap:nowrap;min-width:0;">
                    <span class="lorecodex-muted" style="flex-shrink:0;">上次检索</span>
                    ${statusPill}
                    ${orderPill}
                </span>
                <span class="lorecodex-muted" style="flex-shrink:0;">${snap.took_ms ?? 0}ms · ${snap.turns ?? 0}轮</span>
            </summary>
            <div class="lorecodex-last-body">
                ${snap.skip
                    ? `<div class="lorecodex-muted">原因：${escHtml(snap.reason || '无命中')}</div>`
                    : `${snap.guide ? `<div class="lorecodex-muted" style="line-height:1.45;white-space:pre-line;">${escHtml(snap.guide)}</div>` : ''}${scenesHtml ? `<div class="lorecodex-preview-scenes">${scenesHtml}</div>` : ''}`
                }
                <button type="button" id="lorecodex_preview_open_wb" class="menu_button" style="width:100%;padding:4px 8px;font-size:0.84em;">在大面板查看完整轨迹</button>
            </div>
        </details>
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

async function runTreeRetrieval(cfg, ctx, chat, { query, onDemand, sessionRecall, clear }) {
    const depth = normalizeDepth(cfg.depth);
    const recentChat = collectRecentChat(chat, cfg.recentTurns || 5);
    const corpusId = (cfg.corpus || serverDefaultCorpus || '').trim();
    const corpusMeta = corporaMap.get(corpusId) || null;
    const maxOrder = normalizeMaxOrder(cfg.maxOrder);

    let data;
    try {
        data = await executeTreeSearchRequest(cfg, {
            corpus: corpusId || undefined,
            query,
            onDemand,
            sessionRecall: sessionRecall?.length ? sessionRecall : undefined,
            recentChat,
            sceneAnchor: {
                charName: ctx?.name2 || '',
                userName: ctx?.name1 || '旅人',
                pov: cfg.pov || '',
            },
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

    const profLines = (data.profiles || []).slice(0, 3);
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

    const promptText = `<${framing.xmlTag}>\n${framing.header}\n${framing.priorityRule}${spoilerNote}${guideBlock}${outlineBlock}${profBlock}${sceneBlock}${chunkBlock}${relBlock}\n</${framing.xmlTag}>`;

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

/** 用户原话里明确要求引用原文时，按精确查原文处理。 */
const USER_QUOTE_RE = /原话|台词|原文|说过什么|那句|那句话|怎么说的|引文|还记得.*说|ta当时说|具体说了/;

function normalizeDepth(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function clearInjection(cfg) {
    setExtensionPrompt(PROMPT_TAG, '', extension_prompt_types.IN_CHAT, normalizeDepth(cfg?.depth), false, extension_prompt_roles.SYSTEM);
}

/**
 * 只用字面内容构造检索输入：最后一条用户消息（清理后）。
 * @returns {{ query: string, onDemand: string, sessionRecall: string[] }}
 */
function buildRetrievalInput(chat) {
    const lastUserMsg = (chat || []).filter(m => m && m.is_user && !m.is_system && m.mes).slice(-1)[0];
    const query = lastUserMsg ? cleanMessage(lastUserMsg.mes).slice(0, 500) : '';
    const onDemand = query && USER_QUOTE_RE.test(query) ? query : '';
    const sessionRecall = lastUserMsg ? extractSessionRecall(lastUserMsg.mes) : [];
    return { query, onDemand, sessionRecall };
}

let loreRagRunning = false;
async function runLoreRetrieval(chat) {
    const cfg = getSettings();
    if (!cfg.enabled) { clearInjection(cfg); return; }
    if (loreRagRunning) {
        // 上一轮还没结束：不要让旧注入跟着这次生成走。
        clearInjection(cfg);
        return;
    }
    loreRagRunning = true;
    const clear = () => clearInjection(cfg);
    try {
        const ctx = getContext();
        // 读原始聊天记录：interceptor 传入的 chat 已套用仅作用于提示词的正则并拼入附件，内容和用户原话不一定一致。
        const msgs = Array.isArray(ctx?.chat) && ctx.chat.length ? ctx.chat : (Array.isArray(chat) ? chat : []);
        const { query, onDemand, sessionRecall } = buildRetrievalInput(msgs);
        if (!query) { clear(); return; }
        await runTreeRetrieval(cfg, ctx, msgs, { query, onDemand, sessionRecall, clear });
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

// ST generate_interceptor（见 manifest.json）：在用户消息写入之后、提示词组装之前执行，dry run 不会调用。
globalThis.loreCodexGenerateInterceptor = async function (chat, _contextSize, _abort, type) {
    if (type === 'quiet') return;
    try { await runLoreRetrieval(chat); }
    catch (e) { console.warn('[LoreCodex]', e); }
};
// 仅供离线测试（scripts/verify_st_extension.mjs）在不挂载设置面板时加载书库。
globalThis.__loreCodexTestHooks = { refreshCorpora: () => fetchCorporaAndHealth(getSettings()) };

function getActiveCharKey() {
    const ctx = getContext();
    return String(ctx?.name2 || '').trim();
}

jQuery(async () => {
    const cfg = getSettings();
    const initialOk = await fetchCorporaAndHealth(cfg);

    let localUpgAbortCtrl = null;
    let llmBuildRunning = false;

    const getStSettingsPayload = () => {
        const charKey = getActiveCharKey();
        return {
            enabled: Boolean(cfg.enabled),
            localMode: Boolean(cfg.localMode),
            ragServer: cfg.ragServer || 'http://127.0.0.1:5240',
            corpus: cfg.corpus || '',
            maxOrder: normalizeMaxOrder(cfg.maxOrder),
            maxScenes: normalizeMaxScenes(cfg.maxScenes),
            recentTurns: Math.max(1, Number(cfg.recentTurns) || 5),
            depth: normalizeDepth(cfg.depth),
            pov: cfg.pov || '',
            customXmlTag: cfg.customXmlTag || '',
            customHeader: cfg.customHeader || '',
            customPriorityRule: cfg.customPriorityRule || '',
            charKey,
            charBinding: charKey ? (cfg.charBindings?.[charKey] || null) : null,
        };
    };

    const syncUiFromCfg = () => {
        $('#lorecodex_enabled').prop('checked', Boolean(cfg.enabled));
        $('#lorecodex_corpus').val(cfg.corpus || '');
        const needsApi = !String(cfg.chatBase || '').trim() || !String(cfg.chatModel || '').trim();
        $('#lorecodex_api_banner').toggle(needsApi);
        const badges = [];
        if (Number(cfg.maxOrder) > 0) badges.push(`防剧透≤${cfg.maxOrder}`);
        if (String(cfg.pov || '').trim()) badges.push(`视角:${String(cfg.pov).trim()}`);
        const badgeWrap = $('#lorecodex_active_badges');
        if (badges.length) {
            badgeWrap.html(
                badges
                    .map((b) => `<button type="button" class="lorecodex-pill accent lorecodex-pill-btn" title="点击调整防剧透进度或视角">${escHtml(b)}</button>`)
                    .join('')
            ).show();
            badgeWrap.find('.lorecodex-pill-btn').on('click', () => {
                openWorkbenchModal(cfg, { corpusId: cfg.corpus, action: 'st-settings' });
            });
        } else {
            badgeWrap.empty().hide();
        }
    };

    const renderConnStatus = (ok) => {
        const dot = $('#lorecodex_conn_dot');
        const txt = $('#lorecodex_conn_text');
        if (!dot.length) return;
        dot.removeClass('ok err wait');
        const count = corporaMap.size;
        if (!cfg.localMode && ok && lastHealthInfo?.ok) {
            dot.addClass('ok');
            txt.text(`外部服务就绪 · ${count} 本书`);
        } else if (cfg.localMode || localPacksCache.length > 0) {
            dot.addClass('ok');
            txt.text(`就绪 · ${count} 本书`);
        } else {
            dot.addClass('err');
            txt.text('外部服务未连接');
        }
    };

    const renderStaticLlmWidget = () => {
        if (llmBuildRunning) return;
        const box = $('#lorecodex_llm_box');
        if (!box.length) return;
        const meta = corporaMap.get(cfg.corpus);
        const titleEl = $('#lorecodex_llm_title');
        const btn = $('#lorecodex_llm_btn');
        const fill = $('#lorecodex_llm_fill');
        const sub = $('#lorecodex_llm_sub');

        if (!meta) {
            titleEl.text('LLM 目录 · 未选择书库');
            fill.removeClass('running done paused err').css('width', '0%');
            btn.text('导入书库').prop('disabled', false).data('mode', 'import');
            sub.text('').hide();
            return;
        }
        const st = meta.stats || {};
        const totalScenes = Number(st.scenes || 0);
        const doneScenes = Math.min(totalScenes, Number(st.llm_scenes || 0));
        const pct = totalScenes > 0 ? Math.min(100, (doneScenes / totalScenes) * 100) : 0;

        fill.removeClass('running done paused err');
        if (totalScenes === 0) {
            titleEl.text('LLM 目录 · 空书库');
            fill.css('width', '0%');
            btn.text('去管理').prop('disabled', false).data('mode', 'open');
            sub.text('').hide();
        } else if (doneScenes >= totalScenes) {
            titleEl.text(`LLM 目录 · ✓ 已就绪 (${doneScenes}/${totalScenes} 幕)`);
            fill.addClass('done').css('width', '100%');
            btn.text('已就绪').prop('disabled', false).data('mode', 'upgrade');
            sub.text('').hide();
        } else {
            titleEl.text(`LLM 目录 · ${doneScenes}/${totalScenes} 幕 (${pct.toFixed(0)}%)`);
            fill.css('width', `${pct.toFixed(1)}%`);
            btn.text(doneScenes > 0 ? '继续构建' : '建立目录').prop('disabled', false).data('mode', 'build');
            sub.text('').hide();
        }
    };

    const renderRunningLlmWidget = (prog, stateMode = 'running', customSub = '') => {
        const titleEl = $('#lorecodex_llm_title');
        const btn = $('#lorecodex_llm_btn');
        const fill = $('#lorecodex_llm_fill');
        const sub = $('#lorecodex_llm_sub');

        const pct = stateMode === 'done'
            ? 100
            : Math.min(100, Math.max(0, Number(prog?.percent) || 0));
        fill.removeClass('running done paused err').addClass(stateMode);
        fill.css('width', `${pct.toFixed(1)}%`);

        const now = Date.now();
        const startedAtMs = prog?.startedAtMs || now;
        const elapsedMs = stateMode === 'running'
            ? Math.max(0, now - startedAtMs)
            : Math.max(0, Number(prog?.elapsedMs ?? (now - startedAtMs)));

        let etaStr = '';
        if (stateMode === 'done') etaStr = '已完成';
        else if (stateMode === 'paused') etaStr = '已暂停';
        else if (stateMode === 'err') etaStr = '已中断';
        else if (prog?.etaMs !== null && prog?.etaMs !== undefined) {
            const sinceUpdate = prog?.updatedAtMs ? Math.max(0, now - prog.updatedAtMs) : 0;
            etaStr = `剩 ${formatDurationZh(Math.max(0, Number(prog.etaMs) - sinceUpdate))}`;
        } else if (prog?.estMaxMs > 0) {
            etaStr = `约 ${formatDurationZh(prog.estMinMs)}~${formatDurationZh(prog.estMaxMs)}`;
        } else {
            etaStr = '测速中...';
        }

        const totalArcs = Number(prog?.totalArcs) || 0;
        const doneArcs = Number(prog?.doneArcs) || 0;
        const arcSpan = totalArcs > 0 ? ` (${doneArcs}/${totalArcs}章)` : '';

        if (stateMode === 'running') {
            titleEl.text(
                prog?.phase === 'series_meta'
                    ? `提炼全卷总览 · ${pct.toFixed(1)}%`
                    : `构建 LLM 目录 · ${pct.toFixed(1)}%${arcSpan}`
            );
            btn.text('暂停').prop('disabled', false).data('mode', 'stop');
        } else if (stateMode === 'done') {
            titleEl.text(`LLM 目录 · ✓ 构建完成 (100%)`);
            btn.text('已就绪').prop('disabled', false).data('mode', 'upgrade');
        } else if (stateMode === 'paused') {
            titleEl.text(`LLM 目录 · 已暂停 ${pct.toFixed(1)}%${arcSpan}`);
            btn.text('继续构建').prop('disabled', false).data('mode', 'build');
        } else {
            titleEl.text(`LLM 目录 · 已中断 ${pct.toFixed(1)}%${arcSpan}`);
            btn.text('重试构建').prop('disabled', false).data('mode', 'build');
        }

        const curText = customSub
            || (prog?.phase === 'series_meta'
                ? `提炼「${prog.series || '默认分卷'}」总览 · ${etaStr}`
                : `${prog?.arcTitle ? prog.arcTitle + ' · ' : ''}已用 ${formatDurationZh(elapsedMs)} · ${etaStr}`);
        sub.text(curText).show();
    };

    const updateBindingButton = () => {
        const charKey = getActiveCharKey();
        const btn = $('#lorecodex_bind_toggle');
        if (!btn.length) return;
        const b = charKey ? cfg.charBindings?.[charKey] : null;
        if (!charKey) {
            btn.removeClass('active').prop('disabled', true).text('绑角色').attr('title', '进入角色对话后可一键绑定专属书库');
        } else if (b && b.corpus === cfg.corpus) {
            btn.addClass('active').prop('disabled', false).text('已绑角色').attr('title', `角色「${charKey}」已绑定此书库，点击解绑`);
        } else if (b) {
            btn.removeClass('active').prop('disabled', false).text('改绑角色').attr('title', `角色「${charKey}」当前绑定为 ${b.corpus}，点击改为当前书库`);
        } else {
            btn.removeClass('active').prop('disabled', false).text('绑角色').attr('title', `将当前书库绑定给角色「${charKey}」`);
        }
    };

    const renderCorpusDropdown = () => {
        const sel = $('#lorecodex_corpus').empty();
        const entries = [...corporaMap.values()];
        if (!entries.length) {
            sel.append(`<option value="${escHtml(cfg.corpus || '')}">${escHtml(cfg.corpus || '（暂无书库，点下方打开大面板导入）')}</option>`);
        } else {
            for (const c of entries) {
                sel.append(`<option value="${escHtml(c.id)}">${escHtml(c.name)} (${c.stats?.arcs || 0}卷)</option>`);
            }
            if (cfg.corpus && corporaMap.has(cfg.corpus)) sel.val(cfg.corpus);
        }
        renderStaticLlmWidget();
        updateBindingButton();
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
            renderStaticLlmWidget();
        }
        updateBindingButton();
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
            renderStaticLlmWidget();
            updateBindingButton();
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
            syncUiFromCfg();
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
            syncUiFromCfg();
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
                    cfg.reasoningEffort = normalizeReasoningEffort(localCfg.reasoningEffort);
                } else {
                    if ((cfg.maxTokens === '' || cfg.maxTokens === undefined || cfg.maxTokens === null) && Number(localCfg.maxTokens) > 0) {
                        cfg.maxTokens = Number(localCfg.maxTokens);
                    }
                    if (normalizeTemperature(cfg.temperature) === '' && normalizeTemperature(localCfg.temperature) !== '') {
                        cfg.temperature = normalizeTemperature(localCfg.temperature);
                    }
                    if (!normalizeReasoningEffort(cfg.reasoningEffort) && normalizeReasoningEffort(localCfg.reasoningEffort)) {
                        cfg.reasoningEffort = normalizeReasoningEffort(localCfg.reasoningEffort);
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
                cfg.reasoningEffort = normalizeReasoningEffort(srvCfg.reasoningEffort);
            } else {
                if ((cfg.maxTokens === '' || cfg.maxTokens === undefined || cfg.maxTokens === null) && Number(srvCfg.maxTokens) > 0) {
                    cfg.maxTokens = Number(srvCfg.maxTokens);
                }
                if (normalizeTemperature(cfg.temperature) === '' && normalizeTemperature(srvCfg.temperature) !== '') {
                    cfg.temperature = normalizeTemperature(srvCfg.temperature);
                }
                if (!normalizeReasoningEffort(cfg.reasoningEffort) && normalizeReasoningEffort(srvCfg.reasoningEffort)) {
                    cfg.reasoningEffort = normalizeReasoningEffort(srvCfg.reasoningEffort);
                }
            }
        } catch (_) {}
    };

    await syncConfigFromServer();

    const SUN_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
    const MOON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
    const curTheme = cfg.uiTheme === 'paper' ? 'paper' : 'lamp';

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>LoreCodex 典籍检索</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div id="lorecodex_drawer_root" class="inline-drawer-content lorecodex-drawer" data-lc-theme="${curTheme}">
            <div class="lorecodex-card">
                <div class="lorecodex-sec">
                    <div class="lorecodex-conn-bar">
                        <div class="lorecodex-conn-left">
                            <span id="lorecodex_conn_dot" class="lorecodex-dot wait"></span>
                            <span id="lorecodex_conn_text" class="lorecodex-conn-text">初始化中...</span>
                        </div>
                        <button type="button" id="lorecodex_theme_toggle" class="lorecodex-icon-btn" title="${curTheme === 'paper' ? '切换到墨灯深色模式' : '切换到素笺浅色模式'}">${curTheme === 'paper' ? MOON_SVG : SUN_SVG}</button>
                        <label class="lorecodex-switch" title="对话生成前自动检索并注入相关原著记忆">
                            <input id="lorecodex_enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''} />
                            <span class="lorecodex-switch-track"></span>
                            <span class="lorecodex-switch-label">启用</span>
                        </label>
                    </div>

                    <div class="lorecodex-row" style="flex-wrap:nowrap;">
                        <select id="lorecodex_corpus" class="text_pole" style="flex:1;min-width:0;"></select>
                        <button type="button" id="lorecodex_bind_toggle" class="lorecodex-ghost-btn lorecodex-bind-btn">绑角色</button>
                    </div>

                    <div id="lorecodex_active_badges" class="lorecodex-row" style="gap:5px;display:none;"></div>
                </div>

                <div id="lorecodex_llm_box" class="lorecodex-sec">
                    <div class="lorecodex-prog-head">
                        <span id="lorecodex_llm_title" class="lorecodex-prog-title">LLM 目录</span>
                        <button type="button" id="lorecodex_llm_btn" class="lorecodex-ghost-btn sm">建立目录</button>
                    </div>
                    <div class="lorecodex-prog-track">
                        <div id="lorecodex_llm_fill" class="lorecodex-prog-fill"></div>
                    </div>
                    <div id="lorecodex_llm_sub" class="lorecodex-prog-sub" style="display:none;"></div>
                </div>

                <div id="lorecodex_api_banner" class="lorecodex-api-banner" style="display:none;">
                    <span>尚未配置旁路模型 API</span>
                    <button type="button" id="lorecodex_go_api" class="lorecodex-ghost-btn sm">去配置</button>
                </div>

                <div id="lorecodex_last_preview" class="lorecodex-sec"></div>

                <div class="lorecodex-cta-wrap">
                    <button type="button" id="lorecodex_open_ui" class="lorecodex-btn-primary">打开 LoreCodex 大面板</button>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    renderConnStatus(initialOk);
    renderCorpusDropdown();
    syncUiFromCfg();
    renderLastPreview(cfg);

    const runLocalLlmUpgrade = async (targetCorpusId) => {
        const pack = localPacksMap.get(targetCorpusId);
        if (!pack) {
            openWorkbenchModal(cfg, { corpusId: targetCorpusId, action: 'upgrade' });
            return;
        }
        const apiCfg = buildApiConfig(cfg);
        if (!apiCfg.chatBase || !apiCfg.chatKey) {
            if (typeof toastr !== 'undefined') toastr.warning('请先配置旁路模型 API Base URL 与 API Key');
            openWorkbenchModal(cfg, { corpusId: targetCorpusId, action: 'settings' });
            return;
        }
        if (localUpgAbortCtrl) return;

        const plan = estimateBrowserLlmUpgradePlan(pack, { series: '', workers: 8, limitArcs: 0 });
        if (!plan.totalArcs) {
            renderStaticLlmWidget();
            if (typeof toastr !== 'undefined') toastr.info('当前书库已完成全部 LLM 目录构建');
            return;
        }

        const buildLock = acquireCorpusBuildLock(pack.id, '酒馆扩展侧边栏');
        if (!buildLock.ok) {
            const holderOwner = buildLock.holder?.owner || '其他窗口';
            if (typeof toastr !== 'undefined') toastr.warning(`书库「${pack.config.name}」正在「${holderOwner}」执行 LLM 构建`);
            return;
        }

        localUpgAbortCtrl = new AbortController();
        llmBuildRunning = true;
        const ctrl = localUpgAbortCtrl;

        let latestProg = {
            phase: 'arcs',
            doneArcs: 0,
            totalArcs: plan.totalArcs,
            doneScenes: 0,
            totalScenes: plan.totalScenes,
            doneCalls: 0,
            totalCalls: plan.totalCalls,
            doneSeries: 0,
            totalSeries: plan.totalSeriesMeta,
            percent: 0,
            etaMs: null,
            estMinMs: plan.estMinMs,
            estMaxMs: plan.estMaxMs,
            startedAtMs: Date.now(),
            updatedAtMs: Date.now(),
            arcTitle: plan.targetArcs[0]?.title || '',
            series: plan.targetArcs[0]?.series || '',
        };
        let progStateMode = 'running';
        renderRunningLlmWidget(latestProg, 'running');

        const progTicker = setInterval(() => {
            if (progStateMode === 'running') renderRunningLlmWidget(latestProg, 'running');
        }, 1000);

        try {
            const res = await upgradeBrowserCorpusWithLLM(pack, apiCfg, {
                series: '',
                workers: 8,
                limitArcs: 0,
                signal: ctrl.signal,
                onProgress(prog) {
                    latestProg = { ...prog, updatedAtMs: Date.now() };
                    progStateMode = prog.event === 'done' ? 'done' : 'running';
                    renderRunningLlmWidget(latestProg, progStateMode);
                },
                async onSave(updatedPack) {
                    await idbSaveCorpus(updatedPack);
                    localAgentsCache.delete(updatedPack.id);
                },
            });
            await idbSaveCorpus(pack);
            localAgentsCache.delete(pack.id);
            const ok = await fetchCorporaAndHealth(cfg);
            progStateMode = 'done';
            llmBuildRunning = false;
            renderConnStatus(ok);
            renderCorpusDropdown();
            const durStr = formatDurationZh(res.elapsedMs);
            renderRunningLlmWidget({ ...latestProg, percent: 100, elapsedMs: res.elapsedMs }, 'done', `完成，总耗时 ${durStr}`);
            if (typeof toastr !== 'undefined') toastr.success(`LLM 目录构建完成（${durStr}）`);
        } catch (err) {
            await idbSaveCorpus(pack).catch(() => {});
            localAgentsCache.delete(pack.id);
            await fetchCorporaAndHealth(cfg);
            const isPaused = ctrl.signal.aborted;
            progStateMode = isPaused ? 'paused' : 'err';
            llmBuildRunning = false;
            const errMsg = err?.message || String(err);
            renderRunningLlmWidget(
                latestProg,
                progStateMode,
                isPaused ? '已暂停并保存断点，随时可继续' : `中断: ${errMsg}`
            );
            if (typeof toastr !== 'undefined') {
                toastr.info(isPaused ? '已暂停 LLM 构建并保存断点' : `LLM 构建中断: ${errMsg}`);
            }
        } finally {
            buildLock.release();
            clearInterval(progTicker);
            localUpgAbortCtrl = null;
            llmBuildRunning = false;
        }
    };

    $('#lorecodex_enabled').on('change', function () {
        cfg.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#lorecodex_theme_toggle').on('click', () => {
        cfg.uiTheme = cfg.uiTheme === 'paper' ? 'lamp' : 'paper';
        saveSettingsDebounced();
        $('#lorecodex_drawer_root').attr('data-lc-theme', cfg.uiTheme);
        $('#lorecodex_wb_modal').attr('data-lc-theme', cfg.uiTheme);
        $('#lorecodex_theme_toggle')
            .html(cfg.uiTheme === 'paper' ? MOON_SVG : SUN_SVG)
            .attr('title', cfg.uiTheme === 'paper' ? '切换到墨灯深色模式' : '切换到素笺浅色模式');
    });

    $('#lorecodex_corpus').on('change', function () {
        cfg.corpus = $(this).val();
        saveSettingsDebounced();
        renderStaticLlmWidget();
        updateBindingButton();
    });

    $('#lorecodex_bind_toggle').on('click', () => {
        const charKey = getActiveCharKey();
        if (!charKey) {
            if (typeof toastr !== 'undefined') toastr.warning('当前没有打开的角色卡对话');
            return;
        }
        const cur = cfg.charBindings?.[charKey];
        if (cur && cur.corpus === cfg.corpus) {
            delete cfg.charBindings[charKey];
            saveSettingsDebounced();
            updateBindingButton();
            if (typeof toastr !== 'undefined') toastr.info(`已解除「${charKey}」的专属书库绑定`);
        } else {
            cfg.charBindings[charKey] = {
                corpus: cfg.corpus || serverDefaultCorpus || '',
                maxOrder: normalizeMaxOrder(cfg.maxOrder),
                pov: cfg.pov || '',
            };
            saveSettingsDebounced();
            updateBindingButton();
            if (typeof toastr !== 'undefined') toastr.success(`已将当前书库绑定给「${charKey}」`);
        }
    });

    $('#lorecodex_llm_btn').on('click', () => {
        const mode = $('#lorecodex_llm_btn').data('mode');
        if (mode === 'stop') {
            if (localUpgAbortCtrl) localUpgAbortCtrl.abort();
            return;
        }
        if (mode === 'import') {
            openWorkbenchModal(cfg, { action: 'import' });
            return;
        }
        if (mode === 'upgrade' || mode === 'open') {
            openWorkbenchModal(cfg, { corpusId: cfg.corpus, action: 'upgrade' });
            return;
        }
        runLocalLlmUpgrade(cfg.corpus);
    });

    $('#lorecodex_go_api').on('click', () => {
        openWorkbenchModal(cfg, { action: 'settings' });
    });

    $('#lorecodex_open_ui').on('click', () => {
        openWorkbenchModal(cfg);
    });

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
                cfg.reasoningEffort = normalizeReasoningEffort(localCfg.reasoningEffort);
            }
        }
        saveSettingsDebounced();
        renderConnStatus(ok);
        renderCorpusDropdown();
        syncUiFromCfg();
    };

    window.addEventListener('message', async (ev) => {
        const iframe = document.getElementById('lorecodex_wb_iframe');
        if (!iframe || ev.source !== iframe.contentWindow) return;
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'lorecodex:st-get-settings') {
            ev.source.postMessage({ type: 'lorecodex:st-settings', settings: getStSettingsPayload() }, '*');
        } else if (msg.type === 'lorecodex:st-save-settings' && msg.patch && typeof msg.patch === 'object') {
            const p = msg.patch;
            const prevLocalMode = cfg.localMode;
            const prevServer = cfg.ragServer;
            if (p.enabled !== undefined) cfg.enabled = Boolean(p.enabled);
            if (p.localMode !== undefined) cfg.localMode = Boolean(p.localMode);
            if (p.ragServer !== undefined) cfg.ragServer = String(p.ragServer || '').trim() || 'http://127.0.0.1:5240';
            if (p.maxOrder !== undefined) cfg.maxOrder = normalizeMaxOrder(p.maxOrder);
            if (p.maxScenes !== undefined) cfg.maxScenes = normalizeMaxScenes(p.maxScenes);
            if (p.recentTurns !== undefined) cfg.recentTurns = Math.max(1, Number(p.recentTurns) || 5);
            if (p.depth !== undefined) cfg.depth = Math.max(0, Number(p.depth) || 0);
            if (p.pov !== undefined) cfg.pov = String(p.pov || '').trim();
            if (p.customXmlTag !== undefined) cfg.customXmlTag = String(p.customXmlTag || '');
            if (p.customHeader !== undefined) cfg.customHeader = String(p.customHeader || '');
            if (p.customPriorityRule !== undefined) cfg.customPriorityRule = String(p.customPriorityRule || '');
            saveSettingsDebounced();
            if (prevLocalMode !== cfg.localMode || prevServer !== cfg.ragServer) {
                resolvedServerBase = '';
                const ok = await fetchCorporaAndHealth(cfg);
                renderConnStatus(ok);
                renderCorpusDropdown();
            }
            syncUiFromCfg();
            ev.source.postMessage({ type: 'lorecodex:st-settings-saved', ok: true, settings: getStSettingsPayload() }, '*');
        } else if (msg.type === 'lorecodex:st-corpus-changed' && msg.corpusId) {
            const cid = String(msg.corpusId).trim();
            if (cid) {
                cfg.corpus = cid;
                saveSettingsDebounced();
                $('#lorecodex_wb_corpus_pill').text(corporaMap.get(cid)?.name || cid);
                renderCorpusDropdown();
                syncUiFromCfg();
            }
        }
    });
});
