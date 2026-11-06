import { readFileSync } from "node:fs";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const read = (name: string) => readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8");

// The jobs that only read, wait or comment run on a GitHub-hosted runner by default, so the Blacksmith minutes go to
// the jobs that build or run the app. Each job is billed by the started minute, so a job of seconds costs a minute.
describe("light jobs on a GitHub-hosted runner", () => {
  it.each([
    ["ci.yml", ["commits", "secret-scan", "ticket-key"], ["checks"]],
    ["device-checks.yml", ["changes", "gate", "ios-app-link", "jira-evidence"], ["apk", "maestro-android", "qa-agent"]],
  ])("%s runs its light jobs on light-runner and the rest on runner", (file, light, heavy) => {
    const text = read(file);
    const blocks = jobs(text);
    expect(text).toMatch(/light-runner:\n {8}type: string\n {8}default: ubuntu-latest\n/);
    expect(text).toMatch(/runner:\n {8}type: string\n {8}default: blacksmith-[a-z0-9-]+\n/);
    for (const name of light) expect(blocks[name]).toMatch(/^ {4}runs-on: \$\{\{ inputs\.light-runner \}\}$/m);
    for (const name of heavy) expect(blocks[name]).toMatch(/^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/m);
  });

  it.each(["device-check-mode.yml", "docs-check.yml", "human-review.yml", "jira-evidence-merge.yml"])(
    "%s, whose jobs are all light, defaults its runner to ubuntu-latest",
    (file) => {
      const text = read(file);
      expect(text).toMatch(/ {6}runner:\n {8}type: string\n {8}default: ubuntu-latest\n/);
      for (const block of Object.values(jobs(text))) {
        expect(block).toMatch(/^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/m);
      }
    },
  );
});
