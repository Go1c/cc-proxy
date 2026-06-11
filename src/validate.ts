import { spawn, ChildProcess } from "child_process";
import http from "http";
import path from "path";
import fs from "fs";

const PORT = 3456;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEST_WORKSPACE = path.join(PROJECT_ROOT, "test-workspace");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "dist", "server.js");
const HEALTH_URL = `http://localhost:${PORT}/health`;
const TIMEOUT_MS = 120_000;

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url: string): Promise<{ ok: boolean; body?: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ ok: res.statusCode === 200, body: Buffer.concat(chunks).toString("utf-8") });
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ ok: false }); });
  });
}

async function waitForServer(maxWaitMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await httpGet(HEALTH_URL);
    if (res.ok) return true;
    await sleep(300);
  }
  return false;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout?.on("data", (c: Buffer) => outChunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        exitCode: null,
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
      });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(outChunks).toString("utf-8"),
        stderr: err.message,
      });
    });
  });
}

// --- Main ---

async function main() {
  console.log("=== CC-Proxy Validation Test ===\n");

  // Step 0: Verify files exist
  const serverDist = SERVER_SCRIPT;
  if (!fs.existsSync(serverDist)) {
    console.error("ERROR: dist/server.js not found. Run 'npm run build' first.");
    process.exit(1);
  }

  const serverDemo = path.join(TEST_WORKSPACE, "demo.txt");
  const downstreamDemo = path.join(PROJECT_ROOT, "downstream-project", "demo.txt");
  if (!fs.existsSync(serverDemo) || !fs.existsSync(downstreamDemo)) {
    console.error("ERROR: test workspace files not found.");
    process.exit(1);
  }

  console.log("Server demo.txt content (first 80 chars):");
  console.log("  " + fs.readFileSync(serverDemo, "utf-8").slice(0, 80).replace(/\n/g, "\\n"));
  console.log("Downstream demo.txt content (first 80 chars):");
  console.log("  " + fs.readFileSync(downstreamDemo, "utf-8").slice(0, 80).replace(/\n/g, "\\n"));
  console.log("");

  // Step 1: Start the hook bridge server
  console.log("[1/4] Starting hook bridge server...");
  const serverProc = spawn("node", [SERVER_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Pipe server stderr to our stderr (server logs to stderr)
  serverProc.stderr?.on("data", (c: Buffer) => process.stderr.write(c));
  // Capture server stdout for debugging
  const serverOut: Buffer[] = [];
  serverProc.stdout?.on("data", (c: Buffer) => serverOut.push(c));

  console.log("[1/4] Waiting for server to be ready...");
  const serverReady = await waitForServer(10_000);
  if (!serverReady) {
    console.error("ERROR: Server did not become ready within 10s");
    serverProc.kill("SIGKILL");
    process.exit(1);
  }
  console.log("[1/4] Server is ready.\n");

  // Step 2: Run Claude CLI in the test workspace
  const prompt = "Read the file demo.txt and tell me exactly what text it contains. Quote the key phrases verbatim.";
  console.log(`[2/4] Running Claude CLI with prompt: "${prompt}"`);
  console.log(`      Working directory: ${TEST_WORKSPACE}`);
  console.log("");

  const claudeResult = await runCommand(
    "claude",
    ["-p", prompt, "--output-format", "text", "--verbose"],
    TEST_WORKSPACE,
    {},
    TIMEOUT_MS
  );

  console.log("[2/4] Claude CLI finished.");
  console.log(`       Exit code: ${claudeResult.exitCode}`);
  console.log("");

  // Step 3: Analyze output
  console.log("[3/4] Claude CLI output:");
  console.log("=".repeat(60));
  console.log(claudeResult.stdout);
  console.log("=".repeat(60));
  console.log("");

  if (claudeResult.stderr) {
    console.log("Claude CLI stderr (first 500 chars):");
    console.log(claudeResult.stderr.slice(0, 500));
    console.log("");
  }

  // Step 4: Verify results
  console.log("[4/4] Verifying results...");
  const output = claudeResult.stdout;

  const hasDownstreamMarker = output.includes("DOWNSTREAM_REAL_CONTENT");
  const hasDownstreamPhrase = output.includes("ALPHA-BRAVO-CHARLIE-7742");
  const hasServerPlaceholder = output.includes("SERVER placeholder") || output.includes("SERVER_PLACEHOLDER");
  const hasNeverSeeThis = output.includes("NEVER see this");

  console.log(`  Contains "DOWNSTREAM_REAL_CONTENT":  ${hasDownstreamMarker ? "YES" : "NO"}`);
  console.log(`  Contains "ALPHA-BRAVO-CHARLIE-7742":  ${hasDownstreamPhrase ? "YES" : "NO"}`);
  console.log(`  Contains server placeholder text:     ${hasServerPlaceholder ? "YES (BAD)" : "NO (GOOD)"}`);
  console.log(`  Contains "NEVER see this" text:       ${hasNeverSeeThis ? "YES (BAD)" : "NO (GOOD)"}`);
  console.log("");

  // Cleanup
  console.log("Cleaning up...");
  serverProc.kill("SIGKILL");
  await sleep(500);

  // Verdict
  const passed = (hasDownstreamMarker || hasDownstreamPhrase) && !hasServerPlaceholder && !hasNeverSeeThis;
  console.log("");
  if (passed) {
    console.log("=== VALIDATION PASSED ===");
    console.log("Claude saw downstream content, not server placeholder content.");
    console.log("The hook forwarding mechanism works correctly for Read tool.");
    process.exit(0);
  } else {
    console.log("=== VALIDATION FAILED ===");
    if (!hasDownstreamMarker && !hasDownstreamPhrase) {
      console.log("Reason: Claude did NOT see downstream content.");
    }
    if (hasServerPlaceholder || hasNeverSeeThis) {
      console.log("Reason: Claude saw server placeholder content (hook interception may have failed).");
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Validation script error:", err);
  process.exit(1);
});
