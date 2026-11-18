'use strict';

/**
 * 「官方最新一日」采集存档（append-only，按日期去重）。
 *
 * 为什么需要它：住建委官方页一次只公示「最新一天」，没有逐日历史接口；
 * 线上沙箱会冷启动 / 回收进程，进程内定时器不可靠，漏采的那一天事后无法回补。
 * 因此每采到一个官方日就立刻落盘，本机与线上各存一份：
 *   · 线上进程自己采到 → 写线上这份
 *   · 每日定时任务在本机跑 → 直接抓官方页 + 拉取线上 /api/capture 合并回本机
 * rebuild 会把存档注入日序列，此后该日（含周末）永远是官方真实值，
 * 不会再退回 SAT_RATIO 的 70/30 估算。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'capture-archive.json');

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && j.days && typeof j.days === 'object') return j;
  } catch (_) { /* 不存在 / 损坏 → 新建 */ }
  return { days: {}, updatedAt: null };
}

/** 写入/更新一条官方直采记录；返回 true 表示确有新增或变更 */
function upsert(rec) {
  if (!rec || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '')) return false;
  if (rec.residential == null || !Number.isFinite(Number(rec.residential))) return false;
  const db = read();
  const prev = db.days[rec.date];
  const next = {
    date: rec.date,
    residential: Number(rec.residential),
    total: rec.total == null ? null : Number(rec.total),
    residentialArea: rec.residentialArea == null ? null : Number(rec.residentialArea),
    totalArea: rec.totalArea == null ? null : Number(rec.totalArea),
    source: rec.source || 'zjw',
    capturedAt: new Date().toISOString(),
  };
  if (prev && prev.residential === next.residential && prev.total === next.total) return false;
  db.days[rec.date] = next;
  db.updatedAt = next.capturedAt;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    return true;
  } catch (e) {
    console.error('[captureArchive] 写入失败:', e.message);
    return false;
  }
}

/** 批量合并（用于把线上 /api/capture 的记录并回本机） */
function mergeMany(records) {
  let n = 0;
  for (const r of Object.values(records || {})) if (upsert(r)) n++;
  return n;
}

function expand() {
  return read().days;
}

/** 漏采检测：相邻两条采集日期间隔 > 1 天即记为缺口 */
function gaps() {
  const keys = Object.keys(read().days).sort();
  const out = [];
  for (let i = 1; i < keys.length; i++) {
    const a = new Date(keys[i - 1] + 'T00:00:00Z');
    const b = new Date(keys[i] + 'T00:00:00Z');
    const d = Math.round((b - a) / 86400000);
    if (d > 1) out.push({ from: keys[i - 1], to: keys[i], missedDays: d - 1 });
  }
  return out;
}

module.exports = { FILE, read, upsert, mergeMany, expand, gaps };
