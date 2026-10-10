-- =========================================================
-- Phigros 打分站 · Supabase 表结构 + 安全策略（用户级 RLS）
--
-- 本版本配套「邮箱 + 密码」的 Supabase Auth 登录：
--   · 账号由 Supabase Auth 管理（auth.users），密码不再存在业务表里
--   · 注册后由触发器自动在 public.users 建一行资料（昵称、头像色、管理员标记）
--   · 所有写入都由 auth.uid() 判定归属，未登录一律被拒
--
-- 用法：Supabase → SQL Editor → 粘贴整段 → Run
--       可重复执行，不会报错（策略/触发器都先 drop 再建）
--
-- 「可重复执行」的写法约定（改动本文件时请遵守，已按此逐条自查）：
--   · 表       → create table if not exists（已存在即跳过，与既有列序无关）
--   · 列       → add column if not exists（只会追加在末尾）
--   · 约束     → drop constraint if exists 再 add constraint（add 本身不幂等）
--   · 视图     → drop view if exists 再 create view，列序就写死在 select 里
--                （**不能用 create or replace**：它要求既有列同名同序、只能在末尾多出新列，
--                  线上若是旧列序的老视图就会报 cannot change name of view column
--                  而中断整段脚本。drop + create 是全新建视图，对新装库与旧列序升级库都成立；
--                  注意授权会随 drop 一起消失，所以 grant 必须写在 create 之后。）
--   · 函数     → 无人依赖的函数（public.admin_set_admin(text, boolean)、
--                public.current_session_is_users_owner()）用 `drop function if exists` + `create` 重建；
--                有依赖的函数（public.is_admin() 被 3 条 RLS 策略引用）**不能 drop**，只能 create or replace。
-- =========================================================

-- ---------- 0. 表结构（含管理员字段） ----------
create table if not exists public.users (
  id text primary key,
  username text unique not null,
  password_hash text,
  salt text,
  nickname text,
  avatar_color text,
  created_at bigint
);
create table if not exists public.ratings (
  id text primary key,
  song_id text not null,
  user_id text not null,
  score int not null check (score between 1 and 10),
  created_at bigint,
  updated_at bigint
);
create table if not exists public.comments (
  id text primary key,
  song_id text not null,
  user_id text not null,
  text text not null,
  created_at bigint,
  -- 发表评论时所在的谱面难度（2026-10 需求：评论要固化它评的是哪张谱面，
  -- 不能跟着页面当前选中的难度变）。**可空是刻意的**：本字段之前的历史评论没有记录，
  -- 无法可靠还原，编一个难度等于伪造数据 ⇒ 留 null，前端对 null 不显示难度徽标。
  -- 取值与 js/storage.js 的 DIFF_LEVELS、js/songs.js 的 difficulties[].level 三处一致。
  difficulty text check (difficulty is null or difficulty in ('EZ', 'HD', 'IN', 'AT'))
);
-- 老库升级：表已存在时上面的 create 不会补列，这里显式补一次（幂等）。
-- 同理补约束：客户端可以自由指定该列（RLS 只校验 user_id），CHECK 是唯一取值防线。
alter table public.comments add column if not exists difficulty text;
alter table public.comments drop constraint if exists comments_difficulty_chk;
alter table public.comments add constraint comments_difficulty_chk
  check (difficulty is null or difficulty in ('EZ', 'HD', 'IN', 'AT'));
-- feedback：站内反馈（接手批次 T1）。与服务端时间/主键约定见下方「为什么」注释。
create table if not exists public.feedback (
  id text primary key
    default ('f_' || replace(gen_random_uuid()::text, '-', '')),
  user_id text not null,
  category text not null default 'other'
    check (category in ('bug', 'suggestion', 'other')),
  body text not null
    check (char_length(body) between 10 and 500),
  created_at bigint not null
    default (extract(epoch from now()) * 1000)::bigint,
  handled boolean not null default false,
  handled_at bigint
);

-- 管理员标记
alter table public.users add column if not exists is_admin boolean default false;

-- 老版本遗留的密码列不再需要（改为 Auth 管理），放开非空约束避免插入失败。
-- 守卫：这两列由上面的 create table 建出来，正常一定存在；但若线上/旧库把该列删掉了，
--      直接 alter 会报 column "password_hash" does not exist 而中断整段脚本，
--      所以先查 information_schema 再执行（幂等，重复执行无副作用）。
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash') then
    execute 'alter table public.users alter column password_hash drop not null';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'users' and column_name = 'salt') then
    execute 'alter table public.users alter column salt drop not null';
  end if;
end $$;

-- ---------- 1. 启用 RLS ----------
alter table public.users    enable row level security;
alter table public.ratings  enable row level security;
alter table public.comments enable row level security;
alter table public.feedback enable row level security;

-- ---------- 2. 管理员判断函数（SECURITY DEFINER，避免 RLS 递归） ----------
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.users
    where id = auth.uid()::text and is_admin = true
  );
$$ language sql security definer stable;

-- ---------- 3. users：只能读写自己，管理员可读全部 ----------
drop policy if exists "users_all"          on public.users;
drop policy if exists "users_select_own"   on public.users;
drop policy if exists "users_insert_own"   on public.users;
drop policy if exists "users_update_own"   on public.users;

create policy "users_select_own" on public.users
  for select using (auth.uid()::text = id or public.is_admin());
create policy "users_insert_own" on public.users
  for insert with check (auth.uid()::text = id);
create policy "users_update_own" on public.users
  for update using (auth.uid()::text = id) with check (auth.uid()::text = id);

-- ---------- 3b. is_admin 加固（重要：修掉「登录用户自提权」漏洞） ----------
-- 背景：users_update_own 只校验行的归属（id = auth.uid()），对列没有任何限制。
--       因此任意登录用户都能 PATCH 自己的行把 is_admin 改成 true，一步变成管理员
--       （进而能删任意评论、删任意评分、读全部用户资料）。
-- 修法分三层：
--   (1) 列级权限（**唯一的主防线**）：收回整表 update，只放开展示用列 → 直写 is_admin 直接 42501；
--   (2) 触发器 users_guard_admin_flag（纵深防御，不是第二道真实防线）：**只有当有人误把表级
--       UPDATE 授权加回来**（例如执行了 `grant update on public.users to authenticated;` 或
--       用了旧的 setup 脚本）时才会被触发。当前配置下 PATCH is_admin 在权限检查阶段就被 (1)
--       以 42501 顶掉，压根不会执行到 UPDATE、也就不会触发本触发器（可重复性检查见脚本末尾自检段）。
--       请勿把这一层当作「即使主防线失效也安全」的保证。
--   (3) 受控入口：public.admin_set_admin() —— 只有管理员能调用，且不能改自己。
revoke update on public.users from anon, authenticated;
grant  update (nickname, avatar_color) on public.users to authenticated;

-- 引导路径判据用的辅助函数：当前会话是不是「以 users 表属主身份」直接连库。
-- 可重复执行：采用「drop function if exists + create」的写法（本文件对「无人依赖的函数」统一这么写，
-- 见文件头「可重复执行的写法约定」一节）——它比 create or replace 更能跨版本重建
-- （旧版返回类型/属性不同时，create or replace 会直接报错中断整段脚本）。
-- 返回值语义：true = 表属主会话（SQL Editor 典型情形）/ false = 其它会话（PostgREST 等）。
-- pg_tables.tableowner 就是表属主的角色名（等价于 pg_class.relowner 转名字），
-- 这里用嵌套 select，不引入任何本文件之外的对象依赖。
-- 授权：drop 会连带丢掉旧授权，所以 create 之后显式收回（本函数只由 SECURITY DEFINER 的触发器调用，
-- 走的是函数属主权限，不需要给 anon/authenticated 任何 EXECUTE）。
drop function if exists public.current_session_is_users_owner();
create function public.current_session_is_users_owner()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  owner_name name;
begin
  begin
    select t.tableowner into owner_name
      from pg_catalog.pg_tables t
     where t.schemaname = 'public' and t.tablename = 'users';
  exception when undefined_table then
    -- 极端情况：视图/系统目录在目标库不可用。此时按「不信任」处理，让触发器继续走拒绝分支。
    return false;
  end;
  if owner_name is null then
    return false;
  end if;
  return session_user = owner_name;
end $$;

revoke all on function public.current_session_is_users_owner() from public;
revoke all on function public.current_session_is_users_owner() from anon, authenticated;

-- (2) 的放行判据（本次改动：修掉 D-1「引导路径被误拦」）：
--   放行分支（满足任一即放行）：
--     ① 受控入口：admin_set_admin() 在事务内打的标记（SET LOCAL 语义）——见 3d 段；
--     ② 引导路径（信任根）：**当前会话直接以 users 表属主身份连接**——
--        `session_user = pg_tables.tableowner`。表属主本来就能 `alter table ... disable trigger`
--        或 `grant`/`drop` 任意策略，把「表属主会话」认作可信，不引入任何新的权限边界。
--   为什么用 session_user 而不是 current_user：
--     本函数是 security definer，函数体内 current_user 恒为函数属主（postgres），
--     拿它判断调用者会永远判成「属主」，等于把门彻底打开。
--     session_user 是「建立这条连接的角色」，不会被 SET ROLE / security definer 改写：
--       · Supabase SQL Editor（Dashboard 以项目属主身份连库）→ session_user = postgres = 表属主 → 放行；
--       · PostgREST（匿名/登录用户请求，一律以连接角色 authenticator 连库、再 SET ROLE anon/authenticated）
--         → session_user = authenticator ≠ 表属主 → 不放行，仍走下面的 raise。
--   被否决的备选方案（都要如实记下来，别重复踩）：
--     (b) `current_setting('request.jwt.claims', true) is null` —— **绝对不能用**：
--         PostgREST 的匿名请求（只带 publishable/anon key、不带登录令牌）同样没有 JWT claims，
--         这一条会把它一起放行，等于给「匿名 PATCH is_admin」开了口子，直接违反加固要求 2。
--     (c) (a) or (b) —— 同理，被 (b) 的漏洞污染。
--     (d) `auth.role() = 'service_role' or auth.uid() is null`（GUC 版，与已否决的旧写法同源）——
--         `auth.uid()` 对匿名请求也为 null，同样会把匿名请求放行；且它依赖 PostgREST 的 GUC，
--         而 PostgREST 会复用连接池，GUC 的跨界可见性没有任何文档保证。
--   ① 标记分支为什么不加「必须是表属主会话」的前置条件（改动前请先读完这段）：
--     技术上两种都可行 —— 管理员走 RPC 时 public.is_admin() 为真，下面第 ③ 条不会 raise，
--     控制流自然 return new；所以给 ① 加属主前置**不会**弄坏 admin_set_admin()。
--     这里仍选「不加」，理由是 ① 的定位：它是给**具备 SQL 执行能力**的主体留的逃生舱
--     （表属主 / service_role / 超级用户），用于第 ② 条判据在本项目库上出现偏差时仍能完成引导。
--     加了属主前置就会让 service_role 失去这条通道（以后写服务端管理脚本只能另想办法），
--     收益是关掉一个「非属主会话 + 能执行 set_config」的组合。取舍：保留 ①，把边界写准（见下）。
--   标记的安全边界（前提/结论写准，别简化成「客户端用不到」，也别写成「PG 不允许」）：
--     前提：PostgreSQL **允许任何角色 SET 自定义 GUC** —— 这不是权限问题，所以能当放行标记与否，
--           取决于「API 面有没有设置入口」；
--     事实：PostgREST 只暴露 public schema 的函数，set_config 不在其中
--           （实测 POST /rest/v1/rpc/set_config → 404 PGRST202），本项目也没有暴露任何可设置该 GUC
--           的封装函数 ⇒ 普通客户端没有入口；能设置它的只有具备 SQL 执行能力的主体：
--           表属主（SQL Editor）、service_role、或本项目自己的 admin_set_admin()；
--     结论：因此该标记**目前不可利用**。
--     「登录用户自提权」被两道同时挡住：正常配置下 (1) 列级权限在权限检查阶段就以 42501 拒掉
--     （触发器根本不会被执行）；即使有人误把表级 UPDATE 加回来，触发器里 `not public.is_admin()`
--     仍然拒 —— 要绕过它必须同时满足「有设置 set_config 的入口」+「表级 UPDATE 被误授权」，
--     两道都要破，而普通客户端两道都没有。
--     小结：加固强度仍以 (1) 列级权限为准，本触发器是纵深防御，不能单独依赖。
create or replace function public.users_guard_admin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 只在 is_admin 真的发生变化时才判定；nickname / avatar_color 的更新直接放行。
  if new.is_admin is distinct from old.is_admin then
    -- ① 受控入口（admin_set_admin 打的事务内标记）
    if coalesce(current_setting('app.allow_admin_flag', true), '0') = '1' then
      return new;
    end if;
    -- ② 引导路径（表属主会话；SQL Editor 就是这种会话）
    if public.current_session_is_users_owner() then
      return new;
    end if;
    -- ③ 其余一律拒绝：管理员走 admin_set_admin()，其它人没有合法路径
    if not public.is_admin() then
      raise exception using
        errcode = '42501',
        message = '拒绝修改 is_admin：本次改动既不是管理员调用 admin_set_admin()，也不是表属主会话的引导操作',
        detail  = case when auth.uid() is null
                       then '当前请求没有登录身份（匿名或非 API 会话）'
                       else format('当前登录用户 %s 不是管理员', auth.uid()) end,
        hint    = '怎么改：① 管理员在站点「后台」点按钮，或管理员账号调 select public.admin_set_admin(''<目标用户id>'', true);'
               || ' ② 首次引导（信任根）在 Supabase SQL Editor 用表属主身份执行 update public.users set is_admin = true where username = ''<邮箱>'';'
               || '（SQL Editor 会话的 session_user 即表属主，会被放行；PostgREST 请求一律不放行。）'
               || ' ③ 仅当第 ② 条判据在你的库上不成立（SQL Editor 不是表属主身份）才用逃生舱；该标记是「非事务性」的会话级标记：'
               || '用完请在同一会话执行 select set_config(''app.allow_admin_flag'', ''0'', false); 清掉（或直接关掉该 SQL Editor 会话），'
               || '并重跑整段 supabase-setup.sql 复核： begin; select set_config(''app.allow_admin_flag'', ''1'', false); '
               || 'update public.users set is_admin = true where username = ''<邮箱>''; commit;';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists users_guard_admin_flag on public.users;
create trigger users_guard_admin_flag
  before update on public.users
  for each row execute function public.users_guard_admin_flag();

-- ---------- 3c. avatar_color 格式约束（用户可写字段，别让它当 CSS 注入的跳板） ----------
-- 先把历史脏数据归一，否则下面加约束会失败（可重复执行：已经是合法值的行不动）
update public.users set avatar_color = '#6c5ce7'
 where avatar_color is not null
   and avatar_color !~ '^#[0-9a-fA-F]{3,8}$';

alter table public.users drop constraint if exists users_avatar_color_fmt;
alter table public.users add constraint users_avatar_color_fmt
  check (avatar_color is null or avatar_color ~ '^#[0-9a-fA-F]{3,8}$');

-- 唯一的合法提权入口（前端后台按钮调它：POST /rest/v1/rpc/admin_set_admin）
-- 先 drop 再建：整段脚本可重复执行（改过签名/参数名也不会因「已存在」报错），
-- 授权语句在创建之后重新执行，因此不会因为 drop 而丢权限。
drop function if exists public.admin_set_admin(text, boolean);
create or replace function public.admin_set_admin(target_id text, make_admin boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  affected int := 0;
begin
  if caller is null then
    raise exception '未登录：请先登录管理员账号' using errcode = '42501';
  end if;
  if target_id is null or target_id = '' then
    raise exception '缺少目标用户 id' using errcode = '22023';
  end if;
  if make_admin is null then
    raise exception '缺少目标状态 make_admin（true=设为管理员 / false=取消管理员）' using errcode = '22023';
  end if;
  if target_id = caller::text then
    raise exception '不能修改自己的管理员身份' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception '权限不足：只有管理员可以修改管理员身份' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users where id = target_id) then
    raise exception '目标用户不存在：%', target_id using errcode = '22023';
  end if;
  if make_admin = false and not exists (
       select 1 from public.users where id = target_id and is_admin = true) then
    raise exception '目标不是管理员，无需降级：%', target_id using errcode = '22023';
  end if;

  -- 打上「本次改动由受控函数发起」的事务内标记（SET LOCAL 语义），
  -- 供 users_guard_admin_flag 触发器放行；事务结束自动消失，不需要清理。
  perform set_config('app.allow_admin_flag', '1', true);

  update public.users set is_admin = make_admin where id = target_id;
  get diagnostics affected = row_count;
  return affected > 0;
end $$;

revoke all on function public.admin_set_admin(text, boolean) from public;
revoke all on function public.admin_set_admin(text, boolean) from anon;
grant execute on function public.admin_set_admin(text, boolean) to authenticated;
-- 说明：这里刻意不写「至少要保留一名管理员」的守卫——管理员不能改自己、
--       非管理员不能改别人，两条合起来已经封死了「管理员数归零」的全部路径，
--       那样的守卫是死代码。真机上用下面这句复核即可：
--       select count(*) from public.users where is_admin = true;   -- 期望 >= 1

-- ---------- 4. ratings：公开可读，只能改自己的，管理员可删 ----------
drop policy if exists "ratings_all"          on public.ratings;
drop policy if exists "ratings_select"       on public.ratings;
drop policy if exists "ratings_insert_own"   on public.ratings;
drop policy if exists "ratings_update_own"   on public.ratings;
drop policy if exists "ratings_delete_own"   on public.ratings;

create policy "ratings_select" on public.ratings
  for select using (true);
create policy "ratings_insert_own" on public.ratings
  for insert with check (auth.uid()::text = user_id);
create policy "ratings_update_own" on public.ratings
  for update using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
create policy "ratings_delete_own" on public.ratings
  for delete using (auth.uid()::text = user_id or public.is_admin());

-- ---------- 5. comments：公开可读，只能写自己的，管理员可删任意 ----------
drop policy if exists "comments_all"                   on public.comments;
drop policy if exists "comments_select"                on public.comments;
drop policy if exists "comments_insert_own"            on public.comments;
drop policy if exists "comments_update_own"            on public.comments;
drop policy if exists "comments_delete_own_or_admin"   on public.comments;

create policy "comments_select" on public.comments
  for select using (true);
create policy "comments_insert_own" on public.comments
  for insert with check (auth.uid()::text = user_id);
create policy "comments_update_own" on public.comments
  for update using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
create policy "comments_delete_own_or_admin" on public.comments
  for delete using (auth.uid()::text = user_id or public.is_admin());

-- ---------- 5a. feedback：提交者只能看自己的，管理员可看全部、只能标记已处理 ----------
-- 设计要点（与 ratings/comments 的差别，逐条说明理由）：
--   · **不做公开可读**：反馈里可能含邮箱等隐私内容，`for select using (auth.uid()::text = user_id or
--     public.is_admin())` 是「本人 + 管理员」。这与 comments 的 `using (true)` 是**刻意不同**。
--   · **不给 delete 策略**：后台只需要「标记已处理」，不需要删除。
--     ⚠️ 但要写清真实机制（评审纠正）：**「没有策略」单独并不等于「一定被拒」** ——
--     RLS 已启用且无匹配策略时，PostgREST 会删 0 行却仍回 204（假成功，必须回查数据）。
--     本表之所以真的回 403，是因为下一段的 `revoke all` **把表级 DELETE 权限整个收走了**
--     （权限检查在 RLS 之前发生）。两者要一起看才成立。
--   · **update 由受控函数完成，且列级权限再兜一层**：策略允许管理员更新，但列级授权
--     只给 authenticated 的 (handled, handled_at) 两列 —— 双保险（列级先于 RLS 判定），
--     避免管理员（或将来策略写松时）改到 user_id / body / created_at。
drop policy if exists "feedback_all"                on public.feedback;
drop policy if exists "feedback_select"             on public.feedback;
drop policy if exists "feedback_insert_own"         on public.feedback;
drop policy if exists "feedback_update_admin_only"  on public.feedback;

create policy "feedback_select" on public.feedback
  for select using (auth.uid()::text = user_id or public.is_admin());
create policy "feedback_insert_own" on public.feedback
  for insert with check (auth.uid()::text = user_id);
create policy "feedback_update_admin_only" on public.feedback
  for update using (public.is_admin()) with check (public.is_admin());

-- 授权：**只给"用户真正该提供的那三列"**，不给整表 insert。
-- 为什么这一行很关键（评审发现的 blocker）：表级 `grant insert` 会让客户端**自己填
-- `created_at`**。而默认值只是「没提供时的兜底」、不是约束 —— 于是任何人都能拿公开的
-- anon key 反复提交并把 created_at 写成很久以前，**把 60 秒限频整个绕开**；
-- 又因为本表不可删除，结果是「可无上限刷库 + 只能在 SQL Editor 手工清理」。
-- 改成列级授权后，客户端连"发送 created_at"这个动作都会被 42501 拒掉（权限先于触发器）。
-- （同样的弱点在 ratings/comments 上已存在并被上一轮接受，但那两张表管理员能删；
--   本表不能删 ⇒ 严重度更高，故本批单独收紧。那两表是否一并收紧另开任务。）
revoke all on public.feedback from anon, authenticated;
grant  select on public.feedback to authenticated;
grant  insert (user_id, category, body) on public.feedback to authenticated;
grant  update (handled, handled_at) on public.feedback to authenticated;

-- 第二道防线：即便将来有人把表级 insert 又授回去，服务端也**强制覆写**这三个字段。
-- （列级授权是"不让你发"，触发器是"发了也不算"——两道都在，才叫兜底。）
create or replace function public.feedback_server_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.id := coalesce(nullif(new.id, ''), 'f_' || replace(gen_random_uuid()::text, '-', ''));
  new.created_at := (extract(epoch from now()) * 1000)::bigint;   -- 服务端时间，不信客户端
  if new.handled is null then new.handled := false; end if;
  return new;
end $$;

drop trigger if exists feedback_server_fields on public.feedback;
create trigger feedback_server_fields
  before insert on public.feedback
  for each row execute function public.feedback_server_fields();

revoke all on function public.feedback_server_fields() from public;
revoke all on function public.feedback_server_fields() from anon, authenticated;

-- ---------- 5a-b. feedback 的写频率限制（独立阈值，不与评论/评分互相挤占） ----------
-- 为什么单独一个函数、不复用 enforce_write_rate_limit()：
--   那个函数的阈值是「comments + ratings 合计 60 秒 5 次」。若把 feedback 记进同一个计数，
--   用户「打完 5 首曲子再想反馈」就会被自己刚用完的额度挡住 —— 这是误伤，不是防护。
--   而若不记入、又共用同一个 advisory lock，则在**同一事务**里先插评论再插反馈时，
--   锁被重复获取（同一事务内重入是安全的）但计数互不相干，语义容易读错。故独立成函数。
--   两函数使用同一把锁键（hashtextextended(uid,0)），因此同一用户的写入仍然串行化。
-- 阈值：60 秒内最多 3 条反馈（比评论/评分更严 —— 反馈是低频动作，刷它没有正常理由）。
create or replace function public.enforce_feedback_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid_text  text := auth.uid()::text;
  recent    int;
  max_writes constant int := 3;
  window_ms constant bigint := 60000;
begin
  -- 未登录：直接拒绝（理由同 5b —— 不留「计数 0 就放行」的假防线）
  if uid_text is null or uid_text = '' then
    raise exception '请先登录后再提交反馈' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid_text, 0));

  select count(*) from public.feedback
    where user_id = uid_text
      and created_at > (extract(epoch from now()) * 1000)::bigint - window_ms
  into recent;

  if recent >= max_writes then
    raise exception '提交过于频繁，请稍后再试（同一账号 60 秒内最多提交 3 条反馈）'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists feedback_rate_limit on public.feedback;
create trigger feedback_rate_limit
  before insert on public.feedback
  for each row execute function public.enforce_feedback_rate_limit();

revoke all on function public.enforce_feedback_rate_limit() from public;
revoke all on function public.enforce_feedback_rate_limit() from anon, authenticated;

-- 计数索引：与 5c 同理（带 user_id 过滤的范围计数要走索引）
create index if not exists feedback_user_created_idx on public.feedback (user_id, created_at);

-- ---------- 5a-c. 标记反馈已处理（唯一的修改入口，管理员专用） ----------
-- 与 admin_set_admin 同构：先 drop 再建（可重复执行），security definer，
-- 只用 revoke/grant 控权，前端只能通过 POST /rest/v1/rpc/admin_set_feedback_handled 调用。
-- ⚠️ 参数名**不能叫 handled**：plpgsql 里它会与同名的表列冲突，
--    `set handled = handled` 与 `case when handled then` 都会被解析成「列 = 列」而变成空操作
--    （Postgres 的 UPDATE 右侧同名列优先取目标表的当前值）。
--    故参数名用 make_handled（与 admin_set_admin 的 make_admin 保持同一命名习惯）。
drop function if exists public.admin_set_feedback_handled(text, boolean);
create or replace function public.admin_set_feedback_handled(feedback_id text, make_handled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  affected int := 0;
begin
  if caller is null then
    raise exception '未登录：请先登录管理员账号' using errcode = '42501';
  end if;
  if feedback_id is null or feedback_id = '' then
    raise exception '缺少反馈 id' using errcode = '22023';
  end if;
  if make_handled is null then
    raise exception '缺少目标状态 make_handled（true=已处理 / false=未处理）' using errcode = '22023';
  end if;
  if not public.is_admin() then
    raise exception '权限不足：只有管理员可以标记反馈处理状态' using errcode = '42501';
  end if;
  if not exists (select 1 from public.feedback where id = feedback_id) then
    raise exception '反馈不存在：%', feedback_id using errcode = '22023';
  end if;

  update public.feedback
     set handled = make_handled,
         handled_at = case when make_handled
                           then (extract(epoch from now()) * 1000)::bigint
                           else null end
   where id = feedback_id;
  get diagnostics affected = row_count;
  return affected > 0;
end $$;

revoke all on function public.admin_set_feedback_handled(text, boolean) from public;
revoke all on function public.admin_set_feedback_handled(text, boolean) from anon;
grant execute on function public.admin_set_feedback_handled(text, boolean) to authenticated;

-- ---------- 5b. 写入频率限制（最小防护，部署轮新增） + 5c 计数索引 ----------
-- 语义：同一个 auth.uid() 在 **60 秒**内对 comments + ratings 的**合计**写入最多 5 次，
--       第 6 次起直接拒绝并给出可读提示（「操作过于频繁，请稍后再试」）。
--       这是「最小防护」而不是风控系统：目的是挡住「新号/脚本在几秒内刷几十条评论或评分」这类噪音。
-- 阈值口径：正常人「给 3 首曲子打分 + 发 2 条评论」= 5 次写入，刚好能在 60 秒窗口内通过；
--       改自己的评分走的是 UPDATE（`where id = <自己那行>`），本触发器是 **before insert**、不会被触发
--       —— 也就是说「反复改分」不算新写入，不会把正常用户锁死。
--
-- auth.uid() 为空时怎么办（**这里必须写清楚，不要留成「计数 0 就放行」的漏洞路径**）：
--   **选择 = 直接拒绝**（不查计数、直接 raise）。理由：
--     · 未登录写入本来就被 RLS 拒绝（comments/ratings 的 insert 策略都要求 auth.uid() = user_id），
--       所以这条 raise 挡不住任何**合法**写入，不会破坏功能；
--     · 反过来，若写成「未登录 → 计数为 0 → return new」，就等于让触发器在匿名路径上**恒定放行**：
--       一旦哪天 RLS 被手工改松，限频就静默失效了（多出一条假防线）；
--     · 拒绝还有个附带好处：匿名刷接口时立刻拿到「请先登录」的提示，而不是让请求一路走到 RLS 才失败。
--   错误码统一用 42501（与文件里其它守卫一致；语义上也有人用 53400，这里为保持一致选 42501）。
--   锁：先取事务级 advisory lock（键 = hashtextextended(uid,0)），避免并发请求各自读到同一份计数而一起放行
--       （否则限频只是「大致」有效）。事务结束自动释放，无需手工解锁。
--   计数口径：两表都用 `created_at > (extract(epoch from now())*1000)::bigint - 60000` 统计，再相加。
create or replace function public.enforce_write_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid_text  text := auth.uid()::text;
  recent    int;
  max_writes constant int := 5;        -- 60 秒窗口内允许的最大写入次数（两表合计）
  window_ms constant bigint := 60000;
begin
  -- 未登录 / 非 API 会话：直接拒绝（见上方注释，这不是「计数 0 放行」）
  if uid_text is null or uid_text = '' then
    raise exception '请先登录后再发表评论或评分' using errcode = '42501';
  end if;

  -- 同一用户串行化，避免并发请求同时读到旧计数而一起放行
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid_text, 0));

  select
    (select count(*) from public.ratings
      where user_id = uid_text
        and created_at > (extract(epoch from now()) * 1000)::bigint - window_ms)
  + (select count(*) from public.comments
      where user_id = uid_text
        and created_at > (extract(epoch from now()) * 1000)::bigint - window_ms)
  into recent;

  if recent >= max_writes then
    raise exception '操作过于频繁，请稍后再试（同一账号 60 秒内最多发表 5 条评论或评分，当前已 % 次）', recent
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists ratings_rate_limit on public.ratings;
create trigger ratings_rate_limit
  before insert on public.ratings
  for each row execute function public.enforce_write_rate_limit();

drop trigger if exists comments_rate_limit on public.comments;
create trigger comments_rate_limit
  before insert on public.comments
  for each row execute function public.enforce_write_rate_limit();

-- 本函数只由**触发器**调用（触发器以函数属主权限执行），API 侧不需要任何 EXECUTE 权限。
-- 与文件里其它函数保持一致：显式收回，避免将来 PostgREST 把它当 RPC 暴露出去（默认 PUBLIC 有 EXECUTE）。
-- 只用 revoke（**不用 drop function**）：触发器依赖它，drop 会要求先 drop trigger；
-- 且 `create or replace` 已经保证可重复执行与签名稳定，revoke 本身幂等。
revoke all on function public.enforce_write_rate_limit() from public;
revoke all on function public.enforce_write_rate_limit() from anon, authenticated;

-- ---------- 5c. 限频计数用的索引（F5 的取舍记录） ----------
-- 取舍结论：**建**（成本可控、收益是让「带 user_id 过滤」的计数查询始终走索引）。
--   为什么需要：5b 的计数是
--     select count(*) from public.ratings  where user_id = <uid> and created_at > <cutoff>
--     (+ comments 同形) —— 两张表目前只有主键 id 上的索引，没有 (user_id, ...) 上的索引；
--     现在是小站所以无所谓，但随评分/评论行数增长，每次写入都要全表扫一遍这两张表。
--   为什么成本可接受：复合索引 (user_id, created_at) 同时覆盖过滤条件与范围条件，插入时只多维护一个索引；
--     列上是 text / bigint，体量很小。
--   为什么现在就建（而不是等慢了再说）：当前表很小，`create index` 是短事务、几乎瞬间完成；
--     等表大了再建，普通 create index 会长时间持 ShareLock 阻塞写入（除非用 concurrently，而
--     `concurrently` 不能在事务块里跑、也不能与 IF NOT EXISTS 之外的多语句混跑，不适合放进本脚本）。
--   注意：`create index if not exists` 幂等 —— 整段脚本连跑两遍不会重复建、也不会报错。
create index if not exists ratings_user_created_idx on public.ratings (user_id, created_at);
create index if not exists comments_user_created_idx on public.comments (user_id, created_at);

-- ---------- 6. 注册自动建资料行（auth.users → public.users） ----------
-- users 表策略收紧后前端无法替别人插入行，因此由触发器（SECURITY DEFINER）完成。
--
-- ⚠️ 2026-10 修复（真机事故，根因已用生产数据证实）：
--   事故现象：在 Supabase 控制台删掉一个邮箱后，用**同一个邮箱**重新注册，
--             注册失败，界面报 `duplicate key value violates unique constraint "users_username_key"`。
--   根因：控制台的删除只删 `auth.users` 那一行，**不会**连带删 `public.users` 里的资料行
--         （两者之间没有外键级联）。于是留下一条"孤儿资料行"，它的 username 就是那个邮箱。
--         重新注册时触发器插同一邮箱 → 撞上 `users_username_key` 唯一约束 →
--         **整个注册事务被回滚**（连 auth.users 都建不出来），用户看到的就是"注册不上"。
--         生产库实测：`someone@example.com` 在 public.users 有行、在 auth.users 无行。
--   修法：把 `on conflict (id) do nothing` 改成 `do update set username = excluded.username`。
--         ① 同一 id 重复注册（控制台删了邮箱又用同邮箱注册，id 不变）→ 把 username 改回当前邮箱；
--         ② 已被管理员改过邮箱的账号 → 资料行的 username 跟着更新，不再留旧邮箱；
--         ③ 唯一的键是 id ⇒ 这条 upsert 不会因为别的行占用邮箱而失败。
--         ⚠️ 它只能防"同一 id"的冲突；历史遗留的**不同 id 孤儿行**必须清掉（历史遗留的孤儿行需要手工清一次）。
--   为什么不删孤儿行就算了：孤儿行是历史数据，删了这条；下次再删邮箱还会再造一条。
--   为什么不用 `do nothing` + 先 delete：注册路径上做 delete 会把"删数据"放进一个
--         由匿名注册触发的触发器里，代价与风险都比 upsert 大。
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, username, nickname, avatar_color, created_at, is_admin)
  values (
    new.id::text,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'nickname', ''), split_part(new.email, '@', 1)),
    '#6c5ce7',
    (extract(epoch from now()) * 1000)::bigint,
    false
  )
  /* ⚠️ 冲突目标必须写 (id)：username 上也有唯一约束，写 `on conflict do update`（不带目标）
     在同时撞两个约束时 Postgres 会报 "ON CONFLICT DO UPDATE command cannot affect row a second time"
     那类含糊错误；只按主键 id 处理、把 username 作为被更新的列，语义才明确。 */
  on conflict (id) do update
    set username = excluded.username;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 已经注册过、但还没有资料行的用户，补一行（可重复执行）
-- ⚠️ where 里的 `not exists` 不能省：`on conflict (id) do nothing` 只挡 id 冲突，
--    若某个待补行的**邮箱**已被另一条资料行占用（历史脏数据），这条 insert 会整体报错、
--    中断整段脚本。加上「该 id 还没有资料行」的前提，就把这批行缩到真正缺行的那些。
insert into public.users (id, username, nickname, avatar_color, created_at, is_admin)
select u.id::text,
       u.email,
       coalesce(nullif(u.raw_user_meta_data->>'nickname', ''), split_part(u.email, '@', 1)),
       '#6c5ce7',
       (extract(epoch from now()) * 1000)::bigint,
       false
from auth.users u
where u.email is not null
  and not exists (select 1 from public.users pu where pu.id = u.id::text)
on conflict (id) do update
  set username = excluded.username;

-- ---------- 7. 公开资料视图（评论区显示昵称用） ----------
-- users 表策略收紧后，前端查不到别人的昵称，评论区会全部显示「已注销用户」。
-- 这里用视图只暴露安全字段（不含 password_hash / salt）供公开读取。
--
-- ⚠ 视图 DDL 统一走「drop + create + grant」三件套，不要用 create or replace：
--   CREATE OR REPLACE VIEW 要求既有列同名同序、只允许在末尾多出新列；线上若是旧列序的
--   老视图（例如 `id, username, nickname, avatar_color, created_at`），
--   直接 create or replace 把 is_admin 换到 created_at 之前会报
--     ERROR: cannot change name of view column "created_at" to "is_admin"
--   从而中断整段脚本（真实踩过的坑，本仓会被打包给别人用，对方的库可能是旧列序）。
--   这里的 drop + create 是**全新建视图**：列序就等于下面 select 里写的顺序
--   （不是「往老视图里追加列」）；对全新库与旧列序升级库都成立。
--   三条约束：① drop 必须在（否则第二次执行 create view 会 relation already exists，
--   破坏「整段连续执行两次都不报错」）；② grant 必须在 create 之后（drop 会连带丢掉授权）；
--   ③ 列序固定为 id, username, nickname, avatar_color, created_at, is_admin（is_admin 在末尾）——
--   前端一律按列名查询（storage.js / selfcheck.html 都是 select=xxx），列序不影响调用方。
--
-- ⚠ 授权四件套：select 必须给、insert/update/delete 必须收回（F7 修复，别删掉这几句）：
--   背景：Supabase 对 public schema 的新建对象默认给 anon/authenticated 全部权限
--   （alter default privileges … grant all on tables），视图也算在内；而视图默认以**视图属主**权限执行
--   （security_invoker = false）⇒ 通过视图写入是以属主身份落到基表 public.users 上的，
--   **既绕过 RLS、也绕过 users 的列级授权**。所以只写 `grant select` 是不够的：
--   真机上匿名 PATCH /rest/v1/profiles {nickname} 曾返回 204 并真的改了数据（缺陷 F7，已修）。
--   撤销视图的写权限即可：客户端在「视图」这一层就被权限检查拒掉（42501），写不进去。
--   ⚠ 不要改成 `alter view public.profiles set (security_invoker = on)`：那会让读取也按调用者权限评估，
--     而 public.users 对 anon 没有 SELECT 策略（只有 users_select_own：auth.uid() = id，匿名恒为 NULL）
--     ⇒ 匿名 GET /rest/v1/profiles 会返回空，评论区昵称全部退化成「已注销用户」。
--     真要用 security_invoker，必须同时给 users 加公开读策略（会多暴露整行），收益不划算 —— 本脚本不采用。
--   ⚠ 也不要为了「让用户能改资料」给这个视图加 insert/update/delete：资料修改应走 users 表
--     （已只放开展示列的列级授权），视图是只读出口。
--   ⚠ 升级到本版本必须**整段重跑**：`drop view` 会连带丢掉旧授权、`create view` 又会被默认权限
--     重新授上全部权限，所以只手工跑中间几句（或跑旧版脚本）会把这个洞重新打开 ——
--     revoke 必须和 drop/create/grant 一起、按这个顺序整体执行。
drop view if exists public.profiles;
create view public.profiles as
  select id, username, nickname, avatar_color, created_at, is_admin from public.users;

grant select on public.profiles to anon, authenticated;
-- F7：收回视图上的写权限（public 是 anon/authenticated 授权的源头，一并收回更稳；这两句幂等、可重复执行）
revoke insert, update, delete on public.profiles from public;
revoke insert, update, delete on public.profiles from anon, authenticated;

-- =========================================================
-- 执行后自检：
-- 1) 四张表都已启用 RLS，策略共 14 条
--      users 3（select/insert/update own）· ratings 4 · comments 4 · feedback 3（select/insert/update admin）
--      核对（可重复执行，只读）：
--        select tablename, rowsecurity from pg_tables
--         where schemaname='public' and tablename in ('users','ratings','comments','feedback')
--         order by tablename;                                    -- 期望 4 行、rowsecurity 全为 t
--        select tablename, count(*) from pg_policies
--         where schemaname='public' group by tablename order by tablename;   -- 期望 3 / 4 / 4 / 3
-- 2) 未登录状态下，打分 / 评论 / 改资料 / **提交反馈**应全部失败
--      （feedback 的 insert 策略要求 auth.uid() = user_id，且限频触发器在 auth.uid() 为空时也直接拒绝）
-- 3) 管理员（站点所有者）第一次怎么来——这是「信任根」，只能手工做一次：
--      先在网页用邮箱注册，然后在 SQL Editor 执行
--        update public.users set is_admin = true where username = '你的邮箱';
--      刷新网页，页头会出现「后台」链接，个人主页会显示「管理员」；
--      之后再要加/减管理员，全部走后台按钮（数据库函数 admin_set_admin）。
--      这条路径**必须能成功**（旧版触发器会把它一起拦掉，报 42501 —— 那是缺陷 D-1，本次已修）。
--      先确认放行判据命中（SQL Editor 里逐句执行，期望全部 t）：
--        select session_user = tableowner as is_owner_session,
--               session_user, tableowner
--          from pg_tables where schemaname = 'public' and tablename = 'users';
--        select public.current_session_is_users_owner();          -- 期望 t
--        select coalesce(current_setting('request.jwt.claims', true), '<null>') as claims;  -- SQL Editor 无 claims
--      再确认「真到了 update 这一步，触发器不会 raise」；把上面查到的名字填进引号里（字符串字面量要在单引号内）：
--        select (false is distinct from true)                                  -- true：is_admin 会变化
--             and not public.current_session_is_users_owner()                  -- false：属主会话
--             and coalesce(current_setting('app.allow_admin_flag', true), '0') <> '1'  -- true：无标记
--               as would_raise;                                                -- 期望 f（f = 不会 raise）
--      然后才执行 update 与复核：
--        select username, is_admin from public.users where username = '你的邮箱';
--        select count(*) from public.users where is_admin = true;             -- 期望 >= 1
--      若 is_owner_session = f（例如你的 SQL Editor 因故不是以表属主身份连库），才用逃生舱：
--        begin; select set_config('app.allow_admin_flag', '1', false);   -- 注意：非事务性，false = 会话级
--        update public.users set is_admin = true where username = '你的邮箱'; commit;
--        select set_config('app.allow_admin_flag', '0', false);         -- 用完立刻清掉标记
--      逃生舱的准确边界（前提/结论要分清）：
--      前提 —— PostgreSQL 本身**允许任何角色 SET 自定义 GUC**，所以能否用它当放行标记，取决的不是
--              权限模型，而是「API 面有没有设置它的入口」；
--      事实 —— PostgREST 只暴露 public schema 的函数，set_config 不在暴露面
--              （实测 POST /rest/v1/rpc/set_config → 404 PGRST202），本项目也没有暴露任何可设置
--              该 GUC 的封装函数 ⇒ 普通客户端**没有入口**去设置它；
--      结论 —— 因此该标记目前**不可利用**；能设置它的只有具备 SQL 执行能力的主体
--              （表属主 / SQL Editor、service_role、或本项目自己的 admin_set_admin()）。
--      而「登录用户自提权」被两道同时挡住：① 正常配置下 is_admin 的列级 UPDATE 权限不存在，
--      请求在权限检查阶段就以 42501 拒掉（触发器不会被执行）；② 万一有人误加了表级 UPDATE 授权，
--      触发器里 `not public.is_admin()` 仍会拒 —— 要绕过必须同时破掉这两道，普通客户端两道都没有。
--      用完逃生舱务必：先清标记（上一句）、重跑整段本脚本、再复核 §列表里的拒绝路径。
-- 4) is_admin 加固已生效的验证（普通登录用户不能自提权）：
--      在浏览器控制台（或 Postman）用普通账号的 access_token 发：
--        PATCH {项目URL}/rest/v1/users?id=eq.<自己的uuid>
--        apikey: <publishable key>
--        Authorization: Bearer <普通账号的 access_token>
--        Content-Type: application/json
--        { "is_admin": true }
--      期望：HTTP 403 + 42501 permission denied for table users，
--            并且 GET /rest/v1/profiles?select=is_admin&id=eq.<自己的uuid> 仍是 false。
--            （若哪天有人误把表级 UPDATE 授权加回来，这条请求会改由触发器顶掉，正文变成
--              「拒绝修改 is_admin：…」，同样是 42501 拒绝 —— 两种拒绝对本项验收都算「通过」。）
--      网页版探测：登录普通账号后打开 selfcheck.html，看「is_admin 自提权探测」是否为「通过」。
-- 5) profiles 视图的写路径已关闭（F7 修复的验证）：
--      匿名（只带 publishable key）发这三条，期望**全部被拒**（401/403 + 42501 permission denied for table profiles）：
--        PATCH  {项目URL}/rest/v1/profiles?id=eq.<任意uuid>   body {"nickname":"x"}
--        POST   {项目URL}/rest/v1/profiles                      body {"id":"x","username":"x","nickname":"x"}
--        DELETE {项目URL}/rest/v1/profiles?id=eq.<任意uuid>
--      读要仍然可用（别把评论区昵称弄坏）：GET {项目URL}/rest/v1/profiles?select=nickname&limit=1 → 200 且有数据。
--      SQL Editor 复核视图授权（期望：只有 anon/authenticated 的 SELECT）：
--        select grantee, privilege_type from information_schema.role_table_grants
--         where table_schema='public' and table_name='profiles' order by grantee, privilege_type;
-- 6) 写入频率限制（5b 段的验证）：
--      限频的**真机行为**只能在有真实登录身份时观察（本机没有 PostgreSQL、也没有线上凭据，脚本作者
--      无法代跑）。⚠️ 本节命令由你在自己的环境执行；**不要用 POST 往生产库插测试行**（项目纪律：
--      对生产库只允许「匹配集合必然为空」的 PATCH/DELETE，即 ?id=eq.<绝不存在的 uuid>，且必须回查行数）。
--      ★ 只读核对（SQL Editor，先做这一步：函数与触发器在不在、窗口与阈值是多少）：
--        select p.proname, pg_catalog.pg_get_functiondef(p.oid)
--          from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--         where n.nspname='public' and p.proname='enforce_write_rate_limit';
--        select tgname, tgrelid::regclass from pg_catalog.pg_trigger
--         where not tgisinternal and tgname in ('ratings_rate_limit','comments_rate_limit');
--        期望：1 个函数（定义里 window_ms = 60000、max_writes = 5、统计 ratings + comments 两表）
--              + 2 个触发器（public.ratings / public.comments）。
--      ★ 只读等价观察（看「当前这个账号近 60 秒已写入几次」，<uuid> 换成你自己的 user_id）：
--        select
--          (select count(*) from public.ratings  where user_id = '<uuid>'
--             and created_at > (extract(epoch from now())*1000)::bigint - 60000)
--        + (select count(*) from public.comments where user_id = '<uuid>'
--             and created_at > (extract(epoch from now())*1000)::bigint - 60000) as 近60秒写入次数;
--        期望：正常使用（不是刚刷过）时是 0~2；>= 5 时下一次写入就会被拒（这就是触发器的判据）。
--      ★ 反向用例（别误伤正常人，用**真实操作**观察，不要造测试行）：
--        60 秒内「给 3 首不同的曲子各打 1 次分 + 发 2 条评论」= 5 次写入，应当**全部成功**（第 6 次才会被拒）；
--        之后反复修改自己已有的那条评分（PATCH /rest/v1/ratings?id=eq.<自己那一行的 id>，body 只改 score）
--        应当**始终成功** —— 改分是 UPDATE，本触发器是 before insert，不会被计数。
--      ★ 若你坚持要验证「第 6 次被拒」，请自己在浏览器控制台用**你自己的账号**做，并承担清理责任：
--        连发 6 条评论（POST /rest/v1/comments，song_id 用 '__ratelimit__' 之类的专用值），
--        期望前 5 条 201、第 6 条 403 + 42501（正文含「操作过于频繁，请稍后再试」）；
--        收尾必须回查并清理：先 `select count(*) from public.comments where song_id='__ratelimit__';`
--        再用 `DELETE /rest/v1/comments?song_id=eq.__ratelimit__`（只能删自己的）删掉，并**再回查一次 count = 0**。
--        （这条只能由你执行：成员不得对生产库做会落库的写探测。）
-- 7) 想临时排查问题可以手工关掉某张表的行级安全策略（本仓库不含这类脚本）；**排查完务必重新跑本脚本**，否则那张表会一直裸奔；生产库上不要这样排查。
-- 8) 站内反馈（5a 段的验证）：
--      ★ 只读核对（SQL Editor，先做这一步：表/策略/函数/触发器在不在）：
--        select column_name, data_type, column_default, is_nullable
--          from information_schema.columns
--         where table_schema='public' and table_name='feedback' order by ordinal_position;
--        期望 8 列，且 **id 与 created_at 有 default、handled 有 default false**：
--          id（default 'f_' || gen_random_uuid()）、user_id、category（default 'other'）、
--          body、created_at（default 服务端毫秒）、handled、handled_at
--        select conname, pg_get_constraintdef(oid) from pg_constraint
--         where conrelid = 'public.feedback'::regclass order by conname;
--        期望看到 category 枚举（bug/suggestion/other）与 char_length(body) between 10 and 500。
--        select p.proname, pg_catalog.pg_get_functiondef(p.oid)
--          from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--         where n.nspname='public' and p.proname in ('enforce_feedback_rate_limit','admin_set_feedback_handled');
--        期望 2 个函数：前者 window_ms=60000 / max_writes=3 / 只统计 feedback；
--                     后者参数名是 **make_handled**（若看到参数叫 handled，说明脚本没跑最新版，
--                     那个版本里 `set handled = handled` 是空操作，务必重跑本脚本）。
--        select tgname, tgrelid::regclass from pg_catalog.pg_trigger
--         where not tgisinternal and tgname = 'feedback_rate_limit';      -- 期望 1 行
--      ★ 列级授权核对（「管理员只能改处理状态」的第二道防线）：
--        select grantee, privilege_type, column_name
--          from information_schema.column_privileges
--         where table_schema='public' and table_name='feedback'
--         order by grantee, privilege_type, column_name;
--        期望：authenticated 在 feedback 上**只有** handled / handled_at 的 UPDATE，没有 delete。
--      ★ 真机行为（只能在你的环境观察；项目纪律：**不得对生产库做会落库的写探测**）：
--        · 未登录：`POST /rest/v1/feedback` 应 401/403（RLS + 限频触发器双拒）。
--        · 非管理员读他人：用**小号**登录后 `GET /rest/v1/feedback?select=id,user_id`
--          应只返回**自己**的行（他人的行不可见，不是「返回了但字段为空」）。
--        · 标记已处理：管理员在后台点「标记已处理」，随后只读回查
--            select id, handled, handled_at from public.feedback order by created_at desc limit 5;
--          期望 handled 由 f → t 且 handled_at 非空。
--        · 限频：同一账号 60 秒内第 4 条反馈应被拒（42501，正文含「提交过于频繁」）。
--          ⚠️ 若你坚持要实测这一条，请自己在浏览器里用**你自己的账号**提交，并承担清理责任
--          （feedback 没有 delete 策略，前端删不掉 —— 只能由你在 SQL Editor 里
--            `delete from public.feedback where id = '<那条>'` 收尾，并回查 count 确认）。
-- =========================================================
