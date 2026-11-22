# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=node.js&logoColor=white)
![零第三方依赖](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**无向量树推理 + 毫秒级内存全文检索 + 旁路记忆 Agent：专为长篇小说、游戏世界观与 SillyTavern 角色扮演打造**

> 零第三方依赖、无需向量库、不调重排 API、不硬切文本片段。  
> 让轻量便宜的旁路推理模型先翻阅层级目录树（`分部 → 篇章 → 幕`），再配合自动展开人物别名的毫秒级内存 `grep_scenes` 扫全库、精读无截断原场景，最后将核实过的记忆导读与完整片段交给你的正文主模型。

[English Documentation](./README.md)

---

## 工作台界面预览

| 书卷流派 · **素笺 (`Paper`)** 记忆导读卷宗与寻路瀑布流 | 现代工作台 · **曜夜 (`Studio Dark`)** 别名展开检索与正文高亮 |
| :---: | :---: |
| ![LoreCodex 素笺主题工作台预览](./docs/preview-paper.png) | ![LoreCodex 曜夜主题全文检索预览](./docs/preview-studio-dark.png) |

---

## 核心架构：`--tree-only` 渐进式披露

主模型在每轮对话前不再需要吞下庞大的静态世界书或几十万字摘要，而是交给旁路 Agent 按层级按需展开：

```text
SillyTavern 对话轮次 / API 请求
   │
   ▼  动态 System Prompt（由当前语料 corpus.json 自动装配规则、词汇表与防幻觉护栏）
   ├──► 第 0 层（>250 卷自动折叠）：`list_series`
   │       面对超大规模长篇网文，首轮只展示分部/卷宗概览，防止目录撑爆上下文。
   │
   ├──► 第 1 层：`list_story_arcs`（紧凑篇章书脊目录）
   │       支持按分部、分类、人物（自动展开别名）、关键词与氛围标签 `tone` 过滤。
   │
   ├──► 第 2 层：`get_arc_scenes` 或 `grep_scenes`（毫秒级全库内存扫描）
   │       • 仅展开挑中的 1~5 个篇章分幕摘要；
   │       • `grep_scenes` 自动展开人物别名、优先标记目录漏标的“客串幕”、支持多语种正则直扫。
   │
   └──► 第 3 层：`read_scene`（无截断精读原幕 + 可选宏观大纲与关系图谱）
           先核实完整正文与 `maxOrder` 防剧透边界，再输出结构化 `guide` 导读与完整场景正文。
```

---

## 核心特性

1. **零外部依赖 & 极速冷启动（`< 500ms`）**  
   纯 Node.js（`>= 18`）运行时（`src/server.js`），默认 `--tree-only` 架构，彻底移除对庞大 `vectors.f32` 向量文件和 Embedding/Rerank 服务的启动依赖。
2. **可插拔多语料书库规范（`corpora/<id>/`）**  
   支持同时挂载多个独立作品书库（`corpus.json` + `tree_index.json` + `tree_texts.json` + 可选 `graph.json`）。每部作品均可独立配置人物别名 `aliases`、组织编制 `glossary`、舞台卡防误搜正则、玩家身份隔离规则、数据库状态清洗正则及注入模板。
3. **硬件级防剧透进度门控（`maxOrder`）**  
   在 `/tree-index`、`/tree-grep`、`/tree-scene`、Agent 工具执行及回溯水化全链路强制执行 `order <= maxOrder` 校验，确保连载追更或阶段扮演绝不剧透后续章真相；同时保留无进度限制（`order: null`）的通用世界观档案。
4. **纯 Python 标准库通用建树工具链**  
   - `builders/build_novel.py`：支持 `.txt`（自动探测 UTF-8 / GB18030）、`.md`、`.epub` 及文件夹导入，按自然段落地生成 `分部 → 章 → 幕` 三级树，支持 `--no-llm` 零成本离线建树与 LLM 并发摘要 + JSONL 断点续传。
   - `builders/build_lore.py`：支持 SillyTavern 世界书 `.json`、`.jsonl` 与 `.md`/`.txt` 档案目录（支持 `--filter-game-stats` 清洗游戏数值广告噪点），并通过幂等 `--merge-into` 与正文小说单树共生。
5. **4 种通用查询拓扑策略**  
   - **拓扑 A · 定点事件 / 词条查证**：`1~3` 幕核心片段 + 相邻幕连读。  
   - **拓扑 B · 宏观长跨度回顾**：`selected_arcs` 逐幕脉络大纲 + 高潮代表幕。  
   - **拓扑 C · 单角色立体塑人**：跨越不同分类与氛围抽取 `4~7` 幕，避免单篇偏食。  
   - **拓扑 D · 群像与多声部齐聚**：主动脱离近期在场单一角色锁定，按 `tone_tags` 氛围分流抽取多视角片段。
6. **多主题典籍工作台与全闭环 Web 管理（`ui/`）**  
   提供 **书卷·素笺 / 书卷·墨灯 / 工作台·净台 / 工作台·曜夜** 4 套主题、可拖拽三栏布局、三级折叠树（`分部 → 篇章 → 幕`）、Grep 命中高亮与正文直跳、寻路瀑布流时间轴、导读节点联动、酒馆实际注入原文预览与复制、`Ctrl+K` 快速命令面板、在线语料配置弹窗及**网页拖拽上传建树**。
7. **原生主题融合酒馆插件（`extension/st-tree-lore/`）**  
   融合 SillyTavern `SmartTheme` 变量、顶部实时连接状态栏、**上次注入实时预览卡片**（支持一键直达书阁 `#run=...` 轨迹）、内嵌测试检索区、角色卡自动绑定（`charBindings`）、防剧透序、斜杠命令及早期原型插件配置一键兼容迁移。

---

## 目录结构

```text
lorecodex/
├── src/
│   ├── server.js          # 零依赖 HTTP 服务 (--tree-only)
│   ├── corpus_manager.js  # 多语料发现、元数据管理与按需懒加载
│   ├── tree_agent.js      # 三级目录树推理、防剧透门控与多轮工具循环
│   ├── prompt_builder.js  # 基于 corpus.json 的动态提示词与工具 Schema 生成器
│   ├── grep_engine.js     # 内存毫秒级别名/客串感知 grep + 多语种正则扫描
│   ├── graph_engine.js    # 可选一跳实体关系图谱查询
│   └── utils.js           # 跨平台 Python 探测、富文本清洗与 order 门控工具
├── ui/
│   ├── index.html         # 模块化典籍阅览器与轨迹工作台入口
│   ├── styles.css         # 4 套主题（素笺/墨灯/净台/曜夜）与响应式分栏样式
│   └── js/                # 零构建原生 ES 模块（api, state, toc, reader, trace, modals, main）
├── builders/
│   ├── build_novel.py     # TXT / MD / EPUB 三级树建树器（纯 Python 标准库）
│   └── build_lore.py      # 世界书 JSON / MD / JSONL 建树与 --merge-into 合并器
├── extension/
│   └── st-tree-lore/      # 通用 SillyTavern 第三方扩展插件
├── corpora/
│   └── demo-chronicles/   # 开箱即用的《星港编年史》小说 + 世界书合并示例语料包
├── examples/
│   └── demo-chronicles/   # 示例源文件 chronicles.txt 与 worldbook.json
├── scripts/
│   ├── create_demo_corpus.mjs
│   └── verify.mjs         # 自动化离线与实测端到端验收脚本
├── docs/                  # 工作台截图资源
├── config.example.json
├── LICENSE
└── package.json
```

---

## 快速开始

### 1. 配置旁路推理模型

将 `config.example.json` 复制为 `config.json` 并填入 OpenAI 兼容接口地址与密钥（也可通过环境变量 `CHAT_BASE` / `CHAT_KEY` / `CHAT_MODEL` 注入）：

```json
{
  "port": 5240,
  "defaultCorpus": "demo-chronicles",
  "chatBase": "https://api.openai.com/v1",
  "chatKey": "your-api-key",
  "chatModel": "deepseek-chat",
  "disableThinking": true
}
```

### 2. 启动服务并打开书阁工作台

```bash
npm start
# 或：node src/server.js --tree-only --port 5240 --host 127.0.0.1
```

浏览器访问 `http://127.0.0.1:5240`，即可切换书库、调节防剧透上限、全文搜台词并在右侧实时观测每一次检索轨迹。

#### 默认安全策略（本地回环绑定与跨站保护）
- **默认仅监听回环地址**：服务端默认绑定 `127.0.0.1`，防止局域网内未经授权设备访问本地配置与上传接口。若需在可信内网供远程设备连接，可传入 `--host 0.0.0.0` 或设置环境变量 `HOST=0.0.0.0`。
- **Origin 校验与密钥防窃取**：敏感写入与代理接口（`POST /config`、`POST /models`、`POST /corpora/import`、`POST /corpora/:id/config`）仅允许本地回环来源（`localhost` / `127.0.0.1` / `[::1]`）或通过环境变量 `ALLOWED_ORIGINS`（逗号分隔）显式放行的源；且当请求自行覆盖不同的 `chatBase` / `baseUrl` 时，服务端绝不附带本地保存的 `chatKey`。
- **跨平台 Python 自动探测**：网页端拖拽导入建树会自动探测 `PYTHON_BIN`、`python3` 与 `python`，兼容 Windows / macOS / Linux。

### 3. 导入你自己的作品与世界书

**导入长篇小说（`.txt` / `.md` / `.epub` 或章节目录）：**

```bash
# 离线零成本快速建树：
python3 builders/build_novel.py --input path/to/novel.epub --corpus-id my-novel --name "我的小说" --no-llm

# 或启用并发 LLM 生成高质量摘要与人物/氛围标注（支持断点续传）：
python3 builders/build_novel.py --input path/to/novel.txt --corpus-id my-novel --name "我的小说" --config config.json
```

**将 SillyTavern 世界书或设定文件夹并入同一棵树：**

```bash
python3 builders/build_lore.py --input path/to/worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats --no-llm
```

导入完成后在 UI 顶栏点击 **「刷新」** 或调用 `POST /corpora/reload` 即可立即生效。

---

## SillyTavern 酒馆插件安装（`st-tree-lore`）

1. 将 `extension/st-tree-lore/` 复制到酒馆目录 `<SillyTavern>/public/scripts/extensions/third-party/st-tree-lore/`。
2. 刷新酒馆页面，在扩展面板中展开 **「LoreCodex 树形典籍检索 (st-tree-lore)」**。
3. 若本机曾启用早期单作品原型桥接扩展，插件会自动检测并在顶部提供一键平滑迁移并停用旧插件，避免双倍注入。
4. 支持的斜杠命令：
   - `/lorecodex [on|off]` — 开关树检索
   - `/lorecorpus <corpus_id>` — 切换当前挂载书库
   - `/loreorder <n|off>` — 设置防剧透章节序上限
   - `/lorepov <角色名>` — 设置检索视角（POV）

---

## HTTP API 速查

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /` \| `GET /ui` | 访问书阁与检索轨迹工作台（`/ui/*` 托管模块静态资源） |
| `GET /health` | 查看服务状态、冷启动耗时与已注册书库摘要 |
| `GET /corpora` \| `GET /corpora/:id` | 获取全部书库或单个书库的完整配置与统计 |
| `POST /corpora/:id/config` | 在线更新 `corpus.json` 并热重载该语料检索 Agent |
| `POST /corpora/import` | 接收网页上传的 `.txt`/`.md`/`.epub`/`.json`/`.jsonl` 并异步执行建树任务 |
| `POST /corpora/reload` | 热重载 `corpora/` 目录并清理缓存 |
| `GET /jobs` \| `GET /jobs/:id` | 查询建树任务状态与实时构建日志 |
| `GET /tree-index` \| `GET /tree-scene` \| `GET /tree-grep` | 树目录、单幕原文（含 `403` 防剧透拦截）与毫秒级全文检索 |
| `POST /tree-search` \| `GET /tree-runs` | 运行旁路树推理检索 Agent 及获取最近 40 条寻路轨迹 |

---

## 自动化验收测试

- **零 API 密钥离线测试**（覆盖 EPUB 解析、冷启动耗时、静态资源与路径穿越拦截、Origin/密钥防窃取校验、在线配置、网页上传建树、`maxOrder` 防剧透测试、毫秒级别名/客串 `grep`、敏感信息/本地路径扫描与 JS 语法检查）：

```bash
npm test
```

- **完整验收（含真实 LLM Agent 回归）**（当本机已配置 `config.json` 或 `CHAT_KEY` 时，自动追加 `demo-chronicles` 防剧透与多源检索回归测试）：

```bash
npm run verify
```

---

## 灵感来源与致谢

- **[PageIndex (VectifyAI)](https://github.com/VectifyAI/PageIndex)**：LoreCodex 的核心无向量树形渐进检索范式（让推理模型翻阅层级目录树而非依赖向量分块检索）深受 PageIndex 理念启发。在此基础上，本项目从零独立实现并面向长篇小说、游戏世界观与角色扮演场景进行了深度扩展（三级叙事书脊、毫秒级内存别名/客串 Grep、硬件级 `maxOrder` 防剧透门控、4 种叙事查询拓扑及可视化追踪工作台）。
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**：感谢优秀的开源角色扮演前端生态与扩展接口设计。

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
