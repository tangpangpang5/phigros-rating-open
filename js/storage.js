/* =========================================================
 * js/storage.js —— Supabase REST 客户端 + 会话持久化 + 数据缓存
 * 不依赖任何 SDK，全部手写 fetch
 * ========================================================= */

import { BEC, reportError, fail } from './config.js';

/* 谱面难度档位的唯一真源（与 js/songs.js 的 difficulties[].level、DB 的 CHECK 约束三处必须一致）。
   放在这里而不是从 songs.js 导入：storage.js 是数据层，不该依赖曲库模块。 */
const DIFF_LEVELS = ['EZ', 'HD', 'IN', 'AT'];

/* ---------------- 会话（Supabase Auth） ---------------- */

const SESSION_KEY = 'dsh_session';
const LEGACY_SESSION_KEY = 'phi_session';

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.access_token) ? s : null;
  } catch (e) { return null; }
}

export function saveSession(s) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch (e) { /* 忽略 */ }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch (e) { /* 忽略 */ }
}

export function currentUid() { const s = getSession(); return s ? s.user_id : null; }
export function currentEmail() { const s = getSession(); return s ? s.email : null; }

/** 把 GoTrue 返回的 token 响应统一成我们的会话结构 */
export function normalizeSession(tok) {
  if (!tok || !tok.access_token) return null;
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: Date.now() + ((tok.expires_in || 3600) * 1000),
    user_id: (tok.user && tok.user.id) || tok.user_id || null,
    email: (tok.user && tok.user.email) || null
  };
}

export async function refreshSession() {
  const s = getSession();
  if (!BEC || !s || !s.refresh_token) return null;
  try {
    const res = await fetch(BEC.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': BEC.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    if (!res.ok) { clearSession(); return null; }
    const tok = await res.json();
    const next = normalizeSession(tok);
    if (next) { saveSession(next); return next; }
    clearSession();
    return null;
  } catch (e) {
    console.error('[dsh] refreshSession', e);
    return null;
  }
}

/** 过期前 60 秒自动续期 */
async function ensureFreshToken() {
  const s = getSession();
  if (!s) return null;
  if (s.expires_at && s.expires_at - Date.now() > 60000) return s;
  const next = await refreshSession();
  return next || s;
}

/* ---------------- 通用 REST 请求 ---------------- */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function rawFetch(path, opts, token) {
  const headers = Object.assign({
    'apikey': BEC.key,
    'Authorization': 'Bearer ' + (token || BEC.key)
  }, (opts && opts.headers) || {});
  if (opts && opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(BEC.url + path, Object.assign({}, opts, { headers }));
}

/**
 * 调用 Supabase（path 形如 /rest/v1/ratings?... 或 /auth/v1/token?...）
 * 已登录时自动带上用户 access_token；401 时自动续期重试一次。
 */
export async function api(path, opts) {
  if (!BEC) throw new ApiError('后端未启用', 0, 'NO_BACKEND');
  const s = await ensureFreshToken();
  let res = await rawFetch(path, opts, s && s.access_token);
  if (res.status === 401 && s && s.refresh_token) {
    const next = await refreshSession();
    if (next) res = await rawFetch(path, opts, next.access_token);
  }
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }
  if (!res.ok) {
    const msg = (body && (body.message || body.msg || body.error_description || body.error || body.hint)) || ('HTTP ' + res.status);
    throw new ApiError(String(msg), res.status, body && body.code);
  }
  return body;
}

/* ---------------- 数据缓存（只读镜像） ---------------- */

const DB = { profiles: [], ratings: [], comments: [], feedback: [], readOnly: !BEC };

export function isReadOnly() { return DB.readOnly; }
export function getProfiles() { return DB.profiles; }

export function getProfile(id) {
  if (!id) return null;
  return DB.profiles.find(p => p.id === id) || null;
}

/** 昵称展示：查不到（旧数据/已注销）时统一显示 */
export function profileName(id) {
  const p = getProfile(id);
  if (!p) return '已注销用户';
  return p.nickname || p.username || '匿名';
}

export function getRatings() { return DB.ratings; }
export function getComments() { return DB.comments; }

/* ---------------- 反馈（feedback） ----------------
 * 可见范围由数据库 RLS 决定：普通登录用户只拿得到**自己**的反馈，
 * 管理员拿得到全部。因此前端不需要、也不应该自己过滤权限 ——
 * 这里的 `getFeedback()` 返回什么，完全等于服务端允许它看到什么。
 * 注意只读演示模式（无后端）下 feedback 恒为空数组。 */

export function getFeedback() { return DB.feedback; }

export function myFeedback() {
  const uid = currentUid();
  if (!uid) return [];
  return DB.feedback.filter(f => f.user_id === uid);
}

/** 管理员用：未处理条数（非管理员因 RLS 看不到别人的，天然只会算到自己的） */
export function unhandledFeedbackCount() {
  return DB.feedback.filter(f => !f.handled).length;
}

export function getRatingsFor(songId) { return DB.ratings.filter(r => r.song_id === songId); }
export function ratingCount(songId) { return getRatingsFor(songId).length; }

export function avgScore(songId) {
  const rs = getRatingsFor(songId);
  if (!rs.length) return 0;
  return rs.reduce((a, r) => a + (Number(r.score) || 0), 0) / rs.length;
}

export function myRating(songId) {
  const uid = currentUid();
  if (!uid) return null;
  return DB.ratings.find(r => r.song_id === songId && r.user_id === uid) || null;
}

export function getCommentsFor(songId) {
  return DB.comments
    .filter(c => c.song_id === songId)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function myCommentCount() {
  const uid = currentUid();
  if (!uid) return 0;
  return DB.comments.filter(c => c.user_id === uid).length;
}

export function myRatingCount() {
  const uid = currentUid();
  if (!uid) return 0;
  return DB.ratings.filter(r => r.user_id === uid).length;
}

/* ---------------- 拉取数据 ---------------- */

const FEEDBACK_SELECT = '/rest/v1/feedback?select=id,user_id,category,body,created_at,handled,handled_at&order=created_at.desc';

/** 拉反馈表（RLS 决定可见范围：本人 / 管理员全部） */
async function fetchFeedback() {
  const rows = await api(FEEDBACK_SELECT);
  return Array.isArray(rows) ? rows : [];
}

export async function bootstrapData() {
  if (!BEC) {
    // 无后端：只读演示数据（来自 data.js 的种子）
    DB.profiles = (window.PHIGROS_SEED_PROFILES || []).slice();
    DB.ratings = (window.PHIGROS_SEED_RATINGS || []).slice();
    DB.comments = (window.PHIGROS_SEED_COMMENTS || []).slice();
    DB.readOnly = true;
    return DB;
  }
  try {
    const [profiles, ratings, comments, feedback] = await Promise.all([
      api('/rest/v1/profiles?select=id,username,nickname,avatar_color,is_admin'),
      api('/rest/v1/ratings?select=id,song_id,user_id,score,created_at,updated_at'),
      api('/rest/v1/comments?select=id,song_id,user_id,text,created_at,difficulty&order=created_at.desc'),
      // 反馈拉取失败**不能让整站降级成只读演示模式**（例如后端脚本还没跑、表尚不存在）。
      // 反馈是附加功能：拿不到就当空，其余照常。
      fetchFeedback().catch(() => [])
    ]);
    DB.profiles = Array.isArray(profiles) ? profiles : [];
    DB.ratings = Array.isArray(ratings) ? ratings : [];
    DB.comments = Array.isArray(comments) ? comments : [];
    DB.feedback = Array.isArray(feedback) ? feedback : [];
    DB.readOnly = false;
    return DB;
  } catch (e) {
    // 读取失败：退回只读演示数据，避免误以为可以写入
    DB.readOnly = true;
    DB.profiles = (window.PHIGROS_SEED_PROFILES || []).slice();
    DB.ratings = (window.PHIGROS_SEED_RATINGS || []).slice();
    DB.comments = (window.PHIGROS_SEED_COMMENTS || []).slice();
    throw e;
  }
}

/** 只重新拉表（写入后用，避免整页重载） */
export async function reloadTable(which) {
  if (!BEC) return;
  if (which === 'ratings') {
    DB.ratings = await api('/rest/v1/ratings?select=id,song_id,user_id,score,created_at,updated_at') || [];
  } else if (which === 'comments') {
    DB.comments = await api('/rest/v1/comments?select=id,song_id,user_id,text,created_at,difficulty&order=created_at.desc') || [];
  } else if (which === 'profiles') {
    DB.profiles = await api('/rest/v1/profiles?select=id,username,nickname,avatar_color,is_admin') || [];
  } else if (which === 'feedback') {
    DB.feedback = await fetchFeedback();
  }
}

function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function requireLogin() {
  if (DB.readOnly) throw new ApiError('当前是只读演示模式，无法写入。', 0, 'READ_ONLY');
  const uid = currentUid();
  if (!uid) throw new ApiError('请先登录账号。', 401, 'NOT_LOGGED_IN');
  return uid;
}

/* ---------------- 写入 ---------------- */

export async function setRating(songId, score) {
  const uid = requireLogin();
  const s = Math.max(1, Math.min(10, Math.round(Number(score))));
  const exist = DB.ratings.find(r => r.song_id === songId && r.user_id === uid);
  try {
    if (exist) {
      await api('/rest/v1/ratings?id=eq.' + encodeURIComponent(exist.id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({ score: s, updated_at: Date.now() })
      });
      exist.score = s;
      exist.updated_at = Date.now();
    } else {
      const row = { id: rid('r'), song_id: songId, user_id: uid, score: s, created_at: Date.now(), updated_at: Date.now() };
      await api('/rest/v1/ratings', {
        method: 'POST',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(row)
      });
      DB.ratings.push(row);
    }
    return getRatingsFor(songId);
  } catch (e) {
    fail('评分保存失败', e);
    throw e;
  }
}

export async function addComment(songId, text, difficulty) {
  const uid = requireLogin();
  const body = String(text || '').trim();
  if (!body) throw new ApiError('评论内容不能为空。', 0, 'EMPTY');
  if (body.length > 500) throw new ApiError('评论最多 500 字。', 0, 'TOO_LONG');
  /* 评论要固化「发表时所在的难度」（2026-10 需求）：
     存下来才能让一条评论永远指向它当时评的那张谱面，而不是跟着页面当前选择变。
     ⚠️ 白名单校验放在这里（信任边界）：非 EZ/HD/IN/AT 一律存 null，
        不把调用方传进来的任意字符串写进库；库里另有一条 CHECK 约束兜底。 */
  const diff = DIFF_LEVELS.indexOf(difficulty) >= 0 ? difficulty : null;
  const row = { id: rid('c'), song_id: songId, user_id: uid, text: body, created_at: Date.now(), difficulty: diff };
  try {
    await api('/rest/v1/comments', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(row)
    });
    DB.comments.unshift(row);
    return row;
  } catch (e) {
    fail('评论发布失败', e);
    throw e;
  }
}

export async function deleteComment(id) {
  requireLogin();
  try {
    await api('/rest/v1/comments?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    DB.comments = DB.comments.filter(c => c.id !== id);
  } catch (e) {
    fail('评论删除失败', e);
    throw e;
  }
}

/* ---------------- 反馈（写入） ---------------- */

/** 反馈分类白名单（与数据库 check 约束保持一致，两边不同步会被后端拒绝） */
export const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: '问题 / 故障' },
  { value: 'suggestion', label: '建议 / 想法' },
  { value: 'other', label: '其他' }
];

export const FEEDBACK_MIN = 10;
export const FEEDBACK_MAX = 500;

/**
 * 按**字符**计数，而不是 String.length。
 * 为什么必须这样（评审发现的边界不一致）：
 *   · JS 的 `String.length` 数的是 **UTF-16 码元**，一个 emoji（如 😀）算 2；
 *   · Postgres 的 `char_length(body)` 数的是**字符**，同一个 emoji 算 1。
 * 于是「用户以为刚好 500 字、其实多数几个 emoji」时：前端放行 → 数据库用 23514 拒绝
 * → 用户看到的是**英文的 Postgres 原文**（`violates check constraint ...`），极不友好。
 * 用 Array.from 按码点切分即可与 char_length 对齐（对常见 emoji 与中文都正确）。
 */
export function charLen(str) {
  return Array.from(String(str == null ? '' : str)).length;
}

/**
 * 提交反馈。只有登录用户能提交（未登录由 requireLogin 拦下，数据库侧 RLS 与触发器也会拒）。
 * 刻意**不发送 id / created_at / handled**：这三项由数据库默认值生成
 *   · id → gen_random_uuid()（避免客户端可预测的主键）
 *   · created_at → 服务端时间（避免客户端时钟被改而污染「60 秒限频」窗口）
 *   · handled → false
 * 因此返回的 row 需要以数据库实际写入的行为准 → 写入后重新拉一次表。
 */
export async function submitFeedback(category, body) {
  const uid = requireLogin();
  const cat = String(category || '').trim();
  if (!FEEDBACK_CATEGORIES.some(c => c.value === cat)) {
    throw new ApiError('请选择反馈类型。', 0, 'BAD_CATEGORY');
  }
  const text = String(body == null ? '' : body).trim();
  const n = charLen(text);
  if (n < FEEDBACK_MIN) throw new ApiError('反馈内容至少 ' + FEEDBACK_MIN + ' 个字（当前 ' + n + ' 个）。', 0, 'TOO_SHORT');
  if (n > FEEDBACK_MAX) throw new ApiError('反馈内容最多 ' + FEEDBACK_MAX + ' 个字（当前 ' + n + ' 个）。', 0, 'TOO_LONG');

  const row = { user_id: uid, category: cat, body: text };
  try {
    await api('/rest/v1/feedback', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(row)
    });
    // 重新拉表，拿到服务端生成的 id / created_at
    try { await reloadTable('feedback'); } catch (e) { /* 拉取失败不影响「提交成功」这个事实 */ }
    return true;
  } catch (e) {
    fail('反馈提交失败', e);
    throw e;
  }
}

/**
 * 标记反馈已处理 / 未处理：只能走数据库函数 public.admin_set_feedback_handled(feedback_id, make_handled)。
 * 前端没有任何直接 update public.feedback 的路径（表上也没有 update 的 RLS 策略给非管理员）。
 */
export async function adminSetFeedbackHandled(feedbackId, makeHandled) {
  requireLogin();
  const body = { feedback_id: feedbackId == null ? '' : String(feedbackId), make_handled: !!makeHandled };
  try {
    const res = await api('/rest/v1/rpc/admin_set_feedback_handled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return !!res;
  } catch (e) {
    fail('反馈状态修改失败', e);
    throw e;
  }
}

/* ---------------- 管理员（提权只能走数据库函数） ---------------- */

/** 全量资料副本（管理员后台用户列表用；不暴露 DB 内部数组） */
export function listProfiles() { return DB.profiles.slice(); }

/** 按 id 取资料行（等同 getProfile，名字固定给后台用） */
export function findProfile(id) { return getProfile(id); }

/**
 * 提权 / 降权：调用数据库函数 public.admin_set_admin(target_id, make_admin)。
 * 成功后返回布尔（设为管理员 → true）；失败抛 ApiError（后端原文，便于界面 toast）。
 * 前端没有任何直接改 public.users.is_admin 的路径。
 */
export async function adminSetAdmin(targetId, makeAdmin) {
  requireLogin();
  const body = { target_id: targetId == null ? '' : String(targetId), make_admin: !!makeAdmin };
  try {
    const res = await api('/rest/v1/rpc/admin_set_admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return !!res;
  } catch (e) {
    fail('管理员身份修改失败', e);
    throw e;
  }
}

/** 删除任意评论（管理员用）：与 deleteComment 走同一条 RLS 与同一个请求 */
export async function adminDeleteComment(id) {
  return deleteComment(id);
}

/** 旧版本遗留的本地账号（用于一次性提示，不参与登录） */
export function legacyLocalUsers() {
  for (const k of ['pg_users', 'dsh_users', 'phi_users']) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return { key: k, count: arr.length };
    } catch (e) { /* 忽略 */ }
  }
  return null;
}

export { reportError };
