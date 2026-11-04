import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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

  it.each(["device-checks.yml", "native-cache.yml"])("%s gives the token to the job that runs device-apk", (name) => {
    const text = read(".github", "workflows", name);
    const job = Object.values(jobs(text)).find((block) => block.includes("actions/device-apk@"));
    expect(job).toContain("NPM_AUTH_TOKEN: ${{ secrets.NPM_AUTH_TOKEN }}");
  });
});
