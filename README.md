# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=node.js&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**Vectorless Tree-Reasoning + Millisecond In-RAM Grep + Sidecar Memory Agent for Long-Form Fiction, Game Lore & SillyTavern Roleplay**

> Zero dependencies. Zero vector DB. Zero chunk fragmentation.  
> Let a fast, inexpensive reasoning model navigate a multi-level Table of Contents (`Series → Arc → Scene`), scan millions of characters in milliseconds with alias-aware `grep_scenes`, read complete scenes verbatim, and hand grounded narrative cues to your main RP model.

[简体中文说明](./README.zh-CN.md)

---

## Workbench Preview

| Book-Scroll · **Paper (`素笺`)** Dossier & Waterfall Trace | Modern Workbench · **Studio Dark (`曜夜`)** Alias Grep & Highlight |
| :---: | :---: |
| ![LoreCodex Paper Theme Preview](./docs/preview-paper.png) | ![LoreCodex Studio Dark Theme Preview](./docs/preview-studio-dark.png) |

---

## Core Architecture: Progressive Tree Disclosure

Instead of stuffing giant worldbooks or lossy vector fragments into your main model, a lightweight sidecar agent inspects your corpus in progressive tiers:

```text
SillyTavern Chat Turn / API Request
   │
   ▼  Dynamic System Prompt (corpus config + 4 query topologies + guardrails)
   ├──► Tier 0 (Auto-Fold for 250+ Arcs): `list_series`
   │       Overview of volumes/series when a massive novel exceeds threshold.
   │
   ├──► Tier 1: `list_story_arcs` (Compact Spine Catalog)
   │       Filterable by series, category, character (alias-expanded), keyword, or tone.
   │
   ├──► Tier 2: `get_arc_scenes` OR `grep_scenes` (Milliseconds In-RAM Scan)
   │       • Expands scene summaries ONLY for chosen arcs;
   │       • `grep_scenes` resolves character aliases, prioritizes uncredited cameos,
   │         and scans multi-language quotes in RAM (~1–45ms on multi-million char corpora).
   │
   └──► Tier 3: `read_scene` (Verbatim Un-truncated Scenes + Optional Graph & Outlines)
           Reads complete scenes before writing a structured `guide`, enforcing
           `maxOrder` spoiler gates and rejecting false user premises.
```

---

## Key Capabilities

1. **Zero-Dependency Runtime & Sub-Second Cold Boot**  
   Pure Node.js (`>= 18`) runtime (`src/server.js`) with zero npm dependencies, no vector database, and no Embedding or Rerank API required.
2. **Multi-Corpus Pack Registry (`corpora/<id>/`)**  
   Hot-pluggable corpus packages (`corpus.json` + `tree_index.json` + `tree_texts.json` + optional `graph.json`). Every work can customize aliases, glossaries, stage-card disambiguation patterns, user-identity guards, DB scrubbers, and prompt XML framing.
3. **Hardware-Level Spoiler Gate (`maxOrder`)**  
   Linear progression filtering (`order <= maxOrder`) enforced across `/tree-index`, `/tree-grep`, `/tree-scene`, agent tools, and scene hydration—while keeping timeless world lore (`order: null`) accessible.
4. **Universal Builders (Python 3 Stdlib Only)**  
   - `builders/build_novel.py`: Parses `.txt` (auto UTF-8/GB18030), `.md`, `.epub`, or folders into `Series → Arc → Scene` trees (`--no-llm` heuristic mode or concurrent LLM summarization with JSONL checkpoints).
   - `builders/build_lore.py`: Parses SillyTavern worldbook `.json`, `.jsonl`, or `.md`/`.txt` folders (with optional `--filter-game-stats`) and supports idempotent `--merge-into` into an existing novel tree.
5. **4 Adaptive Query Topologies**  
   - **Targeted Event / Spec Verification**: `1–3` crisp scenes + adjacent scene chaining.  
   - **Macro Multi-Chapter Arcs**: `selected_arcs` chronological scene outlines + climax scenes.  
   - **Full Character Portrait**: `4–7` scenes sampled across different categories/eras.  
   - **Ensemble / Multi-Voice Recall**: Detaches from recent-turn character lock and routes by `tone_tags`.
6. **Modular Codex GUI & Web Management Studio (`ui/`)**  
   4 themes (**Paper `素笺`**, **Lamp `墨灯`**, **Studio Light `净台`**, **Studio Dark `曜夜`**), draggable 3-pane splitters on desktop and mobile-responsive bottom-tab navigation (`<= 860px`) with embed mode (`?embed=1`), collapsible `Series → Arc → Scene` tree, Grep match `<mark>` highlighting & jump navigation, waterfall timing timeline, clickable guide node links + exact SillyTavern prompt preview, `Ctrl+K` command palette, online corpus config editor, and drag-and-drop file upload builder.
7. **Universal SillyTavern Extension (`extension/st-tree-lore/`)**  
   SmartTheme-integrated card layout, **in-SillyTavern fullscreen modal Workbench overlay (`?embed=1`)** (no need to leave your chat tab to browse chapters, import books, or inspect traces), live connection status bar, real-time last-injection preview card with trace deep-link (`/#run=...`), inline test query panel, per-character-card auto-binding (`charBindings`), spoiler-gate input, customizable framing/scrubbers, and slash commands (`/lorecodex`, `/lorecorpus`, `/loreorder`, `/lorepov`, `/loreui`).

---

## Project Structure

```text
lorecodex/
├── src/
│   ├── server.js          # Zero-dependency HTTP server
│   ├── corpus_manager.js  # Multi-corpus discovery, metadata & lazy caching
│   ├── tree_agent.js      # Progressive tree navigation, spoiler gate & LLM loop
│   ├── prompt_builder.js  # Dynamic prompt & tool schema builder from corpus.json
│   ├── grep_engine.js     # In-RAM alias-aware & cameo-aware grep + multi-lang regex
│   ├── graph_engine.js    # Optional 1-hop entity relationship graph lookup
│   └── utils.js           # Cross-platform Python detection, markup & order helpers
├── ui/
│   ├── index.html         # Modular Archival Codex & Trace Workbench shell
│   ├── styles.css         # 4 themes (Paper/Lamp/Studio Light/Studio Dark) & layout
│   └── js/                # Zero-build native ES modules (api, state, toc, reader, trace, modals, main)
├── builders/
│   ├── build_novel.py     # TXT / MD / EPUB -> 3-level tree builder (Python stdlib)
│   └── build_lore.py      # Worldbook JSON / MD / JSONL -> Lore tree & --merge-into
├── extension/
│   └── st-tree-lore/      # Universal SillyTavern third-party extension
├── corpora/
│   └── demo-chronicles/   # Ready-to-run bilingual/demo sci-fi novel + worldbook pack
├── examples/
│   └── demo-chronicles/   # Source chronicles.txt & worldbook.json
├── scripts/
│   ├── create_demo_corpus.mjs
│   └── verify.mjs         # Automated offline & live verification suite
├── docs/                  # Workbench preview screenshots
├── config.example.json
├── LICENSE
└── package.json
```

---

## Quick Start

### 1. Configure API Credentials

Copy `config.example.json` to `config.json` and fill in your OpenAI-compatible sidecar LLM endpoint (`chatBase`, `chatKey`, `chatModel`), or provide `CHAT_BASE` / `CHAT_KEY` / `CHAT_MODEL` environment variables:

```json
{
  "port": 5240,
  "defaultCorpus": "demo-chronicles",
  "chatBase": "https://api.openai.com/v1",
  "chatKey": "your-api-key",
  "chatModel": "deepseek-chat",
  "maxTokens": null
}
```

### 2. Start the Server & Open Workbench

```bash
npm start
# or: node src/server.js --tree-only --port 5240 --host 127.0.0.1
```

Open `http://127.0.0.1:5240` in your browser to read chapters, switch corpora, test `maxOrder` spoiler gating, run full-text `grep`, and inspect live `/tree-search` traces.

#### Security Defaults (Local Binding & Origin Guards)
- **Loopback by default**: The server binds to `127.0.0.1` so unauthenticated local endpoints are not exposed on your LAN. To bind externally (e.g., for remote SillyTavern clients on trusted networks), pass `--host 0.0.0.0` or set `HOST=0.0.0.0`.
- **Origin protection & key isolation**: Write/management routes (`POST /config`, `POST /models`, `POST /corpora/import`, `POST /corpora/:id/config`) accept only loopback browser origins (`localhost`, `127.0.0.1`, `[::1]`) or origins listed in `ALLOWED_ORIGINS` (comma-separated). Server-saved `chatKey` is never forwarded when a request overrides `chatBase` / `baseUrl`.
- **Cross-platform Python detection**: Upload/import jobs automatically probe `PYTHON_BIN`, `python3`, and `python`.

### 3. Build Your Own Corpus

**Long-form fiction (`.txt` / `.md` / `.epub`):**

```bash
# Fast offline heuristic build (zero API cost):
python3 builders/build_novel.py --input path/to/novel.epub --corpus-id my-novel --name "My Novel" --no-llm

# Or LLM-summarized tree with JSONL resume checkpoint:
python3 builders/build_novel.py --input path/to/novel.txt --corpus-id my-novel --name "My Novel" --config config.json
```

**Merge a SillyTavern Worldbook or Lore folder into the same tree:**

```bash
python3 builders/build_lore.py --input path/to/worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats --no-llm
```

Then click **刷新 (`Reload`)** in the UI or call `POST /corpora/reload`.

---

## SillyTavern Extension (`st-tree-lore`)

1. Copy `extension/st-tree-lore/` into `<SillyTavern>/public/scripts/extensions/third-party/st-tree-lore/`.
2. Reload SillyTavern and open the **Extensions** panel (`LoreCodex 树形典籍检索 (st-tree-lore)`).
3. Click **「打开书阁」** or **「在酒馆内查看完整轨迹」** (or type `/loreui`) to open the Workbench in a fullscreen in-SillyTavern modal overlay without leaving your chat page.
4. Slash commands:
   - `/lorecodex [on|off]` — toggle retrieval
   - `/lorecorpus <corpus_id>` — switch active corpus
   - `/loreorder <n|off>` — set spoiler gate chapter limit
   - `/lorepov <name>` — set POV character
   - `/loreui` — open the embedded Workbench modal overlay inside SillyTavern

---

## HTTP API Reference

| Method & Path | Description |
| :--- | :--- |
| `GET /` \| `GET /ui` | Serve Archival Codex & Trace Workbench UI |
| `GET /health` | Server status, boot timing, and registered corpora summary |
| `GET /corpora` | List all discovered corpus packs and framing/scrubber configs |
| `GET /corpora/:id` | Detailed metadata for a specific corpus |
| `POST /corpora/:id/config` | Update `corpus.json` online and hot-reload that corpus agent |
| `POST /corpora/import` | Upload `.txt` / `.md` / `.epub` / `.json` / `.jsonl` via base64 JSON and launch async build job |
| `POST /corpora/reload` | Rescan `corpora/` directory and clear agent cache |
| `GET /jobs` \| `GET /jobs/:id` | List import/build jobs or inspect real-time build logs |
| `GET /tree-index?corpus=<id>&maxOrder=<n>` | Return tree TOC & aliases (filtered by `maxOrder` if set) |
| `GET /tree-scene?corpus=<id>&id=<node_id>&maxOrder=<n>` | Return verbatim scene text (`403` if blocked by `maxOrder`) |
| `GET /tree-grep?corpus=<id>&q=<q>&limit=<n>&category=<c>&tone=<t>&maxOrder=<n>` | Millisecond in-RAM alias/cameo-aware search |
| `GET /tree-runs?corpus=<id>` | Recent 40 retrieval execution traces |
| `POST /tree-search` | Run sidecar tree reasoning agent (`{ corpus, query, onDemand, recentChat, sceneAnchor, activeStateHints, maxScenes, maxChars, maxOrder, pov, apiConfig }`) |
| `GET /config` \| `POST /config` | Read (masked) or persist server configuration |
| `POST /models` | Proxy `/models` discovery from configured `chatBase` |

---

## Verification

- **Offline / zero-API-key verification** (runs EPUB builder, cold boot, static asset MIME & path-traversal checks, origin/key exfiltration guards, web import jobs, deterministic `maxOrder` spoiler gates, millisecond grep, secret/path hygiene scan, and JS syntax checks):

```bash
npm test
```

- **Full verification** (also runs live LLM `demo-chronicles` spoiler-locked & unlocked regression tests automatically when `config.json` / `CHAT_KEY` is present):

```bash
npm run verify
```

---

## Why Vectorless? (Design Journey)

LoreCodex didn't start out vectorless—we took the full detour through traditional vector RAG first:

1. **Stage 1: Traditional Vector RAG (Chunking + Embedding + Rerank)**  
   When indexing multi-million-character fiction and game scripts, standard vector pipelines quickly hit three narrative walls:
   - **Chunk fragmentation**: Fixed-size chunks slice dialogues and plot twists in half, feeding the RP model stripped-down fragments without emotional or timeline context.
   - **Coreference & alias blindness**: Roleplay turns full of pronouns ("what she said back then"), character codenames/nicknames, or uncredited cameos often retrieve semantically similar but wrong scenes.
   - **Heavy setup & maintenance**: Every new chapter meant re-embedding, loading large vector index files at boot, and configuring extra Embedding + Rerank APIs.
2. **Stage 2: Tree Navigation + Vector Fallback (Hybrid Phase)**  
   Inspired by PageIndex, we built a hierarchical Table of Contents so an inexpensive sidecar LLM could browse like a human reader and read complete scenes verbatim—while initially keeping vector search as a fallback. Once we paired tree browsing with millisecond, alias-aware in-RAM `grep_scenes`, trace logs showed a clear pattern: **the sidecar agent virtually never needed the vector fallback anymore**.
3. **Stage 3: Dropping the Baggage (LoreCodex v2)**  
   Removing the vector stack altogether left a dramatically faster, simpler engine: **hierarchical tree reasoning + millisecond alias/cameo grep + verbatim scene reading + spoiler gating**, with zero external dependencies and drag-and-drop corpus building.

---

## Inspiration & Acknowledgements

- **[PageIndex by VectifyAI](https://github.com/VectifyAI/PageIndex)**: LoreCodex's core vectorless, tree-reasoning retrieval paradigm—letting an LLM navigate a hierarchical Table of Contents instead of relying on lossy vector chunks—was inspired by PageIndex. Building upon that insight from scratch, LoreCodex introduces a zero-dependency runtime tailored for long-form fiction, game lore, and roleplay (3-tier narrative spines, millisecond alias/cameo-aware in-RAM grep, hardware-level `maxOrder` spoiler gates, 4 narrative query topologies, and an interactive trace workbench).
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**: Thanks to the SillyTavern community for its extensible roleplay frontend and plugin architecture.

---

## License

Released under the [MIT License](./LICENSE).
