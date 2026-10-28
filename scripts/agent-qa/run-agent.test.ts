import { readFileSync } from "node:fs";
import { join } from "node:path";

// The CI QA agent must not read the project's settings, MCP servers or plugins: the repository
// under test is untrusted input, and the private workflow plugin is not available to CI. These
// flags are what keeps it isolated, so removing one has to fail here.
const script = readFileSync(join(__dirname, "run-agent.sh"), "utf8");
// The claude command without comment lines, so a note that names a flag is not read as the flag.
const command = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("run-agent.sh", () => {
  it("reads only the user's settings, never the project's", () => {
    expect(command).toMatch(/--setting-sources user\s*\\\n/);
  });

  it("ignores every MCP server except those given on the command line", () => {
    expect(command).toContain("--strict-mcp-config");
  });

  it("allows only agent-device commands from the one tool it has", () => {
    expect(command).toContain("--tools Bash");
    expect(command).toContain("--allowedTools 'Bash(agent-device:*)'");
  });

  it("does not load a plugin or widen the settings sources", () => {
    expect(command).not.toContain("--plugin-dir");
    expect(command).not.toMatch(/--setting-sources\s+\S*(project|local)/);
  });
});
