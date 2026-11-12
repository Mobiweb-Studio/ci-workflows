import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const root = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

// Every place that runs `pnpm install`: the workflow jobs, and the device-apk action the device-checks and
// native-cache jobs use.
const sites: [string, string][] = [
  ["ci.yml checks", jobs(read(".github", "workflows", "ci.yml")).checks],
  ["ci.yml commits", jobs(read(".github", "workflows", "ci.yml")).commits],
  ["release.yml release", jobs(read(".github", "workflows", "release.yml")).release],
  ["hotfix-ota.yml hotfix", jobs(read(".github", "workflows", "hotfix-ota.yml")).hotfix],
  ["actions/device-apk", read("actions", "device-apk", "action.yml")],
];

const LINE = "echo '//npm.pkg.github.com/:_authToken=${NPM_AUTH_TOKEN}' >> ~/.npmrc";

// pnpm does not expand environment variables in registry credentials from a project .npmrc, so a project with
// private packages gets the credential line in the runner's user-level ~/.npmrc, where it does.
describe("the npm token for private packages", () => {
  it.each(sites)("%s writes the token's reference to ~/.npmrc before pnpm install, only when it is set", (_, text) => {
    const write = text.indexOf(LINE);
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(text.indexOf("pnpm install"));
    const step = text.slice(text.lastIndexOf("- name:", write), write);
    expect(step).toContain("if: ${{ env.NPM_AUTH_TOKEN != '' }}");
  });

  it("writes the reference, never the token", () => {
    const home = mkdtempSync(join(tmpdir(), "npm-auth-"));
    execFileSync("bash", ["-c", LINE], {
      env: { ...process.env, HOME: home, NPM_AUTH_TOKEN: "ghp_not-a-real-token" },
    });
    expect(readFileSync(join(home, ".npmrc"), "utf8")).toBe(
      "//npm.pkg.github.com/:_authToken=${NPM_AUTH_TOKEN}\n",
    );
  });

  it.each(["device-checks.yml", "native-cache.yml", "android-regression.yml"])("%s gives the token to the job that runs device-apk", (name) => {
    const text = read(".github", "workflows", name);
    const job = Object.values(jobs(text)).find((block) => block.includes("actions/device-apk@"));
    expect(job).toContain("NPM_AUTH_TOKEN: ${{ secrets.NPM_AUTH_TOKEN }}");
  });

  it.each(["device-checks.yml", "native-cache.yml", "ios-regression.yml"])(
    "%s gives the token to every job that runs device-ios-app, and declares it as optional",
    (name) => {
      const text = read(".github", "workflows", name);
      const iosJobs = Object.values(jobs(text)).filter((block) => block.includes("actions/device-ios-app@"));
      expect(iosJobs.length).toBeGreaterThan(0);
      for (const job of iosJobs) expect(job).toContain("NPM_AUTH_TOKEN: ${{ secrets.NPM_AUTH_TOKEN }}");
      expect(text).toMatch(/^ {6}NPM_AUTH_TOKEN:\n {8}required: false$/m);
    },
  );
});

// The iOS runner can be a shared self-hosted Mac, so device-ios-app writes the line to a file under RUNNER_TEMP and
// points pnpm at it, never touching the Mac's own ~/.npmrc.
describe("the npm token on the iOS runner", () => {
  const action = read("actions", "device-ios-app", "action.yml");
  const IOS_LINE = `echo '//npm.pkg.github.com/:_authToken=\${NPM_AUTH_TOKEN}' > "$RUNNER_TEMP/npmrc"`;
  const POINT = 'echo "NPM_CONFIG_USERCONFIG=$RUNNER_TEMP/npmrc" >> "$GITHUB_ENV"';

  it("writes the reference to a job-only user .npmrc before pnpm install, only when the token is set", () => {
    const write = action.indexOf(IOS_LINE);
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(action.indexOf("- run: pnpm install"));
    expect(action.indexOf(POINT)).toBeGreaterThan(write);
    expect(action.indexOf(POINT)).toBeLessThan(action.indexOf("- run: pnpm install"));
    const step = action.slice(action.lastIndexOf("- name:", write), write);
    expect(step).toContain("if: ${{ env.NPM_AUTH_TOKEN != '' }}");
    expect(action).not.toContain("~/.npmrc'");
    expect(action).not.toMatch(/>>? ~\/\.npmrc/);
  });

  it("writes the reference, never the token, and leaves HOME alone", () => {
    const home = mkdtempSync(join(tmpdir(), "npm-auth-home-"));
    const temp = mkdtempSync(join(tmpdir(), "npm-auth-temp-"));
    const githubEnv = join(temp, "github-env");
    execFileSync("bash", ["-c", `${IOS_LINE}\n${POINT}`], {
      env: { ...process.env, HOME: home, RUNNER_TEMP: temp, GITHUB_ENV: githubEnv, NPM_AUTH_TOKEN: "ghp_not-a-real-token" },
    });
    expect(readFileSync(join(temp, "npmrc"), "utf8")).toBe("//npm.pkg.github.com/:_authToken=${NPM_AUTH_TOKEN}\n");
    expect(readFileSync(githubEnv, "utf8")).toBe(`NPM_CONFIG_USERCONFIG=${temp}/npmrc\n`);
    expect(existsSync(join(home, ".npmrc"))).toBe(false);
  });
});
