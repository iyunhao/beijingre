'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const EMPTY = () => ({
  meta: { city: '北京', metric: 'residential', updatedAt: null, lastError: null },
  days: {},
  months: {},
  // 期房 / 现房单日直采数据（与存量房日序列分开存，避免 rebuild 时被覆盖）
  newHomes: {},
  // 可售期房 / 未签约现房「其中住宅套数」库存统计（append-only，按日期索引）
  stocks: {},
});

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return EMPTY();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      meta: { ...EMPTY().meta, ...(raw.meta || {}) },
      days: raw.days || {},
      months: raw.months || {},
      newHomes: raw.newHomes || {},
      stocks: raw.stocks || {},
    };
  } catch (e) {
    console.error('[store] 读取失败，使用空库:', e.message);
    return EMPTY();
  }
}

let cache = null;

function get() {
  if (!cache) cache = load();
  return cache;
}

function save(store) {
  ensureDir();
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
  cache = store;
}

/** 把抓取结果写入库（幂等） */
function upsert(store, { daily = [], monthly = null }) {
  let changed = 0;

  for (const d of daily) {
    if (!d || !d.date) continue;
    const prev = store.days[d.date] || {};
    const next = { ...prev, ...d };
    next.sources = [...new Set([...(prev.sources || []), ...(d.sources || [])])].sort();
    // 只在有实质变化时计数
    if (prev.residential !== next.residential || prev.total !== next.total) changed++;
    store.days[d.date] = next;
  }

  if (monthly) {
    const key = `${monthly.year}-${String(monthly.month).padStart(2, '0')}`;
    store.months[key] = { ...monthly, official: true };
  }

  store.meta.updatedAt = new Date().toISOString();
  return changed;
}

/** 导出为按日期升序的数组 */
function dayList(store) {
  return Object.values(store.days).sort((a, b) => a.date.localeCompare(b.date));
}

function fromSeed() {
  const seedFile = path.join(DATA_DIR, 'seed.json');
  if (!fs.existsSync(seedFile)) return { daily: [], monthly: null };
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  return { daily: seed.daily || [], monthly: seed.monthly || null };
}

/**
 * 读取种子快照（完整 store 结构：{meta, days, months}）。
 * 老格式（{daily:[...]}）也能兼容。
 */
function loadSeed() {
  const seedFile = path.join(DATA_DIR, 'seed.json');
  if (!fs.existsSync(seedFile)) return null;
  try {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    if (seed.days && typeof seed.days === 'object') {
      return {
        meta: { ...EMPTY().meta, ...(seed.meta || {}) },
        days: seed.days,
        months: seed.months || {},
        newHomes: seed.newHomes || {},
        stocks: seed.stocks || {},
      };
    }
    return null;
  } catch (e) {
    console.error('[store] 种子读取失败:', e.message);
    return null;
  }
}

module.exports = { load, get, save, upsert, dayList, fromSeed, loadSeed, STORE_FILE, DATA_DIR };
