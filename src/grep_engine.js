'use strict';

const { isOrderAllowed, escapeRegExp } = require('./utils');

function buildAliasMap(aliasGroups) {
  const map = new Map();
  for (const grp of Array.isArray(aliasGroups) ? aliasGroups : []) {
    if (!Array.isArray(grp) || !grp.length) continue;
    const clean = grp.map((x) => String(x || '').trim()).filter(Boolean);
    if (!clean.length) continue;
    for (const item of clean) {
      const lower = item.toLowerCase();
      const prev = map.get(lower) || [];
      const merged = [...new Set([...prev, ...clean])];
      map.set(lower, merged);
    }
  }
  return map;
}

function createLangDetectors(corpusConfig) {
  const excludes = (corpusConfig?.grep?.english_exclude_terms || [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .map(escapeRegExp);
  const enRe = excludes.length
    ? new RegExp(`\\b(?!(?:${excludes.join('|')})\\b)[A-Za-z]{2,}(?:\\s+[A-Za-z]{2,}){2,}\\b`, 'g')
    : /\b[A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){2,}\b/g;

  return [
    { kw: /^(?:俄语|俄文|西里尔|russian|cyrillic)$/i, label: 'Russian', re: /[А-Яа-яЁё]{2,}/g },
    {
      kw: /^(?:法语|法文|french)$/i,
      label: 'French',
      re: /(?:[A-Za-z]*[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017FœŒ]+[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017FœŒ]*|\b(?:bonjour|merci|au\s+revoir|mademoiselle|monsieur|voil[àa])\b)/gi,
    },
    {
      kw: /^(?:德语|德文|german)$/i,
      label: 'German',
      re: /(?:[A-Za-z]*[äöüßÄÖÜ]+[A-Za-zäöüßÄÖÜ]*|\b(?:danke|guten|jawohl|auf\s+wiedersehen)\b)/gi,
    },
    {
      kw: /^(?:意大利语|意大利文|意语|italian)$/i,
      label: 'Italian',
      re: /\b(?:fiorin|fiorello|ciao|grazie|arrivederci)\b/gi,
    },
    { kw: /^(?:英语|英文|english)$/i, label: 'English', re: enRe },
    { kw: /^(?:日语|日文|japanese)$/i, label: 'Japanese', re: /[\u3040-\u309F\u30A0-\u30FF]{2,}/g },
    { kw: /^(?:韩语|韩文|korean)$/i, label: 'Korean', re: /[\uAC00-\uD7AF\u1100-\u11FF]{2,}/g },
  ];
}

function buildOrderBuckets(pool) {
  const numeric = pool.filter((h) => h.order !== null && h.order !== undefined && Number.isFinite(Number(h.order)));
  if (!numeric.length) return { buckets: [], nonNumeric: pool };

  let minOrd = Infinity;
  let maxOrd = -Infinity;
  for (const h of numeric) {
    const ord = Number(h.order);
    if (ord < minOrd) minOrd = ord;
    if (ord > maxOrd) maxOrd = ord;
  }

  const nonNumeric = pool.filter((h) => h.order === null || h.order === undefined || !Number.isFinite(Number(h.order)));
  if (maxOrd <= minOrd) {
    return {
      buckets: [{ min_order: minOrd, max_order: maxOrd, items: numeric }],
      nonNumeric,
    };
  }

  const bucketCount = Math.min(8, Math.max(5, Math.ceil(numeric.length / 4)));
  const span = maxOrd - minOrd + 1;
  const step = span / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, idx) => {
    const bMin = Math.floor(minOrd + idx * step);
    const bMax = idx === bucketCount - 1 ? maxOrd : Math.max(bMin, Math.floor(minOrd + (idx + 1) * step) - 1);
    return { min_order: bMin, max_order: bMax, items: [] };
  });

  for (const h of numeric) {
    const ord = Number(h.order);
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ord - minOrd) / step)));
    buckets[idx].items.push(h);
  }

  return { buckets, nonNumeric };
}

function orderMatchedHits(pool, sortBy) {
  const byRelevance = (a, b) => b.groups_hit - a.groups_hit || b.match_count - a.match_count;

  if (sortBy === 'diversity') {
    const { buckets, nonNumeric } = buildOrderBuckets(pool);
    for (const b of buckets) {
      b.items.sort((a, bItem) => byRelevance(a, bItem) || (a.cameo === bItem.cameo ? 0 : a.cameo ? -1 : 1));
    }
    const ordered = [];
    let round = 0;
    let added = true;
    while (added) {
      added = false;
      for (const b of buckets) {
        if (round < b.items.length) {
          ordered.push(b.items[round]);
          added = true;
        }
      }
      round += 1;
    }
    if (nonNumeric.length) {
      ordered.push(...[...nonNumeric].sort(byRelevance));
    }
    return ordered;
  }

  if (sortBy === 'rarity') {
    const arcFreq = new Map();
    for (const h of pool) {
      arcFreq.set(h.arc_id, (arcFreq.get(h.arc_id) || 0) + 1);
    }
    return [...pool].sort(
      (a, b) =>
        b.groups_hit - a.groups_hit ||
        (arcFreq.get(a.arc_id) || 0) - (arcFreq.get(b.arc_id) || 0) ||
        a.match_count - b.match_count ||
        (Number(a.order ?? 0) - Number(b.order ?? 0)),
    );
  }

  const cameos = pool.filter((x) => x.cameo).sort(byRelevance);
  const mains = pool.filter((x) => !x.cameo).sort(byRelevance);
  const ordered = [];
  const seenIds = new Set();
  const arcCounts = new Map();

  for (const h of cameos.slice(0, 12)) {
    ordered.push(h);
    seenIds.add(h.node_id);
    arcCounts.set(h.arc_id, (arcCounts.get(h.arc_id) || 0) + 1);
  }
  for (const passLimit of [2, Infinity]) {
    for (const h of mains) {
      if (seenIds.has(h.node_id)) continue;
      if ((arcCounts.get(h.arc_id) || 0) >= passLimit) continue;
      ordered.push(h);
      seenIds.add(h.node_id);
      arcCounts.set(h.arc_id, (arcCounts.get(h.arc_id) || 0) + 1);
    }
  }
  for (const h of cameos) {
    if (!seenIds.has(h.node_id)) {
      ordered.push(h);
      seenIds.add(h.node_id);
    }
  }
  return ordered;
}

function createGrepEngine(searchableScenes, corpusConfig) {
  const aliasGroups = Array.isArray(corpusConfig?.aliases) ? corpusConfig.aliases : [];
  const aliasMap = buildAliasMap(aliasGroups);
  const langDetectors = createLangDetectors(corpusConfig);

  function expandAliases(term) {
    const t = String(term || '').trim();
    if (!t) return [];
    const matched = aliasMap.get(t.toLowerCase());
    return matched ? [...matched] : [t];
  }

  function grepScenes(rawQuery, options = {}) {
    const opts = typeof options === 'number' ? { limit: options } : options || {};
    const limit = Math.min(Math.max(Number(opts.limit) || 24, 1), 100);
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const rawSortBy = String(opts.sort_by || opts.sortBy || 'relevance').trim().toLowerCase();
    const sortBy = rawSortBy === 'diversity' || rawSortBy === 'rarity' ? rawSortBy : 'relevance';
    const maxOrder = opts.maxOrder ?? null;
    const categoryFilter = String(opts.category || '').trim();
    const toneFilter = String(opts.tone || '').trim().toLowerCase();

    const tG0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const q = String(rawQuery || '').trim();
    if (!q) {
      return {
        took_ms: 0,
        total: 0,
        cameo_count: 0,
        all_matched: false,
        sort_by: sortBy,
        offset,
        limit,
        has_more: false,
        next_offset: null,
        buckets: [],
        hits: [],
      };
    }

    const rawTokens = q
      .split(/[\s,，、]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const groups = rawTokens.map((tk) => {
      const ld = langDetectors.find((d) => d.kw.test(tk));
      if (ld) return { kind: 'regex', label: ld.label, re: ld.re, terms: [] };
      return { kind: 'terms', terms: expandAliases(tk).map((a) => a.toLowerCase()) };
    });

    if (!groups.length) {
      return {
        took_ms: 0,
        total: 0,
        cameo_count: 0,
        all_matched: false,
        sort_by: sortBy,
        offset,
        limit,
        has_more: false,
        next_offset: null,
        buckets: [],
        hits: [],
      };
    }

    const flatAliases = [...new Set(groups.flatMap((g) => g.terms))];
    const activeRegexes = groups.filter((g) => g.kind === 'regex').map((g) => g.re);

    const eligible = searchableScenes.filter((sc) => {
      if (!isOrderAllowed(sc.order, maxOrder)) return false;
      if (categoryFilter && sc.category !== categoryFilter) return false;
      if (toneFilter && !(sc.tone_tags || []).some((t) => String(t).toLowerCase().includes(toneFilter))) {
        return false;
      }
      return true;
    });

    const collectHits = (requireAll) => {
      const matched = [];
      for (const sc of eligible) {
        let groupsHit = 0;
        let totalOccurrences = 0;
        const matchedTerms = [];

        for (const grp of groups) {
          let grpCount = 0;
          if (grp.kind === 'regex') {
            grp.re.lastIndex = 0;
            const ms = sc.cleanText.match(grp.re);
            if (ms && ms.length) {
              grpCount = ms.length;
              if (!matchedTerms.includes(grp.label)) matchedTerms.push(grp.label);
            }
          } else {
            for (const term of grp.terms) {
              let idx = sc.lowerText.indexOf(term);
              if (idx >= 0) {
                if (!matchedTerms.includes(term)) matchedTerms.push(term);
                while (idx >= 0) {
                  grpCount += 1;
                  idx = sc.lowerText.indexOf(term, idx + term.length);
                }
              } else if (sc.lowerTitle.includes(term)) {
                grpCount += 1;
                if (!matchedTerms.includes(term)) matchedTerms.push(term);
              }
            }
          }
          if (grpCount > 0) {
            groupsHit += 1;
            totalOccurrences += grpCount;
          }
        }

        if (groupsHit === 0 || (requireAll && groupsHit < groups.length)) continue;

        const inMeta = !activeRegexes.length && flatAliases.some((a) => sc.metaHay.includes(a));
        const cameo = !inMeta;

        const snippets = [];
        const usedLine = new Set();
        for (let i = 0; i < sc.lines.length; i++) {
          const line = sc.lines[i];
          const low = line.toLowerCase();
          const lineHit =
            flatAliases.some((a) => low.includes(a)) ||
            activeRegexes.some((re) => {
              re.lastIndex = 0;
              return re.test(line);
            });
          if (lineHit) {
            const lo = Math.max(0, i - 1);
            const hi = Math.min(sc.lines.length - 1, i + 1);
            const win = [];
            for (let j = lo; j <= hi; j++) {
              if (!usedLine.has(j)) {
                win.push(sc.lines[j]);
                usedLine.add(j);
              }
            }
            if (win.length) snippets.push(win.join(' / '));
            if (snippets.length >= 2) break;
          }
        }

        matched.push({
          node_id: sc.node_id,
          arc_id: sc.arc_id,
          arc_title: sc.arc_title,
          series: sc.series || '',
          category: sc.category,
          title: sc.title,
          order: sc.order ?? null,
          tone_tags: sc.tone_tags || [],
          chars: sc.chars,
          groups_hit: groupsHit,
          match_count: totalOccurrences,
          cameo,
          matched_terms: matchedTerms.slice(0, 4),
          snippet: snippets.join('  …  ').slice(0, 260),
        });
      }
      return matched;
    };

    let allMatched = true;
    let pool = collectHits(true);
    if (!pool.length && groups.length > 1) {
      allMatched = false;
      pool = collectHits(false);
    }

    const cameosCount = pool.reduce((acc, x) => acc + (x.cameo ? 1 : 0), 0);
    const ordered = orderMatchedHits(pool, sortBy);
    const picked = ordered.slice(offset, offset + limit);
    const hasMore = offset + picked.length < ordered.length;
    const nextOffset = hasMore ? offset + picked.length : null;
    const { buckets: rawBuckets } = buildOrderBuckets(pool);
    const buckets = rawBuckets
      .filter((b) => b.items.length > 0)
      .map((b) => ({
        min_order: b.min_order,
        max_order: b.max_order,
        count: b.items.length,
      }));

    const dt = Number((((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())) - tG0).toFixed(2));
    return {
      took_ms: dt,
      total: pool.length,
      cameo_count: cameosCount,
      all_matched: allMatched,
      sort_by: sortBy,
      offset,
      limit,
      has_more: hasMore,
      next_offset: nextOffset,
      buckets,
      hits: picked,
    };
  }

  return {
    expandAliases,
    grepScenes,
  };
}

module.exports = { createGrepEngine, buildAliasMap };
