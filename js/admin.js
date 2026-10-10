/* =========================================================
 * js/admin.js —— 管理员后台（#/admin）
 *   · 评论管理：列出全站评论、按曲名/用户筛选、删除任意评论（走既有 RLS）
 *   · 用户列表：昵称 / 邮箱 / 加入时间 / 评分与评论数 / 身份
 *   · 提权与降权：只能走数据库函数 public.admin_set_admin（禁止改自己）
 * 准入判定只看数据库行（isAdmin()），没有任何前端「伪管理员」后门。
 * ========================================================= */

import { getSong } from './songs.js';
import {
  getComments, getRatings, profileName, isReadOnly,
  adminDeleteComment, adminSetAdmin, reloadTable, listProfiles, findProfile,
  getFeedback, adminSetFeedbackHandled, FEEDBACK_CATEGORIES
} from './storage.js';
import { currentUser, isAdmin } from './auth.js';
import { escapeHtml, toast, formatTime, openAuth } from './ui.js';

const COMMENT_EMPTY = '还没有评论。';
const USER_EMPTY = '没有匹配的用户。';
const FEEDBACK_EMPTY = '没有匹配的反馈。';
const TRUNCATE = 80;

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

/**
 * 头像色白名单：数据库侧已有 users_avatar_color_fmt 约束，
 * 这里再在渲染前兜一层 —— 只有 #RGB/#RRGGBB/#RRGGBBAA 形式才允许进 style，其余回退默认色。
 * （avatar_color 是用户可写字段，直接拼进 style 会造成 CSS 注入。）
 */
const DEFAULT_AVATAR_COLOR = '#6c5ce7';
const AVATAR_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
function safeColor(color) {
  const c = String(color == null ? '' : color).trim();
  return AVATAR_COLOR_RE.test(c) ? c : DEFAULT_AVATAR_COLOR;
}

/** 视图：管理员后台 */
export function renderAdmin(state) {
  const main = $('#main');
  if (!main) return;
  const st = state || {};

  // 1) 只读演示模式：没有后端，管理入口不可用
  if (isReadOnly()) {
    main.innerHTML =
      '<div class="admin-page">' +
        '<div class="need-login big">只读演示模式：管理后台不可用。连上 Supabase 后刷新页面再试。</div>' +
      '</div>';
    return;
  }

  // 2) 未登录：引导登录，不调用任何管理接口
  if (!currentUser()) {
    main.innerHTML =
      '<div class="admin-page">' +
        '<div class="need-login big">请先登录 ' +
          '<button type="button" class="btn primary" id="adminLoginBtn">去登录</button>' +
        '</div>' +
      '</div>';
    const b = $('#adminLoginBtn');
    if (b) b.addEventListener('click', () => openAuth('login'));
    return;
  }

  // 3) 已登录但不是管理员：既看不到入口，也进不来
  if (!isAdmin()) {
    main.innerHTML =
      '<div class="admin-page">' +
        '<div class="need-login big">无权限访问（需要管理员身份）</div>' +
        '<div class="admin-note">当前账号不是管理员。管理员身份存在数据库里，' +
          '只能由已有管理员在后台按钮里授予，或由站点所有者第一次在 Supabase SQL Editor 里手工指定。</div>' +
      '</div>';
    return;
  }

  const me = currentUser();
  main.innerHTML =
    '<div class="admin-page">' +
      '<div class="admin-head">' +
        '<h1>管理后台 <span class="role-tag">管理员</span></h1>' +
        '<div class="admin-sub">当前账号：' + escapeHtml(me.nickname || me.email || me.id) + '</div>' +
      '</div>' +
      '<div class="admin-cols">' +
        '<section class="admin-col">' +
          '<h2>站内反馈 <span class="count-tag" id="adminFbCount">—</span></h2>' +
          '<div class="admin-filters">' +
            '<input id="adminFbQuery" type="text" placeholder="按内容 / 用户筛选…" value="' +
              escapeHtml(st.adminFbQuery || '') + '" />' +
            '<button type="button" class="admin-fb-filter' + (st.adminFbOnlyOpen ? ' is-on' : '') + '" ' +
              'id="adminFbFilter" aria-pressed="' + (st.adminFbOnlyOpen ? 'true' : 'false') + '">只看未处理</button>' +
          '</div>' +
          '<div class="admin-feedback-list" id="adminFeedbackList"></div>' +
        '</section>' +
        '<section class="admin-col">' +
          '<h2>评论管理 <span class="count-tag" id="adminCommentCount">—</span></h2>' +
          '<div class="admin-filters">' +
            '<input id="adminCommentQuery" type="text" placeholder="按曲名筛选…" value="' +
              escapeHtml(st.adminCommentQuery || '') + '" />' +
            '<input id="adminCommentUser" type="text" placeholder="按用户筛选…" value="' +
              escapeHtml(st.adminCommentUser || '') + '" />' +
          '</div>' +
          '<div class="admin-comment-list" id="adminCommentList"></div>' +
        '</section>' +
        '<section class="admin-col">' +
          '<h2>用户列表 <span class="count-tag" id="adminUserCount">—</span></h2>' +
          '<div class="admin-filters">' +
            '<input id="adminUserQuery" type="text" placeholder="按昵称 / 邮箱搜索…" value="' +
              escapeHtml(st.adminUserQuery || '') + '" />' +
          '</div>' +
          '<div class="admin-user-list" id="adminUserList"></div>' +
        '</section>' +
      '</div>' +
      '<div class="admin-note">' +
        '<b>这个后台能做什么：</b>查看站内反馈并标记已处理、删除任意评论、把其他账号设为管理员或取消管理员。<br>' +
        '<b>不能做什么：</b><br>' +
        '· <b>不能删除反馈</b>（反馈是审计记录，只能标记处理状态）；<br>' +
        '· <b>不能删除注册账号</b>（删除 Auth 用户只能在 Supabase 控制台操作，前端没有这个权限）；<br>' +
        '· <b>不能修改自己的管理员身份</b>（自己那一行的按钮是禁用的，数据库函数也会拒绝）；<br>' +
        '· 不能替别人改昵称 / 头像 / 密码。<br>' +
        '权限以数据库为准：提权走 <code>public.admin_set_admin(target_id, make_admin)</code>，' +
        '任何「直接改 users.is_admin」的请求都会被数据库拒绝。' +
      '</div>' +
    '</div>';

  const cq = $('#adminCommentQuery');
  if (cq) cq.addEventListener('input', e => { st.adminCommentQuery = e.target.value; renderCommentList(st); });
  const cu = $('#adminCommentUser');
  if (cu) cu.addEventListener('input', e => { st.adminCommentUser = e.target.value; renderCommentList(st); });
  const uq = $('#adminUserQuery');
  if (uq) uq.addEventListener('input', e => { st.adminUserQuery = e.target.value; renderUserList(st); });

  const fq = $('#adminFbQuery');
  if (fq) fq.addEventListener('input', e => { st.adminFbQuery = e.target.value; renderFeedbackList(st); });
  const ffilter = $('#adminFbFilter');
  if (ffilter) ffilter.addEventListener('click', () => {
    st.adminFbOnlyOpen = !st.adminFbOnlyOpen;
    ffilter.classList.toggle('is-on', !!st.adminFbOnlyOpen);
    ffilter.setAttribute('aria-pressed', st.adminFbOnlyOpen ? 'true' : 'false');
    renderFeedbackList(st);
  });

  renderFeedbackList(st);
  renderCommentList(st);
  renderUserList(st);
}

/* ---------------- 站内反馈 ---------------- */

function fbLabel(v) {
  const hit = FEEDBACK_CATEGORIES.filter(c => c.value === v)[0];
  return hit ? hit.label : '其他';
}

function renderFeedbackList(state) {
  const box = document.getElementById('adminFeedbackList');
  if (!box) return;
  const st = state || {};
  const q = String(st.adminFbQuery || '').trim().toLowerCase();
  const onlyOpen = !!st.adminFbOnlyOpen;
  const all = getFeedback();

  const rows = all.filter(f => {
    if (onlyOpen && f.handled) return false;
    if (q) {
      const hay = (String(f.body == null ? '' : f.body) + ' ' + profileName(f.user_id)).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  const cnt = document.getElementById('adminFbCount');
  if (cnt) {
    const open = all.filter(f => !f.handled).length;
    cnt.textContent = rows.length + ' / ' + all.length + '（待处理 ' + open + '）';
  }

  if (!rows.length) {
    box.innerHTML = '<div class="empty dim">' + escapeHtml(FEEDBACK_EMPTY) + '</div>';
    return;
  }

  box.innerHTML = rows.map(f => {
    const handled = !!f.handled;
    return '<div class="admin-fb-row' + (handled ? ' is-handled' : '') + '" data-id="' + escapeHtml(f.id) + '">' +
        '<div class="admin-fb-head">' +
          '<span class="admin-fb-cat">' + escapeHtml(fbLabel(f.category)) + '</span>' +
          '<span class="admin-fb-user">' + escapeHtml(profileName(f.user_id)) + '</span>' +
          '<span class="admin-fb-time">' + escapeHtml(formatTime(f.created_at)) + '</span>' +
          '<span class="admin-fb-state">' + (handled ? '已处理' : '待处理') + '</span>' +
          '<button type="button" class="admin-fb-toggle" data-id="' + escapeHtml(f.id) + '" ' +
            'data-next="' + (handled ? '0' : '1') + '">' + (handled ? '标记未处理' : '标记已处理') + '</button>' +
        '</div>' +
        '<div class="admin-fb-body">' + escapeHtml(String(f.body == null ? '' : f.body)) + '</div>' +
      '</div>';
  }).join('');

  $$('#adminFeedbackList .admin-fb-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      const makeHandled = btn.dataset.next === '1';
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        // ① 写操作：只能走数据库函数 admin_set_feedback_handled（失败必须让用户看到真实错误）
        await adminSetFeedbackHandled(id, makeHandled);
        toast(makeHandled ? '已标记为已处理' : '已标记为未处理');
        // ② 刷新：与写操作分开——刷新失败 ≠ 操作失败（状态已经落库了）
        try {
          await reloadTable('feedback');
          renderFeedbackList(state);
        } catch (e) {
          // 本地缓存就地更新，让界面至少与服务端一致
          const cached = getFeedback().filter(x => x.id === id)[0];
          if (cached) { cached.handled = makeHandled; }
          try { renderFeedbackList(state); } catch (e2) { /* 渲染失败也不能吞掉上面的提示 */ }
          toast('已生效，刷新页面可见（列表刷新失败：' + ((e && e.message) || e) + '）', 'error');
        }
      } catch (e) {
        toast(e.message || '操作失败', 'error');
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  });
}

/* ---------------- 评论管理 ---------------- */

function renderCommentList(state) {
  const box = document.getElementById('adminCommentList');
  if (!box) return;
  const st = state || {};
  const q = String(st.adminCommentQuery || '').trim().toLowerCase();
  const u = String(st.adminCommentUser || '').trim().toLowerCase();
  const all = getComments();

  const rows = all.filter(c => {
    if (q) {
      const s = getSong(c.song_id);
      const title = String(s ? s.title : '(未知谱面)');
      if (title.toLowerCase().indexOf(q) < 0) return false;
    }
    if (u) {
      const hay = (profileName(c.user_id) + ' ' + String(c.user_id == null ? '' : c.user_id)).toLowerCase();
      if (hay.indexOf(u) < 0) return false;
    }
    return true;
  });

  const cnt = document.getElementById('adminCommentCount');
  if (cnt) cnt.textContent = rows.length + ' / ' + all.length;

  if (!rows.length) {
    box.innerHTML = '<div class="empty dim">' + escapeHtml(COMMENT_EMPTY) + '</div>';
    return;
  }

  box.innerHTML = rows.map(c => {
    const s = getSong(c.song_id);
    const full = String(c.text == null ? '' : c.text);
    const short = full.length > TRUNCATE ? full.slice(0, TRUNCATE) + '…' : full;
    return '<div class="admin-comment-row" data-id="' + escapeHtml(c.id) + '">' +
        '<div class="admin-comment-head">' +
          (s
            ? '<a class="admin-comment-song" href="#/song/' + escapeHtml(s.id) + '">' + escapeHtml(s.title) + '</a>'
            : '<span class="admin-comment-song">' + escapeHtml('(未知谱面) ' + (c.song_id == null ? '' : c.song_id)) + '</span>') +
          '<span class="admin-comment-user">' + escapeHtml(profileName(c.user_id)) + '</span>' +
          '<span class="admin-comment-time">' + escapeHtml(formatTime(c.created_at)) + '</span>' +
          '<button type="button" class="admin-comment-del" data-id="' + escapeHtml(c.id) + '">删除</button>' +
        '</div>' +
        '<div class="admin-comment-text" title="' + escapeHtml(full) + '">' + escapeHtml(short) + '</div>' +
      '</div>';
  }).join('');

  $$('#adminCommentList .admin-comment-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('确定删除这条评论？')) return;
      btn.disabled = true;
      try {
        await adminDeleteComment(id);
        toast('已删除');
        renderCommentList(state);
      } catch (e) {
        toast(e.message || '删除失败', 'error');
        btn.disabled = false;
      }
    });
  });
}

/* ---------------- 用户列表 ---------------- */

function renderUserList(state) {
  const box = document.getElementById('adminUserList');
  if (!box) return;
  const st = state || {};
  const me = currentUser() || {};
  const q = String(st.adminUserQuery || '').trim().toLowerCase();
  const ratings = getRatings();
  const comments = getComments();

  const all = listProfiles();
  const rows = all.filter(p => {
    if (!q) return true;
    return (String(p.nickname || '') + ' ' + String(p.username || '')).toLowerCase().indexOf(q) >= 0;
  });

  const cnt = document.getElementById('adminUserCount');
  if (cnt) cnt.textContent = rows.length + ' / ' + all.length;

  if (!rows.length) {
    box.innerHTML = '<div class="empty dim">' + escapeHtml(USER_EMPTY) + '</div>';
    return;
  }

  box.innerHTML = rows.map(p => {
    const isMe = p.id === me.id;
    const admin = !!p.is_admin;
    const name = p.nickname || p.username || '匿名';
    const rc = ratings.filter(r => r.user_id === p.id).length;
    const cc = comments.filter(c => c.user_id === p.id).length;
    const title = isMe ? ' title="不能修改自己的管理员身份"' : '';
    return '<div class="admin-user-row" data-id="' + escapeHtml(p.id) + '">' +
        '<span class="avatar sm" style="background:' + escapeHtml(safeColor(p.avatar_color)) + '">' +
          escapeHtml(String(name).charAt(0).toUpperCase()) + '</span>' +
        '<div class="admin-user-main">' +
          '<div class="admin-user-name">' + escapeHtml(name) + (isMe ? ' <span class="admin-user-me">（我）</span>' : '') + '</div>' +
          /* ⚠️ title 必须由 JS 写：窄屏下这一行是 `text-overflow: ellipsis` 的单行省略，
             完整邮箱只能靠悬停提示看到。用 CSS `content: attr(...)` 做不到（那要额外属性），
             所以这里直接把原值放进 title —— 它同时也是不用悬停也能读到的无障碍信息。 */
          '<div class="admin-user-mail" title="' + escapeHtml(p.username || '') + '">' + escapeHtml(p.username || '') + '</div>' +
        '</div>' +
        '<div class="admin-user-stats">评分 ' + rc + ' · 评论 ' + cc +
          (p.created_at ? ' · 加入 ' + escapeHtml(formatTime(p.created_at)) : '') + '</div>' +
        '<span class="admin-user-role' + (admin ? ' is-admin' : '') + '">' + (admin ? '管理员' : '普通用户') + '</span>' +
        '<button type="button" class="admin-toggle-admin" data-id="' + escapeHtml(p.id) + '"' +
          (isMe ? ' disabled="disabled"' : '') + title + '>' +
          (admin ? '取消管理员' : '设为管理员') + '</button>' +
      '</div>';
  }).join('');

  $$('#adminUserList .admin-toggle-admin').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (id === (currentUser() || {}).id) return;      // 双保险：连请求都不发
      const p = findProfile(id);
      const name = p ? (p.nickname || p.username || id) : id;
      const makeAdmin = !(p && p.is_admin);
      if (!confirm(makeAdmin ? '确认把「' + name + '」设为管理员？' : '确认取消「' + name + '」的管理员身份？')) return;
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        // ① 写操作：数据库函数 admin_set_admin（失败必须让用户看到真实错误）
        await adminSetAdmin(id, makeAdmin);
        toast(makeAdmin ? '已设为管理员：' + name : '已取消管理员：' + name);
        // ② 刷新：与写操作分开处理——刷新失败 ≠ 操作失败（改已经落库了）
        try {
          await reloadTable('profiles');
          renderUserList(state);
        } catch (e) {
          // 本地缓存里的资料行是同一批对象引用，先就地更新，让界面至少与服务端一致
          const cached = findProfile(id);
          if (cached) cached.is_admin = makeAdmin;
          try { renderUserList(state); } catch (e2) { /* 渲染失败也不能吞掉上面的提示 */ }
          toast('已生效，刷新页面可见（列表刷新失败：' + ((e && e.message) || e) + '）', 'error');
        }
      } catch (e) {
        toast(e.message || '操作失败', 'error');
      } finally {
        // 任何分支都要把按钮复位（重渲染后这个节点已脱离 DOM，赋值无害）
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  });
}
