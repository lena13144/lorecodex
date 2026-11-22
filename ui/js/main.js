import { $, $$, esc, fmtChars, prefs, savePrefs, applyPrefs, state, actions, corpusName } from './state.js';
import { fetchHealth, fetchCorpora, reloadCorpora, fetchTreeIndex } from './api.js';
import { renderFilters, renderToc, triggerGrep, scheduleGrep } from './toc.js';
import {
  initReaderScroll,
  setStageTab,
  openCover,
  openArc,
  openScene,
  openArcRead,
  navigateSceneDelta,
  renderStage,
} from './reader.js';
import { renderPresets, renderTrace, renderRunsList, pollRuns, executeSearch } from './trace.js';
import {
  closeModal,
  openSettingsModal,
  openCorpusModal,
  openImportModal,
  openCommandPalette,
} from './modals.js';

function renderCorpusSelect() {
  const sel = $('#corpusSelect');
  sel.innerHTML = state.corpora
    .map(
      (c) =>
        `<option value="${esc(c.id)}" ${c.id === state.corpusId ? 'selected' : ''}>${esc(c.name)} (${c.stats.arcs}卷)</option>`
    )
    .join('');
}

async function loadCorpusIndex(cid) {
  const idx = await fetchTreeIndex(cid, state.maxOrder);
  state.index = idx;
  state.arcMap.clear();
  state.sceneMap.clear();
  for (const a of idx.arcs || []) {
    state.arcMap.set(a.arc_id, a);
    for (const s of a.scenes || []) {
      state.sceneMap.set(s.node_id, { ...s, arc_id: a.arc_id, arc_title: a.title });
    }
  }
  const st = idx.stats || {};
  $('#brandTitle').querySelector('span').textContent = `LoreCodex · ${corpusName()}`;
  document.title = `${corpusName()} — LoreCodex 工作台`;
  $('#statMeta').textContent = `全录 ${st.arcs || 0} 卷 · ${st.scenes || 0} 幕 · ${fmtChars(st.total_chars || 0)} · 模型 ${state.modelName}`;

  const sg = idx.corpus?.spoiler_gate || {};
  const maxAvailable = st.max_order || state.corpusMeta?.stats?.max_order || 0;
  const bar = $('#spoilerBar');
  if (maxAvailable > 0 || sg.enabled) {
    bar.classList.add('visible');
    $('#spoilerLabel').textContent = `${sg.order_label || '章节进度'}上限 (0=全开${maxAvailable ? ', 全' + maxAvailable : ''})`;
  } else {
    bar.classList.remove('visible');
  }

  if ((idx.arcs || []).length > 100 && state.collapsedSeries.size === 0) {
    const seriesNames = [];
    for (const a of idx.arcs || []) {
      const sk = String(a.series || a.category || '默认分卷').trim();
      if (!seriesNames.includes(sk)) seriesNames.push(sk);
    }
    if (seriesNames.length >= 2) {
      for (const sk of seriesNames.slice(1)) state.collapsedSeries.add(sk);
    }
  }

  renderFilters();
  renderToc();
  renderStage();
}

async function setMaxOrder(val, { reloadIndex = true } = {}) {
  const n = Math.max(0, Math.floor(Number(val) || 0));
  state.maxOrder = n;
  $('#tocMaxOrder').value = n;
  $('#qMaxOrder').value = n;
  if (reloadIndex && state.corpusId) {
    await loadCorpusIndex(state.corpusId);
    if (state.searchMode === 'grep' && state.searchTerm.trim()) await triggerGrep();
  }
}

async function switchCorpus(cid, { keepRun = false } = {}) {
  state.corpusId = cid;
  state.corpusMeta = state.corpora.find((c) => c.id === cid) || null;
  state.category = '全部';
  state.tone = '全部';
  state.grepData = null;
  state.grepTerms = [];
  state.highlightTerms = [];
  state.collapsedSeries.clear();
  state.view = { type: 'cover', arcId: null, nodeId: null };
  if (!keepRun) {
    state.activeRunId = null;
    state.activeRunData = null;
  }

  const sg = state.corpusMeta?.spoiler_gate || {};
  const defOrder = sg.enabled && sg.default_max_order ? Number(sg.default_max_order) : 0;
  state.maxOrder = defOrder;
  $('#tocMaxOrder').value = defOrder;
  $('#qMaxOrder').value = defOrder;
  $('#qChar').value = state.corpusMeta?.ui?.default_char ?? '';
  $('#qUser').value = state.corpusMeta?.ui?.default_user ?? '旅人';
  $('#qMaxScenes').value = 0;

  renderCorpusSelect();
  await loadCorpusIndex(cid);
  renderPresets();
}

function setupResizer(resizerEl, side) {
  if (!resizerEl) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;

  resizerEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = side === 'left' ? prefs.tocWidth : prefs.traceWidth;
    resizerEl.classList.add('active');
    document.body.classList.add('resizing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (side === 'left') {
      prefs.tocWidth = Math.min(540, Math.max(240, startW + dx));
      document.documentElement.style.setProperty('--toc-width', `${prefs.tocWidth}px`);
    } else {
      prefs.traceWidth = Math.min(640, Math.max(300, startW - dx));
      document.documentElement.style.setProperty('--trace-width', `${prefs.traceWidth}px`);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizerEl.classList.remove('active');
    document.body.classList.remove('resizing');
    savePrefs();
  });

  resizerEl.addEventListener('dblclick', () => {
    if (side === 'left') prefs.tocWidth = 328;
    else prefs.traceWidth = 430;
    applyPrefs();
    savePrefs();
  });
}

function setMobilePane(pane) {
  const next = pane === 'toc' || pane === 'trace' ? pane : 'stage';
  document.body.dataset.mobilePane = next;
  $$('[data-mobile-pane]').forEach((b) => b.classList.toggle('active', b.dataset.mobilePane === next));
}

function refreshModelMeta() {
  const st = state.index?.stats || {};
  if (state.index) {
    $('#statMeta').textContent = `全录 ${st.arcs || 0} 卷 · ${st.scenes || 0} 幕 · ${fmtChars(st.total_chars || 0)} · 模型 ${state.modelName}`;
  }
  if (state.stageMode === 'book' && state.view.type === 'cover') {
    renderStage();
  }
}

// Register cross-module actions
Object.assign(actions, {
  renderFilters,
  renderToc,
  setStageTab,
  setMobilePane,
  openCover,
  openArc,
  openScene,
  openArcRead,
  setMaxOrder,
  switchCorpus,
  refreshModelMeta,
  openSettingsModal,
  openCorpusModal,
  openImportModal,
  openCommandPalette,
});

function wireEvents() {
  initReaderScroll();
  setupResizer($('#resizerLeft'), 'left');
  setupResizer($('#resizerRight'), 'right');

  $$('.stage-tab').forEach((el) => el.addEventListener('click', () => setStageTab(el.dataset.stage)));

  $$('[data-theme-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.theme = b.dataset.themeBtn;
      applyPrefs();
      savePrefs();
    })
  );

  $$('[data-size]').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.fontSize = b.dataset.size;
      applyPrefs();
      savePrefs();
    })
  );

  $$('[data-font-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.fontFamily = b.dataset.fontBtn;
      applyPrefs();
      savePrefs();
    })
  );

  $$('[data-width-btn]').forEach((b) =>
    b.addEventListener('click', () => {
      prefs.sheetWidth = b.dataset.widthBtn;
      applyPrefs();
      savePrefs();
    })
  );

  $('#prefsToggleBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#mobileMenuPopover')?.classList.remove('open');
    $('#prefsPopover').classList.toggle('open');
  });
  $('#mobileMoreBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#prefsPopover')?.classList.remove('open');
    $('#mobileMenuPopover')?.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    const pop = $('#prefsPopover');
    if (pop.classList.contains('open') && !pop.contains(e.target) && e.target !== $('#prefsToggleBtn')) {
      pop.classList.remove('open');
    }
    const mPop = $('#mobileMenuPopover');
    if (mPop && mPop.classList.contains('open') && !mPop.contains(e.target) && e.target !== $('#mobileMoreBtn')) {
      mPop.classList.remove('open');
    }
  });

  $$('[data-mobile-pane]').forEach((b) => {
    b.addEventListener('click', () => setMobilePane(b.dataset.mobilePane));
  });

  $$('[data-mobile-action]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#mobileMenuPopover')?.classList.remove('open');
      const act = b.dataset.mobileAction;
      if (act === 'import') openImportModal();
      else if (act === 'corpus') openCorpusModal();
      else if (act === 'settings') openSettingsModal();
      else if (act === 'reload') $('#reloadCorporaBtn')?.click();
    });
  });

  $('#toggleTocBtn').addEventListener('click', () => {
    prefs.tocCollapsed = !prefs.tocCollapsed;
    applyPrefs();
    savePrefs();
  });
  $('#toggleTraceBtn').addEventListener('click', () => {
    prefs.traceCollapsed = !prefs.traceCollapsed;
    applyPrefs();
    savePrefs();
  });

  $$('[data-search-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      $$('[data-search-mode]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.searchMode = b.dataset.searchMode;
      $('#tocSearch').placeholder =
        state.searchMode === 'grep'
          ? '全文扫描人物、台词原句（空格表同幕共现）...'
          : '检篇名、人物、别名、编号...';
      if (state.searchMode === 'grep') triggerGrep();
      renderToc();
    });
  });

  $('#tocSearch').addEventListener('input', (e) => {
    state.searchTerm = e.target.value;
    if (state.searchMode === 'grep') scheduleGrep();
    else renderToc();
  });

  $('#expandAllSeriesBtn').addEventListener('click', () => {
    state.collapsedSeries.clear();
    renderToc();
  });
  $('#collapseAllSeriesBtn').addEventListener('click', () => {
    for (const a of state.index?.arcs || []) {
      state.collapsedSeries.add(String(a.series || a.category || '默认分卷').trim());
    }
    renderToc();
  });

  $('#corpusSelect').addEventListener('change', (e) => {
    if (e.target.value) switchCorpus(e.target.value);
  });
  $('#reloadCorporaBtn').addEventListener('click', async () => {
    const j = await reloadCorpora();
    state.corpora = j.corpora || [];
    const next = state.corpora.some((c) => c.id === state.corpusId)
      ? state.corpusId
      : j.defaultCorpus || state.corpora[0]?.id || '';
    if (next) await switchCorpus(next);
  });

  $('#tocMaxOrder').addEventListener('change', (e) => setMaxOrder(e.target.value, { reloadIndex: true }));
  $('#qMaxOrder').addEventListener('change', (e) => setMaxOrder(e.target.value, { reloadIndex: true }));

  $('#onlyPathBtn').addEventListener('click', () => {
    state.onlyPath = !state.onlyPath;
    $('#onlyPathBtn').classList.toggle('active-toggle', state.onlyPath);
    renderToc();
  });

  $('#clearMarksBtn').addEventListener('click', () => {
    state.activeRunId = null;
    state.activeRunData = null;
    state.onlyPath = false;
    $('#onlyPathBtn').classList.remove('active-toggle');
    renderRunsList();
    renderTrace(null);
    renderToc();
    if (state.stageMode === 'dossier') renderStage();
  });

  $('#homeBtn').addEventListener('click', openCover);
  $('#runBtn').addEventListener('click', executeSearch);
  $('#qOnDemand')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });
  $('#qText')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });

  $('#settingsBtn').addEventListener('click', openSettingsModal);
  $('#corpusCfgBtn').addEventListener('click', openCorpusModal);
  $('#importBtn').addEventListener('click', openImportModal);
  $('#cmdPaletteBtn').addEventListener('click', openCommandPalette);

  $('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#modalBackdrop')) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.key === 'Escape' && $('#modalBackdrop').classList.contains('open')) {
      closeModal();
      return;
    }
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowLeft') navigateSceneDelta(-1);
    if (e.key === 'ArrowRight') navigateSceneDelta(1);
  });
}

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('embed') === '1') {
    document.body.classList.add('embed-mode');
  }
  setMobilePane('stage');

  applyPrefs();
  wireEvents();

  const hashRunMatch = String(window.location.hash || '').match(/run=([a-zA-Z0-9_-]+)/);
  const hashRunId = hashRunMatch ? hashRunMatch[1] : '';
  const reqCorpus = String(urlParams.get('corpus') || '').trim();

  try {
    const [h, c] = await Promise.all([fetchHealth(), fetchCorpora()]);
    state.modelName = h.config?.chatModel || '-';
    state.corpora = c.corpora || [];
    const target =
      reqCorpus && state.corpora.some((x) => x.id === reqCorpus)
        ? reqCorpus
        : c.defaultCorpus || state.corpora[0]?.id || '';
    if (target) await switchCorpus(target);
    else $('#statMeta').textContent = '未发现语料包，请点击「导入建树」';
    await pollRuns({ autoSelectNewest: Boolean(hashRunId), preferHashRunId: hashRunId });
  } catch (e) {
    $('#statMeta').textContent = '连接异常：' + e.message;
  }

  setInterval(() => {
    if ($('#autoPollRuns').checked) pollRuns({ autoSelectNewest: true });
  }, 2500);
}

init();
