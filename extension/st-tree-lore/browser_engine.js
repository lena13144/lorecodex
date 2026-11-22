const IDB_NAME = 'lorecodex_browser_store_v2';
const IDB_STORE = 'corpora';
const IDB_META_STORE = 'runtime_meta';

const DEFAULT_STAGE_PATTERNS = [
    '(?:世界|城市|模拟器|舞台|总览|合集|世界书|沙盒|sandbox|world|city|simulator)',
];

const AD_PATTERNS = [
    /https?:\/\/\S+/i,
    /(?:爱下电子书|爱阅小说|笔趣阁|起点中文网|晋江文学城|飞卢小说|全本小说网)/i,
    /网页版章节内容慢.*下载.*app/i,
    /请记住本站域名/i,
    /最新章节.*阅读/i,
    /^[-=]{3,}\s*章节内容开始\s*[-=]{3,}$/i,
];

function stripMarkup(text) {
    return String(text || '')
        .replace(/<\/?(?:color|size|b|i|u|s|ruby|rt)(?:=[^>]*)?>/gi, '')
        .replace(/\r\n/g, '\n');
}

function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatCharCount(n) {
    const num = Number(n) || 0;
    return num >= 10000 ? `${(num / 10000).toFixed(1)} 万字` : `${num.toLocaleString()} 字`;
}

function normalizeOrder(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
}

function isOrderAllowed(order, maxOrder) {
    const limit = normalizeOrder(maxOrder);
    if (limit === null) return true;
    if (order === null || order === undefined || order === '') return true;
    const n = Number(order);
    if (!Number.isFinite(n)) return true;
    return n <= limit;
}

function extractJsonObject(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : s;
    try {
        return JSON.parse(candidate);
    } catch (_) {}
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try {
            return JSON.parse(candidate.slice(first, last + 1));
        } catch (_) {}
    }
    return null;
}

export function normalizeCorpusConfig(raw, corpusId) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const name = String(cfg.name || corpusId || 'LoreCodex').trim();
    const pf = cfg.prompt_framing && typeof cfg.prompt_framing === 'object' ? cfg.prompt_framing : {};
    const sg = cfg.spoiler_gate && typeof cfg.spoiler_gate === 'object' ? cfg.spoiler_gate : {};
    const ug = cfg.user_identity_guard && typeof cfg.user_identity_guard === 'object' ? cfg.user_identity_guard : {};
    const hier = cfg.hierarchy && typeof cfg.hierarchy === 'object' ? cfg.hierarchy : {};
    const grep = cfg.grep && typeof cfg.grep === 'object' ? cfg.grep : {};
    const scrub = cfg.db_scrubber && typeof cfg.db_scrubber === 'object' ? cfg.db_scrubber : {};

    return {
        id: String(cfg.id || corpusId || 'default').trim(),
        name,
        description: String(cfg.description || '').trim(),
        language: String(cfg.language || 'zh-CN').trim(),
        world_premise:
            String(cfg.world_premise || '').trim() ||
            `当前语料库收录了《${name}》的完整故事章节与设定档案。你负责消解对话中的模糊指代，从目录树中定位并核实原始文本片段，供正文模型直接衔接。`,
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
                '【事实优先级】若原作片段细节与当前世界书/角色卡设定或本局对话已确认的新发展存在冲突，一律以本局当前时间线为准。',
            follow_up_hint:
                String(pf.follow_up_hint || '').trim() ||
                '如仍需追查其他特定过往台词或细节，可在回复末尾附带【查原文：具体问题或人物事件】。',
        },
        db_scrubber: {
            boilerplate_patterns: Array.isArray(scrub.boilerplate_patterns) ? scrub.boilerplate_patterns : [],
            summary_priority_patterns: Array.isArray(scrub.summary_priority_patterns) ? scrub.summary_priority_patterns : [],
        },
    };
}

// IndexedDB wrapper for local serverless corpora & runtime trace runs
function openIdb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('当前环境不支持 IndexedDB'));
        }
        const req = indexedDB.open(IDB_NAME, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(IDB_META_STORE)) {
                db.createObjectStore(IDB_META_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
}

export async function idbGetMeta(key, fallback = null) {
    try {
        const db = await openIdb();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_META_STORE, 'readonly');
            const st = tx.objectStore(IDB_META_STORE);
            const req = st.get(key);
            req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
            req.onerror = () => resolve(fallback);
        });
    } catch (_) {
        return fallback;
    }
}

export async function idbSetMeta(key, value) {
    try {
        const db = await openIdb();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_META_STORE, 'readwrite');
            const st = tx.objectStore(IDB_META_STORE);
            const req = st.put({ key, value, updatedAt: new Date().toISOString() });
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    } catch (_) {
        return false;
    }
}

export async function idbRecordRun(inputPayload, outputData) {
    const run = {
        id: 'run_local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        corpus_id: outputData.corpus_id || inputPayload.corpus || '',
        max_order: outputData.max_order ?? null,
        input: inputPayload,
        output: outputData,
    };
    const runs = (await idbGetMeta('recent_runs', [])) || [];
    runs.unshift(run);
    if (runs.length > 40) runs.length = 40;
    await idbSetMeta('recent_runs', runs);
    return run;
}

export async function idbListRuns(corpusId = '') {
    const runs = (await idbGetMeta('recent_runs', [])) || [];
    return corpusId ? runs.filter((r) => r.corpus_id === corpusId) : runs;
}

export async function idbListCorpora() {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const st = tx.objectStore(IDB_STORE);
        const req = st.getAll();
        req.onsuccess = () => {
            const rows = Array.isArray(req.result) ? req.result : [];
            resolve(rows);
        };
        req.onerror = () => reject(req.error);
    });
}

export async function idbSaveCorpus(pack) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        const req = st.put({
            id: pack.id,
            config: normalizeCorpusConfig(pack.config, pack.id),
            indexData: pack.indexData,
            textsData: pack.textsData,
            graphData: Array.isArray(pack.graphData) ? pack.graphData : [],
            updatedAt: new Date().toISOString(),
        });
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

export async function idbDeleteCorpus(id) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const st = tx.objectStore(IDB_STORE);
        const req = st.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Auto-detect UTF-8 / UTF-16LE / UTF-16BE / GB18030 (GBK) from raw Uint8Array / ArrayBuffer in browser.
 */
export function decodeTextBufferAuto(inputBuffer) {
    const bytes = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer);
    if (!bytes.length) return '';
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
        try {
            return new TextDecoder('gb18030').decode(bytes);
        } catch (_) {
            return new TextDecoder('utf-8').decode(bytes);
        }
    }
}

async function inflateRawBytes(compressedBytes) {
    if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressedBytes);
        writer.close();
        const ab = await new Response(ds.readable).arrayBuffer();
        return new Uint8Array(ab);
    }
    throw new Error('当前环境不支持 DecompressionStream 解压 EPUB');
}

function parseZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocdOffset = -1;
    const minEocd = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= minEocd; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) throw new Error('无效的 EPUB/ZIP 文件结构');
    const cdCount = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const entries = new Map();
    let ptr = cdOffset;
    const utf8 = new TextDecoder('utf-8');

    for (let i = 0; i < cdCount && ptr + 46 <= bytes.length; i++) {
        if (view.getUint32(ptr, true) !== 0x02014b50) break;
        const method = view.getUint16(ptr + 10, true);
        const compSize = view.getUint32(ptr + 20, true);
        const uncompSize = view.getUint32(ptr + 24, true);
        const nameLen = view.getUint16(ptr + 28, true);
        const extraLen = view.getUint16(ptr + 30, true);
        const commentLen = view.getUint16(ptr + 32, true);
        const localHeaderOffset = view.getUint32(ptr + 42, true);
        const name = utf8.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen)).replace(/\\/g, '/');
        entries.set(name, { name, method, compSize, uncompSize, localHeaderOffset });
        ptr += 46 + nameLen + extraLen + commentLen;
    }

    const readEntryBytes = async (entry) => {
        const lh = entry.localHeaderOffset;
        if (view.getUint32(lh, true) !== 0x04034b50) throw new Error(`损坏的 ZIP 条目: ${entry.name}`);
        const lNameLen = view.getUint16(lh + 26, true);
        const lExtraLen = view.getUint16(lh + 28, true);
        const dataStart = lh + 30 + lNameLen + lExtraLen;
        const rawSlice = bytes.subarray(dataStart, dataStart + entry.compSize);
        if (entry.method === 0) return rawSlice;
        if (entry.method === 8) return await inflateRawBytes(rawSlice);
        throw new Error(`不支持的 EPUB 压缩算法 method=${entry.method}`);
    };

    return { entries, readEntryBytes };
}

function htmlToPlainLines(xhtml) {
    let s = String(xhtml || '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');
    let headingTitle = '';
    const hm = s.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    if (hm) {
        headingTitle = hm[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }
    s = s
        .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
    const lines = s
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    return { headingTitle, lines };
}

/**
 * Pure-browser zero-dependency EPUB parser using native DecompressionStream('deflate-raw').
 * Extracts chapters in OPF spine order (or sorted XHTML fallback) and converts to novel text lines.
 */
export async function extractEpubTextInBrowser(inputBuffer) {
    const bytes = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer);
    const { entries, readEntryBytes } = parseZipEntries(bytes);

    let opfPath = '';
    if (entries.has('META-INF/container.xml')) {
        const cTxt = decodeTextBufferAuto(await readEntryBytes(entries.get('META-INF/container.xml')));
        const m = cTxt.match(/full-path=["']([^"']+\.opf)["']/i);
        if (m) opfPath = m[1];
    }
    if (!opfPath) {
        for (const k of entries.keys()) {
            if (k.toLowerCase().endsWith('.opf')) {
                opfPath = k;
                break;
            }
        }
    }

    let orderedHtmlPaths = [];
    if (opfPath && entries.has(opfPath)) {
        const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
        const opfTxt = decodeTextBufferAuto(await readEntryBytes(entries.get(opfPath)));
        const manifest = new Map();
        const itemRe = /<item\b([^>]+?)\/?>/gi;
        let im;
        while ((im = itemRe.exec(opfTxt)) !== null) {
            const attrs = im[1];
            const idM = attrs.match(/\bid=["']([^"']+)["']/i);
            const hrefM = attrs.match(/\bhref=["']([^"']+)["']/i);
            const typeM = attrs.match(/\bmedia-type=["']([^"']+)["']/i);
            if (idM && hrefM) {
                const hrefClean = decodeURIComponent(hrefM[1].split('#')[0]);
                const mediaType = typeM ? typeM[1].toLowerCase() : '';
                if (mediaType.includes('html') || /\.(?:xhtml|html|htm)$/i.test(hrefClean)) {
                    const resolved = (opfDir + hrefClean).replace(/\/\.\//g, '/');
                    manifest.set(idM[1], resolved);
                }
            }
        }
        const itemrefRe = /<itemref\b[^>]*?\bidref=["']([^"']+)["']/gi;
        let rm;
        while ((rm = itemrefRe.exec(opfTxt)) !== null) {
            const p = manifest.get(rm[1]);
            if (p && entries.has(p)) orderedHtmlPaths.push(p);
        }
    }

    if (!orderedHtmlPaths.length) {
        orderedHtmlPaths = [...entries.keys()]
            .filter((k) => /\.(?:xhtml|html|htm)$/i.test(k) && !/(?:nav|toc|cover)\.(?:xhtml|html|htm)$/i.test(k))
            .sort();
    }

    const outLines = [];
    const chapCheckRe = /^(?:##+\s*)?(第[零一二三四五六七八九十百千万0-9]+(?:章|节|回|幕|话)|(?:Chapter|Episode)\s+\d+|序章|楔子|尾声|终章)/i;
    let chapCounter = 1;
    for (const p of orderedHtmlPaths) {
        const ent = entries.get(p);
        if (!ent) continue;
        const rawHtml = decodeTextBufferAuto(await readEntryBytes(ent));
        const { headingTitle, lines } = htmlToPlainLines(rawHtml);
        if (!lines.length || lines.join('').length < 15) continue;
        const hasChapHeader = lines.slice(0, 5).some((l) => chapCheckRe.test(l));
        if (!hasChapHeader) {
            if (headingTitle && chapCheckRe.test(headingTitle)) {
                outLines.push(`## ${headingTitle}`);
            } else if (headingTitle) {
                outLines.push(`## 第${chapCounter}章 ${headingTitle}`);
            } else {
                outLines.push(`## 第${chapCounter}章`);
            }
        }
        chapCounter += 1;
        outLines.push(...lines);
    }
    return outLines.join('\n');
}

// Pure-JS Heuristic Novel Builder (.txt / .md) for In-Browser Serverless Mode
const CN_NUM_MAP = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
function parseChineseOrArabicInt(raw) {
    const s = String(raw || '').trim();
    if (/^\d+$/.test(s)) return Number(s);
    let total = 0;
    let cur = 0;
    for (const ch of s) {
        const v = CN_NUM_MAP[ch];
        if (v === undefined) return null;
        if (v >= 10) {
            total += (cur || 1) * v;
            cur = 0;
        } else {
            cur = cur * 10 + v;
        }
    }
    return total + cur || null;
}

function inferToneTags(text) {
    const s = String(text || '');
    const tags = [];
    if (/(?:战斗|攻击|爆炸|剑|枪|火光|杀|血|死|危机|轰鸣|交锋|突袭)/.test(s)) tags.push('战斗/危机');
    if (/(?:微笑|温柔|茶|午后|阳光|日常|轻声|拥抱|晚安|散步|厨房)/.test(s)) tags.push('温情/日常');
    if (/(?:历史|纪元|档案|设定|法则|原理|组织|编年|体系|阶级)/.test(s)) tags.push('设定/档案');
    if (/(?:心想|沉默|回忆|孤独|梦境|怀疑|愧疚|秘密|凝视)/.test(s)) tags.push('心理/独白');
    if (!tags.length) tags.push('叙事/剧情');
    return tags.slice(0, 2);
}

function extractDialogueCast(text) {
    const counts = new Map();
    const stop = new Set(['自己', '他们', '她们', '我们', '你们', '大家', '众人', '有人', '男人', '女人', '少年', '少女', '声音', '系统']);
    const re = /([\u4e00-\u9fff]{2,4})(?:说道|问道|笑道|低声道|冷笑道|回答|开口|叹道|喊道|看着|转身)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (!stop.has(name)) counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map((x) => x[0]);
}

function makeHeuristicSummary(text) {
    const lines = String(text || '')
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 6);
    if (!lines.length) return '';
    if (lines.length === 1) return lines[0].slice(0, 140);
    const first = lines[0].slice(0, 75);
    const last = lines[lines.length - 1].slice(0, 65);
    return first === last ? first : `${first} … ${last}`;
}

export function buildNovelCorpusInBrowser({ rawText, corpusId, name, category = '正文' }) {
    const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
    const volRe = /^\s*(?:#\s*)?(第[一二三四五六七八九十百千0-9]+(?:卷|部|篇|集)|Volume\s+\d+|Book\s+\d+)(?:[\s：:·、，,-]+(.{0,36}))?\s*$/i;
    const chapRe = /^\s*(?:##+\s*)?(第[零一二三四五六七八九十百千万0-9]+(?:章|节|回|幕|话)|(?:Chapter|Episode)\s+\d+|序章|楔子|尾声|终章)(?:[\s：:·、，,-]*([^\n]{0,45}))?\s*$/i;

    let currentSeries = '';
    let autoVolIdx = 1;
    let lastChapNum = 0;
    const rawChapters = [];
    let curChap = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (AD_PATTERNS.some((re) => re.test(line))) continue;

        const vm = line.match(volRe);
        if (vm && line.length <= 42 && !/敬请期待|求月票|求收藏/.test(line)) {
            currentSeries = `${vm[1]}${vm[2] ? ' ' + vm[2].trim() : ''}`.trim();
            continue;
        }

        const cm = line.match(chapRe);
        if (cm && line.length <= 55) {
            const numPart = (cm[1].match(/[零一二三四五六七八九十百千万0-9]+/) || [])[0];
            const chapNum = numPart ? parseChineseOrArabicInt(numPart) : null;
            if (chapNum === 1 && lastChapNum >= 5 && !vm) {
                if (!currentSeries) {
                    for (const prev of rawChapters) {
                        if (!prev.series) prev.series = `第${autoVolIdx}卷`;
                    }
                }
                autoVolIdx += 1;
                currentSeries = `第${autoVolIdx}卷`;
            }
            if (chapNum !== null) lastChapNum = chapNum;
            const title = `${cm[1]}${cm[2] ? ' ' + cm[2].trim() : ''}`.trim();
            curChap = {
                title,
                series: currentSeries,
                lines: [],
            };
            rawChapters.push(curChap);
            continue;
        }

        if (!curChap) {
            curChap = { title: '序幕', series: currentSeries, lines: [] };
            rawChapters.push(curChap);
        }
        curChap.lines.push(line);
    }

    const validChaps = rawChapters.filter((c) => c.lines.join('\n').trim().length > 0);
    const arcs = [];
    const textsData = {};
    let arcSeq = 1;
    let nodeSeq = 1;
    let totalChars = 0;

    for (const ch of validChaps) {
        const arcId = String(arcSeq).padStart(4, '0');
        const fullText = ch.lines.join('\n');
        const targetSize = 1800;
        const maxSize = 2600;
        const chunks = [];
        let buf = [];
        let bufLen = 0;

        for (const p of ch.lines) {
            if (bufLen + p.length > maxSize && buf.length > 0) {
                chunks.push(buf.join('\n'));
                buf = [p];
                bufLen = p.length;
            } else {
                buf.push(p);
                bufLen += p.length;
                if (bufLen >= targetSize) {
                    chunks.push(buf.join('\n'));
                    buf = [];
                    bufLen = 0;
                }
            }
        }
        if (buf.length > 0) chunks.push(buf.join('\n'));

        const scenes = [];
        for (let i = 0; i < chunks.length; i++) {
            const scText = chunks[i];
            const nodeId = String(nodeSeq++).padStart(4, '0');
            const scTitle = chunks.length === 1 ? ch.title : `${ch.title}（${i + 1}）`;
            const scSummary = makeHeuristicSummary(scText);
            const scTones = inferToneTags(scText);
            scenes.push({
                node_id: nodeId,
                group: `${arcId}-${i + 1}`,
                group_title: scTitle,
                title: scTitle,
                order: arcSeq,
                chars: scText.length,
                tone_tags: scTones,
                summary: scSummary,
            });
            textsData[nodeId] = {
                arc_id: arcId,
                arc_title: ch.title,
                group: `${arcId}-${i + 1}`,
                group_title: scTitle,
                text: scText,
            };
        }

        const cast = extractDialogueCast(fullText);
        const arcChars = fullText.length;
        totalChars += arcChars;
        arcs.push({
            arc_id: arcId,
            arc_key: `${corpusId}-${arcId}`,
            title: ch.title,
            series: ch.series || '',
            category: category || '正文',
            order: arcSeq,
            total_chars: arcChars,
            description: scenes[0]?.summary || ch.title,
            characters: cast,
            key_items: [],
            tone_tags: scenes[0]?.tone_tags || ['叙事/剧情'],
            scenes,
        });
        arcSeq += 1;
    }

    const indexData = {
        version: 2,
        corpus_id: corpusId,
        corpus_name: name || corpusId,
        built_at: new Date().toISOString(),
        stats: {
            arcs: arcs.length,
            scenes: nodeSeq - 1,
            total_chars: totalChars,
            max_order: arcs.length,
            llm_scenes: 0,
            llm_arcs: 0,
        },
        series_summaries: {},
        arcs,
    };

    const config = normalizeCorpusConfig({ id: corpusId, name: name || corpusId }, corpusId);
    return { id: corpusId, config, indexData, textsData, graphData: [] };
}

// Pure-JS Worldbook / Character Card V2 Builder (.json) for In-Browser Mode
export function buildLoreCorpusInBrowser({ rawJson, corpusId, name, category = '档案设定', existingPack = null }) {
    const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;

    // Also support full .lorepack.json export bundle
    if (parsed && parsed.indexData && parsed.textsData) {
        const packId = String(corpusId || parsed.id || parsed.indexData.corpus_id || 'imported-pack').trim();
        return {
            id: packId,
            config: normalizeCorpusConfig(parsed.config || { id: packId, name: name || parsed.indexData.corpus_name || packId }, packId),
            indexData: parsed.indexData,
            textsData: parsed.textsData,
            graphData: Array.isArray(parsed.graphData) ? parsed.graphData : [],
        };
    }

    let entriesRaw = [];
    if (parsed?.data?.character_book?.entries) {
        const e = parsed.data.character_book.entries;
        entriesRaw = Array.isArray(e) ? e : Object.values(e);
    } else if (parsed?.character_book?.entries) {
        const e = parsed.character_book.entries;
        entriesRaw = Array.isArray(e) ? e : Object.values(e);
    } else if (parsed?.entries) {
        entriesRaw = Array.isArray(parsed.entries) ? parsed.entries : Object.values(parsed.entries);
    } else if (Array.isArray(parsed)) {
        entriesRaw = parsed;
    }

    const baseArcs = existingPack ? [...(existingPack.indexData.arcs || [])] : [];
    const textsData = existingPack ? { ...(existingPack.textsData || {}) } : {};
    let arcSeq = baseArcs.length + 1;
    let nodeSeq = Object.keys(textsData).length + 1;

    const cleanEntries = [];
    for (const ent of entriesRaw) {
        if (!ent || typeof ent !== 'object') continue;
        if (ent.disable === true || ent.disabled === true || ent.enabled === false) continue;
        const content = String(ent.content || ent.text || '').trim();
        if (!content || content.length < 10) continue;
        if (/<style[\s>]|{{setvar::|{{getvar::/i.test(content) && content.replace(/<style[\s\S]*?<\/style>/gi, '').trim().length < 20) {
            continue;
        }
        const title = String(ent.comment || ent.title || ent.name || (Array.isArray(ent.key) ? ent.key[0] : '') || `设定条目 ${cleanEntries.length + 1}`).trim();
        const keys = [
            ...(Array.isArray(ent.key) ? ent.key : []),
            ...(Array.isArray(ent.keys) ? ent.keys : []),
            ...(Array.isArray(ent.keysecondary) ? ent.keysecondary : []),
        ]
            .map((k) => String(k || '').trim())
            .filter(Boolean);
        cleanEntries.push({ title, content, keys });
    }

    const arcId = 'L' + String(arcSeq).padStart(3, '0');
    const scenes = [];
    const allKeys = new Set();
    let arcChars = 0;

    for (let i = 0; i < cleanEntries.length; i++) {
        const item = cleanEntries[i];
        const nodeId = 'L' + String(nodeSeq++).padStart(4, '0');
        item.keys.forEach((k) => allKeys.add(k));
        arcChars += item.content.length;
        scenes.push({
            node_id: nodeId,
            group: `${arcId}-${i + 1}`,
            group_title: item.title,
            title: item.title,
            order: null,
            chars: item.content.length,
            tone_tags: ['设定/档案'],
            summary: makeHeuristicSummary(item.content),
        });
        textsData[nodeId] = {
            arc_id: arcId,
            arc_title: name || '世界书设定集',
            group: `${arcId}-${i + 1}`,
            group_title: item.title,
            text: item.content,
        };
    }

    if (scenes.length) {
        baseArcs.push({
            arc_id: arcId,
            arc_key: `${corpusId}-${arcId}`,
            title: name || '世界书设定档案',
            series: category || '档案设定',
            category: category || '档案设定',
            order: null,
            total_chars: arcChars,
            description: `收录 ${scenes.length} 条世界书与角色设定档案`,
            characters: [...allKeys].slice(0, 20),
            key_items: [...allKeys].slice(0, 20),
            tone_tags: ['设定/档案'],
            scenes,
        });
    }

    const totalScenes = baseArcs.reduce((a, x) => a + (x.scenes || []).length, 0);
    const totalChars = baseArcs.reduce((a, x) => a + (Number(x.total_chars) || 0), 0);
    const maxOrder = baseArcs.reduce((m, x) => (x.order != null && x.order > m ? x.order : m), 0);

    const targetId = existingPack ? existingPack.id : corpusId;
    const targetName = existingPack ? existingPack.config.name : name || corpusId;
    const indexData = {
        version: 2,
        corpus_id: targetId,
        corpus_name: targetName,
        built_at: new Date().toISOString(),
        stats: {
            arcs: baseArcs.length,
            scenes: totalScenes,
            total_chars: totalChars,
            max_order: maxOrder,
        },
        series_summaries: existingPack?.indexData?.series_summaries || {},
        arcs: baseArcs,
    };
    const config = existingPack ? existingPack.config : normalizeCorpusConfig({ id: targetId, name: targetName }, targetId);
    const graphData = Array.isArray(existingPack?.graphData) ? existingPack.graphData : [];
    return { id: targetId, config, indexData, textsData, graphData };
}

// In-Browser Tree Agent & Grep Runtime
export function createBrowserTreeAgent(pack) {
    const corpusId = pack.id;
    const corpusConfig = normalizeCorpusConfig(pack.config, corpusId);
    const indexData = pack.indexData || { arcs: [] };
    const textsData = pack.textsData || {};
    const seriesSummaries = indexData.series_summaries || {};
    const graphEdges = Array.isArray(pack.graphData) ? pack.graphData.filter((e) => e && e.s && e.r && e.o) : [];
    const graphEntities = (() => {
        const set = new Set();
        for (const e of graphEdges) {
            set.add(String(e.s));
            set.add(String(e.o));
        }
        return [...set].sort((a, b) => b.length - a.length);
    })();

    function lookupGraph(text, limit = 10, perEnt = 4) {
        if (!graphEdges.length || !text) return [];
        const hay = String(text);
        const hits = new Set();
        for (const ent of graphEntities) {
            if (ent.length >= 2 && hay.includes(ent)) hits.add(ent);
        }
        if (!hits.size) return [];
        const counts = new Map();
        const out = [];
        for (const e of graphEdges) {
            const matched = hits.has(e.s) ? e.s : hits.has(e.o) ? e.o : null;
            if (!matched) continue;
            const cur = counts.get(matched) || 0;
            if (cur >= perEnt) continue;
            counts.set(matched, cur + 1);
            out.push(`${e.s} -[${e.r}]-> ${e.o}${e.w > 1 ? `(×${e.w})` : ''}`);
            if (out.length >= limit) break;
        }
        return out;
    }

    const arcMap = new Map();
    const sceneMetaMap = new Map();
    const searchableScenes = [];
    const categorySet = new Set();
    const toneSet = new Set();
    const seriesStatsMap = new Map();
    let maxOrderAvailable = 0;

    const aliasMap = new Map();
    for (const grp of corpusConfig.aliases || []) {
        if (!Array.isArray(grp)) continue;
        const clean = grp.map((x) => String(x || '').trim()).filter(Boolean);
        for (const item of clean) {
            const low = item.toLowerCase();
            aliasMap.set(low, [...new Set([...(aliasMap.get(low) || []), ...clean])]);
        }
    }
    const expandAliases = (term) => {
        const t = String(term || '').trim();
        if (!t) return [];
        return aliasMap.get(t.toLowerCase()) || [t];
    };

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
        arcTones.forEach((t) => toneSet.add(t));
        if (arc.order != null && Number.isFinite(Number(arc.order))) {
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
        if (arc.order != null && Number.isFinite(Number(arc.order))) {
            const ord = Number(arc.order);
            ss.min_order = ss.min_order === null ? ord : Math.min(ss.min_order, ord);
            ss.max_order = ss.max_order === null ? ord : Math.max(ss.max_order, ord);
        }

        const arcMetaHay = [arc.title, arc.description, arcSeries, ...(arc.characters || []), ...(arc.key_items || [])]
            .join(' ')
            .toLowerCase();

        for (const sc of arc.scenes || []) {
            const scOrder = effectiveSceneOrder(sc, arc);
            if (scOrder !== null && Number.isFinite(scOrder)) {
                maxOrderAvailable = Math.max(maxOrderAvailable, scOrder);
            }
            const scTones = Array.isArray(sc.tone_tags) && sc.tone_tags.length ? sc.tone_tags : arcTones;
            scTones.forEach((t) => toneSet.add(t));
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
            const rawItem = textsData[sc.node_id];
            if (rawItem && rawItem.text) {
                const cleanText = stripMarkup(rawItem.text);
                const lines = cleanText
                    .split(/\n+/)
                    .map((l) => l.trim())
                    .filter(Boolean);
                searchableScenes.push({
                    node_id: sc.node_id,
                    arc_id: arc.arc_id,
                    arc_title: arc.title,
                    series: arcSeries,
                    category: arcCat,
                    title: sc.title || sc.group_title || '',
                    order: scOrder,
                    tone_tags: scTones,
                    chars: sc.chars || cleanText.length,
                    metaHay: `${arcMetaHay} ${sc.title || ''} ${sc.summary || ''}`.toLowerCase(),
                    lowerTitle: `${arc.title || ''} ${sc.title || ''}`.toLowerCase(),
                    cleanText,
                    lowerText: cleanText.toLowerCase(),
                    lines,
                });
            }
        }
    }

    const stats = {
        arcs: indexData.stats?.arcs || (indexData.arcs || []).length,
        scenes: indexData.stats?.scenes || sceneMetaMap.size,
        total_chars: indexData.stats?.total_chars || searchableScenes.reduce((a, s) => a + s.chars, 0),
        max_order: maxOrderAvailable,
        llm_scenes: Number(indexData.stats?.llm_scenes || 0),
        llm_arcs: Number(indexData.stats?.llm_arcs || 0),
        graph_edges: graphEdges.length,
    };
    const categories = [...categorySet];
    const seriesList = [...seriesStatsMap.values()].map((s) => ({
        ...s,
        categories: [...s.categories],
        summary: String(seriesSummaries[s.series] || '').trim(),
    }));
    const toneTags = [...toneSet];

    function resolveMaxOrder(rawMaxOrder) {
        if (rawMaxOrder === undefined || rawMaxOrder === null || rawMaxOrder === '') {
            return corpusConfig.spoiler_gate?.enabled
                ? normalizeOrder(corpusConfig.spoiler_gate.default_max_order)
                : null;
        }
        return normalizeOrder(rawMaxOrder);
    }

    function getTreeIndex({ maxOrder: rawMaxOrder } = {}) {
        const maxOrder = resolveMaxOrder(rawMaxOrder);
        const visible = [];
        for (const arc of indexData.arcs || []) {
            if (!isOrderAllowed(arc.order, maxOrder)) continue;
            const rawScenes = arc.scenes || [];
            const visScenes = rawScenes.filter((s) => isOrderAllowed(effectiveSceneOrder(s, arc), maxOrder));
            if (rawScenes.length > 0 && visScenes.length === 0) continue;
            visible.push({ ...arc, scenes: visScenes });
        }
        const visScenesCount = visible.reduce((acc, a) => acc + (a.scenes || []).length, 0);
        const visChars = visible.reduce(
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
                          arcs: visible.length,
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
            arcs: visible,
            aliases: corpusConfig.aliases || [],
            corpus: {
                id: corpusId,
                name: corpusConfig.name,
                description: corpusConfig.description,
                spoiler_gate: corpusConfig.spoiler_gate,
                ui: corpusConfig.ui,
            },
        };
    }

    function getSceneText(nodeId, { maxOrder: rawMaxOrder } = {}) {
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
    }

    function grepScenes(rawQuery, opts = {}) {
        const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 60);
        const maxOrder = opts.maxOrder ?? null;
        const catFilter = String(opts.category || '').trim();
        const toneFilter = String(opts.tone || '').trim().toLowerCase();
        const t0 = performance.now();
        const q = String(rawQuery || '').trim();
        if (!q) return { took_ms: 0, total: 0, cameo_count: 0, all_matched: false, hits: [] };

        const tokens = q.split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
        const groups = tokens.map((tk) => expandAliases(tk).map((a) => a.toLowerCase()));
        const flatAliases = [...new Set(groups.flat())];

        const eligible = searchableScenes.filter((sc) => {
            if (!isOrderAllowed(sc.order, maxOrder)) return false;
            if (catFilter && sc.category !== catFilter) return false;
            if (toneFilter && !(sc.tone_tags || []).some((t) => String(t).toLowerCase().includes(toneFilter))) return false;
            return true;
        });

        const collect = (requireAll) => {
            const matched = [];
            for (const sc of eligible) {
                let groupsHit = 0;
                let totalOccurrences = 0;
                for (const grp of groups) {
                    let grpCount = 0;
                    for (const term of grp) {
                        let idx = sc.lowerText.indexOf(term);
                        if (idx >= 0) {
                            while (idx >= 0) {
                                grpCount += 1;
                                idx = sc.lowerText.indexOf(term, idx + term.length);
                            }
                        } else if (sc.lowerTitle.includes(term)) {
                            grpCount += 1;
                        }
                    }
                    if (grpCount > 0) {
                        groupsHit += 1;
                        totalOccurrences += grpCount;
                    }
                }
                if (requireAll ? groupsHit < groups.length : groupsHit === 0) continue;
                const cameo = !flatAliases.some((a) => sc.metaHay.includes(a));
                const snippets = [];
                for (let i = 0; i < sc.lines.length; i++) {
                    const low = sc.lines[i].toLowerCase();
                    if (flatAliases.some((a) => low.includes(a))) {
                        const win = sc.lines.slice(Math.max(0, i - 1), Math.min(sc.lines.length, i + 2));
                        snippets.push(win.join(' / '));
                        if (snippets.length >= 2) break;
                    }
                }
                matched.push({
                    node_id: sc.node_id,
                    arc_id: sc.arc_id,
                    arc_title: sc.arc_title,
                    series: sc.series,
                    category: sc.category,
                    title: sc.title,
                    order: sc.order,
                    tone_tags: sc.tone_tags,
                    chars: sc.chars,
                    groups_hit: groupsHit,
                    match_count: totalOccurrences,
                    cameo,
                    snippet: snippets.join(' … ').slice(0, 260),
                });
            }
            return matched;
        };

        let allMatched = true;
        let pool = collect(true);
        if (!pool.length && groups.length > 1) {
            allMatched = false;
            pool = collect(false);
        }
        pool.sort((a, b) => Number(b.cameo) - Number(a.cameo) || b.groups_hit - a.groups_hit || b.match_count - a.match_count);
        const cameos = pool.filter((x) => x.cameo);
        return {
            took_ms: Number((performance.now() - t0).toFixed(2)),
            total: pool.length,
            cameo_count: cameos.length,
            all_matched: allMatched,
            hits: pool.slice(0, limit),
        };
    }

    async function callChat({ base, key, model, messages, tools, maxTokens, temperature }) {
        const cleanBase = String(base || '')
            .trim()
            .replace(/\/+$/, '')
            .replace(/\/(?:chat\/completions|models)$/i, '')
            .replace(/\/+$/, '');
        const body = { model, messages };
        if (temperature !== undefined && temperature !== null && temperature !== '' && Number.isFinite(Number(temperature))) {
            body.temperature = Number(temperature);
        }
        const mt = Number(maxTokens);
        if (Number.isFinite(mt) && mt > 0) body.max_tokens = Math.floor(mt);
        if (tools && tools.length) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }
        const resp = await fetch(`${cleanBase}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const errTxt = await resp.text().catch(() => '');
            throw new Error(`LLM HTTP ${resp.status}: ${errTxt.slice(0, 160)}`);
        }
        return resp.json();
    }

    async function search(payload, apiCfg) {
        const t0 = Date.now();
        const maxOrder = normalizeOrder(payload.maxOrder) ?? corpusConfig.spoiler_gate?.default_max_order ?? null;
        const maxTurns = 8;
        const rawMaxScenes = Number(payload.maxScenes);
        const maxScenes = rawMaxScenes > 0 ? Math.min(rawMaxScenes, 12) : 10;

        if (!apiCfg?.chatBase || !apiCfg?.chatKey) {
            throw new Error('内置免服务端模式需要先在下方「旁路推理 Agent 模型配置」填写 API Base URL 与 API Key');
        }

        const visibleArcs = (indexData.arcs || [])
            .filter((a) => isOrderAllowed(a.order, maxOrder))
            .map((a) => ({
                arc: a,
                scenes: (a.scenes || []).filter((s) => isOrderAllowed(effectiveSceneOrder(s, a), maxOrder)),
            }))
            .filter((x) => x.scenes.length > 0);

        const hasSeriesTool = seriesList.length >= 2;
        const tools = [];
        if (hasSeriesTool) {
            tools.push({
                type: 'function',
                function: {
                    name: 'list_series',
                    description: `列出《${corpusConfig.name}》Level-0 分卷总览`,
                    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: [] },
                },
            });
        }
        tools.push(
            {
                type: 'function',
                function: {
                    name: 'list_story_arcs',
                    description: `列出《${corpusConfig.name}》篇章目录（支持 series, category, character, keyword, tone 过滤）`,
                    parameters: {
                        type: 'object',
                        properties: {
                            series: { type: 'string' },
                            category: { type: 'string' },
                            character: { type: 'string' },
                            keyword: { type: 'string' },
                            tone: { type: 'string' },
                        },
                        required: [],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'get_arc_scenes',
                    description: '展开 1~5 个篇章下的分幕摘要目录',
                    parameters: {
                        type: 'object',
                        properties: { arc_ids: { type: 'array', items: { type: 'string' } } },
                        required: ['arc_ids'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'read_scene',
                    description: '批量读取 1~10 个场景节点的完整无损原文',
                    parameters: {
                        type: 'object',
                        properties: { scene_node_ids: { type: 'array', items: { type: 'string' } } },
                        required: ['scene_node_ids'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'grep_scenes',
                    description: '全库正文毫秒级精确扫描（自动展开人物别名与客串发现）',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' }, category: { type: 'string' }, tone: { type: 'string' } },
                        required: ['query'],
                    },
                },
            }
        );

        const aliasBlock = (corpusConfig.aliases || []).length
            ? `\n【人物本名/化名/代号对照表】\n` +
              corpusConfig.aliases
                  .slice(0, 45)
                  .map((g) => (Array.isArray(g) ? g.join(' = ') : ''))
                  .filter(Boolean)
                  .join(' ； ')
            : '';
        const glossaryBlock = (corpusConfig.glossary || []).length
            ? `\n【核心世界观与设定术语】\n` + corpusConfig.glossary.slice(0, 30).join('\n')
            : '';

        const sysPrompt = `你是《${corpusConfig.name}》后台树形记忆检索 Agent（浏览器内置引擎），负责定位并核实原著文本。
${corpusConfig.world_premise || ''}
语料规模：${stats.arcs} 卷 / ${stats.scenes} 幕 / ${formatCharCount(stats.total_chars)}。${maxOrder ? `当前防剧透锁定：order <= ${maxOrder}，严禁泄露后续内容。` : ''}${aliasBlock}${glossaryBlock}
【检索策略】
1. 跳过判定：纯无关闲聊或未收录原创设定直接输出 {"skip":true,"reason":"..."}；涉及过往经历、设定或台词细节时主动检索。
2. 高效寻路：首轮可并发调用目录工具与 grep_scenes（自动展开别名）；read_scene 尽量一次批量传入多个纯编号 scene_node_ids（最多 10 个，如 ["0080","0601"]）。
3. 按跨度选幕：定点查证读 1~3 幕；长跨度回顾、群像或组织/势力过往读 4~10 幕，结合词表与目录人物表跨阶段/全分支覆盖（如前任/新晋/分队），宏观梳理可填 selected_arcs。
4. 事实核实：selected_nodes 须经 read_scene 核实；若前提与原文矛盾则在 guide 开头直接澄清，严禁编造。
5. 严格输出 JSON：
{"skip":false,"selected_nodes":["经read_scene核实的node_id"],"selected_arcs":["可选宏观arc_id"],"timeline_note":"时间线阶段","guide":"结构化记忆导读并标注[node_id]"}`;

        const userParts = [];
        if (payload.sceneAnchor?.charName) userParts.push(`当前角色：${payload.sceneAnchor.charName} | 用户：${payload.sceneAnchor.userName || '旅人'}`);
        if (payload.activeStateHints) userParts.push(`【状态线索】\n${payload.activeStateHints}`);
        if (Array.isArray(payload.recentChat) && payload.recentChat.length) {
            userParts.push(`【最近对话】\n` + payload.recentChat.map((m) => `[${m.name || m.role}]: ${m.text}`).join('\n'));
        }
        if (payload.onDemand) userParts.push(`【显式检索】\n${payload.onDemand}`);
        if (payload.query) userParts.push(`【当前输入】\n${payload.query}`);

        const userPromptText = userParts.join('\n\n');
        const messages = [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPromptText },
        ];

        const readScenesMap = new Map();
        const trace = [];
        const steps = [];
        const listedArcsSet = new Set();
        const expandedArcsSet = new Set();
        const readNodesSet = new Set();
        let promptTokens = 0;
        let completionTokens = 0;

        const execTool = (fnName, args) => {
            if (fnName === 'list_series') {
                const kw = String(args?.keyword || '').toLowerCase();
                const rows = seriesList
                    .filter((s) => !kw || s.series.toLowerCase().includes(kw) || String(seriesSummaries[s.series] || '').toLowerCase().includes(kw))
                    .map((s) => `[${s.series}] ${s.arcs}卷 ${s.scenes}幕 (${formatCharCount(s.total_chars)})${seriesSummaries[s.series] ? ' | ' + seriesSummaries[s.series] : ''}`);
                return {
                    text: rows.join('\n') || '无匹配分部',
                    summary: `列出 ${rows.length} 个分部`,
                    meta: {},
                };
            }
            if (fnName === 'list_story_arcs') {
                const ser = String(args?.series || '').toLowerCase();
                const cat = String(args?.category || '').toLowerCase();
                const ch = String(args?.character || '').toLowerCase();
                const kw = String(args?.keyword || '').toLowerCase();
                const chTerms = ch ? expandAliases(ch).map((x) => x.toLowerCase()) : [];
                const kwTerms = kw ? expandAliases(kw).map((x) => x.toLowerCase()) : [];
                const matched = visibleArcs.filter(({ arc, scenes }) => {
                    if (ser && !String(arc.series || arc.category || '').toLowerCase().includes(ser)) return false;
                    if (cat && !String(arc.category || '').toLowerCase().includes(cat)) return false;
                    const hay = [arc.title, arc.description, ...(arc.characters || []), ...scenes.map((s) => `${s.title} ${s.summary}`)].join(' ').toLowerCase();
                    if (chTerms.length && !chTerms.some((t) => hay.includes(t))) return false;
                    if (kwTerms.length && !kwTerms.some((t) => hay.includes(t))) return false;
                    return true;
                });
                const shown = matched.slice(0, 60);
                const arcIds = shown.map((x) => x.arc.arc_id);
                arcIds.forEach((id) => listedArcsSet.add(id));
                return {
                    text:
                        shown
                            .map(({ arc, scenes }) => {
                                const castStr = (arc.characters || []).length ? ` | 人物:${arc.characters.slice(0, 8).join('、')}` : '';
                                return `- [${arc.arc_id}] (${arc.series || arc.category}${arc.order != null ? '·序' + arc.order : ''}) 《${arc.title}》 (${scenes.length}幕${castStr}): ${arc.description || ''}`;
                            })
                            .join('\n') || '无匹配篇章',
                    summary: `匹配 ${matched.length} 卷篇章`,
                    meta: { arc_ids: arcIds },
                };
            }
            if (fnName === 'get_arc_scenes') {
                const ids = (Array.isArray(args?.arc_ids) ? args.arc_ids : []).map(String).slice(0, 5);
                const hitArcs = [];
                const hitNodes = [];
                const text = ids
                    .map((aid) => {
                        const found = visibleArcs.find((x) => x.arc.arc_id === aid);
                        if (!found) return `[${aid}] 未找到`;
                        hitArcs.push(aid);
                        expandedArcsSet.add(aid);
                        for (const s of found.scenes) hitNodes.push(s.node_id);
                        const castStr = (found.arc.characters || []).length ? ` | 人物: ${found.arc.characters.join('、')}` : '';
                        const descStr = found.arc.description ? `\n  简介: ${found.arc.description}` : '';
                        return `[${aid}] 《${found.arc.title}》(${found.scenes.length}幕${castStr}):${descStr}\n` + found.scenes.map((s) => `  * [${s.node_id}] 《${s.title}》(${s.chars}字): ${s.summary}`).join('\n');
                    })
                    .join('\n\n');
                return {
                    text,
                    summary: `展开 ${hitArcs.length} 卷共 ${hitNodes.length} 幕`,
                    meta: { arc_ids: hitArcs, node_ids: hitNodes },
                };
            }
            if (fnName === 'read_scene') {
                const ids = (Array.isArray(args?.scene_node_ids) ? args.scene_node_ids : [])
                    .map((rawId) => String(rawId || '').replace(/^node:/i, '').split('|')[0].trim())
                    .filter(Boolean)
                    .slice(0, 10);
                const out = [];
                const nodeIds = [];
                const arcIds = [];
                for (const sid of ids) {
                    const sm = sceneMetaMap.get(sid);
                    const raw = textsData[sid];
                    if (!sm || !raw || !isOrderAllowed(sm.effective_order, maxOrder)) continue;
                    const cleanText = stripMarkup(raw.text);
                    const rec = {
                        node_id: sid,
                        arc_id: sm.arc_id,
                        arc_title: sm.arc_title,
                        category: sm.arc_category,
                        title: sm.title || sm.group_title,
                        order: sm.effective_order,
                        chars: cleanText.length,
                        text: cleanText,
                    };
                    readScenesMap.set(sid, rec);
                    readNodesSet.add(sid);
                    nodeIds.push(sid);
                    if (sm.arc_id && !arcIds.includes(sm.arc_id)) arcIds.push(sm.arc_id);
                    out.push(rec);
                }
                return {
                    text: JSON.stringify(out),
                    summary: `精读 ${out.length} 幕原文`,
                    meta: { arc_ids: arcIds, node_ids: nodeIds },
                };
            }
            if (fnName === 'grep_scenes') {
                const res = grepScenes(args?.query || '', { limit: 20, maxOrder, category: args?.category, tone: args?.tone });
                const nodeIds = res.hits.map((h) => h.node_id);
                const arcIds = [...new Set(res.hits.map((h) => h.arc_id))];
                arcIds.forEach((id) => listedArcsSet.add(id));
                const text = !res.hits.length
                    ? `[全文扫描 ${res.took_ms}ms] 零命中`
                    : `[全文扫描 ${res.took_ms}ms | 命中 ${res.total} 幕]\n` +
                      res.hits.map((h) => `- [node_id=${h.node_id} | arc_id=${h.arc_id}] ${h.arc_title} · ${h.title}${h.cameo ? '[客串]' : ''} (${h.match_count}处): ${h.snippet}`).join('\n');
                return {
                    text,
                    summary: `Grep "${args?.query || ''}" -> ${res.total} 幕 (${res.took_ms}ms)`,
                    meta: { arc_ids: arcIds, node_ids: nodeIds },
                };
            }
            return { text: '[]', summary: '无输出', meta: {} };
        };

        let rawAnswer = '';
        let finalTurn = 1;
        for (let turn = 1; turn <= maxTurns; turn++) {
            finalTurn = turn;
            const tReq = Date.now();
            const resp = await callChat({
                base: apiCfg.chatBase,
                key: apiCfg.chatKey,
                model: apiCfg.chatModel || 'deepseek-chat',
                messages,
                tools: turn < maxTurns ? tools : undefined,
                maxTokens: apiCfg.maxTokens,
                temperature: apiCfg.temperature,
            });
            const reqMs = Date.now() - tReq;
            if (resp?.usage) {
                promptTokens += Number(resp.usage.prompt_tokens) || 0;
                completionTokens += Number(resp.usage.completion_tokens) || 0;
            }
            const msg = resp?.choices?.[0]?.message;
            if (!msg) throw new Error('模型返回为空');
            const reasoning = String(msg.reasoning_content || msg.reasoning || '').trim();
            messages.push(msg);
            const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (!tcs.length) {
                rawAnswer = msg.content || '';
                steps.push({
                    turn,
                    kind: 'final',
                    llm_ms: reqMs,
                    tool_ms: 0,
                    reasoning,
                    calls: [],
                });
                break;
            }
            const tTool = Date.now();
            const callLogs = [];
            const stepCalls = [];
            for (const tc of tcs) {
                const fnName = tc?.function?.name || '';
                let fArgs = {};
                try {
                    fArgs = JSON.parse(tc?.function?.arguments || '{}');
                } catch (_) {}
                callLogs.push(`${fnName}(${JSON.stringify(fArgs)})`);
                const toolOut = execTool(fnName, fArgs);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: toolOut.text });
                stepCalls.push({
                    name: fnName,
                    args: fArgs,
                    summary: toolOut.summary,
                    result_chars: toolOut.text.length,
                    result_preview: toolOut.text.slice(0, 1200),
                    meta: toolOut.meta || {},
                });
            }
            const toolMs = Date.now() - tTool;
            steps.push({
                turn,
                kind: 'tools',
                llm_ms: reqMs,
                tool_ms: toolMs,
                reasoning,
                calls: stepCalls,
            });
            trace.push(`T${turn}(${reqMs}ms): ${callLogs.join(' ; ')}`);
        }

        const parsed = extractJsonObject(rawAnswer);
        const took_ms = Date.now() - t0;
        const baseTraversal = {
            listed_arcs: [...listedArcsSet],
            expanded_arcs: [...expandedArcsSet],
            read_scenes: [...readNodesSet],
            selected_nodes: [],
        };
        const basePrompts = {
            system: sysPrompt,
            user: userPromptText,
        };
        if (parsed?.skip === true) {
            return {
                ok: true,
                corpus_id: corpusId,
                corpus_name: corpusConfig.name,
                max_order: maxOrder,
                skip: true,
                reason: parsed.reason || '无需检索',
                took_ms,
                turns: finalTurn,
                trace,
                steps,
                traversal: baseTraversal,
                prompts: basePrompts,
                raw_answer: rawAnswer,
                usage: { prompt: promptTokens, completion: completionTokens },
                guide: '',
                scenes: [],
                outlines: [],
                relations: [],
            };
        }

        const wantedIds = Array.isArray(parsed?.selected_nodes)
            ? parsed.selected_nodes.map((rawId) => String(rawId || '').replace(/^node:/i, '').split('|')[0].trim())
            : [];
        const finalScenes = [];
        for (const id of wantedIds) {
            if (readScenesMap.has(id) && finalScenes.length < maxScenes) {
                finalScenes.push(readScenesMap.get(id));
            }
        }
        if (!finalScenes.length && readScenesMap.size > 0) {
            for (const sc of readScenesMap.values()) {
                if (finalScenes.length >= Math.min(3, maxScenes)) break;
                finalScenes.push(sc);
            }
        }
        baseTraversal.selected_nodes = finalScenes.map((s) => s.node_id);

        const wantedArcIds = Array.isArray(parsed?.selected_arcs) ? parsed.selected_arcs.map(String).slice(0, 10) : [];
        const finalOutlines = [];
        for (const aid of wantedArcIds) {
            const found = visibleArcs.find((x) => x.arc.arc_id === aid);
            if (!found) continue;
            finalOutlines.push({
                arc_id: found.arc.arc_id,
                title: found.arc.title,
                category: found.arc.category || '',
                description: found.arc.description || '',
                scene_count: found.scenes.length,
                outline_text: found.scenes.map((s) => `  - [${s.node_id}] 《${s.title}》: ${s.summary}`).join('\n'),
            });
        }

        const guide = (parsed && typeof parsed.guide === 'string' ? parsed.guide : rawAnswer).trim();
        const graphQuery = [
            payload.query || '',
            guide,
            ...finalOutlines.map((o) => o.title),
            ...finalScenes.map((s) => `${s.arc_title} ${s.title}`),
        ].join(' ');
        const relations = lookupGraph(graphQuery);
        return {
            ok: true,
            corpus_id: corpusId,
            corpus_name: corpusConfig.name,
            max_order: maxOrder,
            skip: !finalScenes.length && !finalOutlines.length && !guide,
            reason: !finalScenes.length && !finalOutlines.length && !guide ? '无命中片段' : '',
            took_ms,
            turns: finalTurn,
            trace,
            steps,
            traversal: baseTraversal,
            prompts: basePrompts,
            raw_answer: rawAnswer,
            usage: { prompt: promptTokens, completion: completionTokens },
            timeline_note: parsed?.timeline_note || '',
            guide,
            scenes: finalScenes,
            outlines: finalOutlines,
            relations,
        };
    }

    return {
        id: corpusId,
        name: corpusConfig.name,
        config: corpusConfig,
        stats,
        categories,
        seriesList,
        toneTags,
        getTreeIndex,
        getSceneText,
        grepScenes,
        lookupGraph,
        search,
    };
}

function mergeAliasGroupsInBrowser(existingGroups = [], newGroups = [], maxGroups = 60) {
    const existingTermsLower = new Set();
    const merged = [];

    const absorb = (group, isNew = false) => {
        if (!Array.isArray(group)) return;
        const seenLocal = new Set();
        const clean = [];
        for (const raw of group) {
            const term = String(raw || '').trim();
            if (!term) continue;
            const low = term.toLowerCase();
            if (isNew && term.length < 2 && !existingTermsLower.has(low)) continue;
            if (seenLocal.has(low)) continue;
            seenLocal.add(low);
            clean.push(term);
        }
        if (clean.length < 2) return;
        if (!isNew) {
            for (const t of clean) existingTermsLower.add(t.toLowerCase());
        }
        const cleanLower = new Set(clean.map((t) => t.toLowerCase()));
        const hitIndices = [];
        for (let idx = 0; idx < merged.length; idx++) {
            if (merged[idx].some((t) => cleanLower.has(t.toLowerCase()))) {
                hitIndices.push(idx);
            }
        }
        if (!hitIndices.length) {
            merged.push(clean);
            return;
        }
        const primary = hitIndices[0];
        const combined = [];
        const combinedLower = new Set();
        for (const idx of hitIndices) {
            for (const t of merged[idx]) {
                if (!combinedLower.has(t.toLowerCase())) {
                    combinedLower.add(t.toLowerCase());
                    combined.push(t);
                }
            }
        }
        for (const t of clean) {
            if (!combinedLower.has(t.toLowerCase())) {
                combinedLower.add(t.toLowerCase());
                combined.push(t);
            }
        }
        merged[primary] = combined;
        for (let i = hitIndices.length - 1; i >= 1; i--) {
            merged.splice(hitIndices[i], 1);
        }
    };

    for (const g of existingGroups) absorb(g, false);
    for (const g of newGroups) absorb(g, true);
    return merged.slice(0, maxGroups);
}

function mergeGlossaryInBrowser(existingList = [], newList = [], maxItems = 40) {
    const headOf = (item) => {
        for (const sep of ['：', ':']) {
            const pos = item.indexOf(sep);
            if (pos > 0) {
                const h = item.slice(0, pos).trim().replace(/^-+\s*/, '').toLowerCase();
                if (h) return h;
            }
        }
        return item.trim().replace(/^-+\s*/, '').toLowerCase();
    };
    const out = [];
    const headToIdx = new Map();
    const seenFull = new Set();
    for (const raw of existingList || []) {
        const item = String(raw || '').trim();
        if (!item) continue;
        const h = headOf(item);
        const full = item.toLowerCase();
        if (seenFull.has(full)) continue;
        if (headToIdx.has(h)) {
            const idx = headToIdx.get(h);
            if (item.length > out[idx].length && item.length <= 240) {
                out[idx] = item;
                seenFull.add(full);
            }
            continue;
        }
        headToIdx.set(h, out.length);
        seenFull.add(full);
        out.push(item);
    }
    for (const raw of newList || []) {
        const item = String(raw || '').trim();
        if (!item || item.length > 240) continue;
        const h = headOf(item);
        const full = item.toLowerCase();
        if (seenFull.has(full)) continue;
        if (headToIdx.has(h)) {
            const idx = headToIdx.get(h);
            if (item.length > out[idx].length) {
                out[idx] = item;
                seenFull.add(full);
            }
            continue;
        }
        if (out.length >= maxItems) break;
        headToIdx.set(h, out.length);
        seenFull.add(full);
        out.push(item);
    }
    return out.slice(0, maxItems);
}

function mergeRelationsInBrowser(existingEdges = [], newEdges = [], maxEdges = 500) {
    const edgeMap = new Map();
    for (const raw of [...(existingEdges || []), ...(newEdges || [])]) {
        if (!raw || typeof raw !== 'object') continue;
        const s = String(raw.s || '').trim();
        const r = String(raw.r || '').trim();
        const o = String(raw.o || '').trim();
        if (!s || !r || !o || s === o) continue;
        const w = Math.max(1, parseInt(raw.w, 10) || 1);
        const key = `${s.toLowerCase()}\u0000${r.toLowerCase()}\u0000${o.toLowerCase()}`;
        if (edgeMap.has(key)) {
            const cur = edgeMap.get(key);
            cur.w = (cur.w || 1) + w;
        } else {
            const rec = { s, r, o, w };
            if (Array.isArray(raw.ev)) rec.ev = raw.ev;
            edgeMap.set(key, rec);
        }
    }
    return [...edgeMap.values()]
        .sort((a, b) => (b.w || 1) - (a.w || 1))
        .slice(0, maxEdges);
}

function buildSeriesDigestInBrowser(serArcs, maxSamples = 80, maxChars = 6500) {
    let sampled = serArcs;
    if (serArcs.length > maxSamples) {
        const idxs = new Set();
        for (let i = 0; i < maxSamples; i++) {
            idxs.add(Math.floor((i * (serArcs.length - 1)) / (maxSamples - 1)));
        }
        sampled = [...idxs].map((i) => serArcs[i]);
    }
    const lines = [];
    let used = 0;
    for (const a of sampled) {
        const ordTag = a.order != null ? `第${a.order}章 ` : '';
        const desc = String(a.description || '').replace(/\s+/g, ' ').trim().slice(0, 65);
        const line = `- ${ordTag}${a.title || ''}: ${desc}`;
        if (used + line.length + 1 > maxChars && lines.length) break;
        lines.push(line);
        used += line.length + 1;
    }
    const freq = new Map();
    for (const a of serArcs) {
        for (const ch of a.characters || []) {
            const cs = String(ch || '').trim();
            if (cs) freq.set(cs, (freq.get(cs) || 0) + 1);
        }
    }
    const topChars = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map((x) => x[0]);
    return { digestText: lines.join('\n'), topChars };
}

async function callLlmJsonInBrowser(apiCfg, prompt, signal, retries = 3) {
    const cleanBase = String(apiCfg.chatBase || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/(?:chat\/completions|models)$/i, '')
        .replace(/\/+$/, '');
    const model = String(apiCfg.chatModel || 'deepseek-chat').trim();
    const mt = Number(apiCfg.maxTokens);
    const rawTemp = apiCfg.temperature;
    const hasTemp = rawTemp !== undefined && rawTemp !== null && rawTemp !== '' && Number.isFinite(Number(rawTemp));
    let lastErr = null;

    for (let attempt = 0; attempt < retries; attempt++) {
        if (signal?.aborted) throw new Error('用户已暂停/终止 LLM 建库');
        const body = {
            model,
            messages: [{ role: 'user', content: prompt }],
        };
        if (hasTemp) body.temperature = Number(rawTemp);
        if (Number.isFinite(mt) && mt > 0) body.max_tokens = Math.floor(mt);
        try {
            const resp = await fetch(`${cleanBase}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiCfg.chatKey}`,
                },
                body: JSON.stringify(body),
                signal,
            });
            if (!resp.ok) {
                const errTxt = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status}: ${errTxt.slice(0, 140)}`);
            }
            const data = await resp.json();
            const txt = data?.choices?.[0]?.message?.content || '';
            const parsed = extractJsonObject(txt);
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('LLM 未返回有效 JSON');
            }
            return parsed;
        } catch (err) {
            if (signal?.aborted) throw new Error('用户已暂停/终止 LLM 建库');
            lastErr = err;
            if (attempt + 1 < retries) {
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    throw lastErr || new Error('LLM 请求失败');
}

/**
 * In-Browser LLM Corpus Directory Builder & In-Place Upgrader (100% parity with build_novel.py --upgrade)
 * Supports concurrent scene/arc summarization, single-scene reuse optimization, series summary + aliases +
 * glossary synthesis, and automatic checkpoint persistence via onSave(pack).
 */
export async function upgradeBrowserCorpusWithLLM(pack, apiCfg, opts = {}) {
    if (!apiCfg?.chatBase || !apiCfg?.chatKey) {
        throw new Error('请先在下方「旁路推理 Agent 模型配置」填写 API Base URL 与 API Key');
    }
    const bookName = pack.config?.name || pack.indexData?.corpus_name || pack.id;
    const seriesFilter = String(opts.series || '').trim();
    const limitArcs = Number(opts.limitArcs) > 0 ? Math.floor(Number(opts.limitArcs)) : 0;
    const workers = Math.min(Math.max(Number(opts.workers) || 4, 1), 16);
    const force = Boolean(opts.force);
    const signal = opts.signal || null;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const onSave = typeof opts.onSave === 'function' ? opts.onSave : null;

    const allArcs = pack.indexData?.arcs || [];
    const textsData = pack.textsData || {};
    let targetArcs = allArcs.filter((a) => !seriesFilter || String(a.series || a.category || '').trim() === seriesFilter);
    if (!force) {
        targetArcs = targetArcs.filter((a) => !a._llm_done);
    }
    if (limitArcs > 0) {
        targetArcs = targetArcs.slice(0, limitArcs);
    }

    const totalTargetArcs = targetArcs.length;
    if (!totalTargetArcs) {
        return {
            upgradedArcs: 0,
            upgradedScenes: 0,
            synthesizedSeries: 0,
            relationsCount: (pack.graphData || []).length,
            message: '所选范围内的章节均已完成 LLM 目录构建（如需重跑请勾选强制重跑）',
        };
    }

    let completedArcs = 0;
    let upgradedScenes = 0;
    let unsavedCounter = 0;

    const persistStatsAndCheckpoint = async (forceSave = false) => {
        let llmScenesCount = 0;
        let llmArcsCount = 0;
        for (const a of allArcs) {
            if (a._llm_done) llmArcsCount += 1;
            for (const sc of a.scenes || []) {
                if (sc._llm_done) llmScenesCount += 1;
            }
        }
        pack.indexData.stats = {
            ...(pack.indexData.stats || {}),
            arcs: allArcs.length,
            scenes: allArcs.reduce((acc, x) => acc + (x.scenes || []).length, 0),
            llm_arcs: llmArcsCount,
            llm_scenes: llmScenesCount,
        };
        if (onSave && (forceSave || unsavedCounter >= 4)) {
            unsavedCounter = 0;
            await onSave(pack);
        }
    };

    const processSingleArc = async (arc) => {
        if (signal?.aborted) throw new Error('用户已暂停/终止 LLM 建库');
        const scenes = arc.scenes || [];
        for (const sc of scenes) {
            if (!force && sc._llm_done && sc.summary) continue;
            const rawText = String(textsData[sc.node_id]?.text || '').slice(0, 5400);
            if (!rawText.trim()) continue;
            const leafPrompt =
                `你是《${bookName}》文本目录索引员。请为下面这段完整场景生成检索索引（注意把人称代词消解为具体人名）：\n` +
                `1. title: 6-14字场景标题，概括地点/人物或核心事件；\n` +
                `2. summary: 2句话（70-140字），保留人名、化名/外号、专有名词、重要物品、数字和事件转折；若角色在对话中回忆或提及往事、身世、救援、小队组建等过往经历，必须明确记录“回忆当年/提及某人某事”等线索；\n` +
                `3. characters: 本幕直接出场或对话中明确提及的关键/过往人物数组（最多6人）；\n` +
                `4. tone_tags: 从 [战斗/危机, 温情/日常, 心理/独白, 权谋/悬疑, 设定/档案, 叙事/剧情] 中选 1-2 个标签。\n` +
                `只输出严格 JSON：{"title":"...","summary":"...","characters":[],"tone_tags":[]}\n\n` +
                `所属篇章：${arc.series || ''} / ${arc.title}\n正文：\n${rawText}`;
            const parsed = await callLlmJsonInBrowser(apiCfg, leafPrompt, signal);
            sc.title = String(parsed.title || '').trim() || sc.title || `${arc.title}·片段`;
            sc.summary = String(parsed.summary || '').trim() || sc.summary;
            sc.tone_tags = Array.isArray(parsed.tone_tags)
                ? parsed.tone_tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
                : sc.tone_tags || ['叙事/剧情'];
            sc._chars = Array.isArray(parsed.characters)
                ? parsed.characters.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
                : [];
            sc._llm_done = true;
            upgradedScenes += 1;
        }

        if (scenes.length === 1) {
            const sc = scenes[0];
            arc.description = sc.summary || arc.description;
            if (sc._chars?.length) arc.characters = sc._chars.slice(0, 8);
            arc.tone_tags = (sc.tone_tags || ['叙事/剧情']).slice(0, 2);
            arc.key_items = sc.title ? [sc.title] : [];
            arc._llm_done = true;
        } else if (scenes.length > 1) {
            const scLines = scenes
                .slice(0, 25)
                .map((s) => `- [${s.node_id}] ${s.title}: ${s.summary}`)
                .join('\n');
            const arcPrompt =
                `根据《${bookName}》篇章的子场景摘要提炼篇章总目信息：\n` +
                `1. description: 1-2句话（60-120字）概括全章核心人物与事件，必须保留团队/势力/身份变动（如队长交接、更名、分队重组、吸纳新成员）与重要往事揭秘；\n` +
                `2. characters: 核心出场及关键提及人物数组（最多8人）；\n` +
                `3. tone_tags: 1-2个氛围标签。\n` +
                `只输出 JSON：{"description":"...","characters":[],"tone_tags":[]}\n\n` +
                `篇章：${arc.series || ''} / ${arc.title}\n子场景：\n${scLines}`;
            const parsedArc = await callLlmJsonInBrowser(apiCfg, arcPrompt, signal);
            arc.description = String(parsedArc.description || '').trim() || arc.description;
            const chars = Array.isArray(parsedArc.characters)
                ? parsedArc.characters.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
                : [];
            if (chars.length) arc.characters = chars;
            arc.tone_tags = Array.isArray(parsedArc.tone_tags)
                ? parsedArc.tone_tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
                : arc.tone_tags || ['叙事/剧情'];
            arc.key_items = scenes
                .slice(0, 8)
                .map((s) => s.title)
                .filter(Boolean);
            arc._llm_done = true;
        }

        for (const sc of scenes) delete sc._chars;
        completedArcs += 1;
        unsavedCounter += 1;
        await persistStatsAndCheckpoint(false);
        onProgress({
            phase: 'arcs',
            done: completedArcs,
            total: totalTargetArcs,
            arcTitle: arc.title,
            series: arc.series || '',
        });
    };

    // Concurrent worker pool for targetArcs
    let cursor = 0;
    const workerLoops = Array.from({ length: Math.min(workers, totalTargetArcs) }, async () => {
        while (cursor < totalTargetArcs) {
            if (signal?.aborted) break;
            const idx = cursor++;
            const arc = targetArcs[idx];
            await processSingleArc(arc);
        }
    });
    await Promise.all(workerLoops);
    await persistStatsAndCheckpoint(true);

    // Phase 2: Series summary + character aliases + glossary synthesis per touched series
    const groupedSeries = new Map();
    for (const a of targetArcs) {
        if (!a._llm_done) continue;
        const serName = String(a.series || a.category || '正文卷').trim();
        if (!groupedSeries.has(serName)) groupedSeries.set(serName, []);
        groupedSeries.get(serName).push(a);
    }

    pack.indexData.series_summaries = pack.indexData.series_summaries || {};
    let synthesizedSeries = 0;
    const extractedAliases = [];
    const extractedGlossary = [];
    const extractedRelations = [];

    for (const [serName] of groupedSeries.entries()) {
        if (signal?.aborted) break;
        const fullSerArcs = allArcs.filter((a) => String(a.series || a.category || '正文卷').trim() === serName);
        const { digestText, topChars } = buildSeriesDigestInBrowser(fullSerArcs);
        onProgress({
            phase: 'series_meta',
            done: completedArcs,
            total: totalTargetArcs,
            series: serName,
        });
        const metaPrompt =
            `你是《${bookName}》文本资料库总编。请根据以下「${serName}」的章节脉络与高频人物表，提炼全卷级检索元数据与知识图谱：\n` +
            `1. series_summary: 60-120字精炼概括本卷主线剧情、核心舞台与关键转折；\n` +
            `2. aliases: 同一人物/实体的本名、化名、外号、简称对照二维数组（每组至少2项，严禁把不同人混为一组，最多25组）；\n` +
            `3. glossary: 本卷重要势力、组织、小队编制、能力体系、核心地点或器物速查数组（每条“名称：一句话说明”，对核心小队/组织务必写全各分队或各期成员名单与更迭，如一队/二队/新老成员，最多20条）；\n` +
            `4. relations: 人物与人物、人物与组织/小队的知识图谱关系三元组数组，格式 [{"s":"主体","r":"关系(如:属于/队长/搭档/旧友/宿敌/救过/接任)","o":"客体"}]（最多40条）。\n` +
            `只输出严格 JSON：{"series_summary":"60-120字概括本卷主线、核心舞台与转折","aliases":[["正式名","化名/外号/简称"]],"glossary":["重要势力/小队/组织/地点：一句话说明（写明成员或分支）"],"relations":[{"s":"主体","r":"关系","o":"客体"}]}\n\n` +
            `高频人物：${topChars.length ? topChars.join(', ') : '（暂无）'}\n` +
            `章节脉络（共 ${fullSerArcs.length} 章）：\n${digestText}`;
        try {
            const parsedMeta = await callLlmJsonInBrowser(apiCfg, metaPrompt, signal);
            const serSum = String(parsedMeta.series_summary || '').trim();
            if (serSum) {
                pack.indexData.series_summaries[serName] = serSum;
                synthesizedSeries += 1;
            }
            if (Array.isArray(parsedMeta.aliases)) {
                extractedAliases.push(...parsedMeta.aliases);
            }
            if (Array.isArray(parsedMeta.glossary)) {
                extractedGlossary.push(...parsedMeta.glossary);
            }
            if (Array.isArray(parsedMeta.relations)) {
                extractedRelations.push(...parsedMeta.relations);
            }
        } catch (_) {
            // Non-fatal if series meta synthesis fails on a single volume
        }
    }

    if (extractedAliases.length) {
        pack.config.aliases = mergeAliasGroupsInBrowser(pack.config.aliases || [], extractedAliases);
    }
    if (extractedGlossary.length) {
        pack.config.glossary = mergeGlossaryInBrowser(pack.config.glossary || [], extractedGlossary);
    }
    if (extractedRelations.length) {
        pack.graphData = mergeRelationsInBrowser(pack.graphData || [], extractedRelations);
    }
    await persistStatsAndCheckpoint(true);

    return {
        upgradedArcs: completedArcs,
        upgradedScenes,
        synthesizedSeries,
        aliasesCount: (pack.config.aliases || []).length,
        glossaryCount: (pack.config.glossary || []).length,
        relationsCount: (pack.graphData || []).length,
    };
}
