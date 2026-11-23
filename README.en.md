# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Pure Frontend & Node >= 18](https://img.shields.io/badge/Runtime-Browser%20IndexedDB%20%7C%20Node%20%3E%3D18-339933?style=flat-square)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**Vectorless Tree-Reasoning + Millisecond In-RAM Alias Grep + Native-Reasoning Sidecar Memory Agent for Long-Form Fiction, Game Lore, SillyTavern / TauriTavern & Native AI Agents**

> **Zero backend required. Zero dependencies. Zero vector DB. Zero chunk fragmentation.**  
> Combine multi-million-character novels (`.txt` / `.epub` / `.md`), game event scripts, and SillyTavern worldbooks into a single `Series → Arc → Scene` narrative tree. Let a fast, native-reasoning sidecar model navigate the Table of Contents concurrently, scan millions of characters in milliseconds with alias-aware `grep_scenes`, read complete scenes verbatim in batches, and hand grounded narrative cues to your main model.

[简体中文说明 (Default)](./README.md)

---

## Why LoreCodex?

1. **100% Serverless-First In-Browser Engine for SillyTavern & TauriTavern (Desktop & Mobile)**:  
   The extension bundles a complete **IndexedDB in-browser engine (`browser_engine.js`)** and **embedded Archival Codex & Trace Workbench UI (`extension/st-tree-lore/ui/`)**. Once installed via GitHub URL in SillyTavern or TauriTavern, **no Node.js, Python, or Termux backend process is required**—build trees, run concurrent LLM directory summarization with checkpoint resume, browse the Codex, and replay waterfall traces purely inside your browser or mobile WebView.
2. **Unify Original Novels + Worldbooks + V2 Character Cards**:  
   Natively parses `.txt` (auto UTF-8 / UTF-16 / GB18030 detection), `.epub` (pure-browser ZIP extraction via native `DecompressionStream`), `.md`, SillyTavern worldbook `.json`, Character Card V2 `.json` (`character_book`), and single-file `.lorepack.json` bundles into one unified 3-tier tree.
3. **LLM Directory Construction & Auto-Alias Synthesis**:  
   Concurrent per-volume LLM directory summarization resolves pronouns into canonical names, generates scene summaries and volume `series_summaries`, and automatically synthesizes 2D character `aliases` and `glossary` terms with real-time IndexedDB / JSONL checkpointing.
4. **Verbatim Scene Injection & Millisecond Cameo Grep**:  
   `read_scene` (up to 10 scenes per batch call) injects complete, un-truncated original scenes while `grep_scenes` expands character aliases across millions of characters in `< 15ms` and flags uncredited `[CAMEO]` appearances.
5. **Hardware-Level Spoiler Gate (`maxOrder`)**:  
   `order <= maxOrder` is strictly enforced across TOC, Grep, scene reads, and agent tools while preserving timeless lore (`order: null`).

---

## Workbench Preview

| Book-Scroll · **Paper (`素笺`)** Dossier & Waterfall Trace | Modern Workbench · **Studio Dark (`曜夜`)** Alias Grep & Highlight |
| :---: | :---: |
| ![LoreCodex Paper Theme Preview](./docs/preview-paper.png) | ![LoreCodex Studio Dark Theme Preview](./docs/preview-studio-dark.png) |

---

## Quick Start (Zero-Backend Default for SillyTavern & TauriTavern)

1. **One-Click Install**: In SillyTavern or TauriTavern, open **Extensions → Install Extension** and paste:
   ```text
   https://github.com/lena13144/lorecodex
   ```
2. **Minimal Editorial Sidebar & Embedded Workbench**: Expand **LoreCodex 典籍检索** in the sidebar—a single clean card (supporting **Ink & Lamp** dark and **Paper** light themes) with enable switch, corpus selector + one-click character binding, live **LLM Index Progress Bar**, last-retrieval summary, and **「打开 LoreCodex 大面板」** (or `/loreui`).
3. **Configure Model & Two-Step Safe Import**:
   - Click **「去配置」** (or **「模型」** inside the workbench) to set your OpenAI-compatible **API Base URL**, **API Key**, and model (`Max Tokens` left blank uses the model's native limit).
   - Click **「导入」** to upload `.txt` / `.epub` / `.md` novels or `.json` worldbooks/cards: LoreCodex runs a free offline split + structure preflight preview first, then lets you manually start LLM directory building with checkpoint resume.
   - Use **「书库管理」** to inspect LLM coverage, open, export `.lorepack.json`, or permanently delete corpora, and **「酒馆设置」** for visual chapter/volume spoiler-gate selection and POV.

---

## Standalone Release Packages & Native Agent Integrations (DeepSeek Harness `dsh` / MCP / Skill)

[**GitHub Releases**](https://github.com/lena13144/lorecodex/releases) provides 3 targeted standalone packages so users only download what they need:

1. **`lorecodex-sillytavern-tauritavern-extension-v2.2.0.zip`** — Pure frontend extension for SillyTavern & TauriTavern (mobile/desktop) with the v2.2 minimal dual-theme sidebar, built-in IndexedDB serverless engine, embedded Workbench UI, native TXT/GB18030/EPUB/JSON builders, in-browser LLM directory upgrader, and `demo-chronicles.lorepack.json`.
2. **`lorecodex-agent-dsh-mcp-plugin-v2.2.0.zip`** — Lightweight package for AI Agents containing the **DeepSeek Harness (`@deepseek-ai/dsh` / Cordis)** plugin (`src/dsh_plugin.js` + `cordis.patch.yml`), zero-dependency **MCP stdio server** (`src/mcp_server.js`), and **Agent Skill** (`skills/lorecodex/SKILL.md`), exposing 9 tools (`lorecodex_list_corpora`, `lorecodex_list_series`, `lorecodex_list_arcs`, `lorecodex_expand_arc`, `lorecodex_grep_scenes`, `lorecodex_read_scenes`, `lorecodex_build_corpus`, `lorecodex_update_index_meta`, and `lorecodex_ask_agent`).
3. **`lorecodex-full-server-workbench-v2.2.0.zip`** — Complete distribution including the optional standalone Node HTTP server (`src/server.js`, also useful for bypassing browser CORS on custom API relays), Python CLI builders (`builders/`, with web/MediaWiki JS/CSS noise stripping and `--h1-is-volume` / `--strip-block` / `--allow-noisy`), Workbench UI, SillyTavern extension, and Agent integrations.

```bash
# Install directly into DeepSeek Harness (dsh):
dsh plugin --profile web add "github:lena13144/lorecodex"
```

---

## Verification

```bash
# Offline zero-API-key test suite ([1/9] to [8/9]):
npm test

# Build all 4 release distribution assets under dist/releases/:
npm run build:releases
```

---

## Why No Vector DB — and Why Even the Backend Server Became Optional?

1. **Stage 1: Traditional Vector RAG (Chunking + Embedding + Rerank + Heavy Backend)**  
   Fixed-length chunking shattered dramatic scenes and dialogue continuity, cosine similarity failed on character nicknames and timeline questions, and storing hundred-megabyte vector indexes forced every user to run a local backend server.
2. **Stage 2: Tree TOC + Vector Fallback (The Eye-Opening Transition)**  
   Inspired by PageIndex, we built a 3-tier LLM-summarized directory tree paired with millisecond in-RAM alias Grep while keeping vector search as a fallback. Real execution traces revealed a striking truth: **given a deterministic 3-tier TOC and a 1ms alias-aware full-text Grep, modern reasoning models chose not to call the vector fallback tool 99.9% of the time.**
3. **Stage 3: Embracing the Agent Era (Vectorless, Serverless-First, Unleashed Native Reasoning)**  
   Once we removed the unused vector layer, we realized that our true core assets—**LLM-distilled 3-tier directory trees (`tree_index.json`), lossless scene texts (`tree_texts.json`), millisecond in-RAM string scanning, and multi-turn tool-calling**—are 100% pure JSON and string operations. By moving the entire tree builder (including GB18030 decoding, pure-browser `.epub` decompression, and concurrent checkpointed LLM directory synthesis), Grep engine, Tree Agent, and Workbench UI into browser `IndexedDB`, and removing pre-agent era shackles (no hardcoded `max_tokens`, no disabled `thinking`, concurrent Turn-1 tool calls, and batch `read_scene`), LoreCodex runs effortlessly anywhere from mobile TauriTavern to native AI Agent harnesses.

---

## Inspiration & Acknowledgements

- **[PageIndex by VectifyAI](https://github.com/VectifyAI/PageIndex)**: LoreCodex's vectorless tree-reasoning retrieval paradigm was inspired by PageIndex and independently engineered from scratch for long-form fiction, game lore, SillyTavern / TauriTavern roleplay, and native AI Agents.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** & **[TauriTavern](https://github.com/Darkatse/TauriTavern)**: Thanks to the open-source roleplay frontend community.
- **[DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness)**: Thanks for the Cordis-based modular agent harness architecture.

---

## License

Released under the [MIT License](./LICENSE).
