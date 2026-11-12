import { readFileSync } from "node:fs";
import { join } from "node:path";

const action = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "actions",
    "build-android-apk",
    "action.yml",
  ),
  "utf8",
);

// The CI APK is built with no APP_ENV, so it would report as production once a project's
// reference vendor has a Sentry DSN, and it has no upload token to give the Sentry plugin.
describe("the CI device-check APK build", () => {
  it("switches crash reporting off for every later step", () => {
    expect(action).toMatch(/echo "CRASH_REPORTING=off" >> "\$GITHUB_ENV"/);
  });

  it("keeps the mock sign-in for every later step", () => {
    expect(action).toMatch(/echo "AUTH_SOURCE=mock" >> "\$GITHUB_ENV"/);
  });

  it("switches the source map upload off for every later step", () => {
    expect(action).toMatch(
      /echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "\$GITHUB_ENV"/,
    );
  });

  // A runner image with stale package lists fails a bare install with "Unable to locate package ccache".
  it("refreshes the package lists before it installs ccache, and installs it only when it is missing", () => {
    const install = action.indexOf("apt-get install");
    expect(install).toBeGreaterThan(-1);
    const update = action.indexOf("apt-get update");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(install);
    expect(action.slice(action.lastIndexOf("if ! command -v ccache", update), update)).toContain("command -v ccache");
  });
});

const deviceApk = readFileSync(
  join(__dirname, "..", "..", "actions", "device-apk", "action.yml"),
  "utf8",
);

// The repack regenerates the app config from the job's environment, so the switches must be set
// before it, not only in build-android-apk, which a cache hit skips.
describe("the device-check APK action", () => {
  it.each([
    'echo "CRASH_REPORTING=off" >> "$GITHUB_ENV"',
    'echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "$GITHUB_ENV"',
    'echo "AUTH_SOURCE=mock" >> "$GITHUB_ENV"',
  ])("runs %s before the fingerprint and the repack", (line) => {
    const at = deviceApk.indexOf(line);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(deviceApk.indexOf("fingerprint:generate"));
    expect(at).toBeLessThan(deviceApk.indexOf("repack-app@"));
  });
});

// A job that runs flows against the real sign-in passes mock-sign-in "false"; the PR device checks keep the default.
describe("the mock-sign-in input", () => {
  it.each([
    ["build-android-apk", action],
    ["device-apk", deviceApk],
  ])("defaults to true in %s and guards AUTH_SOURCE=mock", (_name, text) => {
    expect(text).toMatch(/mock-sign-in:\n(?:\s+.*\n)*?\s+default: "true"/);
    expect(text).toContain("MOCK_SIGN_IN: ${{ inputs.mock-sign-in }}");
    expect(text).toMatch(/if \[ "\$MOCK_SIGN_IN" != false \]; then\n\s+echo "AUTH_SOURCE=mock"/);
  });

  it("is passed from device-apk to build-android-apk", () => {
    const build = deviceApk.slice(deviceApk.indexOf("actions/build-android-apk@"));
    expect(build.slice(0, build.indexOf("- name:"))).toContain("mock-sign-in: ${{ inputs.mock-sign-in }}");
  });
});
