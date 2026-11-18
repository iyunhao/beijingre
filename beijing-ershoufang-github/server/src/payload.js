'use strict';

/**
 * 统一的「日序列」输出格式，供 /api/days 与 web/data/snapshot.js 共用，
 * 避免两处映射各写一份、新增字段时漏掉其中一边。
 *
 * 字段说明：
 *   sources        —— 该日值的来源标记
 *   weekend        —— 是否周六/周日
 *   singleDayKnown —— 周末日的单日值是否确知（官方逐日表 / 官方直采 / 周残差精确反推）。
 *                     为 true 时前端把周六、周日各自单列展示，不用合计代替。
 *   unknownSplit   —— 周末日单日值不可确知时为 true：此时前端才把周六/周日
 *                     两格合并成一格，只显示「周六+周日合计」。
 *   weekendSum     —— 仅周六记录携带的权威「两天合计」：
 *                     { residential, total, quality, days }
 *                     quality = official-table（官方逐日表逐日实值相加）
 *                              | official（官方直采）
 *                              | weekly-residual（周合计 − 工作日合计，精确反推）
 *                              | estimated（源站缺口，估算）
 *   exactResidual  —— 该日由「周合计 − 工作日合计 − 另一天官方直采值」精确反推
 *
 * 重要：服务端为了满足月累计对账，对单日值不可确知的周末仍会在内部拆到两天参与加总，
 * 但该拆分是近似值，一律不对外展示（unknownSplit=true）。有确知单日值的周末直接用真值。
 */
const store = require('./store');
const cal = require('./calendar');
const newhomes = require('./newhomes');
const stocks = require('./stocks');

const pad2 = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD 位移 n 天（本地时区，避免 UTC 跨日问题） */
function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * 计算每个周末的权威「两天合计」，并标注它的可信等级。
 * 合计是独立输出的一等数据，不再由前端拿两个推测单日值相加得到。
 */
function weekendSums(list) {
  const byDate = new Map(list.map((d) => [d.date, d]));
  const out = new Map();

  for (const sat of list) {
    if (!cal.isWeekendSlot(sat.date)) continue;
    const [y, m, d] = sat.date.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() !== 6) continue; // 只以周六为锚

    const sunKey = shiftDay(sat.date, 1);
    const sun = byDate.get(sunKey) || null;
    const parts = [sat, sun].filter(Boolean);
    if (!parts.length) continue;

    let quality = 'estimated';
    if (parts.every((x) => x.officialTable || x.officialCapture)) quality = 'official-table';
    else if (parts.every((x) => x.quality === 'official')) quality = 'official';
    else if (parts.every((x) => (x.sources || []).includes('weekly-residual'))) quality = 'weekly-residual';

    // days<2 表示数据前沿的「半对周末」：周六已披露、周日未披露。
    // 此时 residential/total 只是周六单日值，不是「周六+周日合计」，
    // 调用方必须按 complete=false 处理，绝不把单日值当合计展示。
    out.set(sat.date, {
      residential: parts.reduce((s, x) => s + (x.residential || 0), 0),
      total: parts.reduce((s, x) => s + (x.total || 0), 0),
      quality,
      days: parts.length,
      complete: parts.length === 2,
      sunDate: sunKey,
    });
  }
  return out;
}

/** 判定哪些周末日是「周残差精确反推」得来的（仅用于悬停说明） */
function weekendExactResidual(list) {
  const byDate = new Map(list.map((d) => [d.date, d]));
  const out = new Set();
  for (const sat of list) {
    if (!cal.isWeekendSlot(sat.date)) continue;
    const [y, m, d] = sat.date.split('-').map(Number);
    if (new Date(y, m - 1, d).getDay() !== 6) continue;
    const sun = byDate.get(shiftDay(sat.date, 1));
    const satOfficial = sat.quality === 'official';
    const sunOfficial = !!sun && sun.quality === 'official';
    const other = satOfficial ? sun : sat;
    if (satOfficial !== sunOfficial && other && (other.sources || []).includes('weekly-residual')) {
      out.add(other.date);
    }
  }
  return out;
}

function days(db, metric = 'total') {
  const m = metric === 'total' ? 'total' : 'residential';
  const list = store.dayList(db);
  const sums = weekendSums(list);
  const exactResidual = weekendExactResidual(list);

  return list
    .map((d) => {
      const wk = cal.isWeekendSlot(d.date);
      // 单日值确知 = 官方逐日表 / 官方直采 / 由周合计精确反推的另一天。
      // 仅由 SAT_RATIO 硬拆出来的两天不算——那是估算，必须继续合并显示合计。
      const singleDayKnown = wk && !!(
        d.officialTable || d.officialCapture || d.quality === 'official' || exactResidual.has(d.date)
      );
      return {
        date: d.date,
        value: m === 'total' ? (d.total ?? null) : (d.residential ?? null),
        residential: d.residential ?? null,
        total: d.total ?? null,
        quality: d.quality || 'exact',
        totalQuality: d.totalQuality || (d.quality === 'official' ? 'official' : null),
        estimated: d.quality === 'estimated',
        sources: d.sources || [],
        weekend: wk,
        singleDayKnown,
        // 只有单日值不可确知的周末才合并；有官方逐日实值 / 直采 / 精确反推的周末单列展示。
        unknownSplit: wk && !singleDayKnown,
        exactResidual: exactResidual.has(d.date),
        weekendSum: wk ? (sums.get(d.date) || null) : null,
        holiday: cal.isHoliday(d.date) ? cal.holidayName(d.date) : null,
        makeupWorkday: cal.isMakeupWorkday(d.date),
      };
    })
    .filter((d) => d.value != null);
}

function newHomeDays(db) {
  newhomes.seedArchive(db); // 冷启动时补齐存档锚点（幂等）
  return newhomes.list(db);
}

/**
 * 可售期房 / 未签约现房「其中住宅套数」库存统计。
 * 冷启动补存档锚点后按日期升序返回；live 标记供前端区分「实时直采」与「网页存档」。
 */
function stockDays(db) {
  stocks.seedArchive(db);
  return stocks.list(db).map((r) => ({
    ...r,
    live: r.source === '住建委（实时抓取）',
  }));
}

module.exports = { days, newHomeDays, stockDays, weekendSums };
