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

  it("builds the app ad-hoc signed, so it carries its entitlements and can use the Keychain", () => {
    expect(build).toContain("CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES");
    expect(build).not.toMatch(/^\s+-derivedDataPath .*CODE_SIGNING_ALLOWED=NO/m);
  });

  it("signs a repacked app again ad-hoc, keeping its entitlements", () => {
    const repack = deviceApp.indexOf("repack-app@");
    const sign = deviceApp.indexOf('codesign --force --sign - --preserve-metadata=entitlements "$app"');
    expect(sign).toBeGreaterThan(repack);
    expect(sign).toBeLessThan(deviceApp.indexOf("id: build"));
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

  it("fills the same cache device-checks reads, with no secret but the optional npm token", () => {
    expect(text).toMatch(/device-check-env@main\n\s+with:\n\s+reference-vendor: .+\n\s+platform: ios\n/);
    expect(text).toContain("ci-workflows/actions/device-ios-app@");
    expect(text.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.NPM_AUTH_TOKEN"]);
  });
});

describe("ios-regression.yml", () => {
  const workflow = read(".github", "workflows", "ios-regression.yml");
  const regression = jobs(workflow).regression ?? "";

  it("refuses every event but schedule and workflow_dispatch before it checks out any code", () => {
    const guard = regression.indexOf('"$EVENT_NAME" != "schedule" ] && [ "$EVENT_NAME" != "workflow_dispatch"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(regression.indexOf("actions/checkout@"));
    expect(workflow).not.toMatch(/^ *pull_request(_target)?:/m);
  });

  it("runs on the iOS runner only when one is named, one runtime at a time, with no secret but the npm token", () => {
    expect(regression).toContain("if: ${{ inputs.ios-runner != '' }}");
    expect(regression).toContain(
      "runs-on: ${{ startsWith(inputs.ios-runner, '[') && fromJSON(inputs.ios-runner) || inputs.ios-runner }}",
    );
    expect(regression).toMatch(/max-parallel: 1\n/);
    expect(regression).toMatch(/fail-fast: false\n/);
    expect(regression).toContain("runtime: ${{ fromJSON(inputs.runtimes) }}");
    expect(regression).toContain("IOS_RUNTIME: ${{ matrix.runtime }}");
    expect(workflow.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.NPM_AUTH_TOKEN"]);
    expect(workflow).toMatch(/^ {4}secrets:\n {6}NPM_AUTH_TOKEN:\n {8}required: false\n(?! {6}\S)/m);
  });

  it("runs every flow and lets only the summary fail the job", () => {
    expect(regression).toContain('MAESTRO_ALL_FLOWS: "true"');
    const flows = regression.indexOf('run-maestro.sh"');
    expect(regression.slice(regression.lastIndexOf("- name:", flows), flows)).toContain("continue-on-error: true");
    expect(regression.indexOf("ios-regression-summary.mjs")).toBeGreaterThan(flows);
    const last = regression.slice(regression.lastIndexOf("- name:"));
    expect(last).toContain("if: always()");
    expect(last).toContain('ios-simulator.sh" delete');
  });

  it("uses the same app as device-checks' maestro-ios", () => {
    expect(regression).toMatch(/device-check-env@main\n\s+with:\n\s+reference-vendor: .+\n\s+platform: ios\n/);
    expect(regression).toContain("ci-workflows/actions/device-ios-app@");
  });
});
