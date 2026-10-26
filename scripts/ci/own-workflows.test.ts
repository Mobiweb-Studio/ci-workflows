import { readFileSync } from "node:fs";
import { join } from "node:path";

// The file without its comment lines, so a header that says "never pull_request_target" is not read as a trigger.
const read = (name: string) =>
  readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

describe("self-test.yml", () => {
  const text = read("self-test.yml");

  it("runs on pull_request with a read-only token on a GitHub-hosted runner, never on pull_request_target", () => {
    expect(text).toMatch(/\n {2}pull_request:\n/);
    expect(text).not.toMatch(/pull_request_target|workflow_run/);
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(text).toContain("runs-on: ubuntu-latest");
    expect(text).not.toMatch(/blacksmith|self-hosted/);
  });

  it("runs the tests and actionlint", () => {
    expect(text).toContain("pnpm test");
    expect(text).toContain("rhysd/actionlint");
  });
});

describe("tag-release.yml", () => {
  const text = read("tag-release.yml");

  it("is started by hand, from main only, under the protected release environment", () => {
    expect(text).toMatch(/\non:\n {2}workflow_dispatch:\n/);
    expect(text).not.toMatch(/\n {2}(push|pull_request|schedule):/);
    expect(text).toContain("if: ${{ github.ref == 'refs/heads/main' }}");
    expect(text).toMatch(/\n {4}environment: release\n/);
  });

  it("limits write permission to the one job", () => {
    expect(text).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(text).toMatch(/\n {4}permissions:\n {6}contents: write\n/);
  });

  it("refuses a malformed version and an existing tag, and passes inputs through the environment only", () => {
    expect(text).toContain("The version must look like");
    expect(text).toContain("Tags are immutable");
    for (const line of text.split("\n").filter((l) => l.includes("${{ inputs."))) {
      expect(line).toMatch(/^\s+(VERSION|REHEARSAL_PASSED): \$\{\{ inputs\.[\w-]+ \}\}$|^\s+description|default/);
    }
  });

  it("moves the floating major only for a release whose rehearsal passed, never for a candidate", () => {
    const move = text.slice(text.indexOf("- name: Move the floating major"));
    expect(move.indexOf("*-rc.*")).toBeGreaterThan(-1);
    expect(move.indexOf("*-rc.*")).toBeLessThan(move.indexOf("git tag -f"));
    expect(move.indexOf('"$REHEARSAL_PASSED" != "true"')).toBeGreaterThan(-1);
    expect(move.indexOf('"$REHEARSAL_PASSED" != "true"')).toBeLessThan(
      move.indexOf("git tag -f"),
    );
  });
});
