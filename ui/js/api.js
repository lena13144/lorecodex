async function reqJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return data;
}

export function fetchHealth() {
  return reqJson('/health');
}

export function fetchCorpora() {
  return reqJson('/corpora');
}

export function reloadCorpora() {
  return reqJson('/corpora/reload', { method: 'POST' });
}

export function fetchCorpusDetail(id) {
  return reqJson(`/corpora/${encodeURIComponent(id)}`);
}

export function saveCorpusConfig(id, patch) {
  return reqJson(`/corpora/${encodeURIComponent(id)}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function fetchTreeIndex(corpusId, maxOrder = 0) {
  const mo = maxOrder > 0 ? `&maxOrder=${maxOrder}` : '';
  return reqJson(`/tree-index?corpus=${encodeURIComponent(corpusId)}${mo}`);
}

export function fetchSceneText(corpusId, nodeId, maxOrder = 0) {
  const mo = maxOrder > 0 ? `&maxOrder=${maxOrder}` : '';
  return reqJson(`/tree-scene?corpus=${encodeURIComponent(corpusId)}&id=${encodeURIComponent(nodeId)}${mo}`);
}

export function fetchGrep(corpusId, { q, limit = 40, category = '', tone = '', maxOrder = 0 }) {
  const params = new URLSearchParams({
    corpus: corpusId,
    q: q || '',
    limit: String(limit),
  });
  if (category && category !== '全部') params.set('category', category);
  if (tone && tone !== '全部') params.set('tone', tone);
  if (maxOrder > 0) params.set('maxOrder', String(maxOrder));
  return reqJson(`/tree-grep?${params.toString()}`);
}

export function fetchRuns() {
  return reqJson('/tree-runs');
}

export function runTreeSearch(payload) {
  return reqJson('/tree-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function fetchConfig() {
  return reqJson('/config');
}

export function saveConfig(patch) {
  return reqJson('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function fetchModels(baseUrl, apiKey) {
  return reqJson('/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey }),
  });
}

export function importCorpus(payload) {
  return reqJson('/corpora/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function upgradeCorpus(id, payload) {
  return reqJson(`/corpora/${encodeURIComponent(id)}/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

export function fetchJob(jobId) {
  return reqJson(`/jobs/${encodeURIComponent(jobId)}`);
}
