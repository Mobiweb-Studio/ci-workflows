import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const root = join(__dirname, "..", "..");
const dir = join(root, ".github", "workflows");
const shared = readdirSync(dir).filter(
  (name) => !["self-test.yml", "tag-release.yml"].includes(name),
);

// A called workflow sees only the secrets it declares in on.workflow_call.secrets. A secret it reads from the
// caller's environment is empty there unless it is declared, and a check that needs it fails or passes without it.
describe("the secrets a shared workflow reads", () => {
  it.each(shared)("%s declares every secret it references", (name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const declared = Object.keys(
      parse(text).on.workflow_call.secrets ?? {},
    );
    const referenced = [
      ...new Set(
        [...text.matchAll(/^[^#\n]*secrets\.([A-Z][A-Z0-9_]*)/gm)]
          .map((match) => match[1])
          .filter((secret) => secret !== "GITHUB_TOKEN"),
      ),
    ];
    expect(referenced.filter((secret) => !declared.includes(secret))).toEqual(
      [],
    );
  });
});
