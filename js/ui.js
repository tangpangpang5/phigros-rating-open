/* =========================================================
 * js/ui.js —— 全部界面渲染与交互
 * 页头 / 首页 / 谱面详情 / 个人主页 / 登录注册弹窗 / 主题 / 设置
 * ========================================================= */

import { BEC, reportError, reportNotice } from './config.js';
import {
  SORT_DIR_DEFAULT, getSongs, getSong, maxLevel, coverImg, filteredSongs, buildPackOptions
} from './songs.js';
import {
  isReadOnly, getRatings, getComments, getRatingsFor, ratingCount, avgScore, myRating,
  myRatingCount, myCommentCount, getCommentsFor, getProfile, profileName,
  setRating, addComment, deleteComment,
  myFeedback, submitFeedback, FEEDBACK_CATEGORIES, FEEDBACK_MIN, FEEDBACK_MAX, charLen
} from './storage.js';
import {
  currentUser, isAdmin, signIn, signUp, signOutUser, resendConfirm, sendReset
} from './auth.js';
import { renderRank } from './rank.js';
import { renderAdmin } from './admin.js';

/* ---------------- 工具 ---------------- */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

/* 站点版本号：取任意一个带 ?v= 的本地资源上的串（index.html 里 6 处同值）。
   ⚠️ 之所以不写常量：那 6 处是发版时唯一会改的版本来源，从这里读保证不会脱节。 */
function siteVersion() {
  try {
    const els = document.querySelectorAll('link[href*="?v="], script[src*="?v="]');
    for (const el of els) {
      const u = el.getAttribute('href') || el.getAttribute('src') || '';
      const m = /[?&]v=([0-9A-Za-z._-]+)/.exec(u);
      if (m) return m[1];
    }
  } catch (e) { /* 忽略 */ }
  return '?';
}

export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------------- 自定义下拉（替代原生 <select>） ----------------
   为什么不用原生 select：安卓自带的选择控件很简陋、各浏览器长相不一，跟本站的现代/简约主题脱节
   （用户反馈，选难度时最明显）。这一套**首页工具栏与榜单页共用**，不要三处各写一遍。

   ⚠️ 兼容性（关键设计）：包装元素沿用原来的 id，并实现与原生 select 相同的接口 ——
      ① `el.value` 可读可写；② 选中后向上冒泡一个 `change` 事件。
   所以既有业务代码（`$('#sortSelect').addEventListener('change', e => e.target.value)`）与既有
   用例（`el.value='x'; el.dispatchEvent(new Event('change'))`）都无需改动，行为完全等价。

   结构：
     <div class="dd" id="sortSelect" data-value="new">
       <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false">
         <span class="dd-label">最新收录</span><span class="dd-caret" aria-hidden="true">▾</span>
       </button>
       <ul class="dd-menu" role="listbox" hidden>
         <li class="dd-opt" role="option" data-value="new" aria-selected="true">最新收录</li>…
       </ul>
     </div>

   交互：点击 / Enter / Space 展开；↑↓、Home/End 移动高亮（aria-activedescendant）；
        Enter 选中并关闭；Esc 或点外部关闭；Tab 关闭；同时只允许展开一个。
   ⚠️ 状态色（高亮/选中）一律用**固定色**，不得使用随主题或强调色翻转的变量 ——
        同类错误在导航栏 `nav a.active` 与设置面板 `.set-opt` 上各犯过一次（见 layout.css 注释）。 */
const DD_OPEN = new Set();

export function createDropdown(cfg) {
  const c = cfg || {};
  const options = (c.options || []).map(o => ({ value: String(o.value), label: String(o.label == null ? o.value : o.label) }));
  const dd = document.createElement('div');
  dd.className = 'dd' + (c.className ? ' ' + c.className : '');
  if (c.id) dd.id = c.id;
  const optId = (c.id || 'dd') + '-o';
  dd.innerHTML =
    '<button type="button" class="dd-btn"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') +
      ' aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="dd-label"></span><span class="dd-caret" aria-hidden="true">▾</span>' +
    '</button>' +
    '<ul class="dd-menu" role="listbox"' + (c.title ? ' aria-label="' + escapeHtml(c.title) + '"' : '') + ' hidden>' +
      options.map((o, i) => '<li class="dd-opt" role="option" id="' + optId + i + '" data-value="' + escapeHtml(o.value) +
        '" aria-selected="false">' + escapeHtml(o.label) + '</li>').join('') +
    '</ul>';

  const btn = dd.querySelector('.dd-btn');
  const menu = dd.querySelector('.dd-menu');
  const label = dd.querySelector('.dd-label');
  const list = () => [...menu.querySelectorAll('.dd-opt')];
  let value = options.length ? options[0].value : '';
  let hi = 0;

  const labelOf = v => { const o = options.find(x => x.value === v); return o ? o.label : v; };
  const sync = () => {
    label.textContent = labelOf(value);
    dd.dataset.value = value;
    list().forEach(li => {
      const on = li.dataset.value === value;
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      li.setAttribute('data-selected', on ? 'true' : 'false');
      li.classList.toggle('is-on', on);
    });
  };
  const setHi = i => {
    const ls = list();
    if (!ls.length) return;
    hi = Math.max(0, Math.min(ls.length - 1, i));
    ls.forEach((li, k) => li.classList.toggle('is-hi', k === hi));
    btn.setAttribute('aria-activedescendant', ls[hi].id);
    if (ls[hi].scrollIntoView) ls[hi].scrollIntoView({ block: 'nearest' });
  };
  const onDocDown = e => { if (!dd.contains(e.target)) close(); };
  const onDocKey = e => { if (e.key === 'Escape') { e.preventDefault(); close(true); } };
  const open = () => {
    [...DD_OPEN].forEach(other => { if (other !== dd && other._ddClose) other._ddClose(); });
    menu.hidden = false;
    dd.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    /* 靠近右边缘时把面板改成右对齐，避免小屏上最后一个控件把面板顶出视口 */
    const r = menu.getBoundingClientRect();
    dd.classList.toggle('is-flip', r.right > window.innerWidth - 8);
    DD_OPEN.add(dd);
    const ls = list();
    setHi(Math.max(0, ls.findIndex(li => li.dataset.value === value)));
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  };
  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    dd.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-activedescendant');
    DD_OPEN.delete(dd);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    if (refocus) { try { btn.focus(); } catch (e) { /* 忽略 */ } }
  }
  const pick = (v, fire) => {
    const ls = list();
    const next = ls.some(li => li.dataset.value === v) ? String(v) : value;
    const changed = next !== value;
    value = next;
    sync();
    close(true);
    if (fire && changed) {
      dd.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof c.onChange === 'function') c.onChange(value);
    }
  };
  const move = step => { const ls = list(); if (ls.length) setHi((hi + step + ls.length) % ls.length); };

  btn.addEventListener('click', e => { e.preventDefault(); menu.hidden ? open() : close(); });
  btn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (menu.hidden) open(); else pick(list()[hi].dataset.value, true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (menu.hidden) open(); else move(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Home' || e.key === 'End') { if (!menu.hidden) { e.preventDefault(); setHi(e.key === 'Home' ? 0 : list().length - 1); } return; }
    if (e.key === 'Tab') close();
  });
  /* 选项用 mousedown 直接选（避免 body 上的关闭监听先一步关掉菜单） */
  menu.addEventListener('mousedown', e => { const li = e.target.closest ? e.target.closest('.dd-opt') : null; if (li) { e.preventDefault(); pick(li.dataset.value, true); } });

  dd._ddClose = () => close();
  dd._ddSet = v => { value = String(v); sync(); };        // 静默同步（初始化/外部刷新用）
  Object.defineProperty(dd, 'value', {
    get: () => value,
    set: v => { value = String(v); sync(); }               // 与原生 select 一致：赋值不触发 change
  });
  sync();
  return dd;
}

/* 把模板里的 .dd-slot 占位替换成自定义下拉（返回实例，便于再读 value）。
   rank.js 也用它，保证首页与榜单页共用同一套控件实现。 */
export function mountDropdown(slotSel, cfg) {
  const slot = $(slotSel);
  if (!slot) return null;
  const dd = createDropdown(cfg);
  slot.replaceWith(dd);
  return dd;
}

/* 曲包清单：songs.js 的 buildPackOptions() 给的是 <option> 字符串（该文件不在本轮改动范围），
   这里用一个游离 <select> 解析成 {value,label}，避免再维护一份曲包列表。 */
function packOptionList() {
  const tmp = document.createElement('select');
  tmp.innerHTML = buildPackOptions(escapeHtml);
  return [{ value: 'all', label: '全部曲包' }].concat(
    Array.from(tmp.options).map(o => ({ value: o.value, label: o.textContent })));
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const diff = Date.now() - Number(ts);
  const min = 60000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
  const pad = n => (n < 10 ? '0' + n : n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function stars(score, max) {
  const full = Math.round(score || 0);
  let out = '';
  for (let i = 1; i <= max; i++) out += '<i class="star-ico ' + (i <= full ? 'on' : '') + '">★</i>';
  return out;
}

function avatarOf(userId) {
  const p = getProfile(userId);
  return {
    color: (p && p.avatar_color) || '#6c5ce7',
    name: p ? (p.nickname || p.username || '匿名') : '已注销用户',
    isAdmin: !!(p && p.is_admin),
    exists: !!p
  };
}

/* ---------------- 应用状态 ---------------- */
const state = {
  view: 'home',
  chartId: null,
  query: '',
  pack: 'all',
  difficulty: 'all',
  sort: 'new',
  dir: 'desc',
  activeDiff: null,
  /* 评论列表的难度筛选（'全部' 或 EZ/HD/IN/AT）。与 activeDiff 分开：
     activeDiff 决定"你在看哪张谱面"（影响评分），这个只筛评论列表。 */
  commentDiff: '全部',
  authTab: 'login',
  /* 反馈弹窗：当前选中的分类（提交后保留，方便连续反馈同一类问题） */
  feedbackCat: 'bug',
  /* 榜单页参数（见 js/rank.js） */
  rankSort: 'avg',
  rankDir: 'desc',
  rankMin: 1,
  rankDiff: 'all',
  /* 管理后台的筛选关键词（见 js/admin.js） */
  adminCommentQuery: '',
  adminCommentUser: '',
  adminUserQuery: ''
};

/* ---------------- Toast ---------------- */
let toastTimer = null;
export function toast(msg, type) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = msg;
  box.className = 'toast ' + (type || '');
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}

/* ---------------- 路由 ---------------- */
export function router() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/song\/([\w-]+)/);
  if (m && getSong(m[1])) {
    /* 换到**另一首**曲子时把评论难度筛选重置回「全部」（2026-10 选定）。
       只判 id 变化：同一首曲子内切难度页签不该把筛选也清掉。
       不清掉的后果很具体：上一首选了「EZ」，点进一首没有 EZ 评论的曲子就是空列表，
       看起来像坏了。 */
    if (state.chartId !== m[1]) state.commentDiff = '全部';
    state.view = 'chart'; state.chartId = m[1];
  } else if (hash.startsWith('#/profile')) {
    state.view = 'profile';
  } else if (hash.startsWith('#/rank')) {
    state.view = 'rank';
  } else if (hash.startsWith('#/admin')) {
    state.view = 'admin';
  } else {
    state.view = 'home';
  }
  render();
}

export function render() {
  renderHeader();
  if (state.view === 'chart') renderChart();
  else if (state.view === 'profile') renderProfile();
  else if (state.view === 'rank') renderRank(state);
  else if (state.view === 'admin') renderAdmin(state);
  else renderHome();
}

/* ---------------- 页头 ---------------- */
function renderHeader() {
  const nav = $('#navLinks');
  if (!nav) return;
  const active = state.view;
  nav.innerHTML =
    '<a href="#/" class="' + (active === 'home' ? 'active' : '') + '">谱面库</a>' +
    '<a href="#/rank" class="' + (active === 'rank' ? 'active' : '') + '">榜单</a>' +
    (currentUser() ? '<a href="#/profile" class="' + (active === 'profile' ? 'active' : '') + '">我的主页</a>' : '') +
    (isAdmin() ? '<a href="#/admin" class="' + (active === 'admin' ? 'active' : '') + '">后台</a>' : '') +
    /* 反馈入口：**不用 hash 路由**（#/xxx 会重建 #main，弹窗跟着被销毁）——
       这里用按钮直接开静态弹窗（与登录弹窗同一套 .modal 机制）。未登录点击时先走登录。 */
    '<button type="button" class="nav-feedback" id="navFeedback">' +
      '<span class="nav-ico" aria-hidden="true">✉</span>反馈</button>';

  const fbBtn = $('#navFeedback');
  if (fbBtn) fbBtn.addEventListener('click', openFeedback);

  const userArea = $('#userArea');
  const u = currentUser();
  if (u) {
    userArea.innerHTML =
      '<div class="user-chip" title="点击进入个人主页" onclick="location.hash=\'#/profile\'">' +
        '<span class="avatar" style="background:' + escapeHtml(u.avatar_color || '#6c5ce7') + '">' +
          escapeHtml((u.nickname || '?').charAt(0).toUpperCase()) + '</span>' +
        '<span class="user-name">' + escapeHtml(u.nickname) + '</span>' +
      '</div>' +
      '<button class="btn ghost" id="logoutBtn">退出</button>';
    $('#logoutBtn').addEventListener('click', async () => {
      try { await signOutUser(); } catch (e) { /* 忽略 */ }
      toast('已退出登录');
      router();
    });
  } else {
    const dis = isReadOnly() ? ' disabled title="只读演示模式：未连接后端，暂不能登录"' : '';
    userArea.innerHTML =
      '<button class="btn ghost" id="loginBtn"' + dis + '>登录</button>' +
      '<button class="btn primary" id="registerBtn"' + dis + '>注册</button>';
    if (!isReadOnly()) {
      $('#loginBtn').addEventListener('click', () => openAuth('login'));
      $('#registerBtn').addEventListener('click', () => openAuth('register'));
    }
  }
}

/* ---------------- 首页 ---------------- */
/* 排序方向按钮：只在**方向真的有意义**时才出现。
   「最新收录」是按加入时间排的，没有升降序之分 —— 旧版此时把按钮变成 disabled 的「固定」，
   于是工具栏里多出一个不能点、又和排序下拉挤在一起的按钮（2026-10 报：
   「固定和排序占用同一个交互按钮，导致我在主界面没有办法排序」）。
   现在直接隐藏：少一个假控件，排序下拉自己独占位置。 */
function updateDirBtn() {
  const b = $('#dirBtn');
  if (!b) return;
  if (state.sort === 'new') {
    b.hidden = true;
    b.setAttribute('aria-hidden', 'true');
    b.removeAttribute('title');
    return;
  }
  b.hidden = false;
  b.removeAttribute('aria-hidden');
  b.textContent = state.dir === 'asc' ? '↑ 升序' : '↓ 降序';
  b.setAttribute('title', state.dir === 'asc' ? '当前：升序（点一下变降序）' : '当前：降序（点一下变升序）');
}

function renderHome() {
  const main = $('#main');
  const SONGS = getSongs();
  const ratings = getRatings();
  const comments = getComments();
  const rated = new Set(ratings.map(r => r.song_id)).size;

  main.innerHTML =
    '<section class="hero">' +
      '<div class="hero-inner">' +
        /* 曲库数据版本胶囊（只首页可见）。⚠️ 刻意**不复用** .hero-badge：
           minimal.css 里有 `.hero-badge { display: none; }`，复用会让它在「简约」风格下直接消失。
           .hero-badges 是 flex + wrap 容器 ⇒ 窄屏两个胶囊自动换行，不产生横向溢出。 */
        '<div class="hero-badges">' +
          '<div class="hero-badge">玩家自制</div>' +
          '<div class="hero-ver" title="曲库数据版本">曲库数据已更新至 3.19.0，热更新曲目尚未收录</div>' +
          /* 站点版本号（2026-10-01：「以后把网站的版本号标到主页方便我检查」）。
             ⚠️ 不新增版本常量：直接从本站样式表链接的 ?v= 上读 —— 那 6 处在发版时本来就会一起改，
                所以这里永远和实际部署版本一致，不会出现"两处版本号对不上"。
             读不到时显示 '?'，不猜。 */
          '<div class="hero-site" title="站点版本（与样式表缓存串同源）">站点 v' + siteVersion() + '</div>' +
        '</div>' +
        '<h1>Phigros 谱面打分站</h1>' +
        '<p>收录 Phigros 现在的全部谱面。随便逛逛，给玩过的谱子打个分，留几句真实感受。</p>' +
        '<div class="hero-stats">' +
          '<div class="stat"><b>' + SONGS.length + '</b><span>收录曲目</span></div>' +
          '<div class="stat"><b>' + ratings.length + '</b><span>收到评分</span></div>' +
          '<div class="stat"><b>' + comments.length + '</b><span>收到评论</span></div>' +
          '<div class="stat"><b>' + rated + '</b><span>被评过的曲目</span></div>' +
        '</div>' +
      '</div>' +
    '</section>' +

    '<section class="toolbar">' +
      '<div class="search-box">' +
        '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9.5 3a6.5 6.5 0 1 0 3.9 11.6l4.5 4.5 1.4-1.4-4.5-4.5A6.5 6.5 0 0 0 9.5 3zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/></svg>' +
        '<input id="searchInput" type="text" placeholder="搜曲名、曲师或章节…" value="' + escapeHtml(state.query) + '" />' +
      '</div>' +
      '<div class="dd-slot" id="ddPack"></div>' +
      '<div class="dd-slot" id="ddDiff"></div>' +
      '<div class="dd-slot" id="ddSort"></div>' +
      '<button id="dirBtn" type="button" class="btn sm">↓ 降序</button>' +
    '</section>' +

    '<section class="grid" id="songGrid"></section>' +
    '<div class="empty" id="empty" style="display:none">没搜到。换个关键词，或者换个曲包试试？</div>';

  /* 原生 select → 自定义下拉（id / value / change 三个接口保持不变，下面的绑定代码无需改） */
  mountDropdown('#ddPack', { id: 'packSelect', className: 'dd-pack', title: '曲包', options: packOptionList() });
  mountDropdown('#ddDiff', { id: 'diffSelect', title: '难度', options: [
    { value: 'all', label: '全部难度' }, { value: 'EZ', label: 'EZ' }, { value: 'HD', label: 'HD' },
    { value: 'IN', label: 'IN' }, { value: 'AT', label: 'AT' }
  ] });
  mountDropdown('#ddSort', { id: 'sortSelect', title: '排序', options: [
    { value: 'new', label: '最新收录' }, { value: 'rating', label: '评分' }, { value: 'ratingCount', label: '评分数量' },
    { value: 'level', label: '难度' }, { value: 'name', label: '名称' }
  ] });

  $('#packSelect').value = state.pack;
  $('#diffSelect').value = state.difficulty;
  $('#sortSelect').value = state.sort;
  updateDirBtn();

  $('#searchInput').addEventListener('input', e => { state.query = e.target.value; renderGrid(); });
  $('#packSelect').addEventListener('change', e => { state.pack = e.target.value; renderGrid(); });
  $('#diffSelect').addEventListener('change', e => { state.difficulty = e.target.value; renderGrid(); });
  $('#sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    state.dir = SORT_DIR_DEFAULT[state.sort] || 'desc';
    updateDirBtn();
    renderGrid();
  });
  $('#dirBtn').addEventListener('click', () => {
    /* 不必再判断 sort==='new'：那个状态下按钮是 hidden 的，点不到 */
    state.dir = state.dir === 'desc' ? 'asc' : 'desc';
    updateDirBtn();
    renderGrid();
  });

  renderGrid();
}

function renderGrid() {
  const list = filteredSongs(state, { avgScore, ratingCount });
  const grid = $('#songGrid');
  const empty = $('#empty');
  if (!list.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = list.map(song => {
    const a = avgScore(song.id);
    const n = ratingCount(song.id);
    const badges = song.difficulties.map(d => {
      const cls = { EZ: 'ez', HD: 'hd', IN: 'in', AT: 'at', Legacy: 'legacy' }[d.level] || 'in';
      return '<span class="diff-badge ' + cls + '">' + escapeHtml(d.level) + ' ' + escapeHtml(d.rating) + '</span>';
    }).join('');
    const cover = song.cover || ['#1a1433', '#a892ff'];
    return '<a class="card" href="#/song/' + escapeHtml(song.id) + '">' +
      '<div class="card-cover" style="background:linear-gradient(135deg,' + cover[0] + ',' + cover[1] + ')">' +
        coverImg(song) +
        (song.isNew ? '<span class="new-badge">NEW</span>' : '') +
        (song.bpm ? '<span class="card-bpm">BPM ' + escapeHtml(song.bpm) + '</span>' : '') +
        '<span class="card-title-overlay">' + escapeHtml(song.title) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<div class="card-title-row">' +
          '<h3 class="card-title">' + escapeHtml(song.title) + '</h3>' +
          '<span class="card-cat" title="' + escapeHtml(song.chapter) + '">' + escapeHtml(song.chapter) + '</span>' +
        '</div>' +
        '<div class="card-meta">曲师 · ' + escapeHtml(song.artist) + '</div>' +
        '<div class="card-meta dim">谱师 · ' + (song.charter ? escapeHtml(song.charter) : '—') + '</div>' +
        '<div class="card-badges">' + badges + '</div>' +
        '<div class="card-footer">' +
          '<span class="score-stars">' + stars(a, 10) + '</span>' +
          '<span class="score-val">' + (a ? a.toFixed(1) : '—') + '</span>' +
          '<span class="score-count">(' + n + ' 人打分)</span>' +
        '</div>' +
      '</div>' +
    '</a>';
  }).join('');
}

/* ---------------- 谱面详情 ---------------- */
function buildDistribution(rs) {
  const counts = new Array(10).fill(0);
  rs.forEach(r => { if (r.score >= 1 && r.score <= 10) counts[r.score - 1]++; });
  const total = rs.length;
  return counts.map((count, i) => ({
    score: i + 1, count, pct: total ? Math.round(count / total * 100) : 0
  })).reverse();
}

function renderChart() {
  const song = getSong(state.chartId);
  const main = $('#main');
  if (!song) { location.hash = '#/'; return; }
  const a = avgScore(song.id);
  const rs = getRatingsFor(song.id);
  const cmts = getCommentsFor(song.id);
  const readOnly = isReadOnly();
  const me = currentUser();

  if (!state.activeDiff || !song.difficulties.some(d => d.level === state.activeDiff)) {
    state.activeDiff = song.difficulties.some(d => d.level === 'IN')
      ? 'IN' : song.difficulties[song.difficulties.length - 1].level;
  }
  const diff = song.difficulties.find(d => d.level === state.activeDiff);
  const my = myRating(song.id);
  const dist = buildDistribution(rs);
  const cover = song.cover || ['#1a1433', '#a892ff'];

  const ratingBlock = readOnly
    ? '<div class="need-login">只读演示模式：未连接 Supabase，打分功能已关闭。</div>'
    : (me
      ? '<div class="star-picker" id="starPicker">' +
          Array.from({ length: 10 }, (_, i) =>
            '<button class="star ' + (my && i < my.score ? 'on' : '') + '" data-score="' + (i + 1) + '">★</button>').join('') +
        '</div>' +
        '<div class="my-rating-hint" id="ratingHint">' +
          (my ? '现在给的是 ' + my.score + ' / 10，点别的星星随时能改' : '点星星给这首打个分（1-10 分）') +
        '</div>'
      : '<div class="need-login">想打分的话先登录 ' +
        '<button class="btn primary sm" id="detailLoginBtn">去登录</button></div>');

  const commentBox = readOnly
    ? '<div class="need-login">只读演示模式：评论功能已关闭。</div>'
    : (me
      ? '<textarea id="commentInput" rows="3" maxlength="500" placeholder="打完一把有什么想说的？（500 字以内）"></textarea>' +
        '<div class="comment-actions"><button class="btn primary" id="submitComment">发表评论</button></div>'
      : '<div class="need-login">想说话也得先登录 ' +
        '<button class="btn primary sm" id="detailLoginBtn2">去登录</button></div>');

  main.innerHTML =
    '<div class="detail">' +
      '<a class="back" href="#/">← 返回谱面库</a>' +
      '<div class="detail-head">' +
        '<div class="detail-cover" style="background:linear-gradient(135deg,' + cover[0] + ',' + cover[1] + ')">' +
          coverImg(song) +
          '<span class="detail-cover-title">' + escapeHtml(song.title) + '</span>' +
        '</div>' +
        '<div class="detail-info">' +
          (song.isNew ? '<span class="new-badge">NEW</span>' : '') +
          '<h1>' + escapeHtml(song.title) + '</h1>' +
          '<div class="detail-meta">' +
            '<div><span class="k">曲师</span><span class="v">' + escapeHtml(song.artist) + '</span></div>' +
            '<div><span class="k">谱师</span><span class="v">' + (song.charter ? escapeHtml(song.charter) : '—') + '</span></div>' +
            '<div><span class="k">章节</span><span class="v">' + escapeHtml(song.chapter) + '</span></div>' +
            (song.bpm ? '<div><span class="k">BPM</span><span class="v">' + escapeHtml(song.bpm) + '</span></div>' : '') +
            (song.version ? '<div><span class="k">收录版本</span><span class="v">v' + escapeHtml(song.version) + '</span></div>' : '') +
          '</div>' +
          (song.note ? '<div class="detail-note">' + escapeHtml(song.note) + '</div>' : '') +
          '<div class="diff-tabs">' +
            song.difficulties.map(d =>
              '<button class="diff-tab ' + String(d.level).toLowerCase() + ' ' + (d.level === state.activeDiff ? 'active' : '') +
              '" data-level="' + escapeHtml(d.level) + '">' + escapeHtml(d.level) +
              '<span>' + escapeHtml(d.rating) + '</span></button>').join('') +
          '</div>' +
          '<div class="diff-const">定数 <b>' + Number(diff.constant).toFixed(1) + '</b><span> · 等级 ' + escapeHtml(diff.rating) + '</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="detail-cols">' +
        '<div class="col rating-col">' +
          '<h2>评分</h2>' +
          '<div class="big-score">' +
            '<div class="big-num">' + (a ? a.toFixed(1) : '—') + '</div>' +
            '<div class="big-stars">' + stars(a, 10) + '</div>' +
            '<div class="big-count">' + rs.length + ' 人打了分</div>' +
          '</div>' +
          '<div class="dist">' +
            dist.map(d =>
              '<div class="dist-row">' +
                '<span class="dist-label">' + d.score + '分</span>' +
                '<div class="dist-bar"><div class="dist-fill" style="width:' + d.pct + '%"></div></div>' +
                '<span class="dist-count">' + d.count + '</span>' +
              '</div>').join('') +
          '</div>' +
          '<h2 class="mt">我的评价</h2>' +
          '<div class="my-rating">' + ratingBlock + '</div>' +
        '</div>' +

        '<div class="col comment-col">' +
          /* 「评论」旁边这个难度筛选（2026-10 要求：全部 / EZ / HD / IN / AT）
             ⚠️ 它和上面谱面区的 .diff-tab **是两件事**：
               · .diff-tab 选的是「你在看哪张谱面」——影响评分与难度信息；
               · 这个 .cmt-diff 只筛「评论列表里显示哪几条」，不动评分。
             当时的诉求是切难度时评分与评论筛选**分开**，所以这里做成独立控件。
             ⚠️ 2026-10 修正：选项从「固定五个」改为**按这首曲子实际有的难度给**
             （使用反馈：一部分谱面没有 AT，但评论却能选 AT）。谱面区本来就是按
             song.difficulties 生成的，这里跟它对齐即可 —— 于是没有 AT 的谱面也就不再有 AT 选项。 */
          '<h2>评论 <span class="count-tag">' + cmts.length + '</span>' +
            '<span class="cmt-diff" role="group" aria-label="按难度筛选评论">' +
              ['全部'].concat(song.difficulties.map(d => d.level)).map(lv =>
                '<button type="button" class="cmt-diff-btn' + (lv === state.commentDiff ? ' is-on' : '') +
                '" data-level="' + lv + '" aria-pressed="' + (lv === state.commentDiff) + '">' + lv + '</button>'
              ).join('') +
            '</span>' +
          '</h2>' +
          '<div class="comment-box">' + commentBox + '</div>' +
          '<div class="comments" id="commentList">' + renderCommentsFor(cmts) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* 评论筛选：只重画评论列表（不整页重渲染），免得把输入框里没发出去的字冲掉 */
  $$('.cmt-diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.commentDiff = btn.dataset.level;
      $$('.cmt-diff-btn').forEach(b => {
        const on = b.dataset.level === state.commentDiff;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const box = $('#commentList');
      if (box) box.innerHTML = renderCommentsFor(cmts);
    });
  });

  $$('.diff-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeDiff = btn.dataset.level;
      renderChart();
      window.scrollTo({ top: 0 });
    });
  });

  const picker = $('#starPicker');
  if (picker) {
    $$('#starPicker .star').forEach(btn => {
      btn.addEventListener('mouseenter', () => highlightStars(btn.dataset.score));
      btn.addEventListener('click', async () => {
        const s = parseInt(btn.dataset.score, 10);
        try { await setRating(song.id, s); toast('打分已记录：' + s + ' / 10'); renderChart(); }
        catch (e) { toast(e.message || '打分失败', 'error'); }
      });
    });
    picker.addEventListener('mouseleave', () => {
      const m2 = myRating(song.id);
      highlightStars(m2 ? m2.score : 0);
    });
  }

  const submit = $('#submitComment');
  if (submit) {
    submit.addEventListener('click', async () => {
      const t = $('#commentInput');
      submit.disabled = true;
      try {
        await addComment(song.id, t.value, state.activeDiff);
        toast('评论已发出');
        renderChart();
      } catch (e) {
        toast(e.message || '评论失败', 'error');
        submit.disabled = false;
      }
    });
  }
  $$('.comment-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除这条评论？')) return;
      try { await deleteComment(btn.dataset.id); toast('已删除'); renderChart(); }
      catch (e) { toast(e.message || '删除失败', 'error'); }
    });
  });

  const dl = $('#detailLoginBtn'); if (dl) dl.addEventListener('click', () => openAuth('login'));
  const dl2 = $('#detailLoginBtn2'); if (dl2) dl2.addEventListener('click', () => openAuth('login'));
}

/* 按当前筛选条件挑出要显示的评论，再交给 renderComments 画。
   筛选是纯客户端过滤（评论最多几百条，不为此加查询参数）。
   「全部」不过滤；选了某个难度时，只显示**自己记录了该难度**的评论 ——
   历史评论（difficulty 为 null）在任何一个具体难度下都不出现，这是对的：
   它们本来就没说自己评的是哪张谱面，塞进 EZ 里才是编造。 */
function renderCommentsFor(cmts) {
  const f = state.commentDiff;
  const list = (f && f !== '全部') ? cmts.filter(c => c.difficulty === f) : cmts;
  return renderComments(list);
}

function renderComments(cmts) {
  if (!cmts.length) return '<div class="empty dim">还没人说话，要不你来开个头？</div>';
  const me = currentUser();
  const admin = isAdmin();
  /* 难度徽标来自**这条评论自己**的 difficulty 字段（发表时固化下来的那张谱面）。
     2026-10 修正：此前这里收的是「页面当前选中的难度」参数，于是切难度时**所有**评论的
     徽标一起变 —— 那是「评论表还没有难度字段」时代的权宜口径（当时代码里也如实标注了
     「并不能真正区分一条历史评论到底评的是哪张谱面」）。现在要求固化，故：
       · 有 difficulty ⇒ 显示它；
       · 没有（2026-10 之前的历史评论，或发表时未带）⇒ 不显示徽标，宁可不标也不编一个。
     只打标签、不按难度筛选列表：同一首曲子的各难度评论仍混在一起看（2026-10 选定）。 */
  return cmts.map(c => {
    const d = c.difficulty;
    const diffTag = (typeof d === 'string' && d)
      ? '<span class="comment-diff" title="这条评论评的是 ' + escapeHtml(d) + ' 难度">' + escapeHtml(d) + '</span>'
      : '';
    const info = avatarOf(c.user_id);
    const canDel = !!me && (c.user_id === me.id || admin);
    return '<div class="comment">' +
      '<span class="avatar sm" style="background:' + escapeHtml(info.color) + '">' +
        escapeHtml(info.name.charAt(0).toUpperCase()) + '</span>' +
      '<div class="comment-main">' +
        '<div class="comment-head">' +
          '<span class="comment-user">' + escapeHtml(info.name) +
            (info.isAdmin ? ' <span class="role-tag">管理员</span>' : '') + '</span>' +
          diffTag +
          '<span class="comment-time">' + formatTime(c.created_at) + '</span>' +
          (canDel ? '<button class="comment-del" data-id="' + escapeHtml(c.id) + '" title="删除">删除</button>' : '') +
        '</div>' +
        '<div class="comment-text">' + escapeHtml(c.text) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function highlightStars(n) {
  $$('#starPicker .star').forEach(b => b.classList.toggle('on', parseInt(b.dataset.score, 10) <= n));
}

/* ---------------- 个人主页 ---------------- */
function renderProfile() {
  const main = $('#main');
  const u = currentUser();
  if (!u) {
    main.innerHTML =
      '<div class="profile"><div class="need-login big">想看自己的主页？先登录' +
      (isReadOnly() ? '（当前为只读演示模式）' : ' <button class="btn primary" id="profileLoginBtn">去登录</button>') +
      '</div></div>';
    const b = $('#profileLoginBtn');
    if (b) b.addEventListener('click', () => openAuth('login'));
    return;
  }
  const p = getProfile(u.id);
  const myRs = getRatings()
    .filter(r => r.user_id === u.id)
    .sort((a, b) => (b.updated_at || b.created_at) - (a.created_at || 0));
  const myCs = getComments()
    .filter(c => c.user_id === u.id)
    .sort((a, b) => b.created_at - a.created_at);

  main.innerHTML =
    '<div class="profile">' +
      '<div class="profile-head">' +
        '<span class="avatar lg" style="background:' + escapeHtml(u.avatar_color || '#6c5ce7') + '">' +
          escapeHtml((u.nickname || '?').charAt(0).toUpperCase()) + '</span>' +
        '<div>' +
          '<h1>' + escapeHtml(u.nickname) + (u.is_admin ? ' <span class="role-tag">管理员</span>' : '') + '</h1>' +
          '<div class="profile-meta">' + escapeHtml(u.email) +
            (p && p.created_at ? ' · 加入于 ' + formatTime(p.created_at) : '') + '</div>' +
        '</div>' +
        '<div class="profile-stats">' +
          '<div><b>' + myRatingCount() + '</b><span>评分</span></div>' +
          '<div><b>' + myCommentCount() + '</b><span>评论</span></div>' +
        '</div>' +
      '</div>' +

      '<div class="profile-sections">' +
        '<section>' +
          '<h2>我的评分</h2>' +
          (myRs.length ? myRs.map(r => {
            const s = getSong(r.song_id);
            if (!s) return '';
            const cv = s.cover || ['#1a1433', '#a892ff'];
            return '<a class="profile-row" href="#/song/' + escapeHtml(s.id) + '">' +
              '<span class="mini-cover" style="background:linear-gradient(135deg,' + cv[0] + ',' + cv[1] + ')"></span>' +
              '<span class="p-title">' + escapeHtml(s.title) + '</span>' +
              '<span class="p-score">' + stars(r.score, 10) + ' <b>' + r.score + '</b>/10</span>' +
            '</a>';
          }).join('') : '<div class="empty dim">还没给谁打过卡，去谱面库挑一首？</div>') +
        '</section>' +
        '<section>' +
          '<h2>我的评论</h2>' +
          (myCs.length ? myCs.map(c => {
            const s = getSong(c.song_id);
            return '<div class="profile-comment">' +
              '<a class="p-link" href="#/song/' + escapeHtml(c.song_id) + '">' +
                (s ? escapeHtml(s.title) : '(未知谱面)') + '</a>' +
              '<div class="comment-text">' + escapeHtml(c.text) + '</div>' +
              '<div class="comment-time">' + formatTime(c.created_at) + '</div>' +
            '</div>';
          }).join('') : '<div class="empty dim">还一条评论都没写过。</div>') +
        '</section>' +
      '</div>' +
    '</div>';
}

/* ---------------- 登录 / 注册弹窗 ---------------- */
export function openAuth(tab) {
  if (isReadOnly()) { toast('只读演示模式：暂不能登录', 'error'); return; }
  state.authTab = tab || 'login';
  renderAuthModal();
  $('#authModal').classList.add('show');
}
function closeAuth() { $('#authModal').classList.remove('show'); }

function renderAuthModal() {
  const modal = $('#authModal');
  const isReg = state.authTab === 'register';
  modal.innerHTML =
    '<div class="modal-backdrop" id="authBackdrop"></div>' +
    '<div class="modal-card">' +
      '<button class="modal-close" id="authClose">×</button>' +
      '<div class="modal-logo">PHIGROS</div>' +
      '<div class="auth-tabs">' +
        '<button class="auth-tab ' + (!isReg ? 'active' : '') + '" data-tab="login">登录</button>' +
        '<button class="auth-tab ' + (isReg ? 'active' : '') + '" data-tab="register">注册</button>' +
      '</div>' +
      '<form id="authForm" autocomplete="on">' +
        (isReg
          ? '<div class="field"><label>昵称 <span class="opt">(选填)</span></label>' +
            '<input id="fNickname" type="text" placeholder="你的昵称" maxlength="20" /></div>'
          : '') +
        '<div class="field"><label>邮箱</label>' +
          '<input id="fEmail" type="email" placeholder="you@example.com" autocomplete="email" required /></div>' +
        '<div class="field"><label>密码</label>' +
          '<input id="fPassword" type="password" placeholder="' + (isReg ? '密码（至少 6 位）' : '密码') +
          '" autocomplete="' + (isReg ? 'new-password' : 'current-password') + '" required /></div>' +
        (isReg
          ? '<div class="field"><label>确认密码</label>' +
            '<input id="fPassword2" type="password" placeholder="再次输入密码" autocomplete="new-password" /></div>'
          : '') +
        '<div class="auth-error" id="authError"></div>' +
        '<button type="submit" class="btn primary block" id="authSubmit">' + (isReg ? '注册' : '登录') + '</button>' +
      '</form>' +
      (isReg
        ? '<div class="auth-tip">注册后需要到邮箱点一次确认链接，再用同一个邮箱登录。</div>'
        : '<div class="auth-tip">还没有账号？<a href="#" id="toRegister">去注册</a>' +
          ' · <a href="#" id="forgotLink">忘记密码</a></div>') +
    '</div>';

  $('#authBackdrop').addEventListener('click', closeAuth);
  $('#authClose').addEventListener('click', closeAuth);
  $$('.auth-tab').forEach(t => t.addEventListener('click', () => {
    state.authTab = t.dataset.tab;
    renderAuthModal();
    $('#authModal').classList.add('show');
  }));
  const toReg = $('#toRegister');
  if (toReg) toReg.addEventListener('click', e => { e.preventDefault(); openAuth('register'); });
  const forgot = $('#forgotLink');
  if (forgot) forgot.addEventListener('click', async e => {
    e.preventDefault();
    const mail = prompt('输入注册邮箱，我们会发一封重置密码的邮件：', $('#fEmail') ? $('#fEmail').value : '');
    if (!mail) return;
    try { await sendReset(mail); setAuthMsg('重置邮件已发送到 ' + mail + '，请查收（含垃圾箱）。', 'ok'); }
    catch (ex) { setAuthMsg(ex.message || '发送失败', 'err'); }
  });

  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#authError');
    err.textContent = '';
    err.className = 'auth-error';
    const email = $('#fEmail').value;
    const password = $('#fPassword').value;
    const nickname = $('#fNickname') ? $('#fNickname').value : '';
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      if (isReg) {
        if (password !== $('#fPassword2').value) throw new Error('两次输入的密码不一致');
        const r = await signUp(email, password, nickname);
        if (r.needsConfirm) {
          showConfirmHelp(r.email);
          return;
        }
        toast('注册成功，已自动登录');
      } else {
        await signIn(email, password);
        toast('登录成功，欢迎回来！');
      }
      closeAuth();
      router();
    } catch (ex) {
      const msg = ex.message || String(ex);
      if (/not confirmed/i.test(msg)) { showConfirmHelp(email, msg); return; }
      err.textContent = msg;
      err.className = 'auth-error show';
    } finally {
      btn.disabled = false;
    }
  });
}

function setAuthMsg(text, kind) {
  const err = $('#authError');
  if (!err) return;
  err.textContent = text;
  err.className = 'auth-error show' + (kind === 'ok' ? ' ok' : '');
}

/** 邮箱未确认时的友好提示 + 重发入口 */
function showConfirmHelp(email, extra) {
  const err = $('#authError');
  if (!err) return;
  err.className = 'auth-error show';
  err.innerHTML =
    '<b>邮箱还没确认。</b><br>' +
    '请到 <b>' + escapeHtml(email) + '</b> 收信并点确认链接，然后再登录。' +
    (extra ? '<br><span style="opacity:.7">（' + escapeHtml(extra) + '）</span>' : '') +
    '<br><button type="button" class="btn sm" id="resendBtn" style="margin-top:6px">重发验证邮件</button>';
  const b = $('#resendBtn');
  if (b) b.addEventListener('click', async () => {
    b.disabled = true;
    try { await resendConfirm(email); setAuthMsg('已重发到 ' + email + '，请查收（也看看垃圾箱）。', 'ok'); }
    catch (ex) { setAuthMsg(ex.message || '重发失败', 'err'); }
  });
}

/* ---------------- 风格 / 外观 / 设置 ---------------- */
const STYLES = ['modern', 'minimal'];
const STYLE_NAME = { modern: '现代', minimal: '简约' };
let STYLE_WANT = 'modern';        // 最近一次请求的风格：延迟关表时以它为准，避免快速连点时关错表

function getPref(key, legacyKey, def) {
  try { return localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey)) || def; }
  catch (e) { return def; }
}

export function setStyleCss(style) {
  if (!STYLES.includes(style)) style = 'modern';
  /* ⚠️ 顺序必须是「**先启用目标、再禁用其它**」。
     旧写法 `STYLES.forEach(k => el.disabled = (style !== k))`（STYLES=['modern','minimal']）切到「简约」时
     先把 modern 关掉、再把 minimal 打开 ⇒ 两句之间存在「两个主题样式表都 disabled」的一瞬间：
     实测启用数轨迹 = [0,1]，那一刻 .card 的 border-width 退化成 0px、body 背景变成透明 rgba(0,0,0,0)。
     先开后关能保证**任一时刻至少有一个主题样式表处于 enabled**（实测轨迹变成 [2,1]），
     结构上消除这个窗口。本函数是风格切换的唯一入口：头部 #styleBtn（cycleStyle）、
     设置面板的「风格」按钮、启动时 initUI 都调用它（index.html 的启动脚本也改成同样的顺序）。
     已知残留（不在本轮范围）：新启用的样式表会有约一帧「enabled 但规则尚未应用」的窗口，
     那一帧 body 背景为空 ⇒ 可能仍闪一下白。逐帧采样与两个备选方案的代价见 t27 报告。 */
  const target = document.getElementById('css-' + style);
  if (target && target.disabled) target.disabled = false;          // ① 先开目标（旧表暂不动）
  STYLES.forEach(k => {                                            // ② 再关其它
    if (k === style) return;
    const el = document.getElementById('css-' + k);
    if (el && !el.disabled) el.disabled = true;
  });
  try { localStorage.setItem('dsh_style', style); } catch (e) { /* 忽略 */ }
  const b = document.getElementById('styleBtn');
  if (b) {
    b.textContent = STYLE_NAME[style];
    b.title = '当前风格：' + STYLE_NAME[style] + '，点击切换到 ' + (style === 'modern' ? '简约' : '现代');
  }
}
/* ⚠️ 过渡动画的钩子只挂在这类**用户动作点**上（#styleBtn / #appBtn / 设置面板的两个按钮），
   **绝不挂进 setStyleCss() / applyAppearance() 本体** —— initUI() 启动时会调用那两个函数，
   挂进去会让「启动」与「路由切换」也误播动画（验收标准①要求那两处的播放次数 = 0）。
   index.html 的启动前置内联脚本绕过 setStyleCss 直接改 link.disabled，天然不经过钩子。 */
function cycleStyle() {
  requestStyle(getPref('dsh_style', 'phi_style', 'modern') === 'modern' ? 'minimal' : 'modern');
}

const APPS = [
  { key: 'light-red', mode: 'light', accent: 'red', label: '浅·红' },
  { key: 'light-blue', mode: 'light', accent: 'blue', label: '浅·蓝' },
  { key: 'dark-red', mode: 'dark', accent: 'red', label: '深·红' },
  { key: 'dark-blue', mode: 'dark', accent: 'blue', label: '深·蓝' }
];
export function applyAppearance(app) {
  document.body.classList.remove('mode-light', 'mode-dark', 'accent-red', 'accent-blue');
  document.body.classList.add('mode-' + app.mode, 'accent-' + app.accent);
  try { localStorage.setItem('dsh_app', app.key); } catch (e) { /* 忽略 */ }
  const b = document.getElementById('appBtn');
  if (b) b.textContent = app.label;
}
function cycleAppearance() {
  const cur = getPref('dsh_app', 'phi_appearance', 'light-red');
  const idx = APPS.findIndex(a => a.key === cur);
  const next = APPS[(idx + 1) % APPS.length];
  requestAppearance(next);
}

const SETTINGS_KEY = 'dsh_settings';
const SETTINGS_DEFS = [
  { key: 'sidebarCollapsed', label: '折叠侧栏', desc: '收起左侧栏为窄条', def: false },
  { key: 'stickyToolbar', label: '工具栏置顶', desc: '下滑时筛选/排序始终吸顶', def: true },
  { key: 'compactCards', label: '紧凑卡片', desc: '缩小卡片间距，一屏看更多', def: false }
];
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || localStorage.getItem('phi_settings') || '{}'); }
  catch (e) { settings = {}; }
  SETTINGS_DEFS.forEach(d => { if (settings[d.key] === undefined) settings[d.key] = d.def; });
  /* 「实验室」分组（不在 SETTINGS_DEFS 里，因为它在面板中单独成组）。
     ⚠️ 2026-10 已定改为**默认开**（原文：「动画现在没什么问题了，默认开启」）。
     注意这里只对「还没有存过这个键」的用户生效：已经手动关掉的人 localStorage 里是 false，
     会被保留，不会被这次改动强行打开。 */
  if (settings.transitionOn === undefined) settings.transitionOn = true;
  if (typeof settings.transitionOn !== 'boolean') settings.transitionOn = true;
  /* 早先为自动截图加的 `?animtest=1` 钩子已删除：默认就是开，钩子没有意义了，
     线上不该留任何"测试专用入口"。 */
}
function getSetting(k) { return settings[k]; }
function setSetting(k, v) {
  settings[k] = v;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
  applySettings();
}
function applySettings() {
  document.body.classList.toggle('sb-collapsed', !!settings.sidebarCollapsed);
  document.body.classList.toggle('no-sticky', !settings.stickyToolbar);
  document.body.classList.toggle('compact', !!settings.compactCards);
  const t = document.getElementById('sbToggle');
  if (t) t.textContent = settings.sidebarCollapsed ? '»' : '«';
}
function openSettings() {
  let m = document.getElementById('settingsModal');
  if (!m) { m = document.createElement('div'); m.id = 'settingsModal'; document.body.appendChild(m); }
  m.innerHTML =
    '<div class="set-backdrop" id="setBackdrop"></div>' +
    '<div class="set-card">' +
      '<div class="set-head"><span>设置</span><button id="setClose" type="button">×</button></div>' +
      /* 一行「当前：…」把状态**用文字**写出来：即使颜色/色觉/屏幕差异，也不会有歧义
         （外观选项里本来就有「浅·红/浅·蓝」，不能靠"深色填充"暗示选中）。 */
      '<div class="set-now" id="setNow"></div>' +
      /* 风格 / 外观：**必须在面板里也有入口** —— 窄屏（≤380px）顶部会隐藏 #styleBtn 等按钮，
         如果面板里没有这两个控件，用户就没有任何办法切换风格了（这是 t15 引入的可达性回归）。 */
      '<div class="set-row set-row-block">' +
        '<div class="set-info"><b>风格</b><span>现代（构成主义）/ 简约（Apple 风）</span></div>' +
        '<div class="set-opts" id="setStyleOpts">' +
          STYLES.map(s => '<button type="button" class="set-opt" data-style="' + s + '">' + STYLE_NAME[s] + '</button>').join('') +
        '</div>' +
      '</div>' +
      '<div class="set-row set-row-block">' +
        '<div class="set-info"><b>外观</b><span>深浅 × 红蓝，共 4 种组合</span></div>' +
        '<div class="set-opts" id="setAppOpts">' +
          APPS.map(a => '<button type="button" class="set-opt" data-app="' + a.key + '">' + a.label + '</button>').join('') +
        '</div>' +
      '</div>' +
      SETTINGS_DEFS.map(d =>
        '<div class="set-row">' +
          '<div class="set-info"><b>' + d.label + '</b><span>' + d.desc + '</span></div>' +
          '<label class="switch"><input type="checkbox" data-key="' + d.key + '"' + (settings[d.key] ? ' checked' : '') +
          '><span class="slider"></span></label>' +
        '</div>').join('') +
      /* 「实验室」分组：目前只有一项 —— 切换过渡动画（默认开；系统要求减少动态效果时置灰不可开）。
         控件是**原生 <input type="checkbox">**（可聚焦、有 aria 状态），不用原生 <select>。 */
      '<div class="set-group">实验室</div>' +
      '<div class="set-row" id="trlSetRow">' +
        '<div class="set-info">' +
          '<b id="trlSetLabel">切换过渡动画</b>' +
          '<span id="trlSetNote">切换风格 / 外观时播放全屏过渡动画（实验室功能，默认开）</span>' +
        '</div>' +
        '<label class="switch">' +
          '<input type="checkbox" id="trlSetInput" role="switch" aria-checked="false"' +
            ' aria-labelledby="trlSetLabel" aria-describedby="trlSetNote" data-key="transitionOn">' +
          '<span class="slider"></span>' +
        '</label>' +
      '</div>' +
      '<div class="set-tip">' +
        '后端：' + (BEC ? '已连接 Supabase' + (isReadOnly() ? '' : '（可读写）') : '未连接（只读演示模式）') +
        '<br>账号：邮箱登录 · <a href="selfcheck.html" target="_blank">运行自检</a>' +
        '<br>更多功能会陆续加进来，每个都可单独开关。' +
      '</div>' +
    '</div>';
  m.querySelector('#setBackdrop').addEventListener('click', closeSettings);
  m.querySelector('#setClose').addEventListener('click', closeSettings);
  m.querySelectorAll('.switch input').forEach(cb => {
    cb.addEventListener('change', e => setSetting(e.target.dataset.key, e.target.checked));
  });
  // 风格：点哪个就切哪个（并高亮当前项）
  m.querySelectorAll('#setStyleOpts .set-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      requestStyle(btn.dataset.style, paintSettings);
    });
  });
  // 外观：同上
  m.querySelectorAll('#setAppOpts .set-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const app = APPS.find(a => a.key === btn.dataset.app);
      if (app) requestAppearance(app, paintSettings);
    });
  });
  // 「实验室 · 切换过渡动画」：置灰/说明由 paintTransitionSetting() 统一决定
  const trlCb = m.querySelector('#trlSetInput');
  if (trlCb) trlCb.addEventListener('change', paintTransitionSetting);
  paintSettings();
}
/* 把当前风格/外观在面板里标成「选中」状态。
   ⚠️ 「当前是哪一项」**读实际生效的状态，不读存储**：
     · 风格 = `<link id="css-modern">` 是否 disabled（哪个样式表真的在生效）
     · 外观 = body 上的 mode-* / accent-* 两个 class（页面真的在用的深浅 + 红蓝）
   localStorage 只作兜底。这样即使写入被浏览器拒绝（Safari 隐私模式、存储配额满）或里面存着
   不认识的值，高亮也永远跟屏幕上看到的样式一致 —— 不会出现「切换了但高亮没动」「一个都没亮」
   或「两个都亮」。（同类问题：导航栏 nav a.active 曾用随主题翻转的变量做状态色。） */
function currentStyleKey() {
  const modern = document.getElementById('css-modern');
  if (modern) return modern.disabled ? 'minimal' : 'modern';
  return getPref('dsh_style', 'phi_style', 'modern');
}
function currentAppKey() {
  const cls = document.body.classList;
  const mode = cls.contains('mode-dark') ? 'dark' : (cls.contains('mode-light') ? 'light' : null);
  const accent = cls.contains('accent-blue') ? 'blue' : (cls.contains('accent-red') ? 'red' : null);
  const hit = APPS.find(a => a.mode === mode && a.accent === accent);
  return hit ? hit.key : getPref('dsh_app', 'phi_appearance', 'light-red');
}
function paintSettings() {
  const m = document.getElementById('settingsModal');
  if (!m) return;
  const curStyle = currentStyleKey();
  const curApp = currentAppKey();
  const paint = (btn, on) => {
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('data-selected', on ? 'true' : 'false');
  };
  m.querySelectorAll('#setStyleOpts .set-opt').forEach(b => paint(b, b.dataset.style === curStyle));
  m.querySelectorAll('#setAppOpts .set-opt').forEach(b => paint(b, b.dataset.app === curApp));
  paintTransitionSetting();   // 实验室开关的「关/置灰/说明」也在这里统一重画
  /* 再用**文字**把状态说一遍（不依赖颜色）：面板顶部「当前：浅·红 · 简约」 */
  const now = document.getElementById('setNow');
  if (now) {
    const app = APPS.find(a => a.key === curApp);
    now.textContent = '当前：' + (app ? app.label : curApp) + ' · ' + (STYLE_NAME[curStyle] || curStyle);
  }
}
function closeSettings() { const m = document.getElementById('settingsModal'); if (m) m.remove(); }

/* =========================================================
 * 风格 / 外观切换的全屏过渡动画（Phigros 加载页语言）
 *
 * 设计要点（本文件即规格正文）：
 *   · 只在用户**手动**切风格 / 换外观时播；启动与路由切换一律不播（见下方钩子位置）；
 *   · **动画要持续到「新主题真正渲染完成」再淡出**，避免出现"没有主题样式"的窗口；
 *   · 两道闸：系统「减少动态效果」＋ 设置面板里的开关，两边都开才播完整动画。
 *
 * ⚠️ 2026-10 口径修订（**以本节为准**）：
 *   遮罩上的元素从「白底黑字 Loading… 徽标」改成**右下角纯图形加载方块**（方块内无任何文字）
 *   ＋ 左下角一行小字提示。依据是用户提供的原版 Phigros 加载页截图逐像素量测：
 *   方块 139×44px、底色 rgb(93,93,93)、右距 89px(6.18%)、下距 54px(5%)，
 *   另有一道循环扫过的亮带。取图/取值位置见 layout.css 的 .trl-badge 注释。
 *   文字形式已被明确否掉（"不是现在这种文字形式的 loading"），所以这里**不再有** Loading… 文案。
 *
 * 钩子位置（硬约束）：只挂在 4 个用户动作点 —— #styleBtn / #appBtn / 设置面板「风格」/「外观」。
 *   绝不挂进 setStyleCss() / applyAppearance() 本体：initUI() 启动时会调用它们，
 *   挂进去会让「启动」「路由切换」误播（验收①要求那两处播放次数 = 0）。
 *
 * 时间线：淡入 250ms → 等「新主题已应用」→ 再等 2 帧（让重排+绘制真的落地）→ 淡出 250ms。
 *   「已应用」不是定时器，是**逐帧实测 computed style**（见 trlWaitApplied）：
 *     ① 遮罩内的主题探针 #trlProbe（带 .card）border-top-width / border-top-left-radius
 *        相对切换前发生变化 —— 现代 .card = 2px 实线 + 直角，简约 .card = 0 边框 + 22px 圆角；
 *     ② body 的 backgroundColor 已不透明 —— 用户实测的「新主题尚未应用」窗口里它是 rgba(0,0,0,0)；
 *     ③ 目标主题样式表确实 enabled。
 *   ② 专门堵住"无主题窗口"被误判成"已应用"：那一刻 ① 恰好也会变（变成 0px/0px）。
 *   读 computed style 这一下**本身就会同步触发**那次昂贵的整页样式重算（实测桌面 ≈1.4s、
 *   手机 ≈3–4s）—— 那正是我们要等的事，而遮罩此刻早已完全不透明，所以重算期间用户看到的是遮罩。
 *   超时兜底 waitCap=2500ms：到点也照常淡出，绝不把用户关在遮罩里。
 *
 * 双闸：总闸 = 系统 prefers-reduced-motion（减少动态效果）；分闸 = 设置面板「实验室」开关（默认开）。
 *   两闸皆开才播完整动画。未开时：**切风格**盖一层纯色极简遮罩做 150ms 淡化；**切外观**硬切（不播）。
 *
 * 跳过：整屏点击 / Esc / 点加载方块本身，均 ≤150ms 结束；连点 = 打断重播（不排队）。
 * 动画期间锁滚动，结束后滚动位置不变。
 * 方块本身**不加斜切**：原版加载页右下角这一块是正放的矩形（量测确认），没有 skew。
 * ========================================================= */
const TRL_ID = 'trl';
const TRL_T = {
  fadeIn: 250,    // 淡入时长
  fadeOut: 250,   // 淡出时长
  waitCap: 2500,  // 等「新主题已应用」的上限（超时也必须正常淡出）
  solid: 150,     // 兜底：纯色极简遮罩的淡化时长（仅切风格）
  /* 跳过（点击 / Esc / 点徽标）：规格要求 ≤150ms 内结束。取 120ms 而不是字面的 150ms ——
     CSS transition 的计时从**下一帧**起算，软件合成下单帧可达 30–50ms，
     按 150ms 写实测会落在 180–200ms（越界）。120ms 既保住"快速淡出"的观感，也给帧延迟留了余量。 */
  skip: 120,
  coverRetry: 2   // 抽到缺图曲目时的重抽次数上限（仍失败 → bg.jpg 兜底）
};

/* 只读计数器：验收用例读它。启动 + 路由切换后必须全是 0。 */
const trlStats = { entries: 0, fullPlays: 0, fallbackPlays: 0, hardSwitches: 0, lastTrace: null };
try { window.__phiTransition = trlStats; } catch (e) { /* 忽略 */ }

let trlLastCoverId = '';   // 避免连抽同一张
let trlGen = 0;            // 代次：连点 = 打断重播（旧的一轮在每个检查点看到代次变了就退出）
let trlHideTimer = 0;
let trlRunning = false;
let trlLocked = false;
let trlPrevOverflow = '';
let trlPrevOverflowBehavior = '';
let trlPrevPadding = '';

function trlReduce() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
}
/* 双闸：两闸皆开才播完整动画 */
function trlFullOn() { return settings.transitionOn === true && !trlReduce(); }

/* 遮罩骨架（与 index.html 中静态写好的那一份**逐字符一致**）。
   index.html 里必须静态写；这里是给 dev/test-*.html 这类没有该骨架的夹具页兜底补建，
   否则夹具点 #styleBtn 会拿到 null 直接抛异常。仍然挂在 body 上（不放 #main）。 */
const TRL_HTML =
  '<div class="trl-bg" id="trlBg"></div>' +
  '<div class="trl-dim" id="trlDim"></div>' +
  '<span class="trl-probe card" id="trlProbe" aria-hidden="true"></span>' +
  '<button type="button" class="trl-badge" id="trlBadge" aria-label="跳过过渡动画">' +
    '<span class="trl-txt">Loading…</span><span class="trl-band" aria-hidden="true"></span>' +
  '</button>' +
  '<p class="trl-tip" aria-hidden="true">Tip: 曲绘与谱面资料，欢迎在站内反馈里纠错</p>';

function trlEl() {
  let ov = document.getElementById(TRL_ID);
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'trl';
  ov.id = TRL_ID;
  ov.hidden = true;
  ov.innerHTML = TRL_HTML;
  /* ⚠️ 这里**不再**无条件挂点击监听。原来挂的是整屏 click → trlSkip，于是「取图/等主题」
     那段点一下屏幕就把动画掐掉了（2026-10-01 报的 bug）。
     现在统一由 trlArmSkip() 在「遮罩已铺满」之后挂上、每轮开始与收尾时摘掉。
     两处入口（这里的兜底骨架、index.html 的静态骨架）走的是同一个函数，不会再各挂一份。 */
  document.body.appendChild(ov);
  return ov;
}
function trlSetBg(url) {
  const bg = document.getElementById('trlBg');
  if (bg) bg.style.backgroundImage = url ? 'url("' + url + '")' : 'none';
}


/* ---------- 滚动锁：动画期间锁住，结束后滚动位置不变 ---------- */
let trlLockY = 0;
function trlLockScroll() {
  if (trlLocked) return;
  trlLocked = true;
  trlLockY = window.scrollY;                                             // 记下来，结束时要还原
  const sbw = window.innerWidth - document.documentElement.clientWidth;   // 经典滚动条宽度
  trlPrevOverflow = document.documentElement.style.overflow;
  trlPrevOverflowBehavior = document.documentElement.style.overscrollBehavior;
  trlPrevPadding = document.body.style.paddingRight;
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.style.overscrollBehavior = 'none';
  /* 滚动条消失会让内容右移 sbw 像素；用等量 padding 抵消，观感上"什么都没动"。
     只在真的有经典滚动条时加（覆盖式滚动条下 sbw = 0，加了反而会溢出）。 */
  if (sbw > 0) document.body.style.paddingRight = sbw + 'px';
}
function trlUnlockScroll() {
  if (!trlLocked) return;
  trlLocked = false;
  document.documentElement.style.overflow = trlPrevOverflow;
  document.documentElement.style.overscrollBehavior = trlPrevOverflowBehavior;
  document.body.style.paddingRight = trlPrevPadding;
  /* ⚠️ 为什么还要显式滚回去（实测结论，不是保险丝）：
     切风格会触发一次**同步的**整页样式重算（本机无头冷切换 ≈2.1s 连续占用主线程）。
     主线程被占住时，合成器收不到主线程的最新滚动树，滚轮增量仍会被它先应用；
     主线程恢复后页面就停在别处了（实测：锁着的时候连推 3 次滚轮，结束后 scrollY 由 420 变成 1620）。
     所以解锁时把位置显式还原 —— 这才是「结束后滚动位置不变」的可靠实现。 */
  if (Math.abs(window.scrollY - trlLockY) > 0.5) {
    try { window.scrollTo(0, trlLockY); } catch (e) { /* 忽略 */ }
  }
}

/* ---------- 取图：311 张全池随机 / 避免连抽同一张 / 缺图重抽 / bg.jpg 兜底 ---------- */
/* 返回一个 token：token.promise 在「图加载成功」或「兜底/失败」时 resolve。
   调用方用 Promise.race 与 300ms 上限赛跑 —— 先等到图就带图淡入，超时先淡入、图到了再补。 */
function trlStartPick() {
  const token = { url: null, id: null, attempts: 0, ok: false };
  token.promise = new Promise(resolve => {
    const songs = (typeof getSongs === 'function' ? getSongs() : []) || [];
    const pool = songs.filter(s => s && s.id);
    let settled = false;
    const settle = (url, id, ok) => {
      if (settled) return;
      settled = true;
      token.url = url; token.id = id; token.ok = ok;
      resolve(token);
    };
    const tryOne = () => {
      if (settled) return;
      if (token.attempts > TRL_T.coverRetry) {           // 首次 + 2 次重抽都失败 → bg.jpg 兜底
        trlLastCoverId = '';
        settle('bg.jpg', 'bg.jpg', false);
        return;
      }
      token.attempts++;
      if (!pool.length) { settle('bg.jpg', 'bg.jpg', false); return; }
      let pick = null;
      /* 避免连抽同一张：最多再摇 4 次；池子只有 1 张时只能接受同一张 */
      for (let k = 0; k < 5 && !pick; k++) {
        const cand = pool[Math.floor(Math.random() * pool.length)];
        if (!cand) continue;
        if (cand.id !== trlLastCoverId || k === 4 || pool.length === 1) pick = cand;
      }
      if (!pick) { settle('bg.jpg', 'bg.jpg', false); return; }
      trlLastCoverId = pick.id;
      const url = 'covers/' + pick.id + '.jpg';
      const im = new Image();
      /* ⚠️ 这里**不用** songs.js 的 coverImg()：它 onerror 会换成内联的「NO ART」占位 SVG，
         而验收标准⑤要求遮罩上 0 次出现 "NO ART"。缺图必须**重抽**，不是换占位图。 */
      im.onload = () => settle(url, pick.id, true);
      im.onerror = () => tryOne();
      im.src = url;
    };
    tryOne();
  });
  return token;
}

/* ---------- 「新主题已应用」的逐帧判据 ---------- */
function trlThemeSig() {
  const probe = document.getElementById('trlProbe');
  const cs = probe ? getComputedStyle(probe) : null;
  const b = getComputedStyle(document.body);
  /* 自定义属性也一并纳入签名：纯「外观」切换（红↔蓝）不改结构，只改这些令牌的值。
     读 computed style 自身就会同步触发那次整页样式重算 —— 这正是我们要等的事。 */
  return [
    cs ? cs.borderTopWidth : '',
    cs ? cs.borderTopLeftRadius : '',
    cs ? cs.borderTopColor : '',
    b.getPropertyValue('--red').trim(),
    b.getPropertyValue('--ink').trim(),
    b.getPropertyValue('--paper').trim(),
    b.getPropertyValue('--a-blue').trim(),
    b.getPropertyValue('--a-ink').trim(),
    b.getPropertyValue('--a-bg').trim()
  ].join('|');
}
function trlBodyOpaque() {
  const m = getComputedStyle(document.body).backgroundColor.match(/rgba?\(([^)]+)\)/);
  if (!m) return true;
  const parts = m[1].split(',').map(s => parseFloat(s));
  return parts.length < 4 || !(parts[3] <= 0.01);   // 无主题窗口里是 rgba(0,0,0,0)
}
function trlWaitApplied(opt) {
  return new Promise(resolve => {
    const t0 = performance.now();
    let done = false;
    const finish = (timedOut, cancelled, forSheet) => {
      if (done) return;
      done = true;
      resolve({
        at: performance.now(),
        timedOut: !!timedOut,
        cancelled: !!cancelled,
        /* 超时是「卡在目标样式表没就绪」还是「表就绪了但重排没落地」——
           两者后果完全不同：前者如果收尾，用户就会看到**没有样式的页面**（本 bug 的样子）。 */
        timedOutForSheet: !!forSheet,
        waited: performance.now() - t0
      });
    };
    const step = () => {
      if (done) return;
      /* 被跳过/被新一轮接管 ⇒ 立刻停。这条**必须有**：每帧读 computed style 会逼着浏览器
         做样式重算，用户按下 Esc 之后还这么干就是拿主线程拖着不让人家收尾。 */
      if (opt.gen !== trlGen) { finish(false, true); return; }
      /* 判据回到 v1.0.15 那版（只判「目标主题表已启用」）。
         ⚠️ 曾经加强成「还要 CSSOM 有规则」，结果换表慢时会把遮罩卡到 8 秒 ——
            而那段里页面没有主题样式，观感就是"曲绘还没出来 CSS 先掉了"（两轮反馈的同一症状）。
            现在松判据 + 2.5s 上限：宁可早点收尾，也不长时间盖着一个没样式的页面。 */
      const sheetOk = !opt.styleKey || (() => {
        const el = document.getElementById('css-' + opt.styleKey);
        return !!el && !el.disabled;
      })();
      const sigOk = trlThemeSig() !== opt.sigBefore;   // ← 这一句会同步触发整页样式重算
      if (sheetOk && sigOk && trlBodyOpaque()) { finish(false, false); return; }
      if (performance.now() - t0 >= opt.cap) { finish(true, false, false); return; }
      requestAnimationFrame(step);
    };
    /* 兜底定时器：标签页在后台时 rAF 会被节流甚至完全不跑，
       只靠 rAF 的话 waitCap 永远到不了点，用户就被关在遮罩里了。 */
    setTimeout(() => finish(true, opt.gen !== trlGen, false), opt.cap + 120);
    step();
  });
}

/* ---------- 显隐 / 淡入淡出 ---------- */
function trlNextFrames(n) {
  return new Promise(resolve => {
    let left = n;
    const tick = () => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
/* 等遮罩**真的**不透明（computed opacity ≥ 0.99）再往下走。
   为什么不能只用 `setTimeout(250)` 等淡入：淡入的 CSS 过渡是从"下一帧"起算的，
   而遮罩第一次显示时要现铺一张全屏大模糊图（实测那一下是个 260ms 级的 long task），
   过渡的起点会被推后 ⇒ 250ms 定时器到点时 opacity 可能只有 0.2~0.5。
   那一刻如果就去切主题，**半透明的遮罩根本盖不住"新主题尚未应用"的窗口**（用户要的正是盖住它）。
   实测数据：改成等不透明之前，覆盖期里能采到 opacity=0.20 的帧。 */
function trlWaitOpaque(ov, cap, gen) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const step = () => {
      /* 用户已经跳过（代次变了）⇒ 立刻停：继续每帧读 computed style 只会白白占着主线程，
         把"跳过"自己的收尾定时器一起顶后（实测这样能把 150ms 的收尾拖到 ~200ms）。 */
      if (gen !== trlGen) { resolve({ ok: false, cancelled: true, at: performance.now() }); return; }
      if (parseFloat(getComputedStyle(ov).opacity) >= 0.99) { resolve({ ok: true, at: performance.now() }); return; }
      if (performance.now() - t0 >= cap) { resolve({ ok: false, at: performance.now() }); return; }
      requestAnimationFrame(step);
    };
    step();
  });
}
/* 「跳过」是否已就绪。声明必须在使用它的 trlShow/trlFadeOut **之前**：let 不像函数声明那样提升，
   放在后面会在某些调用顺序下踩 TDZ（模块初始化期间若有人触发 trlShow）。 */
let trlSkipArmed = false;

function trlShow(ov) {
  clearTimeout(trlHideTimer);
  trlArmSkip(false);      // 每轮开始时先摘掉「跳过」：取图/等主题那段不接受点击
  /* 清掉 index.html 上的内联兜底 style="display:none"。
     那个内联样式的作用：万一 layout.css 没到位，遮罩不会裸奔在文档流末尾（内联不依赖外部文件）。
     layout.css 里没有任何规则给 .trl 设 display（它默认是 block），唯一的隐身机制是
     .trl[hidden]，所以内联 display:none 会永久压住它 —— 这里必须显式清掉。 */
  ov.style.display = '';
  ov.hidden = false;
  ov.classList.remove('is-solid', 'is-dark', 'is-on');
}
function trlFadeOut(ov, ms, gen) {
  trlArmSkip(false);      // 开始收尾就不再接受跳过
  ov.classList.remove('is-on');
  ov.style.transitionDuration = ms + 'ms';
  ov.style.opacity = '0';
  clearTimeout(trlHideTimer);
  trlHideTimer = setTimeout(() => {
    if (gen !== trlGen) return;          // 已经被新一轮接管
    ov.hidden = true;
    ov.style.transitionDuration = '0ms';
    trlRunning = false;
  }, ms);
}
/* 跳过：整屏点击 / Esc / 点徽标本身（徽标即按钮）。连点也是走这里 —— 打断重播，不排队。 */
function trlSkip() {
  const ov = document.getElementById(TRL_ID);
  if (!ov || ov.hidden) return;         // 没在播就什么都不做
  trlGen++;                             // 让在飞的那一轮在每个检查点自行退出
  trlRunning = false;
  trlUnlockScroll();
  /* 重新设一个 hideTimer（旧的那个会因代次不符而空转），
     所以"在淡出途中再点一次"也不会把遮罩永久留在屏幕上。 */
  trlFadeOut(ov, TRL_T.skip, trlGen);
}

/* ---------- 入口：4 个用户动作点都走这里 ---------- */
function requestStyle(style, onDone) {
  trlRun('style', () => setStyleCss(style), onDone, null, style);
}
function requestAppearance(app, onDone) {
  trlRun('appearance', () => applyAppearance(app), onDone, '外观：' + app.label, null);
}
function trlRun(kind, apply, onDone, toastMsg, styleKey) {
  trlStats.entries++;
  const ov = trlEl();
  /* 「跳过」的监听不再在这里常挂：改为遮罩铺满后由 trlArmSkip(true) 挂上（见那里的注释）。*/
  const done = () => {
    try { if (onDone) onDone(); } catch (e) { /* 忽略 */ }
    if (toastMsg) toast(toastMsg);
  };

  /* 兜底：切外观在动画关闭时**硬切**（不播、不盖遮罩、也不打断在飞的那一轮）。 */
  if (kind === 'appearance' && !trlFullOn()) {
    trlStats.hardSwitches++;
    apply();
    done();
    return;
  }

  const gen = ++trlGen;                  // 连点 = 打断重播：旧的一轮看到代次变了就退出
  if (trlFullOn()) {
    trlStats.fullPlays++;
    trlPlayFull(ov, gen, kind, apply, styleKey, done);
    return;
  }
  trlStats.fallbackPlays++;
  trlSolidFade(ov, gen, apply, done);
}
/* ---------- 「跳过」的挂载 / 摘除 ----------
   2026-10-01 反馈：「在动画过程中点击网页动画就没有了，修一下」。
   根因就是原来在这里**初始化时就把整屏点击接成了跳过** —— 于是动画刚起来、
   甚至还在取图/等主题重算的那段，用户随手点一下屏幕就被判定为"跳过"，动画直接收尾。
   改法：把监听改成「只有遮罩**已经铺满**（is-on 且不透明）之后才生效」，
        并在每轮开头（trlShow 之前）与收尾时摘掉。这样：
          · 取图 / 等主题那段点屏幕 → 什么都不发生（动画照常）；
          · 遮罩铺满之后点屏幕 → 仍然立刻跳过（原有能力保留）。 */
function trlSkipClick(e) {
  if (!trlSkipArmed) return;             // 未就绪期：不把点击当成跳过
  e.preventDefault();
  trlSkip();
}
function trlArmSkip(on) {
  const ov = trlEl();
  if (on === trlSkipArmed) { if (!on) return; }
  if (on) {
    if (trlSkipArmed) return;
    trlSkipArmed = true;
    ov.addEventListener('click', trlSkipClick);
    const badge = ov.querySelector('.trl-badge');
    if (badge && !badge.dataset.trlArmed) {
      badge.dataset.trlArmed = '1';
      badge.addEventListener('click', e => {
        if (!trlSkipArmed) { e.stopPropagation(); return; }   // 未就绪期点方块也不跳过
        e.stopPropagation(); trlSkip();
      });
    }
  } else {
    trlSkipArmed = false;
    ov.removeEventListener('click', trlSkipClick);
  }
}

/* 兜底路径：纯色极简遮罩 150ms 淡化（仅切风格）。
   ⚠️ apply() 必须**同步**执行 —— dev/test-ui.html 有一条既有断言在点击后**同步**读
      `#css-modern.disabled`，走成异步就会假失败。 */
function trlSolidFade(ov, gen, apply, done) {
  trlRunning = true;
  trlLockScroll();
  trlShow(ov);
  ov.classList.add('is-solid', 'is-on');
  ov.classList.toggle('is-dark', document.body.classList.contains('mode-dark'));
  ov.style.transitionDuration = '0ms';
  ov.style.opacity = '1';
  void ov.offsetWidth;                   // 提交"遮罩已铺满"这一帧（此刻样式是干净的，很便宜）
  apply();                               // ← 同步切换，保住既有断言
  done();
  requestAnimationFrame(() => {
    if (gen !== trlGen) return;
    trlUnlockScroll();
    trlFadeOut(ov, TRL_T.solid, gen);
  });
}

/* 完整动画：淡入 250ms → 等「新主题已应用」（≤2500ms）→ 2 帧 → 淡出 250ms */
async function trlPlayFull(ov, gen, kind, apply, styleKey, done) {
  const t0 = performance.now();
  const trace = {
    kind: kind, gen: gen, t0: t0,
    coverId: null, coverUrl: null, coverAttempts: 0, coverReadyInTime: false,
    opaqueAt: null, opaqueOk: null, shownAt: null,
    applyAt: null, appliedAt: null, appliedWaitMs: null, timedOut: null,
    paintAt: null, fadeOutAt: null, endAt: null, skip: false,
    /* 2026-10-01 新增：用来回答「动画是否盖住了 CSS 切换」——
       这四个时刻的顺序就是执行顺序，逐帧可查，不靠叙述。 */
    pickStartAt: null, coverUrlAt: null, coverVisibleAt: null, coverWaitMs: null
  };
  trlStats.lastTrace = trace;
  trlRunning = true;
  trlLockScroll();

  /* ① 取图：**等图真的就绪再开始淡入**（回到 v1.0.15 的时序）。
     为什么必须这样（2026-10-01 的第三轮定位 + 代码核对）：
       上一版我改成「动画立刻上、曲绘随后 400ms 淡入」，做法是先把曲绘层压到 opacity 0、
       再立刻让遮罩全屏不透明，然后才切主题。问题出在取图这段：遮罩已经在播（用户看得见），
       而 (a) trlWaitApplied 当时要求「目标样式表 CSSOM 已建立且有规则」会一直卡到 8 秒上限，
       (b) 那段里页面没有主题样式 ⇒ 观感就是**曲绘出现之前 CSS 先掉了**（1.0.20 同款症状）。
       本次两处一起改回 1.0.15 的时序与松判据（trlWaitApplied 现在只判「表已启用」+ 2.5s 上限）。
     等图就绪再显示遮罩则完全没有这个窗口：取图期间页面根本没被遮罩碰过。
     代价：图慢时动画起步晚一点（已确认接受，1.0.15 就是这么跑的）。
     先把背景清空，避免等图期间露出上一轮的曲绘。 */
  trlSetBg('');
  const pick = trlStartPick();
  trace.pickStartAt = performance.now();
  const r0 = await pick.promise;
  if (gen !== trlGen) { trace.skip = true; return; }
  trace.coverAttempts = pick.attempts;
  trace.coverId = r0.id; trace.coverUrl = r0.url;
  trace.coverUrlAt = performance.now();
  trlSetBg(r0.url);

  /* ② 淡入 250ms（**等到真的不透明为止**才继续，见 trlWaitOpaque 的注释） */
  trlShow(ov);
  trace.shownAt = performance.now();
  ov.style.transitionDuration = '0ms';
  ov.style.opacity = '0';
  void ov.offsetWidth;                   // 提交 0 这一帧，否则下一句不产生过渡
  ov.classList.add('is-on');
  ov.style.transitionDuration = TRL_T.fadeIn + 'ms';
  ov.style.opacity = '1';
  const opaque = await trlWaitOpaque(ov, TRL_T.fadeIn + 600, gen);
  if (gen !== trlGen) { trace.skip = true; return; }
  trace.opaqueAt = opaque.at;
  trace.opaqueOk = opaque.ok;
  /* ⚠️ 这里**不再**开放「跳过」。2026-10-01 定的口径：
     「必须等播放完整结束；播放未结束时，跳过操作不应生效。」
     ⇒ 整个播放期间（铺满之后也算）点击/点方块/Esc 都不生效；
       直到 ⑤ 淡出结束、遮罩收起来之后才由 trlPlayFull 末尾开放（那时点它已经无事可做，
       但保留了这条能力，且不给"播放中途掐掉"留任何入口）。 */
  trlArmSkip(false);

  /* ③ 切主题：把切换前那一刻的 computed style 签名记下来（必须**在 apply 之前**读）
     ⚠️ 顺序说明：遮罩已经完全盖住屏幕，此时才切主题 ——
        换主题要重算整页样式（手机上 1~4 秒），遮罩已经把这段时间盖住了。 */
  const sigBefore = trlThemeSig();
  apply();
  trace.applyAt = performance.now();
  const applied = await trlWaitApplied({
    sigBefore: sigBefore, styleKey: styleKey,
    cap: TRL_T.waitCap,
    gen: gen
  });
  if (gen !== trlGen) { trace.skip = true; return; }
  trace.appliedAt = applied.at;
  trace.appliedWaitMs = applied.waited;
  trace.timedOut = applied.timedOut;

  /* ④ 再等 2 帧：computed style 变了 ≠ 重排/绘制已经落地。
        这两帧会强制走完新主题的 layout + paint，画完才允许淡出。
        （曲绘在 ① 就已就绪，这里不需要再等它。） */
  await trlNextFrames(2);
  if (gen !== trlGen) { trace.skip = true; return; }
  trace.coverVisibleAt = trace.coverUrlAt;
  trace.paintAt = performance.now();

  /* ⑤ 淡出 250ms */
  trace.fadeOutAt = performance.now();
  trlUnlockScroll();
  trlFadeOut(ov, TRL_T.fadeOut, gen);
  done();
  await new Promise(res => setTimeout(res, TRL_T.fadeOut));
  trace.endAt = performance.now();
  /* 播放完整结束（淡出也走完）之后才开放「跳过」的监听。
     此时遮罩已 hidden，点它不会也不该有任何效果 —— 只是把能力恢复到"每轮开始时摘掉"的对称状态，
     这样下一轮开始时 trlShow() 里的 trlArmSkip(false) 一定是从"已开放"摘到"未开放"，逻辑可控。 */
  trlArmSkip(true);
}

/* ---------- 设置面板里的「实验室 · 切换过渡动画」开关 ---------- */
function paintTransitionSetting() {
  const m = document.getElementById('settingsModal');
  if (!m) return;
  const cb = m.querySelector('#trlSetInput');
  if (!cb) return;
  const reduced = trlReduce();
  const on = !reduced && settings.transitionOn === true;
  /* 系统要求减少动态效果 ⇒ 显示为**关 + 置灰 + 小字说明**。
     注意：只覆盖"显示"，不覆写用户存的偏好 —— 系统闸放开后他的选择会回来。 */
  cb.disabled = reduced;
  cb.checked = on;
  cb.setAttribute('aria-checked', on ? 'true' : 'false');
  const row = m.querySelector('#trlSetRow');
  if (row) row.classList.toggle('is-muted', reduced);
  const note = m.querySelector('#trlSetNote');
  if (note) {
    note.textContent = reduced
      ? '系统已开启「减少动态效果」，此开关不可用（开启后也不会播放动画）'
      : '切换风格 / 外观时播放全屏过渡动画（实验室功能，默认开）';
  }
}

/* ---------------- 站内反馈（#navFeedback 打开） ----------------
 * 为什么挂在 document.body 而不是 #authModal / #main：
 *   · #main 每次路由都整体重渲染 ⇒ 弹窗会被销毁；
 *   · 复用 #authModal 会与登录弹窗互相覆盖。
 * 与 openSettings() 同一策略：动态创建 #feedbackModal 挂到 body，关闭时 remove()。
 * 提交必须登录：未登录时先弹登录，而不是让用户填完再被后端拒绝。 */

function fbCatLabel(v) {
  const hit = FEEDBACK_CATEGORIES.filter(c => c.value === v)[0];
  return hit ? hit.label : '其他';
}

function closeFeedback() {
  const m = document.getElementById('feedbackModal');
  if (m) m.remove();
}

function renderFeedbackList() {
  const box = document.getElementById('fbList');
  if (!box) return;
  const mine = myFeedback();
  if (!mine.length) {
    box.innerHTML = '<div class="empty dim">你还没有提交过反馈。</div>';
    return;
  }
  box.innerHTML = mine.map(f => {
    const handled = !!f.handled;
    return '<div class="fb-item' + (handled ? ' is-handled' : '') + '">' +
        '<div class="fb-item-head">' +
          '<span class="fb-cat">' + escapeHtml(fbCatLabel(f.category)) + '</span>' +
          '<span class="fb-time">' + escapeHtml(formatTime(f.created_at)) + '</span>' +
          '<span class="fb-state">' + (handled ? '已处理' : '待处理') + '</span>' +
        '</div>' +
        '<div class="fb-body">' + escapeHtml(f.body) + '</div>' +
      '</div>';
  }).join('');
}

export function openFeedback() {
  if (isReadOnly()) { toast('只读演示模式：暂时无法提交反馈', 'error'); return; }
  if (!currentUser()) {
    toast('请先登录再提交反馈');
    openAuth('login');
    return;
  }
  const old = document.getElementById('feedbackModal');
  if (old) old.remove();

  const wrap = document.createElement('div');
  wrap.id = 'feedbackModal';
  wrap.className = 'set-backdrop';
  wrap.innerHTML =
    '<div class="set-card fb-card" role="dialog" aria-modal="true" aria-labelledby="fbTitle">' +
      '<div class="set-head">' +
        '<b id="fbTitle">站内反馈</b>' +
        '<button type="button" id="fbClose" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="set-row set-row-block">' +
        '<div class="set-info">' +
          '<b>提个问题或想法</b>' +
          '<span>反馈只有管理员能看到，你的邮箱不会公开显示。</span>' +
        '</div>' +
        '<div class="dd-slot" id="ddFbCat"></div>' +
        '<textarea id="fbBody" rows="5" maxlength="' + FEEDBACK_MAX + '" ' +
          'placeholder="说清楚发生了什么、你期望怎样（' + FEEDBACK_MIN + '–' + FEEDBACK_MAX + ' 字）"></textarea>' +
        '<div class="fb-counter" id="fbCounter">0 / ' + FEEDBACK_MAX + '</div>' +
        '<div class="auth-error" id="fbError"></div>' +
        '<div class="comment-actions">' +
          '<button type="button" class="btn primary" id="fbSubmit">提交反馈</button>' +
        '</div>' +
      '</div>' +
      '<div class="set-row set-row-block">' +
        '<div class="set-info"><b>我提交过的</b><span>按时间倒序，管理员处理后状态会变成「已处理」。</span></div>' +
        '<div class="fb-list" id="fbList"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  /* 分类用站内自绘下拉（与首页/榜单同一套控件，不用原生 select） */
  mountDropdown('#ddFbCat', {
    id: 'fbCat',
    title: '反馈类型',
    options: FEEDBACK_CATEGORIES.map(c => ({ value: c.value, label: c.label }))
  });
  const cat = document.getElementById('fbCat');
  if (cat) {
    cat.value = state.feedbackCat;
    cat.addEventListener('change', e => { state.feedbackCat = e.target.value; });
  }

  const bodyEl = document.getElementById('fbBody');
  const counter = document.getElementById('fbCounter');
  const errEl = document.getElementById('fbError');
  const setErr = (msg) => { if (errEl) errEl.textContent = msg || ''; };

  if (bodyEl) bodyEl.addEventListener('input', () => {
    const n = charLen(bodyEl.value.trim());     // 按字符数（与数据库 char_length 对齐，见 storage.js）
    if (counter) {
      counter.textContent = n + ' / ' + FEEDBACK_MAX;
      counter.classList.toggle('is-short', n > 0 && n < FEEDBACK_MIN);
    }
    setErr('');
  });

  document.getElementById('fbClose').addEventListener('click', closeFeedback);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeFeedback(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { closeFeedback(); document.removeEventListener('keydown', onEsc); }
  });

  const btn = document.getElementById('fbSubmit');
  btn.addEventListener('click', async () => {
    const text = bodyEl ? bodyEl.value.trim() : '';
    setErr('');
    const n = charLen(text);
    if (n < FEEDBACK_MIN) { setErr('反馈内容至少 ' + FEEDBACK_MIN + ' 个字（当前 ' + n + ' 个）。'); return; }
    if (n > FEEDBACK_MAX) { setErr('反馈内容最多 ' + FEEDBACK_MAX + ' 个字（当前 ' + n + ' 个）。'); return; }
    const old2 = btn.textContent;
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      // ① 写操作：失败必须把后端原文显示出来（例如被限频、被 RLS 拒绝）
      await submitFeedback(state.feedbackCat, text);
      setErr('');
      if (bodyEl) { bodyEl.value = ''; }
      if (counter) { counter.textContent = '0 / ' + FEEDBACK_MAX; counter.classList.remove('is-short'); }
      toast('反馈已提交，谢谢');
      // ② 刷新列表：刷新失败 ≠ 提交失败（上面已经写成功了）
      try { renderFeedbackList(); } catch (e2) { /* 忽略 */ }
    } catch (e) {
      setErr((e && e.message) || '提交失败，请稍后再试。');
    } finally {
      btn.disabled = false; btn.textContent = old2;
    }
  });

  renderFeedbackList();
}

/* ---------------- 初始化界面（静态控件） ---------------- */
export function initUI() {
  const styleBtn = $('#styleBtn');
  if (styleBtn) styleBtn.addEventListener('click', cycleStyle);
  setStyleCss(getPref('dsh_style', 'phi_style', 'modern'));

  const appBtn = $('#appBtn');
  if (appBtn) appBtn.addEventListener('click', cycleAppearance);
  const savedApp = getPref('dsh_app', 'phi_appearance', 'light-red');
  applyAppearance(APPS.find(a => a.key === savedApp) || APPS[0]);

  loadSettings();
  applySettings();

  const sbToggle = $('#sbToggle');
  if (sbToggle) sbToggle.addEventListener('click', () => setSetting('sidebarCollapsed', !getSetting('sidebarCollapsed')));
  const settingsBtn = $('#settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

  /* ---------- 窄屏吸顶工具栏的让位高度（报「吸顶没用」的根因之一）----------
     ≤880px 时 header 变成顶部**横条**（position:sticky）且 z-index 比工具栏高，
     工具栏的吸顶 top:0 正好落在横条底下 ⇒ 每次吸顶都被完整盖住，看起来像"没生效"。
     CSS 侧改成 top: calc(var(--hdr-h) + 安全区)，这里把横条的**实测高度**写进 --hdr-h。
     为什么不在 CSS 里写死 px：横条高度随字号、换行、刘海安全区变化，
     407px 宽与 880px 宽能差出一行的高度，写死必错位。
     ResizeObserver 而不是监听 resize：横条因内容变化（比如导航项增减、字体加载）改高时
     resize 事件不会触发，只有尺寸观察能看到。 */
  try {
    const hdr = document.querySelector('header');
    if (hdr && typeof ResizeObserver === 'function') {
      const paint = () => {
        const narrow = window.matchMedia('(max-width: 880px)').matches;
        if (narrow) document.documentElement.style.setProperty('--hdr-h', Math.round(hdr.getBoundingClientRect().height) + 'px');
        else document.documentElement.style.removeProperty('--hdr-h');
      };
      new ResizeObserver(paint).observe(hdr);
      window.addEventListener('resize', paint);
      paint();
    }
  } catch (e) { /* 老浏览器没有 ResizeObserver：退回 CSS 里的 52px 兜底值，功能不丢 */ }

  /* Esc = 跳过过渡动画（与整屏点击、点徽标等价）。
     用捕获阶段：它在键盘上最"急"，要在自定义下拉等其它 Esc 处理之前拿到。 */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const ov = document.getElementById(TRL_ID);
    if (!ov || ov.hidden) return;
    /* ⚠️ 与整屏点击用**同一把闸**。2026-10-01 定的口径：
       「必须等播放完整结束；播放未结束时，跳过操作不应生效。」—— 播放期间 Esc 同样不生效。
       （早先我给它留了更早的触发点：拿到 is-on 就算数。而 is-on 在淡入一开始就加上了，
        于是压测里 Esc 仍能把动画掐掉：实测 skip=true、endAt 始终为空。这里收回。） */
    if (!trlSkipArmed) return;
    e.preventDefault();
    e.stopPropagation();
    trlSkip();
  }, true);

  /* 系统「减少动态效果」在页面开着的时候被改（macOS/iOS 开关、Windows 动画设置）：
     设置面板若正开着，立刻重画开关的置灰/说明状态。 */
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMq = () => paintTransitionSetting();
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch (e) { /* 忽略 */ }
}

export { reportNotice };
