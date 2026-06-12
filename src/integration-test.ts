// Real integration test for SessionManager + ClaudeRunner.
// Spawns a live server and real `claude` processes.
// Cost control: only the cache test runs paid turns; capacity/reaper/shutdown
// tests just spawn processes (spawning alone costs nothing until a turn runs).

import http from "http";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "dist", "server.js");
const PORT = 13900;
const BASE = `http://localhost:${PORT}`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function req(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const u = new URL(BASE + pathname);
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
              ...headers,
            }
          : headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    r.on("error", () => resolve({ status: 0, json: null }));
    r.setTimeout(180000, () => {
      r.destroy();
      resolve({ status: 0, json: { error: "timeout" } });
    });
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(maxMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await req("GET", "/health");
    if (res.status === 200) return true;
    await sleep(200);
  }
  return false;
}

function countClaudeProcs(): number {
  try {
    const command =
      process.platform === "win32"
        ? 'powershell -Command "(Get-Process claude -ErrorAction SilentlyContinue).Count"'
        : "pgrep -fl '(^|/)claude( |$)' | wc -l";
    const out = execSync(command, { encoding: "utf-8" }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return -1;
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function startServer(env: Record<string, string>): ChildProcess {
  return spawn("node", [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CC_PROXY_PORT: String(PORT), ...env },
  });
}

async function testCacheAcrossTurns() {
  console.log("\n[Test 1] Cache hit across turns in one session (PAID)");
  const claudeBefore = countClaudeProcs();
  const srv = startServer({ CC_MAX_SESSIONS: "5" });
  try {
    if (!(await waitHealth())) {
      check("server ready", false);
      return;
    }
    const create = await req("POST", "/sessions");
    check("create returns 201", create.status === 201, `got ${create.status}`);
    const id = create.json?.id;
    check("session has id", !!id);

    const t1 = await req("POST", `/sessions/${id}/turn`, {
      prompt: "Read demo.txt and reply with only its unique marker, nothing else.",
    });
    check("turn 1 returns 200", t1.status === 200, `got ${t1.status}`);
    check(
      "turn 1 saw downstream content",
      typeof t1.json?.result === "string" &&
        t1.json.result.includes("ALPHA-BRAVO-CHARLIE-7742"),
      `result=${JSON.stringify(t1.json?.result)}`
    );

    const t2 = await req("POST", `/sessions/${id}/turn`, {
      prompt: "Read sub/nested.txt and reply with only its unique marker.",
    });
    check("turn 2 returns 200", t2.status === 200, `got ${t2.status}`);
    check(
      "turn 2 saw downstream content",
      typeof t2.json?.result === "string" &&
        t2.json.result.includes("DELTA-ECHO-FOXTROT-3355"),
      `result=${JSON.stringify(t2.json?.result)}`
    );
    const cacheRead = t2.json?.usage?.cache_read_input_tokens || 0;
    check(
      "turn 2 cache_read > 0 (cache reused across turns)",
      cacheRead > 0,
      `cache_read=${cacheRead}`
    );
    console.log(
      `    turn1 cost=$${t1.json?.usage?.total_cost_usd} turn2 cost=$${t2.json?.usage?.total_cost_usd} turn2 cache_read=${cacheRead}`
    );

    const sameSession =
      t1.json?.session_id && t1.json.session_id === t2.json?.session_id;
    check("same CLI session across turns", !!sameSession);

    const del = await req("DELETE", `/sessions/${id}`);
    check("delete returns 200", del.status === 200);
  } finally {
    srv.kill("SIGTERM");
    await sleep(2000);
    const after = countClaudeProcs();
    check(
      "no leaked claude processes after shutdown",
      after <= claudeBefore || after === 0,
      `before=${claudeBefore} after=${after}`
    );
  }
}

async function testAnthropicMessagesApi() {
  console.log("\n[Test 2] Anthropic /v1/messages compatibility (PAID)");
  const apiKey = "integration-secret";
  const srv = startServer({
    CC_MAX_SESSIONS: "5",
    CC_PROXY_API_KEY: apiKey,
    CC_TURN_TIMEOUT_MS: "180000",
  });
  const fileName = `tmp-write-check-${Date.now()}.txt`;
  const filePath = path.join(PROJECT_ROOT, "test-workspace", fileName);
  const marker = `WRITE-MARKER-${Date.now()}`;
  try {
    if (!(await waitHealth())) {
      check("server ready", false);
      return;
    }

    const unauth = await req("POST", "/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    });
    check("messages endpoint requires API key", unauth.status === 401, `got ${unauth.status}`);

    const read = await req(
      "POST",
      "/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: "Read demo.txt and reply with only its unique marker, nothing else.",
          },
        ],
      },
      { "x-api-key": apiKey }
    );
    check("/v1/messages read returns 200", read.status === 200, `got ${read.status}`);
    const readText = read.json?.content?.[0]?.text;
    check(
      "/v1/messages saw downstream read content",
      typeof readText === "string" && readText.includes("ALPHA-BRAVO-CHARLIE-7742"),
      `text=${JSON.stringify(readText)}`
    );
    check("/v1/messages returns assistant message", read.json?.type === "message");
    check("/v1/messages returns token usage", (read.json?.usage?.output_tokens || 0) > 0);
    check(
      "/v1/messages returns cost metadata",
      typeof read.json?.usage?.total_cost_usd === "number",
      `usage=${JSON.stringify(read.json?.usage)}`
    );

    const write = await req(
      "POST",
      "/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content:
              `Use the Write tool to create ${fileName} in the current directory ` +
              `with exactly this content: ${marker}. Then reply with only DONE.`,
          },
        ],
      },
      { Authorization: `Bearer ${apiKey}` }
    );
    check("/v1/messages write returns 200", write.status === 200, `got ${write.status}`);
    check("write tool created file", fs.existsSync(filePath), filePath);
    const written = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    check("written file has requested marker", written.includes(marker), `content=${written}`);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    srv.kill("SIGTERM");
    await sleep(2000);
  }
}

async function testCapacityLimit() {
  console.log("\n[Test 3] MAX_SESSIONS limit returns 503 (no paid turns)");
  const srv = startServer({ CC_MAX_SESSIONS: "2" });
  try {
    if (!(await waitHealth())) {
      check("server ready", false);
      return;
    }
    const h = await req("GET", "/health");
    check("health reports max_sessions=2", h.json?.max_sessions === 2);

    const s1 = await req("POST", "/sessions");
    const s2 = await req("POST", "/sessions");
    check("session 1 created (201)", s1.status === 201, `got ${s1.status}`);
    check("session 2 created (201)", s2.status === 201, `got ${s2.status}`);

    const s3 = await req("POST", "/sessions");
    check("session 3 rejected (503)", s3.status === 503, `got ${s3.status}`);
    check("503 reports limit", s3.json?.limit === 2);

    const list = await req("GET", "/sessions");
    check("list shows 2 sessions", list.json?.sessions?.length === 2);

    // free one, then a new create should succeed
    await req("DELETE", `/sessions/${s1.json.id}`);
    const s4 = await req("POST", "/sessions");
    check("after freeing one, create succeeds", s4.status === 201, `got ${s4.status}`);
  } finally {
    srv.kill("SIGTERM");
    await sleep(1500);
  }
}

async function testIdleReap() {
  console.log("\n[Test 4] Idle session reaping (no paid turns)");
  const srv = startServer({
    CC_MAX_SESSIONS: "5",
    CC_IDLE_TIMEOUT_MS: "2000",
    CC_REAP_INTERVAL_MS: "1000",
  });
  try {
    if (!(await waitHealth())) {
      check("server ready", false);
      return;
    }
    const s = await req("POST", "/sessions");
    check("session created", s.status === 201);
    const id = s.json.id;

    let h = await req("GET", "/health");
    check("1 session before idle", h.json?.sessions === 1, `sessions=${h.json?.sessions}`);

    // wait past idle timeout + reap interval
    await sleep(4500);

    h = await req("GET", "/health");
    check("session reaped after idle", h.json?.sessions === 0, `sessions=${h.json?.sessions}`);

    const got = await req("GET", `/sessions/${id}`);
    check("reaped session is 404", got.status === 404, `got ${got.status}`);
  } finally {
    srv.kill("SIGTERM");
    await sleep(1500);
  }
}

async function testGracefulShutdown() {
  console.log("\n[Test 5] Graceful shutdown kills all CLI processes (no paid turns)");
  const before = countClaudeProcs();
  const srv = startServer({ CC_MAX_SESSIONS: "5" });
  if (!(await waitHealth())) {
    check("server ready", false);
    srv.kill("SIGKILL");
    return;
  }
  await req("POST", "/sessions");
  await req("POST", "/sessions");
  const during = countClaudeProcs();
  check("processes spawned", during >= before + 2 || before === -1, `before=${before} during=${during}`);

  srv.kill("SIGTERM");
  await sleep(2500);
  const after = countClaudeProcs();
  check(
    "all session processes cleaned up on SIGTERM",
    after <= before || after === 0,
    `before=${before} after=${after}`
  );
}

async function main() {
  console.log("=== cc-proxy Session Manager Integration Test ===");
  await testCacheAcrossTurns();
  await testAnthropicMessagesApi();
  await testCapacityLimit();
  await testIdleReap();
  await testGracefulShutdown();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("integration test error:", e);
  process.exit(1);
});
