'use strict';

/**
 * 导出网页端内置快照：web/data/snapshot.js（window.__SNAPSHOT__）
 * 用于静态托管 / 直接双击打开 index.html 时无后端也能看数据。
 * 用法：npm run web:data
 *
 * 注意：日记录必须同时带 residential 与 total，
 * 前端的「网上签约套数 / 住宅签约套数」两个 tab 是本地切换的，不发第二次请求。
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const external = require('../src/external');
const payload = require('../src/payload');
const verification = require('../src/verification');

function build() {
  const db = store.get();
  if (Object.keys(db.days).length === 0) {
    const seed = store.loadSeed();
    if (seed && Object.keys(seed.days).length) store.save(seed);
  }

  // 与 /api/days 共用同一份映射；前端切换口径时本地重算 value，无需二次请求
  const days = payload.days(db, 'residential');
  const newHomes = payload.newHomeDays(db);
  const stockDays = payload.stockDays(db);

  const m = db.meta || {};
  const ext = external.get();
  const out = {
    city: m.city || '北京',
    metric: 'residential',
    metricLabel: '住宅签约套数',
    updatedAt: m.updatedAt,
    days,
    months: db.months,
    newHomes,
    stocks: stockDays,
    verification: verification.get(),
    external: {
      updatedAt: ext.updatedAt,
      prevYear: ext.prevYear || {},
      lianjia: ext.lianjia || {},
      weekly: ext.weekly || {},
      monthlyTotal: ext.monthlyTotal || {},
      annual: ext.annual || null,
    },
    quality: {
      range: m.range || null,
      rebuiltAt: m.rebuiltAt || null,
      counts: m.counts || { total: days.length, official: 0, exact: 0, derived: 0, estimated: 0 },
      satRatio: m.satRatio ?? null,
      weekendShare: m.weekendShare ?? null,
      residualMedian: m.residualMedian ?? null,
      gaps: m.gaps || [],
      warnings: m.warnings || [],
      reconciliation: m.reconciliation || [],
      suspiciousWeeks: m.suspiciousWeeks || [],
      monthTotals: m.monthTotals || {},
      estimatedDays: m.estimatedDays || [],
    },
  };

  const target = path.join(__dirname, '..', '..', 'web', 'data', 'snapshot.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    '// 自动生成，请勿手动编辑。更新命令：cd server && npm run web:data\n' +
      'window.__SNAPSHOT__ = ' +
      JSON.stringify(out, null, 2) +
      ';\n'
  );
  console.log(
    `[web:data] ${days.length} 天  ${days[0].date} → ${days[days.length - 1].date}，` +
      `期房/现房 ${newHomes.length} 天 · 库存住宅 ${stockDays.length} 天 → ${target}`
  );
}

build();
