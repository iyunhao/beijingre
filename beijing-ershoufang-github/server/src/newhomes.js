'use strict';

/**
 * 期房 / 现房网上签约「单日」数据集合（db.newHomes，按日期索引）。
 *
 * 与存量房不同，住建委只公示**最新一天**的期房/现房网签值，且历史查询接口已失效，
 * 所以没有连续历史日序列可回补。本模块做三件事：
 *   1. 冷启动时把 server/data/newhomes-archive.json 里的零散存档锚点灌进库；
 *   2. 每次刷新把官方页最新一天的值按日期幂等合并（同日覆盖，逐日累积）；
 *   3. 对外导出按日期升序的数组，供 API / 内置快照使用。
 *
 * 记录结构（扁平，便于前端直接取字段）：
 *   { date, qfTotal, qfResidential, qfTotalArea, qfResidentialArea,
 *          xfTotal, xfResidential, xfTotalArea, xfResidentialArea,
 *          source, capturedAt }
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'data', 'newhomes-archive.json');

function readArchive() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    if (raw && Array.isArray(raw.records)) return raw;
  } catch (e) { /* 不存在 / 损坏 */ }
  return { _readme: '', records: [] };
}

function archiveRecords() {
  return readArchive().records;
}

/**
 * 把实时采到的一天同步写回 append-only 存档文件。
 * 之前只写 store.json，线上沙箱被回收重建时这一天会丢；
 * 与 captureArchive / stocks 保持一致，逐日落盘才能保证「只增不删」。
 */
function writeArchive(records) {
  const cur = readArchive();
  cur.records = records.slice().sort((a, b) => a.date.localeCompare(b.date));
  cur.updatedAt = new Date().toISOString();
  const tmp = ARCHIVE_FILE + '.tmp';
  fs.mkdirSync(path.dirname(ARCHIVE_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(tmp, ARCHIVE_FILE);
}

function persist(db) {
  try {
    writeArchive(Object.values(db.newHomes || {}).filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
    return true;
  } catch (e) {
    console.error('[newhomes] 存档写入失败:', e.message);
    return false;
  }
}

/** 冷启动补存档锚点（幂等：已有同日记录不覆盖） */
function seedArchive(db) {
  if (!db.newHomes) db.newHomes = {};
  let added = 0;
  for (const r of archiveRecords()) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || db.newHomes[r.date]) continue;
    db.newHomes[r.date] = {
      ...r,
      source: r.source || '网页存档',
      capturedAt: r.capturedAt || null,
    };
    added++;
  }
  return added;
}

/** 合并一次实时抓取（parseNewHome 的返回值），返回是否写入了新数据 */
function mergeLive(db, parsed) {
  if (!db.newHomes) db.newHomes = {};
  if (!parsed || !parsed.date || (!parsed.qf && !parsed.xf)) return false;

  const date = parsed.date;
  const qf = parsed.qf || {};
  const xf = parsed.xf || {};
  const prev = db.newHomes[date] || {};
  const next = {
    ...prev,
    date,
    qfTotal: qf.total ?? prev.qfTotal ?? null,
    qfResidential: qf.residential ?? prev.qfResidential ?? null,
    qfTotalArea: qf.totalArea ?? prev.qfTotalArea ?? null,
    qfResidentialArea: qf.residentialArea ?? prev.qfResidentialArea ?? null,
    xfTotal: xf.total ?? prev.xfTotal ?? null,
    xfResidential: xf.residential ?? prev.xfResidential ?? null,
    xfTotalArea: xf.totalArea ?? prev.xfTotalArea ?? null,
    xfResidentialArea: xf.residentialArea ?? prev.xfResidentialArea ?? null,
    source: '住建委（实时抓取）',
    capturedAt: new Date().toISOString(),
  };

  // 数值没变且已是直采来源时不重复写盘
  const sameValues = [
    'qfTotal', 'qfResidential', 'qfTotalArea', 'qfResidentialArea',
    'xfTotal', 'xfResidential', 'xfTotalArea', 'xfResidentialArea',
  ].every((k) => next[k] === prev[k]);
  if (sameValues && prev.source === next.source) return false;

  db.newHomes[date] = next;
  persist(db);
  return true;
}

/** 批量合并（把线上 /api/newhomes 的记录并回本机） */
function mergeMany(db, records) {
  let n = 0;
  for (const r of records || []) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const prev = db.newHomes[r.date] || {};
    const next = { ...prev, ...r, date: r.date, source: r.source || prev.source || '线上合并' };
    if (JSON.stringify(next) === JSON.stringify(prev)) continue;
    db.newHomes[r.date] = next;
    n++;
  }
  if (n) persist(db);
  return n;
}

function list(db) {
  return Object.values((db && db.newHomes) || {}).sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { seedArchive, mergeLive, mergeMany, persist, list, ARCHIVE_FILE };
