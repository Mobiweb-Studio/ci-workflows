import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const root = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const deviceApp = read("actions", "device-ios-app", "action.yml");
const build = read("actions", "build-ios-simulator-app", "action.yml");
const nativeCache = jobs(read(".github", "workflows", "native-cache.yml"));

describe("the iOS device-check app", () => {
  it.each([
    ["device-ios-app", deviceApp],
    ["build-ios-simulator-app", build],
  ])("%s switches crash reporting and the source map upload off, as the CI APK does", (_name, action) => {
    expect(action).toMatch(/echo "CRASH_REPORTING=off" >> "\$GITHUB_ENV"/);
    expect(action).toMatch(/echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "\$GITHUB_ENV"/);
  });

  it("keys the cache by the iOS fingerprint, taken before anything generates the ios folder", () => {
    const fingerprint = deviceApp.indexOf("fingerprint:generate --platform ios");
    expect(fingerprint).toBeGreaterThan(-1);
    expect(deviceApp).toContain('device-apk-key.mjs" "$APP_VARIANT" ios');
    expect(fingerprint).toBeLessThan(deviceApp.indexOf("build-ios-simulator-app@"));
    expect(fingerprint).toBeLessThan(deviceApp.indexOf("repack-app@"));
  });

  it("repacks on a hit and builds and saves on a miss, never both", () => {
    expect(deviceApp).toMatch(
      /id: repack\n\s+if: \$\{\{ steps\.cache\.outputs\.cache-hit == 'true' \}\}/,
    );
    expect(deviceApp).toMatch(
      /id: build\n\s+if: \$\{\{ steps\.cache\.outputs\.cache-hit != 'true' \}\}/,
    );
    expect(deviceApp).toMatch(
      /cache\/save@v\d+\n\s+with:\n\s+path: \$\{\{ runner\.temp \}\}\/source-app\/app\.zip\n\s+key: \$\{\{ steps\.key\.outputs\.key \}\}/,
    );
    expect(deviceApp).toContain("--platform ios --source-app");
  });

  it("pins the repack and fingerprint tools to the versions the APK uses", () => {
    const apk = read("actions", "device-apk", "action.yml");
    for (const tool of ["@expo/repack-app", "@expo/fingerprint"]) {
      const version = (text: string) => new RegExp(`${tool}@([0-9.]+)`).exec(text)?.[1];
      expect(version(deviceApp)).toBeDefined();
      expect(version(deviceApp)).toBe(version(apk));
    }
  });
});

describe("native-cache seed-ios", () => {
  const text = nativeCache["seed-ios"] ?? "";

  it("runs only when the caller names an iOS runner, on that runner", () => {
    expect(text).toContain("if: ${{ inputs.ios-runner != '' }}");
    expect(text).toContain(
      "runs-on: ${{ startsWith(inputs.ios-runner, '[') && fromJSON(inputs.ios-runner) || inputs.ios-runner }}",
    );
  });

  it("fills the same cache device-checks reads, with no secret", () => {
    expect(text).toMatch(/device-check-env@main\n\s+with:\n\s+reference-vendor: .+\n\s+platform: ios\n/);
    expect(text).toContain("ci-workflows/actions/device-ios-app@");
    expect(text).not.toMatch(/secrets\./);
  });
});
