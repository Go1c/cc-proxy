# Zeabur 部署 TODO（V1 仅功能验证）

目标链路：**部署服务到 Zeabur → 容器内装 claude CLI → 认证 → 启动服务 → 等待用户连接**

安全/商业暂不考虑，V1 只验证功能能在 Zeabur 上跑通。

---

## 已确定的关键决策

### 认证方案：`claude setup-token`（OAuth 长期 token）

OAuth 登录是浏览器流程，无头容器里没有浏览器，**不能在容器内登录**。正确做法：

```
本地已登录的机器
  → 运行 `claude setup-token`  （需要 Claude 订阅）
  → 生成长期 OAuth token
  → 贴到 Zeabur 环境变量 CLAUDE_CODE_OAUTH_TOKEN
  → 容器内 claude 读此 token 认证（无需浏览器）
```

- 用订阅额度，不走 API key 按量计费
- token 长期有效，适合 headless 部署

### Zeabur 套餐：2GB 内存 → MAX_SESSIONS=2

单个常驻 claude 进程实测 committed ≈ 586MB。2GB 扣掉 OS+编排器后约可跑 2 个会话。
环境变量设 `CC_MAX_SESSIONS=2`。

---

## TODO 清单

### 1. 验证容器内 claude 认证（头号 go/no-go，未验证）

- [ ] 本地机器运行 `claude setup-token`，拿到长期 token
- [ ] 验证容器内（Linux）`claude -p` 能用 `CLAUDE_CODE_OAUTH_TOKEN` 认证启动
- [ ] 确认 `-p` 模式在容器里跳过 workspace trust / onboarding 弹窗

> 风险：本机是 Windows 且已 OAuth 登录，无法完全代验 Linux 容器行为。这条不过，整个方案在 Zeabur 上为 0。

### 2. Dockerfile（未做）

- [ ] 基础镜像 node（claude CLI 需要 Node 运行时）
- [ ] 全局安装 `@anthropic-ai/claude-code`
- [ ] 复制 src，`npm install` + `npm run build`（或多阶段构建）
- [ ] 启动命令 `node dist/server.js`

### 3. 服务监听 Zeabur 的 $PORT（需改）

- [ ] 当前端口写死读 `CC_PROXY_PORT`（默认 3456）。Zeabur 注入 `PORT`，需让 server 读取 `process.env.PORT`

### 4. 容器内 hook 配置（需确认）

- [ ] `test-workspace/.claude/settings.local.json` 里 hook URL 写的是 `localhost:3456`，容器内端口若变需同步
- [ ] 验证 stream-json + HTTP hook 在 Linux 容器里行为与本机一致（未验证）

### 5. 下游文件放哪（V1 决策待定）

> 真正的"远程用户本地 agent"还没做。当前 `readFromDownstream` 只读服务器同机的 `downstream-project/` 文件夹。
- [ ] V1 方案：把 `downstream-project/` 假文件一起打进镜像，先验证 hook+session+缓存链路在 Zeabur 上跑通
- [ ] 注意：部署后用户真实文件在用户电脑上，服务器读不到——这是 V2 的真功能

---

## 暂不做（V1 明确排除）

- API key / Bearer 鉴权（公网裸奔，仅功能验证阶段可接受）
- `--max-budget-usd` 预算上限
- 真实远程下游 agent（session→agent 绑定、网络协议）
- Read 之外的工具（LS / Glob / Grep / Edit / Write / Bash）
- PostToolUse 输出替换
- web 前端 / 多租户 key 映射

---

## 已完成（本机验证通过）

- ClaudeRunner：单个常驻 claude stream-json 进程，多轮复用
- SessionManager：会话生命周期、MAX_SESSIONS 上限、空闲回收、优雅关停
- HTTP 会话 API + Read hook 转发
- 53 单元测试 + 23 集成测试全通过
- 实测：缓存跨轮命中（成本约降 6x）、会话进程隔离、SIGTERM 无僵尸进程
- 实测单进程内存 ~586MB committed
