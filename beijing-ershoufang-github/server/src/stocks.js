'use strict';

/**
 * 「可售期房统计 / 未签约现房统计 · 其中住宅套数」库存统计集合（db.stocks，按日期索引）。
 *
 * 与「期房/现房网上签约」不同，这是**存量**口径：某一天市场上还剩多少套
 * 可售期房住宅、多少套已初始登记但未签约的现房住宅。住建委只公示当前快照，
 * 没有逐日历史查询接口，因此：
 *   1. 冷启动把 server/data/stocks-archive.json 里的网页存档锚点灌进库；
 *   2. 每次刷新解析官方页两个统计块，按页面的「截止日期」幂等写入；
 *   3. 每写入一天就同步落盘到存档文件（append-only），线上沙箱冷启动也不丢；
 *   4. 对外导出按日期升序数组，供 /api/stocks、/api/days、内置快照使用。
 *
 * 记录结构（扁平）：
 *   { date, qfStockTotal, qfStockResidential, qfStockTotalArea, qfStockResidentialArea,
 *          xfStockTotal, xfStockResidential, xfStockTotalArea, xfStockResidentialArea,
 *          source, note, capturedAt }
 *
 * 用户要求的两条曲线是 qfStockResidential 与 xfStockResidential。
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'data', 'stocks-archive.json');

const FIELDS = [
  'qfStockTotal', 'qfStockResidential', 'qfStockTotalArea', 'qfStockResidentialArea',
  'xfStockTotal', 'xfStockResidential', 'xfStockTotalArea', 'xfStockResidentialArea',
];

function readArchive() {
  try {
    const j = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    if (j && Array.isArray(j.records)) return j;
  } catch (_) { /* 不存在 / 损坏 */ }
  return { readme: '', updatedAt: null, records: [] };
}

function writeArchive(j) {
  fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  const tmp = ARCHIVE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, ARCHIVE_FILE);
}

/**
 * 把一条记录同时写进内存库与 append-only 存档文件。
 * 返回 true 表示确有新增或数值变更。
 */
function upsert(db, rec) {
  if (!db.stocks) db.stocks = {};
  if (!rec || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '')) return false;
  if (rec.qfStockResidential == null && rec.xfStockResidential == null) return false;

  const prev = db.stocks[rec.date] || {};
  const next = { ...prev, ...rec, date: rec.date };
  const changed = FIELDS.some((k) => next[k] !== prev[k]) || next.source !== prev.source;
  if (!changed) return false;
  db.stocks[rec.date] = next;

  // 同步落盘：线上进程自己采到的一天，即使沙箱回收也能从文件恢复
  const arc = readArchive();
  const idx = arc.records.findIndex((r) => r.date === rec.date);
  if (idx >= 0) arc.records[idx] = next;
  else arc.records.push(next);
  arc.records.sort((a, b) => a.date.localeCompare(b.date));
  arc.updatedAt = new Date().toISOString();
  try {
    writeArchive(arc);
  } catch (e) {
    console.error('[stocks] 存档写入失败:', e.message);
  }
  return true;
}

/** 冷启动补存档锚点（幂等：已有同日记录不覆盖） */
function seedArchive(db) {
  if (!db.stocks) db.stocks = {};
  let added = 0;
  for (const r of readArchive().records) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || db.stocks[r.date]) continue;
    db.stocks[r.date] = { ...r };
    added++;
  }
  return added;
}

/** 合并一次实时抓取（parseStockStats 的返回值），返回是否写入了新数据 */
function mergeLive(db, parsed) {
  if (!parsed || !parsed.date || (!parsed.qf && !parsed.xf)) return false;
  const qf = parsed.qf || {};
  const xf = parsed.xf || {};
  return upsert(db, {
    date: parsed.date,
    qfStockTotal: qf.total ?? null,
    qfStockResidential: qf.residential ?? null,
    qfStockTotalArea: qf.totalArea ?? null,
    qfStockResidentialArea: qf.residentialArea ?? null,
    xfStockTotal: xf.total ?? null,
    xfStockResidential: xf.residential ?? null,
    xfStockTotalArea: xf.totalArea ?? null,
    xfStockResidentialArea: xf.residentialArea ?? null,
    source: '住建委（实时抓取）',
    note: null,
    capturedAt: new Date().toISOString(),
  });
}

/** 批量合并（把线上 /api/stocks 的记录并回本机） */
function mergeMany(db, records) {
  let n = 0;
  for (const r of records || []) {
    if (upsert(db, { ...r, source: r.source || '线上合并' })) n++;
  }
  return n;
}

function list(db) {
  return Object.values((db && db.stocks) || {})
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 漏采检测：相邻采集日间隔 > 1 天即记为缺口（仅提示，不插值） */
function gaps(records) {
  const keys = (records || []).map((r) => r.date).sort();
  const out = [];
  for (let i = 1; i < keys.length; i++) {
    const d = Math.round(
      (Date.parse(keys[i] + 'T00:00:00Z') - Date.parse(keys[i - 1] + 'T00:00:00Z')) / 86400000
    );
    if (d > 1) out.push({ from: keys[i - 1], to: keys[i], missedDays: d - 1 });
  }
  return out;
}

module.exports = {
  ARCHIVE_FILE, FIELDS, readArchive, upsert, seedArchive, mergeLive, mergeMany, list, gaps,
};
