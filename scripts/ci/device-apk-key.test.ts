import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "device-apk-key.mjs");
const hashA = "a".repeat(40);
const hashB = `b${"a".repeat(39)}`;

function key(vendor: string, input: string) {
  return spawnSync("node", [script, vendor], { input, encoding: "utf8" });
}

describe("device-apk-key", () => {
  it("prints the same key for the same fingerprint and vendor", () => {
    const first = key("default", JSON.stringify({ hash: hashA }));
    const second = key("default", JSON.stringify({ hash: hashA, sources: [] }));
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("prints another key when the native fingerprint changes, so the action builds instead of repacking", () => {
    const a = key("default", JSON.stringify({ hash: hashA }));
    const b = key("default", JSON.stringify({ hash: hashB }));
    expect(a.stdout).not.toBe(b.stdout);
  });

  it("prints another key for another vendor", () => {
    const a = key("default", JSON.stringify({ hash: hashA }));
    const b = key("acme", JSON.stringify({ hash: hashA }));
    expect(a.stdout).not.toBe(b.stdout);
  });

  it.each([
    ["not JSON", "oops"],
    ["no hash", "{}"],
    ["a short hash", JSON.stringify({ hash: "abc" })],
  ])("stops with an error on %s", (_name, input) => {
    const result = key("default", input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("stops with an error on a missing or unsafe vendor", () => {
    expect(key("", JSON.stringify({ hash: hashA })).status).toBe(1);
    expect(key("../x", JSON.stringify({ hash: hashA })).status).toBe(1);
  });
});
