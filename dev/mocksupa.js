/* 开发用：极简 Supabase 模拟服务（Auth + PostgREST 子集），仅用于本地自测
 * 运行：node dev/mocksupa.js   →  http://127.0.0.1:8123
 * 定位：**旧策略替身**（加固前的数据库语义）——故意没有列级权限检查，
 *       用来给 B1「is_admin 自提权漏洞确实存在」做对照。
 *       加固后的语义由 `dev/mocksupa-rpc.js`（8124）模拟；「必须被拒」的拒绝矩阵用它来验。
 * 说明：会像真 Supabase 一样要求 Authorization: Bearer <access_token>，
 *       没有 token 的写入一律返回 42501（row-level security）错误。
 *
 * ============================ 夹具使用矩阵（本仓约定） ============================
 * 端口角色（谁打哪个端口，不允许混用）：
 *   · 8123  本文件，**旧策略对照组**          （旧策略下自提权会成功 —— 这就是对照组的意义）
 *                                              ← `dev/test-auth.html`、`dev/test-ui.html`（必须用**干净启动的空库** 8123）
 *   · 8124  `dev/mocksupa-rpc.js`，**加固版**     ← `dev/test-rank-admin.html`（列级权限 + admin_set_admin 守卫 + 预置 root/user1）
 *   · 8125  本文件，**空库第三实例**           （榜单用例；只做受控数据，不依赖旧/加固语义；本仓没有对应的用例页）
 * 启动方式（端口用环境变量覆盖，避免并行时互相踩状态）：
 *   MOCK_PORT=8123 node dev/mocksupa.js                        # 空库（默认；回归基线必须是这样）
 *   MOCK_PORT=8124 node dev/mocksupa-rpc.js                    # 加固版
 *   MOCK_PORT=8125 node dev/mocksupa.js                        # 空库第三实例
 *   MOCK_PORT=8125 MOCK_SEED_DATA=1 node dev/mocksupa.js       # 预置站点所有者管理员（本文件一般不需要）
 * 硬性注意：
 *   1) `dev/test-auth.html` / `dev/test-ui.html` 断言「profiles 初始为空」「平均分唯一」「评论数 1」，
 *      **必须**跑在干净启动的 8123；预置数据或复用实例会让它们失败（会把平均分污染成 7.5/6.5）。
 *   2) `/_test/reset` 只复位预置 users 行的 is_admin，**不清 authUsers**；
 *      要复现干净的 24/24、30/30 必须**重启进程**（先按端口持有者强杀，再校验 PID 变化）。
 *   3) 本文件是他人对照基线，**不得**给它加列级权限拒绝：那会让它失去「旧策略对照组」的意义。
 *      加固语义一律加在 `dev/mocksupa-rpc.js`。
 *   4) 夹具（`dev/mocksupa*.js` 与 `dev/test-*.html` / `dev/test-rank.js`）由本仓统一维护，改动前请先开 Issue 说明。
 * ================================================================================================ */
const http = require('http');
/* 端口可用环境变量覆盖：多个人/多个用例并行时各自起一个互不干扰的实例
   例：MOCK_PORT=8125 node dev/mocksupa.js ；MOCK_PORT=8125 MOCK_SEED_DATA=1 node dev/mocksupa.js */
const PORT = Number(process.env.MOCK_PORT || 8123);

const DB = { authUsers: [], profiles: [], ratings: [], comments: [], users: [] };
const TOKENS = new Map();       // access/refresh token -> user id
let seq = 0;
const uid = () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
const tok = (p) => p + '_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/* 预置「已有资料行、但从未登录」的用户：
   真库里 public.users 是登录用户的资料表，探测「自提权」时需要先有一条 users 行，
   而账号本身在 auth.users（这里没有对应密码，登录不了）。 */
const SEED_USER_IDS = [
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a002',
  '00000000-0000-4000-8000-00000000a003'
];
SEED_USER_IDS.forEach((id, i) => {
  DB.users.push({
    id,
    username: 'seeduser' + (i + 1) + '@example.com',
    nickname: '种子用户' + (i + 1),
    avatar_color: '#6c5ce7',
    is_admin: false,
    created_at: 1700000000000 + i
  });
});

/* 预置「站点所有者」管理员账号：对应真库里「已注册并已在 SQL Editor 里手工提权」的那一个账号。
   管理员后台/提权用例需要一个本来就存在的管理员才能测（否则谁也没权限提权谁）。
   ⚠ 默认不加载 —— 既有 dev/test-auth.html / dev/test-ui.html 依赖「空库」基线（profiles 初始为空、
     评论数为 1、平均分唯一），预置行会破坏它们。需要基线的用例用：
       MOCK_SEED_DATA=1 node dev/mocksupa.js
     打开；默认启动仍是完全空库。 */
const SEED_ON = process.env.MOCK_SEED_DATA === '1';
const SEED_ADMIN = {
  id: '00000000-0000-4000-8000-00000000ad01',
  email: 'owner@example.com',
  password: 'owner-pw-123',
  nickname: '站点所有者',
  avatar_color: '#6c5ce7'
};
if (SEED_ON) {
  DB.authUsers.push({ id: SEED_ADMIN.id, email: SEED_ADMIN.email, password: SEED_ADMIN.password });
  DB.users.push({
    id: SEED_ADMIN.id, username: SEED_ADMIN.email, nickname: SEED_ADMIN.nickname,
    avatar_color: SEED_ADMIN.avatar_color, is_admin: true, created_at: 1699999999000
  });
  DB.profiles.push({
    id: SEED_ADMIN.id, username: SEED_ADMIN.email, nickname: SEED_ADMIN.nickname,
    avatar_color: SEED_ADMIN.avatar_color, is_admin: true, created_at: 1699999999000
  });
  console.log('[mock] MOCK_SEED_DATA=1 → 预置站点所有者 ' + SEED_ADMIN.email + ' (管理员)');
} else {
  console.log('[mock] 空库启动（默认）。需要预置管理员的用例请用 MOCK_SEED_DATA=1 启动');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
};

function send(res, code, obj) {
  const head = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS);
  res.writeHead(code, head);
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
const rlsError = (table) => ({
  code: '42501',
  message: 'new row violates row-level security policy for table "' + table + '"'
});

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
function userIdOf(req) {
  const t = bearer(req);
  return t ? (TOKENS.get(t) || null) : null;
}

/** 解析 PostgREST 风格的查询串：id=eq.x、order=created_at.desc、select/limit 忽略 */
function filterRows(rows, query) {
  let out = rows.slice();
  const params = new URLSearchParams(query || '');
  for (const [k, v] of params) {
    if (k === 'select' || k === 'limit' || k === 'apikey') continue;
    if (k === 'order') {
      const [col, dir] = v.split('.');
      out.sort((a, b) => (dir === 'desc' ? -1 : 1) * ((b[col] || 0) - (a[col] || 0)));
      continue;
    }
    if (v.startsWith('eq.')) {
      const want = v.slice(3);
      out = out.filter(r => String(r[k]) === want);
    }
  }
  return out;
}

/** 判断某个用户是不是管理员（真库里等价于 public.is_admin()） */
function isAdminId(id) {
  const p = DB.profiles.find(x => x.id === id);
  return !!(p && p.is_admin === true);
}

const server = http.createServer(async (req, res) => {
  const [path, query] = (req.url || '/').split('?');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {};
  const uidOfReq = userIdOf(req);

  /* ---------- 测试辅助：把预置 users 行的 is_admin 复位（仅本地探测用） ---------- */
  if (path === '/_test/reset' && req.method === 'POST') {
    SEED_USER_IDS.forEach(id => {
      const u = DB.users.find(x => x.id === id);
      if (u) u.is_admin = false;
      const p = DB.profiles.find(x => x.id === id);   // users.is_admin 变更会镜像到 profiles，复位时同步
      if (p) p.is_admin = false;
    });
    return send(res, 200, { ok: true });
  }

  /* ---------- 测试辅助:给预置账号设置已知密码（仅本地测试用；真 Supabase 无此端点） ---------- */
  if (path === '/_test/set-password' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    const u = DB.authUsers.find(x => x.email === email);
    if (!u) return send(res, 404, { message: 'no auth user for ' + email });
    u.password = String(body.password || '');
    return send(res, 200, { ok: true, email: email });
  }

  /* ---------- RPC：POST /rest/v1/rpc/<fn> ----------
   * 目前只实现 admin_set_admin(target_id, make_admin)，语义与 supabase-setup.sql 里的
   * public.admin_set_admin 对齐：
   *   · 未登录 → 拒绝
   *   · 改自己（target_id = auth.uid()）→ 拒绝
   *   · 调用者不是管理员 → 拒绝
   *   · 目标不存在 → 报错
   *   · 降级的目标原本不是管理员 → 报错
   * 返回 200 + 布尔（提权 true / 降权 false），与 PostgREST 的 /rpc 行为一致。
   */
  if (path.indexOf('/rest/v1/rpc/') === 0) {
    const fn = path.slice('/rest/v1/rpc/'.length);
    if (fn !== 'admin_set_admin') {
      return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.' + fn });
    }
    if (req.method !== 'POST') return send(res, 405, { message: 'Method Not Allowed' });
    const target = body.target_id == null ? '' : String(body.target_id);
    const makeAdmin = body.make_admin === true || body.make_admin === 'true';
    if (!uidOfReq) return send(res, 403, { code: '42501', message: '未登录：请先登录管理员账号' });
    if (!target) return send(res, 400, { code: '22023', message: '缺少目标用户 id' });
    if (target === uidOfReq) return send(res, 403, { code: '42501', message: '不能修改自己的管理员身份' });
    if (!isAdminId(uidOfReq)) return send(res, 403, { code: '42501', message: '权限不足：只有管理员可以修改管理员身份' });
    const targetRow = DB.profiles.find(x => x.id === target);
    if (!targetRow) return send(res, 400, { code: '22023', message: '目标用户不存在：' + target });
    if (makeAdmin === false && targetRow.is_admin !== true) {
      return send(res, 400, { code: '22023', message: '目标不是管理员，无需降级：' + target });
    }
    targetRow.is_admin = makeAdmin;                    // 真库里 profiles 是 users 的视图投影
    const u = DB.users.find(x => x.id === target);
    if (u) u.is_admin = makeAdmin;
    return send(res, 200, makeAdmin);
  }

  /* ---------- Auth ---------- */
  if (path === '/auth/v1/settings') {
    return send(res, 200, { external: {}, disable_signup: false, mailer_autoconfirm: true });
  }
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!email || !body.password) return send(res, 400, { msg: 'Email and password are required' });
    if (DB.authUsers.some(u => u.email === email)) return send(res, 422, { msg: 'User already registered', error_code: 'user_already_exists' });
    const id = uid();
    DB.authUsers.push({ id, email, password: body.password });
    DB.profiles.push({
      id, username: email,
      nickname: (body.data && body.data.nickname) || email.split('@')[0],
      avatar_color: '#6c5ce7', is_admin: false,
      created_at: Date.now()
    });
    const at = tok('at'), rt = tok('rt');
    TOKENS.set(at, id); TOKENS.set(rt, id);
    return send(res, 200, {
      access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer',
      user: { id, email, email_confirmed_at: new Date().toISOString() }
    });
  }
  if (path === '/auth/v1/token') {
    const grant = new URLSearchParams(query || '').get('grant_type');
    if (grant === 'refresh_token') {
      const owner = TOKENS.get(body.refresh_token);
      if (!owner) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      const at = tok('at'), rt = tok('rt');
      TOKENS.set(at, owner); TOKENS.set(rt, owner);
      const u = DB.authUsers.find(x => x.id === owner);
      return send(res, 200, {
        access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer',
        user: { id: owner, email: u.email, email_confirmed_at: new Date().toISOString() }
      });
    }
    const email = String(body.email || '').toLowerCase();
    const u = DB.authUsers.find(x => x.email === email);
    if (!u || u.password !== body.password) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' });
    }
    const at = tok('at'), rt = tok('rt');
    TOKENS.set(at, u.id); TOKENS.set(rt, u.id);
    return send(res, 200, {
      access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer',
      user: { id: u.id, email: u.email, email_confirmed_at: new Date().toISOString() }
    });
  }
  if (path === '/auth/v1/logout') { return send(res, 204); }
  if (path === '/auth/v1/resend') { return send(res, 200, {}); }
  if (path === '/auth/v1/recover') { return send(res, 200, {}); }

  /* ---------- PostgREST ---------- */
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length);
    const rows = DB[table];
    if (!rows) return send(res, 404, { message: 'relation "public.' + table + '" does not exist' });

    if (req.method === 'GET') {
      const out = filterRows(rows, query);
      /* 模拟 RLS 读策略（夹具职责，见文件头说明）：
         · 匿名读 users   —— 只投影 (id, username, created_at) 等公开列；请求 is_admin / nickname /
                            password_hash / salt 等敏感列时**不报错、也不返回该列**（等价于真库对
                            anon 隐藏这些列，password_hash 永不出现在匿名响应里）。
                            这样「对照组」的 seed 行发现（匿名读 id,username 那条）
                            仍可用，而敏感列不会外泄。
         · 带令牌读 users  —— 返回真实行（含 is_admin）：B1 用普通账号令牌读回被改的那一行做对照。
         · profiles 视图  —— 匿名可读（grant select to anon）；已认证普通用户按 users_select_own
                            只看到自己，管理员（is_admin()）看全部。 */
      if (table === 'users' && !uidOfReq) {
        const PUBLIC_COLS = ['id', 'username', 'created_at'];
        const sel = (new URLSearchParams(query || '').get('select') || '');
        const want = sel.split(',').map(s => s.trim()).filter(Boolean);
        const cols = want.length ? want.filter(c => PUBLIC_COLS.indexOf(c) >= 0) : PUBLIC_COLS;
        if (!cols.length) return send(res, 200, []);
        const pub = filterRows(rows, query).map(r => {
          const o = {};
          cols.forEach(c => { o[c] = r[c]; });
          return o;
        });
        return send(res, 200, pub);
      }
      if (table === 'profiles' && uidOfReq && !isAdminId(uidOfReq)) {
        return send(res, 200, out.filter(p => p.id === uidOfReq));
      }
      return send(res, 200, out);
    }
    if (req.method === 'POST') {
      if (!uidOfReq) return send(res, 403, rlsError(table));
      if (table !== 'profiles' && body.user_id && body.user_id !== uidOfReq) return send(res, 403, rlsError(table));
      rows.push(body);
      return send(res, 201, undefined);
    }
    if (req.method === 'PATCH') {
      if (!uidOfReq) return send(res, 403, rlsError(table));
      const targets = filterRows(rows, query);
      /* 【本文件 = 旧策略替身】这里**故意没有**列级权限检查。
         真库的 supabase-setup.sql 已经加固（revoke update on public.users + grant update(nickname, avatar_color)），
         加固后的行为由 dev/mocksupa-rpc.js（8124）负责模拟；「加固后必须被拒」的矩阵用它来验。
         本文件保留「旧策略」语义，专门用来做 B1 对照：证明这个洞在加固前确实存在。
         注：t4（独立验证）的 admin 用例打的是 8124 那份加固替身，不依赖本文件的宽松语义。 */
      targets.forEach(r => {
        if (r.user_id && r.user_id !== uidOfReq) return;
        Object.assign(r, body);
      });
      /* 与真库一致：public.profiles 是 users 的投影，users.is_admin 变更要同步过去
         （真库靠视图天然同步；这里手工镜像，否则探测「提权后变管理员」看不到效果） */
      if (table === 'users' && Object.prototype.hasOwnProperty.call(body, 'is_admin')) {
        targets.forEach(r => {
          const p = DB.profiles.find(x => x.id === r.id);
          if (p) p.is_admin = r.is_admin;
        });
      }
      return send(res, 204, undefined);
    }
    if (req.method === 'DELETE') {
      if (!uidOfReq) return send(res, 403, rlsError(table));
      const targets = filterRows(rows, query);
      targets.forEach(r => {
        /* 评论/评分：自己的可删，管理员可删任意（对应 comments_delete_own_or_admin） */
        const mine = r.user_id ? r.user_id === uidOfReq : r.id === uidOfReq;
        if ((table === 'comments' || table === 'ratings') && !mine && !isAdminId(uidOfReq)) return;
        const i = rows.indexOf(r);
        if (i >= 0) rows.splice(i, 1);
      });
      return send(res, 204, undefined);
    }
  }

  send(res, 404, { message: 'not found: ' + path });
});

server.listen(PORT, '127.0.0.1', () => console.log('Mock Supabase on http://127.0.0.1:' + PORT));
