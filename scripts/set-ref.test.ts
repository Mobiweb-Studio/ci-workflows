import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const script = join(root, "scripts", "set-ref.mjs");

const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), "set-ref-"));
  cpSync(join(root, ".github"), join(dir, ".github"), { recursive: true });
  cpSync(join(root, "actions"), join(dir, "actions"), { recursive: true });
  cpSync(join(root, "examples"), join(dir, "examples"), { recursive: true });
  return dir;
};
const run = (dir: string, ref: string) =>
  execFileSync("node", [script, ref, dir], { encoding: "utf8" });
const all = (dir: string, sub: string) =>
  readdirSync(join(dir, sub), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => join(entry.parentPath, entry.name));
const references = (text: string) =>
  text.match(/Mobiweb-Studio\/ci-workflows\/[^\s"']+/g) ?? [];

describe("set-ref", () => {
  it("points every internal reference at the given ref and changes nothing else", () => {
    const dir = copy();
    try {
      const before = new Map(
        [...all(dir, ".github"), ...all(dir, "actions")].map((path) => [
          path,
          readFileSync(path, "utf8"),
        ]),
      );
      run(dir, "v1.0.0-rc.1");
      let seen = 0;
      for (const [path, text] of before) {
        const after = readFileSync(path, "utf8");
        const found = references(after);
        seen += found.length;
        for (const reference of found) {
          expect(reference).toMatch(/@v1\.0\.0-rc\.1$/);
        }
        expect(after.replace(/@v1\.0\.0-rc\.1/g, "@main")).toBe(
          text.replace(/(ci-workflows\/[^\s"']+?)@[^\s"']+/g, "$1@main"),
        );
      }
      expect(seen).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes nothing when run again with the same ref", () => {
    const dir = copy();
    try {
      run(dir, "v2.0.0");
      expect(run(dir, "v2.0.0")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the caller examples on the major", () => {
    const dir = copy();
    try {
      run(dir, "v1.0.0");
      for (const path of all(dir, "examples")) {
        for (const reference of references(readFileSync(path, "utf8"))) {
          expect(reference).toMatch(/@v1$/);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a ref that is not a plain tag or branch name", () => {
    const dir = copy();
    try {
      expect(() => run(dir, "v1; rm -rf /")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
