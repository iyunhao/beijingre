'use strict';

/**
 * 中国法定节假日 / 调休日历。
 *
 * 用途有两个：
 *   1. 区分「数据缺口」和「本来就不办公的日子」——之前把 2026-05-04/05-05 这类法定假日
 *      也算成缺口，导致缺口数量虚高，也让月度校准把假日的空缺错误地摊到周末上。
 *   2. 调休上班的周六（如 2026-10-10）当天的签约量接近工作日，
 *      在周六/周日拆分时不能按普通周末的 7:3 处理。
 *
 * 2026 年安排来源：国务院办公厅《关于2026年部分节假日安排的通知》。
 *
 * 注意：住建委在法定假日里通常仍会发布数据（值极低，如 2026-10-01 仅 31 套），
 * 所以「假日」不等于「一定无数据」；这里只用来判断「缺了算不算异常」。
 */

/** 法定放假日（含调休拼假） */
const HOLIDAY_RANGES = [
  ['2025-10-01', '2025-10-08', '国庆·中秋'],
  ['2026-01-01', '2026-01-03', '元旦'],
  ['2026-02-15', '2026-02-23', '春节'],
  ['2026-04-04', '2026-04-06', '清明'],
  ['2026-05-01', '2026-05-05', '劳动节'],
  ['2026-06-19', '2026-06-21', '端午'],
  ['2026-09-25', '2026-09-27', '中秋'],
  ['2026-10-01', '2026-10-07', '国庆'],
];

/**
 * 调休上班的周末（当天有接近工作日的签约量）。
 *
 * 2026 年依据《国务院办公厅关于2026年部分节假日安排的通知》（2025-11-04，gov.cn）：
 *   元旦   1/1–1/3 放假 → **1/4（周日）上班**
 *   春节   2/15–2/23 放假 → 2/14（周六）、2/28（周六）上班
 *   清明   4/4–4/6 放假 → 不调休
 *   劳动节 5/1–5/5 放假 → 5/9（周六）上班
 *   端午   6/19–6/21 放假 → 不调休
 *   中秋   9/25–9/27 放假 → 不调休
 *   国庆   10/1–10/7 放假 → **9/20（周日）、10/10（周六）上班**
 *
 * 注意：房市儿的日序列把**所有**周六周日均过滤掉，所以无法从数据反推哪天是调休，
 * 只能依据上述通知。
 */
const MAKEUP_WORKDAYS = new Set([
  '2025-09-28', // 2025 国庆中秋调休
  '2025-10-11',
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
]);

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const HOLIDAY_MAP = {};
for (const [from, to, name] of HOLIDAY_RANGES) {
  let cur = fromKey(from);
  const end = fromKey(to);
  while (cur <= end) {
    HOLIDAY_MAP[toKey(cur)] = name;
    cur = new Date(cur.getTime() + 86400000);
  }
}

const isHoliday = (key) => Object.prototype.hasOwnProperty.call(HOLIDAY_MAP, key);
const holidayName = (key) => HOLIDAY_MAP[key] || null;
const isMakeupWorkday = (key) => MAKEUP_WORKDAYS.has(key);

const isCalendarWeekend = (key) => {
  const w = fromKey(key).getDay();
  return w === 0 || w === 6;
};

/**
 * 「周一至周五、且非法定假日」的常规交易日。
 * 官方页的逐日数据只覆盖这一类日子（周六周日不更新），
 * 所以逐日序列缺了这类日子才叫真缺口。
 */
const isWeekday = (key) => !isCalendarWeekend(key);

/** 需要靠「周总量 − 工作日合计」回补的日子：周六 / 周日 */
const isWeekendSlot = (key) => isCalendarWeekend(key);

/** 是否为「应有数据」的常规交易日（排除法定假日） */
const isTradingDay = (key) => isWeekday(key) && !isHoliday(key);

/** 某月应有交易日数量（周一至周五，扣除法定假日） */
function tradingDaysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const total = new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= total; d++) {
    if (isTradingDay(`${y}-${pad(m)}-${pad(d)}`)) n++;
  }
  return n;
}

module.exports = {
  isHoliday,
  holidayName,
  isMakeupWorkday,
  isCalendarWeekend,
  isWeekday,
  isWeekendSlot,
  isTradingDay,
  tradingDaysInMonth,
  HOLIDAY_MAP,
  MAKEUP_WORKDAYS,
};
