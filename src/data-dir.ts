import fs from "fs";
import path from "path";

const ZEABUR_VOLUME_DIR = "/data";
const DEFAULT_DATA_DIR_NAME = ".cc-proxy-data";

export type DataDirAvailability = (candidate: string) => boolean;

export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  canUseDirectory: DataDirAvailability = isExistingWritableDirectory
): string {
  const configured = String(env.CC_PROXY_DATA_DIR || "").trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(cwd, configured);
  }

  if (canUseDirectory(ZEABUR_VOLUME_DIR)) {
    return path.join(ZEABUR_VOLUME_DIR, "cc-proxy");
  }

  return path.resolve(cwd, DEFAULT_DATA_DIR_NAME);
}

function isExistingWritableDirectory(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) return false;
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
