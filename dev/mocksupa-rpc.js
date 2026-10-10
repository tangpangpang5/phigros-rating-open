/* 开发用：Mock Supabase（加固版）——在 dev/mocksupa.js 的行为之上，增加「列级权限 + 提权 RPC」
 * 运行：node dev/mocksupa-rpc.js          → http://127.0.0.1:8124
 *        node dev/mocksupa-rpc.js 9001   → 指定端口
 *
 * 为什么需要这个文件：
 *   dev/mocksupa.js 只能模拟「表级」RLS，无法模拟 supabase-setup.sql 里的
 *   `grant update (nickname, avatar_color)` 列级权限与 admin_set_admin() 的守卫。
 *   于是这里把 4.2 节的 INV-1..INV-6 逐条实现成可断言的行为：
 *     INV-1  PATCH /rest/v1/users 带 is_admin 字段 → 非管理员一律 42501 拒绝
 *     INV-2  非管理员调 rpc/admin_set_admin → 拒绝
 *     INV-3  任何人都不能改自己的 is_admin（管理员也不行）
 *     INV-4  只有 is_admin=true 的调用者能改别人的 is_admin
 *     INV-5  last admin 保护（不允许把最后一个管理员降级）
 *     INV-6  target_id 空 / 目标不存在 → 报错
 *
 * ============================ 夹具使用矩阵（本仓约定） ============================
 * 端口角色（谁打哪个端口，不允许混用）：
 *   · 8123  `dev/mocksupa.js`（**旧策略对照组**）← `dev/test-auth.html`、`dev/test-ui.html`
 *                                                （后两者必须跑在**干净启动的空库 8123**，否则「profiles 初始为空」等断言必失败）
 *   · 8124  **本文件（加固版）**              ← `dev/test-rank-admin.html`（默认 ?mock 已指向 8124）
 *   · 8125  `dev/mocksupa.js`（空库第三实例）    本仓没有对应的用例页
 * 启动：MOCK_PORT=8124 node dev/mocksupa-rpc.js（或 node dev/mocksupa-rpc.js 8124）
 * 硬性约束：加固语义（列级权限拒绝、admin_set_admin 守卫）**只能加在本文件**；
 *           加到 8123 上就失去「旧策略对照组」的意义了（那正是它存在的理由）。
 * 夹具（`dev/mocksupa*.js` 与 `dev/test-*.html` / `dev/test-rank.js`）由本仓统一维护，改动前请先开 Issue 说明。
 * ================================================================================================
 *
 * 预置账号（幂等，可重复运行）：
 *   root@example.com / root123456   （is_admin = true）  —— 信任根，模拟「SQL Editor 手工提权」
 *   user1@example.com / user123456  （is_admin = false）
 * 辅助端口（仅供本地测试脚本用，真 Supabase 上没有）：
 *   POST /_test/login  { email }        → { access_token, user_id }
 *   GET  /_test/state                   → 当前内存库快照
 *   POST /_test/reset                   → 恢复预置数据，返回基线快照
 */
const http = require('http');

const PORT = Number(process.argv[2] || process.env.MOCKSUPA_PORT || 8124);
const HOST = '127.0.0.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
};

const FIXED = {
  rootId: '00000000-0000-4000-8000-000000000000',
  user1Id: '00000000-0000-4000-8000-000000000001'
};

/* ---------------- 内存库 ---------------- */
/* DB.profiles 对应「管理员视角读 public.profiles 视图」（id/username/nickname/avatar_color/is_admin/created_at）
 * DB.users    对应「public.users 表」（列级权限用），profiles 的 is_admin 始终与 users 保持一致 */
let DB = null;
const TOKENS = new Map();   // token -> user id
let seq = 100;

function baseline() {
  return {
    authUsers: [
      { id: FIXED.rootId, email: 'root@example.com', password: 'root123456' },
      { id: FIXED.user1Id, email: 'user1@example.com', password: 'user123456' }
    ],
    users: [
      { id: FIXED.rootId, username: 'root@example.com', nickname: '管理员甲', avatar_color: '#6c5ce7', is_admin: true, created_at: 1700000000000 },
      { id: FIXED.user1Id, username: 'user1@example.com', nickname: '普通用户乙', avatar_color: '#ff4081', is_admin: false, created_at: 1700000001000 }
    ],
    profiles: [
      { id: FIXED.rootId, username: 'root@example.com', nickname: '管理员甲', avatar_color: '#6c5ce7', is_admin: true, created_at: 1700000000000 },
      { id: FIXED.user1Id, username: 'user1@example.com', nickname: '普通用户乙', avatar_color: '#ff4081', is_admin: false, created_at: 1700000001000 }
    ],
    ratings: [
      { id: 'r_seed_1', song_id: 'rrharil', user_id: FIXED.rootId, score: 10, created_at: 1700000100000, updated_at: 1700000100000 },
      { id: 'r_seed_2', song_id: 'rrharil', user_id: FIXED.user1Id, score: 8, created_at: 1700000101000, updated_at: 1700000101000 },
      { id: 'r_seed_3', song_id: 'igallta', user_id: FIXED.user1Id, score: 7, created_at: 1700000102000, updated_at: 1700000102000 }
    ],
    comments: [
      { id: 'c_seed_1', song_id: 'rrharil', user_id: FIXED.rootId, text: '预置评论：管理员的评论', created_at: 1700000200000 },
      { id: 'c_seed_2', song_id: 'igallta', user_id: FIXED.user1Id, text: '预置评论：普通用户的评论', created_at: 1700000201000 }
    ],
    /* feedback：站内反馈（对应 public.feedback）。
       两条种子分属两个账号，正好用来验「非管理员只能读到自己的」这条 RLS。 */
    feedback: [
      { id: 'f_seed_1', user_id: FIXED.rootId, category: 'bug', body: '预置反馈：管理员提的一条问题反馈', created_at: 1700000300000, handled: false, handled_at: null },
      { id: 'f_seed_2', user_id: FIXED.user1Id, category: 'suggestion', body: '预置反馈：普通用户提的一条建议反馈', created_at: 1700000301000, handled: true, handled_at: 1700000400000 }
    ]
  };
}

function resetState() {
  DB = baseline();
  TOKENS.clear();
  seq = 100;
  return DB;
}

/* ---------------- 工具 ---------------- */
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
const rlsError = (table) => ({
  code: '42501',
  message: 'new row violates row-level security policy for table "' + table + '"'
});
const permError = (col) => ({
  code: '42501',
  message: 'permission denied for table users',
  detail: '列级权限拒绝：authenticated 只能 update (nickname, avatar_color)，' +
    'is_admin 必须走 admin_set_admin()（拒绝的列：' + col + '）'
});
const guardError = (msg) => ({ code: '42501', message: msg });

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
function profileOf(id) { return DB.profiles.find(p => p.id === id) || null; }
function isAdminId(id) { const p = profileOf(id); return !!(p && p.is_admin === true); }
function uid() { return '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'); }
function tok(prefix) { return prefix + '_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

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
    if (v.startsWith('eq.')) out = out.filter(r => String(r[k]) === v.slice(3));
  }
  return out;
}

/** 保持 users 表与 profiles 视图一致（真 Supabase 里视图是 users 的投影） */
function setAdmin(id, flag) {
  const u = DB.users.find(x => x.id === id);
  const p = profileOf(id);
  if (u) u.is_admin = flag;
  if (p) p.is_admin = flag;
}

/* ---------------- 服务 ---------------- */
resetState();

const server = http.createServer(async (req, res) => {
  const [path, query] = (req.url || '/').split('?');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {};
  const caller = userIdOf(req);

  /* ---------- 测试辅助（真 Supabase 没有这些端点） ---------- */
  if (path === '/_test/login' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    const u = DB.authUsers.find(x => x.email === email);
    if (!u) return send(res, 404, { message: 'no such seed user: ' + email });
    const at = tok('at'), rt = tok('rt');
    TOKENS.set(at, u.id); TOKENS.set(rt, u.id);
    return send(res, 200, { access_token: at, refresh_token: rt, expires_in: 3600, user_id: u.id, email: u.email });
  }
  if (path === '/_test/state' && req.method === 'GET') {
    return send(res, 200, DB);
  }
  if (path === '/_test/reset' && req.method === 'POST') {
    resetState();
    return send(res, 200, DB);
  }
  // 仅供探测脚本模拟「DBA 直接在 SQL Editor 里改 is_admin」的状态（绕过守卫，用于构造 last-admin 场景）
  if (path === '/_test/set-admin' && req.method === 'POST') {
    setAdmin(String(body.user_id || ''), body.is_admin === true);
    return send(res, 200, { ok: true, profiles: DB.profiles });
  }

  /* ---------- Auth ---------- */
  if (path === '/auth/v1/settings') {
    return send(res, 200, { external: {}, disable_signup: false, mailer_autoconfirm: true });
  }
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase();
    if (!email || !body.password) return send(res, 400, { msg: 'Email and password are required' });
    if (DB.authUsers.some(u => u.email === email)) {
      return send(res, 422, { msg: 'User already registered', error_code: 'user_already_exists' });
    }
    const id = uid();
    DB.authUsers.push({ id, email, password: body.password });
    const nick = (body.data && body.data.nickname) || email.split('@')[0];
    DB.users.push({ id, username: email, nickname: nick, avatar_color: '#6c5ce7', is_admin: false, created_at: Date.now() });
    DB.profiles.push({ id, username: email, nickname: nick, avatar_color: '#6c5ce7', is_admin: false, created_at: Date.now() });
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
  if (path === '/auth/v1/logout') return send(res, 204);
  if (path === '/auth/v1/resend') return send(res, 200, {});
  if (path === '/auth/v1/recover') return send(res, 200, {});

  /* ---------- RPC：admin_set_admin ---------- */
  if (path === '/rest/v1/rpc/admin_set_admin') {
    if (req.method !== 'POST') return send(res, 405, { message: 'Method Not Allowed' });
    const target = body.target_id == null ? '' : String(body.target_id);
    const makeAdmin = body.make_admin === true || body.make_admin === 'true';
    if (!caller) return send(res, 403, guardError('未登录：请先登录管理员账号'));
    if (!target) return send(res, 400, { code: '22023', message: '缺少目标用户 id' });
    if (target === caller) return send(res, 403, guardError('不能修改自己的管理员身份'));
    if (!isAdminId(caller)) return send(res, 403, guardError('权限不足：只有管理员可以修改管理员身份'));
    if (!profileOf(target)) return send(res, 400, { code: '22023', message: '目标用户不存在：' + target });
    if (makeAdmin === false && !isAdminId(target)) {
      // 与 root 处断言一致：降级的目标必须原本就是管理员
      return send(res, 400, { code: '22023', message: '目标不是管理员，无需降级：' + target });
    }
    setAdmin(target, makeAdmin);
    return send(res, 200, makeAdmin);
  }

  /* ---------- RPC：admin_set_feedback_handled ---------- */
  /* 与 supabase-setup.sql 里的守卫逐条对应（顺序、错误码都照抄）。
     参数名是 **make_handled**（不是 handled）—— SQL 里若叫 handled 会与表列同名，
     `set handled = handled` 会变成空操作。这里同样只认 make_handled。 */
  if (path === '/rest/v1/rpc/admin_set_feedback_handled') {
    if (req.method !== 'POST') return send(res, 405, { message: 'Method Not Allowed' });
    const fid = body.feedback_id == null ? '' : String(body.feedback_id);
    const makeHandled = body.make_handled === true || body.make_handled === 'true';
    if (!caller) return send(res, 403, guardError('未登录：请先登录管理员账号'));
    if (!fid) return send(res, 400, { code: '22023', message: '缺少反馈 id' });
    if (body.make_handled == null) return send(res, 400, { code: '22023', message: '缺少目标状态 make_handled（true=已处理 / false=未处理）' });
    if (!isAdminId(caller)) return send(res, 403, guardError('权限不足：只有管理员可以标记反馈处理状态'));
    const hit = DB.feedback.filter(f => f.id === fid)[0];
    if (!hit) return send(res, 400, { code: '22023', message: '反馈不存在：' + fid });
    hit.handled = makeHandled;
    hit.handled_at = makeHandled ? Date.now() : null;
    return send(res, 200, true);
  }

  /* ---------- PostgREST ---------- */
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length);
    const rows = DB[table];
    if (!rows) return send(res, 404, { message: 'relation "public.' + table + '" does not exist' });

    if (req.method === 'GET') {
      // feedback 的 select 策略是「本人 or 管理员」，与 ratings/comments 的 using(true) 不同，
      // 必须在读侧也拦一刀 —— 否则「非管理员读不到他人反馈」这条验收在 Mock 上恒真（假通过）。
      if (table === 'feedback') {
        if (!caller) return send(res, 403, rlsError(table));
        const visible = filterRows(rows, query).filter(r => r.user_id === caller || isAdminId(caller));
        return send(res, 200, visible);
      }
      return send(res, 200, filterRows(rows, query));
    }

    if (req.method === 'POST') {
      if (!caller) return send(res, 403, rlsError(table));
      if (table !== 'profiles' && body.user_id && body.user_id !== caller) return send(res, 403, rlsError(table));
      // 真实数据库给 feedback 三个**服务端默认值**（见 supabase-setup.sql 的 feedback 表定义）：
      //   id → 'f_' || gen_random_uuid()、created_at → 服务端毫秒、handled → false
      // 前端刻意不发送这三项，所以 Mock 必须自己补，否则测试里 id 为 undefined，
      // 「标记已处理」就会静默失败 —— 那是假失败，不是产品缺陷。
      if (table === 'feedback') {
        // 列级 INSERT 授权（对应 SQL 的 `grant insert (user_id, category, body)`）：
        // 客户端**不许**自己提供 id / created_at / handled / handled_at。
        // 真库在权限检查阶段就回 42501；这里照做 —— 这正是 blocker 的复现点：
        // 若放开，任何持公开 anon key 的人都能自填 created_at 来绕过 60 秒限频窗口。
        const FORBIDDEN_COLS = ['id', 'created_at', 'handled', 'handled_at'];
        const bad = FORBIDDEN_COLS.filter(c => Object.prototype.hasOwnProperty.call(body, c));
        if (bad.length) {
          return send(res, 403, {
            code: '42501',
            message: 'permission denied for table feedback',
            detail: '列级权限拒绝：authenticated 只能 insert (user_id, category, body)，' +
              '被拒的列：' + bad.join(', ') + '（id / created_at / handled 由服务端生成）'
          });
        }
        const row = Object.assign({}, body);
        // 对应 SQL 里的 before insert 触发器 public.feedback_server_fields()：
        // 这三个字段**由服务端覆写**，客户端发什么都不算数。
        // 尤其 created_at：表级 insert 授权会让客户端自填时间从而绕过 60 秒限频窗口，
        // 真库靠「列级授权 + 触发器覆写」两道挡住，Mock 必须同样覆写，
        // 否则「客户端改 created_at 能不能绕过限频」这条验收在 Mock 上会假通过。
        row.created_at = Date.now();
        if (!row.id) row.id = 'f_' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
        if (row.handled == null) row.handled = false;
        if (row.handled_at === undefined) row.handled_at = null;
        // 模拟 check 约束（category 枚举 + body 10–500 **字符**）。
        // 按码点计数，与 Postgres 的 char_length 对齐（用 .length 会把 emoji 算成 2）。
        if (['bug', 'suggestion', 'other'].indexOf(row.category) < 0) {
          return send(res, 400, { code: '23514', message: 'violates check constraint "feedback_category_check"' });
        }
        const len = Array.from(String(row.body == null ? '' : row.body)).length;
        if (len < 10 || len > 500) {
          return send(res, 400, { code: '23514', message: 'violates check constraint "feedback_body_check"' });
        }
        rows.push(row);
        return send(res, 201, undefined);
      }
      rows.push(body);
      return send(res, 201, undefined);
    }

    if (req.method === 'PATCH') {
      if (!caller) return send(res, 403, rlsError(table));
      // 列级权限（对应 grant update (nickname, avatar_color)）：
      // users 表上任何 is_admin 改动都拒绝；非管理员连别人的行也动不了。
      const wantsAdminFlag = Object.prototype.hasOwnProperty.call(body, 'is_admin');
      const targets = filterRows(rows, query);
      if (table === 'users') {
        if (wantsAdminFlag && !isAdminId(caller)) return send(res, 403, permError('is_admin'));
        if (!isAdminId(caller) && targets.some(r => r.id !== caller)) {
          return send(res, 403, rlsError('users'));
        }
      }
      targets.forEach(r => {
        if (table === 'profiles') { delete body.is_admin; }      // 视图不可写 is_admin
        if ((table === 'comments' || table === 'ratings') && r.user_id && r.user_id !== caller && !isAdminId(caller)) return;
        Object.assign(r, body);
      });
      return send(res, 204, undefined);
    }

    if (req.method === 'DELETE') {
      if (!caller) return send(res, 403, rlsError(table));
      // feedback 表**没有 delete 策略**（见 supabase-setup.sql 5a 段：刻意不给，
      // 反馈是审计记录，后端只允许标记处理状态）。真实 PostgREST 在「RLS 已启用但无匹配
      // 策略」时会删 0 行却仍回 204 —— 那会让人误以为删除生效。这里选择明确报 403：
      // Mock 的职责是**不比真库更宽松**，宁可报错也不要给出假通过。
      if (table === 'feedback') {
        return send(res, 403, {
          code: '42501',
          message: 'permission denied for table feedback',
          detail: '表上没有 delete 策略：反馈只能标记处理状态（admin_set_feedback_handled），不能删除'
        });
      }
      const targets = filterRows(rows, query);
      targets.forEach(r => {
        const mine = r.user_id ? r.user_id === caller : r.id === caller;
        if (!mine && !isAdminId(caller)) return;                  // comments_delete_own_or_admin
        const i = rows.indexOf(r);
        if (i >= 0) rows.splice(i, 1);
      });
      return send(res, 204, undefined);
    }
  }

  send(res, 404, { message: 'not found: ' + path });
});

server.listen(PORT, HOST, () => {
  console.log('Mock Supabase (hardened) on http://' + HOST + ':' + PORT);
  console.log('seed: root@example.com / root123456 (admin), user1@example.com / user123456 (user)');
});
