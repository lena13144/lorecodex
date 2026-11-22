# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?style=flat-square&logo=node.js&logoColor=white)
![零第三方依赖](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**无向量树推理 + 毫秒级内存别名全文检索 + 原生思考旁路记忆 Agent：长篇小说、大体量游戏世界观与 SillyTavern 同人卡的好帮手**

> 零第三方依赖、无需向量数据库、不调 Embedding/Rerank API、不把原著硬切成碎片。  
> 将百万字原著小说、设定集与酒馆世界书合体为 `分部/卷 → 篇章/章 → 场景/幕` 三级叙事目录树；由带原生思考能力的轻量旁路模型像考据党一样翻阅目录、配合自动展开人物别名的毫秒级内存 `grep_scenes` 扫全库、精读无截断原著场景，再将核实过的记忆导读与完整原幕交给酒馆主模型。

[English Documentation](./README.en.md)

---

## 为什么它是同人卡制作与游玩的好帮手？

制作或游玩长篇小说同人卡、二游/单机大世界观同人卡时，创作者和玩家往往受困于两难：手搓几百条绿灯/蓝灯世界书既费时又容易爆上下文，而只塞浓缩大纲又会让角色丢失原著对白腔调与支线细节；改用传统向量 RAG 则会把完整名场面切成 500 字碎片，既认不出角色外号/代号，还经常跨卷剧透大结局。

LoreCodex 专为解决同人卡与长线 RP 的这些痛点而设计：

1. **原著小说 + 酒馆世界书 + V2 角色卡设定直接合体**：无需手工拆分成百上千条触发词，拖入原著 `.txt` / `.epub` / `.md`、世界书 `.json` 或带 `character_book` 的 V2 角色卡即可并入同一棵三级叙事树。
2. **完整原幕注入，还原原著腔调**：旁路 Agent 调用 `read_scene` 读取并注入的是**无截断的完整原著场景**，主模型能直接参考原著的对话语气、互动细节与情绪张力，大幅降低同人角色 OOC。
3. **毫秒级人物别名自动展开 & 客串幕捕捉**：角色有本名、化名、代号、外号？搜任一称呼自动展开全组别名扫描全库（数百万字 `< 15ms`），并自动置顶“章节目录未署名、但正文中登场说话”的客串幕。
4. **硬件级防剧透进度锁（`maxOrder`）**：同人开局想从第 1 卷或某个转折点切入？设置 `maxOrder` 后，从目录、Grep 到单幕读取全链路硬性拦截后续章节，同时保留无进度限制的通用设定，边推进剧情边解锁。
5. **原生思考纠偏与抗幻觉**：完整保留现代推理模型原生思考（Reasoning）能力，不硬编码 `max_tokens` 上限；面对玩家自设 OC 或记忆偏差提问，能主动排查近音词、纠正原著地点/设定细节，原著无此人时干净跳过不瞎编。

---

## 工作台界面预览

| 书卷流派 · **素笺 (`Paper`)** 记忆导读卷宗与寻路瀑布流 | 现代工作台 · **曜夜 (`Studio Dark`)** 别名展开检索与正文高亮 |
| :---: | :---: |
| ![LoreCodex 素笺主题工作台预览](./docs/preview-paper.png) | ![LoreCodex 曜夜主题全文检索预览](./docs/preview-studio-dark.png) |

---

## 核心架构：渐进式目录树披露

主模型在每轮对话前不再需要吞下庞大的静态世界书或几十万字摘要，而是交给旁路 Agent 按层级按需展开：

```text
SillyTavern 对话轮次 / API 请求
   │
   ▼  动态 System Prompt（由当前语料 corpus.json 自动装配规则、词汇表与防幻觉护栏）
   ├──► 第 0 层（>250 章自动折叠）：`list_series`
   │       面对超大规模长篇网文，首轮先展示分部/卷宗概览与各卷剧情总览（series_summaries）。
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
   纯 Node.js（`>= 18`）运行时（`src/server.js`）+ 纯 Python 3 标准库建树工具，0 第三方 npm 包、0 第三方 Python 包，无需向量数据库或 Embedding/Rerank API，电脑与安卓 Termux 均开箱即跑。
2. **先离线秒建树，再按卷原地 LLM 目录升级（`--upgrade`）**  
   - 支持几百万字 `.txt`（自动探测 UTF-8 / GB18030）、`.md`、`.epub` 先以 `--no-llm` 模式在几秒内离线切好 `分部 → 章 → 幕` 三级树立刻开玩；
   - 随后可在网页工作台或命令行**按分卷（`--series`）或章节范围（`--start-arc` / `--limit-arcs`）**并发运行 LLM 原地升级目录摘要：单幕章自动复用分幕摘要免除重复请求，升级完成后**自动合成各卷总览（`series_summaries`）、人物别名对照表（`aliases`）与专有设定词汇表（`glossary`）**并无损合并入 `corpus.json`，全程支持 JSONL 断点续传。
3. **世界书与角色卡设定单树共生（`build_lore.py`）**  
   支持 SillyTavern 世界书 `.json`、V2 角色卡 `.json`（自动提取内嵌 `character_book`）、`.jsonl` 与 `.md`/`.txt` 档案目录（支持 `--filter-game-stats` 清洗游戏数值噪点），并通过幂等 `--merge-into` 与小说正文合并为同一棵树。
4. **4 种叙事查询拓扑策略**  
   - **拓扑 A · 定点事件 / 词条查证**：`1~3` 幕核心片段 + 相邻幕连读。  
   - **拓扑 B · 宏观长跨度回顾**：`selected_arcs` 逐幕脉络大纲 + 高潮代表幕。  
   - **拓扑 C · 单角色立体塑人**：跨越不同分类与时期抽取 `4~7` 幕，避免单篇偏食。  
   - **拓扑 D · 群像与多声部齐聚**：主动脱离近期在场单一角色锁定，按 `tone_tags` 氛围分流抽取多视角片段。
5. **4 主题典籍工作台、移动端底部导航与推理轨迹可视化（`ui/`）**  
   提供 **书卷·素笺 / 书卷·墨灯 / 工作台·净台 / 工作台·曜夜** 4 套主题、桌面可拖拽三栏与移动端（`<= 860px`）底部三标签导航、Grep 命中高亮与正文直跳、**每轮 Agent 思考过程（Reasoning）折叠卡片与工具调用瀑布流**、酒馆实际注入原文预览、在线语料配置及**网页拖拽上传建树 + 在线按卷 LLM 目录补全**。
6. **支持 GitHub URL 一键安装的酒馆插件与全屏内嵌浮层（`extension/st-tree-lore/`）**  
   支持在 SillyTavern 扩展面板直接填 GitHub URL 一键安装与更新；支持在酒馆内直接弹出全屏工作台浮层（`?embed=1` / `/loreui`），提供上次注入实时预览、角色卡专属绑定（`charBindings`）、防剧透序快捷调节与内嵌测试检索。

---

## 保姆级安装指南（PC / 酒馆一键安装 / 手机端全覆盖）

### 一、电脑端（Windows / macOS / Linux）

#### 1. 在 SillyTavern 内通过 GitHub 一键安装插件（推荐）
1. 打开 SillyTavern 右上角 **「扩展 (Extensions) → 安装扩展 (Install Extension)」**；
2. 粘贴本仓库地址并确认安装：
   ```text
   https://github.com/lena13144/lorecodex
   ```
3. 酒馆会自动将仓库克隆到你的扩展目录（通常位于 `<SillyTavern>/data/default-user/extensions/lorecodex` 或 `<SillyTavern>/public/scripts/extensions/third-party/lorecodex`），后续可直接在酒馆扩展管理里一键检查更新。  
   *(注：你也可以手动将 `extension/st-tree-lore/` 复制到 `<SillyTavern>/public/scripts/extensions/third-party/st-tree-lore/`)*。

#### 2. 启动 LoreCodex 后端服务
确保本机已安装 [Node.js (>=18)](https://nodejs.org/) 和 [Python 3](https://www.python.org/)（用于网页导入小说与世界书建树）。  
直接进入刚才酒馆克隆出的扩展目录（或单独 `git clone https://github.com/lena13144/lorecodex.git` 的目录），运行：

```bash
node src/server.js
# 或：npm start
```

看到 `LoreCodex server listening on http://127.0.0.1:5240` 即启动成功（无需 `npm install` 任何第三方依赖）。  
刷新酒馆页面，展开 **「LoreCodex 树形典籍检索 (st-tree-lore)」**，状态显示 `在线`，点击 **「打开书阁」** 或输入 `/loreui` 即可在酒馆内弹窗使用。

---

### 二、手机端安装与使用

#### 玩法 A：安卓手机 Termux 纯本地运行（适合手机本地跑酒馆的玩家）
由于 LoreCodex 没有任何需要编译的 C++ 或 Python 第三方依赖，在 Termux 中不会遇到传统向量库编译报错问题：
1. 在手机酒馆的 **「扩展 → 安装扩展」** 中粘贴 `https://github.com/lena13144/lorecodex` 一键安装插件；
2. 在 Termux 中新开一个会话（确保已安装 `nodejs` 与 `python`），克隆并启动后端（或直接进入酒馆扩展目录启动）：
   ```bash
   git clone https://github.com/lena13144/lorecodex.git ~/lorecodex
   cd ~/lorecodex
   node src/server.js
   ```
3. 手机浏览器回到酒馆，点击插件面板的 **「打开书阁」**（或发送 `/loreui`），界面会自动切换为**移动端底部三标签导航**，可直接在手机浏览器里点击「导入」选择手机中的 `.txt` / `.epub` / `.json` 建树。

#### 玩法 B：TauriTavern / 手机纯前端免服务端模式（无需 Termux、无需 Node.js 后端）
如果你使用的是 **TauriTavern**（桌面或 Android 原生 App），或者在手机上不想启动任何 Termux / Node.js 后台进程：
1. 在 TauriTavern / 酒馆的扩展管理中粘贴 `https://github.com/lena13144/lorecodex` 安装插件；
2. 展开插件面板中的 **「TauriTavern / 手机免服务端内置书库 (IndexedDB 纯前端引擎)」**，勾选 **「启用纯前端免服务端模式」**；
3. 直接点击文件选择框，选中手机或电脑本地的小说（`.txt` / `.md`）、世界书或 V2 角色卡（`.json`），或者从电脑端书阁导出的单文件书库包（`.lorepack.json`），点击 **「导入并建树到浏览器」**；
4. 书库将直接保存在浏览器/WebView 的 `IndexedDB` 中，由内置纯 JS 树形 Agent 与毫秒级 Grep 引擎直接完成每轮检索注入，全程零后台依赖。

#### 玩法 C：电脑 / 服务器跑后端，手机连局域网访问
若酒馆与 LoreCodex 运行在电脑或 NAS 上，手机通过局域网（`192.168.x.x` / Tailscale `100.x.x.x`）访问电脑酒馆：
1. 电脑启动 LoreCodex 时开启局域网监听：
   ```bash
   node src/server.js --host 0.0.0.0 --port 5240
   ```
2. 手机打开电脑酒馆网页，插件会自动探测并回退到 `http://<电脑局域网IP>:5240`（也可手动填入局域网地址），局域网与 TauriTavern 来源均已默认放行。

---

## 如何给你的同人卡建树？（零命令行网页三步法）

除了命令行工具外，所有建树与升级操作均可直接在网页工作台中点鼠标完成：

### 第一步：配置旁路推理模型
1. 在酒馆插件面板点击 **「打开书阁」**（或浏览器打开 `http://127.0.0.1:5240`）；
2. 点击右上角 **「设置」**，填入任意 OpenAI 兼容接口（Base URL、API Key，可点击「拉取模型」自动获取模型列表；`Max Tokens` 留空即可自动沿用模型原生上限）。  
   *(也可以手动将 `config.example.json` 复制为 `config.json` 配置)*。

### 第二步：拖拽上传小说与世界书（支持离线秒建树）
1. 点击顶栏 **「导入」** 按钮：
   - **导入原著小说**：拖入 `.txt`（自动识别 UTF-8 / GB18030）、`.epub` 或 `.md`，填写书库 ID（如 `my-fandom`）与名称；
   - **建议先勾选「离线快速建树 (`--no-llm`)」**：数百万字小说几秒内即可切好 `分部 → 章 → 幕` 三级树，立即可在同人卡中挂载使用。
2. **（可选）将世界书或 V2 角色卡设定集并入同一棵树**：
   - 再次点击 **「导入」**，切换到 **「世界书 / 设定集 (`build_lore.py`)」**；
   - 拖入酒馆世界书 `.json` 或带 `character_book` 的 V2 角色卡 `.json`，选择 **「并入已有书库 (`--merge-into`)」** 并选中 `my-fandom`，设定集与小说正文即合体为同一棵树。

### 第三步：按卷进行 LLM 目录补全（自动生成分幕摘要、人物别名与词汇表）
想要让旁路 Agent 获得最佳目录寻路效率与自动配好的别名表：
1. 在工作台顶栏选中你的书库，点击 **「书库配置」** 按钮；
2. 切换到第 4 个标签页 **「LLM 目录补全」**；
3. 选择 **「仅升级指定分卷（如：第1卷）」** 或填写起止章节号，设置并发数（如 `6~8`），点击 **「开始原地升级目录」**；
4. 后台将并发调用 LLM 生成精准分幕摘要、出场人物与氛围标签，并在收尾时**自动提炼该卷剧情总览、人物别名对照表、专有设定词汇表**并无损合并进 `corpus.json`（自带断点续传，单幕章自动跳过冗余调用）。

---

## 命令行建树与升级速查（进阶 / 批量脚本）

```bash
# 1. 离线零成本快速建树（TXT / MD / EPUB / 文件夹）：
python3 builders/build_novel.py --input path/to/novel.txt --corpus-id my-novel --name "我的小说" --no-llm

# 2. 按指定分卷原地升级 LLM 摘要，并自动提炼卷总览 + 人物别名 + 设定术语（支持断点续传）：
python3 builders/build_novel.py --upgrade --corpus-id my-novel --series "第1卷" --workers 8

# 3. 将 SillyTavern 世界书或 V2 角色卡并入同一棵树：
python3 builders/build_lore.py --input path/to/worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats --no-llm
```

---

## 酒馆插件功能与斜杠命令

- **角色卡自动绑定（`charBindings`）**：点击面板中的「绑定当前角色卡」，即可将该角色卡与指定书库、`maxOrder` 防剧透上限和 `POV` 视角绑定，切换同人卡时自动切换书库与进度。
- **上次注入实时预览与轨迹直达**：每轮对话后实时展示命中幕数、耗时、注入字数与章节列表，点击 **「在酒馆内查看完整轨迹」** 直接弹窗回放该轮 Agent 思考链与翻书瀑布流。
- **斜杠命令**：
  - `/loreui` — 在酒馆内打开嵌入式典籍与轨迹工作台全屏浮层
  - `/lorecodex [on|off]` — 开关树检索
  - `/lorecorpus <corpus_id>` — 切换当前挂载书库
  - `/loreorder <n|off>` — 设置或解除防剧透章节序上限
  - `/lorepov <角色名>` — 设置当前检索视角（角色缺席事件自动标注转述/传闻）

---

## 原生 Agent 接入：MCP Server 与 Agent Skill

除了给酒馆挂载记忆外，LoreCodex 原生内置了零依赖的 **MCP Server（`src/mcp_server.js`）** 与 **Agent Skill（`skills/lorecodex/SKILL.md`）**，可直接挂载到 Claude Code、Antigravity、Cursor、Codex 等原生 Agent 环境：

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

暴露的 8 个 MCP 工具涵盖两种使用模式：
- **主 Agent 亲自翻书模式（零额外旁路 API 消耗）**：`lorecodex_list_corpora`、`lorecodex_list_series`、`lorecodex_list_arcs`、`lorecodex_expand_arc`、`lorecodex_grep_scenes`（毫秒级内存别名与客串扫描）、`lorecodex_read_scenes`（批量读取最多 10 幕无损原文）。
- **子 Agent 蒸馏与在线建树模式**：`lorecodex_ask_agent`（由独立子 Agent 翻完目录树后仅向主 Agent 返回浓缩导读与证据原文，节省主 Agent 上下文窗口）、`lorecodex_build_corpus`（直接从本地小说/EPUB/世界书建树或执行 `--upgrade`）。

---

## 目录结构

```text
lorecodex/
├── manifest.json          # 仓库根清单（支持 SillyTavern 通过 GitHub URL 一键安装扩展）
├── src/
│   ├── server.js          # 零依赖 HTTP 服务与异步建树/升级任务调度
│   ├── corpus_manager.js  # 多语料发现、元数据管理与按需懒加载
│   ├── tree_agent.js      # 三级目录树推理、原生思考捕获、防剧透门控与多轮工具循环
│   ├── prompt_builder.js  # 基于 corpus.json 的动态提示词与工具 Schema 生成器
│   ├── grep_engine.js     # 内存毫秒级别名/客串感知 grep + 多语种正则扫描
│   ├── graph_engine.js    # 可选一跳实体关系图谱查询
│   └── utils.js           # 跨平台 Python 探测、富文本清洗与 order 门控工具
├── ui/
│   ├── index.html         # 模块化典籍阅览器与轨迹工作台入口
│   ├── styles.css         # 4 套主题（素笺/墨灯/净台/曜夜）与响应式分栏样式
│   └── js/                # 零构建原生 ES 模块（api, state, toc, reader, trace, modals, main）
├── builders/
│   ├── build_novel.py     # TXT / MD / EPUB 三级树建树器与 --upgrade 原地 LLM 目录升级器
│   └── build_lore.py      # 世界书 / V2 角色卡 / MD / JSONL 建树与 --merge-into 合并器
├── extension/
│   └── st-tree-lore/      # SillyTavern 第三方扩展插件前端代码与样式
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

## HTTP API 速查

| 方法与路径 | 说明 |
| :--- | :--- |
| `GET /` \| `GET /ui` | 访问书阁与检索轨迹工作台（`/ui/*` 托管模块静态资源） |
| `GET /health` | 查看服务状态、冷启动耗时与已注册书库摘要 |
| `GET /corpora` \| `GET /corpora/:id` | 获取全部书库或单个书库的完整配置与统计 |
| `POST /corpora/:id/config` | 在线更新 `corpus.json` 并热重载该语料检索 Agent |
| `POST /corpora/import` | 接收网页上传的 `.txt`/`.md`/`.epub`/`.json`/`.jsonl` 并异步执行建树任务 |
| `POST /corpora/:id/upgrade` | 在线按分卷或章节范围执行原地 LLM 目录摘要升级与别名/术语自动提炼 |
| `POST /corpora/reload` | 热重载 `corpora/` 目录并清理缓存 |
| `GET /jobs` \| `GET /jobs/:id` | 查询建树/升级任务状态与实时构建日志 |
| `GET /tree-index` \| `GET /tree-scene` \| `GET /tree-grep` | 树目录、单幕原文（含 `403` 防剧透拦截）与毫秒级全文检索 |
| `POST /tree-search` \| `GET /tree-runs` | 运行旁路树推理检索 Agent 及获取最近 40 条寻路轨迹 |
| `GET /config` \| `POST /config` \| `POST /models` | 读取/保存服务端配置与拉取上游模型列表 |

---

## 自动化验收测试

- **零 API 密钥离线测试**（覆盖 EPUB/网文 TXT/V2 角色卡解析、Mock LLM 原地 `--upgrade` 升级、冷启动耗时、静态资源与路径穿越拦截、Origin/密钥防窃取校验、在线配置、网页上传建树、`maxOrder` 防剧透测试、毫秒级别名/客串 `grep`、敏感信息/本地路径扫描与 JS 语法检查）：

```bash
npm test
```

- **完整验收（含真实 LLM Agent 回归）**（当本机已配置 `config.json` 或 `CHAT_KEY` 时，自动追加 `demo-chronicles` 防剧透与多源检索回归测试）：

```bash
npm run verify
```

---

## 为什么不用向量库？（演进心路）

这个项目并不是一开始就打算“无向量”的——恰恰相反，我们也曾完整走过传统向量 RAG 的弯路：

1. **第一阶段：传统向量 RAG（切片 + Embedding + Rerank）**  
   最初面对数百万字的长篇剧情与设定时，我们按照经典方案做了文本分块、向量化索引和重排。但放到长篇小说与同人角色扮演场景下，很快暴露了三个硬伤：
   - **切块破坏叙事完整性**：固定字数切分经常把一段完整对白或剧情反转拦腰截断，主模型拿到的是断章取义的碎片段；
   - **指代与别名失明**：对话中常见的“她当年那句话”、人物外号/代号、或目录未署名的客串台词，靠向量语义相似度极易张冠李戴；
   - **部署与维护成本高**：每新增一章都要重新 Embedding、背着庞大的向量索引文件冷启动，普通玩家还要额外配置 Embedding 与 Rerank API。
2. **第二阶段：目录树 + 向量兜底（混合过渡期）**  
   受 PageIndex 思想启发，我们为整部作品构建了层级目录树，让便宜的旁路推理模型像读者翻书一样先看目录再读完整场景，同时保留了一套向量检索作为兜底（fallback）。但配合全内存、自动展开别名的毫秒级 `grep_scenes` 之后，我们在真实轨迹日志里发现：**只要树索引与别名 Grep 配合得当，旁路 Agent 几乎再也不会去调用向量兜底**。
3. **第三阶段：彻底卸下包袱（LoreCodex v2）**  
   既然向量库已经成了拖慢启动、徒增门槛的冗余组件，干脆彻底剥离，只留下最有效、最轻量的核心——**层级目录树推理 + 毫秒级内存别名 Grep + 无截断场景精读 + 防剧透门控**。于是才有了现在零外部依赖、酒馆一键安装、拖入小说或世界书即可建树的 LoreCodex。

---

## 灵感来源与致谢

- **[PageIndex (VectifyAI)](https://github.com/VectifyAI/PageIndex)**：LoreCodex 的核心无向量树形渐进检索范式（让推理模型翻阅层级目录树而非依赖向量分块检索）深受 PageIndex 理念启发。在此基础上，本项目从零独立实现并面向长篇小说、游戏世界观与同人角色扮演场景进行了深度扩展（三级叙事书脊、毫秒级内存别名/客串 Grep、硬件级 `maxOrder` 防剧透门控、4 种叙事查询拓扑及可视化追踪工作台）。
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**：感谢优秀的开源角色扮演前端生态与扩展接口设计。

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
