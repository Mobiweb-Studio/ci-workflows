import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "rehearse.mjs");

const CALLER = `jobs:
  ci:
    uses: Mobiweb-Studio/ci-workflows/.github/workflows/ci.yml@v1
  other:
    uses: actions/checkout@v7
  scripts:
    steps:
      - uses: Mobiweb-Studio/ci-workflows/actions/ci-scripts@v1.20.0
`;

// The whole command against a stand-in for gh: `repo clone` clones a local bare repository, the rest is logged.
describe("rehearse.mjs", () => {
  let dir: string;

  const ghStub = `#!/bin/sh
echo "gh $*" >> "$CALL_LOG"
case "$1 $2" in
  "api repos/Mobiweb-Studio/ci-workflows/git/ref/tags/"*)
    case "$2" in *"$KNOWN_TAG") echo "refs/tags/$KNOWN_TAG" ;; *) exit 1 ;; esac ;;
  "repo clone") git clone -q "$ORIGIN" "$4" ;;
  "pr create") echo "https://github.com/acme/scratch/pull/7" ;;
  "pr view") printf '%s' "$PR_VIEW" ;;
  "pr checks") printf '%s' "$PR_CHECKS"; [ -n "$CHECKS_EXIT" ] && exit "$CHECKS_EXIT" ;;
esac
exit 0
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rehearse-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gh"), ghStub);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const seed = join(dir, "seed");
    mkdirSync(join(seed, ".github", "workflows"), { recursive: true });
    writeFileSync(join(seed, ".github", "workflows", "ci.yml"), CALLER);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: seed });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--allow-empty");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "callers");
    execFileSync("git", ["clone", "-q", "--bare", seed, join(dir, "origin.git")]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}) => {
    const callLog = join(dir, "calls.log");
    writeFileSync(callLog, "");
    const result = spawnSync("node", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        CALL_LOG: callLog,
        ORIGIN: join(dir, "origin.git"),
        KNOWN_TAG: "v1.22.0-rc.1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
        ...env,
      },
    });
    return { ...result, calls: readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean) };
  };

  it("opens a labelled do-not-merge pull request from a branch whose callers point at the candidate", () => {
    const { status, stdout, calls } = run(["open", "acme/scratch", "v1.22.0-rc.1", "--dispatch", "android-regression.yml"]);
    expect(status).toBe(0);
    const pushed = execFileSync("git", ["--git-dir", join(dir, "origin.git"), "show", "rehearsal/v1.22.0-rc.1:.github/workflows/ci.yml"], {
      encoding: "utf8",
    });
    expect(pushed).toContain("ci.yml@v1.22.0-rc.1");
    expect(calls.find((c) => c.startsWith("gh pr create"))).toMatch(
      /--base main --head rehearsal\/v1\.22\.0-rc\.1 --title Rehearsal of Mobiweb-Studio\/ci-workflows v1\.22\.0-rc\.1 \(do not merge\) --label rehearsal/,
    );
    expect(calls).toContain("gh workflow run android-regression.yml --repo acme/scratch --ref rehearsal/v1.22.0-rc.1");
    expect(stdout).toContain("node scripts/rehearse.mjs close acme/scratch 7");
    // Only the shared references move: another action keeps its own ref.
    expect(pushed).toContain("ci-workflows/actions/ci-scripts@v1.22.0-rc.1\n");
    expect(pushed).toContain("actions/checkout@v7\n");
  });

  it("refuses a project whose workflows never call this repository", () => {
    const work = join(dir, "work");
    execFileSync("git", ["clone", "-q", join(dir, "origin.git"), work]);
    writeFileSync(join(work, ".github", "workflows", "ci.yml"), "jobs: {}\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "none"], { cwd: work });
    execFileSync("git", ["push", "-q", "origin", "HEAD"], { cwd: work });
    const { status, stderr, calls } = run(["open", "acme/scratch", "v1.22.0-rc.1"]);
    expect(status).toBe(1);
    expect(stderr).toContain("No workflow in acme/scratch references Mobiweb-Studio/ci-workflows");
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
  });

  it("refuses a tag this repository does not have, before cloning anything", () => {
    const { status, stderr, calls } = run(["open", "acme/scratch", "v9.9.9-rc.1"]);
    expect(status).toBe(1);
    expect(stderr).toContain("v9.9.9-rc.1 is not a tag of Mobiweb-Studio/ci-workflows");
    expect(calls.some((c) => c.startsWith("gh repo clone"))).toBe(false);
  });

  it("refuses a version that is not a release candidate, and unknown options", () => {
    expect(run(["open", "acme/scratch", "v1.22.0"]).status).toBe(2);
    expect(run(["open", "acme/scratch", "v1.22.0-rc.1", "--force"]).status).toBe(2);
  });

  const view = JSON.stringify({ headRefName: "rehearsal/v1.22.0-rc.1", labels: [{ name: "rehearsal" }], url: "https://github.com/acme/scratch/pull/7" });

  it("closes a passed rehearsal with a comment and prints the line to keep", () => {
    const checks = JSON.stringify([{ name: "ci", bucket: "pass", link: "l" }]);
    const { status, stdout, calls } = run(["close", "acme/scratch", "7"], { PR_VIEW: view, PR_CHECKS: checks });
    expect(status).toBe(0);
    expect(stdout).toContain("Rehearsal of v1.22.0-rc.1 on https://github.com/acme/scratch/pull/7: passed (1 checks passed, 0 skipped).");
    expect(calls).toContain("gh pr close 7 --repo acme/scratch --delete-branch");
  });

  it("closes a failed rehearsal too, names the failed check and exits 1", () => {
    const checks = JSON.stringify([{ name: "maestro-ios", bucket: "fail", link: "l" }]);
    const { status, stdout, calls } = run(["close", "acme/scratch", "7"], { PR_VIEW: view, PR_CHECKS: checks, CHECKS_EXIT: "1" });
    expect(status).toBe(1);
    expect(stdout).toContain("failed: maestro-ios (l)");
    expect(calls).toContain("gh pr close 7 --repo acme/scratch --delete-branch");
  });

  it("counts a rehearsal where no check ran as failed", () => {
    const { status, stdout } = run(["close", "acme/scratch", "7"], { PR_VIEW: view, PR_CHECKS: "[]" });
    expect(status).toBe(1);
    expect(stdout).toContain("failed: no checks ran");
  });

  it("leaves a rehearsal open while a check runs, and leaves alone a pull request without the label", () => {
    const pending = JSON.stringify([{ name: "maestro-android", bucket: "pending", link: "l" }]);
    const running = run(["close", "acme/scratch", "7"], { PR_VIEW: view, PR_CHECKS: pending, CHECKS_EXIT: "8" });
    expect(running.status).toBe(1);
    expect(running.stderr).toContain("Still running: maestro-android");
    const other = JSON.stringify({ headRefName: "feat/x", labels: [], url: "u" });
    const notOurs = run(["close", "acme/scratch", "7"], { PR_VIEW: other });
    expect(notOurs.status).toBe(1);
    for (const result of [running, notOurs]) {
      expect(result.calls.some((c) => c.startsWith("gh pr close"))).toBe(false);
    }
  });
});
