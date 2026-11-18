'use strict';

/**
 * 独立校验报告（server/data/verification.json）的读取入口。
 *
 * 该文件由 `npm run verify` 重新抓取权威源站逐条比对后生成，随项目一起发布，
 * 因此冷启动 / 静态快照也能拿到。这里只做「带 mtime 缓存的只读加载」，
 * 文件缺失或暂时损坏时返回 null，绝不影响主数据接口。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'verification.json');

let cache = null;
let cachedMtime = -1;

function get() {
  try {
    const st = fs.statSync(FILE);
    if (!cache || st.mtimeMs !== cachedMtime) {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cachedMtime = st.mtimeMs;
    }
    return cache;
  } catch (e) {
    return null;
  }
}

/** 给 /api/health 用的轻量摘要 */
function summary() {
  const r = get();
  if (!r) return null;
  return {
    generatedAt: r.generatedAt,
    verdict: r.verdict,
    ...r.summary,
  };
}

module.exports = { get, summary, FILE };
