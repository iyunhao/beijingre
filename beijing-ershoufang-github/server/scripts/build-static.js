'use strict';

/**
 * 生成可直接静态托管的站点目录 site/
 *
 * 用法：npm run static:build
 *
 * 输入：web/index.html、web/app.js、web/style.css、web/data/snapshot.js
 * 输出：site/（含 index.html、app.js、style.css、data/snapshot.js、api/days）
 *
 * 说明：
 *  - 前端优先 fetch /api/days；静态托管下这里给出的是与内置快照同源的 JSON，
 *    即使 CDN 把它当作普通文本返回，前端解析失败也会自动回落到 window.__SNAPSHOT__。
 *  - 该脚本只做文件搬运与格式转换，不联网、不改动数据，可在任何 CI 环境运行。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'site');

function copy(file) {
  const src = path.join(WEB, file);
  const dst = path.join(OUT, file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main() {
  const snapshotSource = fs.readFileSync(path.join(WEB, 'data', 'snapshot.js'), 'utf8');
  const match = snapshotSource.match(/window\.__SNAPSHOT__\s*=\s*([\s\S]*?);\s*$/);
  if (!match) throw new Error('无法从 snapshot.js 解析出数据对象');
  const snapshot = JSON.parse(match[1]);
  if (!Array.isArray(snapshot.days) || !snapshot.days.length) {
    throw new Error('snapshot.js 中没有 days 数据，拒绝生成空站点');
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  for (const file of ['index.html', 'app.js', 'style.css', 'data/snapshot.js']) copy(file);

  // 静态 /api/days：与内置快照完全一致，供前端优先请求
  const apiDir = path.join(OUT, 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'days'), JSON.stringify(snapshot));

  const latest = snapshot.days[snapshot.days.length - 1];
  console.log(
    `[static] 已生成 ${OUT}：${snapshot.days.length} 天，最新 ${latest && latest.date}，更新于 ${snapshot.updatedAt}`
  );
}

try {
  main();
} catch (e) {
  console.error('[static] 生成失败:', e.message);
  process.exit(1);
}
