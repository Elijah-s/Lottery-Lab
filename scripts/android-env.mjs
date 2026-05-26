import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/android-env.mjs <init|dev|run|build> [...args]");
  process.exit(1);
}

const androidHome = process.env.ANDROID_HOME || join(homedir(), "Library/Android/sdk");
const javaHome =
  process.env.JAVA_HOME ||
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
const ndkHome = process.env.NDK_HOME || findLatestNdk(androidHome);
const appleHostCc =
  process.env.HOST_CC ||
  process.env.CC_aarch64_apple_darwin ||
  (existsSync("/usr/bin/cc") ? "/usr/bin/cc" : "cc");

if (!existsSync(javaHome)) {
  fail(`JAVA_HOME not found: ${javaHome}`);
}

if (!existsSync(androidHome)) {
  fail(`ANDROID_HOME not found: ${androidHome}`);
}

if (!ndkHome || !existsSync(ndkHome)) {
  fail(`NDK_HOME not found under: ${join(androidHome, "ndk")}`);
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || androidHome,
  NDK_HOME: ndkHome,
  HOST_CC: appleHostCc,
  CC_aarch64_apple_darwin: appleHostCc,
  "CC_aarch64-apple-darwin": appleHostCc,
  PATH: [
    join(javaHome, "bin"),
    join(androidHome, "platform-tools"),
    join(androidHome, "cmdline-tools/latest/bin"),
    "/usr/bin",
    "/bin",
    process.env.PATH || "",
  ].join(delimiter),
};

const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(executable, ["tauri", "android", ...args], {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);

function findLatestNdk(sdkRoot) {
  const ndkDir = join(sdkRoot, "ndk");
  if (!existsSync(ndkDir)) {
    return "";
  }
  const versions = readdirSync(ndkDir)
    .filter((entry) => existsSync(join(ndkDir, entry, "source.properties")))
    .sort(compareVersionLike);
  const latest = versions.at(-1);
  return latest ? join(ndkDir, latest) : "";
}

function compareVersionLike(a, b) {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.localeCompare(b);
}

function fail(message) {
  console.error(`Android build environment is incomplete. ${message}`);
  process.exit(1);
}
