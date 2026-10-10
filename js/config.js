/* =========================================================
 * js/config.js —— 配置与统一错误提示
 * 读取 index.html 里经典脚本 config.js 注入的 window.PHIGROS_BACKEND
 * （用 typeof 守卫，使整套模块在 node --test 下也能被 import —— 无浏览器时视为未配置后端）
 * ========================================================= */

const RAW = (typeof window !== 'undefined' && window.PHIGROS_BACKEND) || {};
export const SUPA_URL = (RAW.url || '').replace(/\/+$/, '');
export const SUPA_KEY = RAW.anonKey || '';
export const BACKEND_ENABLED = !!RAW.enabled;
/** 后端可用：开关打开且 URL/key 齐全 */
export const BEC = (BACKEND_ENABLED && SUPA_URL && SUPA_KEY) ? { url: SUPA_URL, key: SUPA_KEY } : null;

/** 顶部常驻错误横幅（点击关闭） */
export function reportError(title, detail) {
  let bar = document.getElementById('dshBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dshBanner';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:58px;left:12px;right:12px;margin:0 auto;max-width:820px;' +
      'z-index:999;background:#fff7f6;color:#9e1c12;border:1px solid #eec2bd;border-radius:10px;' +
      'padding:10px 14px;font-size:13px;line-height:1.6;box-shadow:0 6px 18px rgba(0,0,0,.14);' +
      'white-space:pre-wrap;word-break:break-word;cursor:pointer;' +
      'font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif;';
    bar.title = '点击关闭';
    bar.addEventListener('click', () => bar.remove());
    document.body.appendChild(bar);
  }
  bar.textContent = '⚠ ' + title + (detail ? '\n' + detail : '');
}

/** 顶部提示条（信息性质，例如只读模式 / 旧账号提示） */
export function reportNotice(html, key) {
  if (key) {
    try { if (localStorage.getItem('dsh_dismissed_' + key) === '1') return; } catch (e) { /* 忽略 */ }
  }
  let bar = document.getElementById('dshNotice');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dshNotice';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:998;background:#1d1d1f;color:#f5f5f7;' +
      'padding:10px 16px;font-size:13px;line-height:1.6;display:flex;gap:10px;align-items:center;' +
      'justify-content:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif;';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '<span>' + html + '</span>';
  const btn = document.createElement('button');
  btn.textContent = '知道了';
  btn.style.cssText = 'background:transparent;border:1px solid #f5f5f7;color:#f5f5f7;border-radius:999px;' +
    'padding:2px 12px;cursor:pointer;font-size:12px;';
  btn.addEventListener('click', () => {
    if (key) { try { localStorage.setItem('dsh_dismissed_' + key, '1'); } catch (e) { /* 忽略 */ } }
    bar.remove();
  });
  bar.appendChild(btn);
}

/** 控制台详细日志 + 界面友好提示 */
export function fail(where, err) {
  console.error('[dsh]', where, err);
  const msg = (err && err.message) ? err.message : String(err);
  let hint = '';
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    hint = '网络或跨域问题：请用 http(s) 打开页面（不要双击 file://），并确认能访问 Supabase。';
  } else if (/Email not confirmed/i.test(msg)) {
    hint = '邮箱尚未确认：请到邮箱点确认链接，或用「重发验证邮件」。';
  } else if (/Invalid login credentials/i.test(msg)) {
    hint = '邮箱或密码不正确。';
  } else if (/row-level security/i.test(msg)) {
    hint = '数据库安全策略拒绝了本次写入：请确认已登录，且已执行最新的 supabase-setup.sql。';
  } else if (/relation .* does not exist/i.test(msg)) {
    hint = '数据表不存在：请在 Supabase SQL Editor 执行 supabase-setup.sql。';
  }
  reportError(where + '：' + msg, hint);
}
