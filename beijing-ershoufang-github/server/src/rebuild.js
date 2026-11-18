'use strict';

/**
 * 历史重建：把「工作日日值（精确）」+「周末回补」拼成完整日序列，并用官方月报交叉校验。
 *
 * 事实基础（已验证）：
 *   1. 住建委官方页 **每天** 都发布存量房网签数据，包含周六、周日。
 *      证据：Wayback 2022-10-24（周一）快照显示 "2022/10/23存量房网上签约"（周日，住宅 85 套）。
 *   2. 北京房市儿「最近一年」页同时给出
 *        · 每日住宅签约套数 —— 只保留工作日（周末被过滤掉了）
 *        · 每周住宅签约套数 —— 含周末
 *        · 每月住宅签约套数 —— 与住建委月报同口径
 *      因此：周总量 − 本周工作日合计 = 该周周末合计（精确，非估算）。
 *   3. 该等式已被第三方交叉验证：冰山指数同期周末合计为 19 / 911 / 268，
 *      与本方法算出的结果分毫不差。
 *
 * ─────────────────────────────────────────────────────────────────────
 * v2 修正（针对「周末数据明显错误」）：
 *
 *   a. **周总量会被校验**。房市儿的周序列存在个别错值：2026-05-18 那周报 8,570，
 *      而同一周工作日合计只有 3,801，残差 4,769（正常 200–600）。
 *      旧版把 4,769 整个当成周末，于是 05-23 显示 3,148、05-24 显示 1,621。
 *      现在：残差超过全局中位数 3 倍的周视为「周总量不可信」，不参与周末推导。
 *
 *   b. **月报是硬锚**。有官方月报的月份，月合计必须精确等于官方值；
 *      剩余未知日（缺口工作日 + 待定周末）按「日权重」分配这点预算。
 *      这样某一周的错值不会污染其它周，月合计也永远闭合。
 *
 *   c. **日权重模型**。每个未知日给一个相对权重：
 *        普通工作日 = 星期效应（周一偏低、周五偏高）
 *        周六 / 周日 = 由实测「周末占周总量比例」反推
 *        法定假日   = 0.05（住建委在假日仍发布，但只有几十套，如 2026-10-01 仅 31 套）
 *        调休上班的周六 = 按工作日算
 *      按权重分预算，避免旧版把 5,000 套硬摊给一个法定假日这种荒谬结果。
 *
 *   d. **引入法定节假日日历**（server/src/calendar.js）。
 *      2026-05-04/05-05 是劳动节假期，不是数据缺口。
 *
 *   e. **历史缺口用第三方周报做形状**。2026-04-24~05-15 房市儿整段无数据，
 *      改用凤凰网房产「凰家周刊」每周住宅网签套数作为各周的相对强弱（weekScale），
 *      再受月报总量约束回补，标记 quality='estimated'。
 *
 *   f. **新增总量口径**（网上签约套数）。住建委月报同月同时给出「网上签约套数」和
 *      「住宅签约套数」，用当月住宅占比把逐日住宅值换算成总量，月合计对齐官方总量。
 */

const { SOURCES, fetchText, parseFangshiAll } = require('./parse');
const store = require('./store');
const external = require('./external');
const cal = require('./calendar');
const historyArchive = require('./historyArchive');

/**
 * 周六占周末总量的比例 —— 只用于「历史」周末的拆分。
 *
 * 注意：住建委官方页其实是**每天**都发布数据的（含周六、周日），
 * 只是页面一次只显示最新一天、约延迟 1~2 天，且房市儿把它画成「工作日曲线」造成周末无数据的错觉。
 * 因此本项目的爬虫只要持续运行，新产生的周末日都会以 quality='official' 直接采到，不需要推算。
 * 这个比例只影响「历史上已经错过的周末」，属于近似值。
 *
 * 参考实测（冰山指数 2026-10-17/18）：190 : 78 ≈ 0.709
 */
const SAT_RATIO = Number(process.env.WEEKEND_SAT_RATIO || 0.7);

/** 调休上班的周六，签约量接近工作日，拆分比例要抬高 */
const MAKEUP_SAT_RATIO = 0.78;

/** 周末占周总量的经验比例（仅在无法从数据学到时兜底） */
const DEFAULT_WEEKEND_SHARE = 0.091;

/** 周残差相对全局中位数的可信上限，超过即视为周总量错误 */
const RESIDUAL_TRUST_FACTOR = 3.0;

/** 法定假日相对普通工作日的权重 */
const W_HOLIDAY = 0.05;

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const dowOf = (k) => fromKey(k).getDay(); // 0=周日
const isWeekendSlot = (k) => cal.isWeekendSlot(k);
const addDays = (k, n) => toKey(new Date(fromKey(k).getTime() + n * 86400000));

function datesBetween(a, b) {
  const out = [];
  let cur = fromKey(a);
  const end = fromKey(b);
  while (cur <= end) {
    out.push(toKey(cur));
    cur = new Date(cur.getTime() + 86400000);
  }
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 某天所在周的周一 */
function weekStartOf(k) {
  const w = dowOf(k);
  return addDays(k, w === 0 ? -6 : 1 - w);
}

/** 把某周的周末总量按比例拆到周六/周日 */
function splitWeekend(satKey, sunKey, sum) {
  const out = {};
  if (satKey && sunKey) {
    // 调休上班的那一天（无论周六还是周日）当天量接近工作日，比例要抬高
    let r = SAT_RATIO;
    if (cal.isMakeupWorkday(satKey)) r = MAKEUP_SAT_RATIO;
    else if (cal.isMakeupWorkday(sunKey)) r = 1 - MAKEUP_SAT_RATIO;
    const sat = Math.round(sum * r);
    out[satKey] = sat;
    out[sunKey] = sum - sat;
  } else if (satKey) {
    out[satKey] = sum;
  } else if (sunKey) {
    out[sunKey] = sum;
  }
  return out;
}

/**
 * 把 budget 按权重整数分配到 keys 上，保证总和精确等于 budget。
 */
function allocate(keys, budget, weightOf) {
  const weights = keys.map((k) => Math.max(weightOf(k), 1e-6));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const out = {};
  let acc = 0;
  keys.forEach((k, i) => {
    const v = i === keys.length - 1 ? budget - acc : Math.round((budget * weights[i]) / wSum);
    const vv = Math.max(0, v);
    acc += vv;
    out[k] = vv;
  });
  return out;
}

/**
 * @param {object} opts
 * @param {boolean} opts.persist 是否写库
 */
async function rebuild({ persist = true, verbose = true } = {}) {
  const log = (...a) => verbose && console.log('[rebuild]', ...a);

  const html = await fetchText(SOURCES.fangshi52);
  const { daily, weekly, monthly } = parseFangshiAll(html);
  log(`解析到 日 ${Object.keys(daily).length} 条 / 周 ${weekly.length} 条 / 月 ${Object.keys(monthly).length} 条`);

  const db = store.get();
  const ext = external.get();
  const warnings = [];

  // ── 0) 永久历史保护：先把当前库完整吸收进 append-only 存档 ───────────
  //   滚动源只覆盖最近约一年；窗口滑走的老日期必须在这里先存档，
  //   否则下面 `const days = {}` 会把它们整体丢掉（用户要求「只增不删」）。
  const protectedDays = historyArchive.absorb(db);

  // ── 1) 基础日序列：工作日实值 ───────────────────────────────────────
  const days = {};
  for (const [date, value] of Object.entries(daily)) {
    days[date] = { date, residential: value, quality: 'exact', sources: ['fangshi-daily'] };
  }

  // 数据序列的实际边界（房市儿「最近一年」约 52 周，首尾月是残缺月）
  {
    const ks = Object.keys(days).sort();
    var firstDay = ks[0];
    var lastDayKey = ks[ks.length - 1];
  }

  // ── 1.1) 把存档里、本次滚动源不再覆盖的日期原样带回 ────────────────
  //   标记 archived:true：不参与 step 4/5b 的月度分摊与收口，
  //   也不参与 step 7 的总量口径重算，历史数值永不被静默改写。
  let carried = 0;
  for (const [date, rec] of Object.entries(protectedDays)) {
    if (days[date]) continue;
    days[date] = {
      ...rec,
      date,
      archived: true,
      sources: [...new Set([...(rec.sources || []), 'history-archive'])],
    };
    carried++;
  }
  if (carried) log(`历史保护：带回 ${carried} 天（滚动窗口之外的旧数据，只增不删）`);

  const estimatedDays = new Set();

  // 官方直采（含总量口径）优先级最高
  const officialDays = {};
  for (const [k, v] of Object.entries(db.days || {})) {
    if (v.quality === 'official') officialDays[k] = v;
  }
  for (const [date, v] of Object.entries(officialDays)) {
    days[date] = {
      ...(days[date] || {}),
      ...v,
      date,
      quality: 'official',
      sources: [...new Set([...(days[date]?.sources || []), 'zjw'])],
    };
  }
  if (Object.keys(officialDays).length) log(`保留官方直采 ${Object.keys(officialDays).length} 天`);

  // ── 1.5) 官方「逐日」真实值注入（用户提供的官方统计表截图转录）────────
  //   该表给出 2026-01-01 ~ 2026-11-08 的逐日住宅网签套数（含周六、周日），
  //   来源 IMG_5944（3~11月）与 IMG_5953（1~10月）交叉校验一致，
  //   各月合计与住建委月报底行完全一致，是历史逐日最权威的来源。
  //   注入后：周末不再用 SAT_RATIO 估算；历史逐日序列与官方月报同时精确闭合
  //   （逐行求和 == 官方月报，故 step 4/5b 收口变为零差 no-op）。
  try {
    const officialTable = require('./officialTable');
    const offMap = officialTable.expand();
    let inj = 0;
    for (const [date, value] of Object.entries(offMap)) {
      const prev = days[date];
      if (prev) {
        prev.residential = value;
        prev.quality = 'official';
        prev.sources = [...new Set([...(prev.sources || []), 'official-table'])];
        prev.officialTable = true;
      } else {
        days[date] = {
          date,
          residential: value,
          quality: 'official',
          sources: ['official-table'],
          officialTable: true,
        };
      }
      inj++;
    }
    if (inj) log(`注入官方逐日表 ${inj} 天（含周末真实值，2026-01-01 ~ 2026-11-08），历史周末不再估算`);
  } catch (e) {
    log(`官方逐日表不可用，跳过注入：${e.message}`);
  }

  // ── 1.6) 每日官方直采存档注入（新增日期，含周末）────────────────────
  //   官方逐日表止于 2026-11-08，之后每天由 scraper 采到「最新一日」并落盘。
  //   存档优先级最高：凡存档里有的日期，一律用官方真实值覆盖推算值，
  //   这样新周末不会退回 SAT_RATIO 的 70/30 估算。
  try {
    const archive = require('./captureArchive');
    const recs = archive.expand();
    let inj2 = 0;
    for (const [date, r] of Object.entries(recs)) {
      if (r.residential == null) continue;
      const prev = days[date];
      if (prev) {
        prev.residential = r.residential;
        if (r.total != null) prev.total = r.total;
        prev.quality = 'official';
        prev.sources = [...new Set([...(prev.sources || []), 'zjw-archive'])];
        prev.officialCapture = true;
      } else {
        days[date] = {
          date,
          residential: r.residential,
          total: r.total ?? null,
          quality: 'official',
          sources: ['zjw-archive'],
          officialCapture: true,
        };
      }
      inj2++;
    }
    if (inj2) log(`注入每日直采存档 ${inj2} 天（新增周末为官方真实值，不再估算）`);
  } catch (e) {
    log(`直采存档不可用，跳过注入：${e.message}`);
  }

  // ── 2) 周锚（房市儿周序列 + 凰家周刊交叉校验）─────────────────────
  const weekAnchors = new Map();
  for (const w of weekly) {
    if (!w.end) continue; // 当前周未结束
    weekAnchors.set(weekStartOf(w.start), {
      total: w.total,
      source: 'fangshi-weekly',
      derived: false,
    });
  }
  for (const [start, e] of Object.entries(ext.weekly || {})) {
    const prev = weekAnchors.get(start);
    if (prev && Math.abs(prev.total - e.residential) / e.residential > 0.02) {
      warnings.push(
        `周总量冲突 ${start}：房市儿 ${prev.total} vs 凰家周刊 ${e.residential}，采用凰家周刊`
      );
    }
    weekAnchors.set(start, {
      total: e.residential,
      source: e.derived ? 'huangjia-weekly-derived' : 'huangjia-weekly',
      derived: !!e.derived,
    });
  }

  const weekStarts = [...weekAnchors.keys()].sort();
  const anchorValues = weekStarts.map((s) => weekAnchors.get(s).total);
  const anchorMedian = median(anchorValues) || 1;

  /** 每周构成 */
  const weekInfo = new Map();
  for (const start of weekStarts) {
    const all = datesBetween(start, addDays(start, 6));
    const weekdays = all.filter((d) => !isWeekendSlot(d));
    const sat = all.find((d) => dowOf(d) === 6) || null;
    const sun = all.find((d) => dowOf(d) === 0) || null;
    const present = weekdays.filter((d) => days[d]);
    const missing = weekdays.filter((d) => !days[d]);
    const presentSum = present.reduce((s, d) => s + days[d].residential, 0);
    const a = weekAnchors.get(start);
    weekInfo.set(start, {
      start,
      end: addDays(start, 6),
      anchor: a.total,
      anchorSource: a.source,
      anchorDerived: a.derived,
      weekScale: Math.min(1.35, Math.max(0.65, a.total / anchorMedian)),
      weekdays,
      present,
      missing,
      presentSum,
      sat,
      sun,
      residual: missing.length ? null : a.total - presentSum,
    });
  }

  // 残差可信度
  const residuals = [...weekInfo.values()].filter((w) => w.residual != null).map((w) => w.residual);
  const residualMedian = median(residuals.filter((r) => r >= 0));
  const residualCap = residualMedian * RESIDUAL_TRUST_FACTOR;
  log(`周残差中位数 ${Math.round(residualMedian)}，可信上限 ${Math.round(residualCap)}`);

  // 周末占周总量比例（只用「工作日齐全 + 残差可信」的周来学）
  const shareSamples = [];
  for (const w of weekInfo.values()) {
    if (w.residual == null || !w.anchor) continue;
    if (w.residual < 0 || w.residual > residualCap) continue;
    shareSamples.push(w.residual / w.anchor);
  }
  const weekendShare = shareSamples.length ? median(shareSamples) : DEFAULT_WEEKEND_SHARE;

  // 周末日相对工作日的权重：由 weekendShare 反推
  const wSat = (5 * weekendShare * SAT_RATIO) / (1 - weekendShare);
  const wSun = (5 * weekendShare * (1 - SAT_RATIO)) / (1 - weekendShare);
  log(
    `周末占周总量 ${(weekendShare * 100).toFixed(1)}%（样本 ${shareSamples.length} 周）` +
      ` → 日权重 周六 ${wSat.toFixed(2)} / 周日 ${wSun.toFixed(2)}`
  );

  // 周末中位总量 & 工作日中位值（用于「周总量不可信 / 边界残缺周」的兜底估计）
  const reliableResiduals = [...weekInfo.values()]
    .filter((w) => w.residual != null && w.residual > 0 && w.residual < residualCap && !w.anchorDerived)
    .map((w) => w.residual);
  const medianWeekend = median(reliableResiduals) || 350;
  const allExact = Object.values(days).filter((d) => d.quality === 'exact');
  const medianWeekday = median(allExact.map((d) => d.residential)) || 680;
  log(`周末中位总量 ${Math.round(medianWeekend)}，工作日中位 ${Math.round(medianWeekday)}`);

  /** 用中位周末模式估计某周六/周日（调休上班日按工作日、法定假日按近零估计） */
  function estimateWeekend(satKey, sunKey) {
    const valOf = (k) => {
      if (cal.isMakeupWorkday(k)) return Math.round(medianWeekday); // 调休上班 = 工作日量级
      if (cal.isHoliday(k)) return Math.round(medianWeekday * 0.05); // 法定假日极少签约
      const isSat = dowOf(k) === 6;
      return Math.round(medianWeekend * (isSat ? SAT_RATIO : 1 - SAT_RATIO));
    };
    const out = {};
    if (satKey) out[satKey] = valOf(satKey);
    if (sunKey) out[sunKey] = valOf(sunKey);
    return out;
  }

  // 星期效应：各工作日值 / 该周工作日均值
  const dowFactors = {};
  {
    const acc = {};
    for (const w of weekInfo.values()) {
      if (w.missing.length || !w.present.length) continue;
      const mean = w.presentSum / w.present.length;
      if (mean <= 0) continue;
      for (const d of w.present) {
        if (cal.isHoliday(d)) continue; // 假日值极低，会污染星期效应
        const f = days[d].residential / mean;
        (acc[dowOf(d)] = acc[dowOf(d)] || []).push(f);
      }
    }
    for (const [k, v] of Object.entries(acc)) dowFactors[k] = median(v);
  }

  /** 某未知日的相对权重 */
  function dayWeight(k) {
    const ws = weekInfo.get(weekStartOf(k));
    const scale = ws ? ws.weekScale : 1;
    if (cal.isHoliday(k)) return W_HOLIDAY * scale;
    if (cal.isMakeupWorkday(k)) return (dowFactors[dowOf(k)] || 1) * scale;
    if (dowOf(k) === 6) return wSat * scale;
    if (dowOf(k) === 0) return wSun * scale;
    return (dowFactors[dowOf(k)] || 1) * scale;
  }

  // ── 3) 第一遍：工作日齐全且残差可信的周 → 周末合计精确 ─────────────
  const suspiciousWeeks = [];

  for (const w of weekInfo.values()) {
    if (w.residual == null) continue;

    const satOfficial = w.sat && days[w.sat] && days[w.sat].quality === 'official';
    const sunOfficial = w.sun && days[w.sun] && days[w.sun].quality === 'official';
    if ((!w.sat || satOfficial) && (!w.sun || sunOfficial)) continue;

    if (w.residual < 0 || w.residual > residualCap) {
      suspiciousWeeks.push({
        week: w.start,
        residual: w.residual,
        anchor: w.anchor,
        source: w.anchorSource,
      });
      // 周总量不可信：周末改由「中位周末模式」估计，绝不信奉错误的周总量
      const est = estimateWeekend(w.sat, w.sun);
      for (const [k, v] of Object.entries(est)) {
        if (!days[k] || days[k].quality === 'derived' || days[k].quality === 'estimated') {
          days[k] = {
            date: k,
            residential: v,
            quality: 'derived',
            sources: ['median-weekend'],
            calibrated: true,
          };
        }
      }
      continue;
    }

    if (satOfficial) {
      const rest = w.residual - days[w.sat].residential;
      if (w.sun && rest >= 0 && !sunOfficial) {
        days[w.sun] = { date: w.sun, residential: rest, quality: 'derived', sources: ['weekly-residual'] };
      }
      continue;
    }
    if (sunOfficial) {
      const rest = w.residual - days[w.sun].residential;
      if (w.sat && rest >= 0 && !satOfficial) {
        days[w.sat] = { date: w.sat, residential: rest, quality: 'derived', sources: ['weekly-residual'] };
      }
      continue;
    }

    const split = splitWeekend(w.sat, w.sun, w.residual);
    for (const [k, v] of Object.entries(split)) {
      days[k] = { date: k, residential: v, quality: 'derived', sources: ['weekly-residual'] };
    }
  }

  if (suspiciousWeeks.length) {
    log(`⚠ ${suspiciousWeeks.length} 个周总量不可信（残差 > ${Math.round(residualCap)}），改由月报锚定：`);
    for (const s of suspiciousWeeks) {
      log(`   ${s.week} 周总量 ${s.anchor}（${s.source}）残差 ${s.residual}`);
      warnings.push(
        `周总量异常 ${s.week}：${s.anchor}（${s.source}），残差 ${s.residual} 远超正常范围，已忽略`
      );
    }
  }

  // ── 3.5) 边界周 / 缺口周（residual 为 null）的周末估计 ──────────────
  //   这些周的「工作日不全」或「周总量不可信」，无法精确反推周末；
  //   用「中位周末模式」兜底（调休上班日按工作日中位、法定假日按近零估计）。
  for (const w of weekInfo.values()) {
    if (w.residual != null) continue; // 已由 step 3 精确处理
    const est = estimateWeekend(w.sat, w.sun);
    for (const [k, v] of Object.entries(est)) {
      if (days[k]) continue;
      days[k] = {
        date: k,
        residential: v,
        quality: cal.isMakeupWorkday(k) ? 'estimated' : 'derived',
        sources: ['median-weekend'],
        calibrated: true,
      };
      if (cal.isMakeupWorkday(k)) estimatedDays.add(k);
    }
  }

  // ── 4) 月度锚定：把剩余未知日按权重分配到「官方月报 − 已知合计」────────
  const months = { ...db.months };
  for (const [m, value] of Object.entries(monthly)) {
    months[m] = {
      ...(months[m] || {}),
      month: m,
      year: Number(m.slice(0, 4)),
      monthNum: Number(m.slice(5, 7)),
      residential: value,
      official: true,
      source: 'fangshi-monthly',
    };
  }

  // ── 4.1) 官方逐日表覆盖的整月：月报锚改用逐日表求和 ──────────────────
  //   逐日表是权威；房市儿月报偶有 1 套零头（2026-02 报 8130，逐日表 8129）。
  //   若沿用旧锚，step 5b 在「整月每天都已是 official、没有可调整推算日」时
  //   会报「无法收口」告警，且月度对比图与逐日序列差 1 套。整月以逐日表为准。
  try {
    const offTbl = require('./officialTable');
    const offTotals = offTbl.computedTotals();
    for (const m of offTbl.FULL_MONTHS) {
      if (!months[m] || offTotals[m] == null) continue;
      if (months[m].residential !== offTotals[m]) {
        log(`月报锚 ${m}: ${months[m].residential} → 官方逐日表 ${offTotals[m]}`);
        months[m] = { ...months[m], residential: offTotals[m], official: true, source: 'official-table' };
      }
    }
  } catch (e) {
    log(`月报锚校准跳过：${e.message}`);
  }

  const allKeys = () => Object.keys(days).sort();
  const monthKeys = [
    ...new Set([...Object.keys(months), ...allKeys().map((k) => k.slice(0, 7))]),
  ].sort();

  for (const m of monthKeys) {
    const official = months[m] && months[m].official ? months[m].residential : null;
    if (!official) continue;

    const [y, mo] = m.split('-').map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    const monthFirst = `${m}-01`;
    const monthLast = `${m}-${pad(lastDay)}`;

    // 仅对「数据序列完整覆盖」的月份做月报锚定。
    // 首尾残缺月（如 2025-10、2026-10）序列不足一个月，全月官方总量无法合法分摊，
    // 其周末已由 step 3.5 用中位模式估计，缺口工作日则保留为缺失（序列之外，非真缺口）。
    if (monthFirst < firstDay || monthLast > lastDayKey) {
      warnings.push(`${m} 为残缺边界月（序列 ${firstDay}~${lastDayKey}），跳过月报锚定，周末用中位模式估计`);
      continue;
    }

    const slots = [];
    for (let d = 1; d <= lastDay; d++) slots.push(`${m}-${pad(d)}`);

    // 仅在该月「数据序列覆盖范围内」的缺失日参与分摊
    const unknown = slots.filter((k) => !days[k] && k >= firstDay && k <= lastDayKey);
    if (!unknown.length) continue;

    const knownSum = slots
      .filter((k) => days[k] && k >= firstDay && k <= lastDayKey)
      .reduce((s, k) => s + days[k].residential, 0);
    const budget = official - knownSum;
    if (budget < 0) {
      warnings.push(`${m} 月报 ${official} 小于已知合计 ${knownSum}，跳过月度锚定`);
      continue;
    }

    // 缺的工作日（含假日、调休上班日）标记为「回补」，纯周末标记为「推算」
    const assign = allocate(unknown, budget, dayWeight);
    for (const k of unknown) {
      const isGapDay = cal.isTradingDay(k) || cal.isHoliday(k) || cal.isMakeupWorkday(k);
      days[k] = {
        date: k,
        residential: assign[k],
        quality: isGapDay ? 'estimated' : 'derived',
        sources: ['monthly-anchor'],
        calibrated: true,
      };
      if (isGapDay) estimatedDays.add(k);
    }
  }

  // ── 5) 无月报的月份（含当前进行中的月）→ 用周锚回补 ────────────────
  for (const w of weekInfo.values()) {
    const satMissing = w.sat && !days[w.sat];
    const sunMissing = w.sun && !days[w.sun];
    if (!w.missing.length && !satMissing && !sunMissing) continue;

    // 已知合计（含已由其它途径确定的日子）
    const all = datesBetween(w.start, w.end);
    const known = all.filter((k) => days[k]);
    const unknown = all.filter((k) => !days[k]);
    if (!unknown.length) continue;

    const knownSum = known.reduce((s, k) => s + days[k].residential, 0);
    const budget = w.anchor - knownSum;
    if (budget < 0) {
      warnings.push(`${w.start} 周锚 ${w.anchor} 小于已知合计 ${knownSum}，跳过`);
      continue;
    }

    const assign = allocate(unknown, budget, dayWeight);
    for (const k of unknown) {
      const isGapDay = cal.isTradingDay(k) || cal.isHoliday(k) || cal.isMakeupWorkday(k);
      days[k] = {
        date: k,
        residential: assign[k],
        quality: isGapDay ? 'estimated' : 'derived',
        sources: ['weekly-anchor'],
        anchor: w.anchorSource,
        calibrated: true,
      };
      if (isGapDay) estimatedDays.add(k);
    }
  }

  // ── 5b) 收口：所有日子都已确定、但月合计仍与官方有零头的月份 ─────────
  //      这类零头来自「周残差精确推导」与「官方月报」之间的口径微差（约 0.3%），
  //      按比例摊到推算出的周末日上，保证月度对比图与官方月报完全一致。
  for (const m of monthKeys) {
    const official = months[m] && months[m].official ? months[m].residential : null;
    if (!official) continue;
    const inMonth = allKeys().filter((k) => k.startsWith(m));
    if (!inMonth.length) continue;
    const sum = inMonth.reduce((s, k) => s + days[k].residential, 0);
    const diff = official - sum;
    if (diff === 0) continue;

    const pool = inMonth.filter((k) => !days[k].archived && days[k].quality === 'derived');
    const poolSum = pool.reduce((s, k) => s + days[k].residential, 0);
    if (!pool.length || poolSum <= 0) {
      warnings.push(`${m} 偏差 ${diff} 套无法收口（没有可调整的推算日）`);
      continue;
    }
    const factor = (poolSum + diff) / poolSum;
    pool.forEach((k) => {
      days[k].residential = Math.max(0, Math.round(days[k].residential * factor));
      days[k].calibrated = true;
    });
    // 最后一格吸收取整误差
    const after = pool.reduce((s, k) => s + days[k].residential, 0);
    const lastKey = pool[pool.length - 1];
    days[lastKey].residential = Math.max(
      0,
      days[lastKey].residential + Math.round(poolSum + diff - after)
    );
  }

  // ── 6) 对账 ────────────────────────────────────────────────────────
  const reconciliation = [];
  for (const m of monthKeys) {
    const inMonth = allKeys().filter((k) => k.startsWith(m));
    if (!inMonth.length) continue;
    const nonWeekend = inMonth.filter((k) => !isWeekendSlot(k));
    const sum = inMonth.reduce((s, k) => s + days[k].residential, 0);
    const official = months[m] && months[m].official ? months[m].residential : null;
    const missingTrading = nonWeekend.filter((k) => !days[k] && cal.isTradingDay(k));

    reconciliation.push({
      month: m,
      days: inMonth.length,
      weekdays: nonWeekend.length,
      estimated: inMonth.filter((k) => days[k].quality === 'estimated').length,
      derived: inMonth.filter((k) => days[k].quality === 'derived').length,
      sum,
      official,
      deviation: official ? Number((((sum - official) / official) * 100).toFixed(2)) : null,
      missingWeekdays: missingTrading.length,
      complete: missingTrading.length === 0,
    });
  }

  // ── 7) 总量口径（网上签约套数）────────────────────────────────────
  const monthTotals = {};
  for (const m of monthKeys) {
    const inMonth = allKeys().filter((k) => k.startsWith(m));
    if (!inMonth.length) continue;
    const { ratio, exact, source } = external.residentialRatio(m);
    const resSum = inMonth.reduce((s, k) => s + days[k].residential, 0);
    const mt = ext.monthlyTotal[m];
    const targetTotal = exact && mt && mt.total ? mt.total : Math.round(resSum / ratio);

    for (const k of inMonth) {
      const d = days[k];
      // 官方逐日表替换了「住宅」值之后，旧的 total 是注入前的换算结果，必须作废重算。
      // 否则「网上签约套数」视图里的周末日仍是旧估算值——这正是「周六+周日合计」
      // 显示错误却查不出来的原因。只有 zjw 当日直采（officialCapture）才保留原值。
      // 历史保护带回的旧日：数值（含 total）原样冻结，不做任何重算/收口。
      // 只有官方逐日表或官方直采覆盖它时才允许刷新。
      if (d.archived && d.total != null && !d.officialTable && !d.officialCapture) {
        d.totalQuality = d.totalQuality || 'archived';
        continue;
      }
      const replacedByTable = !!d.officialTable && !d.officialCapture && !d.totalOfficial;
      if (!replacedByTable && d.quality === 'official' && d.total != null) {
        d.totalQuality = 'official'; // 官方直采的总量原值，收口时不得改写
        continue;
      }
      d.total = Math.max(0, Math.round(d.residential / ratio));
      d.totalQuality = 'derived';
    }
    const totalSum = inMonth.reduce((s, k) => s + days[k].total, 0);
    const diff = targetTotal - totalSum;
    if (diff !== 0) {
      // 收口差额只能摊到「非官方直采的工作日」。
      // 旧实现把整月差额全砸在月末最后一天；2026-10-31 恰为周六，
      // 于是那个周末的「周六+周日合计」被整体抬高，属于典型的错误来源。
      // 周末两天都不参与收口，保证合计 = 官方住宅值按当月口径的换算结果。
      const adjustable = inMonth.filter(
        (k) => !days[k].archived && days[k].totalQuality !== 'official' && !cal.isWeekendSlot(k)
      );
      const pool = adjustable.length
        ? adjustable
        : inMonth.filter((k) => !days[k].archived && days[k].totalQuality !== 'official');
      const poolSum = pool.reduce((s, k) => s + days[k].total, 0);
      if (poolSum > 0) {
        let left = diff;
        pool.forEach((k, i) => {
          const share = i === pool.length - 1
            ? left
            : Math.round((diff * days[k].total) / poolSum);
          days[k].total = Math.max(0, days[k].total + share);
          left -= share;
        });
      }
    }

    monthTotals[m] = {
      total: targetTotal,
      residential: resSum,
      ratio: Number(ratio.toFixed(4)),
      exact,
      source: exact ? source : '按当月住宅占网签总量比例推算',
    };
    months[m] = {
      ...(months[m] || { month: m, year: Number(m.slice(0, 4)), monthNum: Number(m.slice(5, 7)) }),
      total: targetTotal,
      totalExact: exact,
      totalRatio: Number(ratio.toFixed(4)),
    };
  }

  // ── 8) 缺口检测（首尾之间缺失的交易日，法定假日不算）──────────────
  const keys = allKeys();
  const first = keys[0];
  const last = keys[keys.length - 1];
  const gaps = [];
  if (first && last) {
    let run = null;
    for (const d of datesBetween(first, last)) {
      if (!days[d] && cal.isTradingDay(d)) {
        if (!run) run = { from: d, to: d, days: 1 };
        else {
          run.to = d;
          run.days++;
        }
      } else if (run) {
        gaps.push(run);
        run = null;
      }
    }
    if (run) gaps.push(run);
  }

  const counts = {
    total: keys.length,
    official: keys.filter((k) => days[k].quality === 'official').length,
    exact: keys.filter((k) => days[k].quality === 'exact').length,
    derived: keys.filter((k) => days[k].quality === 'derived').length,
    estimated: keys.filter((k) => days[k].quality === 'estimated').length,
  };

  const next = {
    meta: {
      ...db.meta,
      updatedAt: new Date().toISOString(),
      rebuiltAt: new Date().toISOString(),
      range: { from: first || null, to: last || null },
      counts,
      satRatio: SAT_RATIO,
      weekendShare: Number(weekendShare.toFixed(4)),
      residualMedian: Math.round(residualMedian),
      gaps,
      warnings: warnings.slice(0, 60),
      reconciliation,
      suspiciousWeeks,
      monthTotals,
      estimatedDays: [...estimatedDays].sort(),
      history: {
        ...historyArchive.stats(),
        carriedThisRun: carried,
      },
    },
    days,
    months,
    // 期房/现房直采数据是独立累积的，重建存量房日序列时必须原样带走
    newHomes: db.newHomes || {},
    // 可售期房 / 未签约现房「住宅套数」库存统计，同样是独立累积的
    stocks: db.stocks || {},
  };

  if (persist) store.save(next);

  log(
    `重建完成：${keys.length} 天（官方 ${counts.official} / 工作日实值 ${counts.exact} / 周末推算 ${counts.derived} / 缺口回补 ${counts.estimated}）`
  );
  if (gaps.length)
    log(`仍有 ${gaps.length} 处缺口：`, gaps.map((g) => `${g.from}~${g.to}(${g.days}天)`).join(', '));
  else log('数据缺口：无');
  for (const r of reconciliation.filter((x) => x.official)) {
    log(
      `  ${r.month}  合计 ${r.sum}  官方 ${r.official}  偏差 ${r.deviation}%` +
        `${r.estimated ? `  回补 ${r.estimated} 天` : ''}`
    );
  }

  return next;
}

module.exports = { rebuild, SAT_RATIO };
