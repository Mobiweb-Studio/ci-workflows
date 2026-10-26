import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "wait-for-checks.mjs");

type Run = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
};

// A stand-in for gh. Each call answers with the next file of the sequence (the last one repeats): a file holding
// the word FAIL makes the call fail, any other file is the check runs as one JSON object per line, which is what
// `gh api --paginate --jq '.check_runs[]'` prints.
const stubGh = `#!/bin/sh
n=$(cat "$SEQUENCE_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$SEQUENCE_DIR/count"
last=$(ls "$SEQUENCE_DIR"/step-* | wc -l | tr -d ' ')
[ "$n" -gt "$last" ] && n=$last
file="$SEQUENCE_DIR/step-$n"
if grep -q FAIL "$file"; then
  echo "gh: simulated failure" >&2
  exit 1
fi
cat "$file"
`;

const run = (
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
): Run => ({ id, name, status, conclusion });
const done = (id: number, name: string, conclusion: string) =>
  run(id, name, "completed", conclusion);
const running = (id: number, name: string) =>
  run(id, name, "in_progress", null);

describe("wait-for-checks", () => {
  let dir: string;
  let counter = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wait-for-checks-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), stubGh);
    chmodSync(join(dir, "bin", "gh"), 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Runs the script with a sequence of answers, one per poll. A string is a failing call.
  function wait(
    sequence: (Run[] | string)[],
    env: Record<string, string> = {},
  ) {
    const sequenceDir = join(dir, `sequence-${(counter += 1)}`);
    mkdirSync(sequenceDir);
    sequence.forEach((step, index) => {
      const content =
        typeof step === "string"
          ? step
          : step.map((r) => JSON.stringify(r)).join("\n");
      writeFileSync(join(sequenceDir, `step-${index + 1}`), `${content}\n`);
    });
    return spawnSync("node", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        SEQUENCE_DIR: sequenceDir,
        REPOSITORY: "owner/repo",
        COMMIT_SHA: "abc123",
        CHECKS: "commits\ndocs-check",
        TIMEOUT_SECONDS: "1",
        INTERVAL_SECONDS: "0.05",
        ...env,
      },
    });
  }

  it("passes when every named check succeeded", () => {
    const result = wait([
      [done(1, "commits", "success"), done(2, "docs-check", "success")],
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("commits");
  });

  it("ignores checks that are not named", () => {
    const result = wait([
      [
        done(1, "commits", "success"),
        done(2, "docs-check", "success"),
        done(3, "mode-comment", "failure"),
      ],
    ]);

    expect(result.status).toBe(0);
  });

  it("fails at once and names the check that failed, while another is still running", () => {
    const result = wait([
      [done(1, "commits", "failure"), running(2, "docs-check")],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commits");
    expect(result.stderr).toContain("failure");
  });

  it("fails on a named check that was skipped", () => {
    const result = wait([
      [done(1, "commits", "success"), done(2, "docs-check", "skipped")],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs-check");
    expect(result.stderr).toContain("skipped");
  });

  it("fails on a cancelled check that stays cancelled past the grace period", () => {
    const result = wait(
      [[done(1, "commits", "cancelled"), done(2, "docs-check", "success")]],
      { GRACE_SECONDS: "0.2" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commits");
    expect(result.stderr).toContain("cancelled");
  });

  it("waits for the replacement of a cancelled run and passes when it succeeds", () => {
    const result = wait(
      [
        [done(1, "commits", "cancelled"), done(2, "docs-check", "success")],
        [done(1, "commits", "cancelled"), done(2, "docs-check", "success")],
        [
          done(1, "commits", "cancelled"),
          running(7, "commits"),
          done(2, "docs-check", "success"),
        ],
        [done(7, "commits", "success"), done(2, "docs-check", "success")],
      ],
      { GRACE_SECONDS: "5" },
    );

    expect(result.status).toBe(0);
  });

  it("fails at once when the replacement of a cancelled run failed", () => {
    const result = wait(
      [
        [done(1, "commits", "cancelled"), done(2, "docs-check", "success")],
        [done(7, "commits", "failure"), done(2, "docs-check", "success")],
      ],
      { GRACE_SECONDS: "5" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failure");
  });

  it("still fails at once on failure and timed_out while another check was cancelled", () => {
    const result = wait(
      [[done(1, "commits", "cancelled"), done(2, "docs-check", "timed_out")]],
      { GRACE_SECONDS: "5" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("timed_out");
  });

  it("names the cancelled check when the time limit comes first", () => {
    const result = wait(
      [[done(1, "commits", "cancelled"), done(2, "docs-check", "success")]],
      { GRACE_SECONDS: "60", TIMEOUT_SECONDS: "0.3" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("commits");
    expect(result.stderr).toContain("cancelled");
  });

  it("uses the newer run of a name: an old failure that was re-run and passed", () => {
    const result = wait([
      [
        done(1, "commits", "failure"),
        done(5, "commits", "success"),
        done(2, "docs-check", "success"),
      ],
    ]);

    expect(result.status).toBe(0);
  });

  it("waits while the newer run of a name is still running, whatever the older one was", () => {
    const result = wait([
      [
        done(1, "commits", "success"),
        running(5, "commits"),
        done(2, "docs-check", "success"),
      ],
      [done(5, "commits", "success"), done(2, "docs-check", "success")],
    ]);

    expect(result.status).toBe(0);
  });

  it("keeps waiting while a check runs, then passes", () => {
    const result = wait([
      [running(1, "commits"), done(2, "docs-check", "success")],
      [done(1, "commits", "success"), done(2, "docs-check", "success")],
    ]);

    expect(result.status).toBe(0);
  });

  it("fails at the time limit and names a check that never appeared", () => {
    const result = wait([[done(1, "commits", "success")]]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs-check");
    expect(result.stderr).toContain("did not appear");
  });

  it("fails at the time limit and names a check that is still running", () => {
    const result = wait([
      [done(1, "commits", "success"), running(2, "docs-check")],
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs-check");
    expect(result.stderr).toContain("still running");
  });

  it("treats a failed API call as pending, and recovers when the next call works", () => {
    const result = wait([
      "FAIL",
      [done(1, "commits", "success"), done(2, "docs-check", "success")],
    ]);

    expect(result.status).toBe(0);
  });

  it("fails at the time limit and says the API could not be read when every call failed", () => {
    const result = wait(["FAIL"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not be read");
  });

  it.each([
    ["no check names", { CHECKS: "" }],
    ["a time limit that is not a number", { TIMEOUT_SECONDS: "soon" }],
    ["a negative interval", { INTERVAL_SECONDS: "-1" }],
    ["no commit SHA", { COMMIT_SHA: "" }],
    ["no repository", { REPOSITORY: "" }],
  ])("stops with an error on %s", (_name, env) => {
    const result = wait([[done(1, "commits", "success")]], env);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
