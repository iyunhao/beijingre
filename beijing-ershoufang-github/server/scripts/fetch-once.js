'use strict';

/**
 * 抓取 + 重建，然后退出。适合 crontab / 系统定时任务。
 * 用法：npm run fetch
 */
const { refresh } = require('../src/scraper');

refresh()
  .then((r) => {
    console.log(
      `[fetch] 完成：官方最新一日 ${r.official ? r.official.date : '无'}，重建 ${r.rebuilt ? '成功' : '跳过'}，错误 ${r.errors.length} 个`
    );
    if (r.errors.length) console.log('[fetch] 错误详情:', r.errors.join(' | '));
    process.exit(r.errors.length ? 1 : 0);
  })
  .catch((e) => {
    console.error('[fetch] 失败:', e.message);
    process.exit(1);
  });
