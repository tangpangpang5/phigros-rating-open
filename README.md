# Phigros 谱面评价站

给节奏游戏 **Phigros** 玩家用的谱面评价网站：收录曲目、给谱面打分（1–10 分）、写评论、看榜单，另有一个管理后台。

- **技术形态**：纯静态前端（原生 ES Module + 手写 CSS，**无框架、无打包器、无 npm 依赖**）+ Supabase（PostgreSQL / Auth / 行级安全策略），任何静态托管都能放。
- **代码规模**：8 个 ES 模块（约 3000 行）+ 3 个 CSS。
- **许可**：代码 **MIT**；曲目数据与曲绘**不随本仓库分发**（见「曲目数据」与「版权」两节）。

> ⚠️ 页面用 ES 模块，**必须用 http(s) 打开**。直接双击 `index.html`（`file://`）会被浏览器拦掉模块与后端请求。

---

## 一、功能

**曲库与浏览**

- 全曲目谱面库，按曲包分类（主线 / 支线 / 联动 / 外传 / 单曲）。
- 搜索：曲名、曲师、谱师、章节。
- 筛选：曲包、难度（EZ / HD / IN / AT）；排序：新曲 / 评分 / 评分数 / 定数 / 曲名，可升可降。
- 曲绘按 `covers/<曲目id>.jpg` 约定加载，缺图自动显示灰色占位图。

**打分与评论**

- 登录用户给每首谱面打 **1–10 分**，随时可改；显示平均分、评分人数与 1–10 分分布。
- 评论 500 字以内，可删自己的；管理员可删任意评论。
- 每条评论带发表时选的难度标签（历史评论没有该字段时不显示徽标）。

**榜单**（`#/rank`）

- 按平均分 / 评分数 / 定数排序，可按「最少评分数」过滤掉样本太少的曲子。
- 前端从评分表实时聚合，不需要额外的统计表。
- 卡片式：1:1 曲绘 + 排名号；桌面三列、手机单列。

**账号与管理后台**（`#/admin`，仅管理员可见）

- 邮箱 + 密码注册 / 登录 / 退出，由 Supabase Auth 托管，密码不经过本站后端。
- 后台：筛评论并删除、看用户列表、用按钮给人加 / 减管理员（走数据库函数，不能改自己那行）。
- 站内反馈：登录用户提交（分类 + 10–500 字），只有管理员看得到，可标记「已处理」。
- 管理员身份只存在数据库里，前端没有「伪管理员」判定。

**外观与设置**

- 两套风格（现代·构成主义 / 简约·Apple 风）× 四种外观（浅·红 / 浅·蓝 / 深·红 / 深·蓝）。
- 设置面板：折叠侧栏、工具栏吸顶、紧凑卡片、切换过渡动画（Phigros 加载页语言：随机曲绘重度模糊 + 压暗 + 右下角 `Loading…` 方块）。
- 响应式：宽屏是左侧竖排侧栏，窄屏变成顶部横条。

**只读演示模式**

没配后端、或后端读不到时，页面自动降级：曲库与示例数据照常浏览，写入入口禁用并给出说明。

---

## 二、快速开始

需要 **Node.js**（只用来起本地静态服务器）和一个 **Supabase** 项目（免费版够用）。

```bash
# 1. 起本地服务（不需要 npm install，本仓库没有依赖）
node serve.js
# 2. 浏览器打开 http://localhost:8000
```

此时页面是**只读演示模式**（没配后端）。要真正能注册 / 打分 / 评论，按下一节接上 Supabase。

---

## 三、接上 Supabase

**1）建库**：新建 Supabase 项目 → 打开 **SQL Editor** → 把 `supabase-setup.sql` **整段粘贴执行**（脚本可重复执行，不会报错）。

它一次装好：建表、行级安全策略（RLS）、注册触发器、`profiles` 视图、`is_admin` 加固（列级授权 + 触发器 + `admin_set_admin()` 函数）、写入限频触发器。

**2）复制一份配置模板并填写**：

```bash
cp config.example.js config.js
```

然后编辑 `config.js`：

```js
window.PHIGROS_BACKEND = {
  enabled: true,
  url: 'https://<你的项目ref>.supabase.co',   // Supabase → Settings → API → Project URL
  anonKey: 'sb_publishable_...'              // 只能用 publishable / anon 公钥
};
```

> 仓库里带的是 `config.example.js` 模板，**真正的 `config.js` 被 `.gitignore` 忽略** ——
> 这样你自己填了地址的那份不会被误提交。

> anon / publishable 公钥本来就是给浏览器用的，公开不算泄密 —— **真正的防线是数据库里的 RLS 策略**。
> **绝对不要**把 `service_role` / secret 密钥写进任何前端文件，那等于把数据库钥匙发给每个访客。

**3）注册账号并指定第一个管理员**：第一个管理员只能在 SQL Editor 手工指定一次（这是站点的信任根）：

```sql
update public.users set is_admin = true where username = '你的注册邮箱@example.com';
```

刷新页面后页头会出现「后台」入口。**之后再加 / 减管理员一律用后台按钮**，不要再写 SQL。

**4）自检**：打开 <http://localhost:8000/selfcheck.html> —— 它会检查配置、Auth 可达性、各表是否可读、未登录写入是否真的被拦，以及「普通账号能不能把自己变成管理员」（应当显示「已被拒绝」）。

---

## 四、曲目数据

**本仓库不包含 `songs.json`，也不包含 `covers/`**。原因见「版权」一节。要跑起来需要自备：

- `songs.json`：一个数组，字段如下（缺了它页面会明确提示「没有 songs.json」，不会白屏）：

```json
[
  {
    "id": "song_id",
    "title": "曲名",
    "artist": "曲师",
    "charter": "谱师",
    "chapter": "所属曲包",
    "category": "单曲精选",
    "bpm": 180,
    "isNew": true,
    "difficulties": [
      { "level": "EZ", "rating": 5,  "constant": 5.0 },
      { "level": "HD", "rating": 10, "constant": 10.5 },
      { "level": "IN", "rating": 15, "constant": 15.5 },
      { "level": "AT", "rating": 16, "constant": 16.3 }
    ]
  }
]
```

  - `category` 目前只用于分组，取值：主线章节 / 支线章节 / 联动精选 / 外传章节 / 单曲精选。
  - `level` 取值 `EZ` / `HD` / `IN` / `AT`；没有 AT 的谱面不要写 AT。
  - 卡片渐变封面由前端自动分配，不用手写 `cover` 字段。

- `covers/<曲目id>.jpg`：曲绘按曲目 id 命名放进 `covers/` 即可，**不依赖任何映射文件**，整个目录一起移动也不会丢图；缺图显示灰色 NO ART 占位。

---

## 五、开发与测试

开发脚本都在 `dev/`：两个本地 Mock Supabase（不需要联网、也不需要真库）与四套用例。

```bash
node dev/mocksupa.js        # 终端 A：8123 空库夹具（旧策略对照组）
node dev/mocksupa-rpc.js    # 终端 A2：8124 加固版（预置夹具账号 root@example.com / root123456）
node serve.js               # 终端 B：静态服务器
# 浏览器打开：
#   http://localhost:8000/dev/test-auth.html         24 条：注册/登录/打分/评论
#   http://localhost:8000/dev/test-ui.html           30 条：界面交互
#   http://localhost:8000/dev/test-rank-admin.html   64 条：榜单与后台权限
node --test dev/test-rank.js                       # 13 条榜单计算纯函数单测（不需要浏览器）
```

三条纪律（都是踩过的）：

1. 用例页**每次用全新的浏览器 profile** —— 用例结尾会写 `localStorage`（主题 / 外观 / 折叠态），复用会带脏状态产生假失败。
2. **8123 的两个用例页不能共用同一实例**，会互相写脏。
3. 端口被旧进程占住时先释放再跑。

`dev/mocksupa-rpc.js` 里那两个预置账号**只是本地夹具**，站点本身没有任何内置账号。

打包发布用 `dev/build-site.js`（把站点必需文件复制进 `dist/`）。⚠️ 它内置了针对**完整数据仓库**的数量校验（必需单文件清单、`js/` 模块数、`covers/` 曲绘数）——在本仓库（没有 `covers/`）上会**故意失败退出**，需要自己按实际情况改那份清单再跑。

---

## 六、部署

纯静态，任何静态托管都行（Cloudflare Pages / Netlify / Vercel / GitHub Pages / 自己的服务器）：

1. 把仓库推到你自己的 Git 托管。
2. 托管平台新建站点，**构建命令留空**（没有构建步骤），**输出目录填 `dist/`**（如果用 `dev/build-site.js` 打包过）或直接指向仓库根目录。
3. ⚠️ **部署环境里必须有一份 `config.js`**：它被 `.gitignore` 忽略，所以「只把仓库推上去」的部署方式会让线上取不到它 ⇒ 站点会**静默退回只读演示模式**（能浏览，但不能注册 / 打分 / 评论）。三种做法任选：
   - 把填好的 `config.js` 强制加入版本库：`git add -f config.js`（注意：这样你的项目地址与公钥会进仓库 —— 它们本来就是公开信息，但你要清楚这一点）；
   - 让托管平台在构建/部署阶段生成它（例如从环境变量写出 `config.js`）；
   - 自己维护一个私有部署仓，把 `config.js` 放在那里。
4. 必须 HTTPS 或 localhost，否则浏览器会拦截部分功能。

> 每次改了 CSS / JS，记得把 `index.html` 里几处静态资源的 `?v=` 版本串一起改一版，否则老访客会继续吃浏览器缓存。

---

## 七、文件结构

```
.
├── index.html          页面入口
├── config.example.js   后端配置模板（复制成 config.js 再填；config.js 已被 .gitignore 忽略）
├── data.js             只读演示模式的展示数据（无账号）
├── logo-placeholder.png 页头 logo 的占位图（**请换成你自己的图**；favicon 用的是内联 SVG，不占文件）
├── js/
│   ├── config.js       配置读取 + 统一错误/提示条
│   ├── songs.js        曲库加载、筛选排序、封面
│   ├── storage.js      Supabase REST 客户端、会话持久化、数据缓存与读写
│   ├── auth.js         注册 / 登录 / 退出 / 重发验证 / 重置密码
│   ├── ui.js           界面渲染与交互（页头/首页/详情/主页/弹窗/主题/设置/路由）
│   ├── rank.js         榜单：纯计算 + 视图
│   ├── admin.js        管理后台
│   └── main.js         入口：初始化顺序与路由启动
├── modern.css          现代风格（构成主义）
├── minimal.css         简约风格（Apple 风）
├── layout.css          布局、侧栏、设置面板、移动端适配（始终加载）
├── supabase-setup.sql  建表 + RLS + 注册触发器 + profiles 视图 + is_admin 加固 + 写入限频
├── selfcheck.html      后端自检页（含「自提权探测」）
├── serve.js            本地静态服务器
└── dev/                开发与测试脚本（Mock、用例、打包脚本）
```

---

## 八、安全说明

- **`service_role` 密钥绝不能进前端**，前端只用 publishable / anon 公钥；防线是 RLS 与列级授权。
- 管理员的提权只允许通过数据库函数 `admin_set_admin()`，且**不能改自己那一行**；直接 `PATCH` 修改 `is_admin` 会被列级权限拒绝（`42501`）。
- **写入限频**：同一账号 60 秒内对评论 + 评分的合计写入最多 5 次，第 6 次被数据库拒绝。反复修改自己已有的评分不算新写入（改分走 UPDATE），调分不会被锁。
- 账号只需邮箱，邮箱只用于登录与找回密码，不在页面公开显示。`profiles` 视图对外只暴露昵称与头像色（评论区要显示），不要把隐私字段放进去。
- 部署前请通读一遍 `supabase-setup.sql`：它授予的每一条权限都写明了理由。

---

## 九、版权与许可

- **代码：MIT**，见 [LICENSE](LICENSE)。可以自由使用、修改、分发，保留版权声明即可。
- **本仓库里随代码一起按 MIT 分发的，只有代码本身与两张背景图**（`bg.jpg` / `bg2.jpg`，项目所有者自备素材）。
- ⚠️ **下面这些不在 MIT 授权范围内，本仓库也不分发它们**：
  - **曲目数据**（`songs.json`）：曲名 / 曲师 / BPM / 难度 / 定数这类资料，原始整理来自**萌娘百科**，版权与署名归其贡献者；
  - **曲绘**（`covers/`）：版权归 **Phigros 的曲师与插画师**，以及发行方 **Pigeon Games（鸽游）**；
  - **站点图标**：原图标取自游戏素材，版权不属本项目 ⇒ 本仓库用的是**自制占位图** `logo-placeholder.png`，favicon 用内联 SVG。
  - 想部署自己的实例，请自行准备数据与图标并遵守来源方的许可；**不要**把别人受版权保护的素材按 MIT 再分发出去。
- 本站是非官方同人项目，**与 Pigeon Games（鸽游）无关**，不含任何商业化用途。
- 版权方或作者要求下架相关内容，请到 <https://github.com/tangpangpang5/phigros-rating-open/issues> 开 Issue 说明作品名与诉求（这是本项目唯一的反馈与下架入口）。
