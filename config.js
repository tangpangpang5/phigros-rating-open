/* =========================================================
 * config.js —— 后端开关与连接信息
 *
 * 用法：
 *   1) 先在 Supabase 建项目，整段执行 supabase-setup.sql（建表 + 权限策略 + 限频）；
 *   2) 到 Supabase → Settings → API 复制 Project URL 与 publishable（anon）公钥，
 *      填到下面两行，并把 enabled 改成 true；
 *   3) 刷新页面即为「全站共享」模式。
 *
 * ⚠️ 只能填 publishable / anon 公钥。它本来就是给浏览器用的，公开不算泄密；
 *    真正的防线是数据库里的 RLS 策略。
 * ⚠️ 绝对不要填 service_role / secret 密钥 —— 那等于把数据库钥匙发到每个访客手里。
 * ========================================================= */
window.PHIGROS_BACKEND = {
  enabled: false,                                  /* 填好下面两项后改成 true */
  url: 'https://<你的项目ref>.supabase.co',          /* Supabase → Settings → API → Project URL */
  anonKey: '<你的 publishable / anon 公钥>'          /* sb_publishable_... */
};
