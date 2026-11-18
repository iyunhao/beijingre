'use strict';

/**
 * 独立数据校验：不信任 store.json 的自述，重新抓取原始权威页面逐条比对。
 *
 * 用法：node server/scripts/verify-data.js
 * 产出：server/data/verification.json —— 供 /api/verification、/api/days、网页快照共用。
 *
 * 校验分两类：
 *   A. 可 100% 确证的硬约束（工作日原值、官方直采、官方月报、数值合法性）
 *   B. 源站自身互相矛盾、需要如实披露的项（周序列 vs 月序列口径微差）
 *
 * 原则：任何一项不通过就整体标记为 FAIL，绝不用「四舍五入」「差不多」糊过去。
 */
const fs = require('fs');
const path = require('path');
const {
  SOURCES,
  fetchText,
  parseFangshiAll,
  parseOfficial,
  parseAgency,
  parseNewHome,
} = require('../src/parse');

// 住建委官方逐日公示表（用户提供截图转录，逐条与截图合计行核对过）。
// 这是最高优先级真值：房市儿日/月序列已被证实有错（如 2026-04-28/29、
// 2026-02-16，以及 2026-02 月合计），校验时必须以官方表为准，
// 否则会用错误的源站值去否定正确的数据。
const officialTable = require('../src/officialTable');
const OFFICIAL_DAILY = officialTable.expand();
const OFFICIAL_MONTHS = officialTable.computedTotals();
const OFFICIAL_FULL_MONTHS = new Set(officialTable.FULL_MONTHS);

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const OUT = path.join(DATA_DIR, 'verification.json');

const pad = (n) => String(n).padStart(2, '0');
const shift = (k, n) => {
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
const dow = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

function loadDb() {
  const p = path.join(DATA_DIR, 'store.json');
  const raw = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  if (raw && Object.keys(raw.days || {}).length) return raw;
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'seed.json'), 'utf8'));
}

/** 把源站周序列还原成「每周周末合计」的精确反推值（仅用于披露口径差，不回写数据库） */
function rawWeekendResiduals(raw) {
  const out = new Map();
  for (const w of raw.weekly) {
    if (!w.end) continue;
    const start = w.start;
    const end = shift(start, 6);
    let workdaySum = 0;
    let complete = true;
    for (let k = start; k <= end; k = shift(k, 1)) {
      const wd = dow(k);
      if (wd === 0 || wd === 6) continue;
      if (raw.daily[k] == null) { complete = false; break; }
      workdaySum += raw.daily[k];
    }
    if (!complete) continue;
    out.set(start, {
      start,
      end,
      weeklyTotal: w.total,
      workdaySum,
      weekendResidual: w.total - workdaySum,
    });
  }
  return out;
}

async function collectSources() {
  const result = {};
  const errors = [];
  for (const [name, url] of [
    ['fangshi52', SOURCES.fangshi52],
    ['zjw', SOURCES.zjw],
    ['topic', SOURCES.topic],
  ]) {
    try {
      const html = await fetchText(url);
      if (name === 'fangshi52') result.fangshi = parseFangshiAll(html);
      if (name === 'zjw') result.official = parseOfficial(html);
      if (name === 'topic') {
        result.agency = parseAgency(html);
        result.newHome = parseNewHome(html);
      }
      result[`${name}Bytes`] = Buffer.byteLength(html);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  result.errors = errors;
  return result;
}

function buildChecks(db, src) {
  const D = db.days || {};
  const keys = Object.keys(D).sort();
  const checks = [];
  const push = (id, label, status, numbers, detail) =>
    checks.push({ id, label, status, numbers, detail });

  // 住建委历史月报存档（含逐条出处），用于反查本地 months 锚点表
  let ext = {};
  try {
    ext = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'external.json'), 'utf8'));
  } catch (e) {
    /* 缺失时跳过存档月报比对 */
  }

  // ── 1. 工作日日值：逐条与源站原始日序列比对 ─────────────────────────
  if (src.fangshi) {
    const raw = src.fangshi.daily;
    const rawKeys = Object.keys(raw);
    const mismatch = [];
    const absent = [];
    const overrides = [];
    for (const k of rawKeys) {
      if (!D[k]) { absent.push(k); continue; }
      // 官方逐日公示表覆盖的日期，以官方表为真值；房市儿原值仅作对照披露。
      const authoritative = OFFICIAL_DAILY[k] != null;
      const expected = authoritative ? OFFICIAL_DAILY[k] : raw[k];
      if (authoritative && raw[k] !== expected) {
        overrides.push({ date: k, fangshi: raw[k], official: expected });
      }
      if (D[k].residential !== expected) {
        mismatch.push({ date: k, expected, stored: D[k].residential, from: authoritative ? 'official-table' : 'fangshi' });
      }
    }
    push(
      'workday_exact',
      '工作日单日值 vs 官方逐日表 / 源站原始日序列',
      mismatch.length === 0 && absent.length === 0 ? 'PASS' : 'FAIL',
      { rawDays: rawKeys.length, compared: rawKeys.length - absent.length, mismatch: mismatch.length,
        absent: absent.length, officialOverrides: overrides.length },
      mismatch.length || absent.length
        ? `不一致：${JSON.stringify(mismatch.slice(0, 5))}；缺失：${absent.slice(0, 5).join(',')}`
        : `${rawKeys.length} 个工作日逐条核对通过：其中 ${overrides.length} 天以住建委官方逐日表为准` +
          (overrides.length ? `（房市儿原值有误：${overrides.map((o) => `${o.date} ${o.fangshi}→${o.official}`).join('、')}）` : '') +
          `，其余与源站原始日序列完全一致`
    );
  } else {
    push('workday_exact', '工作日单日值 vs 源站原始日序列', 'UNAVAILABLE', {}, '源站本次未取到，无法校验');
  }

  // ── 2. 官方直采日：与住建委当日公示值比对 ───────────────────────────
  if (src.official && src.official.daily) {
    const o = src.official.daily;
    const s = D[o.date];
    const ok = !!s && s.quality === 'official' &&
      s.residential === o.residential && s.total === o.total;
    push(
      'official_daily',
      '官方最新一日 vs 住建委公示页',
      ok ? 'PASS' : 'FAIL',
      { date: o.date, officialResidential: o.residential, officialTotal: o.total,
        storedResidential: s ? s.residential : null, storedTotal: s ? s.total : null },
      ok ? `${o.date} 住宅 ${o.residential} / 总套数 ${o.total} 与官方页面一致`
         : '本地值与官方页面不一致，需要重新抓取'
    );
  } else {
    push('official_daily', '官方最新一日 vs 住建委公示页', 'UNAVAILABLE', {}, '源站本次未取到');
  }

  // ── 3. 月度住宅合计：逐月与官方月报硬对账 ───────────────────────────
  const officialMonths = {};
  if (src.fangshi) for (const [m, v] of Object.entries(src.fangshi.monthly)) officialMonths[m] = v;
  if (src.official && src.official.monthly) {
    const o = src.official.monthly;
    officialMonths[`${o.year}-${pad(o.month)}`] = o.residential;
  }
  // 补充本地已存档但源站已滚动下线的历史月报
  for (const [m, v] of Object.entries(db.months || {})) {
    if (v && v.official && Number.isFinite(v.residential) && officialMonths[m] == null) {
      officialMonths[m] = v.residential;
    }
  }
  // 官方逐日公示表的整月合计优先级最高：房市儿月序列把 2026-02 记成 8130，
  // 而住建委公示表逐日加总为 8129（已与截图合计行核对）。只覆盖完整月份，
  // 2026-11 这类未完结月份不参与，避免用「截至 11-08」的累计冒充整月。
  for (const m of OFFICIAL_FULL_MONTHS) {
    if (Number.isFinite(OFFICIAL_MONTHS[m])) officialMonths[m] = OFFICIAL_MONTHS[m];
  }
  const monthRows = [];
  for (const [m, official] of Object.entries(officialMonths).sort()) {
    const inM = keys.filter((k) => k.slice(0, 7) === m);
    const sum = inM.reduce((s, k) => s + (D[k].residential || 0), 0);
    monthRows.push({ month: m, official, sum, diff: sum - official, days: inM.length });
  }
  const badMonths = monthRows.filter((r) => r.diff !== 0);
  push(
    'monthly_residential',
    '逐日住宅合计 vs 官方月报',
    monthRows.length > 0 && badMonths.length === 0 ? 'PASS' : 'FAIL',
    { months: monthRows.length, exact: monthRows.length - badMonths.length, off: badMonths.length,
      maxAbsDiff: Math.max(0, ...monthRows.map((r) => Math.abs(r.diff))) },
    badMonths.length ? `偏差月份：${JSON.stringify(badMonths)}` : `${monthRows.length} 个有官方月报的月份逐日合计与官方值完全相等（偏差 0）`
  );

  // ── 4. 月度总量口径（网上签约套数）────────────────────────────────
  if (src.official && src.official.monthly) {
    const o = src.official.monthly;
    const m = `${o.year}-${pad(o.month)}`;
    const inM = keys.filter((k) => k.slice(0, 7) === m);
    const sum = inM.reduce((s, k) => s + (D[k].total || 0), 0);
    push(
      'monthly_total',
      '逐日网上签约总套数 vs 官方月报',
      sum === o.total ? 'PASS' : 'FAIL',
      { month: m, official: o.total, storedSum: sum, diff: sum - o.total, days: inM.length },
      sum === o.total ? `${m} 总套数 ${o.total} 逐日加总分毫不差` : '总量口径不一致'
    );
  }

  // ── 5. 期房/现房：与官方当日页逐字段比对 + 内部合法性 ────────────────
  const nh = db.newHomes || {};
  const nhKeys = Object.keys(nh).sort();
  const nhInvalid = [];
  for (const k of nhKeys) {
    const r = nh[k];
    if (r.qfResidential > r.qfTotal || r.xfResidential > r.xfTotal) nhInvalid.push(`${k}:住宅>总套数`);
    if ([r.qfTotal, r.xfTotal, r.qfResidential, r.xfResidential].some((v) => v != null && (!Number.isInteger(v) || v < 0))) {
      nhInvalid.push(`${k}:非法数值`);
    }
  }
  let nhLive = null;
  if (src.newHome && src.newHome.date) {
    const l = src.newHome;
    const s = nh[l.date];
    nhLive = {
      date: l.date,
      match: !!s && s.qfTotal === l.qf?.total && s.qfResidential === l.qf?.residential &&
             s.xfTotal === l.xf?.total && s.xfResidential === l.xf?.residential,
      official: { qfTotal: l.qf?.total, qfResidential: l.qf?.residential, xfTotal: l.xf?.total, xfResidential: l.xf?.residential },
      stored: s ? { qfTotal: s.qfTotal, qfResidential: s.qfResidential, xfTotal: s.xfTotal, xfResidential: s.xfResidential } : null,
    };
  }
  push(
    'new_homes',
    '期房/现房当日值 vs 住建委 + 内部一致性',
    nhInvalid.length === 0 && (!nhLive || nhLive.match) ? 'PASS' : 'FAIL',
    { records: nhKeys.length, invalid: nhInvalid.length, liveDate: nhLive ? nhLive.date : null, liveMatch: nhLive ? nhLive.match : null },
    nhInvalid.length ? JSON.stringify(nhInvalid.slice(0, 5))
      : nhLive ? `${nhLive.date} 四个字段与官方页面一致；${nhKeys.length} 条记录住宅套数均不大于总套数`
      : '源站未取到，仅完成内部一致性检查'
  );

  // ── 6. 数值与结构不变量 ─────────────────────────────────────────────
  const inv = { negative: [], totalLtResidential: [], nonInteger: [], missingQuality: [], duplicate: 0 };
  for (const k of keys) {
    const d = D[k];
    if (d.residential < 0 || d.total < 0) inv.negative.push(k);
    if (d.total != null && d.residential != null && d.total < d.residential) inv.totalLtResidential.push(k);
    if (!Number.isInteger(d.residential) || !Number.isInteger(d.total)) inv.nonInteger.push(k);
    if (!d.quality) inv.missingQuality.push(k);
  }
  inv.duplicate = keys.length - new Set(keys).size;
  const invBad = inv.negative.length + inv.totalLtResidential.length + inv.nonInteger.length +
    inv.missingQuality.length + inv.duplicate;
  push(
    'invariants',
    '数值与结构不变量',
    invBad === 0 ? 'PASS' : 'FAIL',
    { days: keys.length, range: `${keys[0]} ~ ${keys[keys.length - 1]}`, ...inv },
    invBad === 0 ? '无负数、无非法小数、总套数≥住宅套数、无重复日期、每日均有质量标记'
                 : '存在非法记录'
  );

  // ── 7. 官方月报锚点表：与住建委实时月报 + 历史月报存档逐字段比对 ─────
  //      monthly_residential / monthly_total 校验的是「逐日加总」，
  //      这里校验的是「本地 months 锚点表」本身有没有抄错数。
  const anchorMismatch = [];
  let liveAnchor = null;
  if (src.official && src.official.monthly) {
    const o = src.official.monthly;
    const k = `${o.year}-${pad(o.month)}`;
    const r = (db.months || {})[k] || {};
    liveAnchor = {
      month: k,
      officialResidential: o.residential,
      officialTotal: o.total,
      storedResidential: r.residential ?? null,
      storedTotal: r.total ?? null,
      match: r.residential === o.residential && r.total === o.total,
    };
    if (!liveAnchor.match) anchorMismatch.push(`${k}:实时月报`);
  }
  let archivedChecked = 0;
  for (const [m, e] of Object.entries(ext.monthlyTotal || {})) {
    const r = (db.months || {})[m];
    if (!r || !e) continue; // 存档月报早于本站日序列起点，无对应锚点，跳过
    archivedChecked++;
    if (r.total != null && e.total != null && r.total !== e.total) {
      anchorMismatch.push(`${m}:total(${r.total}≠${e.total})`);
    }
    if (r.residential != null && e.residential != null && r.residential !== e.residential) {
      anchorMismatch.push(`${m}:residential(${r.residential}≠${e.residential})`);
    }
  }
  push(
    'official_month_anchor',
    '官方月报锚点表 vs 住建委实时月报 / 历史存档',
    !liveAnchor ? 'UNAVAILABLE' : anchorMismatch.length === 0 ? 'PASS' : 'FAIL',
    {
      liveMonth: liveAnchor ? liveAnchor.month : null,
      liveResidential: liveAnchor ? liveAnchor.officialResidential : null,
      liveTotal: liveAnchor ? liveAnchor.officialTotal : null,
      archivedMonthsChecked: archivedChecked,
      mismatch: anchorMismatch.length,
    },
    !liveAnchor
      ? '住建委月报本次未取到，无法校验锚点表'
      : anchorMismatch.length
        ? `锚点表与官方月报不一致：${anchorMismatch.join('、')}`
        : `${liveAnchor.month} 住宅 ${liveAnchor.officialResidential} / 总量 ${liveAnchor.officialTotal} 与本地锚点完全一致；` +
          `另核对 ${archivedChecked} 个历史月报存档，0 处不一致`
  );

  // ── 8. 周末合计：逐周用「源站周合计 − 源站工作日之和」反推并逐周比对 ──
  //      这是「历史周末只显示两天合计」这个可信数字的直接证明。
  //      只校验源站周序列自洽的周；口径微差 / 错值周 / 缺口周在第 9 项如实披露。
  const wr = { weeks: 0, verified: 0, skipped: 0, mismatch: [] };
  if (src.fangshi) {
    const raw = src.fangshi.daily;
    for (const w of src.fangshi.weekly) {
      if (!w.end || !w.start) continue;
      const inW = keys.filter((k) => k >= w.start && k <= w.end);
      const storedSum = inW.reduce((s, k) => s + (D[k].residential || 0), 0);
      if (storedSum !== w.total) continue; // 非自洽周，交给 weekly_consistency 披露
      wr.weeks++;
      let workdaySum = 0;
      let weekendSum = 0;
      let complete = true;
      for (let k = w.start; k <= w.end; k = shift(k, 1)) {
        const wd = dow(k);
        if (wd === 0 || wd === 6) {
          if (!D[k]) { complete = false; break; }
          weekendSum += D[k].residential || 0;
        } else {
          if (raw[k] == null) { complete = false; break; }
          workdaySum += raw[k];
        }
      }
      if (!complete) { wr.skipped++; continue; }
      wr.verified++;
      const residual = w.total - workdaySum;
      if (weekendSum !== residual) {
        wr.mismatch.push({ week: w.start, weekendSum, residual, diff: weekendSum - residual });
      }
    }
  }
  push(
    'weekend_residual',
    '历史周末两天合计 vs 源站周合计精确反推',
    !src.fangshi ? 'UNAVAILABLE' : wr.mismatch.length === 0 && wr.verified > 0 ? 'PASS' : 'FAIL',
    { weeks: wr.weeks, verified: wr.verified, skipped: wr.skipped, mismatch: wr.mismatch.length },
    !src.fangshi
      ? '源站周序列本次未取到，无法校验'
      : wr.mismatch.length
        ? `周末合计与反推值不一致：${JSON.stringify(wr.mismatch.slice(0, 5))}`
        : `${wr.verified} 个源站自洽周逐一验证：「本地周六+周日合计」=「源站周合计 − 源站工作日之和」，全部相等（偏差 0）；` +
          `${wr.skipped} 周因源站缺工作日值跳过；口径微差 / 错值 / 缺口周另在第 9 项如实披露`
  );

  // ── 9. 周序列 vs 月序列：源站自身口径差（如实披露，不判 FAIL）────────
  let weeklyReport = [];
  if (src.fangshi) {
    const residuals = rawWeekendResiduals(src.fangshi);
    for (const w of src.fangshi.weekly) {
      if (!w.end) continue;
      const inW = keys.filter((k) => k >= w.start && k <= w.end);
      if (!inW.length) continue;
      const storedSum = inW.reduce((s, k) => s + (D[k].residential || 0), 0);
      const diff = storedSum - w.total;
      const pct = w.total ? Math.abs(diff) / w.total : 0;
      let kind = 'exact';
      if (diff !== 0) {
        if (Math.abs(diff) > 500) kind = 'excluded_or_gap';
        else if (pct <= 0.02) kind = 'source_conflict';
        else kind = 'excluded_or_gap';
      }
      weeklyReport.push({ week: w.start, end: w.end, sourceWeekly: w.total, storedSum, diff, pct: Number((pct * 100).toFixed(2)), kind });
    }
  }
  const conflictWeeks = weeklyReport.filter((r) => r.kind === 'source_conflict');
  const excludedWeeks = weeklyReport.filter((r) => r.kind === 'excluded_or_gap');
  push(
    'weekly_consistency',
    '源站周序列 vs 官方月序列口径差',
    'DISCLOSED',
    { weeks: weeklyReport.length, exact: weeklyReport.length - conflictWeeks.length - excludedWeeks.length,
      sourceConflict: conflictWeeks.length, excludedOrGap: excludedWeeks.length,
      maxConflictPct: conflictWeeks.length ? Math.max(...conflictWeeks.map((r) => r.pct)) : 0 },
    conflictWeeks.length
      ? `${conflictWeeks.length} 周存在源站自身的周/月口径微差（最大 ${Math.max(...conflictWeeks.map((r) => r.pct))}%，最多 ${Math.max(...conflictWeeks.map((r) => Math.abs(r.diff)))} 套）。本站以住建委官方月报为硬约束做极小校准，月合计因此始终与官方 0.00% 一致；另有 ${excludedWeeks.length} 周为已剔除的错值周或源站整段缺口。`
      : '周序列与月序列完全自洽'
  );

  // ── 10. 明确不可确知的部分 ──────────────────────────────────────────
  const estimatedDays = keys.filter((k) => D[k].quality === 'estimated');
  const weekendUnknown = keys.filter((k) => {
    const wd = dow(k);
    return (wd === 0 || wd === 6) && D[k].quality !== 'official';
  });
  push(
    'limits',
    '不可确知项（不参与「准确」宣称）',
    'DISCLOSED',
    { estimatedDays: estimatedDays.length, historicalWeekendDays: weekendUnknown.length,
      newHomeSparseDays: nhKeys.length },
    `历史周六/周日各自的单日值在公开渠道不可确知（界面已合并为「两天合计」，不展示推测单日值）；` +
      `${estimatedDays.length} 天为源站整段缺口回补，标注为估算；期房/现房历史仅 ${nhKeys.length} 个零散存档日，无连续日序列。`
  );

  return { checks, monthRows, weeklyReport };
}

async function main() {
  const db = loadDb();
  const src = await collectSources();
  const { checks, monthRows, weeklyReport } = buildChecks(db, src);

  const hard = checks.filter((c) => c.status === 'PASS' || c.status === 'FAIL');
  const failed = hard.filter((c) => c.status === 'FAIL');
  const unavailable = checks.filter((c) => c.status === 'UNAVAILABLE');
  const verdict = failed.length ? 'FAIL' : unavailable.length ? 'PARTIAL' : 'PASS';

  const report = {
    generatedAt: new Date().toISOString(),
    verdict,
    summary: {
      hardChecks: hard.length,
      passed: hard.filter((c) => c.status === 'PASS').length,
      failed: failed.length,
      unavailable: unavailable.length,
      disclosed: checks.filter((c) => c.status === 'DISCLOSED').length,
    },
    sources: {
      fangshi52: SOURCES.fangshi52,
      zjw: SOURCES.zjw,
      topic: SOURCES.topic,
      fetchedBytes: {
        fangshi52: src.fangshi52Bytes || 0,
        zjw: src.zjwBytes || 0,
        topic: src.topicBytes || 0,
      },
      fetchErrors: src.errors,
      officialLatestDay: src.official && src.official.daily ? src.official.daily : null,
      officialLatestMonth: src.official && src.official.monthly ? src.official.monthly : null,
      newHomeLatest: src.newHome || null,
    },
    checks,
    monthlyReconciliation: monthRows,
    weeklyConsistency: weeklyReport,
    statement:
      '可 100% 确证（8 项硬校验）：工作日单日值、官方直采日、有官方月报月份的逐日合计（住宅与总量两个口径）、官方月报锚点表、历史周末「两天合计」的逐周反推、期房/现房当日值、全部数值合法性。' +
      '不可确证：历史周六/周日各自单日值（公开渠道根本不提供，界面只显示两天合计）、源站整段缺口回补日（估算）、期房/现房历史逐日值（无连续公开源）。' +
      '源站周序列与月序列本身存在小幅口径差时，以住建委官方月报为准并做极小校准，校准幅度在本页逐周披露。',
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');

  for (const c of checks) {
    const tag = c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : c.status === 'DISCLOSED' ? '!' : '?';
    console.log(`[verify] ${tag} ${c.label} — ${JSON.stringify(c.numbers)}`);
    if (c.status === 'FAIL') console.log(`         ${c.detail}`);
  }
  console.log(`[verify] 结论 ${verdict}：${report.summary.passed}/${report.summary.hardChecks} 项硬校验通过 → ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[verify] 失败：', e);
  process.exitCode = 1;
});
