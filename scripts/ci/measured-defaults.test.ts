import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

// Defaults every caller inherits, set from measured runs (ICligo Sprint 1). Changing one is a minor release with a
// "Changed defaults" note (README, Versioning), so a change here must be deliberate.
const root = join(__dirname, "..", "..");
const inputs = (name: string) =>
  parse(readFileSync(join(root, ".github", "workflows", name), "utf8")).on
    .workflow_call.inputs;

describe("measured defaults", () => {
  it("runs the QA agent on Sonnet with 100 turns and a $2 ceiling", () => {
    const device = inputs("device-checks.yml");
    expect(device["qa-agent-model"].default).toBe("claude-sonnet-5-5");
    expect(device["qa-agent-max-turns"].default).toBe(100);
    expect(device["qa-agent-max-budget-usd"].default).toBe(2);
  });

  it("gives both regressions 150 minutes, a full suite's measured time with room", () => {
    for (const name of ["android-regression.yml", "ios-regression.yml"]) {
      expect(inputs(name)["timeout-minutes"].default).toBe(150);
    }
  });
});
