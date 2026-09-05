# Sub-Store Workers 项目总图

> 生成时间: 2026-04-23 15:11（最近更新: 2026-09-04）
> 项目: sub-store-workers
> 类型: project-level codemap

## 1. 项目定位

将 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 后端从 Node.js 移植到 Cloudflare Workers 运行时。**仅替换平台相关层，核心业务逻辑零修改**（构建时从 `../Sub-Store/backend/src/` 引入）。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│              Cloudflare Workers Runtime              │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ index.js │──▶│ express.js   │──▶│ 上游 restful │ │
│  │  入口     │   │ 路由适配层    │   │ 路由处理器    │ │
│  └────┬─────┘   └──────────────┘   └──────────────┘ │
│       │                                              │
│  ┌────▼─────┐   ┌──────────────┐   ┌──────────────┐ │
│  │open-api  │──▶│ KV Namespace │   │ esbuild.js   │ │
│  │存储适配层 │   │ (持久化)      │   │ 构建桥接      │ │
│  └──────────┘   └──────────────┘   └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

## 3. 文件清单与职责

### 3.1 平台适配层（`src/`，本项目自有）

| 文件 | 职责 |
|---|---|
| `src/index.js` | **Workers 入口**：CORS 预检、KV 绑定校验、路径前缀鉴权（含未配置警告头）、KV 初始化、路由分发、Cron 定时同步 |
| `src/vendor/express.js` | **Express 适配**：将 Workers fetch handler 适配为类 Express 的 req/res 路由 |
| `src/vendor/open-api.js` | **OpenAPI 适配**：KV 替代 fs 存储、fetch 替代 undici、日志/通知/推送 |
| `src/core/app.js` | 单例 `$` 导出（`new OpenAPI('sub-store')`） |
| `src/utils/env.js` | 环境检测变量，`backend = 'Workers'`，`isWorker = true` |
| `src/restful/miscs.js` | 工具 API：`/api/utils/env`（暴露 `SUB_STORE_*` 给前端）、`/api/utils/worker-status`（KV/鉴权/能力诊断）、Gist 备份/还原、存储管理、刷新 |
| `src/restful/token.js` | Token 签发/删除（Workers 版，替换上游 JWT 方案为 nanoid） |
| `src/vendor/quickjs-executor.js` | **QuickJS 脚本沙箱**：替代上游 `new Function()` 执行用户脚本（Script Operator/Filter），支持 func / nodeFunc / content 三种模式，详见 4.4 |
| `src/utils/backend-path.js` | **路径前缀归一化与匹配**（纯函数，零依赖零副作用）：把 `/`、`/密码/`、`密码` 这几种会锁死部署的写法归一化；前缀匹配比上游更严（要求前缀后紧跟 `/`），详见 6 |
| `src/utils/rs.js` | **证书指纹计算**，覆写上游同名文件。上游用 `jsrsasign`，但它在 Workers 下必须存根（见 7），调用会抛错并连带搞崩整条订阅。改用 `@noble/hashes` 的同步 sha256（纯 JS、经审计、加载时无副作用）；不能用 Web Crypto——`subtle.digest` 是异步的而调用点是同步赋值。比上游更稳健：畸形输入告警并返回 `undefined` 而非抛错 |

### 3.2 构建层

| 文件 | 职责 |
|---|---|
| `esbuild.js` | **构建脚本**：4 个 esbuild 插件桥接 Workers 与上游源码；同时把上游 `createDynamicFunction` 替换为 QuickJS 沙箱执行（`SCRIPT_ENGINE=disabled` 可关闭）。开头会校验 `../Sub-Store` 的 HEAD 与 `.upstream-sha` 是否一致——本地不一致时警告（`--strict` 则失败），CI 下跳过（同步流程中不一致属正常，标记要到最后一步才更新） |
| `.babelrc.js` | **测试用 Babel 配置**：`@/` 别名解析顺序与 esbuild 的 aliasPlugin 严格一致（Workers `src/` 优先 → 回退上游）。上游用的 `babel-plugin-relative-path-import` 在 Windows 下不做相对路径计算，故换成 `babel-plugin-module-resolver`，Linux/macOS/Windows 行为统一 |
| `wrangler.toml` | Workers 部署配置：KV 绑定、Cron、环境变量（路径密码推荐改用 Worker Secret） |
| `package.json` | 依赖与脚本（`test`、`deploy`、`deploy:pages`、`rotate-secret`、`rotate-secret:sh`） |

### 3.2.1 测试（`src/test/`）

沿用上游标准：**mocha + chai + @babel/register**（`npm test`）。CI 在 `npm ci` 之后、构建之前执行。

| 文件 | 覆盖内容 |
|---|---|
| `src/test/utils/backend-path.spec.js` | 前缀归一化 / 严格匹配 / 剥离，锁定 `/`、`/密码/`、`密码` 不再锁死部署 |
| `src/test/utils/ip-address.spec.js` | 锁定 `ip-address` ≥10.x 拒绝前导零 IPv4（CVE-2026-69192），防止依赖被回退 |
| `src/test/utils/rs.spec.js` | 证书指纹：与真实 `jsrsasign` 及 Node 原生 `crypto` 逐字节交叉校验，并锁定「畸形输入返回 `undefined` 而非抛错」 |

> 注意：测试里不要经 `@/` 间接引入上游模块来断言其**第三方依赖**行为。上游源码中的裸模块名（如 `import 'ip-address'`）在 @babel/register 下走 Node 默认解析，会沿目录树向上命中仓库外的 `node_modules`，结果因机器而异；构建侧不受影响，因为 esbuild 用 `nodePaths` 强制解析到本项目的 `node_modules`。要断言依赖行为就直接 `import` 该依赖。

### 3.3 运维脚本（`scripts/`）

| 文件 | 职责 |
|---|---|
| `scripts/rotate-secret.ps1` | Windows PowerShell：生成随机 URL-safe 密码，通过管道写入 Cloudflare Worker Secret `SUB_STORE_FRONTEND_BACKEND_PATH`，并复制到剪贴板 |
| `scripts/rotate-secret.sh` | Linux/macOS Bash：同上，自动选择 `pbcopy`/`wl-copy`/`xclip`/`xsel` |

### 3.4 上游源码（构建时引入，`../Sub-Store/backend/src/`）

通过 esbuild `@/` 别名解析：**Workers `src/` 优先 → 回退到上游 `src/`**。

关键上游模块：
- `restful/subscriptions` — 订阅 CRUD
- `restful/collections` — 组合订阅
- `restful/artifacts` — 制品生成 + Gist 同步
- `restful/download` / `restful/preview` — 分享链接（公开 API）
- `core/proxy-utils/` — 代理协议解析（Surge/Loon/QX peggy 语法）
- `utils/migration` — 数据迁移

## 4. 核心流程

### 4.1 HTTP 请求处理

```
Browser → fetch()
  │
  ├─ OPTIONS → 返回 CORS headers
  │
  ├─ KV 绑定校验（缺失 SUB_STORE_DATA → 500 明确错误）
  │
  ├─ 路径前缀鉴权（可选）
  │   ├─ 未配置 SUB_STORE_FRONTEND_BACKEND_PATH 且访问 /api/*
  │   │     → 控制台警告 + 响应头 X-Sub-Store-Security-Warning
  │   ├─ 已配置时：/api/* 无前缀 → 401
  │   ├─ /backendPath 精确 → 302 重定向
  │   └─ /backendPath/... → 剥离前缀
  │
  ├─ $.initFromKV(KV) → 加载缓存
  ├─ migrate() → 数据迁移
  ├─ $app.handleRequest(request) → Express 路由分发
  │   ├─ 中间件链
  │   ├─ dispatchRoute() → 最长匹配路由
  │   └─ 404 兜底
  │
  └─ ctx.waitUntil($.persistCache()) → 回写 KV
```

### 4.2 Cron 定时同步

```
scheduled() → cronSyncArtifacts()
  ├─ 检查 GitHub Token / artifacts
  ├─ 预生成订阅缓存（并行）
  ├─ 生成所有 artifacts（并行）
  ├─ syncToGist(files)
  ├─ 更新 artifact URL
  ├─ gistBackupAction('upload')
  └─ $.persistCache()
```

### 4.3 esbuild 构建管线

```
esbuild.js
  ├─ aliasPlugin: @/ → Workers src/ 优先，回退上游 src/
  ├─ peggyPrecompilePlugin: PEG 语法 → 预编译 JS 解析器
  ├─ evalRewritePlugin: eval() → Workers 兼容替换
  └─ nodeStubPlugin: Node 模块 → Proxy 存根
```

### 4.4 QuickJS 脚本执行（Script Operator/Filter）

上游用 `new Function()` 动态执行用户脚本，Workers 禁止运行时代码生成，改用 QuickJS WASM 沙箱（`src/vendor/quickjs-executor.js`）。按输入类型分三种模式：

```
createScriptFunction(script, name)
  ├─ func 模式：IIFE 包裹脚本 → 返回 function operator/filter → 调用
  ├─ 失败且输入是节点数组 → nodeFunc 模式：快捷脚本逐 $server 遍历
  └─ 失败且输入含 $content/$files（文件/覆写场景） → content 模式：
       ├─ mihomoConfig/mihomoProfile 文件：沙箱内取脚本的 main 函数，
       │    宿主侧 YAML 解析 $content → main(config) → YAML 序列化回 $content
       │    （YAML 在宿主侧处理，因沙箱内无 ProxyUtils）
       └─ 其他文件：注入 $content/$files 全局变量直接执行脚本，回读结果
```

> 背景：早期实现缺少 content 模式，$content 输入被当作节点数组遍历（对象无
> length，循环不执行），导致 convert.js 类覆写脚本不报错但输出空配置。

## 5. 数据存储

- **KV Key: `sub-store`** — 主缓存（订阅/组合/设置/tokens/artifacts）
- **KV Key: `root`** — 根数据
- **写入策略**：请求结束时 `persistCache()` 对比 snapshot，变化才写（防止无意义写入）
- **读取策略**：`cacheTtl: 60` 秒边缘缓存

## 6. 安全机制

- **路径前缀鉴权**：`SUB_STORE_FRONTEND_BACKEND_PATH`，**推荐用 Cloudflare Worker Secret 存放**（`wrangler secret put` 或 `npm run rotate-secret`），不要写在 `wrangler.toml [vars]` 里——后者明文存仓库且会被 `wrangler deploy` 覆盖同名 Secret。
  - **匹配比上游严**：要求前缀后紧跟 `/` 或完全相等。上游 `matchesBackendPath` 用 `path.startsWith(backendPath)`，会让 `/secretFOO/...` 通过 `/secret` 的校验并被剥离成 `FOO/...`；本项目刻意不复用其实现，只沿用它对 `/` 的语义。
  - **归一化容错**：`/`、`/密码/`、`密码` 三种写法在归一化前会让管理 API 全部返回 401 且无任何入口（硬砖）。现统一由 `src/utils/backend-path.js` 处理，其中 `/` 按上游语义等价于「不要求前缀」，即管理 API 公开并照常发安全告警。
- **未配置鉴权告警**：未配置时管理 API 访问会输出控制台警告并附加响应头 `X-Sub-Store-Security-Warning`，提醒部署者尽快设置密码。
- **公开路径白名单**：`/api/download`、`/api/preview`、`/api/sub/flow` 不受鉴权限制
- **CORS**：全局 `Access-Control-Allow-Origin: *`，集中在 `src/index.js` 的 `CORS_HEADERS` 常量（便于后续单点收紧）。
  ⚠️ **与上游已分叉**：上游 2.38.x 把默认值从 `*` 收紧为白名单（`utils/cors.js`），但其唯一引用者是 `vendor/express.js`，而本项目覆盖了该文件——上游整个 `cors.js` 在产物中出现 0 次，是死代码。未设路径前缀时，任意站点的 JS 可跨域读取全部订阅配置，路径密码是当前唯一防线。收紧需要同时提供 `SUB_STORE_CORS_ALLOWED_ORIGINS` 配置入口，否则自建前端域名会失效。
- **Script Operator 沙箱化**：构建期改写 `createDynamicFunction` 为 QuickJS WASM 沙箱执行（内存/栈/指令数限制），避免 `eval`/`new Function`；可用 `SCRIPT_ENGINE=disabled` 关闭。
- **状态自检**：`/api/utils/worker-status` 输出 KV 绑定、鉴权、能力降级（脚本/socks/本地文件系统/cron）等运行时信息，方便部署后快速验证。

## 7. 外部依赖

| 依赖 | 用途 |
|---|---|
| `peggy` | PEG 语法编译（构建时） |
| `js-base64` | Base64 编解码 |
| `nanoid` | Token 生成 |
| `ms` | 时间字符串解析 |
| `lodash` | 工具函数 |
| `ip-address` | IP 地址处理，`^10.3.1`（与上游同版，含 CVE-2026-69192 修复；`^9.x` 接受前导零 IPv4） |
| `yaml` | YAML 解析（`src/vendor/quickjs-executor.js` 的 content 模式在宿主侧解析/序列化） |
| `jsrsasign` | 上游 `utils/rs.js` 用它算证书指纹。**必须存根，不能真实打包**——它在模块加载时（全局作用域）就生成随机数种子，Workers 禁止在全局作用域生成随机值，真实打包会让 `wrangler deploy` 被服务端校验拒绝（`code 10021: Disallowed operation called within global scope`）。注意 esbuild 构建**不会**报错，只有部署时才暴露。仅作为测试基准保留在 `dependencies`（`src/test/utils/rs.spec.js` 用真实 jsrsasign 与覆写实现做逐字节交叉校验） |
| `@noble/hashes` | 同步 SHA-256，供 `src/utils/rs.js` 计算证书指纹。**精确钉在 `2.2.0`**（不用 `^`）：`age-encryption` 的传递依赖已把它提升到顶层 2.2.0，用 `^` 会顶到更新版本并额外派生一份 `@noble/curves/node_modules/@noble/hashes`，既多打包一份哈希代码，也顺带改变 age 路径实际使用的版本 |
| `esbuild` | 构建（dev） |
| `wrangler` | 部署 CLI（dev） |
| `mocha` / `chai` / `@babel/*` / `babel-plugin-module-resolver` | 测试（dev），见 3.2.1 |

> 已移除的死依赖：`static-js-yaml`（源码零引用，却拖来整条 2014 年的 `static-module`
> 依赖链——`minimist@0.0.8`、`through2@0.4.x`、`readable-stream@1.0.x` 等，是安全扫描
> 报 CVE 的来源）、`semver`（源码零引用）。两者在产物中出现次数均为 0，移除不影响运行时。

## 8. 已知风险与注意事项

1. **并发安全**：Workers 无状态但 `$.cache` 是全局 in-memory 对象，高并发下可能 read-modify-write 竞争
2. **KV 最终一致性**：KV 读有 60s cacheTtl，写入后可能延迟可见
3. **上游兼容性**：上游 Sub-Store 更新可能引入 Node-only API，需要构建时通过存根或适配处理
4. **CPU 时限**：Workers 免费版 10ms CPU / 请求，复杂订阅处理可能超时。付费版默认 30s，可用 `wrangler.toml` 的 `limits.cpu_ms` 调至 300000（5 min）。注意这是 **CPU 时间不是墙钟时间**——墙钟时长本身不限，等待慢响应几乎不消耗 CPU；但 subrequest 存在未文档化的 ~90 秒截断，拉取订阅建议自行加 `AbortSignal.timeout()`
5. **全局状态污染**：`globalThis.__workerEnv` 在并发请求间共享，理论上存在竞态
6. **Pages 与 Workers 配置不互通**：`wrangler.toml` 的 `[vars]`/`[[kv_namespaces]]` 不影响 Pages 项目，需要在 Cloudflare Dashboard 单独绑定 KV 与设置 `SUB_STORE_FRONTEND_BACKEND_PATH`（建议设为 Pages Secret）。
7. **`[vars]` 与 Worker Secret 同名冲突**：若同时存在，`wrangler deploy` 会用 `[vars]` 明文覆盖 Secret，破坏 CI Secret 管理流程；只用其中一种。
8. **路径密码不可恢复**：Worker Secret 在 Dashboard 看不到原文，遗忘只能通过 `npm run rotate-secret` 重置。
9. **`src/index.js` 是上游 `restful/index.js` 的手工 fork**（不是覆盖——它完全不 import 上游那个文件，自己重新注册全部路由）。上游给 `restful/index.js` 新增路由或中间件时，这边会**静默漏掉**；`SUB_STORE_FRONTEND_BACKEND_PATH` 支持 `/` 就是这个机制的第一次实际发作。同步后建议比对两侧的 `register*Routes` 列表（当前两侧各 17 个、一致）。
10. **本地开发：仓库外的 `node_modules` 会污染裸模块解析**。上游源码里的 `import 'ip-address'` 这类裸模块名，在 `@babel/register` 下沿目录树向上查找，可能命中两个仓库之外的 `node_modules`（不同机器不同结果）。构建侧不受影响（esbuild 用 `nodePaths` 强制解析到本项目），但写测试时要注意，见 3.2.1 的注意事项。
11. ~~**`ca-str` 证书指纹不可用**~~ —— **已修复**，见 3.1 的 `src/utils/rs.js`。原问题：`jsrsasign` 在 Workers 下必须存根，导致上游 `core/proxy-utils/index.js:1168` 的 `rs.generateFingerprint(caStr)` 抛 `TypeError: Cannot read properties of undefined (reading 'Util')`；而该调用点在 try 块**之外**（上面那个 try 只包了「读 CA 文件」），其调用方 `lastParse()` 的两个调用点（`:80`/`:90`）也没兜底 —— 所以一个带 `ca-str` 的节点会让**整条订阅解析失败**。
12. **存根列表的改动必须实机验证**：`nodeStubPlugin` 的 stubs 列表决定哪些模块被替换成 Proxy 空实现。把某个模块从列表移出改为真实打包时，**esbuild 构建成功不代表能部署** —— Workers 对全局作用域有额外限制（禁止异步 IO、定时器、生成随机值），违规只在 `wrangler deploy` 的服务端校验或 `wrangler dev`（本地 workerd）阶段才暴露。改动存根列表后务必先跑 `npx wrangler dev` 确认能启动。
