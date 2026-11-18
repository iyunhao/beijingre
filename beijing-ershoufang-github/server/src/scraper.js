'use strict';

const { SOURCES, fetchText, parseOfficial, parseAgency, parseNewHome, parseStockStats } = require('./parse');
const { rebuild } = require('./rebuild');
const external = require('./external');
const newhomes = require('./newhomes');
const stocks = require('./stocks');
const store = require('./store');
const captureArchive = require('./captureArchive');

/**
 * 完整刷新流程：
 *   1. 抓住建委官方页 → 拿到「最新一日」的原始数值（quality = official，最高可信度）
 *   2. 抓「最近一年」页 → 重建全量日序列（工作日实值 + 周末回补），并保留官方直采数据
 *   3. 用官方月报交叉校验，结果写入 meta.reconciliation
 *
 * 任一步失败都不影响已有数据。
 */
async function refresh({ persist = true, verbose = true, skipRebuild = false } = {}) {
  const log = (...a) => verbose && console.log('[refresh]', ...a);
  const errors = [];
  let official = null;

  // ---- 1. 官方最新一日 ----
  try {
    const html = await fetchText(SOURCES.zjw);
    const parsed = parseOfficial(html);
    if (parsed.daily) {
      const db = store.get();
      const d = parsed.daily;
      db.days[d.date] = {
        ...(db.days[d.date] || {}),
        date: d.date,
        residential: d.residential,
        total: d.total,
        residentialArea: d.residentialArea,
        totalArea: d.totalArea,
        quality: 'official',
        sources: [...new Set([...(db.days[d.date]?.sources || []), 'zjw'])],
        totalOfficial: d.total != null, // 当日「网上签约套数」也是官方原值，rebuild 不得按占比改写
      };
      if (parsed.monthly) {
        const key = `${parsed.monthly.year}-${String(parsed.monthly.month).padStart(2, '0')}`;
        db.months[key] = {
          month: key,
          year: parsed.monthly.year,
          monthNum: parsed.monthly.month,
          residential: parsed.monthly.residential,
          total: parsed.monthly.total,
          official: true,
          source: 'zjw',
        };
      }
      db.meta.updatedAt = new Date().toISOString();

      // 官方页每天都会换一天（含周末），这里记录「实际采到过哪些日期」，
      // 用于发现漏采：如果两次采到的日期中间隔了多天，说明进程停过，中间那几天永久丢失。
      const cap = db.meta.capture || { log: [] };
      if (cap.lastDate !== d.date) {
        const gap =
          cap.lastDate && cap.lastAt
            ? Math.round((Date.parse(d.date) - Date.parse(cap.lastDate)) / 86400000)
            : null;
        cap.log = [...(cap.log || []), { date: d.date, at: new Date().toISOString(), gap }].slice(-60);
        cap.lastDate = d.date;
        cap.lastAt = new Date().toISOString();
        cap.missed = (cap.log || []).filter((x) => x.gap && x.gap > 1).map((x) => x.date);
      }
      db.meta.capture = cap;

      if (persist) store.save(db);
      official = d;

      // 立即把「最新一日」写入 append-only 存档：官方页一次只给一天，
      // 漏采事后无法回补（尤其周末，房市儿日序列不含周末）。
      // 即使沙箱冷启动把 store.json 还原成部署快照，rebuild 也会从存档重新注入。
      captureArchive.upsert({
        date: d.date,
        residential: d.residential,
        total: d.total,
        residentialArea: d.residentialArea,
        totalArea: d.totalArea,
        source: 'zjw',
      });
      log(`官方最新一日 ${d.date}：住宅 ${d.residential} 套 / 总计 ${d.total} 套`);
    } else {
      log('官方页未解析到当日数据');
    }
  } catch (e) {
    errors.push(`zjw: ${e.message}`);
    log('官方页抓取失败：', e.message);
  }

  // ---- 2) 主题服务页：经纪机构月统计（链家）+ 期房/现房最新一日 ----
  // 同一份 HTML 复用，减少一次外网请求
  let agency = null;
  let newHome = null;
  let stock = null;
  try {
    const html = await fetchText(SOURCES.topic);

    const parsed = parseAgency(html);
    if (parsed.lianjia && parsed.month) {
      const r = external.mergeAgency(parsed);
      agency = { month: parsed.month, count: parsed.lianjia.count, changed: !!(r && r.changed) };
      log(`机构统计 ${parsed.month}：链家 ${parsed.lianjia.count} 套（全市 ${parsed.cityTotal ?? '—'} 套）`);
    } else {
      log('机构统计页未解析到链家数据');
    }

    const db = store.get();
    const seeded = newhomes.seedArchive(db);
    const seededStock = stocks.seedArchive(db);
    const nh = parseNewHome(html);
    const merged = newhomes.mergeLive(db, nh);
    if (nh.date && (nh.qf || nh.xf)) {
      newHome = {
        date: nh.date,
        qfTotal: nh.qf?.total ?? null,
        xfTotal: nh.xf?.total ?? null,
        qfResidential: nh.qf?.residential ?? null,
        xfResidential: nh.xf?.residential ?? null,
      };
      db.meta.lastNewHomeDate = nh.date;
      db.meta.newHomeCount = Object.keys(db.newHomes || {}).length;
      log(
        `期房/现房 ${nh.date}：期房 ${newHome.qfTotal ?? '—'} 套（住宅 ${newHome.qfResidential ?? '—'}）` +
          ` / 现房 ${newHome.xfTotal ?? '—'} 套（住宅 ${newHome.xfResidential ?? '—'}）` +
          `，累计 ${db.meta.newHomeCount} 天${seeded ? `（补存档 ${seeded} 天）` : ''}`
      );
    }
    // 「可售期房统计 / 未签约现房统计」里的「其中住宅套数」（存量口径）
    // 与上面的「当日网上签约」是两张不同的表，按页面截止日期逐日累积。
    const sp = parseStockStats(html);
    const stockChanged = stocks.mergeLive(db, sp);
    if (sp.date && (sp.qf || sp.xf)) {
      stock = {
        date: sp.date,
        qfResidential: sp.qf?.residential ?? null,
        xfResidential: sp.xf?.residential ?? null,
        changed: stockChanged,
      };
      db.meta.lastStockDate = sp.date;
      db.meta.stockCount = stocks.list(db).length;
      log(
        `库存住宅 ${sp.date}：可售期房 ${stock.qfResidential ?? '—'} 套 / ` +
          `未签约现房 ${stock.xfResidential ?? '—'} 套，累计 ${db.meta.stockCount} 天` +
          `${seededStock ? `（补存档 ${seededStock} 天）` : ''}`
      );
    }

    if (seeded || merged || newHome || seededStock || stockChanged) {
      db.meta.updatedAt = new Date().toISOString();
      if (persist) store.save(db);
    }
  } catch (e) {
    errors.push(`topic: ${e.message}`);
    log('主题服务页抓取失败：', e.message);
  }

  // ---- 3) 全量重建 ----
  let result = null;
  if (!skipRebuild) {
    try {
      result = await rebuild({ persist, verbose });
    } catch (e) {
      errors.push(`rebuild: ${e.message}`);
      log('重建失败：', e.message);
    }
  }

  const db = store.get();
  db.meta.lastError = errors.length ? { at: new Date().toISOString(), message: errors.join(' | ') } : null;
  if (persist) store.save(db);

  return { official, agency, newHome, stock, errors, rebuilt: !!result };
}

module.exports = { refresh, rebuild };
