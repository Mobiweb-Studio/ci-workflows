import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const root = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const exampleNames = readdirSync(join(root, "examples", "callers")).filter(
  (name) => name.endsWith(".yml"),
);

type Permissions = Record<string, string>;
const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
const covers = (granted: Permissions, wanted: Permissions) =>
  Object.entries(wanted).every(
    ([scope, level]) => (LEVEL[granted[scope] ?? "none"] ?? 0) >= LEVEL[level],
  );

// The permissions a shared workflow asks for in its header line, "Token permissions the caller job must grant: a: read, b: write."
const headerPermissions = (text: string): Permissions => {
  const line = /^# Token permissions the caller job must grant: (.+)\.$/m.exec(text);
  if (!line) throw new Error("the workflow header names no token permissions");
  return Object.fromEntries(
    line[1].split(", ").map((pair) => pair.split(": ") as [string, string]),
  );
};

describe("the caller examples", () => {
  it("has one example for each shared workflow, and no other", () => {
    const shared = readdirSync(join(root, ".github", "workflows"))
      .filter((name) => !["self-test.yml", "tag-release.yml"].includes(name))
      .sort();
    expect(exampleNames.sort()).toEqual(shared);
  });

  describe.each(exampleNames)("%s", (name) => {
    const example = parse(read("examples", "callers", name));
    const sharedText = read(".github", "workflows", name);
    const shared = parse(sharedText);
    const [jobId, job] = Object.entries<any>(example.jobs)[0];

    it("has one job that calls the shared workflow at v1, with no steps and no condition of its own", () => {
      expect(Object.keys(example.jobs)).toHaveLength(1);
      expect(job.uses).toBe(
        `Mobiweb-Studio/ci-workflows/.github/workflows/${name}@v1`,
      );
      expect(job.steps).toBeUndefined();
      expect(job.if).toBeUndefined();
    });

    it("sets only inputs and secrets the shared workflow declares, and every required input", () => {
      const declared = shared.on.workflow_call.inputs ?? {};
      const secrets = shared.on.workflow_call.secrets ?? {};
      for (const key of Object.keys(job.with ?? {})) {
        expect(Object.keys(declared)).toContain(key);
      }
      for (const [key, spec] of Object.entries<any>(declared)) {
        if (spec.required) expect(Object.keys(job.with ?? {})).toContain(key);
      }
      for (const key of Object.keys(job.secrets ?? {})) {
        expect(Object.keys(secrets)).toContain(key);
      }
    });

    it("grants the token permissions the shared workflow asks for, so the run does not fail at startup", () => {
      const granted: Permissions = { ...example.permissions, ...job.permissions };
      expect(covers(granted, headerPermissions(sharedText))).toBe(true);
      for (const sharedJob of Object.values<any>(shared.jobs)) {
        if (sharedJob.permissions) {
          expect(covers(granted, sharedJob.permissions)).toBe(true);
        }
      }
    });

    it("keeps a job id that is the workflow name, so the check names stay predictable", () => {
      // The hotfix workflow is the one job id that differs from its file name; nothing waits for it.
      const expected = name === "hotfix-ota.yml" ? "hotfix" : name.replace(/\.yml$/, "");
      expect(jobId).toBe(expected);
    });
  });

  it("pulls only the events that never give fork code the secrets, for the workflows that hold tokens", () => {
    for (const name of [
      "device-checks.yml",
      "device-check-mode.yml",
      "jira-evidence-merge.yml",
    ]) {
      const example = parse(read("examples", "callers", name));
      expect(Object.keys(example.on)).toEqual(["pull_request"]);
    }
  });
});
