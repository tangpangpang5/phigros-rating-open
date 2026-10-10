/* =========================================================
 * js/main.js —— 入口：按顺序初始化并启动路由
 * 加载顺序：配置 → 界面控件 → 曲库 → 后端数据 → 会话 → 路由
 * ========================================================= */

import { BEC, reportError, reportNotice, fail } from './config.js';
import { loadSongs } from './songs.js';
import { bootstrapData, isReadOnly, legacyLocalUsers } from './storage.js';
import { initAuth } from './auth.js';
import { initUI, router, toast } from './ui.js';

let started = false;

/* ---------- 首屏载入态（Phigros 加载页语言：斜切黑面板 + 白字 + 白色斜切块）----------
   为什么用 class 而不是把标记写进 #main 的 innerHTML：
   下面第 3 步有 `if (mainEl && !mainEl.innerHTML.trim())` 的判断，写进去会让它误判"已有内容"。
   改成给 <html> 加 is-booting，面板完全由 CSS 的 ::before/::after 绘制（零额外 DOM 节点），
   就绪后由 hideBoot() 去掉 class —— 曲库渲染与路由都不受影响。 */
function hideBoot() {
  try { document.documentElement.classList.remove('is-booting'); } catch (e) { /* 忽略 */ }
}

async function init() {
  if (started) return;
  started = true;
  document.documentElement.classList.add('is-booting');

  // 1) 配置检查
  const raw = window.PHIGROS_BACKEND;
  if (raw && raw.enabled && !BEC) {
    reportError('后端配置不完整', 'config.js 里的 url / anonKey 没填全，当前只能以只读演示模式运行。');
  }

  // 2) 界面静态控件（主题、外观、侧栏、设置）
  initUI();

  // 3) 曲库
  const mainEl = document.getElementById('main');
  if (mainEl && !mainEl.innerHTML.trim()) mainEl.innerHTML = '<div class="empty">正在载入曲库…</div>';
  try {
    await loadSongs();
  } catch (e) {
    fail('曲库 songs.json 加载失败', e);
  }

  // 4) 后端数据（失败时自动退回只读演示数据）
  try {
    await bootstrapData();
  } catch (e) {
    fail('后端数据读取失败', e);
  }

  // 5) 旧版本遗留本地账号的一次性提示
  const legacy = legacyLocalUsers();
  if (legacy) {
    reportNotice(
      '检测到旧版本遗留的本地账号数据（' + legacy.count + ' 个）。新版已改为 <b>邮箱 + 密码</b> 登录，' +
      '旧账号无法继续使用，请用邮箱重新注册一个。',
      'legacy_accounts');
  }

  // 6) 恢复登录会话（必要时自动续期）
  try {
    await initAuth();
  } catch (e) {
    console.error('[dsh] initAuth', e);
  }

  if (isReadOnly()) {
    reportNotice('当前是 <b>只读演示模式</b>：未连接 Supabase，可以浏览曲库与已有数据，' +
      '但不能注册 / 登录 / 打分 / 评论。', null);
  }

  // 7) 路由
  window.addEventListener('hashchange', router);
  router();
  hideBoot();          // 首屏载入态到此结束（曲库与路由都已就绪）
}

window.PhigrosApp = { init, router, toast, hideBoot };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
