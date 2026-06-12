const fs = require("fs");
const path = require("path");

const candidates = [
  path.join(__dirname, "..", "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  path.join(__dirname, "..", "node_modules", "node-pty", "build", "Debug", "spawn-helper"),
  path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds"),
];

for (const candidate of candidates) {
  ensureExecutable(candidate);
}

function ensureExecutable(candidate) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(candidate)) {
      ensureExecutable(path.join(candidate, entry, "spawn-helper"));
    }
    return;
  }
  if (!stat.isFile()) return;
  fs.chmodSync(candidate, stat.mode | 0o755);
}
