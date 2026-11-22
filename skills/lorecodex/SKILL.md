---
name: lorecodex
description: Vectorless 3-tier hierarchical tree reasoning + millisecond in-RAM alias/cameo grep engine for multi-million-character novels, game scripts, and SillyTavern lorebooks/character cards. Use when building, upgrading, or searching long-form fiction, canon lore archives, or character memories without vector RAG truncation.
---

# LoreCodex Skill (Vectorless Tree Reasoning & Millisecond Alias Grep)

LoreCodex organizes multi-million-character texts (novels, EPUBs, game story scripts, SillyTavern worldbooks, and Character Card V2 lore) into a 3-tier hierarchy (`Series/Volume` → `Arc/Chapter` → `Lossless Scene`) paired with an in-RAM alias & cameo full-text scanner (`0.5~11ms`).

## 1. Connecting via MCP (`lorecodex-mcp`)

Add `lorecodex` to your agent's `mcpServers` config:

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

### Recommended Retrieval Workflow for Native Agents

When answering plot, character, timeline, or worldbuilding questions from a LoreCodex corpus:

1. **Discover Corpora**: Call `lorecodex_list_corpora` to inspect mounted corpus IDs, total volumes/chapters/scenes, and `max_order`.
2. **Concurrent Turn-1 Routing**:
   - Call `lorecodex_list_series` (Level-0 volume overview) or `lorecodex_list_arcs` (Level-1 chapter filter by `series`, `character`, `keyword`, or `tone`).
   - **In parallel**, call `lorecodex_grep_scenes` with key entity names, quotes, or timeline markers (e.g., `"十年前 解散"`). `lorecodex_grep_scenes` automatically expands character aliases and flags `[CAMEO]` appearances where a character speaks in a chapter whose catalog metadata did not list them.
3. **Expand & Batch Read**:
   - Use `lorecodex_expand_arc` to inspect Level-2 scene summaries within candidate chapters.
   - Call `lorecodex_read_scenes` with an array of `scene_node_ids` (up to 10 scenes per call) to read lossless Level-3 original prose.
4. **Cite Verified Nodes**: Always cite verified `[node_id]`s in your synthesis and respect `max_order` when spoiler gating is requested.
5. **Context-Saving Sub-Agent Mode**: If you want a distilled answer without loading intermediate tool outputs into your own context window, call `lorecodex_ask_agent(corpus, query, max_order)`.

## 2. Building & Upgrading Corpora via CLI or MCP

- **Instant Heuristic Build (< 3s for 4M chars, zero API cost)**:
  ```bash
  python builders/build_novel.py --input novel.txt --corpus-id my-novel --name "作品名" --no-llm
  ```
- **In-Place LLM Summary & Metadata Synthesis (per-volume or full-book with checkpoint resume)**:
  ```bash
  python builders/build_novel.py --upgrade --corpus-id my-novel --series "第一卷"
  ```
- **Worldbook / Character Card V2 Merge**:
  ```bash
  python builders/build_lore.py --input worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats --no-llm
  ```
