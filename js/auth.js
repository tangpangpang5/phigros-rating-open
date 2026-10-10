/* =========================================================
 * js/auth.js —— Supabase Auth（邮箱 + 密码），全部走 REST
 * signup / signin / signout / 重发验证邮件 / 当前用户
 * ========================================================= */

import { BEC } from './config.js';
import {
  api, getSession, saveSession, clearSession, normalizeSession, refreshSession,
  currentUid, currentEmail, getProfile, profileName, reloadTable, ApiError,
  reportError
} from './storage.js';

/** 发起 Auth 请求（Auth 端口不需要用户 token，只需 apikey） */
async function authFetch(path, body) {
  if (!BEC) throw new ApiError('后端未启用，无法登录。', 0, 'NO_BACKEND');
  const res = await fetch(BEC.url + path, {
    method: 'POST',
    headers: { 'apikey': BEC.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
    const err = new ApiError(String(msg), res.status, data && (data.error_code || data.code));
    err.raw = data;
    throw err;
  }
  return data;
}

/** 注册：Supabase 若开启邮箱确认，返回的会话为空 → 需要去邮箱点链接 */
export async function signUp(email, password, nickname) {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new ApiError('请输入正确的邮箱地址。', 0, 'BAD_EMAIL');
  if (String(password || '').length < 6) throw new ApiError('密码至少 6 位。', 0, 'BAD_PASSWORD');
  const data = await authFetch('/auth/v1/signup', {
    email: mail,
    password: String(password),
    data: { nickname: String(nickname || '').trim() || mail.split('@')[0] },
    /* ⚠️ 必须显式带上落点（所有者报告：确认邮件把人送到 localhost:3000）：
       不带这个参数时，确认链接的落点由 Supabase 的 **Site URL** 决定 —— 那是个
       控制台里的配置项，一旦还停在开发地址（如 localhost:3000），**每个新用户注册完
       都会卡在「拒绝连接」**，而前端代码里看不出任何问题。
       这里固定成「当前站点自己的地址」：线上就是 pages.dev 域名、本地就是 localhost:8000，
       于是**不再依赖控制台配置是否正确**。
       注意：该地址必须在 Supabase 的 Redirect URLs 白名单里，否则会被回退到 Site URL。 */
    options: { emailRedirectTo: location.origin + location.pathname }
  });
  const session = normalizeSession(data);
  if (session) {
    saveSession(session);
    await refreshProfile();
    return { needsConfirm: false, user: currentUser() };
  }
  return { needsConfirm: true, email: mail };
}

/** 登录 */
export async function signIn(email, password) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) throw new ApiError('请输入邮箱。', 0, 'BAD_EMAIL');
  if (!password) throw new ApiError('请输入密码。', 0, 'BAD_PASSWORD');
  const data = await authFetch('/auth/v1/token?grant_type=password', {
    email: mail,
    password: String(password)
  });
  const session = normalizeSession(data);
  if (!session) throw new ApiError('登录失败：未取得会话。', 0, 'NO_SESSION');
  if (data.user && data.user.email_confirmed_at === null && data.user.confirmed_at === null) {
    // 允许登录但温和提示（是否允许由 Supabase 设置决定）
    console.warn('[dsh] 该邮箱尚未确认');
  }
  saveSession(session);
  await refreshProfile();
  return currentUser();
}

/** 退出登录 */
export async function signOutUser() {
  const s = getSession();
  if (BEC && s) {
    try { await authFetch('/auth/v1/logout', {}); } catch (e) { /* 忽略远端错误 */ }
  }
  clearSession();
}

/** 重发验证邮件 */
export async function resendConfirm(email) {
  const mail = String(email || currentEmail() || '').trim().toLowerCase();
  if (!mail) throw new ApiError('缺少邮箱地址。', 0, 'BAD_EMAIL');
  await authFetch('/auth/v1/resend', { type: 'signup', email: mail });
  return mail;
}

/** 忘记密码：发重置邮件 */
export async function sendReset(email) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) throw new ApiError('缺少邮箱地址。', 0, 'BAD_EMAIL');
  const res = await fetch(BEC.url + '/auth/v1/recover', {
    method: 'POST',
    headers: { 'apikey': BEC.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: mail })
  });
  if (!res.ok) throw new ApiError('重置邮件发送失败（HTTP ' + res.status + '）', res.status);
  return mail;
}

/** 用当前会话拉自己的资料行（注册触发器可能还没落库，容错重试一次） */
export async function refreshProfile() {
  const uid = currentUid();
  if (!uid || !BEC) return null;
  for (let i = 0; i < 2; i++) {
    try {
      await reloadTable('profiles');
      const p = getProfile(uid);
      if (p) return p;
    } catch (e) {
      console.error('[dsh] refreshProfile', e);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return getProfile(uid);
}

/** 当前登录用户（合并会话 + 资料行） */
export function currentUser() {
  const uid = currentUid();
  if (!uid) return null;
  const p = getProfile(uid);
  return {
    id: uid,
    email: (p && p.username) || currentEmail() || '',
    nickname: (p && p.nickname) || profileName(uid),
    avatar_color: (p && p.avatar_color) || '#6c5ce7',
    is_admin: !!(p && p.is_admin)
  };
}

export function isLoggedIn() { return !!currentUid(); }

/** 管理员判定：只看数据库 is_admin 字段 */
export function isAdmin() {
  const p = getProfile(currentUid());
  return !!(p && p.is_admin);
}

/** 启动时恢复会话：必要时续期 + 拉资料 */
export async function initAuth() {
  if (!BEC) return null;
  let s = getSession();
  if (!s) return null;
  if (!s.expires_at || s.expires_at - Date.now() < 60000) {
    s = await refreshSession();
  }
  if (!s) return null;
  try {
    await refreshProfile();
  } catch (e) {
    console.error('[dsh] initAuth', e);
  }
  return currentUser();
}

export { reportError };
