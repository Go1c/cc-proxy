#!/usr/bin/env node

const http = require("http");
const https = require("https");

const event = process.argv[2] || "pre-tool-use";
const fallback = {
  hookSpecificOutput: {
    hookEventName: event === "pre-tool-use" ? "PreToolUse" : "PostToolUse",
    permissionDecision: "allow",
  },
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function hookBaseUrl() {
  if (process.env.CC_HOOK_BASE_URL) return process.env.CC_HOOK_BASE_URL;
  const port = process.env.PORT || process.env.CC_PROXY_PORT || "3456";
  return `http://127.0.0.1:${port}`;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: Number(process.env.CC_HOOK_TIMEOUT_MS || 10000),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`hook bridge returned HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("hook bridge request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

(async () => {
  try {
    const payload = await readStdin();
    const url = `${hookBaseUrl().replace(/\/+$/, "")}/hooks/${event}`;
    const response = await postJson(url, payload || "{}");
    process.stdout.write(response || "{}");
  } catch (err) {
    process.stderr.write(`cc-proxy hook forwarder failed: ${err.message}\n`);
    process.stdout.write(JSON.stringify(fallback));
  }
})();
