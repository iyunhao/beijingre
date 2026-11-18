'use strict';

const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const addDays = (k, n) => toKey(new Date(fromKey(k).getTime() + n * DAY_MS));

/** 主指标：住宅签约套数（数据最完整）；缺失时回落到网签总套数 */
const valueOf = (day, metric = 'residential') => {
  if (!day) return null;
  if (metric === 'total') return day.total ?? null;
  return day.residential ?? null;
};

/** 该日相对「上一个有数据的交易日」的变化（套） */
function withChange(list, metric = 'residential') {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const v = valueOf(cur, metric);
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      const pv = valueOf(list[j], metric);
      if (pv != null) {
        prev = pv;
        break;
      }
    }
    out.push({
      ...cur,
      value: v,
      change: v != null && prev != null ? v - prev : null,
    });
  }
  return out;
}

function monthSummary(store, monthKey, metric = 'residential') {
  const [y, m] = monthKey.split('-').map(Number);
  const total = daysInMonth(y, m);
  const all = withChange(
    Object.values(store.days).sort((a, b) => a.date.localeCompare(b.date)),
    metric
  );
  const byDate = new Map(all.map((r) => [r.date, r]));

  const days = [];
  let sum = 0;
  let elapsed = 0;
  let prevValue = null; // 仅与「本月上一个有数据的交易日」比较
  for (let d = 1; d <= total; d++) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    const row = byDate.get(key);
    if (row && row.value != null) {
      sum += row.value;
      elapsed = d;
      days.push({
        date: key,
        day: d,
        value: row.value,
        change: prevValue == null ? null : row.value - prevValue,
        total: row.total ?? null,
        residential: row.residential ?? null,
      });
      prevValue = row.value;
    } else {
      days.push({ date: key, day: d, value: null, change: null });
    }
  }

  const official = store.months[monthKey] && store.months[monthKey].official ? store.months[monthKey] : null;
  const isComplete = elapsed >= total;

  // 累计：有官方月报时以官方为准（权威口径），否则用已披露日逐日加总
  const monthTotal = official ? official[metric === 'total' ? 'total' : 'residential'] : sum;

  // 预估：剩余工作日 × 近 10 个有数据日的日均（比按自然日线性外推更贴近北京「仅工作日网签」的节奏）
  let forecast = monthTotal;
  if (!isComplete && monthTotal > 0) {
    const recorded = days.filter((d) => d.value != null);
    const recent = recorded.slice(-10);
    const rate = recent.reduce((s, d) => s + d.value, 0) / (recent.length || 1);
    let remainingWorkdays = 0;
    for (let d = elapsed + 1; d <= total; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow !== 0 && dow !== 6) remainingWorkdays++;
    }
    forecast = Math.round(monthTotal + remainingWorkdays * rate);
  }

  return {
    month: monthKey,
    daysInMonth: total,
    days,
    monthTotal,
    dailySum: sum,
    forecast,
    forecastMethod: isComplete ? 'actual' : 'workday-rate',
    elapsedDays: elapsed,
    countedDays: days.filter((d) => d.value != null).length,
    officialMonthly: official
      ? { total: official.total, residential: official.residential }
      : null,
    deviation: official && official.residential ? Number((((sum - official.residential) / official.residential) * 100).toFixed(2)) : null,
    complete: isComplete,
  };
}

function trend(store, endDate, span, metric = 'residential') {
  const all = withChange(
    Object.values(store.days).sort((a, b) => a.date.localeCompare(b.date)),
    metric
  );
  const map = new Map(all.map((r) => [r.date, r]));

  const points = [];
  for (let i = span - 1; i >= 0; i--) {
    const key = addDays(endDate, -i);
    const row = map.get(key);
    points.push({
      date: key,
      label: `${Number(key.slice(5, 7))}-${key.slice(8, 10)}`,
      value: row ? row.value : null,
    });
  }
  const sum = points.reduce((s, p) => s + (p.value || 0), 0);
  return { span, sum, points };
}

function summary(store, metric = 'residential') {
  const all = withChange(
    Object.values(store.days).sort((a, b) => a.date.localeCompare(b.date)),
    metric
  );
  const latest = all.filter((r) => r.value != null).pop() || null;
  const endDate = latest ? latest.date : toKey(new Date());

  const prevDay = all.filter((r) => r.value != null && r.date < endDate).pop() || null;

  return {
    city: store.meta.city,
    metric,
    metricLabel: metric === 'total' ? '网签总套数' : '住宅签约套数',
    latest: latest
      ? {
          date: latest.date,
          value: latest.value,
          total: latest.total ?? null,
          residential: latest.residential ?? null,
          change: latest.change,
          dodPct:
            prevDay && prevDay.value ? Number(((latest.value - prevDay.value) / prevDay.value * 100).toFixed(1)) : null,
        }
      : null,
    updatedAt: store.meta.updatedAt,
    windows: [7, 15, 30].map((s) => trend(store, endDate, s, metric)),
    month: monthSummary(store, endDate.slice(0, 7), metric),
  };
}

module.exports = { monthSummary, trend, summary, addDays, toKey, valueOf };
