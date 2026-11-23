# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Pure Frontend & Node >= 18](https://img.shields.io/badge/Runtime-Browser%20IndexedDB%20%7C%20Node%20%3E%3D18-339933?style=flat-square)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**Let characters consult the original work during roleplay: index a whole novel or game script as a table of contents, and before each reply a retrieval model looks up the source scenes and hands them to your main model.**

> The idea comes from [PageIndex](https://github.com/VectifyAI/PageIndex): instead of chopping a document into vector chunks, have an LLM build a summarized table-of-contents tree, then let a reasoning model navigate it. LoreCodex applies that idea to long-form fiction and roleplay, implemented from scratch as a SillyTavern / TauriTavern extension.

[简体中文说明 (Default)](./README.md)

---

## What problem it solves

In fan cards and long roleplays, the hardest thing is keeping characters faithful to **what happened in the original work and who said what**:

- **Worldbooks** hold hand-written lore. Writing hundreds of entries is slow, they fire on keywords, and plot events and exact lines rarely make it in.
- **Vector retrieval** finds passages with similar meaning, but struggles with questions that are common in long narratives:
  - "What exactly did she say in chapter 3?" — questions that need a precise source;
  - characters appearing under nicknames or codenames that don't match the text;
  - cause and effect across volumes;
  - later chapters you shouldn't see yet while playing through the story.
- **Stuffing in a synopsis** loses the original voice and details.

What LoreCodex does:

1. **Build the index once.** Split the work into `volume → arc → scene`; an LLM writes a summary for every scene and an overview for every volume, plus a character alias table and a glossary.
2. **Before each reply, the retrieval model looks things up itself.** It browses volumes, expands arcs, searches the full text by name and alias, and finally reads source scenes. Scenes handed to the main model **must have been read in full**, not guessed from summaries.
3. **Inject complete source scenes.** Nothing is truncated or chunked, so the main model can match the original tone and details.

## How it differs

| | Worldbook | Vector retrieval | LoreCodex |
|---|---|---|---|
| Content | Hand-written entries | Text chunks | Full original text, organized by volume / arc / scene |
| When it applies | A keyword appears | Semantically similar | The retrieval model decides whether and what to look up |
| What gets injected | Entry text | Short fragments | Complete source scenes |
| Nicknames, codenames | Hand-written triggers | Often missed | Expanded from the alias table |
| Spoiler control | None | None | Visibility locked to your chapter progress |

**The cost, stated plainly:** every turn calls the retrieval model once, and lookups that need source text run several tool-call rounds, adding latency and API spend. For pure small talk the model decides to skip, but that decision is itself a call. Building the index is a one-time LLM cost. It fits settings with **a lot of source text where faithfulness matters**; for original cards or light lore, a worldbook is enough.

## Features

1. **Pure frontend, no backend.** The extension bundles an IndexedDB engine (`browser_engine.js`) and a workbench UI (`extension/st-tree-lore/ui/`). After installing from the GitHub URL, no Node.js, Python, or Termux is needed; build, retrieve, and inspect retrieval runs directly in mobile TauriTavern or a desktop browser.
2. **Many sources, one tree.** Supports `.txt` (auto UTF-8 / GB18030), `.epub`, `.md`, SillyTavern worldbook `.json`, Character Card V2 `.json` with `character_book`, and single-file `.lorepack.json` bundles.
3. **LLM indexing with checkpoint resume.** Generates scene summaries and volume overviews per volume in parallel, resolves pronouns to names, and builds the alias table (`aliases`) and glossary (`glossary`). Progress is saved to IndexedDB continuously, so you can pause and resume.
4. **Alias-aware full-text search.** Searching any name expands to all of that character's aliases; millions of characters usually finish in under 15 ms. Scenes where a character speaks without being credited in the TOC are flagged `[CAMEO]`.
5. **Spoiler gate (`maxOrder`).** Once set, the TOC, search, and reads never return later chapters; timeless lore with no chapter order is unaffected.
6. **Session recall.** If your database-style memory extension appends a `# 记忆召回` block (`id(summary)` items) to your message, the retrieval model uses it to resolve references, but does not search the original work for events that only happened in this session.
7. **Shareable packs.** A built index can be exported as `.lorepack.json`; others import it and skip the indexing cost.

---

## Workbench Preview

| Light theme · **Paper (`素笺`)** (dossier & retrieval trace) | Dark theme · **Studio Dark (`曜夜`)** (alias grep & text highlight) |
| :---: | :---: |
| ![LoreCodex Paper Theme Preview](./docs/preview-paper.png) | ![LoreCodex Studio Dark Theme Preview](./docs/preview-studio-dark.png) |

---

## How retrieval works

Before each reply (via SillyTavern's `generate_interceptor`, after the user message is saved and before the prompt is assembled), the retrieval model receives your current message and recent turns, then walks down the tree:

```text
Your message + recent N turns (+ optional session recall)
   │
   ▼  First decide: does this turn need source text? Pure small talk skips injection
   │
   ├──► Level 0 / 1: `list_series` for volume overviews, `list_story_arcs` for arc lists
   │       and `grep_scenes` for alias-expanded full-text search
   │
   ├──► Level 2: `get_arc_scenes` to inspect scene summaries inside candidate arcs
   │
   └──► Level 3: `read_scene` to read source text (up to 10 scenes per call)
           only scenes actually read can be selected; spoiler gate enforced throughout
   │
   ▼  Inject into the main model: brief guide + complete source scenes
```

The tool set is close to how a coding agent (such as Claude Code) navigates a codebase: check the structure, grep, read files, and only act on what was read. The difference is that retrieval can run on every turn, so the model first decides whether looking anything up is necessary.

---

## Quick Start (SillyTavern & TauriTavern)

Runs purely in the browser by default—no backend process required on desktop or mobile TauriTavern.

1. **Install the extension**: In SillyTavern or TauriTavern, open **Extensions → Install Extension** and paste:
   ```text
   https://github.com/lena13144/lorecodex
   ```
2. **Open the panel**: Expand **LoreCodex 典籍检索** in the sidebar. It comes with a sample corpus preloaded, light/dark themes, enable switch, corpus selector with character binding, an **LLM Index Progress Bar**, last-retrieval summary, and **打开 LoreCodex 大面板** (or run `/loreui`).
3. **Configure a model and import text**:
   - Click **去配置** (or **模型** in the workbench) and enter any OpenAI-compatible **API Base URL**, **API Key**, and model (leave `Max Tokens` blank to use the model's native limit).
   - Click **导入** to load `.txt` / `.epub` / `.md` novels or `.json` worldbooks/cards. LoreCodex runs a free offline split and shows a structure preflight report first; once it looks right, start LLM directory building with IndexedDB checkpoint resume.
   - Use **书库管理** to check LLM coverage, export `.lorepack.json`, or delete corpora, and **酒馆设置** to configure the spoiler gate and POV.

---

## Release Packages & Agent Integrations (DeepSeek Harness / MCP / Skill)

[**GitHub Releases**](https://github.com/lena13144/lorecodex/releases) provides **4 standalone packages** so you only download what you need:

1. **`lorecodex-sillytavern-tauritavern-extension-v2.2.0.zip`** — Frontend extension for SillyTavern & TauriTavern (mobile/desktop): sidebar card, IndexedDB serverless engine, embedded workbench UI, in-browser TXT/GB18030/EPUB/JSON builders, LLM directory upgrader, and `demo-chronicles.lorepack.json`.
2. **`lorecodex-cloud-builder-kit-v2.2.0.zip`** — Zero-dependency Python scripts (`build_novel.py`, `build_lore.py`, `pack_lorepack.py`) plus `AGENT_INSTRUCTIONS.md`. Upload alongside your novel to a cloud AI task (Gemini / Claude / Grok / Qoder / WorkBuddy, etc.) to produce a `.lorepack.json` without an external API key.
3. **`lorecodex-agent-dsh-mcp-plugin-v2.2.0.zip`** — Agent-only bundle containing the **DeepSeek Harness (`@deepseek-ai/dsh` / Cordis)** plugin (`src/dsh_plugin.js` + `cordis.patch.yml`), zero-dependency **MCP stdio server** (`src/mcp_server.js`), and **Agent Skill** (`skills/lorecodex/SKILL.md`), exposing 9 tools (`lorecodex_list_corpora`, `lorecodex_list_series`, `lorecodex_list_arcs`, `lorecodex_expand_arc`, `lorecodex_grep_scenes`, `lorecodex_read_scenes`, `lorecodex_build_corpus`, `lorecodex_update_index_meta`, and `lorecodex_ask_agent`).
4. **`lorecodex-full-server-workbench-v2.2.0.zip`** — Full package with the optional Node HTTP server (`src/server.js`, also useful for bypassing browser CORS on custom API relays), Python CLI builders (`builders/`, with web/MediaWiki noise stripping and `--h1-is-volume` / `--strip-block` / `--allow-noisy`), standalone workbench UI, SillyTavern extension, and agent integrations.

```bash
# Install directly into DeepSeek Harness (dsh)
dsh plugin --profile web add "github:lena13144/lorecodex"
```

---

## Verification

```bash
# Offline test suite (no API key required)
npm test

# Build the 4 release packages under dist/releases/
npm run build:releases
```

---

## Why no vector DB—and why the backend disappeared too

This project did not start out trying to be vectorless or serverless. It started as a textbook vector RAG pipeline, and took almost every detour along the way:

1. **Stage 1: A textbook vector RAG setup.**  
   Facing millions of characters of game scripts and novels, fixed-size chunking, embeddings, a vector index, and a reranker felt like the obvious choice. Once we actually used it in roleplay, the cracks showed fast: complete scenes and dialogue turns got sliced in half; nicknames, uncredited cameos, and cross-volume arcs tripped up similarity search; and just to hold the vectors and run reranking, everyone had to keep a local backend server running.
2. **Stage 2: Add a TOC tree, keep vectors as a fallback.**  
   Inspired by PageIndex, we added an LLM-built three-level TOC, an alias table, and in-memory alias search—but kept the vector tool around just in case. After running it for a while, we checked the retrieval logs and had to laugh: once the tree and alias search were there, the model did not touch the vector tool in 99.9% of retrievals. The heaviest part of the stack was sitting completely idle.
3. **Stage 3: Drop vectors, then realize the backend isn't needed either.**  
   The moment we deleted the vector layer, it clicked: everything left (`tree_index.json`, `tree_texts.json`, alias search, multi-turn tool calls) was just JSON and string operations. There was no real reason to make desktop and mobile users keep a `127.0.0.1:5240` server alive for that. So we moved the whole pipeline—building (GB18030 decoding, `.epub` extraction, parallel LLM indexing with checkpoints), search, retrieval agent, and workbench—straight into the browser on IndexedDB. Along the way we also removed the early guardrails we had put on the model: no hardcoded `max_tokens`, no disabled thinking, parallel first-turn tool calls, and batched `read_scene`. Give the model a clean table of contents and a fast search tool, and let it look things up itself.

## Inspiration & Acknowledgements

- **[PageIndex by VectifyAI](https://github.com/VectifyAI/PageIndex)**: LoreCodex's core idea comes from PageIndex — let a reasoning model navigate a hierarchical TOC instead of relying on vector chunks. LoreCodex is an independent implementation extended for long-form fiction, game scripts, and roleplay: a volume / arc / scene narrative tree, alias expansion, a spoiler gate, and the rule that cited scenes must have been read in full.
- **Agentic search in coding agents** (e.g. Claude Code): the retrieval tools (browse the tree, grep, read the source, cite only what was read) borrow from how coding agents find code.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** & **[TauriTavern](https://github.com/Darkatse/TauriTavern)**: thanks to the open-source roleplay frontend community.
- **[DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness)**: thanks for the Cordis-based modular agent harness architecture.

---

## License

Released under the [MIT License](./LICENSE).
