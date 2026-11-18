'use strict';

/**
 * 生成 data/seed.json —— 完整 store 快照，首次启动时作为兜底数据。
 * 用法：npm run seed
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/store');
const { rebuild } = require('../src/rebuild');

(async () => {
  const snap = await rebuild({ persist: true, verbose: true });

  const seed = {
    meta: snap.meta,
    days: snap.days,
    months: snap.months,
    // 两条 append-only 序列也要进冷启动种子：线上沙箱回收后 store.json 可能不存在，
    // 仅靠 seed.json 起服时，新增的「可售期房 / 未签约现房 · 住宅套数」tab 才不会空白。
    newHomes: snap.newHomes || {},
    stocks: snap.stocks || {},
  };

  const out = path.join(__dirname, '..', 'data', 'seed.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(seed, null, 2));

  const n = Object.keys(snap.days).length;
  console.log(`[seed] 已写入 ${n} 天 → ${out}`);
})();
