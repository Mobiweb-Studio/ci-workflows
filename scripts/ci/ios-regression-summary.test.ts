import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "ios-regression-summary.mjs");

const junit = (tests: number, failures: number) =>
  `<?xml version="1.0"?><testsuites><testsuite name="x" tests="${tests}" failures="${failures}"></testsuite></testsuites>`;

describe("ios-regression-summary", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ios-regression-"));
    mkdirSync(join(dir, ".maestro", "flows"), { recursive: true });
    mkdirSync(join(dir, "vendors", "default", "maestro"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const flow = (path: string, config: string) =>
    writeFileSync(join(dir, path), `appId: \${APP_ID}\n${config}---\n- launchApp\n- assertVisible: ios\n`);
  const report = (name: string, tests: number, failures: number) =>
    writeFileSync(join(dir, `maestro-report-${name}.xml`), junit(tests, failures));

  const run = () => {
    const summary = join(dir, "summary.md");
    const result = spawnSync("node", [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, APP_VARIANT: "default", IOS_RUNTIME: "26.4", GITHUB_STEP_SUMMARY: summary },
    });
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, "utf8") };
  };

  it("passes and names the untagged flows that passed as ones to tag", () => {
    flow(".maestro/flows/tagged.yml", "tags: [ios]\n");
    flow(".maestro/flows/candidate.yml", "");
    flow("vendors/default/maestro/android-only.yml", "tags:\n  - smoke\n");
    report("tagged", 1, 0);
    report("candidate", 1, 0);
    report("android-only", 1, 1);
    const { status, stdout, summary } = run();
    expect(status).toBe(0);
    expect(summary).toContain("### iOS 26.4");
    expect(summary).toContain("| `.maestro/flows/tagged.yml` | yes | passed |");
    expect(summary).toContain("| `vendors/default/maestro/android-only.yml` | no | failed |");
    expect(summary).toContain("**Regressions:** none.");
    expect(summary).toContain("**Can be tagged ios:** `.maestro/flows/candidate.yml`");
    expect(stdout).toContain("::notice::iOS 26.4: .maestro/flows/candidate.yml passed and can be tagged ios");
  });

  it("fails on a tagged flow that failed or left no report, and on nothing else", () => {
    flow(".maestro/flows/broken.yml", "tags: [ios]\n");
    flow(".maestro/flows/silent.yml", "tags:\n  - ios\n");
    flow(".maestro/flows/untagged.yml", "");
    report("broken", 1, 1);
    report("untagged", 1, 1);
    const { status, stdout, summary } = run();
    expect(status).toBe(1);
    expect(summary).toContain("| `.maestro/flows/silent.yml` | yes | no report |");
    expect(summary).toMatch(/\*\*Regressions:\*\* `.maestro\/flows\/broken.yml`, `.maestro\/flows\/silent.yml`/);
    expect(stdout).toContain("::error::iOS 26.4: .maestro/flows/broken.yml is tagged ios and failed");
    expect(stdout).toContain("::error::iOS 26.4: .maestro/flows/silent.yml is tagged ios and left no report");
    expect(stdout).not.toContain("untagged.yml is tagged");
  });

  it("reads the tag only from the config section, as run-maestro.sh does", () => {
    flow(".maestro/flows/lookalike.yml", "tags: [iosx]\n");
    report("lookalike", 1, 0);
    const { summary } = run();
    expect(summary).toContain("| `.maestro/flows/lookalike.yml` | no | passed |");
  });
});
