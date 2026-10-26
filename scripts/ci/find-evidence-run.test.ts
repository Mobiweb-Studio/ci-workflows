import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "find-evidence-run.mjs");

type Artifact = { name: string; expired: boolean };

// A stand-in for gh. It answers `gh api <path>` from the files in $ANSWERS_DIR: `runs.json` for the list of the
// workflow's runs, `artifacts-<id>.json` for the artifacts of run <id>. It records each path it was asked for.
const stubGh = `#!/bin/sh
path="$2"
echo "$path" >> "$ANSWERS_DIR/calls"
case "$path" in
  */actions/workflows/device-checks.yml/runs*) cat "$ANSWERS_DIR/runs.json" ;;
  */actions/runs/*/artifacts*)
    id=$(echo "$path" | sed 's|.*/actions/runs/\\([0-9]*\\)/artifacts.*|\\1|')
    cat "$ANSWERS_DIR/artifacts-$id.json" ;;
  *) echo "gh: unexpected call $path" >&2; exit 1 ;;
esac
`;

describe("find-evidence-run", () => {
  let dir: string;
  let counter = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "find-evidence-run-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), stubGh);
    chmodSync(join(dir, "bin", "gh"), 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Runs the script with the given runs (newest first, as the API lists them) and their artifacts.
  function find(runs: { id: number; artifacts: Artifact[] }[]) {
    const answersDir = join(dir, `answers-${(counter += 1)}`);
    mkdirSync(answersDir);
    writeFileSync(
      join(answersDir, "runs.json"),
      JSON.stringify({ workflow_runs: runs.map(({ id }) => ({ id })) }),
    );
    for (const { id, artifacts } of runs) {
      writeFileSync(
        join(answersDir, `artifacts-${id}.json`),
        JSON.stringify({ artifacts }),
      );
    }
    return spawnSync("node", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        ANSWERS_DIR: answersDir,
        GITHUB_REPOSITORY: "owner/repo",
        HEAD_SHA: "abc123",
      },
    });
  }

  it("passes over a newer run with no artifacts or only a qa-report, and chooses the older run that has qa-agent", () => {
    const result = find([
      { id: 40, artifacts: [{ name: "qa-report", expired: false }] },
      { id: 30, artifacts: [] },
      {
        id: 20,
        artifacts: [
          { name: "qa-report", expired: false },
          { name: "qa-agent", expired: false },
        ],
      },
      { id: 10, artifacts: [{ name: "qa-report", expired: false }] },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("20");
  });

  it("asks for the device-checks runs of the PR's head commit", () => {
    const answersDir = join(dir, `answers-${counter + 1}`);
    find([{ id: 5, artifacts: [{ name: "maestro-android", expired: false }] }]);

    const calls = readFileSync(join(answersDir, "calls"), "utf8");
    expect(calls).toContain(
      "repos/owner/repo/actions/workflows/device-checks.yml/runs?head_sha=abc123",
    );
  });

  it("chooses a run that has only a maestro-android artifact", () => {
    const result = find([
      { id: 7, artifacts: [{ name: "maestro-android", expired: false }] },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("7");
  });

  it("reports none when every run's artifacts expired or none ever ran", () => {
    const result = find([
      { id: 30, artifacts: [] },
      {
        id: 20,
        artifacts: [
          { name: "qa-agent", expired: true },
          { name: "maestro-android", expired: true },
          { name: "device-apk", expired: false },
        ],
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("abc123");
  });

  it("reports none when the commit has no device-checks run", () => {
    const result = find([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
