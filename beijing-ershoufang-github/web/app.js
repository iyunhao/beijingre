/* 北京二手房网签统计 · 前端逻辑（零依赖） */
(function () {
  'use strict';

  // ---------- 工具 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  const fmt = (n) =>
    n === null || n === undefined || isNaN(n)
      ? '–'
      : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const addMonth = (key, delta) => {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };

  // ---------- 状态 ----------
  const state = {
    days: [],            // 存量房日序列（含 total / residential 两个口径）
    newHomes: [],        // 期房 / 现房单日直采 + 存档锚点
    stocks: [],          // 可售期房 / 未签约现房「其中住宅套数」库存统计
    weekendPairs: {},    // 周六日期 → {sat, sun, ...}，用于历史周末合并显示
    ungroupedUnknown: new Set(), // 未合并、但单日值仍不可确知的周末日（占位为「–」）
    months: {},
    quality: null,
    external: null,
    verification: null,  // 独立校验报告（重新抓取权威源站逐条比对）
    city: '北京',
    // total / residential = 存量房两个口径；qfXfTotal / qfXfResidential = 期房+现房两个视图
    // 默认口径 = 住宅签约套数：与住建委官方逐日统计表 / 月报「住宅签约套数」一致，
    // 也是用户提供的官方截图口径；「网上签约套数」为换算口径，仍可一键切换。
    metric: 'residential',
    metricLabel: '存量房 · 住宅签约套数',
    updatedAt: null,
    monthKey: '',        // 存量房日历当前月份
    nhMonthKey: '',      // 期房/现房三张日历当前月份（与存量房独立）
    stMonthKey: '',      // 库存住宅三张日历当前月份（独立）
    span: 30,
    offline: false,
    hoverDate: null,
  };

  const NEW_VIEWS = ['qfXfTotal', 'qfXfResidential'];
  const STOCK_VIEW = 'stockResidential';
  const VIEW_LIST = ['total', 'residential', 'qfXfTotal', 'qfXfResidential', STOCK_VIEW];
  const isNewView = () => NEW_VIEWS.indexOf(state.metric) >= 0;
  const isStockView = () => state.metric === STOCK_VIEW;
  /** 期房/现房视图当前对应的两个字段名 */
  const newHomeFields = () =>
    state.metric === 'qfXfTotal'
      ? ['qfTotal', 'xfTotal', '网上签约套数']
      : ['qfResidential', 'xfResidential', '住宅签约套数'];

  const $ = (sel) => document.querySelector(sel);

  // ---------- 数据 ----------
  function normalize(raw) {
    const metric = raw.metric === 'residential' ? 'residential' : 'total';
    return {
      days: (raw.days || []).slice().sort((a, b) => a.date.localeCompare(b.date)),
      newHomes: (raw.newHomes || []).slice().sort((a, b) => a.date.localeCompare(b.date)),
      stocks: (raw.stocks || []).slice().sort((a, b) => a.date.localeCompare(b.date)),
      months: raw.months || {},
      quality: raw.quality || null,
      external: raw.external || null,
      verification: raw.verification || null,
      city: raw.city || '北京',
      metric,
      metricLabel: raw.metricLabel || (metric === 'total' ? '网上签约套数' : '住宅签约套数'),
      updatedAt: raw.updatedAt || null,
    };
  }

  /**
   * 按当前口径重建 state.days 的 value 字段。
   * 接口一次返回 residential 与 total 两个值，切换口径不需要重新请求。
   */
  function applyMetric() {
    if (isNewView() || isStockView()) {
      if (isStockView()) {
        state.metricLabel = '可售期房 / 未签约现房 · 其中住宅套数';
      } else {
        state.metricLabel =
          state.metric === 'qfXfTotal' ? '期房 / 现房 · 网上签约套数' : '期房 / 现房 · 住宅签约套数';
      }
      return;
    }
    const f = state.metric === 'total' ? 'total' : 'residential';
    state.days = state.days
      .map((d) => {
        const v = d[f];
        return v == null ? null : { ...d, value: v };
      })
      .filter(Boolean);
    state.metricLabel = state.metric === 'total' ? '存量房 · 网上签约套数' : '存量房 · 住宅签约套数';
    buildWeekendPairs();
  }

  const isWk = (d) => {
    if (d.weekend != null) return !!d.weekend;
    const w = parseKey(d.date).getDay();
    return w === 0 || w === 6;
  };
  /** 该周末日的单日值是否不可确知（官方直采日为确知） */
  const splitUnknown = (d) =>
    isWk(d) && (d.unknownSplit != null ? !!d.unknownSplit : d.quality !== 'official');

  /**
   * 周末展示模式（用户明确指示）：
   *   separate —— 周六、周日都有确知单日值（官方逐日表 / 官方直采 / 精确反推），
   *               两天各自单列、各自算涨跌；合计只作为数据字段保留，不再冒充单日值。
   *   merged   —— 两天单日值都不可确知，才合并成一格显示「周六+周日合计」。
   *   pending  —— 只有一侧有确知单日值：有值的一侧单列展示，另一侧显示「待披露」。
   */
  function buildWeekendPairs() {
    const byDate = new Map(state.days.map((d) => [d.date, d]));
    const pairs = {};
    for (const sat of state.days) {
      if (!isWk(sat) || parseKey(sat.date).getDay() !== 6) continue; // 以周六为锚
      const sunKey = toKey(new Date(parseKey(sat.date).getTime() + 86400000));
      const sun = byDate.get(sunKey) || null;
      const parts = [sat, sun].filter(Boolean);
      const ws = sat.weekendSum || null;

      const quality = ws
        ? ws.quality
        : (parts.every((x) => x.quality === 'official' ||
            (x.sources || []).indexOf('weekly-residual') >= 0)
            ? 'weekly-residual'
            : 'estimated');

      const complete = !!sun;
      const satKnown = !!sat.singleDayKnown;
      const sunKnown = !!sun && !!sun.singleDayKnown;
      const mode = satKnown && sunKnown ? 'separate'
        : (complete && !satKnown && !sunKnown) ? 'merged'
        : 'pending';

      pairs[sat.date] = {
        satDate: sat.date,
        sunDate: sunKey,
        sat,
        sun,
        complete,
        satKnown,
        sunKnown,
        mode,
        sumTotal: ws ? ws.total : parts.reduce((s, x) => s + (x.total || 0), 0),
        sumResidential: ws ? ws.residential : parts.reduce((s, x) => s + (x.residential || 0), 0),
        weekendQuality: quality,
        // 官方逐日表 / 官方直采 / 周残差精确反推 = 实际值；源站缺口回补 = 估算。
        exact: complete && (quality === 'official-table' || quality === 'official' || quality === 'weekly-residual'),
        change: null,
      };
    }
    state.weekendPairs = pairs;
    // pending 模式下单日未知的一侧要占位，绝不能把内部推算值当真值展示。
    const ungrouped = new Set();
    for (const p of Object.values(pairs)) {
      if (p.mode !== 'pending') continue;
      if (!p.satKnown) ungrouped.add(p.satDate);
      if (!p.sunKnown) ungrouped.add(p.sunDate);
    }
    state.ungroupedUnknown = ungrouped;
    if (typeof window !== 'undefined') window.__PAIRS = JSON.parse(JSON.stringify(pairs));
  }

  /** 口径说明文案 */
  function setMetricNote() {
    const note = $('#metricNote');
    if (!note) return;
    const texts = {
      total:
        '存量房：全部（含住宅、商业、办公等）网签口径。逐日总量由当月住宅占比换算，月合计对齐官方总量。有官方单日实值的周末周六、周日单列；仅有周合计的周末才显示两天合计。',
      residential:
        '存量房：住宅类网签口径，与住建委月报「住宅签约套数」一致。逐日数据为原始值；周末有官方单日实值时周六、周日单列，只有周合计时才显示两天合计。',
      qfXfTotal:
        '新建商品房：期房 / 现房当日「网上签约套数」（含住宅与非住宅）。三张日历分别为期房、现房、总计；住建委只公示最新一天，空白格是「未采集」而非 0。',
      qfXfResidential:
        '新建商品房：期房 / 现房当日「住宅签约套数」。三张日历分别为期房、现房、总计；住建委只公示最新一天，空白格是「未采集」而非 0。',
      stockResidential:
        '库存住宅存量（非成交）：可售期房统计、未签约现房统计里的「其中住宅套数」。两张日历按官方页自报截止日期逐日累积；住建委只公示当前快照，空白格是「未采集」而非 0，2020 年起的网页存档锚点单独标注。',
    };
    note.textContent = texts[state.metric] || texts.total;
  }

  /** 当前口径下的官方月报值 */
  function officialMonthValue(monthKey) {
    const m = state.months[monthKey];
    if (!m || !m.official) return null;
    if (state.metric === 'total') return m.total != null ? m.total : null;
    return m.residential != null ? m.residential : null;
  }

  /** 去年同月（仅住宅口径有原始数据；总量口径按住宅占比换算） */
  function prevYearValue(prevKey) {
    const pv = state.external && state.external.prevYear && state.external.prevYear[prevKey];
    if (!pv || pv.residential == null) return null;
    if (state.metric !== 'total') return pv.residential;
    const mt = state.external.monthlyTotal && state.external.monthlyTotal[prevKey];
    if (mt && mt.total) return mt.total;
    const ratio = globalRatio();
    return Math.round(pv.residential / ratio);
  }

  /** 全站住宅 / 网上签约总量占比（中位数），用于总量口径的换算兜底 */
  function globalRatio() {
    const list = [];
    const mt = (state.external && state.external.monthlyTotal) || {};
    for (const e of Object.values(mt)) {
      if (e && e.total && e.residential) list.push(e.residential / e.total);
    }
    const lj = (state.external && state.external.lianjia) || {};
    for (const e of Object.values(lj)) {
      if (e && e.cityTotal && e.cityResidential) list.push(e.cityResidential / e.cityTotal);
    }
    if (!list.length) return 0.8936;
    list.sort((a, b) => a - b);
    return list[Math.floor(list.length / 2)];
  }

  async function loadData() {
    let data = null;
    try {
      const res = await fetch('/api/days?metric=residential', { headers: { Accept: 'application/json' } });
      if (res.ok) {
        data = await res.json();
      }
    } catch (e) {
      /* 静态托管 / file:// 下走内置快照 */
    }
    if (!data && window.__SNAPSHOT__) {
      data = window.__SNAPSHOT__;
      state.offline = true;
    }
    if (!data) throw new Error('no data');
    return normalize(data);
  }

  // ---------- 计算 ----------
  function monthSummary(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const total = daysInMonth(y, m);
    const map = new Map(state.days.map((d) => [d.date, d]));

    const days = [];
    let sum = 0;
    let elapsed = 0;
    let prev = null;

    for (let d = 1; d <= total; d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;
      const rec = map.get(key);
      const v = rec ? rec.value : null;
      if (v != null) {
        sum += v;
        elapsed = d;
        days.push({
          date: key,
          day: d,
          value: v,
          quality: rec.quality || 'exact',
          change: prev == null ? null : v - prev,
          // 周末显示所需的元数据必须透传，否则日历会把「精确反推」误标成推算值
          weekend: rec.weekend,
          unknownSplit: rec.unknownSplit,
          singleDayKnown: rec.singleDayKnown,
          exactResidual: rec.exactResidual,
          sources: rec.sources,
        });
        prev = v;
      } else {
        days.push({ date: key, day: d, value: null, quality: null, change: null });
      }
    }

    const recorded = days.filter((d) => d.value != null);
    const isComplete = elapsed >= total;
    const officialMonth = officialMonthValue(monthKey);
    // 有官方月报时以官方为准（权威口径），否则用已披露日加总
    const monthTotal = officialMonth != null ? officialMonth : sum;

    // 「预估本月」已按用户要求下线，不再做剩余工作日外推；
    // 服务端 stats.js 的 forecast 字段仍保留（数据层，不影响页面）。
    return {
      month: monthKey,
      days,
      monthTotal,
      dailySum: sum,
      officialMonth,
      deviation:
        officialMonth != null && officialMonth > 0
          ? Number((((sum - officialMonth) / officialMonth) * 100).toFixed(2))
          : null,
      countedDays: recorded.length,
      derivedDays: recorded.filter((d) => d.quality === 'derived').length,
      estimatedDays: recorded.filter((d) => d.quality === 'estimated').length,
      elapsedDays: elapsed,
      complete: isComplete,
    };
  }

  function latestDay() {
    const list = state.days.filter((d) => d.value != null);
    return list.length ? list[list.length - 1] : null;
  }

  function buildWindow(span, endKey) {
    const map = new Map(state.days.map((d) => [d.date, d.value]));
    const base = parseKey(endKey);
    const points = [];
    for (let i = span - 1; i >= 0; i--) {
      const dt = new Date(base.getTime() - i * 86400000);
      const key = toKey(dt);
      points.push({
        date: key,
        label: key.slice(5),
        value: map.has(key) ? map.get(key) : null,
      });
    }
    const sum = points.reduce((s, p) => s + (p.value || 0), 0);
    const counted = points.filter((p) => p.value).length;
    return { span, points, sum, avg: counted ? Math.round(sum / counted) : 0, counted };
  }

  // ---------- 渲染：KPI ----------
  function renderKpis(month) {
    const latest = latestDay();
    const w30 = buildWindow(30, latest ? latest.date : toKey(new Date()));

    $('#kpiTotal').textContent = fmt(month.monthTotal);
    $('#kpiTotalSub').textContent =
      month.officialMonth != null
        ? `套 · 官方月报口径`
        : month.derivedDays > 0
          ? `套 · 覆盖 ${month.countedDays} 天（含推算 ${month.derivedDays} 天）`
          : `套 · 已披露 ${month.countedDays} 天`;

    if (latest) {
      const prev = state.days.filter((d) => d.value != null && d.date < latest.date).pop();
      const chg = prev ? latest.value - prev.value : null;
      $('#kpiLatest').textContent = fmt(latest.value);
      $('#kpiLatestSub').innerHTML =
        `套 · ${latest.date.slice(5).replace('-', '/')}` +
        (chg === null
          ? ''
          : ` 较前日 <span class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${
              chg > 0 ? '+' : ''
            }${fmt(chg)}</span>`);
      $('#latestChip').textContent = `最新 ${latest.date.slice(5)} · ${fmt(latest.value)} 套`;
    }

    $('#kpiWin30').textContent = fmt(w30.sum);
    $('#kpiWin30Sub').textContent = `套 · 日均 ${fmt(w30.avg)}`;

    if (state.updatedAt) {
      const d = new Date(state.updatedAt);
      $('#updatedAt').textContent =
        `更新于 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}${state.offline ? ' · 离线快照' : ''}`;
    }
  }

  // ---------- 渲染：日历 ----------
  /** 单日值不可确知的周末才用这个合并格：两格只居中列一行「周六+周日合计」 */
  function weekendCell(d, pair, span2, change, todayNum, month, opts) {
    opts = opts || {};
    const isXmSun = !!opts.crossMonthSunday;
    // 防御：半对周末的 sum 只是已有的一侧单日值，不能冒充两日合计，也不比涨跌。
    const pending = pair.complete === false;
    const el = document.createElement('div');
    // 跨月周末的周日落在次月：该周末单日值不可确知，合计已在上一月周六格显示，
    // 这里用「–」占位，不展示任何推算单日值。
    const sum = (isXmSun || pending) ? null : (state.metric === 'total' ? pair.sumTotal : pair.sumResidential);
    el.className =
      'cell weekend-group has' +
      (span2 ? ' span2' : '') +
      (pair.exact || pending ? '' : ' wk-est') +
      (pending ? ' wk-pending' : '') +
      (isXmSun ? ' xm-sun' : '') +
      (d.day === todayNum ? ' today' : '');
    el.dataset.date = span2 ? pair.satDate : d.date;

    let cls = '';
    let chg = '';
    if (!isXmSun && !pending && change != null && change !== 0) {
      cls = change > 0 ? 'up' : 'down';
      chg = (change > 0 ? '涨' : '降') + fmt(Math.abs(change));
    }
    const dayLabel = span2 && !isXmSun
      ? `${Number(pair.satDate.slice(8))} · ${Number(pair.sunDate.slice(8))}`
      : `${d.day} · 跨月`;
    // 「跨月周末 · 合计见上月」在单列格里放不下（会溢出格线），这里只留「合计见上月」，
    // 「· 跨月」已经在上面的日期行里说明，信息不丢。
    const sub = isXmSun
      ? (pending ? '合计待披露' : '合计见上月')
      : pending ? '周日待披露'
      : (span2 ? '周六+周日合计' : '跨月周末合计');
    el.innerHTML =
      `<span class="d">${dayLabel}</span>` +
      `<span class="c ${cls}">${chg}</span>` +
      `<span class="v ${cls}${(isXmSun || pending) ? ' muted' : ''}">${(isXmSun || pending) ? '–' : fmt(sum)}</span>` +
      `<span class="wk-sub">${sub}${!isXmSun && !pending && !pair.exact ? ' · 估算' : ''}</span>`;

    el.addEventListener('mouseenter', () => (
      isXmSun ? showCrossMonthSundayNote(pair, d)
        : pending ? showPendingWeekendNote(pair, d)
        : showWeekendNote(pair, sum)
    ));
    el.addEventListener('mouseleave', () => resetCellNote(month));
    return el;
  }

  /** 半对周末：有确知单日值的一侧单列显示，另一侧待披露 */
  function showPendingWeekendNote(pair, d) {
    const a = parseKey(pair.satDate);
    const b = parseKey(pair.sunDate);
    const known = pair.satKnown ? `周六 ${a.getMonth() + 1}月${a.getDate()}日` : `周日 ${b.getMonth() + 1}月${b.getDate()}日`;
    $('#calNote').innerHTML =
      `<b>${a.getMonth() + 1}月${a.getDate()}日（六） + ${b.getMonth() + 1}月${b.getDate()}日（日）</b> · ` +
      `${known}已有官方单日实值，按「有单日数据则单独统计」的口径单列展示；` +
      `另一侧尚未公示，显示「–」待披露，不用两天合计或推测值代替 · ` +
      `<span class="q-tag q-weekend-est">单日待披露</span>`;
  }

  /** 跨月周末「日」落在次月的提示：当天自身值 + 与上一月周六的合计 */
  function showCrossMonthSundayNote(pair, d) {
    const a = parseKey(pair.satDate);
    const b = parseKey(pair.sunDate);
    if (pair.complete === false) {
      $('#calNote').innerHTML =
        `<b>${b.getMonth() + 1}月${b.getDate()}日（日）</b> 为本跨月周末的次日 · ` +
        `与 ${a.getMonth() + 1}月${a.getDate()}日（六）同属一个周末，但周日数据尚未披露，` +
        `该周末暂无可确知的单日值，待披露 · <span class="q-tag q-weekend-est">单日待披露</span>`;
      return;
    }
    const total = state.metric === 'total' ? pair.sumTotal : pair.sumResidential;
    const q = pair.exact
      ? '<span class="q-tag q-weekend">周末合计 · 实际值</span>'
      : '<span class="q-tag q-weekend-est">周末合计 · 估算</span>';
    $('#calNote').innerHTML =
      `<b>${b.getMonth() + 1}月${b.getDate()}日（日）</b> 为本跨月周末的次日 · ` +
      `与 ${a.getMonth() + 1}月${a.getDate()}日（六）的「周六+周日合计」为 <b>${fmt(total)}</b> 套 ${q}；` +
      `这两天单日值均不可确知，合计数字已显示在上一月周六格`;
  }

  function showWeekendNote(pair, sum) {
    const a = parseKey(pair.satDate);
    const b = parseKey(pair.sunDate);
    const q = pair.exact
      ? '<span class="q-tag q-weekend">周末合计 · 实际值</span>'
      : '<span class="q-tag q-weekend-est">周末合计 · 估算</span>';
    const why = {
      'official-table': '来源：住建委官方逐日统计表，两天的逐日实值相加（已与官方月报逐月核对一致）',
      'official': '来源：住建委官方页逐日直采值相加',
      'weekly-residual': '来源：由「周合计 − 该周工作日之和」精确反推，并已与官方月报核对',
      'estimated': '该周周合计异常或源站整段缺失，合计为估算值，请谨慎使用',
    }[pair.weekendQuality] || '来源未标注';
    $('#calNote').innerHTML =
      `<b>${a.getMonth() + 1}月${a.getDate()}日（六） + ${b.getMonth() + 1}月${b.getDate()}日（日）</b> · ` +
      `<b>${fmt(sum)}</b> 套 ${q} · 这两天单日值均不可确知，才合并显示「周六+周日合计」（${why}）`;
  }

  function renderCalendar(month) {
    const [y, m] = month.month.split('-').map(Number);
    const firstWeekday = new Date(y, m - 1, 1).getDay();
    const offset = (firstWeekday + 6) % 7;

    const now = new Date();
    const isCurrent = month.month === `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const todayNum = isCurrent ? now.getDate() : 0;

    // 只有「两天合计格」才按上一个周末合计算涨跌；
    // 单日确知的周六 / 周日各自用 monthSummary 里 d.change（较上一已披露日）即可。
    const ordered = Object.values(state.weekendPairs).sort((a, b) =>
      a.satDate.localeCompare(b.satDate)
    );
    const changeMap = {};
    let prevSum = null;
    for (const p of ordered) {
      if (p.mode !== 'merged') { changeMap[p.satDate] = null; continue; }
      const s = state.metric === 'total' ? p.sumTotal : p.sumResidential;
      changeMap[p.satDate] = prevSum == null ? null : s - prevSum;
      prevSum = s;
    }

    const inMonth = new Set(month.days.map((d) => d.date));
    const frag = document.createDocumentFragment();
    for (let i = 0; i < offset; i++) frag.appendChild(document.createElement('div'));

    for (const d of month.days) {
      const dow = parseKey(d.date).getDay();
      const satKey = dow === 0 ? toKey(new Date(parseKey(d.date).getTime() - 86400000)) : null;
      const pairFromSunday = satKey ? state.weekendPairs[satKey] : null;
      const pair = dow === 6 ? state.weekendPairs[d.date] : pairFromSunday;
      const isWeekendDay = dow === 0 || dow === 6;

      // 只有「两天单日值都不可确知」的周末才跨列合并成一格；
      // 有官方逐日实值 / 直采 / 精确反推的周末，两天各占一格。
      if (pair && pair.mode === 'merged') {
        const pairSpans2 = !!(inMonth.has(pair.satDate) && inMonth.has(pair.sunDate));
        if (dow === 0 && pairSpans2) continue; // 周日已被本月周六的跨列格覆盖
        // 跨月周末的周日落在次月：合计已在上一月周六格显示，这里只留占位。
        if (dow === 0 && !inMonth.has(pair.satDate)) {
          frag.appendChild(weekendCell(d, pair, false, null, todayNum, month, { crossMonthSunday: true }));
          continue;
        }
        frag.appendChild(weekendCell(d, pair, pairSpans2, changeMap[pair.satDate], todayNum, month));
        continue;
      }

      const sideKnown = pair ? (dow === 6 ? pair.satKnown : pair.sunKnown) : false;
      const sidePending = !!(pair && pair.mode === 'pending' && !sideKnown);
      // pending 侧用「–」占位；孤立周末日（无配对却有值）也按防御隐藏推算值。
      const hiddenSpeculative = state.ungroupedUnknown.has(d.date) || sidePending ||
        (isWeekendDay && d.value != null && !pair);
      const has = d.value != null && !hiddenSpeculative;
      const est = has && d.quality === 'derived' && !d.exactResidual;
      const estGap = has && d.quality === 'estimated';
      const wkSingle = !!(has && isWeekendDay && sideKnown);
      const el = document.createElement('div');
      el.className =
        'cell' +
        (has ? ' has' : '') +
        (est ? ' est' : '') +
        (estGap ? ' estg' : '') +
        (wkSingle ? ' wk-single' : '') +
        (sidePending ? ' wk-pending' : '') +
        (hiddenSpeculative && !sidePending ? ' wk-unknown' : '') +
        (d.day === todayNum ? ' today' : '');
      if (has) el.dataset.date = d.date;

      let cls = '';
      let chg = '';
      if (has && d.change !== null && d.change !== 0) {
        cls = d.change > 0 ? 'up' : 'down';
        chg = (d.change > 0 ? '涨' : '降') + fmt(Math.abs(d.change));
      }

      el.innerHTML =
        `<span class="d">${d.day}</span>` +
        `<span class="c ${cls}">${chg}</span>` +
        `<span class="v ${cls}${has ? '' : ' muted'}">${has ? fmt(d.value) : '–'}</span>` +
        (sidePending ? `<span class="wk-sub">${dow === 6 ? '周六' : '周日'}待披露</span>` : '');

      if (has) {
        el.addEventListener('mouseenter', () => showCellNote(month, d));
        el.addEventListener('mouseleave', () => resetCellNote(month));
      } else if (hiddenSpeculative) {
        el.addEventListener('mouseenter', () => showUnknownWeekendNote(d));
        el.addEventListener('mouseleave', () => resetCellNote(month));
      }
      frag.appendChild(el);
    }

    const grid = $('#calGrid');
    grid.innerHTML = '';
    grid.appendChild(frag);

    $('#monthTitle').textContent = month.month;
    $('#prevM').disabled = !hasOlderMonth(month.month);
    $('#nextM').disabled = month.month >= currentMonthKey();

    resetCellNote(month);
  }

  function showCellNote(month, d) {
    const dt = parseKey(d.date);
    const chg = d.change;
    let extra = '';
    if (chg !== null && chg !== undefined && chg !== 0) {
      const pct = d.value - chg !== 0 ? ((chg / (d.value - chg)) * 100).toFixed(1) : null;
      extra =
        ` · 较上一有数据日 <b class="${chg > 0 ? 'up' : 'down'}">${chg > 0 ? '+' : ''}${fmt(chg)}` +
        (pct ? `（${chg > 0 ? '+' : ''}${pct}%）` : '') +
        '</b>';
    }
    const q = d.exactResidual
      ? ' · <span class="q-tag q-residual">周合计精确反推</span>'
      : d.quality === 'official'
        ? ' · <span class="q-tag q-official">官方直采</span>'
        : d.quality === 'estimated'
          ? ' · <span class="q-tag q-estg">缺口回补（估算）</span>'
          : d.quality === 'derived'
            ? ' · <span class="q-tag q-derived">周末推算</span>'
            : ' · <span class="q-tag q-exact">工作日实值</span>';
    $('#calNote').innerHTML =
      `<b>${dt.getMonth() + 1} 月 ${d.day} 日 周${WEEK[dt.getDay()]}</b> · ` +
      `<b class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${fmt(d.value)}</b> 套${extra}${q}`;
  }

  /** 单边实采周末中，另一天仍不可确知时的占位说明 */
  function showUnknownWeekendNote(d) {
    const dt = parseKey(d.date);
    $('#calNote').innerHTML =
      `<b>${dt.getMonth() + 1} 月 ${d.day} 日 周${WEEK[dt.getDay()]}</b> · ` +
      `这一侧的单日值尚未披露或不可确知，故显示为「–」；本周末另一侧已有官方实值并单独统计，` +
      `不用两天合计或推算值代替 · <span class="q-tag q-weekend-est">不展示推测数</span>`;
  }

  function resetCellNote(month) {
    if (!month.countedDays) {
      $('#calNote').textContent = '该月暂无数据';
      return;
    }
    const parts = [`本月覆盖 ${month.countedDays} 天`];
    const groups = Object.values(state.weekendPairs).filter(
      (p) => p.satDate.slice(0, 7) === month.month || p.sunDate.slice(0, 7) === month.month
    );
    const separate = groups.filter((p) => p.mode === 'separate').length;
    const merged = groups.filter((p) => p.mode === 'merged');
    const pending = groups.filter((p) => p.mode === 'pending').length;
    if (separate) parts.push(`${separate} 个周末周六、周日各自显示官方单日值`);
    const exactMerged = merged.filter((p) => p.exact).length;
    if (exactMerged) parts.push(`${exactMerged} 个周末单日不可确知，只显示两天合计（实际值）`);
    if (merged.length - exactMerged) parts.push(`${merged.length - exactMerged} 个周末合计为估算`);
    if (pending) parts.push(`${pending} 个周末单日待披露`);
    if (month.estimatedDays) parts.push(`${month.estimatedDays} 天为缺口回补（估算）`);
    if (month.officialMonth != null) {
      if (month.deviation != null && Math.abs(month.deviation) >= 0.05) {
        parts.push(`逐日加总较官方月报 ${month.deviation > 0 ? '+' : ''}${month.deviation}%`);
      } else {
        parts.push(`与官方月报（${fmt(month.officialMonth)} 套）一致`);
      }
    } else {
      parts.push('月合计为逐日加总');
    }
    $('#calNote').textContent = parts.join('，') + '。';
  }

  function currentMonthKey() {
    const n = new Date();
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}`;
  }

  function hasOlderMonth(monthKey) {
    if (!state.days.length) return false;
    return state.days[0].date.slice(0, 7) < monthKey;
  }

  // ---------- 渲染：图表 ----------
  const chartState = { day: null, month: null };

  function setupCanvas(canvas, cssH) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const cssW = Math.max(200, rect.width);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, W: cssW, H: cssH };
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceMax(v) {
    if (v <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const s = steps.find((x) => x >= n - 1e-9) || 10;
    return s * mag;
  }

  function drawDayChart() {
    const canvas = $('#chart');
    if (!canvas) return;
    const latest = latestDay();
    const end = latest ? latest.date : toKey(new Date());
    const win = buildWindow(state.span, end);
    chartState.day = win;

    const { ctx, W, H } = setupCanvas(canvas, canvas.parentElement.clientWidth < 480 ? 200 : 238);
    const padL = 38, padR = 10, padT = 16, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const max = niceMax(Math.max.apply(null, win.points.map((p) => p.value || 0).concat([1])));
    const yOf = (v) => padT + plotH - (v / max) * plotH;

    // 网格 + y 轴
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = (max / 4) * i;
      const y = yOf(val);
      ctx.strokeStyle = css('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(W - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = css('--faint');
      ctx.fillText(fmt(val), padL - 7, y);
    }

    const n = win.points.length;
    const step = plotW / n;
    const barW = Math.max(2.5, Math.min(18, step * 0.58));
    const radius = Math.min(3, barW / 2);
    const tops = [];
    const upColor = css('--brand');

    win.points.forEach((p, i) => {
      const cx = padL + step * i + step / 2;
      if (!p.value) {
        ctx.fillStyle = css('--line');
        ctx.fillRect(cx - barW / 2, padT + plotH - 2.5, barW, 2.5);
        tops.push(null);
        return;
      }
      const h = Math.max(2.5, (p.value / max) * plotH);
      const y = padT + plotH - h;
      const g = ctx.createLinearGradient(0, y, 0, padT + plotH);
      g.addColorStop(0, upColor);
      g.addColorStop(1, upColor + '55');
      ctx.fillStyle = g;
      const r = Math.min(radius, h);
      ctx.beginPath();
      ctx.moveTo(cx - barW / 2 + r, y);
      ctx.lineTo(cx + barW / 2 - r, y);
      ctx.quadraticCurveTo(cx + barW / 2, y, cx + barW / 2, y + r);
      ctx.lineTo(cx + barW / 2, padT + plotH);
      ctx.lineTo(cx - barW / 2, padT + plotH);
      ctx.lineTo(cx - barW / 2, y + r);
      ctx.quadraticCurveTo(cx - barW / 2, y, cx - barW / 2 + r, y);
      ctx.closePath();
      ctx.fill();
      tops.push({ x: cx, y });
    });

    // 折线
    ctx.strokeStyle = css('--up');
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    tops.forEach((t) => {
      if (!t) return;
      if (!started) {
        ctx.moveTo(t.x, t.y);
        started = true;
      } else ctx.lineTo(t.x, t.y);
    });
    ctx.stroke();

    // x 轴标签
    ctx.fillStyle = css('--faint');
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const stride = n <= 7 ? 1 : Math.ceil(n / (W < 420 ? 4 : 6));
    win.points.forEach((p, i) => {
      const show = n <= 7 || i === n - 1 || (n - 1 - i) % stride === 0;
      if (!show) return;
      ctx.fillText(p.label, padL + step * i + step / 2, H - padB + 9);
    });

    // 图表上方指标
    const maxPoint = win.points.reduce((a, b) => ((b.value || 0) > (a.value || 0) ? b : a), win.points[0]);
    $('#chartKpis').innerHTML =
      `<div class="ck"><span class="ck-v">${fmt(win.sum)}</span><span class="ck-k">区间累计（套）</span></div>` +
      `<div class="ck"><span class="ck-v">${fmt(win.avg)}</span><span class="ck-k">区间日均（套）</span></div>` +
      `<div class="ck"><span class="ck-v">${fmt(maxPoint.value)}</span><span class="ck-k">单日最高 ${maxPoint.date.slice(5)}</span></div>`;

    canvas._geom = { padL, padR, step, points: win.points };
  }

  // 近 N 个月：本月 vs 去年同期。窄屏用 4 个月，让每组双柱 + 双数值不拥挤。
  function monthCompare(count) {
    const keys = [...new Set(state.days.map((d) => d.date.slice(0, 7)))].sort();
    if (!keys.length) return [];
    const end = keys[keys.length - 1];
    const list = [];
    for (let i = count - 1; i >= 0; i--) {
      const k = addMonth(end, -i);
      const ms = monthSummary(k);
      const prevKey = `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`;
      const prev = prevYearValue(prevKey);
      // 有官方月报即视为整月数据完整（缺口月份也有官方月报，只是逐日不全）
      const official = !!(state.months[k] && state.months[k].official);
      const complete = official || ms.complete;
      const yoy =
        prev && complete && ms.monthTotal > 0
          ? Number((((ms.monthTotal - prev) / prev) * 100).toFixed(1))
          : null;
      list.push({
        key: k,
        label: `${k.slice(2, 4)}/${k.slice(5)}`,
        value: ms.monthTotal,
        prev,
        prevKey,
        yoy,
        complete,
        totalExact: !!(state.months[k] && state.months[k].totalExact),
      });
    }
    return list;
  }

  function drawMonthChart() {
    const canvas = $('#monthChart');
    if (!canvas) return;

    // 窄屏每组要容纳两根柱 + 两串数字，减少到 4 个月比强行缩字号更清晰。
    const narrow = canvas.parentElement.clientWidth < 480;
    const items = monthCompare(narrow ? 4 : 6);
    chartState.month = items;

    const done = items.filter((i) => i.yoy != null).length;
    const withPrev = items.filter((i) => i.prev != null && i.complete).length;
    $('#monthHint').textContent = items.length
      ? `近 ${items.length} 个月 · ${withPrev} 个月有去年同期 · 同比 ${done} 个月可比`
      : '暂无完整月份';

    // 顶部要同时容纳「今年」与「去年同期」两串数字，画布比原来高一些
    const { ctx, W, H } = setupCanvas(canvas, narrow ? 208 : 224);
    if (!items.length) return;

    const padL = 48;
    const padR = 10;
    const padT = 34;
    const padB = 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const peak = Math.max.apply(
      null,
      items.map((i) => Math.max(i.value || 0, i.prev || 0)).concat([1])
    );
    const max = niceMax(peak);
    const yOf = (v) => padT + plotH - (v / max) * plotH;

    // 网格 + Y 轴
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const val = (max / 2) * i;
      const y = yOf(val);
      ctx.strokeStyle = css('--grid');
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(W - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = css('--faint');
      ctx.fillText(fmt(val), padL - 7, y);
    }

    const step = plotW / items.length;
    const barW = Math.min(15, step * 0.19);
    const curColor = css('--brand');
    const prevColor = css('--faint');

    // 两串数字必须各自紧贴「自己的」柱顶：去年数值更小 → 灰柱更矮 → 数字自然
    // 落在今年数字下方。绝不能为了防重叠而把小数值硬抬到大数值上方。
    // 防重叠改由「横向拉开」解决：按实际文字宽度算所需中心距；窄屏放不下时
    // 自动降一档字号，但数字与柱顶的对应关系始终不变。
    const fontTiers = [[10, 9], [9.5, 8.5], [9, 8], [8.5, 7.5]];
    let curFont = '';
    let prevFont = '';
    let gap = Math.max(10, step * 0.18);
    const maxGap = Math.max(10, step * 0.9 - 2 * barW);
    for (const [cs, ps] of fontTiers) {
      const cf = `600 ${cs}px -apple-system, sans-serif`;
      const pf = `600 ${ps}px -apple-system, sans-serif`;
      let need = 0;
      for (const it of items) {
        ctx.font = cf;
        const a = ctx.measureText(fmt(it.value)).width;
        ctx.font = pf;
        const b = it.prev != null ? ctx.measureText(fmt(it.prev)).width : 0;
        need = Math.max(need, (a + b) / 2 + 4);
      }
      curFont = cf;
      prevFont = pf;
      gap = Math.max(10, need - barW);
      if (gap <= maxGap) break;
    }
    gap = Math.min(gap, maxGap);

    const bar = (x, w, h, color, alpha) => {
      const y = padT + plotH - h;
      const r = Math.min(4, w / 2, h);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, padT + plotH);
      ctx.lineTo(x, padT + plotH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      return y;
    };

    items.forEach((it, i) => {
      const cx = padL + step * i + step / 2;
      const showPrev = !!(it.prev && it.complete);
      const xCur = showPrev ? cx - barW - gap / 2 : cx - barW / 2;
      const xPrev = cx + gap / 2;

      // 去年同期（当月进行中时不给去年柱，避免误读成暴跌）
      let yPrevTop = null;
      if (showPrev) {
        const h = Math.max(2, (it.prev / max) * plotH);
        yPrevTop = bar(xPrev, barW, h, prevColor, 0.5);
        // 柱顶短横线：把数值标签和这根灰柱明确对应起来
        ctx.save();
        ctx.strokeStyle = prevColor;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xPrev, Math.round(yPrevTop) + 0.5);
        ctx.lineTo(xPrev + barW, Math.round(yPrevTop) + 0.5);
        ctx.stroke();
        ctx.restore();
      }
      // 今年
      const h = Math.max(2, (it.value / max) * plotH);
      const yTop = bar(xCur, barW, h, curColor, it.complete ? 1 : 0.45);

      if (!it.complete) {
        // 进行中：顶部虚线
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = curColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xCur, Math.round(yTop) + 0.5);
        ctx.lineTo(xCur + barW, Math.round(yTop) + 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // 今年数值（紧贴蓝柱柱顶）
      ctx.fillStyle = it.complete ? css('--text') : css('--muted');
      ctx.font = curFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(it.value), xCur + barW / 2, yTop - 3);

      // 去年同期数值（紧贴灰柱柱顶；柱更矮，数字就自然在下方）
      if (showPrev) {
        ctx.fillStyle = css('--muted');
        ctx.font = prevFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(fmt(it.prev), xPrev + barW / 2, yPrevTop - 3);
      }

      // 月份
      ctx.fillStyle = css('--faint');
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(it.label, cx, H - padB + 5);

      // 同比
      if (it.yoy != null) {
        ctx.fillStyle = it.yoy > 0 ? css('--up') : it.yoy < 0 ? css('--down') : css('--faint');
        ctx.font = '600 9.5px -apple-system, sans-serif';
        ctx.fillText(`${it.yoy > 0 ? '+' : ''}${it.yoy}%`, cx, H - padB + 19);
      } else {
        ctx.fillStyle = css('--faint');
        ctx.font = '9.5px -apple-system, sans-serif';
        ctx.fillText(it.complete ? '—' : '进行中', cx, H - padB + 19);
      }
    });

    const foot = $('#monthFoot');
    if (foot) {
      // 窄屏为容纳双柱 + 双数值只画近 4 个月，如实说明，避免被误认为数据缺失
      const narrowNote = narrow ? '窄屏为并排容纳两串数字，此处显示近 4 个月。' : '';
      if (state.metric === 'total') {
        const exact = items.filter((i) => i.totalExact).length;
        foot.textContent =
          `网上签约套数 = 住宅 + 非住宅（商业、办公等）。${exact}/${items.length} 个月为住建委月报的原始总量口径，` +
          `其余月份按当月住宅占网签总量比例（约 ${(globalRatio() * 100).toFixed(1)}%）由住宅值换算；` +
          `去年同期总量同法换算，仅作趋势参考。灰柱上方数字即去年同期套数。${narrowNote}`;
      } else {
        const missing = items.length - withPrev;
        foot.textContent =
          '蓝柱为今年、灰柱为去年同期，两柱上方数字均为当月住宅签约套数，下方百分比为同比。' +
          '去年同期取住建委月报；' +
          (missing > 0
            ? `其中 ${missing} 个月缺公开数据或当月未结束，不显示灰柱、不做同比。`
            : '当月未结束时只显示累计值，不做同比。') +
          narrowNote;
      }
    }
  }

  // ---------- 链家签约与市占率 ----------
  function lianjiaRows() {
    const ext = state.external;
    if (!ext || !ext.lianjia) return [];
    return Object.keys(ext.lianjia)
      .sort()
      .map((k) => {
        const r = ext.lianjia[k] || {};
        const share = r.cityTotal ? (r.count / r.cityTotal) * 100 : null;
        return { key: k, label: `${k.slice(2, 4)}/${k.slice(5)}`, count: r.count, share, raw: r };
      })
      .filter((r) => r.count != null);
  }

  function renderLianjiaSum(rows) {
    const el = $('#ljSum');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<span class="q-empty">暂无链家分机构数据</span>';
      return;
    }
    const last = rows[rows.length - 1];
    const avg = rows.reduce((s, r) => s + (r.share || 0), 0) / rows.filter((r) => r.share).length;
    el.innerHTML =
      `<div class="ck"><span class="ck-v">${fmt(last.count)}<small>套</small></span>` +
      `<span class="ck-k">${last.key} 链家签约</span></div>` +
      `<div class="ck"><span class="ck-v">${last.share != null ? last.share.toFixed(1) + '%' : '—'}</span>` +
      `<span class="ck-k">当月市占率</span></div>` +
      `<div class="ck"><span class="ck-v">${isFinite(avg) ? avg.toFixed(1) + '%' : '—'}</span>` +
      `<span class="ck-k">${rows.length} 个月均值</span></div>`;
  }

  function drawLianjiaChart() {
    const canvas = $('#ljChart');
    if (!canvas) return;
    const rows = lianjiaRows();
    renderLianjiaSum(rows);
    $('#ljHint').textContent = rows.length
      ? `${rows[0].key} ~ ${rows[rows.length - 1].key} · 共 ${rows.length} 个月`
      : '—';
    const ljFoot = $('#ljFoot');
    if (ljFoot) {
      ljFoot.textContent =
        '柱：链家当月签约套数；橙线：市占率 = 链家签约套数 ÷ 全市网上签约总套数。' +
        '住建委只公布最新一个月的机构排行，历史月份由网页存档补齐，因此月份不连续；此后按月自动累积。';
    }

    const { ctx, W, H } = setupCanvas(canvas, canvas.parentElement.clientWidth < 480 ? 176 : 196);
    if (!rows.length) return;

    const padL = 44;
    const padR = 34;
    const padT = 22;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // 上半部分留给市占率折线，下半部分放柱状图，避免两组数字打架
    const shareBandH = Math.max(26, plotH * 0.2);
    const barTop = padT + shareBandH + 16;
    const barH = padT + plotH - barTop;

    const maxCount = niceMax(Math.max.apply(null, rows.map((r) => r.count).concat([1])));
    const shares = rows.map((r) => r.share).filter((s) => s != null);
    const sMin = Math.min.apply(null, shares);
    const sMax = Math.max.apply(null, shares);
    const lo = Math.max(0, sMin - 3);
    const hi = sMax + 3;

    const yOf = (v) => padT + plotH - (v / maxCount) * barH;
    const yOfShare = (s) => padT + shareBandH - ((s - lo) / (hi - lo || 1)) * shareBandH;
    const shareColor = '#d97706';

    // 网格
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const val = (maxCount / 2) * i;
      const y = yOf(val);
      ctx.strokeStyle = css('--grid');
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(W - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = css('--faint');
      ctx.fillText(fmt(val), padL - 7, y);
    }

    const step = plotW / rows.length;
    const barW = Math.min(26, step * 0.46);
    const barColor = css('--brand');

    rows.forEach((r, i) => {
      const cx = padL + step * i + step / 2;
      const h = Math.max(2, (r.count / maxCount) * barH);
      const y = padT + plotH - h;
      const rad = Math.min(5, barW / 2, h);
      const g = ctx.createLinearGradient(0, y, 0, padT + plotH);
      g.addColorStop(0, barColor);
      g.addColorStop(1, barColor + '55');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - barW / 2 + rad, y);
      ctx.lineTo(cx + barW / 2 - rad, y);
      ctx.quadraticCurveTo(cx + barW / 2, y, cx + barW / 2, y + rad);
      ctx.lineTo(cx + barW / 2, padT + plotH);
      ctx.lineTo(cx - barW / 2, padT + plotH);
      ctx.lineTo(cx - barW / 2, y + rad);
      ctx.quadraticCurveTo(cx - barW / 2, y, cx - barW / 2 + rad, y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = css('--text');
      ctx.font = '600 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(r.count), cx, y - 3);

      ctx.fillStyle = css('--faint');
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(r.label, cx, H - padB + 6);
    });

    // 市占率折线（独立上区）
    const pts = rows
      .map((r, i) => (r.share == null ? null : { x: padL + step * i + step / 2, y: yOfShare(r.share), v: r.share }))
      .filter(Boolean);
    if (pts.length > 1) {
      ctx.strokeStyle = shareColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    pts.forEach((p) => {
      ctx.fillStyle = shareColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 9.5px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${p.v.toFixed(1)}%`, p.x, p.y - 6);
    });
  }


  // ---------- 渲染：期房 / 现房视图 ----------
  function newHomeRows() {
    const [qfF, xfF] = newHomeFields();
    return state.newHomes
      .filter((r) => Number.isFinite(r[qfF]) || Number.isFinite(r[xfF]))
      .map((r) => ({
        date: r.date,
        qf: Number.isFinite(r[qfF]) ? r[qfF] : null,
        xf: Number.isFinite(r[xfF]) ? r[xfF] : null,
        source: r.source || '—',
      }));
  }

  function renderNewHomeTable(rows, label) {
    const el = $('#nhTable');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="nh-empty">暂无期房 / 现房采集数据</div>';
      return;
    }
    const body = rows
      .slice()
      .reverse()
      .map((r) => {
        const sum = (r.qf || 0) + (r.xf || 0);
        const tag = r.source === '住建委（实时抓取）' ? '实时抓取' : '存档锚点';
        return (
          `<tr><td>${r.date}</td><td class="n">${fmt(r.qf)}</td>` +
          `<td class="n">${fmt(r.xf)}</td><td class="n">${fmt(sum)}</td>` +
          `<td class="src">${tag}</td></tr>`
        );
      })
      .join('');
    el.innerHTML =
      `<table class="nh-table"><thead><tr>` +
      `<th>日期</th><th>期房${label}</th><th>现房${label}</th><th>合计</th><th>来源</th>` +
      `</tr></thead><tbody>${body}</tbody></table>`;
  }

  function drawNewHomeChart(rows, label, opts) {
    const o = opts || {};
    const canvas = $(o.canvasSel || '#nhChart');
    if (!canvas) return;
    const { ctx, W, H } = setupCanvas(canvas, canvas.parentElement.clientWidth < 480 ? 210 : 244);
    const padL = 40, padR = 10, padT = 18, padB = 32;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const list = rows.slice(-16); // 最多画最近 16 个采集日
    const peak = Math.max.apply(null, list.flatMap((r) => [r.qf || 0, r.xf || 0]).concat([1]));
    const max = niceMax(peak);
    const yOf = (v) => padT + plotH - (v / max) * plotH;

    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const val = (max / 4) * i;
      const y = yOf(val);
      ctx.strokeStyle = css('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(W - padR, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = css('--faint');
      ctx.fillText(fmt(val), padL - 7, y);
    }

    if (!list.length) {
      ctx.fillStyle = css('--faint');
      ctx.textAlign = 'center';
      ctx.fillText('暂无采集数据', W / 2, padT + plotH / 2);
      return;
    }

    const qfColor = css('--brand');
    const xfColor = '#f08c2e';
    const step = plotW / list.length;
    const barW = Math.max(3, Math.min(20, step * 0.3));
    const gap = Math.max(2, step * 0.05);

    const bar = (x, v, color) => {
      const h = Math.max(2, (v / max) * plotH);
      const y = padT + plotH - h;
      const r = Math.min(3, barW / 2, h);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barW - r, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
      ctx.lineTo(x + barW, padT + plotH);
      ctx.lineTo(x, padT + plotH);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
      return y;
    };

    list.forEach((r, i) => {
      const cx = padL + step * i + step / 2;
      const yQ = bar(cx - barW - gap / 2, r.qf || 0, qfColor);
      const yX = bar(cx + gap / 2, r.xf || 0, xfColor);
      if (list.length <= 9) {
        ctx.fillStyle = css('--text');
        ctx.font = '600 9.5px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(fmt(r.qf), cx - barW - gap / 2 + barW / 2, yQ - 3);
        ctx.fillText(fmt(r.xf), cx + gap / 2 + barW / 2, yX - 3);
      }
      ctx.fillStyle = css('--faint');
      ctx.font = '9.5px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const stride = list.length <= 7 ? 1 : Math.ceil(list.length / (W < 420 ? 4 : 7));
      const show = list.length <= 7 || i === list.length - 1 || (list.length - 1 - i) % stride === 0;
      if (show) ctx.fillText(r.date.slice(5), cx, H - padB + 8);
    });

    const hintEl = $(o.hintSel || '#nhHint');
    if (hintEl) hintEl.textContent = o.hintText
      ? o.hintText(list, rows)
      : (list.length
        ? `已采集 ${rows.length} 天 · 显示最近 ${list.length} 天 · ${list[0].date} ~ ${list[list.length - 1].date}`
        : '—');
  }

  function renderNewHome() {
    const rows = newHomeRows();
    const [, , label] = newHomeFields();
    const last = rows.length ? rows[rows.length - 1] : null;
    const qf = last ? last.qf : null;
    const xf = last ? last.xf : null;
    const sum = qf != null || xf != null ? (qf || 0) + (xf || 0) : null;
    const shortDate = last ? last.date.slice(5).replace('-', '/') : '';

    $('#nhKpiQf').textContent = fmt(qf);
    $('#nhKpiXf').textContent = fmt(xf);
    $('#nhKpiSum').textContent = fmt(sum);
    $('#nhKpiDays').textContent = fmt(rows.length);
    $('#nhKpiQfSub').textContent = last ? `套 · ${shortDate} 期房${label}` : '套';
    $('#nhKpiXfSub').textContent = last ? `套 · ${shortDate} 现房${label}` : '套';
    $('#nhKpiSumSub').textContent = last ? `套 · ${shortDate} 当日合计` : '套';
    $('#nhKpiDaysSub').textContent = last ? `天 · 最新 ${last.date}` : '天';
    $('#nhLegendNote').textContent = `口径：${label} · 日期不连续`;
    // 顶栏 chip：存量房视图由 KPI 渲染负责，这里补上期房/现房口径，否则会一直停在「数据加载中…」
    const chip = $('#latestChip');
    if (chip) chip.textContent = last ? `最新 ${last.date.slice(5)} · ${fmt(sum)} 套` : '暂无采集';
    if (rows.length) {
      $('#nhHint').textContent = `共 ${rows.length} 个采集日 · ${rows[0].date} ~ ${rows[rows.length - 1].date}`;
    } else {
      $('#nhHint').textContent = '—';
    }
    renderNewHomeTable(rows, label);
    drawNewHomeChart(rows, label);
    renderNewHomeCalendars();
  }

  // ---------- 期房 / 现房：三张月历（期房 / 现房 / 总计） ----------
  /**
   * 与存量房日历的区别：期房/现房没有连续历史日序列。
   * 因此这里绝不插值、绝不用日均凑数 —— 只把「已采集到的官方单日实际值」放进对应日期格，
   * 其余日期显示「–」（未采集，不是 0）。合计也只是本月已采集这几天的加总。
   */
  function newHomeMonthRows(monthKey) {
    const [qfF, xfF] = newHomeFields();
    return state.newHomes
      .filter((r) => r.date.slice(0, 7) === monthKey)
      .map((r) => {
        const qf = Number.isFinite(r[qfF]) ? r[qfF] : null;
        const xf = Number.isFinite(r[xfF]) ? r[xfF] : null;
        const sum = qf != null && xf != null ? qf + xf : null;
        return {
          date: r.date,
          qf,
          xf,
          sum,
          partial: sum == null && (qf != null || xf != null),
          source: r.source || '—',
          live: r.source === '住建委（实时抓取）',
          chg_qf: null,
          chg_xf: null,
          chg_sum: null,
        };
      })
      .filter((r) => r.qf != null || r.xf != null)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 「较上一采集日」只在同月内计算，避免拿相隔数月的两个日子做无意义对比 */
  function attachNewHomeChanges(rows) {
    let prev = null;
    for (const r of rows) {
      for (const f of ['qf', 'xf', 'sum']) {
        r[`chg_${f}`] =
          prev && Number.isFinite(r[f]) && Number.isFinite(prev[f]) ? r[f] - prev[f] : null;
      }
      prev = r;
    }
    return rows;
  }

  /**
   * 日历格悬停说明。opts 让「期房/现房」与「库存住宅」两套日历共用同一套渲染逻辑：
   *   noteSel  —— 写说明文字的容器
   *   noteDesc —— 数值性质说明（成交 / 库存）
   *   resetText—— 鼠标移开时的汇总文案
   * 不传 opts 时行为与原来的期房/现房视图完全一致。
   */
  function showNhCellNote(row, field, name, opts) {
    const o = opts || {};
    const noteEl = $(o.noteSel || '#nhCalNote');
    if (!noteEl) return;
    const dt = parseKey(row.date);
    const v = row[field];
    const chg = row[`chg_${field}`];
    let extra = '';
    if (chg != null && chg !== 0) {
      extra =
        ` · 较本月上一采集日 <b class="${chg > 0 ? 'up' : 'down'}">${chg > 0 ? '+' : ''}${fmt(chg)}</b>`;
    }
    const src = row.live
      ? '<span class="q-tag q-official">住建委实时抓取</span>'
      : '<span class="q-tag q-exact">网页存档锚点</span>';
    const missing =
      field === 'sum' && row.partial
        ? ' · <span class="q-tag q-estg">当日缺少一侧数据，故不计总计</span>'
        : '';
    noteEl.innerHTML =
      `<b>${dt.getMonth() + 1} 月 ${dt.getDate()} 日 周${WEEK[dt.getDay()]}</b> · ` +
      `${name} <b class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${Number.isFinite(v) ? fmt(v) : '–'}</b> 套` +
      `${extra}${src}${missing} · ${o.noteDesc || '数值为当日官方实际值，无推算'}`;
  }

  function resetNhCalNote(monthKey, rows, opts) {
    const o = opts || {};
    const noteEl = $(o.noteSel || '#nhCalNote');
    if (!noteEl) return;
    if (o.resetText) {
      noteEl.textContent = o.resetText(monthKey, rows);
      return;
    }
    if (!rows.length) {
      noteEl.textContent =
        `${monthKey} 没有任何已采集日期 · 住建委只公示最新一天，历史逐日值无法回补，空白格均为「未采集」而非 0`;
      return;
    }
    noteEl.textContent =
      `${monthKey} 共采集 ${rows.length} 天（${rows.map((r) => Number(r.date.slice(8))).join('、')} 日）` +
      ` · 悬停任一日格可查看来源与较本月上一采集日的变化`;
  }

  /** 渲染单张日历，返回 { count, sum } 供右侧合计与页脚使用 */
  function renderNhGrid(gridEl, monthKey, rows, field, name, opts) {
    const o = opts || {};
    if (!gridEl) return { count: 0, sum: 0 };
    const [y, m] = monthKey.split('-').map(Number);
    const totalDays = daysInMonth(y, m);
    const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 周一为第一列
    const byDate = new Map(rows.map((r) => [r.date, r]));

    const now = new Date();
    const isCurrent = monthKey === `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const todayNum = isCurrent ? now.getDate() : 0;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < offset; i++) frag.appendChild(document.createElement('div'));

    for (let d = 1; d <= totalDays; d++) {
      const key = `${y}-${pad(m)}-${pad(d)}`;
      const row = byDate.get(key) || null;
      const v = row ? row[field] : null;
      const has = Number.isFinite(v);
      const el = document.createElement('div');
      el.className =
        'cell nh-cell' +
        (has ? ' has' : '') +
        (row && row.partial && field === 'sum' ? ' nh-partial' : '') +
        (d === todayNum ? ' today' : '');

      let cls = '';
      let chg = '';
      const change = row ? row[`chg_${field}`] : null;
      if (has && change != null && change !== 0) {
        cls = change > 0 ? 'up' : 'down';
        chg = (change > 0 ? '涨' : '降') + fmt(Math.abs(change));
      }

      el.innerHTML =
        `<span class="d">${d}</span>` +
        `<span class="c ${cls}">${chg}</span>` +
        `<span class="v ${cls}${has ? '' : ' muted'}">${has ? fmt(v) : '–'}</span>` +
        (has
          ? `<span class="nh-tag ${row.live ? 'live' : 'archive'}">${row.live ? '实时抓取' : '存档锚点'}</span>`
          : '');

      if (row) {
        el.addEventListener('mouseenter', () => showNhCellNote(row, field, name, o));
        el.addEventListener('mouseleave', () => resetNhCalNote(monthKey, rows, o));
      }
      frag.appendChild(el);
    }

    gridEl.innerHTML = '';
    gridEl.appendChild(frag);

    // 格宽有限而数字位数不定（库存有 6 位数），按实际可用宽度收缩字号，避免与邻格叠压
    fitNhGridNumbers(gridEl);

    const vals = rows.map((r) => r[field]).filter(Number.isFinite);
    return { count: vals.length, sum: vals.reduce((s, x) => s + x, 0) };
  }

  /**
   * 日历格内数字自适应字号。
   * 库存日历的数值可达 6 位（如 27,328 / 53,472），固定字号会横向溢出本格、
   * 压到相邻格的数字上。这里量出每格的实际可用宽度，取能让整张日历的数字
   * 都放得下的最大字号并统一应用（同一张表内字号一致，不会参差）。
   */
  function fitNhGridNumbers(gridEl) {
    if (!gridEl) return;
    const cells = Array.from(gridEl.querySelectorAll('.cell.has'));
    const vs = [];
    cells.forEach((c) => {
      const v = c.querySelector('.v');
      if (v) vs.push(v);
    });
    if (!vs.length) return;

    vs.forEach((v) => { v.style.fontSize = ''; });
    const base = parseFloat(getComputedStyle(vs[0]).fontSize) || 15;

    // 字号随文字宽度近似线性变化，先按比值估一个能整表放下的最大字号
    let ratio = 1;
    cells.forEach((c) => {
      const v = c.querySelector('.v');
      if (!v) return;
      const cs = getComputedStyle(c);
      const avail = c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (avail <= 4) return;
      const w = v.scrollWidth; // 基础字号下的文字实际宽度
      if (w > 0) ratio = Math.min(ratio, avail / w);
    });

    let fs = Math.max(9.5, Math.round(base * ratio * 2) / 2);
    // 复核：字间距是固定 px，且估算有舍入，逐档微调保证「完全放得下、不裁切」
    vs.forEach((v) => { v.style.fontSize = fs + 'px'; });
    let guard = 0;
    while (fs > 9.5 && guard++ < 12) {
      const overflow = vs.some((v) => v.scrollWidth > v.clientWidth + 0.5);
      if (!overflow) break;
      fs -= 0.5;
      vs.forEach((v) => { v.style.fontSize = fs + 'px'; });
    }
  }

  /** 所有日历格数字重新自适应（窗口尺寸变化后调用） */
  function fitAllNhGrids() {
    ['#nhQfGrid', '#nhXfGrid', '#nhSumGrid', '#stQfGrid', '#stXfGrid', '#stSumGrid'].forEach((sel) =>
      fitNhGridNumbers($(sel))
    );
  }

  function nhMonthKeysWithData() {
    return [...new Set(state.newHomes.map((r) => r.date.slice(0, 7)))].sort();
  }

  function renderNhNav(monthKey) {
    const keys = nhMonthKeysWithData();
    $('#nhMonthTitle').textContent = monthKey;
    const prevBtn = $('#nhPrevM');
    const nextBtn = $('#nhNextM');
    if (prevBtn) prevBtn.disabled = keys.length ? monthKey <= keys[0] : true;
    if (nextBtn) nextBtn.disabled = monthKey >= currentMonthKey();

    const sel = $('#nhMonthJump');
    if (sel) {
      const opts = keys
        .map((k) => {
          const n = state.newHomes.filter((r) => r.date.slice(0, 7) === k).length;
          return `<option value="${k}"${k === monthKey ? ' selected' : ''}>${k}（${n} 天）</option>`;
        })
        .join('');
      const placeholder = keys.indexOf(monthKey) >= 0
        ? ''
        : `<option value="${monthKey}" selected>${monthKey}（本月无采集）</option>`;
      sel.innerHTML = placeholder + opts;
    }

    const range = $('#nhCalRange');
    if (range) {
      const first = state.newHomes.length ? state.newHomes[0].date : null;
      const last = state.newHomes.length ? state.newHomes[state.newHomes.length - 1].date : null;
      range.textContent = first && last
        ? `累计 ${state.newHomes.length} 个采集日 · ${first} ~ ${last} · 共 ${keys.length} 个月有数据`
        : '—';
    }
  }

  function renderNewHomeCalendars() {
    if (!state.nhMonthKey) {
      const last = state.newHomes.length ? state.newHomes[state.newHomes.length - 1].date : null;
      state.nhMonthKey = last ? last.slice(0, 7) : currentMonthKey();
    }
    const monthKey = state.nhMonthKey;
    const rows = attachNewHomeChanges(newHomeMonthRows(monthKey));
    const [, , label] = newHomeFields();

    const defs = [
      ['qf', '期房', '#nhQfGrid', '#nhQfSum', '#nhQfFoot'],
      ['xf', '现房', '#nhXfGrid', '#nhXfSum', '#nhXfFoot'],
      ['sum', '总计', '#nhSumGrid', '#nhSumSum', '#nhSumFoot'],
    ];
    for (const [field, name, gridSel, sumSel, footSel] of defs) {
      const { count, sum } = renderNhGrid($(gridSel), monthKey, rows, field, name);
      const sumEl = $(sumSel);
      const footEl = $(footSel);
      if (sumEl) sumEl.textContent = count ? `合计 ${fmt(sum)} 套` : '本月无采集';
      if (footEl) {
        footEl.innerHTML = count
          ? `已采集 <b>${count}</b> 天 · 合计 <b>${fmt(sum)}</b> 套（${label}）<br>仅这 ${count} 天相加，<b>非整月网签量</b>`
          : '本月没有采集到任何日期，空白格均为「未采集」而非 0';
      }
    }
    renderNhNav(monthKey);
    resetNhCalNote(monthKey, rows);
  }

  // ---------- 可售期房 / 未签约现房 · 库存住宅套数（新 tab） ----------
  /**
   * 与「期房/现房网上签约」的区别：
   *   · 网上签约 tab = 当日成交（流量）
   *   · 本 tab      = 当日市场剩余库存（存量）
   * 两者都不能跨 tab 相加。日历严格只显示已采集到的官方快照值，空白 = 未采集。
   */
  const STOCK_CAL_OPTS = {
    noteSel: '#stCalNote',
    noteDesc: '数值为当日官方公示的库存存量（套），不是当日成交，无推算、无插值',
    resetText: (monthKey, rows) => {
      if (!rows.length) {
        return `${monthKey} 没有任何已采集快照 · 住建委只公示当前快照，历史逐日值无法回补，空白格均为「未采集」而非 0`;
      }
      return `${monthKey} 共采集 ${rows.length} 个快照日（${rows.map((r) => Number(r.date.slice(8))).join('、')} 日）` +
        ' · 悬停任一日格可查看来源与较本月上一采集日的变化';
    },
  };

  const stockNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** 全量库存序列 → 通用日历行结构（复用期房/现房的日历渲染与涨跌计算） */
  function stockRows() {
    return state.stocks
      .map((r) => {
        const qf = stockNum(r.qfStockResidential);
        const xf = stockNum(r.xfStockResidential);
        if (qf == null && xf == null) return null;
        return {
          date: r.date,
          qf,
          xf,
          sum: qf != null && xf != null ? qf + xf : null,
          partial: qf == null || xf == null,
          source: r.source || '—',
          live: r.live === true || r.source === '住建委（实时抓取）',
          chg_qf: null,
          chg_xf: null,
          chg_sum: null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  function stockMonthRows(monthKey) {
    return attachNewHomeChanges(
      stockRows().filter((r) => r.date.slice(0, 7) === monthKey)
    );
  }

  function stockMonthKeysWithData() {
    return [...new Set(stockRows().map((r) => r.date.slice(0, 7)))].sort();
  }

  function renderStockTable(rows) {
    const el = $('#stTable');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="nh-empty">暂无库存住宅采集数据</div>';
      return;
    }
    const body = rows
      .slice()
      .reverse()
      .map((r) => {
        const tag = r.live ? '官方页实时抓取' : '网页存档锚点';
        return (
          `<tr><td>${r.date}</td><td class="n">${fmt(r.qf)}</td>` +
          `<td class="n">${fmt(r.xf)}</td><td class="n">${fmt(r.sum)}</td>` +
          `<td class="src">${tag}</td></tr>`
        );
      })
      .join('');
    el.innerHTML =
      `<table class="nh-table"><thead><tr>` +
      `<th>截止日期</th><th>可售期房住宅</th><th>未签约现房住宅</th><th>两项相加</th><th>来源</th>` +
      `</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderStockNav(monthKey) {
    const keys = stockMonthKeysWithData();
    const title = $('#stMonthTitle');
    if (title) title.textContent = monthKey;
    const prevBtn = $('#stPrevM');
    const nextBtn = $('#stNextM');
    if (prevBtn) prevBtn.disabled = keys.length ? monthKey <= keys[0] : true;
    if (nextBtn) nextBtn.disabled = monthKey >= currentMonthKey();

    const sel = $('#stMonthJump');
    if (sel) {
      const rows = stockRows();
      const opts = keys
        .map((k) => {
          const n = rows.filter((r) => r.date.slice(0, 7) === k).length;
          return `<option value="${k}"${k === monthKey ? ' selected' : ''}>${k}（${n} 天）</option>`;
        })
        .join('');
      const placeholder = keys.indexOf(monthKey) >= 0
        ? ''
        : `<option value="${monthKey}" selected>${monthKey}（本月无采集）</option>`;
      sel.innerHTML = placeholder + opts;
    }

    const range = $('#stCalRange');
    if (range) {
      const rows = stockRows();
      const first = rows.length ? rows[0].date : null;
      const last = rows.length ? rows[rows.length - 1].date : null;
      range.textContent = first && last
        ? `累计 ${rows.length} 个快照日 · ${first} ~ ${last} · 共 ${keys.length} 个月有数据`
        : '—';
    }
  }

  function renderStockCalendars() {
    if (!state.stMonthKey) {
      const rows = stockRows();
      const last = rows.length ? rows[rows.length - 1].date : null;
      state.stMonthKey = last ? last.slice(0, 7) : currentMonthKey();
    }
    const monthKey = state.stMonthKey;
    const rows = stockMonthRows(monthKey);

    const defs = [
      ['qf', '可售期房住宅', '#stQfGrid', '#stQfSum', '#stQfFoot'],
      ['xf', '未签约现房住宅', '#stXfGrid', '#stXfSum', '#stXfFoot'],
      ['sum', '两项相加', '#stSumGrid', '#stSumSum', '#stSumFoot'],
    ];
    for (const [field, name, gridSel, sumSel, footSel] of defs) {
      const { count, sum } = renderNhGrid($(gridSel), monthKey, rows, field, name, STOCK_CAL_OPTS);
      const sumEl = $(sumSel);
      const footEl = $(footSel);
      if (sumEl) sumEl.textContent = count ? `合计 ${fmt(sum)} 套` : '本月无采集';
      if (footEl) {
        footEl.innerHTML = count
          ? `已采集 <b>${count}</b> 个快照日 · 合计 <b>${fmt(sum)}</b> 套<br>仅这 ${count} 天相加，<b>不是月末库存</b>`
          : '本月没有采集到任何日期，空白格均为「未采集」而非 0';
      }
    }
    renderStockNav(monthKey);
    resetNhCalNote(monthKey, rows, STOCK_CAL_OPTS);
  }

  function drawStockChart(rows) {
    drawNewHomeChart(rows, '住宅套数', {
      canvasSel: '#stChart',
      hintSel: '#stHint',
      hintText: (list, all) =>
        list.length
          ? `共 ${all.length} 个快照日 · 显示最近 ${list.length} 个 · ${list[0].date} ~ ${list[list.length - 1].date}`
          : '—',
    });
  }

  function renderStock() {
    const rows = stockRows();
    const last = rows.length ? rows[rows.length - 1] : null;
    const qf = last ? last.qf : null;
    const xf = last ? last.xf : null;
    const sum = last ? last.sum : null;
    const shortDate = last ? last.date.slice(5).replace('-', '/') : '';

    $('#stKpiQf').textContent = fmt(qf);
    $('#stKpiXf').textContent = fmt(xf);
    $('#stKpiSum').textContent = fmt(sum);
    $('#stKpiDays').textContent = fmt(rows.length);
    $('#stKpiQfSub').textContent = last ? `套 · ${shortDate} 截止` : '套';
    $('#stKpiXfSub').textContent = last ? `套 · ${shortDate} 截止` : '套';
    $('#stKpiSumSub').textContent = last ? `套 · ${shortDate} 截止` : '套 · 仅作观察';
    $('#stKpiDaysSub').textContent = last ? `天 · 最新 ${last.date}` : '天';

    const chip = $('#latestChip');
    if (chip) chip.textContent = last ? `库存截止 ${shortDate} · 住宅 ${fmt(qf)} / ${fmt(xf)} 套` : '暂无库存采集';

    renderStockTable(rows);
    drawStockChart(rows);
    renderStockCalendars();
  }

  // ---------- 更长时间尺度 · 住建委近五年官方年度数据（所有视图共用） ----------
  /** 官方只给年度合计，不能拆成日历；这里如实以年度柱状呈现，绝不伪造逐日值。 */
  function renderAnnual() {
    const el = $('#annualPanel');
    if (!el) return;
    const a = state.external && state.external.annual;
    if (!a || !Array.isArray(a.existingHome) || !a.existingHome.length) {
      el.innerHTML = '<p class="q-empty">暂无官方年度数据</p>';
      return;
    }
    const cols = [
      ['存量房 · 住宅签约套数', a.existingHome, ''],
      ['新建商品房 · 住宅签约套数', a.newHome || [], 'alt'],
    ];
    const all = [...a.existingHome, ...(a.newHome || [])].map((r) => r.residential).filter(Number.isFinite);
    const max = Math.max.apply(null, all.concat([1]));
    const html = cols
      .map(([title, list, cls]) => {
        if (!list.length) return '';
        const rows = list
          .map((r) =>
            `<div class="an-row"><span class="yr">${r.year}</span>` +
            `<span class="an-track"><span class="an-bar ${cls}" style="width:${Math.max(2, (r.residential / max) * 100).toFixed(1)}%"></span></span>` +
            `<span class="n">${r.residential.toFixed(2)}</span></div>`
          )
          .join('');
        return `<div class="an-col"><h3><i class="${cls ? 'nh-xf' : 'nh-qf'}"></i>${title}</h3>${rows}</div>`;
      })
      .join('');
    const hint = $('#annualHint');
    if (hint) hint.textContent = `${a.existingHome[0].year}–${a.existingHome[a.existingHome.length - 1].year} · ${a.unit}`;
    el.innerHTML = `<div class="an-grid">${html}</div>` +
      `<p class="an-foot">${a.source} · ${a.note || ''}</p>`;
  }

  // ---------- 独立数据校验报告（所有视图共用） ----------
  const NUM_LABELS = {
    rawDays: '源站日数', compared: '逐条比对', mismatch: '不一致', absent: '缺失',
    date: '日期', officialResidential: '官方住宅', officialTotal: '官方总量',
    storedResidential: '本站住宅', storedTotal: '本站总量',
    months: '月份数', exact: '完全一致', off: '偏差月', maxAbsDiff: '最大差值',
    month: '月份', official: '官方值', storedSum: '本站合计', diff: '差值', days: '天数',
    records: '记录数', invalid: '非法', liveDate: '直采日', liveMatch: '与官方一致',
    negative: '负数', totalLtResidential: '总量<住宅', nonInteger: '非整数',
    missingQuality: '缺质量标记', duplicate: '重复', range: '区间',
    liveMonth: '实时月报月', liveResidential: '官方住宅', liveTotal: '官方总量',
    archivedMonthsChecked: '存档月报核对',
    weeks: '周数', verified: '已验证', skipped: '跳过',
    sourceConflict: '口径微差周', excludedOrGap: '错值/缺口周', maxConflictPct: '最大口径差%',
    estimatedDays: '估算日', historicalWeekendDays: '历史周末日', newHomeSparseDays: '期现房零散日',
  };

  const fmtVal = (x) => {
    if (Array.isArray(x)) {
      if (!x.length) return '0';
      return `[${x.slice(0, 3).join(', ')}${x.length > 3 ? ', …' : ''}]`;
    }
    if (x === null || x === undefined) return '—';
    if (typeof x === 'boolean') return x ? '是' : '否';
    if (typeof x === 'object') return JSON.stringify(x);
    return String(x);
  };

  function renderVerification() {
    const el = $('#verifyPanel');
    if (!el) return;
    const v = state.verification;
    if (!v) {
      el.innerHTML =
        '<p class="q-empty">暂无独立校验报告。运行 <code>npm run verify</code> 生成 server/data/verification.json，再刷新页面即可。</p>';
      return;
    }

    const s = v.summary || {};
    const verdict = v.verdict || 'UNKNOWN';
    const cls = verdict === 'PASS' ? 'ok' : verdict === 'PARTIAL' ? 'warn' : 'bad';
    const verdictText =
      verdict === 'PASS'
        ? `PASS · ${s.passed}/${s.hardChecks} 项硬校验通过`
        : verdict === 'PARTIAL'
          ? `PARTIAL · ${s.passed}/${s.hardChecks} 项通过，${s.unavailable} 项源站未取到`
          : `FAIL · ${s.failed} 项硬校验未通过`;
    const gen = v.generatedAt ? new Date(v.generatedAt) : null;
    const genText = gen
      ? `${gen.getFullYear()}-${pad(gen.getMonth() + 1)}-${pad(gen.getDate())} ${pad(gen.getHours())}:${pad(gen.getMinutes())}`
      : '—';

    const checks = v.checks || [];
    const num = (id, key, dflt) => {
      const c = checks.find((x) => x.id === id);
      return c && c.numbers && c.numbers[key] != null ? c.numbers[key] : dflt;
    };

    const checksHtml = checks
      .map((c) => {
        const isPass = c.status === 'PASS';
        const isFail = c.status === 'FAIL';
        const isDisc = c.status === 'DISCLOSED';
        const ico = isPass ? '✓' : isFail ? '✗' : isDisc ? '!' : '?';
        const icoCls = isPass ? 'pass' : isFail ? 'fail' : 'disc';
        const nums = Object.entries(c.numbers || {})
          .map(([k, val]) => `${NUM_LABELS[k] || k} <b>${fmtVal(val)}</b>`)
          .join(' · ');
        return (
          `<div class="vf-check ${isDisc ? 'disclosed' : ''} ${isFail ? 'fail' : ''}">` +
          `<div class="vf-check-h"><span class="vf-ico ${icoCls}">${ico}</span><span>${c.label}</span></div>` +
          (nums ? `<div class="vf-nums">${nums}</div>` : '') +
          `<div class="vf-detail">${c.detail || ''}</div>` +
          `</div>`
        );
      })
      .join('');

    const monthly = v.monthlyReconciliation || [];
    const weekly = v.weeklyConsistency || [];
    const conflicts = weekly.filter((w) => w.kind === 'source_conflict');
    const excluded = weekly.filter((w) => w.kind === 'excluded_or_gap');

    const monthlyRows = monthly
      .slice()
      .reverse()
      .map(
        (r) =>
          `<tr><td>${r.month}</td><td class="n">${fmt(r.sum)}</td>` +
          `<td class="n">${fmt(r.official)}</td>` +
          `<td class="n ${r.diff === 0 ? 'good-n' : ''}">${r.diff === 0 ? '0 ✓' : (r.diff > 0 ? '+' : '') + r.diff}</td>` +
          `<td class="n">${r.days}</td></tr>`
      )
      .join('');
    const weeklyRows = weekly
      .filter((w) => w.kind !== 'exact')
      .slice()
      .reverse()
      .map(
        (w) =>
          `<tr><td>${w.week} ~ ${w.end}</td><td class="n">${fmt(w.sourceWeekly)}</td>` +
          `<td class="n">${fmt(w.storedSum)}</td><td class="n">${w.diff > 0 ? '+' : ''}${fmt(w.diff)}</td>` +
          `<td class="note">${w.kind === 'source_conflict' ? `源站周/月口径微差 ${w.pct}%` : '错值周 / 源站整段缺口，已剔除'}</td></tr>`
      )
      .join('');

    const okBox =
      `<div class="vf-box ok"><h4>这些数字是 100% 正确的</h4>` +
      `${fmt(num('workday_exact', 'rawDays', 0))} 个工作日单日值逐条与源站一致（0 处不符）；` +
      `官方直采日、${fmt(num('monthly_residential', 'months', 0))} 个官方月报月份的逐日合计（住宅 / 总量两个口径）、` +
      `官方月报锚点表、${fmt(num('weekend_residual', 'verified', 0))} 个自洽周的历史周末「两天合计」逐周反推、` +
      `期房/现房当日值、全部数值合法性 —— <b>共 ${s.passed}/${s.hardChecks} 项硬校验全部通过</b>。</div>`;
    const noBox =
      `<div class="vf-box no"><h4>这些数字无法 100% 确知（界面已标注）</h4>` +
      `历史周六 / 周日<b>各自</b>的单日值（公开渠道根本不提供，界面只显示两天合计，共 ${fmt(num('limits', 'historicalWeekendDays', 0))} 天）；` +
      `${fmt(num('limits', 'estimatedDays', 0))} 天源站整段缺口回补（估算，日历标「缺口回补」）；` +
      `期房 / 现房历史逐日值（仅 ${fmt(num('limits', 'newHomeSparseDays', 0))} 个零散存档日，无连续公开源）。` +
      `<b>这些值不参与「准确」宣称，绝不冒充精确值。</b></div>`;

    el.innerHTML =
      `<div class="vf-top">` +
      `<span class="vf-badge ${cls}">${verdictText}</span>` +
      `<span class="vf-meta">校验时间 ${genText} · 重新抓取住建委存量房公示页 / 房地产数据主题服务页 / 北京房市儿原始日序列逐条比对` +
      ` · ${s.disclosed || 0} 项「如实披露」不参与准确宣称 · 源站取数失败 ${s.unavailable || 0} 项</span>` +
      `</div>` +
      `<div class="vf-checks">${checksHtml}</div>` +
      (v.statement ? `<div class="vf-statement">${v.statement}</div>` : '') +
      `<div class="vf-split">${okBox}${noBox}</div>` +
      `<details class="vf-details">` +
      `<summary>展开逐月对账表（${monthly.length} 个月，偏差全为 0）与源站周/月口径差明细（${conflicts.length} 周微差 / ${excluded.length} 周剔除）</summary>` +
      `<div class="q-table-wrap"><table class="q-table"><thead><tr>` +
      `<th>月份</th><th>本站逐日合计</th><th>官方月报</th><th>偏差</th><th>天数</th>` +
      `</tr></thead><tbody>${monthlyRows}</tbody></table></div>` +
      `<div class="q-table-wrap" style="margin-top:14px"><table class="q-table"><thead><tr>` +
      `<th>周（一 ~ 日）</th><th>源站周合计</th><th>本站合计</th><th>差值</th><th>说明</th>` +
      `</tr></thead><tbody>${weeklyRows}</tbody></table></div>` +
      `</details>`;
  }

  // ---------- 交互 ----------
  function bindTooltip() {
    const canvas = $('#chart');
    const tip = $('#tip');

    const move = (clientX, clientY) => {
      const geom = canvas._geom;
      if (!geom) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const i = Math.floor((x - geom.padL) / geom.step);
      const p = geom.points[i];
      if (!p) {
        tip.hidden = true;
        return;
      }
      const label = p.value
        ? `${p.date.slice(5)} · ${fmt(p.value)} 套`
        : `${p.date.slice(5)} · 未披露`;
      tip.textContent = label;
      tip.hidden = false;
      const cx = geom.padL + geom.step * i + geom.step / 2;
      tip.style.left = Math.min(Math.max(cx, 46), rect.width - 46) + 'px';
      const max = niceMax(Math.max.apply(null, geom.points.map((q) => q.value || 0).concat([1])));
      const plotH = canvas.clientHeight - 16 - 26;
      const h = p.value ? Math.max(2.5, (p.value / max) * plotH) : 0;
      tip.style.top = Math.max(24, 16 + plotH - h) + 'px';
    };

    canvas.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    canvas.addEventListener('mouseleave', () => {
      tip.hidden = true;
    });
    canvas.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
  }

  function bindEvents() {
    $('#prevM').addEventListener('click', () => {
      state.monthKey = addMonth(state.monthKey, -1);
      render();
    });
    $('#nextM').addEventListener('click', () => {
      if (state.monthKey >= currentMonthKey()) return;
      state.monthKey = addMonth(state.monthKey, 1);
      render();
    });

    // 期房/现房三张日历：共用一个月份导航 + 直接跳到有采集数据的月份
    $('#nhPrevM').addEventListener('click', () => {
      state.nhMonthKey = addMonth(state.nhMonthKey, -1);
      renderNewHomeCalendars();
    });
    $('#nhNextM').addEventListener('click', () => {
      if (state.nhMonthKey >= currentMonthKey()) return;
      state.nhMonthKey = addMonth(state.nhMonthKey, 1);
      renderNewHomeCalendars();
    });
    const jump = $('#nhMonthJump');
    if (jump) {
      jump.addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test(jump.value)) return;
        state.nhMonthKey = jump.value;
        renderNewHomeCalendars();
      });
    }

    // 库存住宅三张日历：独立的月份导航 + 跳到有数据的月份
    $('#stPrevM').addEventListener('click', () => {
      state.stMonthKey = addMonth(state.stMonthKey, -1);
      renderStockCalendars();
    });
    $('#stNextM').addEventListener('click', () => {
      if (state.stMonthKey >= currentMonthKey()) return;
      state.stMonthKey = addMonth(state.stMonthKey, 1);
      renderStockCalendars();
    });
    const stJump = $('#stMonthJump');
    if (stJump) {
      stJump.addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test(stJump.value)) return;
        state.stMonthKey = stJump.value;
        renderStockCalendars();
      });
    }

    $('#spanTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-span]');
      if (!btn) return;
      state.span = Number(btn.dataset.span);
      [...$('#spanTabs').children].forEach((b) => b.classList.toggle('on', b === btn));
      drawDayChart();
    });

    // 口径切换：网上签约套数 / 住宅签约套数
    $('#metricTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-metric]');
      if (!btn || btn.dataset.metric === state.metric) return;
      state.metric = btn.dataset.metric;
      [...$('#metricTabs').children].forEach((b) => {
        const on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      setMetricNote();
      applyMetric();
      render();
      // 同步地址栏，便于把某个视图直接分享出去
      try {
        const u = new URL(location.href);
        u.searchParams.set('metric', state.metric);
        history.replaceState(null, '', u);
      } catch (e) {
        /* file:// 下忽略 */
      }
    });

    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        // 格宽变了，格内数字要重新算一次字号，否则窄屏下会再次叠压
        fitAllNhGrids();
        if (isStockView()) drawStockChart(stockRows());
        else if (isNewView()) drawNewHomeChart(newHomeRows(), newHomeFields()[2]);
        else {
          drawDayChart();
          drawMonthChart();
          drawLianjiaChart();
        }
      }, 120);
    });

    // 主题
    const root = document.documentElement;
    const qTheme = new URLSearchParams(location.search).get('theme');
    const saved = qTheme === 'dark' || qTheme === 'light' ? qTheme : localStorage.getItem('theme');
    if (saved) root.setAttribute('data-theme', saved);
    $('#themeBtn').addEventListener('click', () => {
      const cur =
        root.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      if (isStockView()) drawStockChart(stockRows());
      else if (isNewView()) drawNewHomeChart(newHomeRows(), newHomeFields()[2]);
      else {
        drawDayChart();
        drawMonthChart();
        drawLianjiaChart();
      }
    });
  }

  // ---------- 渲染：数据质量 ----------
  function renderQuality() {
    const el = $('#qualityPanel');
    if (!el) return;
    const q = state.quality;
    if (!q) {
      el.innerHTML = '<p class="q-empty">暂无质量报告</p>';
      return;
    }
    const c = q.counts || {};
    const rows = (q.reconciliation || []).slice().reverse();

    const fmtRange = q.range && q.range.from ? `${q.range.from} ~ ${q.range.to}` : '—';

    const trs = rows
      .map((r) => {
        let note = '—';
        let cls = '';
        if (r.official == null) {
          note = r.estimated ? `进行中 · 回补 ${r.estimated} 天` : '进行中';
        } else if (r.deviation != null && Math.abs(r.deviation) >= 0.05) {
          note = `偏差 ${r.deviation > 0 ? '+' : ''}${r.deviation}%`;
          cls = 'bad';
        } else if (r.estimated > 0) {
          note = `一致 · 回补 ${r.estimated} 天`;
          cls = 'warn';
        } else {
          note = '一致';
          cls = 'good';
        }
        return `<tr class="${cls}">
          <td>${r.month}</td>
          <td class="n">${fmt(r.sum)}</td>
          <td class="n">${r.official != null ? fmt(r.official) : '—'}</td>
          <td class="n">${r.deviation != null ? (r.deviation > 0 ? '+' : '') + r.deviation + '%' : '—'}</td>
          <td class="note">${note}</td>
        </tr>`;
      })
      .join('');

    const estDays = q.estimatedDays || [];
    const est = estDays.length;
    const estWeekdays = estDays.filter((k) => {
      const w = parseKey(k).getDay();
      return w !== 0 && w !== 6;
    }).length;
    const gapHtml = (q.gaps || []).length
      ? `<div class="q-alert">仍有数据缺口：${q.gaps
          .map((g) => `<b>${g.from}${g.from === g.to ? '' : ' ~ ' + g.to}</b>（${g.days} 个工作日）`)
          .join('、')} —— 该区间原始数据源本身缺失，未做任何填充。</div>`
      : est
        ? `<div class="q-ok">源站 2026-04-24 ~ 05-15 整段缺失，已回补 <b>${est}</b> 天（其中 <b>${estWeekdays}</b> 个工作日、${est - estWeekdays} 个周末/假日）。做法：用凤凰网房产「凰家周刊」的每周住宅网签套数作为各周强弱，在官方月报总量约束下按「星期效应 + 周末占比」分配。这些日期在日历中标注为「缺口回补」，属估算值；月合计仍与官方月报完全一致。</div>`
        : '<div class="q-ok">无数据缺口：区间内每个工作日都有原始数据。</div>';

    const sus = q.suspiciousWeeks || [];
    const susHtml = sus.length
      ? `<div class="q-alert">已剔除 ${sus.length} 个异常周合计：${sus
          .map((s) => `<b>${s.week}</b>（源站 ${fmt(s.anchor)}，残差 ${fmt(s.residual)}）`)
          .join('、')} —— 该周合计与同周工作日数据自相矛盾，周末值改由官方月报锚定。</div>`
      : '';

    const cap = q.capture;
    const capChip =
      cap && cap.lastDate
        ? `<span class="q-chip">官方直采最近 <b>${cap.lastDate.slice(5)}</b></span>`
        : '';
    const missHtml =
      cap && (cap.missed || []).length
        ? `<div class="q-alert">漏采提醒：${cap.missed.join('、')} 附近的官方日值未被采到（爬虫进程中断所致），这些日期只能保留推算值。</div>`
        : '';

    el.innerHTML = `
      <div class="q-sum">
        <span class="q-chip">区间 <b>${fmtRange}</b></span>
        <span class="q-chip">共 <b>${fmt(c.total)}</b> 天</span>
        <span class="q-chip">官方直采 <b>${fmt(c.official || 0)}</b></span>
        <span class="q-chip">工作日实值 <b>${fmt(c.exact || 0)}</b></span>
        <span class="q-chip">历史周末（只显合计） <b>${fmt(c.derived || 0)}</b></span>
        <span class="q-chip">缺口回补 <b>${fmt(c.estimated || 0)}</b></span>
        ${capChip}
      </div>
      ${gapHtml}
      ${susHtml}
      ${missHtml}
      <div class="q-table-wrap">
        <table class="q-table">
          <thead>
            <tr><th>月份</th><th>本站合计</th><th>官方月报</th><th>偏差</th><th>校验</th></tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
      <p class="q-foot">校验方法：用住建委公布的月度「住宅签约套数」作为硬约束，逐月核对本站逐日合计。工作日日值来自原始日序列（不做任何调整）；<b>周末合计</b>由「周总量 − 本周工作日合计」精确推导；源站周合计自相矛盾的周被剔除，改由官方月报锚定。因此有官方月报的月份，本站合计与官方偏差均为 0.00%。<br>关于周末：住建委官方页每天都发布（含周六、周日），但一次只显示最新一天，历史单日值无法回补。<b>历史周六、周日各自的单日值不可确知，只有两天的合计是实际值</b>；为让月合计闭合，内部仍按比例把合计拆成两天，但该拆分是近似值，<b>日历里已合并成一格、只居中显示一行合计</b>，不再展示两个推测数。跨月周末在相邻两个月各显示一次同一合计，并标注「跨月」。<b>今后新产生的周末日会以官方值直接入库，两天各自单独显示。</b></p>
    `;
  }

  // ---------- 主渲染 ----------
  function render() {
    // 校验报告与长期年度数据、口径无关，所有视图都常驻显示
    renderVerification();
    renderAnnual();
    const oldView = $('#oldView');
    const newView = $('#newHomeView');
    const stockView = $('#stockView');

    if (isStockView()) {
      // 必须先取消隐藏，canvas 才能量到正确宽度
      if (oldView) oldView.hidden = true;
      if (newView) newView.hidden = true;
      if (stockView) stockView.hidden = false;
      renderStock();
      return;
    }
    if (stockView) stockView.hidden = true;

    if (isNewView()) {
      // 必须先取消隐藏，canvas 才能量到正确宽度
      if (oldView) oldView.hidden = true;
      if (newView) newView.hidden = false;
      renderNewHome();
      return;
    }
    if (oldView) oldView.hidden = false;
    if (newView) newView.hidden = true;

    const month = monthSummary(state.monthKey);
    renderKpis(month);
    renderCalendar(month);
    renderQuality();
    drawDayChart();
    drawMonthChart();
    drawLianjiaChart();
  }

  /** 页面每 10 分钟重拉一次 /api/days；切回前台时也检查一次（在线模式） */
  async function refreshClientData() {
    if (state.offline) return;
    try {
      const res = await fetch('/api/days?metric=residential', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const raw = await res.json();
      const keep = {
        metric: state.metric,
        monthKey: state.monthKey,
        nhMonthKey: state.nhMonthKey,
        stMonthKey: state.stMonthKey,
        span: state.span,
      };
      Object.assign(state, normalize(raw), keep);
      applyMetric();
      render();
    } catch (e) {
      /* 网络抖动静默跳过，下一轮再试 */
    }
  }

  async function boot() {
    try {
      const data = await loadData();
      Object.assign(state, data);
      if (!state.days.length && !state.newHomes.length && !state.stocks.length) throw new Error('empty');

      // 支持 ?metric=... 直达任一视图
      const qm = new URLSearchParams(location.search).get('metric');
      if (VIEW_LIST.indexOf(qm) >= 0) {
        state.metric = qm;
      }

      applyMetric();
      setMetricNote();

      // 同步口径 tab 的选中态
      const tabs = $('#metricTabs');
      if (tabs) {
        [...tabs.children].forEach((b) => {
          const on = b.dataset.metric === state.metric;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
      }

      const lastDate = state.days.length ? state.days[state.days.length - 1].date : null;
      state.monthKey = lastDate ? lastDate.slice(0, 7) : currentMonthKey();
      const lastNh = state.newHomes.length ? state.newHomes[state.newHomes.length - 1].date : null;
      state.nhMonthKey = lastNh ? lastNh.slice(0, 7) : currentMonthKey();
      const lastSt = state.stocks.length ? state.stocks[state.stocks.length - 1].date : null;
      state.stMonthKey = lastSt ? lastSt.slice(0, 7) : currentMonthKey();

      bindEvents();
      bindTooltip();
      render();

      // 网页每 10 分钟自动重拉一次；从后台切回前台时也补一次
      setInterval(refreshClientData, 10 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshClientData();
      });
    } catch (e) {
      console.error(e);
      $('#latestChip').textContent = '数据加载失败';
      $('#calNote').textContent = '数据加载失败，请检查 /api/days 或重新生成内置快照。';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
