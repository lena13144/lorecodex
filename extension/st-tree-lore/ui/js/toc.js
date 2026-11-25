import {
  $,
  esc,
  fmtChars,
  state,
  actions,
  corpusName,
  getMarks,
  expandSearchAliases,
  expandGrepQueryTerms,
  highlightEscapedText,
} from './state.js';
import { fetchGrep } from './api.js';

let grepTimer = null;
let grepSeq = 0;
let tocListWired = false;

function ensureTocDelegation() {
  if (tocListWired) return;
  const listEl = $('#tocList');
  if (!listEl) return;
  tocListWired = true;
  listEl.addEventListener('click', (e) => {
    const sceneEl = e.target.closest('.toc-scene');
    if (sceneEl && listEl.contains(sceneEl)) {
      e.stopPropagation();
      actions.openScene?.(sceneEl.dataset.nid, sceneEl.dataset.aid);
      return;
    }
    const seriesHead = e.target.closest('.series-head');
    if (seriesHead && listEl.contains(seriesHead)) {
      const grp = seriesHead.closest('.series-group');
      const ser = grp?.dataset.series;
      if (ser !== undefined) {
        if (state.collapsedSeries.has(ser)) state.collapsedSeries.delete(ser);
        else state.collapsedSeries.add(ser);
        renderToc();
      }
      return;
    }
    if (state.searchMode === 'grep') {
      const entry = e.target.closest('.arc-entry');
      if (entry && listEl.contains(entry) && entry.dataset.nid) {
        const q = state.searchTerm.trim();
        const terms = state.grepTerms.length ? state.grepTerms : expandGrepQueryTerms(q);
        actions.openScene?.(entry.dataset.nid, entry.dataset.aid, { highlightTerms: terms });
      }
      return;
    }
    const arcRow = e.target.closest('.arc-row');
    if (arcRow && listEl.contains(arcRow)) {
      const aid = arcRow.closest('.arc-entry')?.dataset.aid;
      if (aid) actions.openArc?.(aid);
    }
  });
}

export function renderFilters() {
  const arcs = state.index?.arcs || [];
  const cats = ['全部', ...new Set(arcs.map((a) => a.category).filter(Boolean))];
  if (!cats.includes(state.category)) state.category = '全部';

  $('#catBar').innerHTML = cats
    .map((c) => {
      const cnt = c === '全部' ? arcs.length : arcs.filter((a) => a.category === c).length;
      return `<span class="cat-chip ${state.category === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} ${cnt}</span>`;
    })
    .join('');

  $('#catBar')
    .querySelectorAll('.cat-chip')
    .forEach((el) => {
      el.addEventListener('click', () => {
        state.category = el.dataset.cat;
        renderFilters();
        if (state.searchMode === 'grep') triggerGrep();
        else renderToc();
      });
    });

  const toneSet = new Set();
  for (const a of arcs) {
    for (const t of a.tone_tags || []) toneSet.add(t);
    for (const s of a.scenes || []) for (const t of s.tone_tags || []) toneSet.add(t);
  }
  const tones = ['全部', ...toneSet];
  if (!tones.includes(state.tone)) state.tone = '全部';

  if (tones.length > 1) {
    $('#toneBar').style.display = 'flex';
    $('#toneBar').innerHTML = tones
      .map((t) => `<span class="tone-chip ${state.tone === t ? 'active' : ''}" data-tone="${esc(t)}">${esc(t)}</span>`)
      .join('');
    $('#toneBar')
      .querySelectorAll('.tone-chip')
      .forEach((el) => {
        el.addEventListener('click', () => {
          state.tone = el.dataset.tone;
          renderFilters();
          if (state.searchMode === 'grep') triggerGrep();
          else renderToc();
        });
      });
  } else {
    $('#toneBar').style.display = 'none';
    $('#toneBar').innerHTML = '';
  }
}

function renderArcCard(a, { listed, expanded, read, selected, selectedArcs, readArcs }) {
  const isSel = selectedArcs.has(a.arc_id);
  const isRead = readArcs.has(a.arc_id);
  const isExp = expanded.has(a.arc_id);
  const isList = listed.has(a.arc_id);
  const markCls = isSel ? 'mark-selected' : isRead ? 'mark-read' : isExp ? 'mark-expanded' : isList ? 'mark-listed' : '';
  const isViewing = state.view.arcId === a.arc_id;
  const open = isViewing || isSel || isRead || isExp;

  let stamp = '';
  if (isSel) stamp = '<span class="stamp sel">入选</span>';
  else if (isRead) stamp = '<span class="stamp read">已阅</span>';
  else if (isExp) stamp = '<span class="stamp exp">翻幕</span>';
  else if (isList) stamp = '<span class="stamp list">候补</span>';

  const ordBadge = a.order !== null && a.order !== undefined ? `<span class="tone-pill">序${esc(a.order)}</span>` : '';
  const tones = (a.tone_tags || [])
    .slice(0, 2)
    .map((t) => `<span class="tone-pill">${esc(t)}</span>`)
    .join('');

  const scenesList = a.scenes || [];
  const scenesBlock = open
    ? `<div class="toc-scenes">${scenesList
        .map((s) => {
          const sSel = selected.has(s.node_id);
          const sRead = read.has(s.node_id);
          const scCls = sSel ? 'mark-selected' : sRead ? 'mark-read' : '';
          return `<div class="toc-scene ${scCls} ${state.view.nodeId === s.node_id ? 'viewing' : ''}" data-nid="${esc(s.node_id)}" data-aid="${esc(a.arc_id)}">
        <span class="toc-scene-t" title="${esc(s.title)}">${esc(s.node_id)} · ${esc(s.title || s.group_title)}</span>
        <span class="toc-scene-c">${Number(s.chars) || 0}</span>
      </div>`;
        })
        .join('')}</div>`
    : '';

  return `<div class="arc-entry ${markCls} ${open ? 'open' : ''} ${isViewing ? 'viewing' : ''}" data-aid="${esc(a.arc_id)}">
    <div class="arc-row">
      <div class="arc-line1">
        <span class="arc-name">${esc(a.title)}</span>
        <span class="arc-no">${esc(a.arc_id)}</span>
      </div>
      <div class="arc-line2">
        <span>${esc(a.category)} · ${scenesList.length} 幕 · ${(Number(a.total_chars) || 0).toLocaleString()} 字</span>
        <span style="display:flex;gap:3px;align-items:center;">${ordBadge}${tones}${stamp}</span>
      </div>
    </div>
    ${scenesBlock}
  </div>`;
}

export function renderToc() {
  if (!state.index) return;
  ensureTocDelegation();
  const traceLegend = $('#tocTraceLegend');
  if (traceLegend) {
    traceLegend.style.display = state.activeRunData ? 'flex' : 'none';
  }
  if (state.searchMode === 'grep') {
    renderGrepToc();
    return;
  }

  const marks = getMarks();
  const { listed, expanded, read, selected } = marks;
  const terms = expandSearchAliases(state.searchTerm);
  const aliasBox = $('#aliasNote');
  if (terms.length > 1) {
    aliasBox.style.display = 'block';
    aliasBox.textContent = `同义别名展开：${terms.join(' / ')}`;
  } else {
    aliasBox.style.display = 'none';
  }

  const selectedArcs = new Set([...selected].map((nid) => state.sceneMap.get(nid)?.arc_id).filter(Boolean));
  const readArcs = new Set([...read].map((nid) => state.sceneMap.get(nid)?.arc_id).filter(Boolean));

  const arcs = (state.index.arcs || []).filter((a) => {
    if (state.category !== '全部' && a.category !== state.category) return false;
    if (state.tone !== '全部') {
      const arcHit = (a.tone_tags || []).includes(state.tone);
      const scHit = (a.scenes || []).some((s) => (s.tone_tags || []).includes(state.tone));
      if (!arcHit && !scHit) return false;
    }
    const touched =
      selectedArcs.has(a.arc_id) || readArcs.has(a.arc_id) || expanded.has(a.arc_id) || listed.has(a.arc_id);
    if (state.onlyPath && !touched) return false;
    if (!terms.length) return true;
    const hay = [
      a.arc_id,
      a.arc_key,
      a.series,
      a.title,
      a.description,
      ...(a.characters || []),
      ...(a.key_items || []),
      ...(a.tone_tags || []),
      ...(a.scenes || []).flatMap((s) => [s.node_id, s.group, s.group_title, s.title, s.summary]),
    ]
      .join(' ')
      .toLowerCase();
    return terms.some((t) => hay.includes(t));
  });

  $('#tocCount').textContent = `${arcs.length} / ${state.index.arcs.length} 卷${state.maxOrder > 0 ? `（序 <= ${state.maxOrder}）` : ''}`;

  if (!arcs.length) {
    $('#seriesExpandBtns').style.display = 'none';
    $('#tocList').innerHTML = `<div style="padding:28px 12px;text-align:center;color:var(--ink-muted);font-size:12px;">目录中暂无匹配篇章</div>`;
    return;
  }

  const seriesBuckets = new Map();
  for (const a of arcs) {
    const sk = String(a.series || a.category || '默认分卷').trim();
    if (!seriesBuckets.has(sk)) seriesBuckets.set(sk, []);
    seriesBuckets.get(sk).push(a);
  }

  const showSeriesTree = seriesBuckets.size >= 2;
  $('#seriesExpandBtns').style.display = showSeriesTree ? 'flex' : 'none';

  const cardCtx = { listed, expanded, read, selected, selectedArcs, readArcs };

  if (!showSeriesTree) {
    $('#tocList').innerHTML = arcs.map((a) => renderArcCard(a, cardCtx)).join('');
  } else {
    const forceExpand = Boolean(terms.length || state.onlyPath);
    $('#tocList').innerHTML = [...seriesBuckets.entries()]
      .map(([serName, serArcs]) => {
        const hasViewing = serArcs.some((a) => a.arc_id === state.view.arcId);
        const isCollapsed = !forceExpand && !hasViewing && state.collapsedSeries.has(serName);
        const totalSc = serArcs.reduce((acc, x) => acc + (x.scenes || []).length, 0);
        return `<div class="series-group ${isCollapsed ? 'collapsed' : ''}" data-series="${esc(serName)}">
          <div class="series-head">
            <span>${isCollapsed ? '▸' : '▾'} ${esc(serName)}</span>
            <span class="series-meta">${serArcs.length}卷 · ${totalSc}幕</span>
          </div>
          <div class="series-body">
            ${isCollapsed ? '' : serArcs.map((a) => renderArcCard(a, cardCtx)).join('')}
          </div>
        </div>`;
      })
      .join('');
  }
}

export function renderGrepToc() {
  ensureTocDelegation();
  const q = state.searchTerm.trim();
  const st = state.index?.stats || {};
  $('#seriesExpandBtns').style.display = 'none';
  $('#aliasNote').style.display = 'none';

  if (!q) {
    $('#tocCount').textContent = `全文检索就绪（${fmtChars(st.total_chars || 0)}）`;
    $('#tocList').innerHTML = `<div style="padding:26px 12px;text-align:center;color:var(--ink-muted);font-size:12px;line-height:1.7;">
      输入人物名、别称或任意一句原著台词，将在毫秒内扫描《${esc(corpusName())}》当前可见 ${Number(st.scenes) || 0} 幕正文（支持上方分类/氛围筛选与客串发现）。
    </div>`;
    return;
  }

  const d = state.grepData;
  if (!d) {
    $('#tocCount').textContent = '正在扫描全本正文...';
    return;
  }

  const terms = state.grepTerms.length ? state.grepTerms : expandGrepQueryTerms(q);
  if (terms.length > 1) {
    $('#aliasNote').style.display = 'block';
    $('#aliasNote').textContent = `展开扫描词：${terms.slice(0, 8).join(' / ')}`;
  }

  $('#tocCount').textContent = `命中 ${Number(d.total) || 0} 幕（客串 ${Number(d.cameo_count) || 0} 幕 · ${Number(d.took_ms) || 0}ms）`;
  const hits = d.hits || [];
  if (!hits.length) {
    $('#tocList').innerHTML = `<div style="padding:26px 12px;text-align:center;color:var(--ink-muted);font-size:12px;">当前筛选范围内未找到「${esc(q)}」</div>`;
    return;
  }

  $('#tocList').innerHTML = hits
    .map(
      (h) => `
    <div class="arc-entry ${h.cameo ? 'mark-expanded' : 'mark-read'} ${state.view.nodeId === h.node_id ? 'viewing' : ''}" data-nid="${esc(h.node_id)}" data-aid="${esc(h.arc_id)}">
      <div class="arc-row">
        <div class="arc-line1">
          <span class="arc-name">${highlightEscapedText(h.title, terms)}</span>
          <span class="arc-no">${esc(h.node_id)}</span>
        </div>
        <div class="arc-line2">
          <span>${esc(h.arc_title)}</span>
          <span>${h.cameo ? '<span class="stamp exp">客串</span>' : ''} ${Number(h.match_count) || 0}处</span>
        </div>
        <div style="font-size:11.5px;color:var(--ink-soft);line-height:1.55;margin-top:3px;">${highlightEscapedText(h.snippet, terms)}</div>
      </div>
    </div>
  `
    )
    .join('');
}

export async function triggerGrep() {
  const q = state.searchTerm.trim();
  if (!q) {
    ++grepSeq;
    state.grepData = null;
    state.grepTerms = [];
    renderToc();
    return;
  }
  const seq = ++grepSeq;
  const reqCorpusId = state.corpusId;
  state.grepTerms = expandGrepQueryTerms(q);
  try {
    const data = await fetchGrep(reqCorpusId, {
      q,
      limit: 40,
      category: state.category,
      tone: state.tone,
      maxOrder: state.maxOrder,
    });
    if (seq !== grepSeq || state.corpusId !== reqCorpusId) return;
    state.grepData = data;
    if (state.searchMode === 'grep') renderToc();
  } catch (e) {
    if (seq !== grepSeq || state.corpusId !== reqCorpusId) return;
    state.grepData = null;
    if (state.searchMode === 'grep') {
      $('#seriesExpandBtns').style.display = 'none';
      $('#aliasNote').style.display = 'none';
      $('#tocCount').textContent = '全文检索失败';
      $('#tocList').innerHTML = `<div style="padding:26px 12px;text-align:center;color:var(--seal);font-size:12px;">全文扫描失败：${esc(e?.message || String(e))}</div>`;
    }
  }
}

export function scheduleGrep() {
  clearTimeout(grepTimer);
  grepTimer = setTimeout(triggerGrep, 180);
}
