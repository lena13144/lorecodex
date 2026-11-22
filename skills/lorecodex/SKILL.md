---
name: lorecodex
description: Vectorless 3-tier hierarchical tree reasoning + millisecond in-RAM alias/cameo grep engine for multi-million-character novels, game scripts, and SillyTavern lorebooks/character cards. Use when building, upgrading, or searching long-form fiction, canon lore archives, or character memories without vector RAG truncation.
---

# LoreCodex Skill (Vectorless Tree Reasoning & Millisecond Alias Grep)

LoreCodex organizes multi-million-character texts (novels, EPUBs, game story scripts, SillyTavern worldbooks, and Character Card V2 lore) into a 3-tier hierarchy (`Series/Volume` → `Arc/Chapter` → `Lossless Scene`) paired with an in-RAM alias & cameo full-text scanner (`0.5~11ms`).

## 1. Connecting via DeepSeek Harness (`dsh`) or MCP (`lorecodex-mcp`)

- **DeepSeek Harness (`@deepseek-ai/dsh`)**:
  ```bash
  dsh plugin --profile web add "github:lena13144/lorecodex"
  ```
- **MCP (`Claude Code` / `Antigravity` / `Cursor`)**:
  ```json
  {
    "mcpServers": {
      "lorecodex": {
        "command": "node",
        "args": ["/path/to/lorecodex/src/mcp_server.js"]
      }
    }
  }
  ```

## 2. CRITICAL RULE: LLM Directory Construction is Mandatory

LoreCodex's 3-tier tree navigation and alias-aware Grep depend on **LLM-synthesized directory metadata** (pronoun-resolved scene summaries, chapter descriptions, Level-0 volume `series_summaries`, character `aliases` 2D groups, and `glossary` terms).
- **Never treat a heuristic (`--no-llm` / `use_llm: false`) split as a finished corpus.** A raw heuristic split only extracts chapter titles and first/last lines; without LLM directory summaries and synthesized character alias groups, cross-volume plot reasoning and nickname/alias Grep will degrade severely.

### Two Ways for Native Agents to Build Full LLM Directories

#### Path A: Concurrent Sidecar LLM Build (`lorecodex_build_corpus`, default `use_llm: true`)
1. **Small-to-Medium Books (< 500k chars)**:
   Call `lorecodex_build_corpus(action="build_novel", corpus_id="...", input_path="...", use_llm=true, workers=8)`.
2. **Multi-Million-Character Web Novels / Game Scripts**:
   - Step 1: Run a structural split (`use_llm: false`) or build the first volume directly (`use_llm: true, series: "第1卷"`).
   - Step 2: **Immediately** run `lorecodex_build_corpus(action="upgrade", corpus_id="...", series="第1卷", workers=8)` volume by volume (supports automatic checkpoint resume in `.build_novel.ckpt.jsonl`).
3. **Merging Worldbooks / Character Cards V2**:
   Call `lorecodex_build_corpus(action="build_lore", corpus_id="...", input_path="...", merge_into="...", use_llm=true)`.

#### Path B: Host-Agent Zero-External-Key Directory Synthesis (`lorecodex_update_index_meta`)
If no external sidecar API key (`config.json` / `CHAT_KEY` / `DEEPSEEK_API_KEY`) is configured, **you (the host Agent)** can act as the directory indexer directly:
1. Call `lorecodex_build_corpus(action="build_novel", corpus_id="...", input_path="...", use_llm=false)` to split chapters and scenes.
2. Read scenes in batches via `lorecodex_read_scenes` and call `lorecodex_update_index_meta` to write:
   - `scenes`: `[{ node_id, title, summary, tone_tags }]`
   - `arcs`: `[{ arc_id, description, characters, tone_tags, key_items }]`
   - `series_summaries`: `{ "第一卷": "60-120字全卷主线与转折总览" }`
   - `aliases`: `[["正式名", "外号/代号/简称"]]`
   - `glossary`: `["专有术语/组织/地点：一句话说明"]`

## 3. Recommended Retrieval Workflow for Native Agents

When answering plot, character, timeline, or worldbuilding questions from a LoreCodex corpus:

1. **Discover Corpora & Verify LLM TOC Coverage**:
   Call `lorecodex_list_corpora` to inspect mounted corpus IDs, total volumes/chapters/scenes, `max_order`, and `LLM_TOC` coverage. If `LLM_TOC` is `0/N`, run `lorecodex_build_corpus(action="upgrade")` or `lorecodex_update_index_meta` first.
2. **Concurrent Turn-1 Routing**:
   - Call `lorecodex_list_series` (Level-0 volume overview) or `lorecodex_list_arcs` (Level-1 chapter filter by `series`, `character`, `keyword`, or `tone`).
   - **In parallel**, call `lorecodex_grep_scenes` with key entity names, quotes, or timeline markers (e.g., `"十年前 解散"`). `lorecodex_grep_scenes` automatically expands character aliases and flags `[CAMEO]` appearances where a character speaks in a chapter whose catalog metadata did not list them.
3. **Expand & Batch Read**:
   - Use `lorecodex_expand_arc` to inspect Level-2 scene summaries within candidate chapters.
   - Call `lorecodex_read_scenes` with an array of `scene_node_ids` (up to 10 scenes per call) to read lossless Level-3 original prose.
4. **Cite Verified Nodes**: Always cite verified `[node_id]`s in your synthesis and respect `max_order` when spoiler gating is requested.
5. **Context-Saving Sub-Agent Mode**: If you want a distilled answer without loading intermediate tool outputs into your own context window, call `lorecodex_ask_agent(corpus, query, max_order)`.
