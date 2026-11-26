'use strict';

const fs = require('fs');
const path = require('path');
const { isOrderAllowed, normalizeOrder, writeJsonAtomic } = require('./utils');

const MAX_NOTES = 200;
const MEMORY_FILENAME = 'librarian_memory.json';
const LINK_DECAY_GAMMA = 0.95;
const LINK_PRUNE_THRESHOLD = 0.05;
const LINK_STEP = 0.8;

function cleanStr(val, maxLen = 200) {
  return String(val || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeTriggers(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，、;\n]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = cleanStr(item, 40);
    if (!s || s.length < 2) continue;
    const low = s.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(s);
    if (out.length >= 12) break;
  }
  return out;
}

function normalizeRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const nodeId = typeof item === 'string' ? cleanStr(item, 40) : cleanStr(item.node_id, 40);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    out.push({
      node_id: nodeId,
      arc_id: typeof item === 'object' ? cleanStr(item.arc_id, 40) : '',
      title: typeof item === 'object' ? cleanStr(item.title, 80) : '',
      order: typeof item === 'object' ? normalizeOrder(item.order) : null,
    });
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeArcRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const arcId = typeof item === 'string' ? cleanStr(item, 40) : cleanStr(item.arc_id, 40);
    if (!arcId || seen.has(arcId)) continue;
    seen.add(arcId);
    out.push({
      arc_id: arcId,
      title: typeof item === 'object' ? cleanStr(item.title, 80) : '',
      order: typeof item === 'object' ? normalizeOrder(item.order) : null,
    });
    if (out.length >= 5) break;
  }
  return out;
}

function normalizeLinks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw)
    .map(([k, v]) => [cleanStr(k, 64), Number((Number(v) || 0).toFixed(4))])
    .filter(([k, v]) => k && Number.isFinite(v) && v >= LINK_PRUNE_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  return Object.fromEntries(entries);
}

function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topic = cleanStr(raw.topic, 60);
  const refs = normalizeRefs(raw.refs);
  if (!topic || !refs.length) return null;
  const now = new Date().toISOString();
  const triggers = normalizeTriggers(raw.triggers);
  return {
    id: cleanStr(raw.id, 64) || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    topic,
    triggers: triggers.length ? triggers : [topic],
    summary: cleanStr(raw.summary, 180),
    refs,
    arc_refs: normalizeArcRefs(raw.arc_refs),
    links: normalizeLinks(raw.links),
    hits: Math.max(1, Math.floor(Number(raw.hits) || 1)),
    locked: Boolean(raw.locked),
    created_at: cleanStr(raw.created_at, 40) || now,
    updated_at: cleanStr(raw.updated_at, 40) || now,
  };
}

function normalizeMemoryList(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.notes) ? raw.notes : [];
  const out = [];
  const seenIds = new Set();
  for (const item of arr) {
    const n = normalizeNote(item);
    if (!n || seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    out.push(n);
  }
  return pruneNotes(out, MAX_NOTES);
}

function pruneNotes(notes, maxNotes = MAX_NOTES) {
  if (notes.length <= maxNotes) return notes;
  const locked = notes.filter((n) => n.locked);
  const unlocked = notes
    .filter((n) => !n.locked)
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  const keepUnlocked = Math.max(0, maxNotes - locked.length);
  return [...locked, ...unlocked.slice(0, keepUnlocked)];
}

function extractTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = new Set();
  const enWords = s.match(/[a-z0-9_-]{2,}/g) || [];
  for (const w of enWords) tokens.add(w);
  const cjkRuns = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 4) tokens.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function filterRefsByOrder(refs, maxOrder) {
  if (maxOrder === null || maxOrder === undefined) return refs;
  return refs.filter((r) => isOrderAllowed(r.order, maxOrder));
}

function matchLibrarianNotes(notes, queryText, { expandAliases = null, maxOrder = null, limit = 5 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const rawQuery = String(queryText || '').trim();
  if (!list.length || !rawQuery) return [];

  const lowQuery = rawQuery.toLowerCase();
  const expandedTerms = new Set();
  if (typeof expandAliases === 'function') {
    for (const piece of rawQuery.split(/[\s,，、。？！?!:：;；()（）《》「」【】"'`]+/)) {
      const p = piece.trim();
      if (p.length < 2 || p.length > 24) continue;
      for (const alias of expandAliases(p) || []) {
        const a = String(alias || '').trim().toLowerCase();
        if (a.length >= 2) expandedTerms.add(a);
      }
    }
  }
  const expandedHay = expandedTerms.size ? `${lowQuery} ${[...expandedTerms].join(' ')}` : lowQuery;
  const queryTokens = extractTokens(expandedHay);

  const scored = [];
  for (const note of list) {
    const visibleRefs = filterRefsByOrder(note.refs || [], maxOrder);
    if (!visibleRefs.length) continue;

    let score = 0;
    const topicLow = String(note.topic || '').toLowerCase();
    if (topicLow.length >= 2 && (expandedHay.includes(topicLow) || expandedTerms.has(topicLow))) {
      score += 8;
    }

    let triggerHits = 0;
    for (const trig of note.triggers || []) {
      const tLow = String(trig || '').toLowerCase();
      if (tLow.length < 2) continue;
      if (expandedHay.includes(tLow) || expandedTerms.has(tLow)) {
        score += 5;
        triggerHits += 1;
      }
    }

    const noteTokens = extractTokens(`${note.topic} ${(note.triggers || []).join(' ')} ${note.summary || ''}`);
    let overlap = 0;
    for (const tok of noteTokens) {
      if (queryTokens.has(tok)) overlap += 1;
    }
    if (overlap >= 2) {
      score += Math.min(6, overlap * 1.2);
    }

    if (score < 4.5 && triggerHits === 0) continue;
    score += Math.min(2.5, Math.log2(1 + (Number(note.hits) || 1)) * 0.8);
    scored.push({
      note,
      visibleRefs,
      visibleArcRefs: filterRefsByOrder(note.arc_refs || [], maxOrder),
      score: Number(score.toFixed(2)),
    });
  }

  scored.sort((a, b) => b.score - a.score || (b.note.hits || 1) - (a.note.hits || 1));
  const maxOut = Math.max(1, limit);
  const hasGate = maxOrder !== null && maxOrder !== undefined;
  const direct = scored.slice(0, maxOut).map((x) => {
    const trimmed = hasGate && (x.visibleRefs.length < (x.note.refs || []).length || x.visibleArcRefs.length < (x.note.arc_refs || []).length);
    return {
      ...x.note,
      summary: trimmed ? '' : x.note.summary,
      refs: x.visibleRefs,
      arc_refs: x.visibleArcRefs,
      _score: x.score,
    };
  });

  // Co-access associative recall (Horon-inspired): pull up to 2 linked notes if slots remain
  if (direct.length > 0 && direct.length < maxOut) {
    const pickedIds = new Set(direct.map((n) => n.id));
    const byId = new Map(list.map((n) => [n.id, n]));
    const linkedCandidates = [];
    for (const src of direct) {
      for (const [targetId, weight] of Object.entries(src.links || {})) {
        if (pickedIds.has(targetId) || !(weight > 0)) continue;
        const target = byId.get(targetId);
        if (!target) continue;
        const visibleRefs = filterRefsByOrder(target.refs || [], maxOrder);
        if (!visibleRefs.length) continue;
        const visibleArcRefs = filterRefsByOrder(target.arc_refs || [], maxOrder);
        linkedCandidates.push({
          note: target,
          visibleRefs,
          visibleArcRefs,
          weight,
          fromTopic: src.topic,
        });
        pickedIds.add(targetId);
      }
    }
    linkedCandidates.sort((a, b) => b.weight - a.weight || (b.note.hits || 1) - (a.note.hits || 1));
    const slots = Math.min(2, maxOut - direct.length);
    for (const lc of linkedCandidates.slice(0, slots)) {
      const trimmed = hasGate && (lc.visibleRefs.length < (lc.note.refs || []).length || lc.visibleArcRefs.length < (lc.note.arc_refs || []).length);
      direct.push({
        ...lc.note,
        summary: trimmed ? '' : lc.note.summary,
        refs: lc.visibleRefs,
        arc_refs: lc.visibleArcRefs,
        _score: Number((1 + Math.min(2, lc.weight * 0.5)).toFixed(2)),
        _linked_from: lc.fromTopic,
      });
    }
  }
  return direct;
}

function formatLibrarianHints(matchedNotes) {
  if (!Array.isArray(matchedNotes) || !matchedNotes.length) return '';
  const lines = matchedNotes.map((n) => {
    const refText = (n.refs || [])
      .slice(0, 6)
      .map((r) => `${r.node_id}${r.order !== null && r.order !== undefined ? `(序${r.order})` : ''}`)
      .join(', ');
    const sum = n.summary ? `：${n.summary}` : '';
    const linkTag = n._linked_from ? `|关联←《${n._linked_from}》` : '';
    const arcText = (n.arc_refs || []).length
      ? ` | 宏观卷: ${(n.arc_refs || []).slice(0, 5).map((a) => a.arc_id).join(', ')}`
      : '';
    return `- 《${n.topic}》[命中${n.hits || 1}次${linkTag}]${sum} -> 原文节点: ${refText}${arcText}`;
  });
  return `【图书馆管理员笔记（过往查证过的直达索引；若与当前问题相关，首轮可直接对所列节点调 read_scene 核实原文，切勿不读原文直接照搬）】\n${lines.join('\n')}`;
}

function deriveNoteFromSearch({ parsedMemoryNote, guide, scenes, outlines = [], forcedFinal = false }) {
  if (forcedFinal || !Array.isArray(scenes) || !scenes.length) return null;
  const refs = scenes.slice(0, 10).map((s) => ({
    node_id: String(s.node_id || ''),
    arc_id: String(s.arc_id || ''),
    title: cleanStr(s.title || s.arc_title || '', 80),
    order: normalizeOrder(s.order),
  })).filter((r) => r.node_id);
  if (!refs.length) return null;

  const mn = parsedMemoryNote && typeof parsedMemoryNote === 'object' ? parsedMemoryNote : null;
  const topic = mn ? cleanStr(mn.topic, 60) : '';
  if (topic.length < 2) return null;
  const arcRefs = normalizeArcRefs(
    (Array.isArray(outlines) ? outlines : []).map((o) => ({
      arc_id: o?.arc_id,
      title: o?.title,
      order: o?.order,
    }))
  );
  return {
    topic,
    triggers: normalizeTriggers(mn.triggers),
    summary: cleanStr(mn.summary || guide, 180),
    refs,
    arc_refs: arcRefs,
  };
}

function refOverlapRatio(aRefs, bRefs) {
  const aSet = new Set((aRefs || []).map((r) => r.node_id));
  const bSet = new Set((bRefs || []).map((r) => r.node_id));
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const id of aSet) {
    if (bSet.has(id)) inter += 1;
  }
  const union = aSet.size + bSet.size - inter;
  return union > 0 ? inter / union : 0;
}

function reinforceCoAccessLinks(notes, savedId, matchedIds) {
  const peerIds = [...new Set((matchedIds || []).filter((id) => id && id !== savedId))];
  if (!peerIds.length) return notes;
  const peerSet = new Set(peerIds);
  const delta = LINK_STEP / peerIds.length;
  const decayAll = (linksObj) => {
    const out = {};
    for (const [k, v] of Object.entries(linksObj || {})) {
      const decayed = Number(v) * LINK_DECAY_GAMMA;
      if (decayed >= LINK_PRUNE_THRESHOLD) out[k] = decayed;
    }
    return out;
  };
  return notes.map((n) => {
    if (n.id === savedId) {
      const nextLinks = decayAll(n.links);
      for (const pid of peerIds) nextLinks[pid] = (nextLinks[pid] || 0) + delta;
      return { ...n, links: normalizeLinks(nextLinks) };
    }
    if (peerSet.has(n.id)) {
      const nextLinks = decayAll(n.links);
      nextLinks[savedId] = (nextLinks[savedId] || 0) + delta;
      return { ...n, links: normalizeLinks(nextLinks) };
    }
    return n;
  });
}

function recordLibrarianNote(notes, candidate, { matchedIds = [], maxNotes = MAX_NOTES } = {}) {
  const list = normalizeMemoryList(notes);
  const now = new Date().toISOString();
  const cand = normalizeNote(candidate);
  if (!cand) return { notes: list, saved: null };

  const matchedSet = new Set(Array.isArray(matchedIds) ? matchedIds : []);
  let targetIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < list.length; i++) {
    const existing = list[i];
    const sameTopic = existing.topic.toLowerCase() === cand.topic.toLowerCase();
    const overlap = refOverlapRatio(existing.refs, cand.refs);
    const wasMatched = matchedSet.has(existing.id);
    let score = 0;
    if (sameTopic) score += 10;
    if (overlap >= 0.6) score += 6 + overlap;
    else if (wasMatched && overlap >= 0.4) score += 5 + overlap;
    if (score > bestScore) {
      bestScore = score;
      targetIdx = i;
    }
  }

  if (targetIdx >= 0) {
    const cur = list[targetIdx];
    const next = cur.locked
      ? {
          ...cur,
          hits: (cur.hits || 1) + 1,
          updated_at: now,
        }
      : {
          ...cur,
          topic: cur.topic,
          triggers: normalizeTriggers([...(cur.triggers || []), ...(cand.triggers || [])]),
          summary: cand.summary && cand.summary.length >= cur.summary.length ? cand.summary : cur.summary,
          refs: normalizeRefs([...(cur.refs || []), ...(cand.refs || [])]),
          arc_refs: normalizeArcRefs([...(cur.arc_refs || []), ...(cand.arc_refs || [])]),
          hits: (cur.hits || 1) + 1,
          updated_at: now,
        };
    const updated = [...list];
    updated[targetIdx] = next;
    const linked = reinforceCoAccessLinks(updated, next.id, matchedIds);
    return {
      notes: pruneNotes(linked, maxNotes),
      saved: { id: next.id, topic: next.topic, hits: next.hits, action: cur.locked ? 'hit' : 'merged' },
    };
  }

  const created = { ...cand, hits: 1, created_at: now, updated_at: now };
  const linked = reinforceCoAccessLinks([created, ...list], created.id, matchedIds);
  const nextList = pruneNotes(linked, maxNotes);
  return {
    notes: nextList,
    saved: { id: created.id, topic: created.topic, hits: 1, action: 'created' },
  };
}

function applyMemoryAction(notes, payload = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const list = normalizeMemoryList(notes);
  const action = String(body.action || '').trim().toLowerCase();
  const id = cleanStr(body.id, 64);

  if (action === 'clear') {
    const keepLocked = body.includeLocked ? [] : list.filter((n) => n.locked);
    return { notes: keepLocked, changed: list.length - keepLocked.length };
  }

  if (action === 'delete' && id) {
    const next = list.filter((n) => n.id !== id);
    return { notes: next, changed: list.length - next.length };
  }

  if (action === 'toggle_lock' && id) {
    let changed = 0;
    const next = list.map((n) => {
      if (n.id !== id) return n;
      changed = 1;
      return { ...n, locked: body.locked !== undefined ? Boolean(body.locked) : !n.locked };
    });
    return { notes: next, changed };
  }

  if (action === 'upsert') {
    const rawNote = body.note && typeof body.note === 'object' ? body.note : body;
    const incoming = normalizeNote({
      ...rawNote,
      id: id || rawNote.id,
    });
    if (!incoming) {
      throw new Error('笔记至少需要主题与 1 个原文节点引用');
    }
    const idx = list.findIndex((n) => n.id === incoming.id);
    const next = [...list];
    if (idx >= 0) {
      const existing = list[idx];
      next[idx] = {
        ...existing,
        ...incoming,
        hits: rawNote.hits !== undefined ? incoming.hits : existing.hits,
        locked: rawNote.locked !== undefined ? incoming.locked : existing.locked,
        updated_at: new Date().toISOString(),
      };
    } else {
      next.unshift(incoming);
    }
    return { notes: pruneNotes(next, MAX_NOTES), changed: 1, note: idx >= 0 ? next[idx] : incoming };
  }

  throw new Error(`不支持的操作: ${action || 'empty'}`);
}

function getMemoryFilePath(corpusDir) {
  return path.join(corpusDir, MEMORY_FILENAME);
}

function loadLibrarianMemory(corpusDir) {
  if (!corpusDir) return [];
  const fp = getMemoryFilePath(corpusDir);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return normalizeMemoryList(raw);
  } catch (err) {
    console.warn(`[librarian_memory] Failed to parse ${fp}: ${err.message}`);
    return [];
  }
}

function saveLibrarianMemory(corpusDir, notes) {
  if (!corpusDir) return [];
  const clean = normalizeMemoryList(notes);
  const fp = getMemoryFilePath(corpusDir);
  writeJsonAtomic(fp, { version: 1, updated_at: new Date().toISOString(), notes: clean });
  return clean;
}

module.exports = {
  MAX_NOTES,
  MEMORY_FILENAME,
  normalizeNote,
  normalizeMemoryList,
  matchLibrarianNotes,
  formatLibrarianHints,
  deriveNoteFromSearch,
  recordLibrarianNote,
  applyMemoryAction,
  getMemoryFilePath,
  loadLibrarianMemory,
  saveLibrarianMemory,
};
