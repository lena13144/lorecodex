// Offline harness for extension/st-tree-lore/index.js.
// Builds a throwaway fake SillyTavern tree (stub script.js / extensions.js / slash-commands) plus a stub
// browser_engine.js whose tree agent records every search payload, then drives the real index.js through
// its generate_interceptor the same way SillyTavern's runGenerationInterceptors does.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_SRC = path.join(ROOT, 'extension', 'st-tree-lore');

const STUB_SCRIPT = `
export const extension_prompt_types = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const event_types = new Proxy({}, { get: (_t, k) => String(k) });
export const eventSource = { on: (ev, fn) => { (globalThis.__lc.listeners[ev] ||= []).push(fn); } };
export function saveSettingsDebounced() {}
export function setExtensionPrompt(tag, text, pos, depth, scan, role) {
  globalThis.__lc.prompts.push({ tag, text, pos, depth, scan, role });
}
`;
const STUB_EXTENSIONS = `
export const extension_settings = globalThis.__lc.extension_settings;
export function getContext() { return globalThis.__lc.context; }
`;
const STUB_SLASH = 'export class SlashCommand { static fromProps(p) { return p; } }';
const STUB_PARSER = 'export class SlashCommandParser { static addCommandObject() {} }';
const STUB_ENGINE = `
const noop = () => {};
export const idbListCorpora = async () => globalThis.__lc.packs;
export const idbSaveCorpus = async () => {};
export const idbDeleteCorpus = async () => {};
export const idbGetMeta = async (_k, fb = null) => fb;
export const idbSetMeta = async () => {};
export const idbRecordRun = async () => ({ id: 'run_test' });
export const decodeTextBufferAuto = noop;
export const extractEpubTextInBrowser = noop;
export const buildNovelCorpusInBrowser = noop;
export const buildLoreCorpusInBrowser = noop;
export const isArcLlmDone = () => true;
export const upgradeBrowserCorpusWithLLM = noop;
export const estimateBrowserLlmUpgradePlan = noop;
export const inspectCorpusStructure = () => ({});
export const acquireCorpusBuildLock = () => ({ ok: true, release: noop });
export const formatDurationZh = (ms) => ms + 'ms';
export function createBrowserTreeAgent(pack) {
  return {
    id: pack.id,
    async search(payload) {
      globalThis.__lc.payloads.push(payload);
      if (globalThis.__lc.searchGate) await globalThis.__lc.searchGate;
      return globalThis.__lc.searchResult(payload);
    },
  };
}
`;

function buildFakeSt() {
  const stRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-st-'));
  const extDir = path.join(stRoot, 'scripts', 'extensions', 'third-party', 'st-tree-lore');
  fs.mkdirSync(path.join(stRoot, 'scripts', 'slash-commands'), { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(stRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(stRoot, 'script.js'), STUB_SCRIPT);
  fs.writeFileSync(path.join(stRoot, 'scripts', 'extensions.js'), STUB_EXTENSIONS);
  fs.writeFileSync(path.join(stRoot, 'scripts', 'slash-commands', 'SlashCommand.js'), STUB_SLASH);
  fs.writeFileSync(path.join(stRoot, 'scripts', 'slash-commands', 'SlashCommandParser.js'), STUB_PARSER);
  fs.copyFileSync(path.join(EXT_SRC, 'index.js'), path.join(extDir, 'index.js'));
  fs.writeFileSync(path.join(extDir, 'browser_engine.js'), STUB_ENGINE);
  return { stRoot, extIndex: path.join(extDir, 'index.js') };
}

function installGlobals() {
  const lc = {
    listeners: {},
    prompts: [],
    payloads: [],
    extension_settings: {},
    context: { chat: [], name1: 'lena', name2: '特市' },
    packs: [{ id: 'demo', config: { name: 'Demo', prompt_framing: {} }, indexData: { arcs: [] }, textsData: {} }],
    searchGate: null,
    searchResult: () => ({
      corpus_id: 'demo',
      scenes: [{ node_id: '0001', arc_title: '第一章', title: '雷达室', text: '苏璃：信号又来了。' }],
      guide: '导读 [0001]',
      took_ms: 1,
      turns: 2,
    }),
  };
  globalThis.__lc = lc;
  // Minimal jQuery stand-in: the interceptor path must work without the settings panel mounted.
  const empty = {
    length: 0,
    html() { return this; },
    on() { return this; },
    val() { return ''; },
    prop() { return this; },
    toggle() { return this; },
    show() { return this; },
    hide() { return this; },
    find() { return this; },
  };
  globalThis.$ = () => empty;
  globalThis.jQuery = () => {}; // never run the UI bootstrap
  globalThis.toastr = { warning() {}, info() {}, success() {}, error() {} };
  return lc;
}

const userMsg = (mes) => ({ is_user: true, is_system: false, name: 'lena', mes });
const aiMsg = (mes) => ({ is_user: false, is_system: false, name: '特市', mes });

export async function testStExtension() {
  console.log('\n[7.6/9] Testing SillyTavern extension trigger (generate_interceptor, literal-only retrieval input)...');

  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
  const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.generate_interceptor, 'loreCodexGenerateInterceptor', 'extension manifest must declare generate_interceptor');
  assert.strictEqual(rootManifest.generate_interceptor, manifest.generate_interceptor, 'root manifest must declare the same interceptor');

  const lc = installGlobals();
  const { stRoot, extIndex } = buildFakeSt();
  try {
    await import(pathToFileURL(extIndex).href);
    const interceptor = globalThis[manifest.generate_interceptor];
    assert.strictEqual(typeof interceptor, 'function', 'index.js must register the interceptor on globalThis');
    assert(!lc.listeners.WORLDINFO_ENTRIES_LOADED, 'retrieval must not listen to WORLDINFO_ENTRIES_LOADED');
    assert(!lc.listeners.GENERATION_STARTED, 'retrieval must not hook GENERATION_STARTED');

    const run = async (chat, type = 'normal') => {
      lc.prompts.length = 0;
      lc.payloads.length = 0;
      lc.context.chat = chat;
      await interceptor(chat, 8192, () => {}, type);
    };

    // Before any corpus is loaded the interceptor must fail soft and clear.
    await run([userMsg('你好')]);
    const settings = lc.extension_settings.st_tree_lore;
    assert(settings && settings.enabled === true, 'getSettings must seed defaults');
    for (const gone of ['customFollowUpHint', 'customBoilerplateRegex', 'customSummaryPriorityRegex']) {
      assert(!(gone in settings), `removed setting ${gone} must not be seeded`);
    }
    assert(lc.prompts.length >= 1 && lc.prompts.every((p) => p.text === ''), 'missing corpus must clear the injection');

    settings.localMode = true;
    settings.corpus = 'demo';
    assert.strictEqual(typeof globalThis.__loreCodexTestHooks?.refreshCorpora, 'function', 'index.js must expose refreshCorpora test hook');
    await globalThis.__loreCodexTestHooks.refreshCorpora();

    // 1) Literal input only: AI-side markers and memory-recall blocks are ignored, no state hints.
    await run([
      aiMsg('上次的事我还记得。【查原文：M4 塔顶原话】'),
      userMsg('<details>思考</details>我们晚上吃什么？\n# 记忆召回\nAM0012 莱娅曾经说过……'),
    ]);
    assert.strictEqual(lc.payloads.length, 1, 'exactly one search per generation');
    let p = lc.payloads[0];
    assert.strictEqual(p.query, '我们晚上吃什么？', 'query is the cleaned literal user text');
    assert.strictEqual(p.onDemand, '', 'an AI-side 【查原文】 marker must not trigger on-demand retrieval');
    assert(!('activeStateHints' in p), 'payload must not carry world-info state hints');
    assert(Array.isArray(p.recentChat) && p.recentChat.length === 2, 'recent turns are still passed');
    assert.strictEqual(p.sceneAnchor.charName, '特市');
    const injected = lc.prompts.filter((x) => x.text).pop();
    assert(injected, 'a hit must be injected');
    assert(injected.text.includes('苏璃：信号又来了。'), 'scene text injected');
    assert(!/查原文|追查/.test(injected.text), 'injection must not carry the follow-up marker hint');
    assert.strictEqual(injected.depth, 1);
    assert.strictEqual(p.sessionRecall, undefined, 'bare AM ids (content lives in world info) must not be forwarded');

    // 1b) Database recall in the real wrapper format: keep only "id(summary)" items, drop bare ids and <supplement>.
    await run([
      userMsg(
        '以下是用户的本轮输入：\n<本轮用户输入>\n看向两份报告所代表的异常，随后开始思考\n</本轮用户输入>\n\n' +
          '以下输入的代码为接下来剧情相关记忆条目的对应的索引编码。\n<recall>\n# 记忆召回\n## 从总结大纲索引\n' +
          'AM0022(芙拉米尔最初交代异常物收容委托规则及追查蓝蝶线索的背景), AM0057, AM0092（Lena拍板主动出击并先赴老钟表行走手续）\n\n' +
          '---\n合计：3条（全部来自总结大纲）\n</recall>\n\n<supplement>\n# 补充信息（6-8条）\n- [背景设定] 特市物价锚点(1公斤原型食物2大洋国元)\n</supplement>'
      ),
    ]);
    p = lc.payloads[0];
    assert.strictEqual(p.query, '看向两份报告所代表的异常，随后开始思考', 'wrapper and recall block stripped from query');
    assert.deepStrictEqual(
      p.sessionRecall,
      ['AM0022 芙拉米尔最初交代异常物收容委托规则及追查蓝蝶线索的背景', 'AM0092 Lena拍板主动出击并先赴老钟表行走手续'],
      'session recall keeps id(summary) items only'
    );

    // 2) The user literally asks for the original line → onDemand = the query.
    await run([userMsg('M4 当时在塔顶说的原话是什么？')]);
    p = lc.payloads[0];
    assert.strictEqual(p.onDemand, p.query, "the user's explicit quote request drives onDemand");

    // 3) quiet generations are ignored entirely.
    await run([userMsg('M4 原话')], 'quiet');
    assert.strictEqual(lc.payloads.length, 0, 'quiet generations must not search');
    assert.strictEqual(lc.prompts.length, 0, 'quiet generations must not touch the injection');

    // 4) Disabled → clear stale injection, no search.
    settings.enabled = false;
    await run([userMsg('还记得吗')]);
    assert.strictEqual(lc.payloads.length, 0);
    assert(lc.prompts.length === 1 && lc.prompts[0].text === '', 'disabling must clear the previous injection');
    settings.enabled = true;

    // 5) No user text → clear.
    await run([aiMsg('只有角色在说话')]);
    assert.strictEqual(lc.payloads.length, 0);
    assert(lc.prompts.length === 1 && lc.prompts[0].text === '', 'no user input must clear the injection');

    // 6) Overlapping generation → the second call clears instead of reusing a stale block.
    let release;
    lc.searchGate = new Promise((r) => { release = r; });
    lc.prompts.length = 0;
    lc.payloads.length = 0;
    const chat = [userMsg('第一次的问题')];
    lc.context.chat = chat;
    const first = interceptor(chat, 8192, () => {}, 'normal');
    await new Promise((r) => setTimeout(r, 0));
    await interceptor(chat, 8192, () => {}, 'normal');
    assert(lc.prompts.length === 1 && lc.prompts[0].text === '', 'concurrent run must clear the injection');
    release();
    await first;
    lc.searchGate = null;
    assert.strictEqual(lc.payloads.length, 1, 'concurrent run must not start a second search');

    // 6b) The interceptor's chat is ST's coreChat (prompt-only regex applied, attachments appended); retrieval
    //     must read the raw chat from getContext() instead.
    lc.prompts.length = 0;
    lc.payloads.length = 0;
    lc.context.chat = [userMsg('雷达室那晚说了什么')];
    await interceptor([{ ...userMsg('<被正则改写的提示词版本>') }], 8192, () => {}, 'normal');
    assert.strictEqual(lc.payloads[0]?.query, '雷达室那晚说了什么', 'retrieval reads the raw chat, not the regexed coreChat');

    // 7) depth 0 is honoured (used to be coerced to 1).
    settings.depth = 0;
    await run([userMsg('雷达室那晚')]);
    assert.strictEqual(lc.prompts.filter((x) => x.text).pop()?.depth, 0, 'depth 0 must be preserved');
    settings.depth = 1;

    console.log('  PASS: interceptor retrieval uses literal user text only; stale injections cleared; quiet/depth handled');
  } finally {
    fs.rmSync(stRoot, { recursive: true, force: true });
    delete globalThis.__lc;
    delete globalThis.__loreCodexTestHooks;
    delete globalThis.loreCodexGenerateInterceptor;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  testStExtension().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
