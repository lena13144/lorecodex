#!/usr/bin/env node
/**
 * Build standalone LoreCodex release artifacts under dist/releases/v<version>/
 *
 * Produces 4 clean, targeted distribution assets:
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
      if (ent === '__pycache__' || ent.endsWith('.pyc') || ent.endsWith('.ckpt.jsonl')) continue;
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
  const pack = {
    format: 'lorecodex-pack-v2',
    exported_at: new Date().toISOString(),
    corpus_id: 'demo-chronicles',
    corpus_name: indexData.corpus_name || '苍穹残响·灰烬星港编年史',
    indexData,
    textsData,
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
  console.log(`[1/4] Built ${path.relative(ROOT, lorepackPath)} & synced extension/st-tree-lore/ui/`);

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
      '2. 刷新酒馆页面，在「扩展 -> LoreCodex 书阁旁路检索」中展开 **「TauriTavern / 手机免服务端内置书库 (IndexedDB 纯前端引擎)」**。',
      '3. 可直接点击「选择文件并构建入库」导入本包附带的 `demo-chronicles.lorepack.json`，或直接选择您的 `.txt` / `.md` 小说、世界书 `.json` 或角色卡 V2 `.json` 构建入库。',
      '',
    ].join('\n'),
    'utf8'
  );
  const stZipPath = path.join(OUT_DIR, `lorecodex-sillytavern-tauritavern-extension-${TAG}.zip`);
  createZipFromDir(stStage, stZipPath);
  console.log(`[2/4] Built ${path.relative(ROOT, stZipPath)}`);

  // 3. Build AI Agent (DeepSeek Harness `dsh` / Cordis + MCP + Agent Skill) standalone zip
  const agentStage = path.join(STAGE_ROOT, 'agent-plugin');
  fs.mkdirSync(path.join(agentStage, 'src'), { recursive: true });
  for (const f of [
    'dsh_plugin.js',
    'mcp_server.js',
    'corpus_manager.js',
    'tree_agent.js',
    'prompt_builder.js',
    'grep_engine.js',
    'graph_engine.js',
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
  console.log(`[3/4] Built ${path.relative(ROOT, agentZipPath)}`);

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
  console.log(`[4/4] Built ${path.relative(ROOT, fullZipPath)}`);

  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  console.log(`\nAll 4 release artifacts generated in ${path.relative(ROOT, OUT_DIR)}`);
}

main();
