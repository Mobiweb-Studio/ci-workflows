import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const root = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const ci = read(".github", "workflows", "ci.yml");

const blocks = jobs(ci);

describe("the wait-for-checks action", () => {
  const action = read("actions", "wait-for-checks", "action.yml");

  it("exists, and runs the script with the head commit of the pull request, never the merge commit", () => {
    expect(existsSync(join(root, "scripts", "ci", "wait-for-checks.mjs"))).toBe(
      true,
    );
    expect(action).toContain(
      'node "$GITHUB_ACTION_PATH/../../scripts/ci/wait-for-checks.mjs"',
    );
    expect(action).toContain(
      "COMMIT_SHA: ${{ github.event.pull_request.head.sha }}",
    );
    expect(action).not.toContain("github.sha");
  });

  it("takes the check names, the time limit and a token", () => {
    expect(action).toMatch(/^ {2}checks:\n/m);
    expect(action).toMatch(/^ {2}timeout-seconds:\n/m);
    expect(action).toMatch(/^ {2}github-token:\n/m);
  });
});

describe("ci.yml stage order", () => {
  it("runs `checks` only after `commits` and `secret-scan`, which share its workflow", () => {
    expect(blocks.checks).toMatch(/^ {4}needs: \[commits, secret-scan\]$/m);
  });

  it("does not make `checks` wait for the Jira check, which is off until the team uses Jira", () => {
    expect(blocks.checks).not.toMatch(/needs:.*ticket-key/);
  });

  it("does not make `checks` wait for `docs-check`, so a docs check that is fixed by a label recovers through the gate", () => {
    expect(blocks.checks).not.toContain("wait-for-checks");
    expect(blocks.checks).not.toMatch(/needs:.*docs-check/);
    expect(blocks.checks).not.toContain("checks: read");
  });

  it("does not use the setup-node pnpm cache, which failed on a cache miss", () => {
    expect(ci).not.toContain("cache: pnpm");
  });

  it("does not let the other quick checks wait for anything", () => {
    for (const name of ["commits", "secret-scan"]) {
      expect(blocks[name]).not.toMatch(/^ {4}needs:/m);
      expect(blocks[name]).not.toContain("wait-for-checks");
    }
  });
});

describe("the APK actions", () => {
  const build = read("actions", "build-android-apk", "action.yml");
  const deviceApk = read("actions", "device-apk", "action.yml");

  it("set up the toolchain and install the dependencies once, in device-apk", () => {
    for (const step of ["pnpm/action-setup", "setup-node", "setup-java"]) {
      expect(deviceApk).toContain(step);
      expect(build).not.toContain(step);
    }
    expect(deviceApk).toContain("pnpm install --frozen-lockfile");
    expect(build).not.toContain("pnpm install");
  });

  it("keep Gradle's own setup in the build action", () => {
    expect(build).toContain("gradle/actions/setup-gradle");
  });

  it("do not use the setup-node pnpm cache, which failed on a cache miss", () => {
    expect(deviceApk).not.toContain("cache: pnpm");
    expect(build).not.toContain("cache: pnpm");
  });
});
