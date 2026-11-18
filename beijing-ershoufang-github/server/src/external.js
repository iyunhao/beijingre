'use strict';

/**
 * 外部补充数据（server/data/external.json）
 *
 *  - prevYear：去年同月「住宅签约套数」，用于同比。
 *    来源为住建委月报（媒体/机构转载），无法从日序列推导，故单独存档并标注出处。
 *  - lianjia：住建委「存量房网上签约月统计 · 按经纪机构」中链家的月度签约套数，
 *    以及同月全市网上签约总套数（市占率分母）。
 *    官方页只保留最新一个月，历史月份由 Wayback 快照补齐，之后由爬虫按月累积。
 *  - weekly：第三方（凤凰网房产北京「凰家周刊」）公布的**每周**住宅网签套数。
 *    房市儿的周序列存在个别错值（如 2026-05-18 那周报 8570，明显偏离），
 *    凰家周刊是独立来源，用来交叉校验并替换错值。
 *  - monthlyTotal：住建委月报口径的「网上签约套数」（含非住宅），用于第二个 tab。
 *    房市儿只提供住宅口径，总量口径需外部补齐，缺的月份按住宅占比推算。
 *  - annual：住建委「房产数据统计 · 近五年房屋网上签约统计」的年度汇总
 *    （2020–2024，单位万套 / 万平方米）。这是官方给出的**更长时间尺度**数据，
 *    但只有年度合计，没有逐日序列，不能拆成日历；仅用于长期趋势参照。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'external.json');

const README =
  '外部补充数据。prevYear 用于同比（住建委月报口径·住宅）；lianjia 为住建委「存量房网上签约月统计·按经纪机构」中链家的月度签约套数，cityTotal 为同月全市网上签约总套数（市占率分母）；weekly 为凤凰网房产「凰家周刊」每周住宅网签套数（用于校验/替换房市儿周序列的错值）；monthlyTotal 为住建委月报「网上签约套数」总量口径。';

const EMPTY = () => ({
  updatedAt: null,
  prevYear: {},
  lianjia: {},
  weekly: {},
  monthlyTotal: {},
  annual: null,
});

let cache = null;

function get() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      updatedAt: raw.updatedAt || null,
      prevYear: raw.prevYear || {},
      lianjia: raw.lianjia || {},
      weekly: raw.weekly || {},
      monthlyTotal: raw.monthlyTotal || {},
      annual: raw.annual || null,
    };
  } catch (e) {
    cache = EMPTY();
  }
  return cache;
}

function save(obj) {
  const out = {
    _readme: README,
    updatedAt: new Date().toISOString(),
    prevYear: obj.prevYear || {},
    lianjia: obj.lianjia || {},
    weekly: obj.weekly || {},
    monthlyTotal: obj.monthlyTotal || {},
    annual: obj.annual || null,
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  cache = {
    updatedAt: out.updatedAt,
    prevYear: out.prevYear,
    lianjia: out.lianjia,
    weekly: out.weekly,
    monthlyTotal: out.monthlyTotal,
    annual: out.annual,
  };
  return cache;
}

/** 把一次抓取到的机构统计合并进 external.json（同一月份幂等覆盖） */
function mergeAgency(parsed) {
  if (!parsed || !parsed.month || !parsed.lianjia) return null;
  const db = get();
  const prev = db.lianjia[parsed.month] || {};
  const entry = {
    count: parsed.lianjia.count,
    refund: parsed.lianjia.refund,
    cityTotal: parsed.cityTotal != null ? parsed.cityTotal : prev.cityTotal ?? null,
    cityResidential:
      parsed.cityResidential != null ? parsed.cityResidential : prev.cityResidential ?? null,
    source: '住建委月统计（实时抓取）',
    capturedAt: new Date().toISOString(),
  };
  const changed =
    prev.count !== entry.count ||
    prev.cityTotal !== entry.cityTotal ||
    prev.cityResidential !== entry.cityResidential;
  if (!changed) return { month: parsed.month, changed: false, entry: prev };

  db.lianjia[parsed.month] = entry;
  save(db);
  return { month: parsed.month, changed: true, entry };
}

/**
 * 该月「住宅 / 网上签约总量」占比。
 * 优先用官方月报同月两个口径直接相除；没有时用所有已知月份的加权中位数兜底。
 */
function residentialRatio(monthKey) {
  const db = get();
  const known = [];
  for (const [m, e] of Object.entries(db.lianjia)) {
    if (e.cityTotal && e.cityResidential) known.push(e.cityResidential / e.cityTotal);
  }
  for (const [m, e] of Object.entries(db.monthlyTotal)) {
    if (e.total && e.residential) known.push(e.residential / e.total);
  }
  const fallback = known.length
    ? known.slice().sort((a, b) => a - b)[Math.floor(known.length / 2)]
    : 0.893;

  const mt = db.monthlyTotal[monthKey];
  if (mt && mt.total && mt.residential) {
    return { ratio: mt.residential / mt.total, exact: true, source: mt.source || null };
  }
  const lj = db.lianjia[monthKey];
  if (lj && lj.cityTotal && lj.cityResidential) {
    return { ratio: lj.cityResidential / lj.cityTotal, exact: true, source: lj.source || null };
  }
  return { ratio: fallback, exact: false, source: null };
}

module.exports = { get, save, mergeAgency, residentialRatio, FILE };
