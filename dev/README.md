# dev/ · 开发与测试脚本

这些脚本**不是站点运行必需的**（站点只需要根目录那几个文件）。放在这里是为了能离线验证后端行为、以及跑完整用例。

## 本地 Mock Supabase

不需要联网、也不需要真实的 Supabase 项目：

| 脚本 | 端口 | 语义 |
|---|---|---|
| `mocksupa.js` | 8123 | **空库 · 旧策略对照夹具**（故意没有列级权限拒绝，用来验证「加固前后」的差异） |
| `mocksupa-rpc.js` | 8124 | **加固版**（列级权限拒绝 + `admin_set_admin` 守卫） |

`mocksupa-rpc.js` 预置两个账号：`root@example.com / root123456`（管理员）、`user1@example.com / user123456`（普通用户）。
**这两个只是本地夹具的预置账号**，站点本身没有任何内置账号，也没有默认密码。

端口可用环境变量改：`MOCK_PORT=8125 node dev/mocksupa.js`。

## 用例

| 用例页 / 脚本 | 条数 | 默认后端 |
|---|---|---|
| `test-auth.html` | 24 | 8123 |
| `test-ui.html` | 30 | 8123 |
| `test-rank-admin.html` | 64 | 8124 |
| `node --test dev/test-rank.js` | 13 | 不需要浏览器、不需要起服务 |

跑法：

```bash
node dev/mocksupa.js        # 终端 A：8123
node dev/mocksupa-rpc.js    # 终端 A2：8124
node serve.js               # 终端 B：静态服务器
# 浏览器打开 http://localhost:8000/dev/test-auth.html 等
```

**三条纪律**（都是踩出来的坑）：

1. 用例页**每次用全新的浏览器 profile**：用例结尾会写 `localStorage`（主题 / 外观 / 折叠态），复用 profile 会带脏初始态，产生**假失败**。
2. **8123 的两个用例页不能共用同一个 Mock 实例**：会互相写脏（表现为 `Failed to fetch` 或通过数骤降）。
3. 端口被旧进程占住时先释放再跑：`Get-NetTCPConnection -LocalPort 8123 -State Listen | Stop-Process -Id $_.OwningProcess -Force`。

## 打包

```bash
node dev/build-site.js
```

把站点必需文件复制进 `dist/`（先写临时目录，三道闸门全过才原子替换）。

⚠️ **本仓库上它会故意失败**：脚本内置了针对**完整数据仓库**的数量校验（必需单文件清单、`js/` 8 个模块、`covers/` 311 张曲绘），而本仓库按设计不含 `covers/` 与 `songs.json`。要用它请先按自己的实际情况改 `REQUIRED_FILES` / `REQUIRED_DIRS` 两份清单。

## 其它

`node dev/yaml-lint.js <file.yml> ...`：极简 YAML 结构自检（本仓库没有 npm 依赖，装不了 YAML 解析器），只用来排除缩进、漏冒号、制表符这类低级错误；不替代 GitHub 自己的校验。
