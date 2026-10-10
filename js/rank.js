/* =========================================================
 * js/rank.js —— 榜单（排序维度 / 阈值 / 难度筛选）
 *   · rankRows(songs, ratings, opts)：纯函数，不碰 DOM / window，可 node --test 单测
 *   · renderRank(state)：把榜单骨架渲染进 #main，并绑定控件
 * 计算口径、排序主键与并列规则见 私有开发仓的接口规格 第 2.3 节（逐字实现）。
 * 数据源：songs.json（元数据）+ public.ratings 全表（前端聚合，唯一权威源）。
 * ========================================================= */

import { getSongs, coverImg } from './songs.js';
import { getRatings, isReadOnly } from './storage.js';
import { escapeHtml, stars, mountDropdown } from './ui.js';

/* 规格 5.1 允许把后台视图放在 js/admin.js（只从 ui.js 调用）。这里再导出一份，
 * 让「按规格名字直接 import js/rank.js」的用法也能拿到 renderAdmin。 */
export { renderAdmin } from './admin.js';

/* ---------------- 控件常量 ---------------- */

const SORTS = [
  { value: 'avg', label: '平均分' },
  { value: 'count', label: '评分人数' },
  { value: 'level', label: '难度（定数）' }
];
const MIN_OPTIONS = [1, 3, 5, 10, 20];
const DIFFS = ['all', 'EZ', 'HD', 'IN', 'AT'];
const EMPTY_TEXT = '还没有可排行的数据。榜单按「平均分」等维度给曲目排名，'
  + '需要先有人打分；如果只有个别曲目有分，这里就会只有那几首。'
  + '（也可以试试把「最少评分人数」调小一点。）';

/* ---------------- 纯计算 ---------------- */

function cmpNum(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/** 取难度等级（rating）最高的一项：并列时取 difficulties 数组里靠前者 */
export function mostDiffOf(song) {
  const list = (song && song.difficulties) || [];
  let best = null;
  list.forEach(d => {
    if (!d) return;
    if (!best || Number(d.rating) > Number(best.rating)) best = d;
  });
  if (!best) return { level: '', rating: 0, constant: 0 };
  return { level: best.level, rating: best.rating, constant: best.constant };
}

/**
 * 计算榜单（纯函数）。
 * @param {Array} songs   songs.json 的曲目数组
 * @param {Array} ratings public.ratings 全表
 * @param {{sort?:string,dir?:string,minCount?:number,difficulty?:string}} opts
 * @returns {Array<{song:object,count:number,sum:number,avg:number,mostDiff:object,maxDiff:object,rank:number}>}
 */
export function rankRows(songs, ratings, opts) {
  const o = opts || {};
  const sort = (o.sort === 'count' || o.sort === 'level') ? o.sort : 'avg';
  const dir = o.dir === 'asc' ? 'asc' : 'desc';
  const minCount = Math.max(1, Number(o.minCount) || 1);
  const difficulty = DIFFS.indexOf(o.difficulty) >= 0 ? o.difficulty : 'all';

  // 一次聚合：song_id -> { count, sum }
  const agg = new Map();
  (ratings || []).forEach(r => {
    if (!r || r.song_id == null) return;
    let cur = agg.get(r.song_id);
    if (!cur) { cur = { count: 0, sum: 0 }; agg.set(r.song_id, cur); }
    cur.count += 1;
    cur.sum += Number(r.score) || 0;   // 非法值按 0 计，与 avgScore() 一致
  });

  const rows = [];
  (songs || []).forEach(song => {
    if (!song || song.id == null) return;
    const a = agg.get(song.id);
    if (!a || a.count === 0) return;                 // 零评分曲目不上榜
    if (a.count < minCount) return;                  // 低于阈值不上榜
    const diffs = Array.isArray(song.difficulties) ? song.difficulties : [];
    if (difficulty !== 'all' && !diffs.some(d => d && d.level === difficulty)) return;
    const md = mostDiffOf(song);
    rows.push({
      song: song, count: a.count, sum: a.sum, avg: a.sum / a.count,
      mostDiff: md, maxDiff: md                          // maxDiff 为同义别名（规格 2.3 / 5.1 用词差异）
    });
  });

  // 主键随方向；二级/三级键恒为「人数多者在前 / 定数高者在前 / id 小者在前」
  const dirMul = dir === 'asc' ? 1 : -1;
  const idAsc = (a, b) => {
    const x = String(a.song.id), y = String(b.song.id);
    return x < y ? -1 : (x > y ? 1 : 0);
  };
  rows.sort((a, b) => {
    let p;
    if (sort === 'count') p = cmpNum(a.count, b.count);
    else if (sort === 'level') p = cmpNum(Number(a.mostDiff.constant) || 0, Number(b.mostDiff.constant) || 0);
    else p = cmpNum(a.avg, b.avg);
    if (p !== 0) return dirMul * p;

    let s;
    if (sort === 'count') s = cmpNum(a.avg, b.avg);
    else if (sort === 'level') s = cmpNum(Number(a.mostDiff.rating) || 0, Number(b.mostDiff.rating) || 0);
    else s = cmpNum(a.count, b.count);
    if (s !== 0) return -s;                            // 二级键恒降序

    return idAsc(a, b);
  });

  return rows.map((r, i) => ({
    song: r.song, count: r.count, sum: r.sum, avg: r.avg,
    mostDiff: r.mostDiff, maxDiff: r.maxDiff, rank: i + 1
  }));
}

/* ---------------- 视图 ---------------- */

function $(sel) { return document.querySelector(sel); }

/** 把 state 上的榜单参数收敛成合法取值（state 缺字段时用默认值） */
function readOpts(state) {
  const st = state || {};
  return {
    sort: (st.rankSort === 'count' || st.rankSort === 'level') ? st.rankSort : 'avg',
    dir: st.rankDir === 'asc' ? 'asc' : 'desc',
    minCount: Math.max(1, Number(st.rankMin) || 1),
    difficulty: DIFFS.indexOf(st.rankDiff) >= 0 ? st.rankDiff : 'all'
  };
}

/** 视图：榜单页（#/rank） */
export function renderRank(state) {
  const main = $('#main');
  if (!main) return;
  const st = state || {};
  const o = readOpts(st);
  st.rankSort = o.sort; st.rankDir = o.dir; st.rankMin = o.minCount; st.rankDiff = o.difficulty;

  main.innerHTML =
    '<div class="rank-page">' +
      '<div class="rank-head">' +
        '<h1>榜单</h1>' +
        '<div class="rank-sub">按平均分 / 评分人数 / 难度定数给全站谱面排名，数据来自公开评分实时计算。</div>' +
      '</div>' +
      (isReadOnly()
        ? '<div class="need-login rank-readonly">只读演示模式：榜单用的是本地演示数据，打分与评论已关闭。</div>'
        : '') +
      '<section class="toolbar rank-toolbar">' +
        '<div class="dd-slot" id="ddRankSort"></div>' +
        '<button id="rankDir" type="button" class="btn sm">' + (o.dir === 'asc' ? '↑ 升序' : '↓ 降序') + '</button>' +
        '<div class="dd-slot" id="ddRankMin"></div>' +
        '<div class="dd-slot" id="ddRankDiff"></div>' +
        '<span id="rankCount" class="rank-count-tip"></span>' +
      '</section>' +
      '<div class="rank-list" id="rankList"></div>' +
    '</div>';

  /* 原生 select → 自定义下拉（组件来自 ui.js，与首页共用同一套实现）。
     id / value / change 三个接口与原生 select 一致，所以下面的绑定与 renderRankList 逻辑无需改动。 */
  mountDropdown('#ddRankSort', { id: 'rankSort', title: '排序维度',
    options: SORTS.map(s => ({ value: s.value, label: s.label })) });
  mountDropdown('#ddRankMin', { id: 'rankMin', title: '最少评分人数',
    options: MIN_OPTIONS.map(v => ({ value: v, label: '至少 ' + v + ' 人评分' })) });
  mountDropdown('#ddRankDiff', { id: 'rankDiff', title: '难度筛选',
    options: DIFFS.map(v => ({ value: v, label: (v === 'all' ? '全部难度' : v) })) });

  const sortSel = $('#rankSort');
  if (sortSel) sortSel.addEventListener('change', e => {
    st.rankSort = e.target.value;
    st.rankDir = 'desc';                                  // 三种维度的默认方向都是降序
    const dirBtn = $('#rankDir');
    if (dirBtn) dirBtn.textContent = '↓ 降序';
    renderRankList(st);
  });
  const dirBtn = $('#rankDir');
  if (dirBtn) dirBtn.addEventListener('click', () => {
    st.rankDir = (st.rankDir === 'asc' ? 'desc' : 'asc');
    dirBtn.textContent = st.rankDir === 'asc' ? '↑ 升序' : '↓ 降序';
    renderRankList(st);
  });
  const minSel = $('#rankMin');
  if (minSel) minSel.addEventListener('change', e => {
    st.rankMin = Math.max(1, Number(e.target.value) || 1);
    renderRankList(st);
  });
  const diffSel = $('#rankDiff');
  if (diffSel) diffSel.addEventListener('change', e => {
    st.rankDiff = e.target.value;
    renderRankList(st);
  });

  renderRankList(st);
}

/** 只重画榜单列表与统计（控件不动，避免丢失选择状态） */
function renderRankList(state) {
  const list = $('#rankList');
  if (!list) return;
  const o = readOpts(state);
  const songs = getSongs();
  const ratings = getRatings();
  const rows = rankRows(songs, ratings, o);

  const countEl = $('#rankCount');
  if (countEl) {
    /* 只有极少数曲目有分时（新站常见），说明"为什么就这么几首"，否则看着像坏了。
       阈值取「上榜不足 5 首」—— 到这个量级时读者更需要解释，而不是更多数字。 */
    const thin = rows.length > 0 && rows.length < 5
      ? '（当前只有 ' + rows.length + ' 首曲子有评分，给更多曲子打分后这里会更完整）'
      : '';
    countEl.textContent = '上榜 ' + rows.length + ' 首 · 共收到 ' + ratings.length + ' 条评分' + thin;
  }

  if (!rows.length) {
    list.innerHTML = '<div class="empty" id="rankEmpty">' + escapeHtml(EMPTY_TEXT) + '</div>';
    return;
  }

  /* 卡片式（用户 2026-10 裁定）：曲绘在卡片顶部，排名号压在曲绘左上角，数据在下方。
     结构 = .rank-row > .rank-no + .rank-cover + .rank-main + .rank-diff + .rank-score，
     样式见 layout.css「榜单卡片」段（flex-direction: column + aspect-ratio 1/1 的曲绘）。 */
  list.innerHTML = rows.map(r => {
    const s = r.song;
    const cv = s.cover || ['#1a1433', '#a892ff'];
    const md = r.mostDiff || { level: '', rating: '', constant: 0 };
    const diffText = md.level
      ? (md.level + ' ' + md.rating + ' · 定数 ' + Number(md.constant).toFixed(1))
      : '—';
    return '<div class="rank-row" data-id="' + escapeHtml(s.id) + '" data-rank="' + r.rank + '">' +
        '<span class="rank-no">' + r.rank + '</span>' +
        '<span class="rank-cover" style="background:linear-gradient(135deg,' + cv[0] + ',' + cv[1] + ')">' +
          coverImg(s) +
        '</span>' +
        '<div class="rank-main">' +
          '<a class="rank-title" href="#/song/' + escapeHtml(s.id) + '">' + escapeHtml(s.title) + '</a>' +
          '<div class="rank-meta">' + escapeHtml(s.artist || '') +
            (s.chapter ? ' · ' + escapeHtml(s.chapter) : '') + '</div>' +
        '</div>' +
        '<span class="rank-diff">' + escapeHtml(diffText) + '</span>' +
        '<span class="rank-score">' +
          '<span class="score-stars" title="平均分 ' + escapeHtml(r.avg.toFixed(1)) + '">' + stars(r.avg, 10) + '</span>' +
          '<span class="rank-avg">' + escapeHtml(r.avg.toFixed(1)) + '</span>' +
          '<span class="rank-count">' + r.count + '</span>' +
        '</span>' +
      '</div>';
  }).join('');
}
