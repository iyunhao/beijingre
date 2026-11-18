'use strict';

/**
 * 永久历史保护存档（append-only，按日期索引，绝不删除键）。
 *
 * 为什么需要它：
 *   「北京房市儿 · 最近一年」是滚动窗口，每次 rebuild 都从它重新生成 `days = {}`。
 *   一年前的数据会随窗口滑动被整体丢掉；线上沙箱冷启动还可能把 store.json 还原成
 *   部署时的快照。用户明确要求「每天的数据持续累计，但不要删除之前的数据」。
 *
 * 做法：
 *   1. 每次 rebuild 开始时，先把当前 store.days 全量吸收进 server/data/history-archive.json；
 *   2. rebuild 生成新日序列后，把存档里「本次滚动源不再覆盖」的日期原样带回；
 *   3. 带回的记录标记 archived:true，不参与月度收口、不参与总量口径重算，
 *      保证历史数值不被静默改写；
 *   4. 官方逐日表 / 官方直采存档 / 官方直采日仍然优先级最高，会覆盖存档值。
 *
 * 权威等级只用于「同一天有更好的来源时允许订正」，任何时候都不会删除日期。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'history-archive.json');
const RANK = { official: 4, exact: 3, derived: 2, estimated: 1 };
const rankOf = (d) => RANK[(d && d.quality) || ''] || 0;

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && j.days && typeof j.days === 'object') return j;
  } catch (_) { /* 不存在 / 损坏 → 新建 */ }
  return { days: {}, updatedAt: null };
}

function write(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

/**
 * 把当前库里的所有日记录吸收进永久存档。
 * @returns {object} 完整存档 days（按日期索引）
 */
function absorb(db) {
  const arc = read();
  let added = 0;
  let upgraded = 0;
  for (const [date, rec] of Object.entries((db && db.days) || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rec || typeof rec !== 'object') continue;
    const clean = { ...rec, date };
    const prev = arc.days[date];
    if (!prev) {
      arc.days[date] = clean;
      added++;
    } else if (
      rankOf(clean) > rankOf(prev) ||
      (rankOf(clean) === rankOf(prev) && JSON.stringify(clean) !== JSON.stringify(prev))
    ) {
      // 同等级允许订正（例如官方逐日表修正了旧推算值），但键永远保留
      arc.days[date] = clean;
      upgraded++;
    }
  }
  if (added || upgraded) {
    arc.updatedAt = new Date().toISOString();
    try {
      write(arc);
    } catch (e) {
      console.error('[historyArchive] 写入失败:', e.message);
    }
  }
  return arc.days;
}

function dates() {
  return Object.keys(read().days).sort();
}

function stats() {
  const d = read().days;
  const keys = Object.keys(d).sort();
  return {
    archivedDays: keys.length,
    first: keys[0] || null,
    last: keys[keys.length - 1] || null,
    updatedAt: read().updatedAt,
  };
}

module.exports = { FILE, read, absorb, dates, stats };
