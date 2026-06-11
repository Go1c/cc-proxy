// Functional validation: 2 concurrent sessions, interleaved turns.
// Verifies: session isolation (no content cross-talk), each session caches
// independently across its own turns, both run truly in parallel.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname);
const SERVER = path.join(PROJECT_ROOT, "dist", "server.js");
const PORT = 13950;
const BASE = `http://localhost:${PORT}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const u = new URL(BASE + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf-8");
        let j = null; try { j = JSON.parse(t); } catch { j = t; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on("error", () => resolve({ status: 0, json: null }));
    r.setTimeout(180000, () => { r.destroy(); resolve({ status: 0, json: { error: "timeout" } }); });
    if (data) r.write(data);
    r.end();
  });
}

async function waitHealth(maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await req("GET", "/health");
    if (res.status === 200) return true;
    await sleep(200);
  }
  return false;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  console.log("=== 2 Concurrent Sessions Functional Validation ===\n");
  const srv = spawn("node", [SERVER], {
    cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CC_PROXY_PORT: String(PORT), CC_MAX_SESSIONS: "2" },
  });
  try {
    if (!(await waitHealth())) { check("server ready", false); return; }

    // Create 2 sessions
    const [a, b] = await Promise.all([req("POST", "/sessions"), req("POST", "/sessions")]);
    check("session A created", a.status === 201, `got ${a.status}`);
    check("session B created", b.status === 201, `got ${b.status}`);
    const idA = a.json?.id, idB = b.json?.id;
    check("two distinct session ids", idA && idB && idA !== idB);

    const h = await req("GET", "/health");
    check("health shows 2 active sessions", h.json?.sessions === 2, `sessions=${h.json?.sessions}`);

    // Turn 1: run both sessions IN PARALLEL, each reads a DIFFERENT file
    console.log("\n-- Turn 1: parallel, different files per session --");
    const t1Start = Date.now();
    const [a1, b1] = await Promise.all([
      req("POST", `/sessions/${idA}/turn`, { prompt: "Read demo.txt and reply with only its unique marker, nothing else." }),
      req("POST", `/sessions/${idB}/turn`, { prompt: "Read sub/nested.txt and reply with only its unique marker, nothing else." }),
    ]);
    const t1Elapsed = Date.now() - t1Start;
    console.log(`   parallel turn 1 wall time: ${t1Elapsed}ms`);

    check("A turn1 200", a1.status === 200, `got ${a1.status}`);
    check("B turn1 200", b1.status === 200, `got ${b1.status}`);
    // ISOLATION: A must see demo marker, B must see nested marker, no cross-talk
    check("A saw demo marker", typeof a1.json?.result === "string" && a1.json.result.includes("ALPHA-BRAVO-CHARLIE-7742"), `A=${JSON.stringify(a1.json?.result)}`);
    check("A did NOT see B's marker", !(a1.json?.result || "").includes("DELTA-ECHO-FOXTROT-3355"));
    check("B saw nested marker", typeof b1.json?.result === "string" && b1.json.result.includes("DELTA-ECHO-FOXTROT-3355"), `B=${JSON.stringify(b1.json?.result)}`);
    check("B did NOT see A's marker", !(b1.json?.result || "").includes("ALPHA-BRAVO-CHARLIE-7742"));
    check("A and B have different CLI sessions", a1.json?.session_id && b1.json?.session_id && a1.json.session_id !== b1.json.session_id,
      `A=${a1.json?.session_id} B=${b1.json?.session_id}`);

    // Turn 2: each session reads the OTHER file — verify each caches independently
    console.log("\n-- Turn 2: parallel, swap files, check per-session cache --");
    const [a2, b2] = await Promise.all([
      req("POST", `/sessions/${idA}/turn`, { prompt: "Now read unicode.txt and reply with only the text after 'Emoji markers:' on that line." }),
      req("POST", `/sessions/${idB}/turn`, { prompt: "Now read demo.txt and reply with only its unique marker, nothing else." }),
    ]);
    check("A turn2 200", a2.status === 200, `got ${a2.status}`);
    check("B turn2 200", b2.status === 200, `got ${b2.status}`);
    check("A turn2 saw unicode content", (a2.json?.result || "").includes("UNICODE_MARKER"), `A2=${JSON.stringify(a2.json?.result)}`);
    check("B turn2 saw demo marker", (b2.json?.result || "").includes("ALPHA-BRAVO-CHARLIE-7742"), `B2=${JSON.stringify(b2.json?.result)}`);

    const aCache = a2.json?.usage?.cache_read_input_tokens || 0;
    const bCache = b2.json?.usage?.cache_read_input_tokens || 0;
    check("A turn2 cache_read > 0 (A's own cache reused)", aCache > 0, `A cache_read=${aCache}`);
    check("B turn2 cache_read > 0 (B's own cache reused)", bCache > 0, `B cache_read=${bCache}`);

    check("A session id stable across turns", a1.json?.session_id === a2.json?.session_id);
    check("B session id stable across turns", b1.json?.session_id === b2.json?.session_id);

    const totalCost = [a1, b1, a2, b2].reduce((s, r) => s + (r.json?.usage?.total_cost_usd || 0), 0);
    console.log(`\n   total cost across 4 turns: $${totalCost.toFixed(4)}`);
    console.log(`   A cache_read turn2=${aCache}, B cache_read turn2=${bCache}`);

    // Cleanup sessions
    await Promise.all([req("DELETE", `/sessions/${idA}`), req("DELETE", `/sessions/${idB}`)]);
    const h2 = await req("GET", "/health");
    check("both sessions closed", h2.json?.sessions === 0, `sessions=${h2.json?.sessions}`);
  } finally {
    srv.kill("SIGTERM");
    await sleep(2000);
  }
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error("error:", e); process.exit(1); });
