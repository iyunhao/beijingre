'use strict';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 数据源配置 */
const SOURCES = {
  // 北京市住建委 · 存量房网上签约统计（官方口径，含「最新一日」与「上一整月」）
  zjw: 'http://bjjs.zjw.beijing.gov.cn/eportal/ui?pageId=53610668',
  // 北京房市儿 · 最近 3 周（日序列，仅工作日）
  fangshi: 'http://www.beijingfangshi.com/wx_w12_pc.html',
  // 北京房市儿 · 最近一年（日/周/月三组序列，周序列含周末）
  fangshi52: 'http://www.beijingfangshi.com/wx_w52_pc.html',
  // 北京市住建委 · 房地产数据主题服务（含「存量房网上签约月统计 · 按经纪机构」）
  topic: 'http://bjjs.zjw.beijing.gov.cn/eportal/ui?pageId=307749',
  // 北京市住建委 · 房产数据统计（新版页面，含「截止日期」与可售期房/未签约现房统计）
  stats: 'https://zjw.beijing.gov.cn/bjjs/fdcjy/wqht/fcsjtj/index.shtml',
};

const { execFile } = require('child_process');

/** 原生 fetch（生产环境首选） */
async function viaFetch(url, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/** curl 兜底（部分容器/代理环境里 Node 直连会超时） */
function viaCurl(url, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-sS', '-L', '--compressed', '-m', String(Math.ceil(timeout / 1000)), '-A', UA, url],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        if (!stdout || !stdout.length) return reject(new Error('empty response'));
        resolve(stdout.toString('utf8'));
      }
    );
  });
}

async function fetchText(url, { timeout = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await viaFetch(url, timeout);
    } catch (e) {
      lastErr = e;
      try {
        return await viaCurl(url, timeout);
      } catch (e2) {
        lastErr = e2;
      }
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`抓取失败 ${url}: ${(lastErr && lastErr.message) || 'unknown'}`);
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '');

/**
 * 解析住建委「存量房网上签约统计」页面。
 * 返回 { monthly, daily }，任一可能为 null。
 *  monthly: { year, month, total, totalArea, residential, residentialArea }
 *  daily:   { date, total, totalArea, residential, residentialArea }
 */
function parseOfficial(html) {
  const out = { monthly: null, daily: null };
  const blocks = String(html).split('<h3>').slice(1);

  for (const raw of blocks) {
    const title = stripTags(raw.split('</h3>')[0] || '');
    const nums = [...raw.matchAll(/<td[^>]*class\s*=\s*"r"[^>]*>\s*([\d.]+)\s*<\/td>/g)].map((m) =>
      Number(m[1])
    );
    if (nums.length < 4) continue;

    const item = {
      total: nums[0],
      totalArea: nums[1],
      residential: nums[2],
      residentialArea: nums[3],
    };

    const mMonth = title.match(/^(\d{4})年(\d{1,2})月/);
    if (mMonth) {
      out.monthly = { year: Number(mMonth[1]), month: Number(mMonth[2]), ...item };
      continue;
    }
    const mDay = title.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (mDay) {
      out.daily = {
        date: `${mDay[1]}-${String(mDay[2]).padStart(2, '0')}-${String(mDay[3]).padStart(2, '0')}`,
        ...item,
      };
    }
  }
  return out;
}

/**
 * 解析「北京房市儿」页面里的日序列（住宅签约套数）。
 * 返回 [{ date, residential }]
 */
function parseFangshi(html) {
  const m = String(html).match(/Chartkick\.\w*Chart\(\s*document\.getElementById\([^)]*\)\s*,\s*(\{[^}]*\})/);
  if (!m) return [];
  const rows = [];
  const re = /'(\d{4}-\d{2}-\d{2})'\s*:\s*(\d+)/g;
  let x;
  while ((x = re.exec(m[1]))) rows.push({ date: x[1], residential: Number(x[2]) });
  return rows;
}

/** 官方月报 + 日序列 → 合并后的日数组 */
function mergeDaily(fangshiRows, officialDaily) {
  const map = new Map();
  for (const r of fangshiRows) {
    map.set(r.date, { date: r.date, residential: r.residential, sources: ['fangshi'] });
  }
  if (officialDaily) {
    const prev = map.get(officialDaily.date) || { date: officialDaily.date, sources: [] };
    map.set(officialDaily.date, {
      ...prev,
      total: officialDaily.total,
      totalArea: officialDaily.totalArea,
      residential: officialDaily.residential,
      residentialArea: officialDaily.residentialArea,
      sources: [...new Set([...(prev.sources || []), 'zjw'])],
    });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 解析「最近一年网签」页（wx_w52_pc.html）的三组序列。
 *
 * 页面里有三个图：
 *   1) 每日住宅签约套数  {'YYYY-MM-DD': n}     —— 只含工作日（周末不画）
 *   2) 每周住宅签约套数  [["YYYY-MM-DD\u81f3YYYY-MM-DD", n]]  —— 含周末
 *   3) 每月住宅签约套数  [["YYYY年M月存量房网上签约", n]]      —— 官方月报口径
 *
 * 关键：周序列含周末、日序列不含，所以「周总量 - 本周工作日合计 = 该周周末合计」，
 * 这是把周末补回来的唯一精确依据（已用官方月报交叉验证）。
 */
function parseFangshiAll(html) {
  const h = String(html);

  // 1) 日序列（同一份数据会出现在折线图和柱状图里，去重）
  const daily = {};
  const reDay = /'(\d{4}-\d{2}-\d{2})'\s*:\s*(\d+)/g;
  let x;
  while ((x = reDay.exec(h))) daily[x[1]] = Number(x[2]);

  // 2) 周序列
  const weekly = [];
  const reWeek = /\[\s*"(\d{4}-\d{2}-\d{2})(?:\\u81f3|至)([^"]*)"\s*,\s*(\d+)\s*\]/g;
  while ((x = reWeek.exec(h))) {
    weekly.push({ start: x[1], end: x[2] || null, total: Number(x[3]) });
  }

  // 3) 月序列（官方月报）
  const monthly = {};
  const reMonth = /\[\s*"(\d{4})年(\d{1,2})月存量房网上签约"\s*,\s*(\d+)\s*\]/g;
  while ((x = reMonth.exec(h))) {
    monthly[`${x[1]}-${String(x[2]).padStart(2, '0')}`] = Number(x[3]);
  }

  return { daily, weekly, monthly };
}

/**
 * 解析住建委「房地产数据主题服务」页（pageId=307749）里的
 * 「存量房网上签约月统计 · 按经纪机构」以及同页的整月全市汇总。
 *
 * 返回 {
 *   month: 'YYYY-MM' | null,        // 机构统计所属月份
 *   lianjia: { count, refund },     // 链家当月签约套数 / 退房套数
 *   cityTotal, cityResidential,     // 全市当月网上签约总套数 / 住宅签约套数
 *   agencies: [{ name, count, refund }]
 * }
 *
 * 注意：该页面只提供「最新一个月」的机构排行，历史月份需要外部补充。
 */
function parseAgency(html) {
  const h = String(html);
  const out = { month: null, lianjia: null, cityTotal: null, cityResidential: null, agencies: [] };

  // 1) 机构统计月份
  const mMonth = h.match(/\((\d{4})年(\d{1,2})月统计结果\)/);
  if (mMonth) out.month = `${mMonth[1]}-${String(mMonth[2]).padStart(2, '0')}`;

  // 2) 机构行：<td>北京链家置地房地产经纪有限公司</td><td>8218</td><td>124</td>
  const reRow =
    /<td[^>]*>\s*([\u4e00-\u9fa5（）()·A-Za-z]{4,40}?(?:公司|中心|事务所|经纪))[\s\S]{0,40}?<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/g;
  let x;
  while ((x = reRow.exec(h))) {
    const name = stripTags(x[1]);
    const row = { name, count: Number(x[2]), refund: Number(x[3]) };
    if (out.agencies.length < 40) out.agencies.push(row);
    if (!out.lianjia && name.includes('链家')) out.lianjia = { count: row.count, refund: row.refund };
  }

  // 3) 同页的「YYYY年M月存量房网上签约」整月汇总（网上签约套数 / 住宅签约套数）
  const mBlock = h.match(/(\d{4})年(\d{1,2})月存量房网上签约/);
  if (mBlock) {
    const start = mBlock.index + mBlock[0].length;
    const nxt = h.indexOf('存量房网上签约', start);
    const seg = h.slice(start, nxt > 0 ? nxt : start + 2500).replace(/<sup>2<\/sup>/g, '2');
    const cells = [...seg.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    for (let i = 0; i < cells.length; i++) {
      if (out.cityTotal == null && cells[i].startsWith('网上签约套数')) {
        const v = Number(cells[i + 1]);
        if (Number.isFinite(v)) out.cityTotal = v;
      }
      if (out.cityResidential == null && cells[i].startsWith('住宅签约套数')) {
        const v = Number(cells[i + 1]);
        if (Number.isFinite(v)) out.cityResidential = v;
      }
    }
    if (!out.month) {
      out.month = `${mBlock[1]}-${String(mBlock[2]).padStart(2, '0')}`;
    }
  }

  return out;
}

/**
 * 解析住建委「房地产数据主题服务」页（pageId=307749）里的
 * 「YYYY/M/D期房网上签约」「YYYY/M/D现房网上签约」两个表。
 *
 * 表格结构（每个表）：
 *   <td colspan=2>2026/11/8期房网上签约</td>
 *   <td> 网上签约套数：</td><td>307</td>
 *   <td> 网上签约面积 (M2)：</td><td>25244.1800</td>
 *   <td> 其中 住宅套数：</td><td>220</td>
 *   <td> 面积(M2)：</td><td>23601.1000</td>
 *   ...
 *
 * 返回 { date:'YYYY-MM-DD'|null, qf:{...}|null, xf:{...}|null }
 *   {...} = { total, totalArea, residential, residentialArea }
 *
 * 注意：该页面**只公示最新一天**，不提供历史日期查询接口；历史值只能靠网页存档
 * 或由爬虫逐日累积（见 server/src/newhomes.js）。
 */
function parseNewHome(html) {
  const h = String(html);
  const strip = (s) =>
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const num = (s) => {
    if (s == null) return null;
    const n = Number(String(s).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const out = { date: null, qf: null, xf: null };
  const re = /(\d{4})\/(\d{1,2})\/(\d{1,2})(期房|现房)网上签约/g;
  let m;
  while ((m = re.exec(h))) {
    const date = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    if (out.date && date !== out.date) continue; // 同一次抓取里只认同一天
    const kind = m[4] === '期房' ? 'qf' : 'xf';

    // 从标题所在位置往后截一段，抽「标签 / 数值」单元格序列。
    // 老版页面用 <td>，新版「房产数据统计」页用 <li><span>，两种都兼容。
    const seg = h.slice(m.index, m.index + 2600);
    const pick = (re) => [...seg.matchAll(re)].map((x) => strip(x[1])).filter(Boolean);
    let cells = pick(/<td[^>]*>([\s\S]*?)<\/td>/g);
    if (cells.length < 4) cells = pick(/<span[^>]*>([\s\S]*?)<\/span>/g);
    const after = (label, offset = 1) => {
      const i = cells.findIndex((c) => c.includes(label));
      return i >= 0 ? num(cells[i + offset]) : null;
    };

    const rec = {
      total: after('网上签约套数'),
      totalArea: after('网上签约面积'),
      residential: after('住宅套数'),
      residentialArea: after('住宅套数', 3),
    };
    if (rec.total == null && rec.residential == null) continue;
    if (!out.date) out.date = date;
    out[kind] = rec;
  }
  return out;
}

/**
 * 解析住建委页面里的两个「库存」统计块：
 *
 *   可售期房统计  → 可售房屋套数 / 其中住宅套数（含面积）
 *   未签约现房统计 → 未签约套数   / 其中住宅套数（含面积）
 *
 * 这是「存量」口径（某日可售 / 未签约的存量套数），与 parseNewHome() 抓的
 * 「当日网上签约」是两回事，不能混用。
 *
 * 页面有两代结构，这里都兼容：
 *   · 老版 pageId=307749：<td>label</td><td>value</td>，表尾有「截止日期：YYYY/M/D」
 *   · 新版 fcsjtj：<div class="tits">标题</div><li><span>label</span><span>value</span></li>
 *
 * 注意：老版页面里有一段被 HTML 注释掉的过期「截止日期：2010-11-28」，
 * 解析前必须先剥掉注释，否则会把 2010 年当成数据日期。
 *
 * 返回 {
 *   date: 'YYYY-MM-DD' | null,
 *   qf: { total, totalArea, residential, residentialArea } | null,   // 可售期房统计
 *   xf: { total, totalArea, residential, residentialArea } | null,   // 未签约现房统计
 * }
 */
function parseStockStats(html) {
  // 剥注释：老版页面藏有 2010 年的过期截止日期
  const h = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const out = { date: null, qf: null, xf: null };

  const strip = (s) =>
    s
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const num = (s) => {
    if (s == null) return null;
    const n = Number(String(s).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && String(s).replace(/[^\d.]/g, '') !== '' ? n : null;
  };
  const pad2 = (n) => String(n).padStart(2, '0');

  // 1) 数据截止日期。新版把 label / value 放在两个 <span> 里，中间会夹标签。
  const mDate = h.match(
    /截止日期[：:]\s*(?:<\/span>\s*<span[^>]*>\s*)?(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/
  );
  if (mDate) {
    out.date = `${mDate[1]}-${pad2(Number(mDate[2]))}-${pad2(Number(mDate[3]))}`;
  } else {
    // 老版页面偶尔没有可见截止日期，退回同页「YYYY/M/D期房网上签约」的日期
    const mDay = h.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(?:期房|现房)网上签约/);
    if (mDay) out.date = `${mDay[1]}-${pad2(Number(mDay[2]))}-${pad2(Number(mDay[3]))}`;
  }

  /** 从标题位置截出单个统计块，并抽出「标签 / 数值」序列 */
  function cellsOf(title) {
    const idx = h.indexOf(title);
    if (idx < 0) return [];
    const candidates = [
      h.indexOf('</table>', idx),
      h.indexOf('<div class="div1_ks"', idx + 10),
      h.indexOf('<div class="div1_ks1"', idx + 10),
      h.indexOf('class="tits"', idx + 10),
      h.indexOf('class="tits1"', idx + 10),
    ].filter((p) => p > idx);
    const end = candidates.length ? Math.min(...candidates) : idx + 3200;
    const seg = h.slice(idx, end);

    // 新版：<li><span>label</span><span>value</span></li>
    const li = [...seg.matchAll(
      /<li[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/li>/g
    )].flatMap((m) => [strip(m[1]), strip(m[2])]);
    if (li.length >= 4) return li;

    // 老版：<td>label</td><td>value</td>
    const td = [...seg.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (td.length >= 4) return td;

    // 兜底：纯 span 序列
    return [...seg.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
  }

  /** 找标签后第 offset 个单元格的数值（标签里含 &nbsp; 已被压成空格） */
  const after = (cells, label, offset = 1) => {
    const i = cells.findIndex((c) => c.replace(/\s/g, '').includes(label));
    return i >= 0 ? num(cells[i + offset]) : null;
  };

  const qfCells = cellsOf('可售期房统计');
  if (qfCells.length) {
    const rec = {
      total: after(qfCells, '可售房屋套数'),
      totalArea: after(qfCells, '可售房屋面积'),
      residential: after(qfCells, '住宅套数'),
      residentialArea: after(qfCells, '住宅套数', 3),
    };
    if (rec.total != null || rec.residential != null) out.qf = rec;
  }

  const xfCells = cellsOf('未签约现房统计');
  if (xfCells.length) {
    const rec = {
      total: after(xfCells, '未签约套数'),
      totalArea: after(xfCells, '未签约面积'),
      residential: after(xfCells, '住宅套数'),
      residentialArea: after(xfCells, '住宅套数', 3),
    };
    if (rec.total != null || rec.residential != null) out.xf = rec;
  }

  return out;
}

module.exports = {
  UA,
  SOURCES,
  fetchText,
  parseOfficial,
  parseFangshi,
  mergeDaily,
  parseFangshiAll,
  parseAgency,
  parseNewHome,
  parseStockStats,
};
