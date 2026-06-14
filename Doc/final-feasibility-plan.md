# cc-proxy 最终可行方案与验证记录

日期：2026-06-13

## 阶段性结论

Phase 0 核心可行性已经通过实测。目标必须收敛为：

> 本地 Claude Code 负责工具执行，服务器 `cc-proxy` 负责 Claude 账号登录态、模型请求、并发控制、后台管理、日志和用量。

必须放弃的错误前提是：

> 不要让服务器上的 Claude CLI 直接充当本地 Claude Code 的工具运行环境。

截至 2026-06-13 20:27 CST，代码层、自动化回归、远端真实 Claude 请求、本地 Claude Code 工具执行、SubAgent、streaming、image input、错误透传、CCTest 暴露的 Anthropic 响应结构兼容问题都已经跑通。

结论是：

> 本地 Claude Code 可以把模型请求发到远端 `cc-proxy`，同时保持 Read / Write / Edit / Bash / 搜索 / SubAgent 等工具在本地执行。

这证明方案主线可行，可以进入产品化设计和重构阶段。但这还不是生产可上线状态，后续仍需要做账号池、后台管理、日志审计、配置持久化、稳定性和安全边界。

## 当前验证状态

### 已验证通过

- 本地到测试服务器 SSH 可用，可以直接远端改代码、build、重启、验证。
- 远端 Claude 登录态有效，`cc-proxy` 能使用服务器上的 Claude 账号发起请求。
- 本地全局 `~/.claude/settings.json` 已指向远端 `cc-proxy`：
  - `ANTHROPIC_BASE_URL=http://43.128.89.221:3456`
  - 本地 Claude Code：`2.1.177`
- `/v1/messages` 请求能进入远端 `cc-proxy`。
- Claude CLI 的真实 quota/session-limit 错误能原样返回给下游；此前已观测到 5 小时上限错误。
- MCP client-tool bridge 的真实根因已确认：
  - Claude Code 2.1.173 对 stdio MCP 使用 newline-delimited JSON-RPC。
  - 旧实现只兼容 `Content-Length` frame，导致 MCP server 一直 pending 并在 30 秒后超时。
- MCP stdio server 已兼容三种输入/输出：
  - `Content-Length: ...\r\n\r\n`
  - `Content-Length: ...\n\n`
  - JSON-line：`{"jsonrpc":"2.0",...}\n`
- 远端 MCP bridge 已能完成：
  - `initialize`
  - `notifications/initialized`
  - `tools/list`
  - 返回客户端工具，例如 `lookup_marker`
- `/v1/messages/count_tokens` 已从 404 修复为兼容响应：
  - 返回形状：`{"input_tokens": number}`
  - 远端实测返回 200。
- `/v1/messages` 出站响应已做 Anthropic 兼容归一化：
  - 默认不再暴露 Claude Code 内部 `thinking` block。
  - 默认不再在公开 `usage` 里暴露内部 `total_cost_usd`。
  - `stream:true` live SSE 会过滤非请求的 thinking 事件，并把可见 content block index 重映射为连续索引。
  - 只有请求显式 `thinking.type = "enabled"` 时才保留 thinking 内容。

### live 验证结果

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 远端服务 | 通过 | `node dist/server.js` 监听 `43.128.89.221:3456`，PID `821951`；`max_cli_windows=12` |
| 远端 Claude 认证 | 通过 | `claude auth status --json` 返回 `loggedIn: true`，`authMethod: claude.ai`，`subscriptionType: pro` |
| 直连两段式 client tool | 通过 | 第一次 `/v1/messages` 返回 `status=200`、`stop_reason=tool_use`、工具 `lookup_marker({key:"phase0"})`；第二次带 `tool_result` 返回 `REMOTE_CLIENT_TOOL_OK_20260613` |
| 本地文件读取 | 通过 | 本地 Claude Code 调用 `Read` 读取 `/private/tmp/cc-proxy-local-tools.6kYty9/source.txt`，得到 `LOCAL_READ_OK_20260613` |
| 本地文件搜索 | 通过 | Claude Code 2.1.177 的工具列表没有单独 `Grep` 工具；模型通过本地 `Bash(grep -r "LOCAL_GREP_OK_20260613" .)` 完成搜索 |
| 本地 shell | 通过 | 本地 `Bash(pwd)` 返回 `/tmp/cc-proxy-local-tools.6kYty9` |
| 本地写文件 | 通过 | 本地 `Write` 创建 `write-output.txt`，内容为 `LOCAL_WRITE_OK_20260613` |
| 本地编辑文件 | 通过 | 本地 `Edit` 把 `edit-target.txt` 改为 `LOCAL_EDIT_OK_20260613` |
| 工具不落到服务器 | 通过 | 远端不存在 `/private/tmp/cc-proxy-local-tools.6kYty9` 或 `/tmp/cc-proxy-local-tools.6kYty9`；桥日志里的工具路径是本地 macOS `/private/tmp/...` |
| SubAgent / Agent | 通过 | 主会话调用 `Agent`；子代理请求带 `cc_is_subagent=true`、`source=agent:builtin:general-purpose`；子代理本地 `Read` + `Write` 创建 `subagent-output.txt` |
| SubAgent 磁盘结果 | 通过 | `/tmp/cc-proxy-subagent.jAHC1l/subagent-output.txt` 内容为 `LOCAL_SUBAGENT_OK_20260613` |
| live streaming | 通过 | `stream:true` 返回 `text/event-stream`，事件包含 `message_start` / `message_stop`，增量文本拼接为 `STREAM_OK_20260613` |
| live image input | 通过 | 发送红色 PNG base64，模型返回 `IMAGE_RED_OK_20260613` |
| live error passthrough | 通过 | 使用不存在模型 `not-a-real-model-phase0-20260613` 返回 HTTP 502，错误信息保留上游模型不可用描述 |
| CCTest 结构兼容修复 | 通过 | 非流式真实请求返回 `content` 类型为 `text`；`usage` 只有 `cache_creation_input_tokens`、`cache_read_input_tokens`、`input_tokens`、`output_tokens`；没有 `thinking` 和 `total_cost_usd` |
| CCTest streaming 结构兼容修复 | 通过 | 流式真实请求返回 `message_start` / `message_stop`；响应体没有 `thinking` 和 `total_cost_usd` |

### 自动化验证结果

本地：

```text
npm test
tests 118
pass 118
fail 0
```

远端测试服务器：

```text
npm test
tests 118
pass 118
fail 0
```

远端真实 `/v1/messages` 结构实测：

```text
NON_STREAM_STATUS 200
NON_STREAM_CONTENT_TYPES text
NON_STREAM_USAGE_KEYS cache_creation_input_tokens,cache_read_input_tokens,input_tokens,output_tokens
NON_STREAM_HAS_THINKING false
NON_STREAM_HAS_TOTAL_COST false
STREAM_STATUS 200
STREAM_HAS_THINKING false
STREAM_HAS_TOTAL_COST false
STREAM_HAS_MESSAGE_START true
STREAM_HAS_MESSAGE_STOP true
```

远端 `count_tokens` 实测：

```text
POST /v1/messages/count_tokens
HTTP 200
{"input_tokens":3}
```

### 仍需产品化验证

Phase 0 主链路已通过，剩余事项不再是“方案是否可行”的阻塞，而是产品化交付前必须补齐：

- `count_tokens` 目前是兼容形状和估算值，不是官方 tokenizer 级别的精确计数。
- Claude Code 2.1.177 在该模式下没有单独暴露 `Grep`/`Glob`，搜索通过 `Bash` 中的 `grep`/`rg` 完成；后续要按 Claude Code 实际工具集适配，不要写死旧工具名。
- 需要持续监控 Claude Code 版本变化，尤其是 MCP stdio transport、工具名、SubAgent 协议和 stream-json 事件结构。
- 需要补账号池调度、cooldown、后台状态、日志审计、配置持久化、并发限流、超时和重试策略。
- 需要补更完整的长任务、并发请求、多账号切换、客户端断连、stream 中途错误等稳定性测试。
- CCTest 的行为/签名兼容优先级高于隐式缓存复用，因此标准 `/v1/messages` 默认恢复为 Anthropic-compatible stateless one-shot：一轮结束即关闭 Claude Code 进程，不返回隐式 session header。需要长对话缓存时，最精确的方式仍然是客户端显式传 `x-cc-session-id`；也可以在部署侧开启 `CC_PROXY_AUTO_SESSION_AFFINITY=1` 使用自动 warm-session affinity。自动复用开启时，代理只把全历史请求里的新增 user 后缀转发给持久 CLI，避免旧轮次被重复执行。

## 最终架构

```text
本地项目 A / B / C
  |
  | 本地 Claude Code 或本地适配器
  | - 读写文件
  | - 搜索代码
  | - 执行命令
  | - MCP
  | - 图片读取
  | - tool_result 回传
  v
cc-proxy HTTPS API
  |
  | - API Key 鉴权
  | - Anthropic /v1/messages 兼容
  | - /v1/messages/count_tokens 兼容
  | - tool_use / tool_result 透传
  | - session / CLI 并发管理
  | - 后台配置
  | - 日志和用量
  v
服务器 Claude CLI
  |
  | - 使用服务器上的 Claude 登录态
  | - 只负责模型推理
  | - 返回真实 Claude usage 和 error
  v
Claude 官方服务
```

## 职责边界

### 本地负责

- 读取本地文件。
- 写入本地文件。
- 搜索本地项目。
- 运行 shell 命令。
- 连接本地 MCP。
- 读取本地图片并作为请求内容发给模型。
- 执行模型返回的 `tool_use`，然后把 `tool_result` 发回服务器。

### 服务器负责

- 管理一个或多个 Claude 账号登录态。
- 启动和复用 Claude CLI 进程。
- 控制最大 CLI 并发数。
- 管理下游 API Key。
- 管理运行配置，不能长期依赖环境变量做主要配置。
- 记录请求日志、错误日志、审计日志。
- 汇总 cost、token、cache read、平均耗时。
- 识别 429、5 小时上限、周上限、账号封禁等错误。
- 单账号模式下原样返回错误。
- 多账号模式下把触发上限的账号临时停调度，并切换到可用账号。

## 必须放弃的方案

### 放弃 1：服务器直接读本地文件

不可行。服务器没有 Mac 本地文件系统权限。即使通过 SSH、HTTP 或临时上传做桥接，也会变成一套脆弱的远程文件协议。

### 放弃 2：全量同步本地项目到服务器

不适合 Unity 或大型项目。同步慢、容易冲突，也会让上下文不可控。

### 放弃 3：服务器拦截 Claude Code 工具后转发到本地

技术上可以做一部分，但不是商业化主线。它会重做 Claude Code 的工具层，MCP、权限、交互、文件冲突、长任务和图片都会越来越复杂。

现有项目里的 `DOWNSTREAM_ROOT` 和 `Read hook` 只能保留为测试/兼容模式，不能作为默认架构。

## 第一验证门槛

在继续大规模重构前，必须完成这一件事：

> 本地 Claude Code 是否可以把模型请求发到 `cc-proxy`，并保持工具在本地执行。

结论：已完成，结果通过。

成功标准对应结果：

- 本地文件读取成功：通过，`Read` 读取本机 `/private/tmp/.../source.txt`。
- 本地文件搜索成功：通过，Claude Code 2.1.177 通过本地 `Bash(grep ...)` 完成搜索。
- 本地文件写入成功：通过，`Write` 创建本机 `write-output.txt`。
- 本地文件编辑成功：通过，`Edit` 修改本机 `edit-target.txt`。
- 本地 shell 命令成功：通过，`Bash(pwd)` 返回本机临时目录。
- SubAgent 成功：通过，`Agent` 启动子代理，子代理本地 `Read` + `Write`。
- 服务器没有读取本地路径：通过，远端不存在本机临时路径，桥日志里的路径为 macOS `/private/tmp/...`。
- `tool_use/tool_result` 往返成功：通过，两段式 client tool 返回 `REMOTE_CLIENT_TOOL_OK_20260613`。
- 图片请求不被代理破坏：通过，红色 PNG image block 返回 `IMAGE_RED_OK_20260613`。
- 429、未登录、session limit 等错误能原样传回：部分已实测，5 小时 session limit 已原样返回；不存在模型 fresh 验证返回 HTTP 502 和上游模型错误。未登录错误可在后台账号管理完成后作为账号状态用例补测。

历史失败处理分支：

- 如果官方 Claude Code 完全不支持这种接入方式，则只保留 `cc-proxy` 作为普通 Anthropic-compatible API 代理。
- 现在该分支没有触发，可以继续投入 client-tool bridge 和控制面产品化；仍然不建议投入项目同步、远程文件代理这些方向。

## 商用版本目标架构

### 1. Admin Control Plane

后台必须管理：

- 管理员账号和密码。
- 下游 API Key 创建、禁用、删除。
- Claude 账号登录认证。
- 最大 CLI 并发。
- CLI idle timeout。
- CLI turn timeout。
- 默认模型。
- permission mode。
- effort。
- client tool timeout。
- 是否启用旧的 server workspace hook 模式。
- 日志查看。
- 账号状态和用量。

环境变量只保留：

- `PORT`
- `CC_PROXY_DATA_DIR`
- 首次启动 fallback，例如 `CLAUDE_COMMAND`

### 2. Account Plane

账号抽象应该按商业化结构设计，即使第一阶段只启用一个账号：

```text
Account
  id
  label
  provider = claude-cli
  status = active | cooling_down | disabled | auth_required | banned
  max_cli_windows
  active_cli_windows
  auth_home_dir
  last_error
  quota_state
  usage_summary
```

单账号模式：

- 账号触发 429、5 小时上限、周上限、封禁时，原样返回给下游。
- 后台显示账号状态。

多账号模式：

- 账号触发上限后进入 cooling_down。
- 调度器不再选择该账号。
- 如果还有可用账号，自动切换。
- 如果全部不可用，返回最后一个真实 Claude 错误，不伪造成功。

### 3. Scheduler Plane

调度器只调度模型执行，不调度本地工具。

基础策略：

- `round-robin`
- `fill-first`
- `session-affinity`

必须支持：

- 按账号并发上限选择账号。
- 按账号 cooldown 跳过账号。
- persistent session 绑定到同一账号。
- 请求失败前没有输出时可以换账号重试。
- 请求已经开始流式输出后不换账号，错误原样传递。

### 4. Message Compatibility Plane

`/v1/messages` 是核心。

必须保证：

- text 输入不丢字段。
- image base64 输入不丢字段。
- `tool_use` 返回给本地。
- `tool_result` 原样回传给 Claude CLI。
- streaming SSE 形状兼容 Anthropic。
- `/v1/messages/count_tokens` 至少返回兼容形状。
- Claude CLI 原始错误尽量保留 status、type、message、body。
- 不默认拦截客户端工具。

注意：

- 当前 `count_tokens` 是兼容兜底估算，不是官方 tokenizer 精确结果。
- 如果后续能可靠调用官方 count_tokens，应替换为真实计数。

### 5. Observability Plane

后台至少显示：

- 当前活跃 CLI 窗口。
- 每个窗口所属账号、session、状态、turn 数。
- 今日 cost。
- 本周 cost。
- 本月 cost。
- input tokens。
- output tokens。
- cache creation tokens。
- cache read tokens。
- cache read rate。
- 平均耗时。
- 最近错误。
- 429 / 5 小时 / 周上限 / 封禁记录。
- API Key 请求次数和最后使用时间。

数据来源只使用 Claude CLI 实际返回的 usage 和 error。没有真实百分比时，不伪造百分比。

## 实施阶段

### Phase 0：可行性验证

目标：确认本地 Claude Code 能不能以 `cc-proxy` 作为模型后端，并继续本地执行工具。

当前状态：

- 自动化测试：通过。
- MCP transport 修复：通过。
- 远端 `tools/list`：通过。
- live 本地工具执行：通过。
- live SubAgent：通过。
- live streaming：通过。
- live image input：通过。
- CCTest 响应结构兼容修复：通过。

下一步：

1. 用 CCTest 重新跑结构完整性和行为验证分数。
2. 如果结构分仍低，抓取 CCTest 失败项对应的原始响应样本逐项补兼容。
3. 缓存和 token 偏高单独开专项，不阻塞 Phase 1 产品化。

### Phase 1：单账号商业化

目标：把当前单账号版本做稳定。

工作项：

- 默认关闭 `Read hook` / `DOWNSTREAM_ROOT`。
- 后台增加明确的运行模式：
  - `local-client-tools` 默认模式。
  - `server-workspace-hooks` 调试模式。
- 所有运行参数进入后台配置。
- 修正登录认证任务状态和取消任务。
- 完善日志和账号 usage。
- 完善 Zeabur 持久化检查。

### Phase 2：多账号调度

目标：参考 CLIProxyAPI 的账号池和调度设计，但只服务 Claude CLI。

工作项：

- 账号 CRUD。
- 每个账号独立 Claude home。
- 每个账号独立登录认证任务。
- 每个账号独立 CLI 并发池。
- 调度器支持 round-robin、fill-first、session-affinity。
- quota/cooldown 状态持久化。
- 全部账号不可用时返回真实错误。

### Phase 3：兼容性强化

目标：尽量接近本地 Claude Code 原生体验。

工作项：

- 增加 Claude Code 兼容哨兵测试。
- 增加 tool_use/tool_result 多轮测试。
- 增加 streaming 中断和错误测试。
- 增加图片输入测试。
- 增加长上下文测试。
- 增加 MCP 工具桥接测试。
- 增加真实本地 Claude Code smoke test。

## 最终判断

这个项目可以继续推进，Phase 0 live 验证已经通过。

当前最重要的判断不是“服务器能不能跑 Claude Code”，而是：

> 本地 Claude Code 能不能把模型请求发到 `cc-proxy`，同时仍然由本地执行工具。

该验证已经通过，后续投入应该集中在 Anthropic 兼容性、账号池、控制面、日志审计、会话复用和稳定性上。

仍然不要继续投入服务器文件代理、远程工具桥接或项目全量同步作为主线。
