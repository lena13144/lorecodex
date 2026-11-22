import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn, execFile, execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 5249;
const BASE = `http://127.0.0.1:${PORT}`;
const OFFLINE = process.argv.includes('--offline') || process.env.LORECODEX_OFFLINE === '1';

function detectPythonBin() {
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) return envBin;
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0 && String(res.stdout || '').trim() === '3') return cmd;
    } catch (_) {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_BIN = detectPythonBin();

async function waitForServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        return { health: await r.json(), ms: Date.now() - t0 };
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Server failed to become ready within ${timeoutMs}ms`);
}

async function getJson(urlPath, headers = {}) {
  const r = await fetch(`${BASE}${urlPath}`, { headers });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

async function postJson(urlPath, body, headers = {}) {
  const r = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

async function testEpubAndBuilders() {
  console.log('\n[1/9] Testing real-world EPUB, web-novel TXT, Character Card V2, and in-place LLM upgrade builders...');
  const tmpDir = path.join(ROOT, '.tmp-builder-test');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const epubPath = path.join(tmpDir, 'sample.epub');
  const outDir = path.join(tmpDir, 'out');

  const pyMaker = `
import urllib.parse, zipfile
epub_path = r"${epubPath.replace(/\\/g, '\\\\')}"
ch1_name = "第1章.xhtml"
ch1_href = urllib.parse.quote(ch1_name)
with zipfile.ZipFile(epub_path, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip")
    zf.writestr("META-INF/container.xml", '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>''')
    zf.writestr("OEBPS/content.opf", f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <manifest>
    <item id="ch1" href="{ch1_href}" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>''')
    zf.writestr("OEBPS/" + ch1_name, '''<html><body><h1>第一卷 星海篇</h1><h2>第1章 星海启航</h2><p>飞船穿过冰冷的星环，舰长按下启动钮。</p><p>引擎在深空中发出低吼。</p></body></html>''')
    zf.writestr("OEBPS/ch2.xhtml", '''<html><body><p class="chapter-title">第2章 沉默信号</p><p>次日清晨，雷达捕获了一段来自未知星系的旧时代频段。</p></body></html>''')
`;

  try {
    execFileSync(PYTHON_BIN, ['-c', pyMaker], { stdio: 'inherit' });
    execFileSync(
      PYTHON_BIN,
      [
        path.join(ROOT, 'builders', 'build_novel.py'),
        '--input',
        epubPath,
        '--corpus-id',
        'epub-smoke',
        '--name',
        'EPUB测试集',
        '--out-dir',
        outDir,
        '--min-chars',
        '20',
        '--no-llm',
      ],
      { stdio: 'inherit' }
    );

    const idx = JSON.parse(fs.readFileSync(path.join(outDir, 'epub-smoke', 'tree_index.json'), 'utf8'));
    const txt = JSON.parse(fs.readFileSync(path.join(outDir, 'epub-smoke', 'tree_texts.json'), 'utf8'));
    assert.strictEqual(idx.arcs.length, 2, 'EPUB with URL-encoded Chinese href & class=chapter-title should produce 2 chapters');
    assert.strictEqual(idx.arcs[0].series, '第一卷 星海篇');
    assert.strictEqual(idx.arcs[0].order, 1);
    assert.strictEqual(idx.arcs[1].order, 2);
    assert.strictEqual(idx.source, 'sample.epub', 'source field must not leak absolute path');
    const ch1Text = txt[idx.arcs[0].scenes[0].node_id].text;
    assert(ch1Text.includes('飞船穿过冰冷的星环'), 'EPUB ch1 text preserved');

    // Web-novel TXT real-world quirks: unspaced headers, pirate ads, glued prefix, chapter reset -> auto-volume, heuristic cast
    const webNovelPath = path.join(tmpDir, 'web_novel.txt');
    const chapBlocks = ['『测试小说/作者:夜雨』\n爱下电子书Txt版阅读 https://ixdzs8.com\n------章节内容开始-------'];
    for (let i = 1; i <= 10; i++) {
      chapBlocks.push(
        `第${i}章启程\n测试小说正文卷第${i}章启程清晨雾气慢慢散开。林墨说道：“第${i}次行动开始。”\n，测试小说\n苏夏问道：“情报确认好了吗？”\n`
      );
    }
    chapBlocks.push('第二卷，新大陆，敬请期待ing\n网页版章节内容慢，请下载爱阅小说app阅读最新内容');
    chapBlocks.push('第一章远航\n新大陆的港口响起汽笛，林墨站在甲板上望向地平线。');
    fs.writeFileSync(webNovelPath, chapBlocks.join('\n'), 'utf8');

    execFileSync(
      PYTHON_BIN,
      [
        path.join(ROOT, 'builders', 'build_novel.py'),
        '--input',
        webNovelPath,
        '--corpus-id',
        'web-novel-smoke',
        '--name',
        '测试小说',
        '--out-dir',
        outDir,
        '--min-chars',
        '20',
        '--no-llm',
      ],
      { stdio: 'inherit' }
    );
    const wnIdx = JSON.parse(fs.readFileSync(path.join(outDir, 'web-novel-smoke', 'tree_index.json'), 'utf8'));
    const wnTxt = JSON.parse(fs.readFileSync(path.join(outDir, 'web-novel-smoke', 'tree_texts.json'), 'utf8'));
    assert.strictEqual(wnIdx.arcs.length, 11, 'Web novel should parse 10 + 1 chapters');
    assert.strictEqual(wnIdx.arcs[0].series, '第1卷', 'Prior chapters auto-grouped into 第1卷 after Ch.1 reset');
    assert.strictEqual(wnIdx.arcs[10].series, '第2卷', 'Chapter reset creates 第2卷 while skipping teaser line');
    const wnCh1 = wnTxt[wnIdx.arcs[0].scenes[0].node_id].text;
    assert(wnCh1.startsWith('清晨雾气慢慢散开'), `Glued prefix must be stripped cleanly, got: ${wnCh1.slice(0, 40)}`);
    assert(!wnCh1.includes('爱下电子书') && !wnCh1.includes('正文卷'), 'Ad lines & glued markers removed');
    assert(wnIdx.arcs[0].characters.includes('林墨'), 'Offline heuristic cast extraction captures protagonist 林墨');

    // SillyTavern V2 Character Card character_book + disabled & CSS/macro filtering
    const cardPath = path.join(tmpDir, 'char_card_v2.json');
    fs.writeFileSync(
      cardPath,
      JSON.stringify({
        spec: 'chara_card_v2',
        data: {
          name: 'TestCard',
          character_book: {
            name: '白塔档案',
            entries: [
              { id: 1, comment: '白塔历史', enabled: true, key: ['白塔'], keysecondary: ['学院'], content: '北方眺望之高塔学院建于黄昏时代之前，分为魔法与龙之两大序列。' },
              { id: 2, comment: 'V2禁用废案', enabled: false, key: ['废案'], content: '这段是作者已关闭的 V2 废案条目，绝不应该被导入书库正文。' },
              { id: 3, comment: 'V1禁用草稿', disable: true, key: ['草稿'], content: '这段是带有 content 但 disable=true 的旧版关闭条目，也不应该导入。' },
              { id: 4, comment: 'UI状态栏样式', enabled: true, key: ['状态栏'], content: '<style>.hud{color:#fff;padding:8px}</style>{{setvar::hp::100}}{{getvar::mp}}' },
            ],
          },
        },
      }),
      'utf8'
    );
    execFileSync(
      PYTHON_BIN,
      [
        path.join(ROOT, 'builders', 'build_lore.py'),
        '--input',
        cardPath,
        '--corpus-id',
        'card-v2-smoke',
        '--name',
        'V2卡设定',
        '--out-dir',
        outDir,
        '--filter-game-stats',
        '--no-llm',
      ],
      { stdio: 'inherit' }
    );
    const cardIdx = JSON.parse(fs.readFileSync(path.join(outDir, 'card-v2-smoke', 'tree_index.json'), 'utf8'));
    const cardTxtStr = fs.readFileSync(path.join(outDir, 'card-v2-smoke', 'tree_texts.json'), 'utf8');
    assert.strictEqual(cardIdx.arcs.length, 1, 'Character Card V2 lore book extracted');
    assert(cardTxtStr.includes('北方眺望之高塔学院'), 'Enabled V2 character_book entry preserved');
    assert(!cardTxtStr.includes('V2禁用废案') && !cardTxtStr.includes('V1禁用草稿'), 'Disabled V1/V2 entries must be skipped');
    assert(!cardTxtStr.includes('.hud{color'), 'CSS/macro boilerplate filtered out cleanly');
    assert(cardIdx.arcs[0].characters.includes('白塔') && cardIdx.arcs[0].characters.includes('学院'), 'Secondary keys merged');

    // Mock OpenAI endpoint to verify in-place --upgrade, single-scene skip, ckpt caching, and series_meta extraction
    const mockCounts = { leaf: 0, arc: 0, seriesMeta: 0 };
    let expectedMaxTokens = undefined;
    const mockSrv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let content = '';
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            content = String(body?.messages?.[0]?.content || '');
          } catch (_) {}

          assert.strictEqual(body.thinking, undefined, 'Mock LLM requests should keep thinking enabled by default');
          assert.strictEqual(
            body.max_tokens,
            expectedMaxTokens,
            `Expected body.max_tokens=${expectedMaxTokens}, got ${body.max_tokens}`
          );

          let replyObj;
          if (content.includes('series_summary')) {
            mockCounts.seriesMeta += 1;
            const serMatch = content.match(/「([^」]+)」/);
            const serLabel = serMatch ? serMatch[1] : '本卷';
            replyObj = {
              series_summary: `${serLabel}LLM总览：白川澄与林夜在星环观测站追查异常波段。`,
              aliases: [['白川澄', '小澄', '澄博士']],
              glossary: [`${serLabel}星环观测站：记录星界异常波段的北境哨所`],
            };
          } else if (content.includes('子场景')) {
            mockCounts.arc += 1;
            replyObj = {
              description: '多幕章LLM汇总：白川澄在观测站校准信标并发现异常信号。',
              characters: ['白川澄', '林夜'],
              tone_tags: ['叙事/剧情'],
            };
          } else {
            mockCounts.leaf += 1;
            replyObj = {
              title: '观测站异动',
              summary: '白川澄在北境星环观测站校准旧历信标，记录到异常电波脉冲并联系林夜复核。',
              characters: ['白川澄', '林夜'],
              tone_tags: ['设定/档案'],
            };
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(replyObj) } }],
              usage: { prompt_tokens: 120, completion_tokens: 45 },
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });

    await new Promise((resolve) => mockSrv.listen(0, '127.0.0.1', resolve));
    try {
      const mockPort = mockSrv.address().port;
      const mockCfgPath = path.join(tmpDir, 'mock_llm_cfg.json');
      fs.writeFileSync(
        mockCfgPath,
        JSON.stringify({
          chatBase: `http://127.0.0.1:${mockPort}/v1`,
          chatKey: 'mock-key',
          chatModel: 'mock-flash',
        }),
        'utf8'
      );

      const segA = '北境的风雪拍打着观测站穹顶。'.repeat(60) + '白川澄记下第1组异常频段。';
      const segB = '深夜仪表盘突然闪烁蓝光。'.repeat(60) + '林夜推门走入记录室查看波形。';
      const upgBookPath = path.join(tmpDir, 'upgrade_sample.txt');
      fs.writeFileSync(
        upgBookPath,
        [
          '# 第1卷',
          '## 第1章 单幕序章',
          '清晨的观测站还很安静，白川澄独自整理着旧历电报档案，准备等待星环信号。',
          '## 第2章 双幕变局',
          segA,
          '***',
          segB,
          '# 第2卷',
          '## 第3章 新篇章',
          '第二卷开始时，南方的信使带回了新的星图拓本与密函，准备启程核对古碑坐标。',
        ].join('\n'),
        'utf8'
      );

      execFileSync(
        PYTHON_BIN,
        [
          path.join(ROOT, 'builders', 'build_novel.py'),
          '--input',
          upgBookPath,
          '--corpus-id',
          'llm-upgrade-smoke',
          '--name',
          '升级测试传',
          '--out-dir',
          outDir,
          '--min-chars',
          '200',
          '--target-chars',
          '900',
          '--max-chars',
          '1200',
          '--no-llm',
        ],
        { stdio: 'inherit' }
      );

      const preIdx = JSON.parse(fs.readFileSync(path.join(outDir, 'llm-upgrade-smoke', 'tree_index.json'), 'utf8'));
      assert.strictEqual(preIdx.arcs.length, 3);
      assert.strictEqual(preIdx.arcs[0].scenes.length, 1, 'Ch.1 must have 1 scene');
      assert.strictEqual(preIdx.arcs[1].scenes.length, 2, 'Ch.2 must have 2 scenes');
      assert.strictEqual(preIdx.arcs[2].scenes.length, 1, 'Ch.3 must have 1 scene');
      const ch3OfflineSummary = preIdx.arcs[2].scenes[0].summary;

      // Upgrade Vol 1 only: 3 leaf calls + 1 multi-scene arc call (Ch.1 single-scene skipped!) + 1 series_meta = 5
      await execFileAsync(PYTHON_BIN, [
        path.join(ROOT, 'builders', 'build_novel.py'),
        '--upgrade',
        '--corpus-id',
        'llm-upgrade-smoke',
        '--out-dir',
        outDir,
        '--config',
        mockCfgPath,
        '--series',
        '第1卷',
        '--workers',
        '2',
      ]);
      assert.deepStrictEqual(mockCounts, { leaf: 3, arc: 1, seriesMeta: 1 }, `Unexpected Vol 1 LLM call counts: ${JSON.stringify(mockCounts)}`);

      const midIdx = JSON.parse(fs.readFileSync(path.join(outDir, 'llm-upgrade-smoke', 'tree_index.json'), 'utf8'));
      const midCfg = JSON.parse(fs.readFileSync(path.join(outDir, 'llm-upgrade-smoke', 'corpus.json'), 'utf8'));
      assert(midIdx.series_summaries?.['第1卷']?.includes('LLM总览'), 'Vol 1 series_summary saved');
      assert.strictEqual(midIdx.stats.llm_scenes, 3);
      assert.strictEqual(midIdx.stats.llm_arcs, 2);
      assert.strictEqual(midIdx.arcs[2].scenes[0].summary, ch3OfflineSummary, 'Vol 2 Ch.3 must stay untouched after Vol 1 upgrade');
      assert(midCfg.aliases.some((g) => g.includes('白川澄') && g.includes('澄博士')), 'Aliases merged into corpus.json');
      assert(midCfg.glossary.some((g) => g.includes('星环观测站')), 'Glossary merged into corpus.json');

      // Upgrade full book with explicit --max-tokens: Vol 1 must hit ckpt; only Vol 2 (1 leaf + 1 seriesMeta) runs
      mockCounts.leaf = 0;
      mockCounts.arc = 0;
      mockCounts.seriesMeta = 0;
      expectedMaxTokens = 8192;
      await execFileAsync(PYTHON_BIN, [
        path.join(ROOT, 'builders', 'build_novel.py'),
        '--upgrade',
        '--corpus-id',
        'llm-upgrade-smoke',
        '--out-dir',
        outDir,
        '--config',
        mockCfgPath,
        '--workers',
        '2',
        '--max-tokens',
        '8192',
      ]);
      assert.deepStrictEqual(mockCounts, { leaf: 1, arc: 0, seriesMeta: 1 }, `Unexpected cached resume LLM counts: ${JSON.stringify(mockCounts)}`);

      const postIdx = JSON.parse(fs.readFileSync(path.join(outDir, 'llm-upgrade-smoke', 'tree_index.json'), 'utf8'));
      assert(postIdx.series_summaries?.['第1卷'] && postIdx.series_summaries?.['第2卷'], 'Both series summaries present');
      assert.strictEqual(postIdx.stats.llm_scenes, 4);
      assert.strictEqual(postIdx.stats.llm_arcs, 3);
    } finally {
      mockSrv.close();
    }

    console.log(`  PASS: EPUB, web-novel, Character Card V2, and in-place LLM --upgrade verified via ${PYTHON_BIN}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testHygieneAndSyntax() {
  console.log('\n[8/9] Checking secret hygiene, path hygiene, and JS syntax...');
  const badSecretHits = [];
  const badPrivacyHits = [];

  const keyPatterns = [
    new RegExp(['sk', 'sp', ''].join('-'), 'i'),
    new RegExp(['sk', 'dupx'].join('-'), 'i'),
    /sk-[A-Za-z0-9._-]{24,}/,
  ];
  const privacyPatterns = [
    ['D:', ['g', 'f', '2', '-work'].join('')].join('\\\\'),
    ['D:', ['g', 'f', '2', '-work'].join('')].join('/'),
    ['C:', 'Users', ''].join('\\\\'),
    ['C:', 'Users', ''].join('/'),
    ['D:', 'Games', 'SillyTavern'].join('\\\\'),
    ['D:', 'Games', 'SillyTavern'].join('/'),
    'Yut' + 'eng',
    '特列潘戈' + '夫斯克',
    '少女' + '前线',
  ].map((s) => s.toLowerCase());

  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name.startsWith('.tmp')) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (
        rel === 'config.json' ||
        /^builders\/migrate_.*\.mjs$/i.test(rel) ||
        (rel.startsWith('corpora/') && !rel.startsWith('corpora/demo-chronicles/'))
      ) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(js|mjs|py|json|html|css|md|txt|yml|yaml)$/i.test(ent.name)) {
        const content = fs.readFileSync(full, 'utf8');
        if (keyPatterns.some((re) => re.test(content))) {
          badSecretHits.push(rel);
        }
        const lower = content.toLowerCase();
        if (privacyPatterns.some((tok) => lower.includes(tok))) {
          badPrivacyHits.push(rel);
        }
      }
    }
  };
  walk(ROOT);

  assert.strictEqual(badSecretHits.length, 0, `Potential leaked API key found in: ${badSecretHits.join(', ')}`);
  assert.strictEqual(badPrivacyHits.length, 0, `Private path or identifier found in: ${badPrivacyHits.join(', ')}`);

  for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js'))) {
    execFileSync('node', ['--check', path.join(ROOT, 'src', f)], { stdio: 'inherit' });
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'ui', 'js')).filter((x) => x.endsWith('.js'))) {
    execFileSync('node', ['--check', path.join(ROOT, 'ui', 'js', f)], { stdio: 'inherit' });
  }

  const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.strictEqual(rootManifest.js, 'extension/st-tree-lore/index.js');
  assert.strictEqual(rootManifest.css, 'extension/st-tree-lore/style.css');
  assert(fs.existsSync(path.join(ROOT, rootManifest.js)), 'Root manifest.js target must exist');
  assert(fs.existsSync(path.join(ROOT, rootManifest.css)), 'Root manifest.css target must exist');

  const extDir = path.join(ROOT, 'extension', 'st-tree-lore');
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.js, 'index.js');
  assert.strictEqual(manifest.css, 'style.css');
  execFileSync('node', ['--check', path.join(extDir, 'index.js')], { stdio: 'inherit' });
  console.log('  PASS: zero leaked secrets/private paths & all JS modules syntax-verified');
}

async function main() {
  await testEpubAndBuilders();

  const cfgPath = path.join(ROOT, 'config.json');
  const cfgExistedBefore = fs.existsSync(cfgPath);

  const srvProc = spawn(
    'node',
    [
      path.join(ROOT, 'src', 'server.js'),
      '--tree-only',
      '--port',
      String(PORT),
      '--host',
      '127.0.0.1',
      '--corpora-dir',
      path.join(ROOT, 'corpora'),
      '--corpus',
      'demo-chronicles',
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderrBuf = '';
  srvProc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  try {
    console.log('\n[2/9] Testing cold boot (< 2000ms), corpus registry, static assets, and traversal guard...');
    const { health, ms } = await waitForServer(8000);
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.mode, 'tree-only');
    assert(health.boot_ms < 2000, `Cold boot too slow: ${health.boot_ms}ms`);

    const corporaRes = await getJson('/corpora');
    assert.strictEqual(corporaRes.status, 200);
    const ids = corporaRes.data.corpora.map((c) => c.id);
    assert(ids.includes('demo-chronicles'), 'demo-chronicles corpus must be registered');

    const uiIndex = await fetch(`${BASE}/`);
    assert.strictEqual(uiIndex.status, 200);
    const uiHtml = await uiIndex.text();
    assert(uiHtml.includes('/ui/js/main.js') && uiHtml.includes('/ui/styles.css'));

    const cssRes = await fetch(`${BASE}/ui/styles.css`);
    assert.strictEqual(cssRes.status, 200);
    assert(cssRes.headers.get('content-type')?.includes('text/css'));

    for (const jsFile of ['api.js', 'state.js', 'toc.js', 'reader.js', 'trace.js', 'modals.js', 'main.js']) {
      const jsRes = await fetch(`${BASE}/ui/js/${jsFile}`);
      assert.strictEqual(jsRes.status, 200, `/ui/js/${jsFile} should serve 200`);
      assert(jsRes.headers.get('content-type')?.includes('application/javascript'), `/ui/js/${jsFile} MIME`);
    }

    const trav1 = await fetch(`${BASE}/ui/../../config.json`);
    assert([403, 404].includes(trav1.status), `Traversal 1 must be blocked, got ${trav1.status}`);
    const trav2 = await fetch(`${BASE}/ui/%2e%2e/config.json`);
    assert([403, 404].includes(trav2.status), `Traversal 2 must be blocked, got ${trav2.status}`);
    console.log(`  PASS: ready in ${ms}ms (boot_ms=${health.boot_ms}ms), modular UI assets & path traversal guard OK`);

    console.log('\n[3/9] Testing origin protection & custom-baseUrl API key guard...');
    const modelsBlocked = await postJson('/models', { baseUrl: 'https://evil.example/v1' });
    assert.strictEqual(modelsBlocked.status, 400, 'POST /models with custom baseUrl without apiKey must return 400');

    const cfgOriginBlocked = await postJson('/config', {}, { Origin: 'https://evil.example' });
    assert.strictEqual(cfgOriginBlocked.status, 403, 'POST /config from foreign origin must return 403');

    const impOriginBlocked = await postJson('/corpora/import', { kind: 'novel', corpusId: 'x' }, { Origin: 'https://evil.example' });
    assert.strictEqual(impOriginBlocked.status, 403, 'POST /corpora/import from foreign origin must return 403');

    const upgOriginBlocked = await postJson('/corpora/demo-chronicles/upgrade', { series: '' }, { Origin: 'https://evil.example' });
    assert.strictEqual(upgOriginBlocked.status, 403, 'POST /corpora/:id/upgrade from foreign origin must return 403');

    const cfgLocalOk = await postJson('/config', {}, { Origin: BASE });
    assert.strictEqual(cfgLocalOk.status, 200, 'POST /config from localhost origin must succeed');

    const cfgLanOk = await postJson('/config', {}, { Origin: 'http://192.168.1.88:8000' });
    assert.strictEqual(cfgLanOk.status, 200, 'POST /config from LAN mobile origin must succeed');

    const cfgTailscaleOk = await postJson('/config', {}, { Origin: 'http://100.90.12.34:8000' });
    assert.strictEqual(cfgTailscaleOk.status, 200, 'POST /config from Tailscale LAN origin must succeed');
    console.log('  PASS: cross-origin write guard (LAN allowed, foreign blocked) & API key exfiltration guard verified');

    console.log('\n[4/9] Testing online corpus config update & reload...');
    const origDetail = await getJson('/corpora/demo-chronicles');
    const origDesc = origDetail.data.config.description;
    const patchRes = await postJson('/corpora/demo-chronicles/config', {
      description: origDesc + ' [online-patched]',
    });
    assert.strictEqual(patchRes.status, 200);
    assert(patchRes.data.corpus.description.includes('[online-patched]'));
    const restoreRes = await postJson('/corpora/demo-chronicles/config', { description: origDesc });
    assert.strictEqual(restoreRes.status, 200);
    assert.strictEqual(restoreRes.data.corpus.description, origDesc);
    console.log('  PASS: POST /corpora/:id/config persisted, invalidated cache, and restored');

    console.log('\n[5/9] Testing web drag-upload import & build job (/corpora/import -> /jobs/:id)...');
    const tmpCorpusId = 'tmp-web-upload';
    const tmpCorpusDir = path.join(ROOT, 'corpora', tmpCorpusId);
    fs.rmSync(tmpCorpusDir, { recursive: true, force: true });
    try {
      const sampleTxt = '# 第一卷 晨曦测试\n\n## 第1章 云海飞舟\n清晨的云海被晨曦染成金红色，领航员白昼打开了星图罗盘，找到了隐藏在悬崖下的古代信标。\n';
      const impRes = await postJson('/corpora/import', {
        kind: 'novel',
        corpusId: tmpCorpusId,
        name: '云海测试传',
        filename: 'cloud_test.txt',
        contentBase64: Buffer.from(sampleTxt, 'utf8').toString('base64'),
        category: '正文',
        useLlm: false,
      });
      assert.strictEqual(impRes.status, 202);
      const jobId = impRes.data.job.id;
      let job = impRes.data.job;
      for (let i = 0; i < 40 && job.status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        job = (await getJson(`/jobs/${jobId}`)).data.job;
      }
      assert.strictEqual(job.status, 'done', `Import job failed: ${job.error} | ${job.logs.join('\n')}`);

      const listAfter = await getJson('/corpora');
      assert(listAfter.data.corpora.some((c) => c.id === tmpCorpusId), 'Imported corpus must appear in /corpora');
      const grepImported = await getJson(`/tree-grep?corpus=${tmpCorpusId}&q=${encodeURIComponent('星图罗盘')}`);
      assert(grepImported.data.total >= 1, 'Imported corpus must be searchable via /tree-grep');
      console.log(`  PASS: uploaded & built "${tmpCorpusId}" via job ${jobId} cleanly`);
    } finally {
      fs.rmSync(tmpCorpusDir, { recursive: true, force: true });
      await postJson('/corpora/reload', {});
    }

    console.log('\n[6/9] Testing deterministic spoiler gate (maxOrder)...');
    const fullDemoIdx = await getJson('/tree-index?corpus=demo-chronicles');
    const ch5Arc = fullDemoIdx.data.arcs.find((a) => a.order === 5);
    assert(ch5Arc, 'Ch.5 arc exists in unfiltered index');
    const ch5Node = ch5Arc.scenes[0].node_id;

    const gatedIdx = await getJson('/tree-index?corpus=demo-chronicles&maxOrder=3');
    assert.strictEqual(gatedIdx.status, 200);
    assert(gatedIdx.data.arcs.every((a) => a.order === null || a.order <= 3), 'No arc > maxOrder=3');
    assert(gatedIdx.data.arcs.some((a) => a.order === null && a.category === '档案设定'), 'Timeless lore preserved when maxOrder=3');
    assert.strictEqual(gatedIdx.data.arcs.length, 4, '3 story chapters + 1 lore arc visible');

    const grepLocked = await getJson('/tree-grep?corpus=demo-chronicles&q=' + encodeURIComponent('苍穹之心') + '&maxOrder=3');
    assert.strictEqual(grepLocked.data.total, 0, 'Spoiler term must yield 0 hits when maxOrder=3');

    const grepUnlocked = await getJson('/tree-grep?corpus=demo-chronicles&q=' + encodeURIComponent('苍穹之心') + '&maxOrder=6');
    assert(grepUnlocked.data.total >= 1, 'Spoiler term must hit when maxOrder=6');

    const sceneLocked = await getJson(`/tree-scene?corpus=demo-chronicles&id=${ch5Node}&maxOrder=3`);
    assert.strictEqual(sceneLocked.status, 403, 'Direct scene fetch > maxOrder must return HTTP 403');
    assert.strictEqual(sceneLocked.data.blocked, true);

    const sceneUnlocked = await getJson(`/tree-scene?corpus=demo-chronicles&id=${ch5Node}&maxOrder=6`);
    assert.strictEqual(sceneUnlocked.status, 200);
    console.log('  PASS: spoiler gate strictly enforced across index, grep, and scene endpoints');

    console.log('\n[7/9] Testing millisecond alias & cameo grep (demo-chronicles)...');
    const gAliasDemo = await getJson('/tree-grep?corpus=demo-chronicles&q=Zero-7');
    assert(gAliasDemo.data.total >= 2, 'Zero-7 hits Ch.1 & Ch.4');
    assert(gAliasDemo.data.took_ms < 50);

    const gCameoDemo = await getJson('/tree-grep?corpus=demo-chronicles&q=' + encodeURIComponent('卡伦'));
    assert(gCameoDemo.data.total >= 1);
    assert.strictEqual(gCameoDemo.data.hits[0].cameo, true, '卡伦 must be detected as cameo');
    console.log(`  PASS: demo-chronicles Zero-7=${gAliasDemo.data.took_ms}ms/${gAliasDemo.data.total} hits, cameo=${gCameoDemo.data.hits[0].cameo}`);

    testHygieneAndSyntax();

    console.log('\n[9/9] Checking live LLM regression eligibility (demo-chronicles)...');
    const liveCfg = (await getJson('/config')).data || {};
    const hasLiveKey = liveCfg.chatKey === '***';
    if (OFFLINE || !hasLiveKey) {
      console.log(`  [SKIP] Live LLM checks skipped (${OFFLINE ? '--offline mode' : 'no chatKey configured'})`);
    } else {
      const demo_1 = await postJson('/tree-search', {
        corpus: 'demo-chronicles',
        maxOrder: 3,
        query: '苏璃的真正身份和苍穹之心是什么？',
        sceneAnchor: { charName: '灰烬星港', userName: '旅人' },
        maxScenes: 0,
      });
      assert.strictEqual(demo_1.status, 200);
      assert(
        (demo_1.data.scenes || []).every((s) => s.order === null || s.order <= 3),
        'Demo #1 must never return scenes with order > 3'
      );
      assert(
        !String(demo_1.data.guide || '').includes('初代星门守望者'),
        `Demo #1 guide leaked spoiler: ${demo_1.data.guide}`
      );
      console.log(`  PASS Demo #1 (Spoiler Gate order<=3): skip=${demo_1.data.skip}, scenes=${demo_1.data.scenes.length}, took=${demo_1.data.took_ms}ms`);

      const demo_2 = await postJson('/tree-search', {
        corpus: 'demo-chronicles',
        maxOrder: 6,
        onDemand: '苏璃的真正身份以及银鸢号推进器参数',
        query: '苏璃的真正身份以及银鸢号推进器参数',
        sceneAnchor: { charName: '灰烬星港', userName: '旅人' },
        maxScenes: 0,
      });
      assert.strictEqual(demo_2.status, 200);
      assert.strictEqual(demo_2.data.skip, false, 'Demo #2 must not skip');
      const hitStory = demo_2.data.scenes.some((s) => s.order === 5 || s.text.includes('初代星门守望者'));
      const hitLore = demo_2.data.scenes.some((s) => s.category === '档案设定' || s.text.includes('风神-IV型'));
      assert(hitStory, 'Demo #2 should retrieve Ch.5 secret reveal');
      assert(hitLore, 'Demo #2 should retrieve merged worldbook thruster specs');
      console.log(`  PASS Demo #2 (Unlocked + Merged Lore): ${demo_2.data.scenes.length} scenes in ${demo_2.data.took_ms}ms`);
    }

    console.log(`\nALL LORECODEX VERIFICATION CHECKS PASSED! (${OFFLINE ? 'offline' : 'full'})`);
  } finally {
    srvProc.kill();
    if (!cfgExistedBefore && fs.existsSync(cfgPath)) {
      try {
        fs.unlinkSync(cfgPath);
      } catch (_) {}
    }
    if (stderrBuf.trim()) {
      console.log('\n[Server stderr]:\n' + stderrBuf.trim());
    }
  }
}

main().catch((err) => {
  console.error('\nVERIFICATION FAILED:', err);
  process.exit(1);
});
