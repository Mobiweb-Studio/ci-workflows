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
});
