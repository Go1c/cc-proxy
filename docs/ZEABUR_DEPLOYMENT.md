# Zeabur 自部署指南

当前版本按单账号模型部署：

- 1 台服务器只跑 1 个 `cc-proxy` 服务。
- 1 个服务只登录 1 个 Claude 账号。
- 并发限制是这个账号下允许同时存在的 Claude CLI 窗口数，不是多账号调度。
- 下游看到的 Claude 报错尽量保持原样透传，例如 429、5 小时上限、周上限、账号封禁。
- API Key、Claude CLI 数量、超时、模型、Claude 登录/检查命令等运行配置以后都在 `/admin` 后台管理；环境变量只用于启动和首次默认值。

## 1. Zeabur 服务

推荐直接用仓库里的 `Dockerfile` 构建部署，不再手工把 `dist` 做成 ConfigMap。

镜像里必须包含这些内容：

- `dist/`：TypeScript 编译产物。
- `public/`：后台页面，`/admin` 会读取 `public/admin.html`。
- `node_modules/`：包含 Claude Code CLI 依赖。

当前 `Dockerfile` 已经复制了 `public`，不要删掉：

```dockerfile
COPY public ./public
```

## 2. 持久化卷

在 Zeabur 给服务加一个 Volume，并挂载到：

```text
/data
```

然后设置服务环境变量：

```text
CC_PROXY_DATA_DIR=/data/cc-proxy
```

这个目录会保存：

- 管理员账号和后台会话配置。
- 后台创建的下游 API Keys，服务端只保存 hash。
- 运行配置。
- 后台日志。
- Claude 账号状态和用量统计。

不挂持久化卷的话，重建/重新部署后这些数据可能丢失。

## 3. 最少环境变量

Zeabur 一般会自动提供 `PORT`，服务会优先监听它。

建议只配置：

```text
CC_PROXY_DATA_DIR=/data/cc-proxy
```

可选启动默认值：

```text
CLAUDE_COMMAND=/src/node_modules/@anthropic-ai/claude-code-linux-x64/claude
```

如果不设置 `CLAUDE_COMMAND`，服务会自动尝试寻找镜像内的 Claude CLI。模型、最大 CLI 数量、超时等推荐部署后在 `/admin` 配。

不要再依赖这些作为主要配置方式：

```text
CC_PROXY_API_KEY
CC_MAX_SESSIONS
CC_IDLE_TIMEOUT_MS
CC_TURN_TIMEOUT_MS
CC_CLAUDE_MODEL
CC_PERMISSION_MODE
CC_CLAUDE_EFFORT
CC_CLAUDE_SETTING_SOURCES
```

它们只适合迁移或首次默认值；后台保存后的配置才是运行时准配置。

## 4. 首次初始化

部署成功后打开：

```text
https://你的域名/admin
```

按顺序做：

1. 创建管理员账号。
2. 在 Runtime Config 里设置：
   - 最大 CLI 数量：例如 `1`、`2`、`3`，取决于你这个 Claude 账号能承受的并发。
   - CLI idle timeout：空闲多久自动回收窗口。
   - CLI turn timeout：单次请求最长等待时间。
   - Claude command：一般保持自动探测，或填 `/src/node_modules/@anthropic-ai/claude-code-linux-x64/claude`。
   - Claude model：需要固定模型时再填。
3. 在 Claude Auth 区域执行登录或检查。
4. 在 API Keys 区域创建下游调用用的 key。

## 5. 下游调用

健康检查：

```bash
curl https://你的域名/health
```

消息接口示例：

```bash
curl https://你的域名/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <后台创建的 API Key>" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 256,
    "messages": [
      { "role": "user", "content": "hello" }
    ]
  }'
```

如果 Claude CLI 返回 429、5 小时上限、周上限或账号异常，代理会把能拿到的原始错误体和状态码传给下游，同时后台日志和账号页会记录最后错误。

## 6. 后台可看数据

`/admin` 里可以看：

- Runtime Config：最大 CLI 数量、超时、Claude 命令、模型等。
- Claude Auth：登录/检查任务输出。
- Account：账号状态、最后错误、5 小时/周限制、今日/本周/本月 cost 和 token 统计、缓存读取率、平均耗时。
- CLI Windows：当前活跃 Claude CLI 窗口、每个窗口的 session/usage/error。
- API Keys：创建、禁用、删除下游 key。
- Logs：后台审计日志和服务错误日志。

注意：5 小时和周限制百分比只有在 Claude/上游真实返回百分比字段时才显示；服务不会用冷却时间伪造剩余百分比。

## 7. 部署后自检

完成后至少检查：

```bash
curl https://你的域名/health
```

然后用后台创建的 key 调一次 `/v1/messages`。如果失败，先看：

- `/admin/logs`
- `/admin/account`
- `/admin/cli-windows`
- Zeabur Runtime Logs

常见问题：

- `/admin` 500：镜像里缺 `public/admin.html`，检查 Dockerfile 是否有 `COPY public ./public`。
- 重部署后管理员/key 丢失：没有挂载 `/data` 或没有设置 `CC_PROXY_DATA_DIR=/data/cc-proxy`。
- Claude 未登录：进 `/admin` 的 Claude Auth 执行登录/检查，或确认 Zeabur 容器内 Claude CLI 能保存登录态到持久目录。
- 下游 401：必须使用后台 API Keys 新建出来的 key。
