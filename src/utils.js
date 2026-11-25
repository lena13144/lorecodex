'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let cachedPythonBin = null;

function detectPythonBin() {
  if (cachedPythonBin) return cachedPythonBin;
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) {
    cachedPythonBin = envBin;
    return cachedPythonBin;
  }
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0 && String(res.stdout || '').trim() === '3') {
        cachedPythonBin = cmd;
        return cachedPythonBin;
      }
    } catch (_) {}
  }
  cachedPythonBin = process.platform === 'win32' ? 'python' : 'python3';
  return cachedPythonBin;
}

function stripMarkup(text) {
  return String(text || '')
    .replace(/<\/?(?:color|size|b|i|u|s|ruby|rt)(?:=[^>]*)?>/gi, '')
    .replace(/\r\n/g, '\n');
}

function extractJsonObject(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch (_) {}
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function compilePatterns(patterns, fallback = []) {
  const source = Array.isArray(patterns) && patterns.length ? patterns : fallback;
  const out = [];
  for (const item of source) {
    if (!item) continue;
    try {
      if (item instanceof RegExp) {
        out.push(item);
      } else if (typeof item === 'object' && item.pattern) {
        out.push(new RegExp(String(item.pattern), String(item.flags || 'i')));
      } else {
        out.push(new RegExp(String(item), 'i'));
      }
    } catch (err) {
      console.warn('[utils] invalid regex pattern skipped:', item, err.message);
    }
  }
  return out;
}

function normalizeOrder(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function isOrderAllowed(order, maxOrder) {
  const limit = normalizeOrder(maxOrder);
  if (limit === null) return true;
  if (order === null || order === undefined || order === '') return true;
  const n = Number(order);
  if (!Number.isFinite(n)) return true;
  return n <= limit;
}

function formatCharCount(n) {
  const num = Number(n) || 0;
  if (num >= 10000) {
    return `${(num / 10000).toFixed(1)} 万字`;
  }
  return `${num.toLocaleString()} 字`;
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
}

module.exports = {
  detectPythonBin,
  stripMarkup,
  extractJsonObject,
  compilePatterns,
  normalizeOrder,
  isOrderAllowed,
  formatCharCount,
  escapeRegExp,
  writeJsonAtomic,
};
