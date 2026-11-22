# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=node.js&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**Vectorless Tree-Reasoning + Millisecond In-RAM Alias Grep + Native-Reasoning Sidecar Memory Agent for Long-Form Fiction, Game Lore & SillyTavern Fanfic / Canon Character Cards**

> Zero dependencies. Zero vector DB. Zero chunk fragmentation.  
> Combine multi-million-character novels, game event scripts, and SillyTavern worldbooks into a single `Series → Arc → Scene` narrative tree. Let a fast, native-reasoning sidecar model navigate the Table of Contents, scan millions of characters in milliseconds with alias-aware `grep_scenes`, read complete scenes verbatim, and hand grounded narrative cues to your main RP model.

[简体中文说明 (Default)](./README.md)

---

## Why LoreCodex for Fanfic & Canon Character Cards?

Building or playing SillyTavern character cards based on long web novels or massive game worlds usually forces a painful tradeoff: hand-crafting hundreds of keyword-triggered worldbook entries takes days and bloats context, while traditional vector RAG slices iconic dialogues into 500-character fragments, fails on character nicknames/codenames, and leaks late-story spoilers into early-timeline roleplay.

LoreCodex solves this directly:

1. **Unify Original Novels + Worldbooks + V2 Character Cards**: Drag and drop multi-million-character `.txt` / `.epub` / `.md` novels, SillyTavern worldbook `.json` files, or Character Card V2 `.json` files (auto-extracting embedded `character_book`) into one unified 3-tier tree.
2. **Verbatim Scene Injection**: `read_scene` injects complete, un-truncated original scenes so your main RP model preserves canon dialogue voice, emotional nuance, and scene continuity without OOC drift.
3. **Millisecond Alias Expansion & Uncredited Cameo Detection**: Searching any character name automatically expands all configured or LLM-synthesized aliases across millions of characters in `< 15ms`, prioritizing scenes where a character speaks in the text even if uncredited in the chapter header.
4. **Hardware-Level Spoiler Gate (`maxOrder`)**: Start roleplaying from Volume 1 or any mid-story turning point—`order <= maxOrder` is strictly enforced across TOC, Grep, scene reads, and agent tools while preserving timeless lore (`order: null`).
5. **Native Reasoning & Anti-Hallucination**: Preserves modern models' native thinking (`reasoning_content`) without hardcoded `max_tokens` ceilings—proactively tracing upstream causal setups, correcting false premises in user queries, and cleanly skipping ungrounded OC queries.

---

## Workbench Preview

| Book-Scroll · **Paper (`素笺`)** Dossier & Waterfall Trace | Modern Workbench · **Studio Dark (`曜夜`)** Alias Grep & Highlight |
| :---: | :---: |
| ![LoreCodex Paper Theme Preview](./docs/preview-paper.png) | ![LoreCodex Studio Dark Theme Preview](./docs/preview-studio-dark.png) |

---

## Core Architecture: Progressive Tree Disclosure

```text
SillyTavern Chat Turn / API Request
   │
   ▼  Dynamic System Prompt (corpus config + 4 query topologies + guardrails)
   ├──► Tier 0 (Auto-Fold for 250+ Arcs): `list_series`
   │       Overview of volumes/series and `series_summaries` on massive novels.
   │
   ├──► Tier 1: `list_story_arcs` (Compact Spine Catalog)
   │       Filterable by series, category, character (alias-expanded), keyword, or tone.
   │
   ├──► Tier 2: `get_arc_scenes` OR `grep_scenes` (Milliseconds In-RAM Scan)
   │       • Expands scene summaries ONLY for chosen arcs;
   │       • `grep_scenes` resolves character aliases, prioritizes uncredited cameos,
   │         and scans multi-language quotes in RAM (~1–15ms on multi-million char corpora).
   │
   └──► Tier 3: `read_scene` (Verbatim Un-truncated Scenes + Optional Graph & Outlines)
           Reads complete scenes before writing a structured `guide`, enforcing
           `maxOrder` spoiler gates and rejecting false user premises.
```

---

## Installation Guide (PC, One-Click SillyTavern GitHub Install & Mobile)

### 1. PC (Windows / macOS / Linux)

#### Step A: One-Click Extension Install in SillyTavern (Recommended)
1. In SillyTavern, open **Extensions → Install Extension**;
2. Paste the repository URL:
   ```text
   https://github.com/lena13144/lorecodex
   ```
3. SillyTavern clones the repository directly into your extensions folder (`<SillyTavern>/data/default-user/extensions/lorecodex` or `<SillyTavern>/public/scripts/extensions/third-party/lorecodex`) and supports one-click updates from the Extensions manager.  
   *(Alternatively, copy `extension/st-tree-lore/` into `<SillyTavern>/public/scripts/extensions/third-party/st-tree-lore/`).*

#### Step B: Start the LoreCodex Backend Server
Ensure [Node.js (>=18)](https://nodejs.org/) and [Python 3](https://www.python.org/) are installed. Inside the cloned repository directory, run:

```bash
node src/server.js
# or: npm start
```

Once you see `LoreCodex server listening on http://127.0.0.1:5240`, reload SillyTavern, expand **LoreCodex 树形典籍检索 (st-tree-lore)**, and click **「打开书阁」** (or type `/loreui`) to open the fullscreen Workbench overlay directly inside SillyTavern.

---

### 2. Mobile Setup (Android Termux & LAN Browser)

- **Option A · Local Android Termux**:  
  Because LoreCodex has zero compiled C++ or third-party Python/npm dependencies, it runs out of the box in Termux (`pkg install nodejs python git`):
  ```bash
  git clone https://github.com/lena13144/lorecodex.git ~/lorecodex
  cd ~/lorecodex
  node src/server.js
  ```
  Install the extension in SillyTavern via `https://github.com/lena13144/lorecodex`, then tap **「打开书阁」** (`/loreui`) on your phone—the Workbench automatically switches to a mobile bottom-tab layout (`<= 860px`) where you can upload `.txt` / `.epub` / `.json` files directly from phone storage.
- **Option B · PC / NAS Backend + Mobile Browser over LAN**:  
  Start the server on your PC with LAN binding and origin allowance:
  ```bash
  ALLOWED_ORIGINS=* node src/server.js --host 0.0.0.0 --port 5240
  ```
  Then set the Server URL in SillyTavern's LoreCodex extension panel on your mobile browser to `http://<your-pc-lan-ip>:5240`.

---

## Building & Upgrading Trees (Zero-CLI Web Workflow or CLI)

### Web 3-Step Workflow
1. **Configure Sidecar Model**: Open the Workbench (`http://127.0.0.1:5240` or `/loreui`), click **设置 (`Settings`)**, and fill in your OpenAI-compatible API Base URL, API Key, and Model (`Max Tokens` left blank uses the model's native limit).
2. **Instant Offline Tree Import**: Click **导入 (`Import`)**, drop your `.txt` (auto UTF-8/GB18030), `.epub`, or `.md` novel, and check **离线快速建树 (`--no-llm`)** to build a 3-tier tree in seconds. Optionally import a SillyTavern worldbook `.json` or Character Card V2 `.json` with **并入已有书库 (`--merge-into`)**.
3. **In-Place Per-Volume LLM Upgrade**: Open **书库配置 (`Corpus Config`) → LLM 目录补全 (`LLM Upgrade`)**, select a specific volume (`series`) or chapter range, and start an in-place concurrent LLM upgrade. Single-scene chapters automatically reuse leaf summaries to save tokens, and upon completion the builder synthesizes volume `series_summaries`, character `aliases`, and `glossary` terms into `corpus.json` with JSONL checkpoint resume.

### CLI Builders

```bash
# 1. Fast offline heuristic build (zero API cost):
python3 builders/build_novel.py --input path/to/novel.epub --corpus-id my-novel --name "My Novel" --no-llm

# 2. In-place per-volume LLM upgrade + auto alias/glossary/series summary synthesis:
python3 builders/build_novel.py --upgrade --corpus-id my-novel --series "Volume 1" --workers 8

# 3. Merge a SillyTavern Worldbook or V2 Character Card into the same tree:
python3 builders/build_lore.py --input path/to/worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats --no-llm
```

---

## HTTP API Reference

| Method & Path | Description |
| :--- | :--- |
| `GET /` \| `GET /ui` | Serve Archival Codex & Trace Workbench UI |
| `GET /health` | Server status, boot timing, and registered corpora summary |
| `GET /corpora` \| `GET /corpora/:id` | List all discovered corpus packs or detailed metadata for one corpus |
| `POST /corpora/:id/config` | Update `corpus.json` online and hot-reload that corpus agent |
| `POST /corpora/import` | Upload `.txt` / `.md` / `.epub` / `.json` / `.jsonl` and launch async build job |
| `POST /corpora/:id/upgrade` | Launch in-place LLM directory upgrade & metadata synthesis by volume or arc range |
| `POST /corpora/reload` | Rescan `corpora/` directory and clear agent cache |
| `GET /jobs` \| `GET /jobs/:id` | List import/upgrade jobs or inspect real-time logs |
| `GET /tree-index` \| `GET /tree-scene` \| `GET /tree-grep` | Tree TOC, verbatim scene (`403` if blocked by `maxOrder`), and millisecond grep |
| `POST /tree-search` \| `GET /tree-runs` | Run sidecar tree reasoning agent and fetch recent 40 execution traces |
| `GET /config` \| `POST /config` \| `POST /models` | Read/persist server configuration and proxy `/models` discovery |

---

## Verification

```bash
# Offline zero-API-key test suite ([1/9] to [8/9]):
npm test

# Full verification (adds live LLM regression when config.json / CHAT_KEY is present):
npm run verify
```

---

## Inspiration & Acknowledgements

- **[PageIndex by VectifyAI](https://github.com/VectifyAI/PageIndex)**: LoreCodex's vectorless tree-reasoning retrieval paradigm was inspired by PageIndex and independently engineered from scratch for long-form fiction, game lore, and SillyTavern roleplay.
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**: Thanks to the SillyTavern community for its extensible roleplay frontend and plugin architecture.

---

## License

Released under the [MIT License](./LICENSE).
