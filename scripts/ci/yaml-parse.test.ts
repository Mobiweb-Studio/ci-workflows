import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const root = join(__dirname, "..", "..");
const yamlFiles = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(dir, entry.parentPath.slice(join(root, dir).length), entry.name));

// A text-level test can pass on a file no parser accepts, and a project's CI then fails at startup.
describe("every workflow, action and caller example", () => {
  it.each([
    ...yamlFiles(".github/workflows"),
    ...yamlFiles("actions"),
    ...yamlFiles("examples"),
  ])("%s parses as YAML", (file) => {
    expect(() => parse(readFileSync(join(root, file), "utf8"))).not.toThrow();
  });
});
