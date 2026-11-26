#!/usr/bin/env node
/**
 * Build standalone LoreCodex release artifacts under dist/releases/v<version>/
 *
 * Produces 5 clean, targeted distribution assets:
 *  1. demo-chronicles.lorepack.json
 *     Single-file sample corpus bundle for direct import into TauriTavern / mobile IndexedDB.
 *  2. lorecodex-sillytavern-tauritavern-extension-v<version>.zip
 *     Pure frontend extension package for SillyTavern & TauriTavern (mobile/desktop) + sample .lorepack.json.
 *  3. lorecodex-agent-dsh-mcp-plugin-v<version>.zip
 *     Lightweight package exclusively for AI Agents (DeepSeek Harness `dsh` / Cordis plugin,
 *     MCP stdio server, Agent Skill, core 3-tier tree engine, and corpus builders — no Web UI or ST files).
 *  4. lorecodex-full-server-workbench-v<version>.zip
 *     Complete desktop distribution: Node server, Archival Codex & Trace Workbench Web UI,
 *     Python offline/LLM builders, SillyTavern/TauriTavern extension, and Agent integrations.
 *  5. lorecodex-cloud-builder-kit-v<version>.zip
 *     Ultra-lightweight zero-dependency Python builder kit + AGENT_INSTRUCTIONS.md for Cloud AI
 *     Tasks (Gemini App Task, Muse, Grok, Qoder, WorkBuddy, Claude) to split novels and export
 *     a ready-to-import .lorepack.json without local setup or external API keys.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectPythonBin } = require('../src/utils.js');

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '2.1.0';
const TAG = `v${VERSION}`;

const OUT_DIR = path.join(ROOT, 'dist', 'releases', TAG);
const STAGE_ROOT = path.join(ROOT, 'dist', '.stage');

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      if (ent === '__pycache__' || ent.endsWith('.pyc') || ent.endsWith('.ckpt.jsonl') || ent === 'ARCHITECTURE-V3-DESIGN.md' || ent === 'librarian_memory.json' || /^migrate_.*\.mjs$/i.test(ent)) continue;
      copyRecursive(path.join(src, ent), path.join(dest, ent));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function createZipFromDir(sourceDir, outZipPath) {
  const pyBin = detectPythonBin();
  const pyCode = [
    'import os, sys, zipfile',
    'src_dir, out_zip = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:',
    '    for root, dirs, files in os.walk(src_dir):',
    '        dirs.sort()',
    '        for f in sorted(files):',
    '            full = os.path.join(root, f)',
    '            rel = os.path.relpath(full, src_dir).replace("\\\\", "/")',
    '            zf.write(full, rel)',
  ].join('\n');
  execFileSync(pyBin, ['-c', pyCode, sourceDir, outZipPath], { stdio: 'inherit' });
}

function buildDemoLorepack(outPath) {
  const demoDir = path.join(ROOT, 'corpora', 'demo-chronicles');
  const indexData = JSON.parse(fs.readFileSync(path.join(demoDir, 'tree_index.json'), 'utf8'));
  const textsData = JSON.parse(fs.readFileSync(path.join(demoDir, 'tree_texts.json'), 'utf8'));
  const configPath = path.join(demoDir, 'corpus.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const graphPath = path.join(demoDir, 'graph.json');
  let graphData = [];
  if (fs.existsSync(graphPath)) {
    const parsedGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    if (Array.isArray(parsedGraph)) graphData = parsedGraph;
  }
  const nowIso = new Date().toISOString();
  const pack = {
    format: 'lorecodex-pack-v2',
    id: 'demo-chronicles',
    corpus_id: 'demo-chronicles',
    corpus_name: config.name || indexData.corpus_name || '苍穹残响·灰烬星港编年史',
    config,
    indexData,
    textsData,
    graphData,
    exportedAt: nowIso,
    exported_at: nowIso,
  };
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2), 'utf8');
  return pack;
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Build demo-chronicles.lorepack.json & sync embedded ui/ into extension/st-tree-lore/ui/
  const lorepackPath = path.join(OUT_DIR, 'demo-chronicles.lorepack.json');
  buildDemoLorepack(lorepackPath);
  const extUiDir = path.join(ROOT, 'extension', 'st-tree-lore', 'ui');
  fs.rmSync(extUiDir, { recursive: true, force: true });
  copyRecursive(path.join(ROOT, 'ui'), extUiDir);
  fs.copyFileSync(lorepackPath, path.join(extUiDir, 'demo-chronicles.lorepack.json'));
  console.log(`[1/5] Built ${path.relative(ROOT, lorepackPath)} & synced extension/st-tree-lore/ui/`);

  // 2. Build SillyTavern & TauriTavern pure-frontend extension zip
  const stStage = path.join(STAGE_ROOT, 'st-extension');
  copyRecursive(path.join(ROOT, 'extension', 'st-tree-lore'), path.join(stStage, 'st-tree-lore'));
  fs.copyFileSync(lorepackPath, path.join(stStage, 'demo-chronicles.lorepack.json'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(stStage, 'LICENSE'));
  fs.writeFileSync(
    path.join(stStage, 'README-EXTENSION.md'),
    [
      `# LoreCodex (${TAG}) — SillyTavern & TauriTavern 纯前端扩展包`,
      '',
      '本压缩包专为 **SillyTavern（酒馆）** 与 **TauriTavern（手机端 APK / 桌面端）** 玩家打包，内置 **IndexedDB 纯前端免服务端引擎**，无需安装 Node.js 或 Python 即可直接在浏览器或手机端建库、导入与多轮翻树检索。',
      '',
      '## 安装方式',
      '',
      '### 方式 A：酒馆内 GitHub URL 一键安装（推荐）',
      '在 SillyTavern / TauriTavern 顶部打开 **扩展 (Extensions) -> 安装扩展 (Install Extension)**，输入：',
      '```text',
      'https://github.com/lena13144/lorecodex',
      '```',
      '',
      '### 方式 B：离线手动解压安装',
      '1. 将本压缩包内的 `st-tree-lore` 文件夹解压到酒馆目录的 `public/scripts/extensions/third-party/st-tree-lore/`。',
      '2. 刷新酒馆页面，展开右侧 **「LoreCodex 典籍检索」** 极简卡片（支持顶部小太阳/小月亮切换素笺浅色 / 墨灯深色主题）。',
      '3. 点击 **「打开 LoreCodex 大面板」**，在工作台顶栏点击 **「导入」** 导入本包附带的 `demo-chronicles.lorepack.json`，或直接导入 `.txt` / `.md` / `.epub` 小说与世界书 `.json`，随后可手动启动 LLM 目录构建并在侧边栏实时查看进度条。',
      '',
    ].join('\n'),
    'utf8'
  );
  const stZipPath = path.join(OUT_DIR, `lorecodex-sillytavern-tauritavern-extension-${TAG}.zip`);
  createZipFromDir(stStage, stZipPath);
  console.log(`[2/5] Built ${path.relative(ROOT, stZipPath)}`);

  // 3. Build AI Agent (DeepSeek Harness `dsh` / Cordis + MCP + Agent Skill) standalone zip
  const agentStage = path.join(STAGE_ROOT, 'agent-plugin');
  fs.mkdirSync(path.join(agentStage, 'src'), { recursive: true });
  for (const f of [
    'dsh_plugin.js',
    'mcp_server.js',
    'corpus_manager.js',
    'tree_agent.js',
    'llm_stream.js',
    'prompt_builder.js',
    'grep_engine.js',
    'librarian_memory.js',
    'utils.js',
  ]) {
    fs.copyFileSync(path.join(ROOT, 'src', f), path.join(agentStage, 'src', f));
  }
  copyRecursive(path.join(ROOT, 'builders'), path.join(agentStage, 'builders'));
  copyRecursive(path.join(ROOT, 'skills'), path.join(agentStage, 'skills'));
  copyRecursive(path.join(ROOT, 'corpora', 'demo-chronicles'), path.join(agentStage, 'corpora', 'demo-chronicles'));
  fs.copyFileSync(path.join(ROOT, 'cordis.patch.yml'), path.join(agentStage, 'cordis.patch.yml'));
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(agentStage, 'config.example.json'));
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(agentStage, 'LICENSE'));

  const agentPkg = {
    name: 'lorecodex',
    version: VERSION,
    description:
      'LoreCodex native plugin for DeepSeek Harness (dsh / Cordis) and MCP stdio server for vectorless 3-tier tree navigation and millisecond in-RAM grep.',
    main: 'src/dsh_plugin.js',
    exports: {
      '.': './src/dsh_plugin.js',
      './dsh': './src/dsh_plugin.js',
      './mcp': './src/mcp_server.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    },
    dsh: {
      bundle: {
        patch: './cordis.patch.yml',
      },
    },
    bin: {
      'lorecodex-mcp': './src/mcp_server.js',
    },
    engines: {
      node: '>=18.0.0',
    },
    scripts: {
      mcp: 'node src/mcp_server.js',
    },
    keywords: ['dsh-plugin', 'cordis', 'deepseek-harness', 'mcp', 'vectorless-rag', 'pageindex', 'llm-agent'],
    author: 'lena13144',
    license: 'MIT',
  };
  fs.writeFileSync(path.join(agentStage, 'package.json'), JSON.stringify(agentPkg, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(agentStage, 'README-AGENT-PLUGIN.md'),
    [
      `# LoreCodex (${TAG}) — DeepSeek Harness (\`dsh\`) Plugin & MCP / Skill 独立包`,
      '',
      '本压缩包专为 **DeepSeek Harness (`@deepseek-ai/dsh`)**、**Claude Code**、**Cursor**、**Antigravity** 等原生 AI Agent 打包，剔除了所有 SillyTavern 前端与 Web UI 静态资源，仅保留核心三层树推理引擎、Cordis 插件入口、MCP Server 与建库脚本。',
      '',
      '## 1. 在 DeepSeek Harness (`dsh`) 中使用',
      '',
      '直接通过 GitHub 一键挂载插件：',
      '```bash',
      'dsh plugin --profile web add "github:lena13144/lorecodex"',
      '```',
      '或将本包解压后在您的 `cordis.patch.yml` 中引用 `src/dsh_plugin.js`。插件会自动通过 `ctx.tools.register` 向 DeepSeek Harness 注册全部 8 个三层树与毫秒级 Grep 工具。',
      '',
      '## 2. 作为标准 MCP Server 挂载 (Claude Code / Cursor / Antigravity)',
      '',
      '在 `mcpServers` 配置中添加：',
      '```json',
      '{',
      '  "mcpServers": {',
      '    "lorecodex": {',
      '      "command": "node",',
      '      "args": ["/absolute/path/to/lorecodex/src/mcp_server.js"]',
      '    }',
      '  }',
      '}',
      '```',
      '',
      '## 3. 作为 Agent Skill 挂载',
      '将包内的 `skills/lorecodex/SKILL.md` 复制到您的 Agent `skills/` 目录下即可。',
      '',
    ].join('\n'),
    'utf8'
  );
  const agentZipPath = path.join(OUT_DIR, `lorecodex-agent-dsh-mcp-plugin-${TAG}.zip`);
  createZipFromDir(agentStage, agentZipPath);
  console.log(`[3/5] Built ${path.relative(ROOT, agentZipPath)}`);

  // 4. Build Full Desktop Server + Archival Codex Workbench UI zip
  const fullStage = path.join(STAGE_ROOT, 'full-workbench');
  for (const dirName of ['src', 'ui', 'builders', 'extension', 'skills', 'docs', 'scripts']) {
    copyRecursive(path.join(ROOT, dirName), path.join(fullStage, dirName));
  }
  copyRecursive(path.join(ROOT, 'corpora', 'demo-chronicles'), path.join(fullStage, 'corpora', 'demo-chronicles'));
  for (const fileName of [
    'package.json',
    'manifest.json',
    'cordis.patch.yml',
    'config.example.json',
    'README.md',
    'README.en.md',
    'LICENSE',
  ]) {
    fs.copyFileSync(path.join(ROOT, fileName), path.join(fullStage, fileName));
  }
  const fullZipPath = path.join(OUT_DIR, `lorecodex-full-server-workbench-${TAG}.zip`);
  createZipFromDir(fullStage, fullZipPath);
  console.log(`[4/5] Built ${path.relative(ROOT, fullZipPath)}`);

  // 5. Build Cloud AI / Agent Standalone Builder Kit zip (pure zero-dep Python + SOP prompt)
  const kitStage = path.join(STAGE_ROOT, 'cloud-builder-kit');
  fs.mkdirSync(path.join(kitStage, 'builders'), { recursive: true });
  for (const pyFile of ['build_novel.py', 'build_lore.py', 'slice_batches.py', 'pack_lorepack.py']) {
    fs.copyFileSync(path.join(ROOT, 'builders', pyFile), path.join(kitStage, 'builders', pyFile));
  }
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(kitStage, 'LICENSE'));
  fs.writeFileSync(
    path.join(kitStage, 'AGENT_INSTRUCTIONS.md'),
    [
      `# LoreCodex Cloud Builder Kit (${TAG}) — Agent Execution SOP`,
      '',
      'You have been given this zero-dependency Python builder kit alongside one or more user source files (`.txt`, `.epub`, `.md` novels, and/or SillyTavern worldbook/character card `.json`).',
      'Your goal is to build a high-quality, ready-to-import **`<corpus_id>.lorepack.json`** file for LoreCodex.',
      '',
      "## Workflow (5 Steps)",
      "",
      "### Step 1: Offline Split & Structure Preflight",
      "Run the zero-dependency Python splitter first (never spend external API calls before checking structure):",
      "```bash",
      "python3 builders/build_novel.py --input \"<source_file>\" --corpus-id \"<slug>\" --name \"<Book Title>\" --no-llm --out-dir ./out",
      "```",
      "- If the user also provided a SillyTavern worldbook or V2 character card `.json`, merge it into the same corpus:",
      "  ```bash",
      "  python3 builders/build_lore.py --input \"<worldbook.json>\" --corpus-id \"<slug>\" --merge-into ./out/<slug>",
      "  ```",
      "- Inspect the `[build_novel] preflight:` line. If `series` looks wrong because the book uses Markdown `# Volume` headings, re-run with `--h1-is-volume`. If scraped web noise remains, use `--strip-block \"start=<RE>||end=<RE>\"`.",
      "",
      "### Step 2: Slice Into Batches",
      "`tree_texts.json` holds the whole book in one file (tens of MB for a long novel). **Do not open it directly.** Slice it into numbered batches of bounded size:",
      "```bash",
      "python3 builders/slice_batches.py --corpus-dir ./out/<slug> --batch-chars 40000",
      "```",
      "This writes `./out/<slug>/batches/batch_001.md ...` (each scene under a `## [node_id=XXXX]` heading, grouped under `# 篇章 [arc_id=XXXX]`) and `batches/manifest.json` (batch → node_ids, arcs, series, chars, status). Lower `--batch-chars` if one batch does not fit comfortably in your context.",
      "",
      "### Step 3: Summarize One Batch at a Time (Loop)",
      "Repeat until every batch is done:",
      "1. Run `python3 builders/slice_batches.py --corpus-dir ./out/<slug> --status` and take the `next:` batch.",
      "2. Read **only** that `batches/batch_NNN.md`. Never write a summary for a scene you have not read in this batch.",
      "3. Write `batches/meta_NNN.json`:",
      "   - `scene_summaries`: **exactly** the node_ids listed at the top of the batch file — one entry each, no extra ids. Each summary is 80–150 Chinese (or source-language) characters, resolves pronouns (\"他/她/对方\") into canonical names, and names key events, places and turns. Add the characters present.",
      "   - `arc_summaries`: one 1–2 sentence summary for each arc listed under \"本批结束的多幕篇章\" (single-scene arcs reuse their scene summary automatically).",
      "   - `series_summaries`: for each volume listed under \"本批结束的分卷\", first run `python3 builders/slice_batches.py --corpus-dir ./out/<slug> --digest-series \"<卷名>\"` to see all summaries written for it, then write a 60–120 character overview.",
      "   - `aliases` / `glossary`: add what this batch introduces (they are merged across batches).",
      "4. Apply it right away:",
      "   ```bash",
      "   python3 builders/pack_lorepack.py --corpus-dir ./out/<slug> --apply-meta ./out/<slug>/batches/meta_NNN.json --out <slug>.lorepack.json --strict",
      "   ```",
      "   This writes the summaries into `tree_index.json` and updates `manifest.json`. A non-zero exit or a `WARN` line means an id in your meta file does not exist, or some node_ids are still missing: fix `meta_NNN.json` and apply it again before moving on.",
      "5. If the session is interrupted, start a new one and continue from step 1: progress lives in the files, not in your memory.",
      "",
      "Schema of `meta_NNN.json`:",
      "```json",
      "{",
      "  \"scene_summaries\": {",
      "    \"0002\": { \"summary\": \"...\", \"characters\": [\"角色A\", \"角色B\"], \"keywords\": [\"关键词\"] }",
      "  },",
      "  \"arc_summaries\": {",
      "    \"0001\": \"...\"",
      "  },",
      "  \"series_summaries\": {",
      "    \"第一卷\": \"...\"",
      "  },",
      "  \"aliases\": [",
      "    [\"本名\", \"化名\", \"外号\"]",
      "  ],",
      "  \"glossary\": [",
      "    \"专有名词：简明释义\"",
      "  ]",
      "}",
      "```",
      "*(If the user explicitly supplied an external API key and asked to use it, write `chatBase`, `chatKey`, and `chatModel` into a `config.json` file and run `python3 builders/build_novel.py --upgrade --corpus-id <slug> --out-dir ./out --config <config.json> --workers 8` to skip Steps 2–3.)*",
      "",
      "### Step 4: Final Export & Coverage Check",
      "After the last batch, export once more without new meta files:",
      "```bash",
      "python3 builders/pack_lorepack.py --corpus-dir ./out/<slug> --out <slug>.lorepack.json --strict",
      "```",
      "Verify `llm_toc=X/Y (100.0%)` and that `slice_batches.py --status` reports all batches done. Exit code must be `0`.",
      "",
      "### Step 5: Deliver to User",
      "Provide the generated **`<slug>.lorepack.json`** file to the user for download, along with a short summary (volumes, arcs, scenes, aliases count, glossary count).",
      "",
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(kitStage, 'README-BUILDER-KIT.md'),
    [
      `# LoreCodex 云端 AI 拆书工具包 (${TAG})`,
      '',
      '本压缩包是 **完全解耦的纯 Python 零依赖拆书工具包**，专为 **Gemini App Task、Muse、Grok、Qoder、WorkBuddy、Claude** 等带云端沙盒的 AI 工具设计。',
      '',
      '无需在手机或电脑上折腾环境，也无需额外填外部 API Key——把本包和小说一起发给云端 AI，让它直接用自身算力切树、写目录摘要、提炼人物别名表，并输出单文件 **`.lorepack.json`** 供酒馆 1 秒导入！',
      '',
      '## 30 秒使用方式',
      '',
      '1. 将本压缩包 **`lorecodex-cloud-builder-kit-' + TAG + '.zip`** 和你的小说文件（`.txt` / `.epub` / `.md`，可选附带世界书 `.json`）一起上传给云端 AI（如 Gemini App Task / Muse / Qoder / WorkBuddy）。',
      '2. 发送下面这段提示词即可：',
      '',
      '```text',
      '请解压附件中的 lorecodex-cloud-builder-kit，严格按照里面的 AGENT_INSTRUCTIONS.md 执行拆书流程：',
      '1. 先用 builders/build_novel.py --no-llm 离线切分我上传的小说（若附带世界书请一并合并）；',
      '2. 用 builders/slice_batches.py 把原文切成批次，每次只读一批，补全分幕摘要（注意把代词消解为具体人名）、篇章与分卷总览、人物别名对照表(aliases)和专有术语表(glossary)；',
      '3. 每写完一批就用 builders/pack_lorepack.py --apply-meta 回填校验，全部完成后打包输出最终的 .lorepack.json 文件供我下载。',
      '```',
      '',
      '长篇小说会分很多批完成。如果会话中断或上下文用完，换一个新会话，重新上传工具包和上次的 out 目录，说“按 AGENT_INSTRUCTIONS.md 继续 LoreCodex 拆书”，它会从 batches/manifest.json 记录的进度接着做。',
      '',
      '3. 下载云端 AI 生成的 `.lorepack.json`，在 SillyTavern / TauriTavern 中打开 **LoreCodex 大面板 → 导入**，1 秒导入即可开玩！',
      '',
    ].join('\n'),
    'utf8'
  );
  const kitZipPath = path.join(OUT_DIR, `lorecodex-cloud-builder-kit-${TAG}.zip`);
  createZipFromDir(kitStage, kitZipPath);
  console.log(`[5/5] Built ${path.relative(ROOT, kitZipPath)}`);

  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  console.log(`\nAll 5 release artifacts generated in ${path.relative(ROOT, OUT_DIR)}`);
}

main();
