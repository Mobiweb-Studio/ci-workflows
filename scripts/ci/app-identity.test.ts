import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "app-identity.mjs");

function identity(platform: string, config: unknown) {
  const input = typeof config === "string" ? config : JSON.stringify(config);
  return spawnSync("node", [script, platform], { input, encoding: "utf8" });
}

const devConfig = {
  name: "ICligo",
  scheme: "icligo.dev",
  android: { package: "com.icligo.app.dev" },
  ios: { bundleIdentifier: "com.icligo.app.dev" },
};

describe("app-identity", () => {
  it("prints the Android package and the scheme of the resolved config", () => {
    const result = identity("android", devConfig);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("APP_ID=com.icligo.app.dev\nAPP_SCHEME=icligo.dev\n");
  });

  it("prints the iOS bundle id with ios", () => {
    expect(identity("ios", { ...devConfig, ios: { bundleIdentifier: "pt.icligo.ios" } }).stdout).toBe(
      "APP_ID=pt.icligo.ios\nAPP_SCHEME=icligo.dev\n",
    );
  });

  it("prefers the platform's own scheme, takes the first of a list, and prints an empty one when there is none", () => {
    expect(identity("android", { ...devConfig, android: { package: "a.b", scheme: "own" } }).stdout).toContain(
      "APP_SCHEME=own\n",
    );
    expect(identity("android", { ...devConfig, scheme: ["first", "second"] }).stdout).toContain("APP_SCHEME=first\n");
    expect(identity("android", { android: { package: "a.b" } }).stdout).toBe("APP_ID=a.b\nAPP_SCHEME=\n");
  });

  it("skips text Expo printed before the JSON", () => {
    expect(identity("android", `warning: something\n${JSON.stringify(devConfig)}`).stdout).toContain(
      "APP_ID=com.icligo.app.dev\n",
    );
  });

  it.each([
    ["not JSON", "oops"],
    ["no Android package", { ios: { bundleIdentifier: "a.b" } }],
    ["an id that would break the env line", { android: { package: "a.b\nAPP_ID=evil" } }],
    ["a scheme that is not a URL scheme", { scheme: "a b", android: { package: "a.b" } }],
  ])("stops with an error on %s", (_name, config) => {
    const result = identity("android", config);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("stops with an error on an unknown platform", () => {
    expect(identity("web", devConfig).status).toBe(1);
  });
});
