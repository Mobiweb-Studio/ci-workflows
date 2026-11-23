import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "device-apk-key.mjs");
const hashA = "a".repeat(40);
const hashB = `b${"a".repeat(39)}`;

function key(vendor: string, input: string, ...rest: string[]) {
  return spawnSync("node", [script, vendor, ...rest], { input, encoding: "utf8", env: { ...process.env, DEVICE_APK_ABI: "", APP_ENV: "" } });
}

function keyForEnv(appEnv: string, input: string, ...rest: string[]) {
  return spawnSync("node", [script, "default", ...rest], {
    input,
    encoding: "utf8",
    env: { ...process.env, DEVICE_APK_ABI: "", APP_ENV: appEnv },
  });
}

function keyFor(abi: string, input: string) {
  return spawnSync("node", [script, "default"], { input, encoding: "utf8", env: { ...process.env, DEVICE_APK_ABI: abi, APP_ENV: "" } });
}

describe("device-apk-key", () => {
  it("prints the same key for the same fingerprint and vendor", () => {
    const first = key("default", JSON.stringify({ hash: hashA }));
    const second = key("default", JSON.stringify({ hash: hashA, sources: [] }));
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("prints another key when the native fingerprint changes, so the action builds instead of repacking", () => {
    const a = key("default", JSON.stringify({ hash: hashA }));
    const b = key("default", JSON.stringify({ hash: hashB }));
    expect(a.stdout).not.toBe(b.stdout);
  });

  it("prints another key for another vendor", () => {
    const a = key("default", JSON.stringify({ hash: hashA }));
    const b = key("acme", JSON.stringify({ hash: hashA }));
    expect(a.stdout).not.toBe(b.stdout);
  });

  it.each([
    ["not JSON", "oops"],
    ["no hash", "{}"],
    ["a short hash", JSON.stringify({ hash: "abc" })],
  ])("stops with an error on %s", (_name, input) => {
    const result = key("default", input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("stops with an error on a missing or unsafe vendor", () => {
    expect(key("", JSON.stringify({ hash: hashA })).status).toBe(1);
    expect(key("../x", JSON.stringify({ hash: hashA })).status).toBe(1);
  });
  it("keeps the Android key as it was, so the cached APKs stay valid", () => {
    expect(key("default", JSON.stringify({ hash: hashA })).stdout).toBe(
      `device-apk-v1-x86_64-default-${hashA}\n`,
    );
    expect(key("default", JSON.stringify({ hash: hashA }), "android").stdout).toBe(
      `device-apk-v1-x86_64-default-${hashA}\n`,
    );
  });

  it("prints another key for an arm64-v8a APK, so a Mac's emulator never gets an x86_64 one", () => {
    const arm = keyFor("arm64-v8a", JSON.stringify({ hash: hashA }));
    expect(arm.status).toBe(0);
    expect(arm.stdout).toBe(`device-apk-v1-arm64-v8a-default-${hashA}\n`);
    expect(keyFor("x86_64", JSON.stringify({ hash: hashA })).stdout).toBe(`device-apk-v1-x86_64-default-${hashA}\n`);
  });

  it("stops with an error on an unknown ABI", () => {
    const result = keyFor("mips", JSON.stringify({ hash: hashA }));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("prints an iOS simulator key that never matches an Android one", () => {
    const ios = key("default", JSON.stringify({ hash: hashA }), "ios");
    expect(ios.status).toBe(0);
    expect(ios.stdout).toBe(`device-app-ios-v2-simulator-default-${hashA}\n`);
    expect(key("acme", JSON.stringify({ hash: hashA }), "ios").stdout).not.toBe(ios.stdout);
  });

  it("stops with an error on an unknown platform", () => {
    const result = key("default", JSON.stringify({ hash: hashA }), "web");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("names APP_ENV in the key, so a dev app and a prod one never share a cached build", () => {
    const input = JSON.stringify({ hash: hashA });
    expect(keyForEnv("dev", input).stdout).toBe(`device-apk-v1-x86_64-default.dev-${hashA}\n`);
    expect(keyForEnv("dev", input, "ios").stdout).toBe(`device-app-ios-v2-simulator-default.dev-${hashA}\n`);
    expect(keyForEnv("staging", input).stdout).not.toBe(keyForEnv("dev", input).stdout);
    expect(keyForEnv("", input).stdout).toBe(`device-apk-v1-x86_64-default-${hashA}\n`);
  });

  it("stops with an error on an APP_ENV that is not a plain name", () => {
    const result = keyForEnv("dev/../x", JSON.stringify({ hash: hashA }));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
