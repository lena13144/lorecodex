import { $, esc, prefs, savePrefs, applyPrefs, showToast, state, actions } from './state.js';
import {
  fetchConfig,
  saveConfig,
  fetchModels,
  fetchCorpusDetail,
  saveCorpusConfig,
  importCorpus,
  upgradeCorpus,
  cancelJob,
  findRunningJobForCorpus,
  previewLocalImportFile,
  fetchJob,
  fetchCorpora,
  exportCorpusLorepack,
} from './api.js';

function formatDurationZh(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) < 0) {
    return '计算中...';
  }
  const n = Number(ms);
  if (n <= 0) return '0秒';
  if (n < 1000) return '<1秒';
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return `${totalSec}秒`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec === 0 ? `${totalMin}分钟` : `${totalMin}分${String(sec).padStart(2, '0')}秒`;
  }
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}小时` : `${hours}小时${String(mins).padStart(2, '0')}分`;
}

function isArcDoneInIndex(arc, indexData) {
  if (!arc) return false;
  if (arc._llm_done === true) return true;
  if (arc._llm_done === false) return false;
  const stats = indexData?.stats || {};
  if (stats.llm_arcs === 0 && stats.llm_scenes === 0) return false;
  if (typeof stats.llm_arcs === 'number' && stats.llm_arcs < (indexData?.arcs?.length || 0)) {
    return false;
  }
  return Boolean(String(arc.description || '').trim());
}

function estimateIndexUpgradePlan(indexData, { series = '', limitArcs = 0, workers = 8, force = false, skipMeta = false } = {}) {
  const allArcs = indexData?.arcs || [];
  const serFilter = String(series || '').trim();
  let targetArcs = allArcs.filter((a) => !serFilter || String(a.series || a.category || '').trim() === serFilter);
  if (!force) {
    targetArcs = targetArcs.filter((a) => !isArcDoneInIndex(a, indexData));
  }
  const lim = Number(limitArcs) > 0 ? Math.floor(Number(limitArcs)) : 0;
  if (lim > 0) targetArcs = targetArcs.slice(0, lim);

  let totalScenes = 0;
  let arcSummaryCalls = 0;
  const touchedSeries = new Set();
  for (const arc of targetArcs) {
    const scenes = arc.scenes || [];
    const arcDone = isArcDoneInIndex(arc, indexData);
    for (const sc of scenes) {
      if (!force && (sc._llm_done || arcDone) && sc.summary) continue;
      totalScenes += 1;
    }
    if (scenes.length > 1) arcSummaryCalls += 1;
    touchedSeries.add(String(arc.series || arc.category || '正文卷').trim());
  }
  const totalSeriesMeta = skipMeta ? 0 : touchedSeries.size;
  const phase1Calls = totalScenes + arcSummaryCalls;
  const totalCalls = phase1Calls + totalSeriesMeta;
  const parsedWorkers = Math.min(Math.max(Number(workers) || 8, 1), 24);
  const effectiveWorkers = Math.min(parsedWorkers, Math.max(1, phase1Calls || targetArcs.length));
  const estMinMs = totalCalls > 0 ? Math.round((phase1Calls / effectiveWorkers + totalSeriesMeta) * 2500) : 0;
  const estMaxMs = totalCalls > 0 ? Math.round((phase1Calls / effectiveWorkers + totalSeriesMeta) * 8000) : 0;
  return {
    totalArcs: targetArcs.length,
    totalScenes,
    totalCalls,
    effectiveWorkers,
    estMinMs,
    estMaxMs,
  };
}

function renderJobProgressMarkup(prefix) {
  return `
    <div id="${prefix}ProgWrap" class="job-prog-wrap">
      <div class="job-prog-head">
        <span id="${prefix}ProgTitle" class="job-prog-title">准备构建...</span>
        <span id="${prefix}ProgTime" class="job-prog-time">已用 0秒</span>
      </div>
      <div class="job-prog-track">
        <div id="${prefix}ProgFill" class="job-prog-fill running indeterminate"></div>
      </div>
      <div class="job-prog-sub">
        <span id="${prefix}ProgCur" class="job-prog-cur">等待开始...</span>
        <span id="${prefix}ProgMeta"></span>
      </div>
    </div>
  `;
}

function renderJobProgressUi(prefix, job, fallbackStartMs) {
  const wrap = $(`#${prefix}ProgWrap`);
  if (!wrap) return;
  const fill = $(`#${prefix}ProgFill`);
  const titleEl = $(`#${prefix}ProgTitle`);
  const timeEl = $(`#${prefix}ProgTime`);
  const curEl = $(`#${prefix}ProgCur`);
  const metaEl = $(`#${prefix}ProgMeta`);

  const now = Date.now();
  const startedAtMs = job?.progress?.startedAtMs || (job?.startedAt ? Date.parse(job.startedAt) : fallbackStartMs) || now;
  const status = job?.status || 'running';

  let prog = job?.progress || null;
  if (!prog) {
    // Fallback for external Node server jobs that only emit logs like "[12/100] ..."
    const logs = Array.isArray(job?.logs) ? job.logs : [];
    let parsedDone = 0;
    let parsedTotal = 0;
    let lastLine = logs[logs.length - 1] || '';
    for (let i = logs.length - 1; i >= 0; i--) {
      const m = String(logs[i] || '').match(/\[(\d+)\/(\d+)\]/);
      if (m) {
        parsedDone = Number(m[1]);
        parsedTotal = Number(m[2]);
        lastLine = logs[i];
        break;
      }
    }
    const elapsed = Math.max(0, now - startedAtMs);
    const pct = status === 'done'
      ? 100
      : (parsedTotal > 0 ? Math.min(99.9, Number(((parsedDone / parsedTotal) * 100).toFixed(1))) : null);
    const etaMs = status === 'done'
      ? 0
      : (parsedDone > 0 && parsedTotal > parsedDone ? Math.round((elapsed / parsedDone) * (parsedTotal - parsedDone)) : null);
    prog = {
      phase: status === 'done' ? 'done' : 'arcs',
      percent: pct,
      doneArcs: parsedDone,
      totalArcs: parsedTotal,
      doneCalls: parsedDone,
      totalCalls: parsedTotal,
      elapsedMs: elapsed,
      etaMs,
      startedAtMs,
      currentLabel: lastLine || '服务端处理中...',
    };
  }

  const modeClass = status === 'done'
    ? 'done'
    : status === 'aborted'
      ? 'paused'
      : status === 'error'
        ? 'err'
        : 'running';
  fill.classList.remove('running', 'indeterminate', 'done', 'paused', 'err');
  fill.classList.add(modeClass);

  const hasPct = prog.percent !== null && prog.percent !== undefined && Number.isFinite(Number(prog.percent));
  if (!hasPct && status === 'running') {
    fill.classList.add('indeterminate');
  } else {
    const pct = status === 'done' ? 100 : Math.min(100, Math.max(0, Number(prog.percent) || 0));
    fill.style.width = `${pct.toFixed(1)}%`;
  }

  const elapsedMs = status === 'running'
    ? Math.max(0, now - startedAtMs)
    : Math.max(0, Number(prog.elapsedMs ?? (now - startedAtMs)));

  let etaPart = '';
  if (status === 'done') {
    etaPart = '已完成';
  } else if (status === 'aborted') {
    etaPart = '已暂停';
  } else if (status === 'error') {
    etaPart = '已中断';
  } else if (prog.etaMs !== null && prog.etaMs !== undefined) {
    const sinceUpd = prog.updatedAtMs ? Math.max(0, now - prog.updatedAtMs) : 0;
    const liveEta = Math.max(0, Number(prog.etaMs) - sinceUpd);
    etaPart = `剩余约 ${formatDurationZh(liveEta)}`;
  } else if (prog.estMaxMs > 0) {
    etaPart = `参考 ${formatDurationZh(prog.estMinMs)}~${formatDurationZh(prog.estMaxMs)}`;
  } else {
    etaPart = '测速中...';
  }

  const pctStr = hasPct ? `${(status === 'done' ? 100 : Number(prog.percent)).toFixed(1)}%` : '进行中';
  const arcSpan = Number(prog.totalArcs) > 0 ? ` (${prog.doneArcs || 0}/${prog.totalArcs} 章)` : '';
  if (status === 'done') {
    titleEl.textContent = `构建完成 · 100.0%${arcSpan}`;
  } else if (status === 'aborted') {
    titleEl.textContent = `已暂停并保存断点 · ${pctStr}${arcSpan}`;
  } else if (status === 'error') {
    titleEl.textContent = `构建中断（断点已保存）· ${pctStr}${arcSpan}`;
  } else if (prog.phase === 'series_meta') {
    titleEl.textContent = `提炼全卷总览 · ${pctStr} (${prog.doneSeries || 0}/${prog.totalSeries || 0} 卷)`;
  } else if (prog.phase === 'init') {
    titleEl.textContent = `准备构建 · ${prog.currentLabel || '解析文本中...'}`;
  } else {
    titleEl.textContent = `正在构建 LLM 目录 · ${pctStr}${arcSpan}`;
  }

  timeEl.textContent = `已用 ${formatDurationZh(elapsedMs)} · ${etaPart}`;
  curEl.textContent = prog.currentLabel || '处理中...';

  const reqPart = Number(prog.totalCalls) > 0 ? `请求 ${prog.doneCalls || 0}/${prog.totalCalls}` : '';
  const avgPart = prog.avgCallMs ? ` · 均速 ${(prog.avgCallMs / 1000).toFixed(1)}s/次` : '';
  metaEl.textContent = `${reqPart}${avgPart}`;
}

function renderSplitPreviewHtml(report, estimate, { autoUncheckedLlm = false } = {}) {
  if (!report) return '';
  const badgeCls = report.severity === 'error' ? 'err' : report.severity === 'warn' ? 'warn' : 'ok';
  const badgeText = report.severity === 'error' ? '高危异常' : report.severity === 'warn' ? '建议检查' : '切分正常';
  const volLabel = report.hasNamedSeries ? `${report.seriesCount} 卷` : (report.isLorePack ? '设定集' : '未分卷');
  const statsText = `${volLabel} · ${report.arcCount} 章 · ${report.sceneCount} 幕 · ${report.totalChars.toLocaleString()} 字 · 均章 ${report.avgArcChars.toLocaleString()} 字`;

  const estHtml = estimate && estimate.totalArcs > 0
    ? `<div class="pane-sub" style="margin:0;">若勾选下方 LLM 构建：预计 ${estimate.totalCalls} 次请求（并发 ${estimate.effectiveWorkers}）· 参考耗时约 ${formatDurationZh(estimate.estMinMs)} ~ ${formatDurationZh(estimate.estMaxMs)}</div>`
    : '';

  const blockNotice = autoUncheckedLlm
    ? `<div class="split-warn-item err"><b>防误烧护栏已拦截</b>：已自动取消勾选「启用 LLM 智能目录构建」，避免按异常切分白白调用 API。如确认无误仍要构建，可手动重新勾选后再导入。</div>`
    : '';

  const warnsHtml = report.warnings.length
    ? `<div class="split-warns">${report.warnings
        .map((w) => `<div class="split-warn-item ${w.level === 'error' ? 'err' : 'warn'}">${esc(w.message)}</div>`)
        .join('')}</div>`
    : '';

  const seriesHtml = report.seriesBreakdown.length
    ? `<div class="split-series-row">${report.seriesBreakdown
        .slice(0, 16)
        .map((s) => `<span class="split-chip">${esc(s.name)} (${s.arcs}章/${s.scenes}幕)</span>`)
        .join('')}${report.seriesBreakdown.length > 16 ? `<span class="split-chip">…共 ${report.seriesBreakdown.length} 卷</span>` : ''}</div>`
    : '';

  const samplesHtml = report.sampleArcs.length
    ? `<div class="split-samples">${report.sampleArcs
        .map((item) => {
          if (item.separator) {
            return `<div class="split-sep">··· 省略中间 ${item.omittedCount} 章 ···</div>`;
          }
          const meta = `${item.series ? esc(item.series) + ' · ' : ''}${item.sceneCount}幕 / ${item.chars.toLocaleString()}字`;
          return `<div class="split-sample-row">
            <div class="split-sample-head">
              <span>[${esc(item.arc_id)}] ${esc(item.title)}</span>
              <span style="font-weight:400;color:var(--ink-muted);">${meta}</span>
            </div>
            ${item.snippet ? `<div class="split-snippet">${esc(item.snippet)}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '';

  const shouldOpen = report.severity !== 'ok';
  return `
    <div class="split-preview-head">
      <span>切分结构预检（构建前预览）</span>
      <span class="split-badge ${badgeCls}">${badgeText}</span>
    </div>
    <div class="split-stats">${statsText}</div>
    ${estHtml}
    ${blockNotice}
    ${warnsHtml}
    <details ${shouldOpen ? 'open' : ''} style="margin-top:2px;">
      <summary style="cursor:pointer;font-size:11.5px;color:var(--ink-soft);user-select:none;">查看分卷分布与章节抽样（前 5 章 + 尾 2 章）</summary>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
        ${!report.hasNamedSeries && !report.isLorePack ? '<div class="pane-sub" style="margin:0;">提示：未匹配到“第X卷/部/篇”标记，所有章节暂归入同一卷。</div>' : ''}
        ${seriesHtml}
        ${samplesHtml}
      </div>
    </details>
  `;
}

let activeModalPoll = null;
function clearModalPoll() {
  if (activeModalPoll) {
    clearInterval(activeModalPoll);
    activeModalPoll = null;
  }
}

function startModalJobPoll({
  jobId,
  initialJob,
  progPrefix,
  logsEl,
  statusEl,
  stopBtnEl,
  runningText,
  onDone,
  onAborted,
  onError,
}) {
  clearModalPoll();
  const fallbackStartMs = Date.now();
  if (progPrefix && initialJob) {
    renderJobProgressUi(progPrefix, initialJob, fallbackStartMs);
  }
  if (stopBtnEl) {
    stopBtnEl.style.display = initialJob?.canCancel ? 'inline-flex' : 'none';
    stopBtnEl.disabled = false;
    stopBtnEl.onclick = () => {
      stopBtnEl.disabled = true;
      cancelJob(jobId);
      if (statusEl) statusEl.textContent = '正在暂停并写入断点，请稍候...';
    };
  }

  activeModalPoll = setInterval(async () => {
    try {
      const jr = await fetchJob(jobId);
      const job = jr.job;
      if (progPrefix) {
        renderJobProgressUi(progPrefix, job, fallbackStartMs);
      }
      if (logsEl) {
        logsEl.textContent = (job.logs || []).join('\n');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
      if (job.status === 'done') {
        clearModalPoll();
        if (stopBtnEl) stopBtnEl.style.display = 'none';
        if (onDone) await onDone(job);
      } else if (job.status === 'aborted') {
        clearModalPoll();
        if (stopBtnEl) stopBtnEl.style.display = 'none';
        if (statusEl) statusEl.textContent = '已暂停并保存断点（已完成章节已入库，可随时继续）';
        if (onAborted) await onAborted(job);
      } else if (job.status === 'error') {
        clearModalPoll();
        if (stopBtnEl) stopBtnEl.style.display = 'none';
        if (statusEl) statusEl.textContent = `任务失败: ${job.error}`;
        if (onError) await onError(job);
      } else if (statusEl) {
        statusEl.textContent = runningText ? runningText(job) : `正在运行 (${job.kind})...`;
      }
    } catch (_) {}
  }, 500);
}

export function closeModal() {
  clearModalPoll();
  $('#modalBackdrop').classList.remove('open');
  $('#modalDialog').className = 'modal-dialog';
  $('#modalDialog').innerHTML = '';
}

function openDialog(html, extraClass = '') {
  const dlg = $('#modalDialog');
  dlg.className = `modal-dialog ${extraClass}`.trim();
  dlg.innerHTML = html;
  $('#modalBackdrop').classList.add('open');
  dlg.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
}

export async function openSettingsModal() {
  openDialog(`
    <div class="modal-head">
      <span class="modal-title">服务与旁路模型配置 (config.json)</span>
      <button class="btn-ghost" data-close-modal>✕</button>
    </div>
    <div class="modal-body" id="settingsBody"><div style="color:var(--ink-muted);">正在读取服务端配置...</div></div>
  `);

  try {
    const cfg = await fetchConfig();
    const corpusOptions = state.corpora
      .map((c) => `<option value="${esc(c.id)}" ${c.id === cfg.defaultCorpus ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})</option>`)
      .join('');

    $('#modalDialog').innerHTML = `
      <div class="modal-head">
        <span class="modal-title">服务与旁路模型配置 (config.json)</span>
        <button class="btn-ghost" data-close-modal>✕</button>
      </div>
      <div class="modal-body">
        <div class="fld-group">
          <label class="fld">OpenAI 兼容 API Base URL</label>
          <input id="cfgBase" type="text" value="${esc(cfg.chatBase || '')}" />
        </div>
        <div class="fld-group">
          <label class="fld">API Key（当前为 *** 时留空则保留现有密钥）</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgKey" type="password" value="" placeholder="${cfg.chatKey ? '已配置密钥（留空不变，输入新值则覆盖）' : 'sk-...'}" />
            <button id="toggleCfgKey" type="button" class="btn-sm">显隐</button>
          </div>
        </div>
        <div class="fld-group">
          <label class="fld">模型名称</label>
          <div style="display:flex;gap:6px;">
            <input id="cfgModel" type="text" value="${esc(cfg.chatModel || '')}" placeholder="手动输入或点击右侧拉取后在下拉框选择" />
            <button id="cfgFetchModels" type="button" class="btn-sm" style="white-space:nowrap;">拉取模型</button>
          </div>
          <select id="cfgModelSelect" class="fld-sel" style="display:none;margin-top:6px;"></select>
        </div>
        <div class="fld-row-2">
          <div class="fld-group">
            <label class="fld">默认启动书库</label>
            <select id="cfgDefaultCorpus" class="fld-sel">${corpusOptions}</select>
          </div>
          <div class="fld-group">
            <label class="fld">思考强度 Reasoning Effort（默认不传）</label>
            <select id="cfgReasoningEffort" class="fld-sel">
              <option value="" ${!cfg.reasoningEffort ? 'selected' : ''}>沿用模型默认（不传）</option>
              ${['minimal', 'low', 'medium', 'high'].map((v) => `<option value="${v}" ${cfg.reasoningEffort === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="fld-row-2">
          <div class="fld-group">
            <label class="fld">单次输出 Max Tokens（留空/0 = 不限制）</label>
            <input id="cfgMaxTokens" type="number" min="0" step="256" value="${Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : ''}" placeholder="沿用模型默认" />
          </div>
          <div class="fld-group">
            <label class="fld">采样温度 Temperature（留空 = 不传）</label>
            <input id="cfgTemperature" type="number" min="0" max="2" step="0.1" value="${cfg.temperature !== null && cfg.temperature !== undefined && cfg.temperature !== '' ? cfg.temperature : ''}" placeholder="沿用模型默认（留空不传）" />
          </div>
        </div>
        <div id="cfgStatus" class="pane-sub"></div>
      </div>
      <div class="modal-foot">
        <button data-close-modal>取消</button>
        <button id="cfgSaveBtn" class="btn-seal">保存到服务端</button>
      </div>
    `;
    $('#modalDialog').querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));

    $('#toggleCfgKey').addEventListener('click', () => {
      const inp = $('#cfgKey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#cfgModelSelect').addEventListener('change', (e) => {
      const picked = e.target.value.trim();
      if (picked) {
        $('#cfgModel').value = picked;
        $('#cfgStatus').textContent = `已选择模型：${picked}（点击下方「保存到服务端」生效）`;
      }
    });

    $('#cfgModel').addEventListener('input', (e) => {
      const val = e.target.value.trim();
      const sel = $('#cfgModelSelect');
      if (sel && sel.style.display !== 'none') {
        const hasOpt = [...sel.options].some((o) => o.value === val);
        sel.value = hasOpt ? val : '';
      }
    });

    $('#cfgFetchModels').addEventListener('click', async () => {
      const btn = $('#cfgFetchModels');
      btn.disabled = true;
      $('#cfgStatus').textContent = '正在拉取模型列表...';
      try {
        const j = await fetchModels($('#cfgBase').value.trim(), $('#cfgKey').value.trim());
        const models = j.models || [];
        const sel = $('#cfgModelSelect');
        if (sel && models.length) {
          const cur = $('#cfgModel').value.trim();
          sel.innerHTML =
            `<option value="">-- 从已拉取的 ${models.length} 个模型中选择 --</option>` +
            models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
          sel.style.display = 'block';
          if (!cur || !models.includes(cur)) {
            $('#cfgModel').value = models[0];
            sel.value = models[0];
          }
        }
        $('#cfgStatus').textContent = models.length
          ? `已拉取 ${models.length} 个可用模型，可在下拉框直接选择`
          : '接口返回了 0 个模型，请手动输入模型名称';
      } catch (e) {
        $('#cfgStatus').textContent = '拉取失败: ' + e.message;
      } finally {
        btn.disabled = false;
      }
    });

    $('#cfgSaveBtn').addEventListener('click', async () => {
      try {
        const rawMaxTokens = Number($('#cfgMaxTokens').value);
        const rawTempStr = $('#cfgTemperature').value.trim();
        const parsedTemp = rawTempStr === '' ? null : Number(rawTempStr);
        const reVal = ($('#cfgReasoningEffort')?.value || '').trim().toLowerCase();
        const patch = {
          chatBase: $('#cfgBase').value.trim(),
          chatModel: $('#cfgModel').value.trim(),
          defaultCorpus: $('#cfgDefaultCorpus').value,
          maxTokens: Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? Math.floor(rawMaxTokens) : null,
          temperature: parsedTemp !== null && Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2 ? parsedTemp : null,
          reasoningEffort: reVal || null,
        };
        const newKey = $('#cfgKey').value.trim();
        if (newKey) patch.chatKey = newKey;
        const res = await saveConfig(patch);
        state.modelName = res.config?.chatModel || patch.chatModel;
        actions.refreshModelMeta?.();
        showToast('服务模型配置已保存', 'ok');
        closeModal();
      } catch (e) {
        $('#cfgStatus').textContent = '保存失败: ' + e.message;
      }
    });
  } catch (e) {
    $('#settingsBody').textContent = '加载配置失败: ' + e.message;
  }
}

export async function openCorpusModal() {
  if (!state.corpusId) return showToast('请先选择一个书库', 'err');
  openDialog(`
    <div class="modal-head">
      <span class="modal-title">编辑书库配置 · ${esc(state.corpusId)}</span>
      <button class="btn-ghost" data-close-modal>✕</button>
    </div>
    <div class="modal-body" id="corpusModalLoading">正在读取 corpus.json...</div>
  `);

  try {
    const detail = await fetchCorpusDetail(state.corpusId);
    const c = detail.config;
    const aliasesText = (c.aliases || []).map((g) => g.join(', ')).join('\n');
    const glossaryText = (c.glossary || []).join('\n');
    const stageText = (c.stage_card_patterns || []).join('\n');
    const boilerText = (c.db_scrubber?.boilerplate_patterns || []).join('\n');
    const sumPriText = (c.db_scrubber?.summary_priority_patterns || []).join('\n');

    const seriesList = Array.isArray(state.index?.series) ? state.index.series : [];
    const totalScenes = Number(state.index?.stats?.scenes || detail.stats?.scenes || 0);
    const llmScenes = Number(state.index?.stats?.llm_scenes || 0);
    const seriesOptions = [
      '<option value="">全部卷宗</option>',
      ...seriesList.map(
        (s) => `<option value="${esc(s.series)}">${esc(s.series)} (${s.arcs}卷 / ${s.scenes}幕)</option>`
      ),
    ].join('');

    $('#modalDialog').innerHTML = `
      <div class="modal-head">
        <span class="modal-title">语料包在线配置 · ${esc(c.name)} (${esc(c.id)})</span>
        <button class="btn-ghost" data-close-modal>✕</button>
      </div>
      <div class="modal-tabs">
        <div class="modal-tab active" data-ctab="basic">基础与世界观</div>
        <div class="modal-tab" data-ctab="aliases">别名与编制表</div>
        <div class="modal-tab" data-ctab="framing">防误判与注入包装</div>
        <div class="modal-tab" data-ctab="upgrade">LLM 目录补全</div>
      </div>
      <div class="modal-body">
        <div id="ctab-basic" class="ctab-pane" style="display:flex;flex-direction:column;gap:10px;">
          <div class="fld-row-2">
            <div class="fld-group"><label class="fld">显示名称</label><input id="ccName" type="text" value="${esc(c.name)}" /></div>
            <div class="fld-group"><label class="fld">3层自动折叠阈值 (卷)</label><input id="ccThreshold" type="number" min="20" value="${c.hierarchy?.auto_series_threshold || 250}" /></div>
          </div>
          <div class="fld-group"><label class="fld">书库简介</label><textarea id="ccDesc" rows="2">${esc(c.description || '')}</textarea></div>
          <div class="fld-group"><label class="fld">世界观前提 (world_premise)</label><textarea id="ccPremise" rows="3">${esc(c.world_premise || '')}</textarea></div>
          <div class="fld-group"><label class="fld">主动触发召回条件</label><textarea id="ccTriggers" rows="2">${esc(c.active_recall_triggers || '')}</textarea></div>
          <div class="fld-group"><label class="fld">日常跳过判据</label><textarea id="ccSkip" rows="2">${esc(c.skip_criteria || '')}</textarea></div>
          <div class="fld-row-2">
            <div class="fld-group"><label class="fld">防剧透进度标签</label><input id="ccOrderLabel" type="text" value="${esc(c.spoiler_gate?.order_label || '章节进度')}" /></div>
            <div class="fld-group" style="justify-content:flex-end;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
                <input id="ccSpoilerEnabled" type="checkbox" ${c.spoiler_gate?.enabled ? 'checked' : ''} />
                <span>默认开启防剧透门控</span>
              </label>
            </div>
          </div>
        </div>

        <div id="ctab-aliases" class="ctab-pane" style="display:none;flex-direction:column;gap:10px;">
          <div class="fld-group">
            <label class="fld">人物/实体别名组（每行一组，逗号分隔，如：可露凯, HK416, 416）</label>
            <textarea id="ccAliases" rows="7">${esc(aliasesText)}</textarea>
          </div>
          <div class="fld-group">
            <label class="fld">编制/势力/关系速查表（每行一条）</label>
            <textarea id="ccGlossary" rows="5">${esc(glossaryText)}</textarea>
          </div>
          <div class="fld-row-2">
            <div class="fld-group"><label class="fld">防张冠李戴 OC 示例（逗号分隔）</label><input id="ccOc" type="text" value="${esc((c.oc_examples || []).join(', '))}" /></div>
            <div class="fld-group"><label class="fld">英文短语扫描排除词（逗号分隔）</label><input id="ccEnExcl" type="text" value="${esc((c.grep?.english_exclude_terms || []).join(', '))}" /></div>
          </div>
        </div>

        <div id="ctab-framing" class="ctab-pane" style="display:none;flex-direction:column;gap:10px;">
          <div class="fld-group"><label class="fld">舞台/城市卡屏蔽正则（每行一条，匹配时禁止拿卡名搜目录）</label><textarea id="ccStage" rows="2">${esc(stageText)}</textarea></div>
          <div class="fld-group"><label class="fld">氛围分流指引 (tone_routing_hints)</label><textarea id="ccToneHints" rows="2">${esc(c.tone_routing_hints || '')}</textarea></div>
          <div class="fld-row-2">
            <div class="fld-group"><label class="fld">注入 XML 标签名</label><input id="ccXmlTag" type="text" value="${esc(c.prompt_framing?.xml_tag || '')}" /></div>
            <div class="fld-group"><label class="fld">用户身份防混淆提示</label><input id="ccUserGuard" type="text" value="${esc(c.user_identity_guard?.note || '')}" /></div>
          </div>
          <div class="fld-group"><label class="fld">注入导语 Header</label><textarea id="ccHeader" rows="2">${esc(c.prompt_framing?.header || '')}</textarea></div>
          <div class="fld-group"><label class="fld">事实优先级规则</label><textarea id="ccPriority" rows="2">${esc(c.prompt_framing?.priority_rule || '')}</textarea></div>
          <div class="fld-group"><label class="fld">追查指令尾注</label><input id="ccFollowUp" type="text" value="${esc(c.prompt_framing?.follow_up_hint || '')}" /></div>
          <div class="fld-row-2">
            <div class="fld-group"><label class="fld">数据库样板跳过正则（每行一条）</label><textarea id="ccBoiler" rows="2">${esc(boilerText)}</textarea></div>
            <div class="fld-group"><label class="fld">优先摘要正则（每行一条）</label><textarea id="ccSumPri" rows="2">${esc(sumPriText)}</textarea></div>
          </div>
        </div>

        <div id="ctab-upgrade" class="ctab-pane" style="display:none;flex-direction:column;gap:10px;">
          <div class="pane-sub" id="ccUpgCoverage">
            当前 LLM 目录覆盖度：<b>${llmScenes}</b> / ${totalScenes} 幕（单幕章节自动复用幕级摘要，支持断点续传与分卷补全）
          </div>
          <div class="fld-group">
            <label class="fld">目标分卷范围</label>
            <select id="ccUpgSeries" class="fld-sel">${seriesOptions}</select>
          </div>
          <div class="fld-row-2">
            <div class="fld-group">
              <label class="fld">并发数（推荐 6~12）</label>
              <input id="ccUpgWorkers" type="number" min="1" max="24" value="8" />
            </div>
            <div class="fld-group">
              <label class="fld">限量章数（0 = 所选范围全部）</label>
              <input id="ccUpgLimit" type="number" min="0" value="0" />
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input id="ccUpgSynthMeta" type="checkbox" checked />
              <span>同时提炼别名表、设定速查与分卷简介</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input id="ccUpgForce" type="checkbox" />
              <span>强制重生成已有摘要</span>
            </label>
          </div>
          <div id="ccUpgEstimate" class="pane-sub"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button id="ccUpgStartBtn" type="button" class="btn-seal">开始原地补全 LLM 目录</button>
            <button id="ccUpgStopBtn" type="button" class="btn-sm" style="display:none;">暂停并保存断点</button>
          </div>
          <div id="ccUpgJobWrap" style="display:none;flex-direction:column;gap:6px;">
            ${renderJobProgressMarkup('ccUpg')}
            <div id="ccUpgJobStatus" style="font-size:12px;font-weight:600;">准备补全...</div>
            <div id="ccUpgJobLogs" class="job-logs"></div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button id="ccExportPackBtn" type="button" class="btn-sm" style="margin-right:auto;" title="导出为单个 .lorepack.json 文件，可直接导入 TauriTavern / 手机内置免服务端引擎">导出 .lorepack.json</button>
        <button data-close-modal>取消</button>
        <button id="ccSaveBtn" class="btn-seal">保存并热重载语料</button>
      </div>
    `;

    $('#modalDialog').querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
    $('#ccExportPackBtn')?.addEventListener('click', () => {
      exportCorpusLorepack(c.id).catch((e) => showToast('导出失败: ' + e.message, 'err'));
    });
    $('#modalDialog')
      .querySelectorAll('[data-ctab]')
      .forEach((tab) => {
        tab.addEventListener('click', () => {
          $('#modalDialog').querySelectorAll('[data-ctab]').forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          $('#modalDialog').querySelectorAll('.ctab-pane').forEach((p) => (p.style.display = 'none'));
          $(`#ctab-${tab.dataset.ctab}`).style.display = 'flex';
        });
      });

    const updateUpgEstimate = () => {
      const estEl = $('#ccUpgEstimate');
      if (!estEl) return;
      const workersVal = Math.min(Math.max(Number($('#ccUpgWorkers')?.value) || 8, 1), 24);
      const est = estimateIndexUpgradePlan(state.index, {
        series: $('#ccUpgSeries')?.value || '',
        limitArcs: Math.max(0, Number($('#ccUpgLimit')?.value) || 0),
        workers: workersVal,
        force: Boolean($('#ccUpgForce')?.checked),
        skipMeta: !$('#ccUpgSynthMeta')?.checked,
      });
      if (!est.totalArcs) {
        estEl.textContent = '所选范围均已完成 LLM 目录构建（如需重跑请勾选“强制重生成已有摘要”）';
        return;
      }
      estEl.textContent = `本次待补全 ${est.totalArcs} 章 / ${est.totalScenes} 幕 · 预计 ${est.totalCalls} 次请求（并发 ${est.effectiveWorkers}）· 启动前参考耗时约 ${formatDurationZh(est.estMinMs)} ~ ${formatDurationZh(est.estMaxMs)}`;
    };
    updateUpgEstimate();
    $('#ccUpgSeries')?.addEventListener('change', updateUpgEstimate);
    $('#ccUpgWorkers')?.addEventListener('input', updateUpgEstimate);
    $('#ccUpgLimit')?.addEventListener('input', updateUpgEstimate);
    $('#ccUpgSynthMeta')?.addEventListener('change', updateUpgEstimate);
    $('#ccUpgForce')?.addEventListener('change', updateUpgEstimate);

    const upgBtn = $('#ccUpgStartBtn');
    const stopBtn = $('#ccUpgStopBtn');

    const refreshAfterUpg = async (isAborted = false) => {
      const [listRes, freshDetail] = await Promise.all([
        fetchCorpora(),
        fetchCorpusDetail(c.id).catch(() => null),
      ]);
      state.corpora = listRes.corpora || [];
      await actions.switchCorpus?.(c.id, { keepRun: true });
      if (freshDetail?.config) {
        const fc = freshDetail.config;
        if ($('#ccAliases')) $('#ccAliases').value = (fc.aliases || []).map((g) => g.join(', ')).join('\n');
        if ($('#ccGlossary')) $('#ccGlossary').value = (fc.glossary || []).join('\n');
      }
      const newLlm = state.index?.stats?.llm_scenes || 0;
      const newTot = state.index?.stats?.scenes || totalScenes;
      $('#ccUpgCoverage').innerHTML = isAborted
        ? `当前 LLM 目录覆盖度：<b>${newLlm}</b> / ${newTot} 幕（已暂停并保存断点，可随时点击「开始原地补全 LLM 目录」续传）`
        : `当前 LLM 目录覆盖度：<b>${newLlm}</b> / ${newTot} 幕（已完成本轮补全并重载，新增别名与设定已同步至左侧标签页）`;
      updateUpgEstimate();
    };

    const attachUpgJob = (jobObj, reused = false) => {
      upgBtn.disabled = true;
      $('#ccUpgJobWrap').style.display = 'flex';
      if (reused) {
        $('#ccUpgJobStatus').textContent = '已接管正在后台进行的 LLM 目录构建任务...';
      }
      startModalJobPoll({
        jobId: jobObj.id,
        initialJob: jobObj,
        progPrefix: 'ccUpg',
        logsEl: $('#ccUpgJobLogs'),
        statusEl: $('#ccUpgJobStatus'),
        stopBtnEl: stopBtn,
        runningText: (job) => {
          const p = job?.progress;
          if (p && p.totalCalls > 0) {
            const etaStr = p.etaMs !== null && p.etaMs !== undefined ? ` · 剩余约 ${formatDurationZh(p.etaMs)}` : '';
            return `正在执行 LLM 目录补全（${p.percent}%${etaStr}，可切回主页面或随时暂停）`;
          }
          return '正在执行 LLM 目录补全（可切回主页面或稍候）...';
        },
        onDone: async (job) => {
          $('#ccUpgJobStatus').textContent = `补全完成（耗时 ${formatDurationZh(job?.progress?.elapsedMs)}）！正在热重载书库索引...`;
          await refreshAfterUpg(false);
          showToast(`书库「${c.id}」LLM 目录补全完成！`, 'ok');
          upgBtn.disabled = false;
        },
        onAborted: async () => {
          await refreshAfterUpg(true);
          showToast('已暂停 LLM 补全并保存断点', 'ok');
          upgBtn.disabled = false;
        },
        onError: () => {
          upgBtn.disabled = false;
        },
      });
    };

    const existingActiveJob = findRunningJobForCorpus(c.id);
    if (existingActiveJob) {
      attachUpgJob(existingActiveJob, true);
    }

    $('#ccUpgStartBtn')?.addEventListener('click', async () => {
      upgBtn.disabled = true;
      $('#ccUpgJobWrap').style.display = 'flex';
      $('#ccUpgJobStatus').textContent = '正在提交 LLM 目录补全任务...';
      try {
        const res = await upgradeCorpus(c.id, {
          series: $('#ccUpgSeries').value,
          workers: Math.min(Math.max(Number($('#ccUpgWorkers')?.value) || 8, 1), 24),
          limitArcs: Math.max(0, Number($('#ccUpgLimit').value) || 0),
          skipMeta: !$('#ccUpgSynthMeta').checked,
          force: $('#ccUpgForce').checked,
        });
        attachUpgJob(res.job, Boolean(res.reused));
      } catch (e) {
        $('#ccUpgJobStatus').textContent = '提交失败: ' + e.message;
        upgBtn.disabled = false;
      }
    });

    $('#ccSaveBtn').addEventListener('click', async () => {
      try {
        const splitLines = (v) => v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const splitComma = (v) => v.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
        const aliases = splitLines($('#ccAliases').value).map(splitComma).filter((g) => g.length);

        await saveCorpusConfig(c.id, {
          name: $('#ccName').value.trim() || c.id,
          description: $('#ccDesc').value.trim(),
          world_premise: $('#ccPremise').value.trim(),
          active_recall_triggers: $('#ccTriggers').value.trim(),
          skip_criteria: $('#ccSkip').value.trim(),
          aliases,
          glossary: splitLines($('#ccGlossary').value),
          oc_examples: splitComma($('#ccOc').value),
          stage_card_patterns: splitLines($('#ccStage').value),
          tone_routing_hints: $('#ccToneHints').value.trim(),
          user_identity_guard: { enabled: true, note: $('#ccUserGuard').value.trim() },
          spoiler_gate: {
            enabled: $('#ccSpoilerEnabled').checked,
            order_label: $('#ccOrderLabel').value.trim() || '章节进度',
          },
          hierarchy: { auto_series_threshold: Math.max(20, Number($('#ccThreshold').value) || 250) },
          grep: { english_exclude_terms: splitComma($('#ccEnExcl').value) },
          prompt_framing: {
            xml_tag: $('#ccXmlTag').value.trim(),
            header: $('#ccHeader').value.trim(),
            priority_rule: $('#ccPriority').value.trim(),
            follow_up_hint: $('#ccFollowUp').value.trim(),
          },
          db_scrubber: {
            boilerplate_patterns: splitLines($('#ccBoiler').value),
            summary_priority_patterns: splitLines($('#ccSumPri').value),
          },
        });

        const listRes = await fetchCorpora();
        state.corpora = listRes.corpora || [];
        await actions.switchCorpus?.(c.id, { keepRun: true });
        showToast(`书库「${c.id}」配置已更新并热重载`, 'ok');
        closeModal();
      } catch (e) {
        showToast('保存失败: ' + e.message, 'err');
      }
    });
  } catch (e) {
    $('#corpusModalLoading').textContent = '加载失败: ' + e.message;
  }
}

export function openImportModal() {
  let selectedFile = null;

  const mergeOptions = [
    '<option value="">（新建独立设定书库）</option>',
    ...state.corpora.map((c) => `<option value="${esc(c.id)}">并入已有书库：${esc(c.name)} (${esc(c.id)})</option>`),
  ].join('');

  openDialog(`
    <div class="modal-head">
      <span class="modal-title">网页导入建树（小说 / 世界书 / 设定档案）</span>
      <button class="btn-ghost" data-close-modal>✕</button>
    </div>
    <div class="modal-body">
      <div id="impDropzone" class="dropzone">
        <div style="font-weight:600;margin-bottom:4px;">点击选择或拖拽文件到此处</div>
        <div class="pane-sub">支持单文件典籍包 (.lorepack.json)、小说 (.txt / .md / .epub) 或世界书 / 角色卡 (.json)</div>
        <div id="impFileInfo" style="margin-top:8px;font-family:var(--mono);font-size:11.5px;color:var(--seal);"></div>
      </div>
      <input id="impFileInput" type="file" accept=".txt,.md,.epub,.json,.jsonl" style="display:none;" />

      <div class="fld-row-2">
        <div class="fld-group">
          <label class="fld">建树模式</label>
          <select id="impKind" class="fld-sel">
            <option value="novel">长篇小说三级树 (build_novel.py)</option>
            <option value="lore">世界书 / 离散设定 (build_lore.py)</option>
          </select>
        </div>
        <div class="fld-group">
          <label class="fld">目标书库 ID（英文/数字/短横线）</label>
          <input id="impCorpusId" type="text" placeholder="my-novel" />
        </div>
      </div>

      <div class="fld-row-2">
        <div class="fld-group">
          <label class="fld">作品显示名称</label>
          <input id="impName" type="text" placeholder="例如：诡秘之主" />
        </div>
        <div class="fld-group">
          <label class="fld">默认分类标签</label>
          <input id="impCategory" type="text" value="正文" />
        </div>
      </div>

      <div id="impLoreOpts" class="fld-row-2" style="display:none;">
        <div class="fld-group">
          <label class="fld">合并目标（可选单树共生）</label>
          <select id="impMergeInto" class="fld-sel">${mergeOptions}</select>
        </div>
        <div class="fld-group" style="justify-content:flex-end;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;">
            <input id="impFilterStats" type="checkbox" checked />
            <span>自动过滤游戏战斗数值/广告噪点</span>
          </label>
        </div>
      </div>

      <div id="impSplitPreviewWrap" class="split-preview-wrap" style="display:none;"></div>

      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:space-between;font-size:12px;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;min-width:220px;">
          <input id="impUseLlm" type="checkbox" checked />
          <span><b>启用 LLM 智能目录构建</b>（自动生成分幕摘要、卷总览、人物别名对照表与术语表；数百万字大书可先取消勾选切好分卷，再在「语料配置 -> LLM 目录补全」按卷升级）</span>
        </label>
        <div class="fld-group" style="width:130px;flex-shrink:0;">
          <label class="fld">LLM 建库并发数</label>
          <input id="impWorkers" type="number" min="1" max="24" value="8" />
        </div>
      </div>

      <div id="impJobWrap" style="display:none;flex-direction:column;gap:6px;">
        ${renderJobProgressMarkup('imp')}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div id="impJobStatus" style="font-size:12px;font-weight:600;">准备构建...</div>
          <button id="impStopBtn" type="button" class="btn-sm" style="display:none;">暂停并保存断点</button>
        </div>
        <div id="impJobLogs" class="job-logs"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button id="impDoneSwitchBtn" class="btn-seal" style="display:none;">立即打开新书库</button>
      <button data-close-modal>关闭</button>
      <button id="impStartBtn" class="btn-seal">开始导入</button>
    </div>
  `);

  const cleanupClose = () => {
    closeModal();
  };
  $('#modalDialog').querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', cleanupClose));

  const updateModeUi = () => {
    const isLore = $('#impKind').value === 'lore';
    $('#impLoreOpts').style.display = isLore ? 'grid' : 'none';
    if (isLore && $('#impCategory').value === '正文') $('#impCategory').value = '档案设定';
    if (!isLore && $('#impCategory').value === '档案设定') $('#impCategory').value = '正文';
  };

  let previewSeq = 0;
  let userExplicitlyEnabledLlm = false;

  $('#impUseLlm').addEventListener('change', (e) => {
    userExplicitlyEnabledLlm = Boolean(e.target.checked);
  });

  const runFileSplitPreview = async (file) => {
    const wrap = $('#impSplitPreviewWrap');
    if (!wrap) return;
    if (!file || file.name.toLowerCase().endsWith('.lorepack.json')) {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    const seq = ++previewSeq;
    wrap.style.display = 'flex';
    wrap.innerHTML = '<div class="pane-sub" style="margin:0;">正在解析并预检切分结构...</div>';
    try {
      const ab = await file.arrayBuffer();
      if (seq !== previewSeq) return;
      const res = await previewLocalImportFile({
        filename: file.name,
        buffer: ab,
        kind: $('#impKind').value,
        corpusId: $('#impCorpusId').value.trim() || 'preview',
        name: $('#impName').value.trim() || file.name,
        category: $('#impCategory').value.trim(),
        workers: Math.min(Math.max(Number($('#impWorkers')?.value) || 8, 1), 24),
      });
      if (seq !== previewSeq) return;
      if (!res?.ok || !res.report) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
      }
      let autoUncheckedLlm = false;
      const useLlmEl = $('#impUseLlm');
      if (res.report.shouldBlockAutoLlm && !res.report.isLorePack && useLlmEl.checked && !userExplicitlyEnabledLlm) {
        useLlmEl.checked = false;
        autoUncheckedLlm = true;
      }
      wrap.innerHTML = renderSplitPreviewHtml(res.report, res.estimate, { autoUncheckedLlm });
      wrap.style.display = 'flex';
    } catch (_) {
      if (seq === previewSeq) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
      }
    }
  };

  $('#impKind').addEventListener('change', () => {
    updateModeUi();
    if (selectedFile) runFileSplitPreview(selectedFile);
  });
  $('#impWorkers')?.addEventListener('input', () => {
    if (selectedFile) runFileSplitPreview(selectedFile);
  });

  let lastAutoSlug = '';
  let lastAutoName = '';

  const handleFile = (file) => {
    if (!file) return;
    selectedFile = file;
    userExplicitlyEnabledLlm = false;
    const lower = file.name.toLowerCase();
    const isLorepack = lower.endsWith('.lorepack.json');
    if (isLorepack) {
      $('#impFileInfo').textContent = `已选择典籍包: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB) — 点击下方「开始导入」即可直接入库`;
    } else {
      $('#impFileInfo').textContent = `已选择: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    }
    const stem = file.name.replace(/\.lorepack\.json$/i, '').replace(/\.[^.]+$/, '');
    const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom-book';
    const curId = $('#impCorpusId').value.trim();
    const curName = $('#impName').value.trim();
    if (!curId || curId === lastAutoSlug) {
      $('#impCorpusId').value = slug;
      lastAutoSlug = slug;
    }
    if (!curName || curName === lastAutoName) {
      $('#impName').value = stem;
      lastAutoName = stem;
    }
    if (isLorepack || lower.endsWith('.json') || lower.endsWith('.jsonl')) $('#impKind').value = 'lore';
    else $('#impKind').value = 'novel';
    updateModeUi();
    runFileSplitPreview(file);
  };

  const dz = $('#impDropzone');
  const fi = $('#impFileInput');
  dz.addEventListener('click', () => {
    fi.value = '';
    fi.click();
  });
  fi.addEventListener('change', (e) => handleFile(e.target.files?.[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    handleFile(e.dataTransfer?.files?.[0]);
  });

  const readBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || '');
        const idx = res.indexOf('base64,');
        resolve(idx >= 0 ? res.slice(idx + 7) : res);
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });

  $('#impStartBtn').addEventListener('click', async () => {
    if (!selectedFile) {
      fi.value = '';
      fi.click();
      return;
    }
    const corpusId = $('#impCorpusId').value.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(corpusId)) {
      return showToast('书库 ID 仅支持英文/数字/连字符', 'err');
    }
    const startBtn = $('#impStartBtn');
    startBtn.disabled = true;
    $('#impJobWrap').style.display = 'flex';
    $('#impJobStatus').textContent = '正在读取文件并启动导入...';

    try {
      const contentBase64 = await readBase64(selectedFile);
      const kind = $('#impKind').value;
      const mergeInto = kind === 'lore' ? $('#impMergeInto').value : '';
      const res = await importCorpus({
        kind,
        corpusId,
        name: $('#impName').value.trim() || corpusId,
        filename: selectedFile.name,
        contentBase64,
        category: $('#impCategory').value.trim(),
        mergeInto,
        useLlm: $('#impUseLlm').checked,
        workers: Math.min(Math.max(Number($('#impWorkers')?.value) || 8, 1), 24),
        allowLlmOnAnomaly: userExplicitlyEnabledLlm,
        filterGameStats: $('#impFilterStats').checked,
      });

      const jobId = res.job.id;
      const targetId = res.job.corpusId;
      startModalJobPoll({
        jobId,
        initialJob: res.job,
        progPrefix: 'imp',
        logsEl: $('#impJobLogs'),
        statusEl: $('#impJobStatus'),
        stopBtnEl: $('#impStopBtn'),
        runningText: (job) => {
          const p = job?.progress;
          if (p && p.totalCalls > 0) {
            const etaStr = p.etaMs !== null && p.etaMs !== undefined ? ` · 剩余约 ${formatDurationZh(p.etaMs)}` : '';
            return `正在构建 (${p.percent}%${etaStr})...`;
          }
          return `正在运行 (${job.kind})...`;
        },
        onDone: async (job) => {
          const wrap = $('#impSplitPreviewWrap');
          if (wrap && !wrap.innerHTML.trim() && job?.structureReport) {
            wrap.innerHTML = renderSplitPreviewHtml(job.structureReport, null);
            wrap.style.display = 'flex';
          }
          const wasBlocked = job?.structureReport?.shouldBlockAutoLlm && $('#impUseLlm').checked && !userExplicitlyEnabledLlm;
          $('#impJobStatus').textContent = wasBlocked
            ? `已切分入库 "${targetId}"（高危异常已拦截自动 LLM 构建）`
            : `构建完成（耗时 ${formatDurationZh(job?.progress?.elapsedMs)}）！书库 "${targetId}" 已入库`;
          const listRes = await fetchCorpora();
          state.corpora = listRes.corpora || [];
          showToast(wasBlocked ? `书库「${targetId}」已切分入库，请检查结构后构建` : `书库「${targetId}」导入建树成功！`, 'ok');
          const switchBtn = $('#impDoneSwitchBtn');
          switchBtn.style.display = 'inline-flex';
          switchBtn.onclick = async () => {
            await actions.switchCorpus?.(targetId);
            cleanupClose();
          };
        },
        onAborted: async () => {
          const listRes = await fetchCorpora();
          state.corpora = listRes.corpora || [];
          showToast(`书库「${targetId}」已保存断点，打开后可在语料配置继续补全`, 'ok');
          const switchBtn = $('#impDoneSwitchBtn');
          switchBtn.style.display = 'inline-flex';
          switchBtn.onclick = async () => {
            await actions.switchCorpus?.(targetId);
            cleanupClose();
          };
          startBtn.disabled = false;
        },
        onError: (job) => {
          $('#impJobStatus').textContent = `构建失败: ${job.error}`;
          startBtn.disabled = false;
        },
      });
    } catch (e) {
      $('#impJobStatus').textContent = '提交失败: ' + e.message;
      startBtn.disabled = false;
    }
  });

  fi.click();
}

export function openCommandPalette() {
  const items = [
    { kind: '操作', label: '导入小说 / 世界书建树', run: () => openImportModal() },
    { kind: '操作', label: '编辑当前书库配置与别名', run: () => openCorpusModal() },
    { kind: '操作', label: '打开服务与模型配置', run: () => openSettingsModal() },
    { kind: '主题', label: '切换主题：书卷 · 素笺', run: () => setTheme('paper') },
    { kind: '主题', label: '切换主题：书卷 · 墨灯', run: () => setTheme('lamp') },
    { kind: '主题', label: '切换主题：工作台 · 净台', run: () => setTheme('studio-light') },
    { kind: '主题', label: '切换主题：工作台 · 曜夜', run: () => setTheme('studio-dark') },
  ];

  for (const c of state.corpora) {
    items.push({
      kind: '书库',
      label: `切换到书库：${c.name} (${c.stats.arcs}卷)`,
      run: () => actions.switchCorpus?.(c.id),
    });
  }
  for (const a of state.index?.arcs || []) {
    items.push({
      kind: '篇章',
      label: `[${a.arc_id}] ${a.title}`,
      sub: a.category,
      run: () => actions.openArc?.(a.arc_id),
    });
    for (const s of a.scenes || []) {
      items.push({
        kind: '场景',
        label: `${s.node_id} · ${s.title || s.group_title}`,
        sub: a.title,
        run: () => actions.openScene?.(s.node_id, a.arc_id),
      });
    }
  }

  function setTheme(t) {
    prefs.theme = t;
    savePrefs();
    applyPrefs();
    closeModal();
  }

  openDialog(
    `<input id="cmdSearchInput" class="cmd-input" type="text" placeholder="搜索卷名、场景节点、操作或书库..." autofocus />
     <div id="cmdList" class="cmd-list"></div>`,
    'cmd-dialog'
  );

  let activeIdx = 0;
  let filtered = items.slice(0, 40);

  const renderList = () => {
    const q = $('#cmdSearchInput').value.trim().toLowerCase();
    filtered = (q
      ? items.filter((it) => it.label.toLowerCase().includes(q) || (it.sub || '').toLowerCase().includes(q))
      : items
    ).slice(0, 40);
    if (activeIdx >= filtered.length) activeIdx = 0;
    $('#cmdList').innerHTML = filtered.length
      ? filtered
          .map(
            (it, idx) => `<div class="cmd-item ${idx === activeIdx ? 'active' : ''}" data-cidx="${idx}">
          <span>${esc(it.label)}${it.sub ? ` <span class="pane-sub">· ${esc(it.sub)}</span>` : ''}</span>
          <span class="cmd-kind">${esc(it.kind)}</span>
        </div>`
          )
          .join('')
      : `<div style="padding:18px;text-align:center;color:var(--ink-muted);">无匹配条目</div>`;

    $('#cmdList')
      .querySelectorAll('.cmd-item')
      .forEach((el) => {
        el.addEventListener('click', () => {
          const item = filtered[Number(el.dataset.cidx)];
          closeModal();
          item?.run();
        });
      });
  };

  renderList();
  const inp = $('#cmdSearchInput');
  inp.focus();
  inp.addEventListener('input', () => {
    activeIdx = 0;
    renderList();
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      renderList();
    } else if (e.key === 'Enter' && filtered[activeIdx]) {
      e.preventDefault();
      const item = filtered[activeIdx];
      closeModal();
      item.run();
    }
  });
}
