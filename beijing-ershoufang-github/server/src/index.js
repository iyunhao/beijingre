'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const stats = require('./stats');
const external = require('./external');
const cal = require('./calendar');
const payload = require('./payload');
const verification = require('./verification');
const { refresh } = require('./scraper');
const captureArchive = require('./captureArchive');
const stocks = require('./stocks');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SCRAPE_INTERVAL_MS = Number(process.env.SCRAPE_INTERVAL_MS || 30 * 60 * 1000);
const AUTO_SCRAPE = process.env.AUTO_SCRAPE !== '0';
// 数据超过这个时长就视为过期；任何 /api/ 请求都会顺带触发一次后台刷新。
// 这条是「每天刷新」的关键兜底：即使平台冷启动 / 进程被回收，只要有人访问就会补采。
const REFRESH_STALE_MS = Number(process.env.REFRESH_STALE_MS || 60 * 60 * 1000);
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000;
// 每天固定（北京时间）再强制刷几次，覆盖官方页的发布节奏
const DAILY_TIMES = String(process.env.DAILY_REFRESH_TIMES || '09:05,22:05')
  .split(',')
  .map((s) => s.trim().split(':').map(Number))
  .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

const refreshState = {
  running: false,
  lastRunAt: 0,
  lastOkAt: null,
  lastReason: null,
  lastError: null,
  count: 0,
  nextAt: null,
};

const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const boot = Date.now();

/** 触发一次后台刷新（并发保护 + 最小间隔，避免请求风暴把源站打爆） */
async function triggerRefresh(reason) {
  if (!AUTO_SCRAPE || refreshState.running) return;
  const now = Date.now();
  if (now - refreshState.lastRunAt < MIN_REFRESH_GAP_MS) return;
  refreshState.running = true;
  refreshState.lastRunAt = now;
  refreshState.lastReason = reason;
  refreshState.nextAt = now + SCRAPE_INTERVAL_MS;
  try {
    const r = await refresh({ verbose: false });
    refreshState.lastOkAt = Date.now();
    refreshState.count++;
    if (r && r.errors && r.errors.length) {
      refreshState.lastError = r.errors.join(' | ');
      console.error('[refresh] 部分失败:', refreshState.lastError);
    } else {
      refreshState.lastError = null;
    }
  } catch (e) {
    refreshState.lastError = e.message;
    console.error('[refresh] 失败:', e.message);
  } finally {
    refreshState.running = false;
  }
}

/** 任何 /api/ 请求都检查一次：数据过期就补采（冷启动场景下保证每天至少更新） */
function maybeRefresh() {
  if (!AUTO_SCRAPE) return;
  const last = Date.parse(store.get().meta.updatedAt || '') || 0;
  if (Date.now() - last > REFRESH_STALE_MS) triggerRefresh('stale');
}

/** 计算北京时间 h:m 的下一次真实时间点（epoch ms） */
function nextBeijingTime(hour, minute) {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  const target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour,
    minute,
    0
  ) - 8 * 3600 * 1000;
  return target <= Date.now() ? target + 86400000 : target;
}

/** 每天固定时刻强制刷新（北京时间），递归排下一次 */
function scheduleDaily(hour, minute) {
  const wait = nextBeijingTime(hour, minute) - Date.now();
  setTimeout(() => {
    triggerRefresh(`daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    scheduleDaily(hour, minute);
  }, Math.max(1000, Math.min(wait, 2147483000)));
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'public, max-age=60',
  });
  res.end(buf);
}

function metricOf(url) {
  const m = url.searchParams.get('metric');
  return m === 'total' ? 'total' : 'residential';
}

/** 数据质量概览（前端「数据质量」面板用） */
function qualitySummary(db) {
  const m = db.meta || {};
  return {
    range: m.range || null,
    rebuiltAt: m.rebuiltAt || null,
    counts: m.counts || { total: Object.keys(db.days).length, official: 0, exact: 0, derived: 0 },
    satRatio: m.satRatio ?? null,
    weekendShare: m.weekendShare ?? null,
    residualMedian: m.residualMedian ?? null,
    gaps: m.gaps || [],
    warnings: m.warnings || [],
    reconciliation: m.reconciliation || [],
    suspiciousWeeks: m.suspiciousWeeks || [],
    monthTotals: m.monthTotals || {},
    estimatedDays: m.estimatedDays || [],
    lastError: m.lastError || null,
    capture: m.capture
      ? {
          lastDate: m.capture.lastDate || null,
          lastAt: m.capture.lastAt || null,
          missed: m.capture.missed || [],
          log: (m.capture.log || []).slice(-20),
        }
      : null,
  };
}

/** 外部补充数据：去年同月（同比）+ 链家月度签约 */
function externalPayload() {
  const ext = external.get();
  return {
    updatedAt: ext.updatedAt,
    prevYear: ext.prevYear || {},
    lianjia: ext.lianjia || {},
    weekly: ext.weekly || {},
    monthlyTotal: ext.monthlyTotal || {},
    annual: ext.annual || null,
  };
}

/** 静态文件（web 目录） */
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function route(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const db = store.get();

  if (!path.startsWith('/api/')) return serveStatic(res, url.pathname);

  maybeRefresh();

  if (path === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - boot) / 1000),
      days: Object.keys(db.days).length,
      months: Object.keys(db.months).length,
      newHomeDays: Object.keys(db.newHomes || {}).length,
      stockDays: Object.keys(db.stocks || {}).length,
      historyArchivedDays: (db.meta.history && db.meta.history.archivedDays) || 0,
      updatedAt: db.meta.updatedAt,
      lastNewHomeDate: db.meta.lastNewHomeDate || null,
      lastStockDate: db.meta.lastStockDate || null,
      stockCount: db.meta.stockCount || Object.keys(db.stocks || {}).length,
      lastError: db.meta.lastError,
      capture: {
        archivedDays: Object.keys(captureArchive.read().days).length,
        gaps: captureArchive.gaps(),
      },
      verification: verification.summary(),
      refresh: {
        autoScrape: AUTO_SCRAPE,
        intervalMs: SCRAPE_INTERVAL_MS,
        staleMs: REFRESH_STALE_MS,
        dailyTimesBJT: DAILY_TIMES.map((p) => `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}`),
        running: refreshState.running,
        lastRunAt: refreshState.lastRunAt ? new Date(refreshState.lastRunAt).toISOString() : null,
        lastOkAt: refreshState.lastOkAt ? new Date(refreshState.lastOkAt).toISOString() : null,
        lastReason: refreshState.lastReason,
        lastError: refreshState.lastError,
        count: refreshState.count,
      },
    });
  }

  // 网页端一次性拿全量日序列，前端本地算月历/窗口/预估，切换月份零请求
  if (path === '/api/days') {
    const metric = metricOf(url);
    const days = payload.days(db, metric);
    return json(res, 200, {
      city: db.meta.city,
      metric,
      metricLabel: metric === 'total' ? '网上签约套数' : '住宅签约套数',
      updatedAt: db.meta.updatedAt,
      days,
      months: db.months,
      newHomes: payload.newHomeDays(db),
      stocks: payload.stockDays(db),
      quality: qualitySummary(db),
      external: externalPayload(),
      verification: verification.get(),
    });
  }

  // 独立校验报告：重新抓取权威源站逐条比对的结果（见 npm run verify）
  if (path === '/api/verification') {
    const report = verification.get();
    if (!report) return json(res, 404, { error: 'verification report not found', hint: 'run: npm run verify' });
    return json(res, 200, report);
  }

  // 期房 / 现房单日直采数据（独立接口，便于单独核对）
  if (path === '/api/newhomes') {
    const list = payload.newHomeDays(db);
    return json(res, 200, {
      city: db.meta.city,
      count: list.length,
      lastDate: list.length ? list[list.length - 1].date : null,
      updatedAt: db.meta.updatedAt,
      records: list,
    });
  }

  // 可售期房 / 未签约现房「其中住宅套数」库存统计（独立接口，便于定时合并）
  if (path === '/api/stocks') {
    const list = payload.stockDays(db);
    return json(res, 200, {
      city: db.meta.city,
      count: list.length,
      lastDate: list.length ? list[list.length - 1].date : null,
      updatedAt: db.meta.updatedAt,
      gaps: stocks.gaps(list),
      records: list,
    });
  }

  // 同比 + 链家分机构数据
  if (path === '/api/external') {
    return json(res, 200, externalPayload());
  }

  // 数据质量报告：月度对账 + 覆盖情况 + 缺口
  if (path === '/api/quality') {
    return json(res, 200, qualitySummary(db));
  }

  // 每日官方直采存档：供定时任务把线上新采到的日期合并回本机（防止漏采丢失）
  if (path === '/api/capture') {
    const a = captureArchive.read();
    return json(res, 200, {
      count: Object.keys(a.days).length,
      updatedAt: a.updatedAt,
      gaps: captureArchive.gaps(),
      days: a.days,
    });
  }

  if (path === '/api/summary') {
    return json(res, 200, stats.summary(db, metricOf(url)));
  }

  if (path === '/api/month') {
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: 'month 格式应为 YYYY-MM' });
    return json(res, 200, stats.monthSummary(db, month, metricOf(url)));
  }

  if (path === '/api/trend') {
    const span = Math.min(180, Math.max(1, Number(url.searchParams.get('days') || 30)));
    const metric = metricOf(url);
    const s = stats.summary(db, metric);
    const end = url.searchParams.get('end') || (s.latest ? s.latest.date : stats.toKey(new Date()));
    return json(res, 200, stats.trend(db, end, span, metric));
  }

  if (path === '/api/months') {
    const keys = new Set(Object.keys(db.days).map((d) => d.slice(0, 7)));
    Object.keys(db.months).forEach((k) => keys.add(k));
    const list = [...keys].sort().reverse().map((k) => {
      const ms = stats.monthSummary(db, k);
      return { month: k, monthTotal: ms.monthTotal, countedDays: ms.countedDays };
    });
    return json(res, 200, { months: list });
  }

  // 小程序一次性拉全量首屏数据
  if (path === '/api/snapshot') {
    const metric = metricOf(url);
    const s = stats.summary(db, metric);
    const month = url.searchParams.get('month') || s.month.month;
    const keys = new Set(Object.keys(db.days).map((d) => d.slice(0, 7)));
    Object.keys(db.months).forEach((k) => keys.add(k));
    return json(res, 200, {
      ...s,
      month: stats.monthSummary(db, month, metric),
      monthKeys: [...keys].sort().reverse(),
      newHomes: payload.newHomeDays(db),
      stocks: payload.stockDays(db),
      verification: verification.get(),
      serverTime: new Date().toISOString(),
    });
  }

  // 手动触发一次刷新（建议只在内网/带 token 使用）
  if (path === '/api/refresh') {
    const token = process.env.REFRESH_TOKEN;
    if (token && url.searchParams.get('token') !== token) {
      return json(res, 401, { error: 'unauthorized' });
    }
    refresh({ verbose: false })
      .then((r) => json(res, 200, { ok: !r.errors.length, errors: r.errors, rebuilt: r.rebuilt }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
    return;
  }

  return json(res, 404, {
    error: 'not found',
    endpoints: [
      '/api/days',
      '/api/newhomes',
      '/api/stocks',
      '/api/verification',
      '/api/quality',
      '/api/capture',
      '/api/health',
      '/api/summary',
      '/api/month',
      '/api/trend',
      '/api/months',
      '/api/snapshot',
    ],
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    route(req, res, url);
  } catch (e) {
    console.error('[api]', e);
    json(res, 500, { error: e.message });
  }
});

async function bootstrap() {
  const db = store.get();
  if (Object.keys(db.days).length === 0) {
    const seed = store.loadSeed();
    if (seed && Object.keys(seed.days).length) {
      store.save(seed);
      console.log('[boot] 已载入种子快照', Object.keys(seed.days).length, '天');
    }
  }

  // 冷启动就把期房/现房存档锚点补进库（幂等），避免首屏该视图空白。
  // 注意上面可能刚 save(seed) 换过 cache，这里必须重新 get()。
  const newhomes = require('./newhomes');
  const dbNow = store.get();
  let seeded = newhomes.seedArchive(dbNow);
  seeded += stocks.seedArchive(dbNow);
  if (seeded) store.save(dbNow);

  server.listen(PORT, HOST, () => {
    console.log(`[api] http://127.0.0.1:${PORT}/api/days  (bind ${HOST}:${PORT})`);
  });

  if (!AUTO_SCRAPE) return;

  // 启动 5 秒后刷新一次；之后按间隔刷新（默认 30 分钟）
  setTimeout(() => triggerRefresh('boot'), 5000);
  setInterval(() => triggerRefresh('interval'), SCRAPE_INTERVAL_MS);

  // 每天北京时间固定时刻再强制刷一次（冷启动/进程回收时由 maybeRefresh 兜底）
  for (const [h, m] of DAILY_TIMES) scheduleDaily(h, m);
  console.log(
    `[refresh] 自动刷新已启用：间隔 ${Math.round(SCRAPE_INTERVAL_MS / 60000)} 分钟，` +
      `过期兜底 ${Math.round(REFRESH_STALE_MS / 60000)} 分钟，` +
      `每日北京时间 ${DAILY_TIMES.map((p) => `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}`).join(' / ')}`
  );
}

bootstrap();
