import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "ios-runtime.mjs");

const phone = (name: string) => ({
  name,
  productFamily: "iPhone",
  identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/[ ()]+/g, "-")}`,
});
const runtime = (version: string, phones: string[], isAvailable = true) => ({
  platform: "iOS",
  isAvailable,
  version,
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.split(".").slice(0, 2).join("-")}`,
  supportedDeviceTypes: [{ name: "iPad Pro", productFamily: "iPad", identifier: "ipad" }, ...phones.map(phone)],
});
const list = {
  runtimes: [
    runtime("27.1", ["iPhone Duo"]),
    runtime("26.4.1", ["iPhone 17 Pro", "iPhone 17e", "iPhone 17", "iPhone 16"]),
    runtime("9.10", ["iPhone 9"]),
    runtime("28.0", ["iPhone 19"], false),
    { platform: "watchOS", isAvailable: true, version: "30.0", identifier: "watch", supportedDeviceTypes: [] },
  ],
};

const pick = (version?: string, input = JSON.stringify(list)) =>
  spawnSync("node", [script, ...(version ? [version] : [])], { input, encoding: "utf8" });

describe("ios-runtime", () => {
  it("takes the newest available iOS runtime by default, comparing versions as numbers", () => {
    expect(pick().stdout).toBe("com.apple.CoreSimulator.SimRuntime.iOS-27-1 com.apple.CoreSimulator.SimDeviceType.iPhone-Duo\n");
    expect(pick("newest").stdout).toBe(pick().stdout);
  });

  it("takes the runtime of a version, and its first plain numbered iPhone", () => {
    expect(pick("26.4").stdout).toBe("com.apple.CoreSimulator.SimRuntime.iOS-26-4 com.apple.CoreSimulator.SimDeviceType.iPhone-17\n");
  });

  it("stops and lists what is installed when the version is missing", () => {
    const result = pick("16.4");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("iOS 16.4 is not installed on this runner; installed: 9.10, 26.4.1, 27.1");
  });

  it.each([
    ["a malformed version", "26.x", JSON.stringify(list)],
    ["input that is not JSON", "26.4", "oops"],
    ["no iOS runtime", undefined, JSON.stringify({ runtimes: [] })],
  ])("stops with an error on %s", (_name, version, input) => {
    const result = pick(version, input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
