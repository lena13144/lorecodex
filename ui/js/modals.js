import { $, esc, prefs, savePrefs, applyPrefs, showToast, state, actions } from './state.js';
import {
  fetchConfig,
  saveConfig,
  fetchModels,
  fetchCorpusDetail,
  saveCorpusConfig,
  importCorpus,
  upgradeCorpus,
  fetchJob,
  fetchCorpora,
} from './api.js';

let activeModalPoll = null;
function clearModalPoll() {
  if (activeModalPoll) {
    clearInterval(activeModalPoll);
    activeModalPoll = null;
  }
}

function startModalJobPoll({ jobId, logsEl, statusEl, runningText, onDone, onError }) {
  clearModalPoll();
  activeModalPoll = setInterval(async () => {
    try {
      const jr = await fetchJob(jobId);
      const job = jr.job;
      if (logsEl) {
        logsEl.textContent = (job.logs || []).join('\n');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
      if (job.status === 'done') {
        clearModalPoll();
        if (onDone) await onDone(job);
      } else if (job.status === 'error') {
        clearModalPoll();
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
            <label class="fld">单次输出 Max Tokens（留空/0 = 不限制）</label>
            <input id="cfgMaxTokens" type="number" min="0" step="256" value="${Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : ''}" placeholder="沿用模型默认" />
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
        const patch = {
          chatBase: $('#cfgBase').value.trim(),
          chatModel: $('#cfgModel').value.trim(),
          defaultCorpus: $('#cfgDefaultCorpus').value,
          maxTokens: Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? Math.floor(rawMaxTokens) : null,
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
          <div class="fld-row-2">
            <div class="fld-group">
              <label class="fld">目标分卷范围</label>
              <select id="ccUpgSeries" class="fld-sel">${seriesOptions}</select>
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
          <div>
            <button id="ccUpgStartBtn" type="button" class="btn-seal">开始原地补全 LLM 目录</button>
          </div>
          <div id="ccUpgJobWrap" style="display:none;flex-direction:column;gap:6px;">
            <div id="ccUpgJobStatus" style="font-size:12px;font-weight:600;">准备补全...</div>
            <div id="ccUpgJobLogs" class="job-logs"></div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <a href="/corpora/${encodeURIComponent(c.id)}/export" download="${esc(c.id)}.lorepack.json" class="btn-sm" style="margin-right:auto;text-decoration:none;color:var(--ink-soft);border:1px solid var(--rule-strong);padding:5px 9px;border-radius:var(--radius);" title="导出为单个 .lorepack.json 文件，可直接导入 TauriTavern / 手机内置免服务端引擎">导出 .lorepack.json</a>
        <button data-close-modal>取消</button>
        <button id="ccSaveBtn" class="btn-seal">保存并热重载语料</button>
      </div>
    `;

    $('#modalDialog').querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
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

    $('#ccUpgStartBtn')?.addEventListener('click', async () => {
      const upgBtn = $('#ccUpgStartBtn');
      upgBtn.disabled = true;
      $('#ccUpgJobWrap').style.display = 'flex';
      $('#ccUpgJobStatus').textContent = '正在提交 LLM 目录补全任务...';
      try {
        const res = await upgradeCorpus(c.id, {
          series: $('#ccUpgSeries').value,
          limitArcs: Math.max(0, Number($('#ccUpgLimit').value) || 0),
          skipMeta: !$('#ccUpgSynthMeta').checked,
          force: $('#ccUpgForce').checked,
        });
        startModalJobPoll({
          jobId: res.job.id,
          logsEl: $('#ccUpgJobLogs'),
          statusEl: $('#ccUpgJobStatus'),
          runningText: () => '正在执行 LLM 目录补全（可切回主页面或稍候）...',
          onDone: async () => {
            $('#ccUpgJobStatus').textContent = '补全完成！正在热重载书库索引...';
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
            $('#ccUpgCoverage').innerHTML = `当前 LLM 目录覆盖度：<b>${newLlm}</b> / ${newTot} 幕（已完成本轮补全并重载，新增别名与设定已同步至左侧标签页）`;
            showToast(`书库「${c.id}」LLM 目录补全完成！`, 'ok');
            upgBtn.disabled = false;
          },
          onError: () => {
            upgBtn.disabled = false;
          },
        });
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
        <div class="pane-sub">支持长篇小说 (.txt / .md / .epub) 或 SillyTavern 世界书 / 离散设定 (.json / .jsonl)</div>
        <div id="impFileInfo" style="margin-top:8px;font-family:var(--mono);font-size:11.5px;color:var(--seal);"></div>
        <input id="impFileInput" type="file" accept=".txt,.md,.epub,.json,.jsonl" style="display:none;" />
      </div>

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

      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input id="impUseLlm" type="checkbox" />
          <span>启用 LLM 并发摘要（取消则离线秒级启发式建树）</span>
        </label>
      </div>

      <div id="impJobWrap" style="display:none;flex-direction:column;gap:6px;">
        <div id="impJobStatus" style="font-size:12px;font-weight:600;">准备构建...</div>
        <div id="impJobLogs" class="job-logs"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button id="impDoneSwitchBtn" class="btn-seal" style="display:none;">立即打开新书库</button>
      <button data-close-modal>关闭</button>
      <button id="impStartBtn" class="btn-seal">开始上传并建树</button>
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
  $('#impKind').addEventListener('change', updateModeUi);

  const handleFile = (file) => {
    if (!file) return;
    selectedFile = file;
    $('#impFileInfo').textContent = `已选择: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    const lower = file.name.toLowerCase();
    const stem = file.name.replace(/\.[^.]+$/, '');
    const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom-book';
    if (!$('#impCorpusId').value.trim()) $('#impCorpusId').value = slug;
    if (!$('#impName').value.trim()) $('#impName').value = stem;
    if (lower.endsWith('.json') || lower.endsWith('.jsonl')) $('#impKind').value = 'lore';
    else $('#impKind').value = 'novel';
    updateModeUi();
  };

  const dz = $('#impDropzone');
  const fi = $('#impFileInput');
  dz.addEventListener('click', () => fi.click());
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
    if (!selectedFile) return showToast('请先选择或拖入一个文件', 'err');
    const corpusId = $('#impCorpusId').value.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(corpusId)) {
      return showToast('书库 ID 仅支持英文/数字/连字符', 'err');
    }
    const startBtn = $('#impStartBtn');
    startBtn.disabled = true;
    $('#impJobWrap').style.display = 'flex';
    $('#impJobStatus').textContent = '正在上传文件并启动建树任务...';

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
        filterGameStats: $('#impFilterStats').checked,
      });

      const jobId = res.job.id;
      const targetId = res.job.corpusId;
      startModalJobPoll({
        jobId,
        logsEl: $('#impJobLogs'),
        statusEl: $('#impJobStatus'),
        runningText: (job) => `正在运行 (${job.kind})...`,
        onDone: async () => {
          $('#impJobStatus').textContent = `构建完成！书库 "${targetId}" 已入库`;
          const listRes = await fetchCorpora();
          state.corpora = listRes.corpora || [];
          showToast(`书库「${targetId}」导入建树成功！`, 'ok');
          const switchBtn = $('#impDoneSwitchBtn');
          switchBtn.style.display = 'inline-flex';
          switchBtn.onclick = async () => {
            await actions.switchCorpus?.(targetId);
            cleanupClose();
          };
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
