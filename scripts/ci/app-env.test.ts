import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

// A project's app environment (APP_ENV: dev, staging, prod) changes the app's ids and the backend it talks to, so the
// device checks can build the dev app. Every workflow that builds or runs the app takes `app-env`, empty by default
// (the project's default build, as before), and hands it to each action; the app's id comes from the resolved Expo
// config, never from vendor.json, so a `.dev` id is the one Maestro launches.
const root = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const ACTIONS_WITH_APP_ENV = ["device-apk", "device-check-env"];

const workflows = readdirSync(join(root, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, doc: parse(read(".github", "workflows", name)) }))
  .filter(({ doc }) =>
    Object.values<any>(doc.jobs).some((job) =>
      (job.steps ?? []).some((step: any) => /actions\/(device-apk|device-check-env|device-ios-app)@/.test(step.uses ?? "")),
    ),
  );

describe("the app-env input", () => {
  it("is taken by every workflow that builds or runs the app", () => {
    expect(workflows.map(({ name }) => name).sort()).toEqual([
      "android-regression.yml",
      "device-checks.yml",
      "ios-regression.yml",
      "native-cache.yml",
    ]);
  });

  describe.each(workflows.map(({ name, doc }) => [name, doc] as const))("%s", (name, doc) => {
    const steps = Object.values<any>(doc.jobs).flatMap((job) => job.steps ?? []);

    it("declares app-env as an optional string, empty by default, and documents it in its header", () => {
      expect(doc.on.workflow_call.inputs["app-env"]).toEqual({ type: "string", default: "" });
      expect(read(".github", "workflows", name)).toMatch(/^# {3}app-env {11}\S/m);
    });

    it("passes it to every device-apk and device-check-env step", () => {
      const uses = steps.filter((step: any) =>
        ACTIONS_WITH_APP_ENV.some((action) => (step.uses ?? "").includes(`actions/${action}@`)),
      );
      expect(uses.length).toBeGreaterThan(0);
      for (const step of uses) expect(step.with["app-env"]).toBe("${{ inputs.app-env }}");
    });

    it("gives every Android device-check-env the app id device-apk read from the resolved config", () => {
      for (const step of steps.filter((s: any) => (s.uses ?? "").includes("actions/device-check-env@"))) {
        if (step.with.platform === "ios") continue;
        expect(step.with["app-id"]).toMatch(/^\$\{\{ (needs|steps)\.apk\.outputs\.app-id \}\}$/);
        expect(step.with["app-scheme"]).toMatch(/^\$\{\{ (needs|steps)\.apk\.outputs\.app-scheme \}\}$/);
      }
    });
  });

  it("is handed by device-checks' apk job to the device jobs as job outputs", () => {
    const apk = parse(read(".github", "workflows", "device-checks.yml")).jobs.apk;
    expect(apk.outputs).toEqual({
      "app-id": "${{ steps.apk.outputs.app-id }}",
      "app-scheme": "${{ steps.apk.outputs.app-scheme }}",
    });
  });
});

describe.each([
  ["device-apk", "android"],
  ["device-ios-app", "ios"],
])("%s", (name, platform) => {
  const text = read("actions", name, "action.yml");

  it("reads APP_ID and APP_SCHEME from the resolved Expo config, after the fingerprint and before the build or repack", () => {
    const identity = text.indexOf(`app-identity.mjs" ${platform}`);
    expect(identity).toBeGreaterThan(-1);
    expect(text.lastIndexOf("pnpm exec expo config --json", identity)).toBeGreaterThan(text.indexOf("fingerprint:generate"));
    expect(identity).toBeLessThan(text.indexOf("repack-app@"));
    expect(identity).toBeLessThan(text.indexOf("actions/build-"));
    expect(text).not.toContain("require('./vendors/");
  });
});

describe("device-apk", () => {
  const text = read("actions", "device-apk", "action.yml");

  it("exports APP_ENV before the fingerprint, the key and the repack, and hands app-env to build-android-apk", () => {
    const exported = text.indexOf('echo "APP_ENV=$INPUT_APP_ENV" >> "$GITHUB_ENV"');
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(text.indexOf("fingerprint:generate"));
    expect(text).toMatch(/build-android-apk@main\n\s+with:\n\s+reference-vendor: .*\n\s+app-env: \$\{\{ inputs\.app-env \}\}/);
  });

  it("leaves APP_ENV unset when app-env is empty, so the default build is the one it was before", () => {
    expect(text).toContain('if [ -n "$INPUT_APP_ENV" ]; then echo "APP_ENV=$INPUT_APP_ENV" >> "$GITHUB_ENV"; fi');
  });
});

it("build-android-apk no longer sets APP_ID from vendor.json", () => {
  expect(read("actions", "build-android-apk", "action.yml")).not.toContain("require('./vendors/");
});
