'use strict';

const fs = require('fs');

function createGraphEngine(graphPath) {
  let edges = [];
  let entities = [];

  if (graphPath && fs.existsSync(graphPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      if (Array.isArray(raw)) {
        edges = raw.filter((e) => e && e.s && e.r && e.o);
        const set = new Set();
        for (const e of edges) {
          set.add(String(e.s));
          set.add(String(e.o));
        }
        entities = [...set].sort((a, b) => b.length - a.length);
      }
    } catch (err) {
      console.warn('[graph-engine] failed to load', graphPath, err.message);
    }
  }

  function lookup(text, limit = 10, perEnt = 4) {
    if (!edges.length || !text) return [];
    const hay = String(text);
    const hits = new Set();
    for (const ent of entities) {
      if (ent.length >= 2 && hay.includes(ent)) hits.add(ent);
    }
    if (!hits.size) return [];

    const counts = new Map();
    const out = [];
    for (const e of edges) {
      const matched = hits.has(e.s) ? e.s : hits.has(e.o) ? e.o : null;
      if (!matched) continue;
      const cur = counts.get(matched) || 0;
      if (cur >= perEnt) continue;
      counts.set(matched, cur + 1);
      out.push(`${e.s} -[${e.r}]-> ${e.o}${e.w > 1 ? `(×${e.w})` : ''}`);
      if (out.length >= limit) break;
    }
    return out;
  }

  return {
    edgeCount: edges.length,
    entityCount: entities.length,
    lookup,
  };
}

module.exports = { createGraphEngine };
