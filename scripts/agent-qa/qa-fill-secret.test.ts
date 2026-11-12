import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "bin", "qa-fill-secret");

// A stand-in for agent-device that records its arguments, one per line.
describe("qa-fill-secret", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qa-fill-secret-"));
    writeFileSync(
      join(dir, "agent-device"),
      '#!/bin/sh\nfor arg in "$@"; do echo "$arg"; done > "$CALL_LOG"\n',
    );
    chmodSync(join(dir, "agent-device"), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}) => {
    const log = join(dir, "calls");
    writeFileSync(log, "");
    const result = spawnSync("bash", [script, ...args], {
      env: { PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log, ...env },
      encoding: "utf8",
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  };

  it("fills the input with the variable's value through agent-device, and prints nothing itself", () => {
    const result = run(["id=login-password-input", "MAESTRO_TP_PASSWORD"], {
      MAESTRO_TP_PASSWORD: "p ss$1",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.calls).toBe("fill\nid=login-password-input\np ss$1\n--settle\n");
  });

  it.each([
    [["@e1", "HOME"]],
    [["@e1", "MAESTRO_lower"]],
    [["@e1"]],
  ])("refuses %j: only a MAESTRO_* variable, with a target", (args) => {
    const result = run(args, { HOME: "/home/runner" });
    expect(result.status).toBe(2);
    expect(result.calls).toBe("");
  });

  it("fails without typing when the variable is empty", () => {
    const result = run(["@e1", "MAESTRO_TP_PASSWORD"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MAESTRO_TP_PASSWORD is not set");
    expect(result.calls).toBe("");
  });
});
