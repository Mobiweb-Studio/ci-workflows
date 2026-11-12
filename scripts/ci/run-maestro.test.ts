import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "run-maestro.sh");

// Stand-ins for maestro, adb and xcrun: each logs its arguments, and maestro fails for a flow named in MAESTRO_FAIL.
const stub = (name: string) => `#!/bin/sh
echo "${name} $*" >> "$CALL_LOG"
case "$*" in *"$MAESTRO_FAIL"*) [ -n "$MAESTRO_FAIL" ] && [ "${name}" = maestro ] && exit 1 ;; esac
exit 0
`;

describe("run-maestro.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-maestro-"));
    mkdirSync(join(dir, "bin"));
    for (const name of ["maestro", "adb", "xcrun", "sleep"]) {
      writeFileSync(join(dir, "bin", name), stub(name));
      chmodSync(join(dir, "bin", name), 0o755);
    }
    mkdirSync(join(dir, ".maestro", "flows"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const flow = (name: string, config: string, commands = "- launchApp\n") =>
    writeFileSync(join(dir, ".maestro", "flows", `${name}.yml`), `appId: \${APP_ID}\n${config}---\n${commands}`);

  const run = (env: Record<string, string> = {}) => {
    const callLog = join(dir, "calls.log");
    writeFileSync(callLog, "");
    const result = spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        APP_VARIANT: "default",
        APP_ID: "com.example.app",
        CALL_LOG: callLog,
        ...env,
      },
    });
    const calls = readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
    return { status: result.status, stdout: result.stdout, calls };
  };

  const maestroFlows = (calls: string[]) =>
    calls.filter((c) => c.startsWith("maestro ")).map((c) => /flows\/([a-z-]+)\.yml/.exec(c)?.[1]);

  it("runs every flow on Android, stopping the app with adb first", () => {
    flow("one", "");
    flow("two", "tags: [smoke]\n");
    const { status, calls } = run();
    expect(status).toBe(0);
    expect(maestroFlows(calls)).toEqual(["one", "two"]);
    expect(calls[0]).toBe("adb shell am force-stop com.example.app");
    expect(calls.some((c) => c.startsWith("xcrun"))).toBe(false);
  });

  it("runs only the flows tagged ios on iOS, on the job's simulator", () => {
    flow("inline", "tags: [smoke, ios]\n");
    flow("listed", "tags:\n  - smoke\n  - ios\n");
    flow("untagged", "", "- launchApp\n- assertVisible: ios\n");
    flow("lookalike", "tags: [iosx]\n");
    const { status, stdout, calls } = run({ MAESTRO_PLATFORM: "ios", IOS_UDID: "UDID-1" });
    expect(status).toBe(0);
    expect(maestroFlows(calls)).toEqual(["inline", "listed"]);
    expect(calls).toContain("xcrun simctl terminate UDID-1 com.example.app");
    expect(calls.filter((c) => c.startsWith("maestro ")).every((c) => c.startsWith("maestro --device UDID-1 test"))).toBe(true);
    expect(calls.some((c) => c.startsWith("adb"))).toBe(false);
    expect(stdout).toContain("Not tagged ios, skipped: .maestro/flows/untagged.yml");
  });

  it("runs every flow on iOS, tagged or not, with MAESTRO_ALL_FLOWS=true", () => {
    flow("tagged", "tags: [ios]\n");
    flow("untagged", "");
    const { status, calls } = run({ MAESTRO_PLATFORM: "ios", IOS_UDID: "UDID-1", MAESTRO_ALL_FLOWS: "true" });
    expect(status).toBe(0);
    expect(maestroFlows(calls)).toEqual(["tagged", "untagged"]);
  });

  it("warns when no flow is tagged ios, and passes", () => {
    flow("android-only", "");
    const { status, stdout, calls } = run({ MAESTRO_PLATFORM: "ios", IOS_UDID: "UDID-1" });
    expect(status).toBe(0);
    expect(maestroFlows(calls)).toEqual([]);
    expect(stdout).toContain("::warning::No Maestro flow ran on ios");
  });

  it("runs the remaining flows after one fails, and fails at the end", () => {
    flow("bad", "tags: [ios]\n");
    flow("good", "tags: [ios]\n");
    const { status, calls } = run({ MAESTRO_PLATFORM: "ios", IOS_UDID: "UDID-1", MAESTRO_FAIL: "bad.yml" });
    expect(status).toBe(1);
    expect(maestroFlows(calls)).toEqual(["bad", "good"]);
  });

  describe("feature folders, tags and output", () => {
    // A project that keeps one folder per feature has no .maestro/flows.
    const featureFlow = (feature: string, name: string, config: string) => {
      rmSync(join(dir, ".maestro", "flows"), { recursive: true, force: true });
      mkdirSync(join(dir, ".maestro", feature), { recursive: true });
      writeFileSync(join(dir, ".maestro", feature, `${name}.yml`), `appId: \${APP_ID}\n${config}---\n- launchApp\n`);
    };
    const ranFlows = (calls: string[]) =>
      calls.filter((c) => c.startsWith("maestro ")).map((c) => /\/([a-z-]+)\.yml/.exec(c)?.[1]);

    it("runs the flows of every feature folder, but not the shared subflows", () => {
      featureFlow("login", "happy-path", "tags: [smoke, login]\n");
      featureFlow("settings", "theme", "tags: [settings]\n");
      featureFlow("_subflows", "open-login", "");
      const { status, calls } = run();
      expect(status).toBe(0);
      expect(ranFlows(calls)).toEqual(["happy-path", "theme"]);
    });

    it("keeps .maestro/flows when the project has it, and ignores feature folders then", () => {
      flow("legacy", "");
      mkdirSync(join(dir, ".maestro", "subflows"));
      writeFileSync(join(dir, ".maestro", "subflows", "helper.yml"), "appId: x\n---\n- launchApp\n");
      const { calls } = run();
      expect(ranFlows(calls)).toEqual(["legacy"]);
    });

    it("runs only the flows with one of MAESTRO_TAGS", () => {
      featureFlow("login", "happy-path", "tags: [smoke, login]\n");
      featureFlow("login", "offline", "tags:\n  - login\n");
      featureFlow("rankings", "list", "tags: [rankings]\n");
      featureFlow("settings", "theme", "tags: [settings-x]\n");
      const { status, stdout, calls } = run({ MAESTRO_TAGS: "smoke,rankings settings" });
      expect(status).toBe(0);
      expect(ranFlows(calls)).toEqual(["happy-path", "list"]);
      expect(stdout).toContain("Not affected by this change, skipped: .maestro/login/offline.yml");
      expect(stdout).toContain("Not affected by this change, skipped: .maestro/settings/theme.yml");
    });

    it("drops the flows with one of MAESTRO_EXCLUDE_TAGS", () => {
      featureFlow("login", "happy-path", "tags: [smoke, login]\n");
      featureFlow("login", "wrong-password", "tags: [login, nightly]\n");
      const { calls } = run({ MAESTRO_EXCLUDE_TAGS: "nightly" });
      expect(ranFlows(calls)).toEqual(["happy-path"]);
    });

    it("lists each flow that ran in maestro-output/flows.tsv, with its name and tags", () => {
      featureFlow("login", "happy-path", "name: Login happy path\ntags: [smoke, login, ICLIGO-19-AC9]\n");
      featureFlow("login", "listed", "tags:\n  - login\n  - ICLIGO-19-AC11\n");
      featureFlow("login", "plain", "");
      featureFlow("login", "skipped", "tags: [nightly]\n");
      run({ MAESTRO_EXCLUDE_TAGS: "nightly" });
      expect(readFileSync(join(dir, "maestro-output", "flows.tsv"), "utf8").split("\n")).toEqual([
        "happy-path\t.maestro/login/happy-path.yml\tLogin happy path\tsmoke,login,ICLIGO-19-AC9",
        "listed\t.maestro/login/listed.yml\tlisted\tlogin,ICLIGO-19-AC11",
        "plain\t.maestro/login/plain.yml\tplain\t",
        "",
      ]);
    });

    it("writes each flow's output to a folder named after it", () => {
      featureFlow("login", "happy-path", "");
      const { calls } = run();
      expect(calls.find((c) => c.startsWith("maestro "))).toContain("--test-output-dir maestro-output/happy-path");
    });
  });
});
