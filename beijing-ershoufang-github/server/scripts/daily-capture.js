'use strict';

/**
 * 每日采集保障脚本（由定时任务调用，也可手动跑）。
 *
 *   node server/scripts/daily-capture.js
 *
 * 每轮必做的事：
 *  1) 本机直接抓住建委官方页的「最新一日」→ append-only 直采存档（存量房）；
 *  1b) 同页抓「可售期房 / 未签约现房 · 其中住宅套数」库存快照，以及
 *      期房/现房当日网上签约值 → 各自的 append-only 存档（只公示当天，漏一天就永远补不回）；
 *  2) 访问线上链接的 /api/capture、/api/stocks、/api/newhomes（顺带唤醒沙箱），
 *     把线上进程自己采到、而本机没有的日期合并回来；
 *  3) 用合并后的存档重跑 rebuild，把每个真实采到的日子（含周末）注入日序列，
 *     从此不会再退回 SAT_RATIO 的 70/30 估算；滚动窗口外的旧日期由
 *     history-archive.json 原样带回，只增不删；
 *  4) 重建网页内置快照，并打印漏采缺口供人工/定时任务告警。
 *
 * 线上地址的唯一真相 = server/data/live-url.json
 *   平台每次重新发布都可能新建沙箱、换 shareLink。发布成功后必须把返回的
 *   shareLink 回写该文件，否则定时任务会一直去唤醒已失效的旧沙箱：
 *     node server/scripts/daily-capture.js --set-live-url <https://新链接>
 *   LIVE_URL 环境变量可临时覆盖；设成空字符串可跳过第 2 步。
 *
 * 失败分级：
 *   官方页抓不到  → 硬错误（exit 1），因为这是每日真实数据的唯一来源。
 *   线上链接失效  → 警告（不阻断）；直采已完成，定时任务仍应继续重新发布，
 *                    发布成功后回写新链接即可自愈。
 */
const fs = require('fs');
const path = require('path');
const { SOURCES, fetchText, parseOfficial, parseNewHome, parseStockStats } = require('../src/parse');
const captureArchive = require('../src/captureArchive');
const newhomes = require('../src/newhomes');
const stocks = require('../src/stocks');
const store = require('../src/store');
const { rebuild } = require('../src/rebuild');

const LIVE_URL_FILE = path.join(__dirname, '..', 'data', 'live-url.json');

function readLiveUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(LIVE_URL_FILE, 'utf8'));
    return (cfg.url || '').trim().replace(/\/$/, '');
  } catch (e) {
    return '';
  }
}

// 发布成功后由定时任务调用，把新 shareLink 落盘为唯一真相。
if (process.argv[2] === '--set-live-url') {
  const url = (process.argv[3] || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(url)) {
    console.error('用法: node server/scripts/daily-capture.js --set-live-url <https://...>');
    process.exit(1);
  }
  fs.writeFileSync(
    LIVE_URL_FILE,
    JSON.stringify({ url, updatedAt: new Date().toISOString() }, null, 2) + '\n'
  );
  console.log(`[capture] 已写入 ${LIVE_URL_FILE}: ${url}`);
  process.exit(0);
}

const LIVE_URL = process.env.LIVE_URL === undefined
  ? readLiveUrl()
  : process.env.LIVE_URL.trim().replace(/\/$/, '');

function printGaps() {
  const gaps = captureArchive.gaps();
  if (!gaps.length) return;
  console.log('[capture] ⚠ 检测到漏采缺口（官方页只给最新一日，缺口日无法事后回补）：');
  for (const g of gaps) console.log(`   ${g.from} → ${g.to}，缺 ${g.missedDays} 天`);
}

(async () => {
  const before = Object.keys(captureArchive.read().days).length;
  const errors = [];
  const warnings = [];
  let direct = null;
  let stockDirect = null;
  let nhDirect = null;
  const db = store.get();
  stocks.seedArchive(db); // 冷启动补齐库存网页存档锚点（幂等）
  newhomes.seedArchive(db); // 冷启动补齐期房/现房网页存档锚点（幂等）
  const stockBefore = Object.keys(db.stocks || {}).length;
  const nhBefore = Object.keys(db.newHomes || {}).length;

  console.log(`[capture] 线上地址: ${LIVE_URL || '（未配置，跳过线上合并）'}`);

  // ---- 1) 本机直接抓官方页 ----
  try {
    const html = await fetchText(SOURCES.zjw);
    const parsed = parseOfficial(html);
    if (parsed.daily) {
      const d = parsed.daily;
      const changed = captureArchive.upsert({
        date: d.date,
        residential: d.residential,
        total: d.total,
        residentialArea: d.residentialArea,
        totalArea: d.totalArea,
        source: 'zjw',
      });
      direct = `${d.date} 住宅 ${d.residential} / 总量 ${d.total}${changed ? '（新增）' : '（已存在）'}`;
    } else {
      errors.push('官方页未解析到当日数据');
    }
  } catch (e) {
    errors.push(`官方页抓取失败: ${e.message}`);
  }

  // ---- 1b) 库存统计：可售期房 / 未签约现房「其中住宅套数」 ----
  // 两个官方页面都解析，任一成功即可；按页面自报「截止日期」幂等写入 append-only 存档。
  for (const [name, url] of [['主题服务页', SOURCES.topic], ['房产数据统计页', SOURCES.stats]]) {
    try {
      const html = await fetchText(url);
      // 主题服务页是「当前」快照，同时给出期房/现房当日网签值；
      // 房产数据统计页是静态历史页，不能拿它的旧值冒充当日直采。
      if (name === '主题服务页') {
        const nh = parseNewHome(html);
        if (nh.date && (nh.qf || nh.xf)) {
          const changed = newhomes.mergeLive(db, nh);
          nhDirect = `${nh.date} 期房住宅 ${nh.qf?.residential ?? '—'} / 现房住宅 ${nh.xf?.residential ?? '—'}${changed ? '（新增）' : '（已存在）'}`;
        }
      }
      const parsed = parseStockStats(html);
      if (parsed.date && (parsed.qf || parsed.xf)) {
        const line = `${parsed.date} 期房住宅 ${parsed.qf?.residential ?? '—'} / 现房住宅 ${parsed.xf?.residential ?? '—'}`;
        let changed = false;
        if (name === '主题服务页') {
          // 只有实时主题页才算「直采」，按页面自报截止日期幂等写入。
          changed = stocks.mergeLive(db, parsed);
        } else {
          // 房产数据统计页是静态历史快照（页面常年标注 2025/6/23），不是当日直采。
          // 只能作为「网页存档锚点」补录，绝不覆盖已有记录、更不冒充实时抓取。
          const qf = parsed.qf || {};
          const xf = parsed.xf || {};
          if (!db.stocks[parsed.date]) {
            changed = stocks.upsert(db, {
              date: parsed.date,
              qfStockTotal: qf.total ?? null,
              qfStockResidential: qf.residential ?? null,
              qfStockTotalArea: qf.totalArea ?? null,
              qfStockResidentialArea: qf.residentialArea ?? null,
              xfStockTotal: xf.total ?? null,
              xfStockResidential: xf.residential ?? null,
              xfStockTotalArea: xf.totalArea ?? null,
              xfStockResidentialArea: xf.residentialArea ?? null,
              source: '住建委房产数据统计页',
              note: '页面静态快照，自报截止日期 ' + parsed.date,
              capturedAt: null,
            });
          }
        }
        const tag = name === '主题服务页' ? (changed ? '（新增直采）' : '（直采已存在）') : (changed ? '（补录存档锚点）' : '（存档锚点已存在）');
        stockDirect = stockDirect ? `${stockDirect}；${name} ${line}${tag}` : `${name} ${line}${tag}`;
      }
    } catch (e) {
      warnings.push(`库存统计 ${name} 抓取失败（不阻断）: ${e.message}`);
    }
  }

  // ---- 2) 合并线上进程自己采到的日期，并算「线上落后几天」 ----
  // LIVE_LAG 很关键：只看 NEW_DAYS 会漏掉「上轮已在本机采到、但发布失败」的情况，
  // 那样线上会一直缺这天，而下一轮 NEW_DAYS=0 又不会触发补发。
  let mergedFromLive = 0;
  let liveLag = -1; // -1 = 线上状态未知（链接失效），应触发补发
  let liveLatest = null;
  let localLatest = null;
  if (LIVE_URL) {
    try {
      const res = await fetch(`${LIVE_URL}/api/capture`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) {
        warnings.push(`线上 ${LIVE_URL} 无 /api/capture（链接可能已失效或版本过旧）`);
      } else if (!res.ok) {
        warnings.push(`线上 /api/capture 返回 HTTP ${res.status} —— 链接很可能已失效`);
      } else {
        const j = await res.json();
        const liveDays = j.days || {};
        mergedFromLive = captureArchive.mergeMany(liveDays);
        const liveSet = new Set(Object.keys(liveDays));
        const localDays = Object.keys(captureArchive.read().days).sort();
        liveLag = localDays.filter((d) => !liveSet.has(d)).length;
        liveLatest = Object.keys(liveDays).sort().pop() || null;
        localLatest = localDays.pop() || null;
      }
    } catch (e) {
      warnings.push(`线上存档合并失败（不阻断直采）: ${e.message}`);
    }
  }
  // ---- 2b) 把线上进程自己采到的库存统计日并回本机 ----
  let stockFromLive = 0;
  if (LIVE_URL) {
    try {
      const res = await fetch(`${LIVE_URL}/api/stocks`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const j = await res.json();
        stockFromLive = stocks.mergeMany(db, j.records || []);
      }
    } catch (e) {
      warnings.push(`线上库存统计合并失败（不阻断）: ${e.message}`);
    }
  }

  // ---- 2c) 把线上进程自己采到的期房/现房当日值并回本机 ----
  let nhFromLive = 0;
  if (LIVE_URL) {
    try {
      const res = await fetch(`${LIVE_URL}/api/newhomes`, {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const j = await res.json();
        nhFromLive = newhomes.mergeMany(db, j.records || []);
      }
    } catch (e) {
      warnings.push(`线上期房/现房合并失败（不阻断）: ${e.message}`);
    }
  }

  const nhAfter = Object.keys(db.newHomes || {}).length;
  const nhLatest = newhomes.list(db).slice(-1)[0]?.date || null;
  const nhMetaChanged = db.meta.lastNewHomeDate !== nhLatest;
  if (nhMetaChanged) db.meta.lastNewHomeDate = nhLatest;
  console.log(`[capture] 期房/现房直采: ${nhDirect || '无'}`);
  console.log(`[capture] 期房/现房存档: ${nhBefore} → ${nhAfter} 天（从线上合并回 ${nhFromLive} 天，最新 ${nhLatest || '—'}）`);

  const stockList = stocks.list(db);
  const stockAfter = stockList.length;
  const stockLatest = stockAfter ? stockList[stockAfter - 1].date : null;
  // 与 scraper.refresh() 保持一致：让 /api/health 能看到库存最新采集日与累计天数
  const metaChanged = db.meta.lastStockDate !== stockLatest || db.meta.stockCount !== stockAfter;
  if (metaChanged) {
    db.meta.lastStockDate = stockLatest;
    db.meta.stockCount = stockAfter;
  }
  console.log(`[capture] 库存直采: ${stockDirect || '无'}`);
  console.log(`[capture] 库存存档: ${stockBefore} → ${stockAfter} 天（从线上合并回 ${stockFromLive} 天，最新 ${stockLatest || '—'}）`);

  // 先落盘一次：即使后面 rebuild 失败，本轮采到的库存日也不会丢。
  // rebuild 的 meta 是 {...db.meta} 展开的，这两个字段会原样带过去。
  if (stockAfter !== stockBefore || stockFromLive || metaChanged ||
      nhAfter !== nhBefore || nhFromLive || nhMetaChanged) {
    db.meta.updatedAt = new Date().toISOString();
    store.save(db);
  }

  if (warnings.length) {
    warnings.push(`发布成功后请执行 --set-live-url 回写新 shareLink 至 ${LIVE_URL_FILE}`);
  }

  const after = Object.keys(captureArchive.read().days).length;
  const newDays = after - before;
  console.log(`[capture] 直采: ${direct || '无'}`);
  console.log(`[capture] 存档: ${before} → ${after} 天（从线上合并回 ${mergedFromLive} 天）`);
  console.log(`[capture] NEW_DAYS=${newDays}`);
  console.log(`[capture] LIVE_LAG=${liveLag}（本机最新 ${localLatest || '?'} / 线上最新 ${liveLatest || '?'}；-1=线上未知）`);

  // ---- 3) 重跑重建，让官方直采值覆盖所有推算值 ----
  try {
    await rebuild({ persist: true, verbose: false });
    console.log('[capture] rebuild 完成（官方直采日已注入日序列）');
  } catch (e) {
    errors.push(`rebuild 失败: ${e.message}`);
  }

  // ---- 4) 重建内置快照 ----
  try {
    require('./build-web-data');
  } catch (e) {
    errors.push(`快照生成失败: ${e.message}`);
  }

  printGaps();
  for (const w of warnings) console.log(`[capture] ⚠ ${w}`);
  if (errors.length) {
    console.log('[capture] ⚠ 本轮错误：' + errors.join(' | '));
    process.exitCode = 1;
  } else {
    console.log('[capture] OK');
  }
})().catch((e) => {
  console.error('[capture] 致命错误:', e);
  process.exit(1);
});
