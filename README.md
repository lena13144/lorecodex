# LoreCodex (`st-tree-lore`)

[![CI](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml/badge.svg)](https://github.com/lena13144/lorecodex/actions/workflows/ci.yml)
![Pure Frontend & Node >= 18](https://img.shields.io/badge/Runtime-Browser%20IndexedDB%20%7C%20Node%20%3E%3D18-339933?style=flat-square)
![零第三方依赖](https://img.shields.io/badge/Dependencies-Zero-0ea5e9?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b?style=flat-square)

**无向量树推理 + 毫秒级内存别名全文检索 + 原生思考旁路记忆 Agent：长篇小说、大体量游戏世界观、SillyTavern / TauriTavern 同人卡与原生 AI Agent 的好帮手**

> **零后台免安装、零第三方依赖、无需向量数据库、不调 Embedding/Rerank API、不把原著硬切成碎片。**  
> 将百万字原著小说（`.txt` / `.epub` / `.md`）、设定集与酒馆世界书合体为 `分部/卷 → 篇章/章 → 场景/幕` 三级叙事目录树；由带原生思考能力的轻量旁路模型像考据党一样并发翻阅目录、配合自动展开人物别名的毫秒级内存 `grep_scenes` 扫全库、批量精读无截断原著场景，再将核实过的记忆导读与完整原幕交给主模型。

[English Documentation](./README.en.md)

---

## 为什么它是同人卡制作、长线 RP 与文艺创作的好帮手？

制作或游玩长篇小说同人卡、二游/单机大世界观同人卡时，创作者和玩家往往受困于两难：手搓几百条绿灯/蓝灯世界书既费时又容易爆上下文，而只塞浓缩大纲又会让角色丢失原著对白腔调与支线细节；改用传统向量 RAG 则会把完整名场面切成 500 字碎片，既认不出角色外号/代号，还经常跨卷剧透大结局，更得在电脑上挂一个笨重的后台服务。

LoreCodex 专为解决这些痛点而设计：

1. **纯前端免后台架构（SillyTavern & TauriTavern 电脑/手机开箱即用）**：插件内置完整的 **IndexedDB 纯前端引擎 (`browser_engine.js`)** 与 **内嵌书阁工作台 (`extension/st-tree-lore/ui/`)**。在酒馆内通过 GitHub URL 一键安装后，**无需启动任何 Node.js、Python 或 Termux 后台进程**，在手机 TauriTavern APK 或桌面浏览器里直接选文件建树、跑 LLM 目录合成、打开书阁阅读与回放轨迹。
2. **原著小说 + 酒馆世界书 + V2 角色卡设定直接合体**：无需手工拆分成百上千条触发词，纯前端原生支持 `.txt`（自动识别 UTF-8 / GB18030）、`.epub`（浏览器原生 `DecompressionStream` 解压提取章节）、`.md`、世界书 `.json`、带 `character_book` 的 V2 角色卡 `.json` 以及单文件书库包 `.lorepack.json`。
3. **LLM 智能目录构建（自动提炼分幕梗概、卷总览、人物别名表与术语表）**：支持按分卷并发调用 LLM 将正文中的人称代词消解为具体人名，生成精准分幕摘要与全卷总览，并自动提炼**人物本名/化名/外号二维对照表 (`aliases`)** 与**专有设定词汇表 (`glossary`)**，全程支持 IndexedDB / JSONL 实时断点续传。
4. **完整原幕注入，还原原著腔调**：旁路 Agent 调用 `read_scene`（单次支持最多 10 幕批量连读）读取并注入的是**无截断的完整原著场景**，主模型能直接参考原著的对话语气、互动细节与情绪张力，大幅降低同人角色 OOC。
5. **毫秒级人物别名自动展开 & 客串幕捕捉**：角色有本名、化名、代号、外号？搜任一称呼自动展开全组别名扫描全库（数百万字 `< 15ms`），并自动置顶“章节目录未署名、但正文中登场说话”的客串幕 (`[CAMEO]`)。
6. **硬件级防剧透进度锁（`maxOrder`）**：同人开局想从第 1 卷或某个转折点切入？设置 `maxOrder` 后，从目录、Grep 到单幕读取全链路硬性拦截后续章节，同时保留无进度限制的通用设定，边推进剧情边解锁。

---

## 工作台界面预览

| 书卷流派 · **素笺 (`Paper`)** 记忆导读卷宗与寻路瀑布流 | 现代工作台 · **曜夜 (`Studio Dark`)** 别名展开检索与正文高亮 |
| :---: | :---: |
| ![LoreCodex 素笺主题工作台预览](./docs/preview-paper.png) | ![LoreCodex 曜夜主题全文检索预览](./docs/preview-studio-dark.png) |

---

## 核心架构：渐进式目录树披露

主模型在每轮对话前不再需要吞下庞大的静态世界书或几十万字摘要，而是交给旁路 Agent 按层级按需展开：

```text
SillyTavern / TauriTavern 对话轮次 或 原生 Agent (MCP / DeepSeek Harness)
   │
   ▼  动态 System Prompt（由当前语料配置自动装配规则、人物别名表、词汇表与防幻觉护栏）
   ├──► 首轮并发寻路：第 0 层 `list_series` / 第 1 层 `list_story_arcs` + 全库 `grep_scenes`
   │       • 宏观分卷概览（series_summaries）与紧凑篇章目录过滤；
   │       • 同时并发运行毫秒级内存 `grep_scenes`（自动展开人物别名、捕捉目录未署名的 `[CAMEO]` 客串幕）。
   │
   ├──► 第 2 层：`get_arc_scenes`（按需展开 1~5 个候选篇章的分幕摘要目录）
   │
   └──► 第 3 层：`read_scene`（支持单次最多 10 幕批量无截断精读 + 最多 10 卷宏观大纲）
           先核实完整正文与 `maxOrder` 防剧透边界，再输出结构化 `guide` 导读与完整场景正文。
```

---

## 保姆级安装与使用指南（默认零后台 · 手机 TauriTavern & 电脑酒馆通用）

### 第一步：在 SillyTavern / TauriTavern 内一键安装插件
1. 打开 SillyTavern 或 TauriTavern 顶部的 **「扩展 (Extensions) → 安装扩展 (Install Extension)」**；
2. 粘贴本仓库地址并确认安装：
   ```text
   https://github.com/lena13144/lorecodex
   ```
3. 刷新页面后展开右侧扩展面板中的 **「LoreCodex 典籍检索」**（v2.2 极简卡片，支持顶栏小太阳/小月亮一键切换 **墨灯深色 / 素笺浅色** 主题）：
   - 顶栏默认绿灯就绪并预挂载《苍穹残响·灰烬星港编年史》示例书库；侧边栏仅保留开关、选书库/绑角色、**LLM 目录进度条**、上次检索摘要与 **「打开 LoreCodex 大面板」** 主入口；
   - 点击 **「打开 LoreCodex 大面板」**（或输入 `/loreui`），即可直接在酒馆内弹出完整工作台（无需启动任何 Node.js 或 Python 后台！）。

### 第二步：配置旁路推理模型
1. 首次使用若未配置 API，侧边栏会自动浮现 **「尚未配置旁路模型 API · 去配置」** 引导，点击直达大面板的模型配置弹窗（也可在大面板右上角点击 **「模型」**）；
2. 填入任意 OpenAI 兼容接口的 **API Base URL** 与 **API Key**（如 DeepSeek、Gemini OpenAI 兼容端点、OpenRouter、硅基流动等）；
3. 点击 **「拉取模型」**，在弹出的模型下拉框中直接选择模型（`Max Tokens` 留空即可自动沿用模型原生上限），点击保存。

### 第三步：两步安全导入小说 / 世界书并建立 LLM 目录
在大面板顶栏点击 **「导入」**（或点击 **「书库管理」** 查看/切换/导出/删除全部书库）：
1. 选择本地的小说文件（支持 `.txt` 自动识别 UTF-8/GB18030、`.epub` 电子书、`.md`）、SillyTavern 世界书 `.json`、V2 角色卡 `.json`，或别人分享的 `.lorepack.json` 单文件书库包；
2. 点击 **「开始导入」**，先免费完成离线切分并展示**结构预检报告**（卷数、章数、字数与章节抽样），防止异常切分或脏文本误烧 API；
3. 确认切分无误后，手动点击 **「开始 LLM 建立目录」**（或随时在酒馆侧边栏的进度条控件 / 大面板「LLM 建目录」启动）：
   - **实时断点续传**：构建进度实时同步显示在酒馆侧边栏进度条与大面板中，每完成若干章自动写入 `IndexedDB`，随时点击 **「暂停」** 都不会丢失进度，下次继续自动跳过已完成章节；
   - **按卷增量构建**：数百万字超长篇可在大面板「书库设置 → LLM 目录补全」中选择 **目标分卷（如：第一卷）** 逐卷构建；
   - **书库管理与分享**：在大面板顶栏点击 **「书库管理」**，可一目了然查看所有书库的 LLM 覆盖率，一键打开、补全目录、导出 `.lorepack.json` 或永久删除书库。

---

## 按需选择安装包（GitHub Releases 分包指南）

除了在酒馆内通过 GitHub URL 一键安装外，[**GitHub Releases**](https://github.com/lena13144/lorecodex/releases) 还针对三类不同人群提供了 **3 套完全独立的按需发行包**：

| 发行包名称 | 适用人群 | 包含内容 |
| :--- | :--- | :--- |
| **`lorecodex-sillytavern-tauritavern-extension-v2.2.0.zip`** | **手机端 / TauriTavern / 纯酒馆前端玩家**（零后台，无需安装 Node.js 或 Python） | 仅含 `st-tree-lore` 酒馆扩展（v2.2 极简墨灯/素笺双模式侧边栏、IndexedDB 免后台引擎、内嵌大面板、纯前端 TXT/EPUB/JSON 建库与 LLM 目录升级器）+ `demo-chronicles.lorepack.json` |
| **`lorecodex-cloud-builder-kit-v2.2.0.zip`** | **云端 AI 拆书玩家**（Gemini App Task / Muse / Grok / Qoder / WorkBuddy / Claude） | 超轻量纯 Python 零依赖拆书工具包（`build_novel.py` + `build_lore.py` + `pack_lorepack.py` + `AGENT_INSTRUCTIONS.md`），连同小说直接丢给云端 AI 即可免 API Key 产出满血 `.lorepack.json` 供手机 1 秒导入 |
| **`lorecodex-agent-dsh-mcp-plugin-v2.2.0.zip`** | **AI Agent 开发者**（DeepSeek Harness `dsh` / Claude Code / Cursor / Antigravity） | 仅含 DeepSeek Harness (`@deepseek-ai/cordis`) 插件、零依赖 MCP Server、Agent Skill 与核心树引擎（剔除所有酒馆与 Web UI 资源） |
| **`lorecodex-full-server-workbench-v2.2.0.zip`** | **独立桌面书阁 / 本地命令行建库玩家**（需要脱离酒馆独立运行 `127.0.0.1:5240` 服务、绕过中转站 CORS 限制或与 MCP 共享本地磁盘 `corpora/`） | 完整 Node 服务端 + 独立书阁 Web UI + Python 批量建树器 + 酒馆扩展 + Agent 插件 |

---

## 原生 Agent 接入：DeepSeek Harness (`dsh`) 插件、MCP Server 与 Agent Skill

LoreCodex 原生内置了 **DeepSeek Harness (`@deepseek-ai/dsh` / Cordis) 插件（`src/dsh_plugin.js`）**、**MCP Server（`src/mcp_server.js`）** 与 **Agent Skill（`skills/lorecodex/SKILL.md`）**：

### 1. 在 DeepSeek Harness (`dsh`) 中一键安装插件
```bash
dsh plugin --profile web add "github:lena13144/lorecodex"
```
仓库内置 `cordis.patch.yml` 与 `dsh.bundle` 声明，加载后会自动通过 `ctx.tools.register` 向 DeepSeek Harness 注入全部 9 个三级树、毫秒级 Grep 与 LLM 建库工具。

### 2. 在 Claude Code / Antigravity / Cursor 中挂载 MCP Server
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

暴露的 9 个工具涵盖三种核心能力：
- **主 Agent 亲自翻书模式（6 个毫秒级原语，零额外旁路 API 消耗）**：`lorecodex_list_corpora`（含 `LLM_TOC` 覆盖率检测）、`lorecodex_list_series`、`lorecodex_list_arcs`、`lorecodex_expand_arc`、`lorecodex_grep_scenes`（毫秒级内存别名与客串扫描）、`lorecodex_read_scenes`（单次批量读取最多 10 幕无损原文）。
- **LLM 智能建库与宿主 Agent 原生写索引（2 个建库工具）**：
  - `lorecodex_build_corpus`（默认 `use_llm: true`，从本地 `.txt`/`.md`/`.epub`/`.json` 构建三级树或按分卷执行 `action: "upgrade"` 合成 LLM 目录摘要与人物别名表）；
  - `lorecodex_update_index_meta`（无需外部旁路 API Key，允许 Claude Code / DeepSeek Harness 等宿主 Agent 在阅读原文后直接将提炼好的分幕摘要、卷总览、人物别名组 `aliases` 与术语表 `glossary` 原地写回索引并热重载）。
- **子 Agent 上下文隔离蒸馏模式**：`lorecodex_ask_agent`（由独立子 Agent 翻完目录树后仅向主 Agent 返回浓缩导读、宏观大纲与证据原文，节省主 Agent 上下文窗口）。

---

## 酒馆插件功能与斜杠命令

- **角色卡一键绑定（`charBindings`）**：点击侧边栏书库旁的 **「绑角色」** 按钮，即可将当前书库、防剧透上限与视角绑定给当前角色卡；切换角色卡时自动切回专属书库与进度。
- **可视化防剧透按卷选择 & 徽章直达**：在大面板顶栏 **「酒馆设置」** 中可通过下拉框按章节/分卷选择防剧透进度（点击侧边栏的 `防剧透≤N` / `视角` 徽章可一步直达调整）。
- **上次注入摘要 & 轨迹直达**：侧边栏以极简单行胶囊显示最近一次检索命中幕数与耗时，点击展开命中的幕列表并可直达大面板回放完整翻书轨迹。
- **斜杠命令**：
  - `/loreui` — 在酒馆内打开内嵌典籍与轨迹工作台全屏浮层
  - `/lorecodex [on|off]` — 开关树检索
  - `/lorecorpus <corpus_id>` — 切换当前挂载书库
  - `/loreorder <n|off>` — 设置或解除防剧透章节序上限
  - `/lorepov <角色名>` — 设置当前检索视角（角色缺席事件自动标注转述/传闻）

---

## 进阶可选：独立 Node 服务端与 Python 命令行批量建树

如果你希望脱离酒馆单独在浏览器使用书阁工作台（`http://127.0.0.1:5240`）、绕过部分中转站的浏览器 CORS 跨域限制，或者将书库以文件形式保存在本地磁盘 `corpora/` 目录下供本地 MCP Server 与酒馆共同读写：

```bash
# 启动独立书阁 HTTP 服务（支持局域网访问可加 --host 0.0.0.0）：
node src/server.js

# 命令行离线切树（内置 MediaWiki/网页 JS/CSS 噪声清洗与结构体检；支持 --h1-is-volume / --strip-block / --allow-noisy）：
python3 builders/build_novel.py --input path/to/novel.txt --corpus-id my-novel --name "我的小说" --no-llm
python3 builders/build_novel.py --upgrade --corpus-id my-novel --series "第1卷" --workers 8

# 将 SillyTavern 世界书或 V2 角色卡并入同一棵树：
python3 builders/build_lore.py --input path/to/worldbook.json --corpus-id my-novel --merge-into corpora/my-novel --filter-game-stats
```

---

## 目录结构

```text
lorecodex/
├── manifest.json          # 仓库根清单（支持 SillyTavern / TauriTavern 通过 GitHub URL 一键安装扩展）
├── cordis.patch.yml       # DeepSeek Harness (dsh / @deepseek-ai/cordis) 插件挂载声明
├── extension/
│   └── st-tree-lore/      # 酒馆 & TauriTavern 纯前端扩展（默认免后台）
│       ├── index.js       # 扩展面板、生成前拦截注入、角色卡绑定与斜杠命令
│       ├── browser_engine.js # IndexedDB 纯前端引擎（TXT/GB18030/EPUB/JSON 解析、LLM 建库升级器、别名 Grep 与 Tree Agent）
│       ├── style.css      # 扩展抽屉与全屏浮层样式
│       └── ui/            # 内嵌同源书阁与轨迹工作台（免 5240 服务端直接运行）
├── src/
│   ├── dsh_plugin.js      # DeepSeek Harness (Cordis) 原生插件入口（自动注册 9 个工具）
│   ├── mcp_server.js      # 零依赖 MCP stdio JSON-RPC 2.0 服务端
│   ├── server.js          # 可选独立 HTTP 书阁服务与异步建树/升级任务调度
│   ├── corpus_manager.js  # 多语料发现、元数据管理与按需懒加载
│   ├── tree_agent.js      # Node 端三级目录树推理、原生思考捕获与多轮工具循环
│   ├── prompt_builder.js  # 基于 corpus.json 的动态提示词与工具 Schema 生成器
│   ├── grep_engine.js     # 内存毫秒级别名/客串感知 grep + 多语种正则扫描
│   ├── graph_engine.js    # 可选一跳实体关系图谱查询
│   └── utils.js           # 跨平台 Python 探测、富文本清洗与 order 门控工具
├── skills/
│   └── lorecodex/SKILL.md # 原生 AI Agent Skill 规范文件
├── ui/                    # 书阁阅览器与轨迹工作台前端源码（自动同步至 extension/st-tree-lore/ui/）
├── builders/              # Python 命令行 TXT / MD / EPUB / 世界书 / V2 角色卡建树与 --upgrade 升级器
├── corpora/
│   └── demo-chronicles/   # 开箱即用的《星港编年史》小说 + 世界书合并示例语料包
└── scripts/
    ├── build_releases.mjs # 自动化打包 4 个按需独立 Release 发行包
    └── verify.mjs         # 自动化离线与实测端到端验收脚本
```

---

## 自动化验收测试

```bash
# 零 API 密钥离线全量测试（覆盖 Python/浏览器双端 EPUB、GB18030 网文、V2 角色卡、Mock LLM 目录升级与断点续传、MCP 9 工具、DeepSeek Harness 插件、防剧透门控与毫秒级 Grep）：
npm test

# 构建 dist/releases/ 下的 4 个独立发行包：
npm run build:releases
```

---

## 为什么不用向量库，甚至连后台服务端都成了可选项？（迈入 Agent 时代的演进心路）

这个项目并不是一开始就打算“无向量、免后台”的——恰恰相反，我们完整走过了传统向量 RAG 的弯路，才看清了 Agent 时代记忆检索的真正形态：

1. **第一阶段：传统向量 RAG（切片 + Embedding + Rerank + 重型后台）**  
   最初面对数百万字的游戏解包剧情与长篇小说时，我们按照经典方案做了固定字数切块、向量化索引和重排。但放到长篇叙事与角色扮演场景下，很快暴露了三大硬伤：
   - **切块破坏叙事完整性**：原本脚本解包出来的是有头有尾的完整剧本，向量切块却把完整对白和剧情反转拦腰剁碎；
   - **指代、别名与时间线失明**：人物外号/代号、目录未署名的客串台词，以及“这十年发生了什么”的跨卷脉络，靠向量余弦相似度极易张冠李戴；
   - **基建绑架体验**：为了存几百兆的高维向量和跑 Embedding/Rerank，不得不逼着所有玩家在电脑上挂一个后台服务。
2. **第二阶段：目录树 + 向量兜底（看清真相的过渡期）**  
   受 PageIndex 启发，我们用 LLM 为整部作品提炼了三级目录树与人物别名表，配合毫秒级内存 `grep_scenes`，同时保留了向量检索作为兜底（fallback）。结果在真实运行的轨迹日志里，我们发现了一个极其扎心的事实：**面对确定性的层级目录树和 1 毫秒扫遍全书的别名 Grep，拥有原生推理能力的现代模型在 99.9% 的情况下压根连碰都不会去碰那个向量检索工具！** 那个耗费大量精力维护的向量层，完完全全是个零调用的冗余累赘。
3. **第三阶段：彻底拥抱 Agent 时代（无向量、零后台、解放模型原生推理）**  
   一旦一刀砍掉那个永远在吃灰的向量层，我们猛然意识到：剩下的核心资产——**LLM 提炼的三级目录树 (`tree_index.json`) + 完整无损场景原文 (`tree_texts.json`) + 内存毫秒级别名 Grep + 多轮工具调用循环**——全都是纯粹的 JSON 与内存字符串操作！
   - 既然如此，为什么还要让酒馆和手机玩家被一个 `127.0.0.1:5240` 的后台进程束缚？
   - 于是我们将整套建树器（含 GB18030 自动解码、浏览器原生 `.epub` 解压、并发 LLM 目录合成与断点续传）、毫秒级 Grep、多轮树推理 Agent 和书阁工作台 UI **100% 搬进了浏览器的 `IndexedDB` 纯前端引擎中**；同时在模型侧彻底拆掉“写死 `max_tokens`”、“禁用 `thinking`”、“首轮只准调一个工具”、“单次只准读一幕”等旧时代枷锁。
   - **把模型当成真正会思考的考据学者，只给它最干净的目录树与最锋利的放大镜，卸下一切不必要的基建包袱**——这就是 LoreCodex 在 Agent 时代交出的答案。

---

## 灵感来源与致谢

- **[PageIndex (VectifyAI)](https://github.com/VectifyAI/PageIndex)**：LoreCodex 的核心无向量树形渐进检索范式（让推理模型翻阅层级目录树而非依赖向量分块检索）深受 PageIndex 理念启发。在此基础上，本项目从零独立实现并面向长篇小说、游戏世界观、SillyTavern / TauriTavern 与原生 AI Agent 场景进行了深度扩展。
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** & **[TauriTavern](https://github.com/Darkatse/TauriTavern)**：感谢优秀的开源角色扮演前端生态与跨平台容器设计。
- **[DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness)**：感谢基于 Cordis 的模块化 Agent Harness 插件架构。

---

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
