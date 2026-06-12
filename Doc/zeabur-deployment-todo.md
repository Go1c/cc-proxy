# Zeabur 部署状态与 TODO

目标链路：

```text
Client / Claude SDK
  -> https://cc-proxy.zeabur.app/v1/messages
  -> cc-proxy
  -> real Claude Code CLI
  -> CLAUDE_CODE_OAUTH_TOKEN subscription quota
```

当前目标不是走 Anthropic API credits。生产环境不要配置 `CC_ANTHROPIC_*` 上游变量。

## 当前线上状态

- Public URL: `https://cc-proxy.zeabur.app`
- Kubernetes namespace: `environment-6a2ad5e305a35017ba9066bb`
- Deployment: `service-6a2ad5ee16481d6693b3f1f5`
- Runtime mount: `cc-proxy-dist` ConfigMap mounted at `/src/dist`
- Model override: `CC_CLAUDE_MODEL=claude-sonnet-4-6`
- Permission mode: `CC_PERMISSION_MODE=acceptEdits`
- Max sessions: `CC_MAX_SESSIONS=10`
- Auth:
  - `CLAUDE_CODE_OAUTH_TOKEN` is set for Claude Code CLI.
  - `CC_PROXY_API_KEY` is set for client access.
- Removed upstream API env:
  - `CC_ANTHROPIC_BETA`
  - `CC_ANTHROPIC_BASE_URL`
  - `CC_ANTHROPIC_API_KEY`
  - `CC_ANTHROPIC_AUTH_HEADER`
  - `CC_ANTHROPIC_VERSION`

## 已完成

- 容器内 Claude Code CLI 认证已验证，`apiKeySource` reports `none`, using OAuth token path.
- Zeabur `$PORT` runtime已验证，服务监听 `8080` 并通过 public route 暴露。
- `/health` 已验证，返回 `max_sessions=10`。
- `/v1/messages` 已验证：
  - Bearer auth works.
  - Text request works.
  - `Read demo.txt` hits PreToolUse hook and returns downstream marker `ALPHA-BRAVO-CHARLIE-7742`.
  - `stream:true` returns Anthropic-style SSE events.
  - 64x64 PNG image block works and returns `Red`.
  - Long game-development prompt works.
  - Persistent session second turn works and reads `sub/nested.txt` marker `DELTA-ECHO-FOXTROT-3355`.
  - Cache metadata is surfaced; second long turn observed `cache_read_input_tokens=48460`.
- Claude Code assistant content blocks are preserved, including `thinking` and `signature`.
- `CC_CLAUDE_MODEL=claude-sonnet-4-6` is passed to the Claude Code CLI.
- `CC_PERMISSION_MODE=acceptEdits` is passed to the Claude Code CLI.
- Deployment mismatch fixed:
  - Bad state: only `/src/dist/server.js` was mounted from ConfigMap, leaving old `runner.js` in the image.
  - Symptom: `/v1/messages` returned 502 and Claude Code emitted `G?.startsWith is not a function`.
  - Fix: mount full compiled `dist` directory through `cc-proxy-dist`.

## 部署注意

Do not mount only `server.js`. The compiled runtime modules must be deployed as one unit:

```text
/src/dist/server.js
/src/dist/runner.js
/src/dist/session-manager.js
/src/dist/types.js
```

Recommended flow:

```bash
npm run build
tar -czf /tmp/cc-proxy-dist.tgz -C . dist
scp /tmp/cc-proxy-dist.tgz ubuntu@43.128.89.221:/tmp/cc-proxy-dist.tgz
```

On the Zeabur host:

```bash
NS=environment-6a2ad5e305a35017ba9066bb
DEPLOY=service-6a2ad5ee16481d6693b3f1f5

rm -rf /tmp/cc-proxy-dist-upload
mkdir -p /tmp/cc-proxy-dist-upload
tar -xzf /tmp/cc-proxy-dist.tgz -C /tmp/cc-proxy-dist-upload
find /tmp/cc-proxy-dist-upload/dist -name '._*' -delete

sudo kubectl create configmap cc-proxy-dist -n "$NS" \
  --from-file=/tmp/cc-proxy-dist-upload/dist \
  -o yaml --dry-run=client | sudo kubectl apply -f -

sudo kubectl rollout restart -n "$NS" deploy/"$DEPLOY"
sudo kubectl rollout status -n "$NS" deploy/"$DEPLOY" --timeout=150s
```

After rollout:

```bash
POD=$(sudo kubectl get pods -n "$NS" \
  -l zeabur_service_id=6a2ad5ee16481d6693b3f1f5 \
  -o jsonpath='{.items[0].metadata.name}')

sudo kubectl exec -n "$NS" "$POD" -- sh -lc \
  'sha256sum /src/dist/server.js /src/dist/runner.js /src/dist/session-manager.js /src/dist/types.js'
```

## TODO

- Run full external cctest again against `https://cc-proxy.zeabur.app`.
- Implement live token streaming instead of buffered SSE.
- Implement real client-supplied Anthropic tool-use protocol:
  - `tools`
  - `tool_choice`
  - emitted `tool_use`
  - follow-up `tool_result`
- Map Anthropic `thinking` request options to Claude Code if a stable CLI/API switch exists.
- Decide whether request `model` should override `CC_CLAUDE_MODEL` per request.
- Improve Anthropic-compatible headers, request IDs, and error shapes.
- Add per-client keys or a key store instead of one shared `CC_PROXY_API_KEY`.
- Add explicit rate limiting beyond `CC_MAX_SESSIONS`.
- Design the real downstream workspace sync path for writes/edits.
- Script the Zeabur ConfigMap deployment to avoid manual patch drift.
- Add cctest-focused automated fixtures for long context, images, stream mode, assistant history, cache reuse, and tool protocol edge cases.

## 已知边界

- Very small images can be rejected by the underlying Claude Code/API image processor. A normal 64x64 PNG passed through `/v1/messages`.
- Token usage is high because Claude Code injects its own runtime/tool/system context. This is expected for the Claude Code subscription path.
- `usage.total_cost_usd` is reported by Claude Code for observability, but billing/auth is through `CLAUDE_CODE_OAUTH_TOKEN` in this deployment.
