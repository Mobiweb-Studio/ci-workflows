import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(__dirname, "ticket-key.mjs");

describe("ticket-key", () => {
  // Runs the check as the workflow does: inputs in the environment.
  const check = (input: {
    branch: string;
    title: string;
    projectKey?: string;
  }) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      BRANCH: input.branch,
      TITLE: input.title,
    };
    if (input.projectKey !== undefined) env.JIRA_PROJECT_KEY = input.projectKey;
    const result = spawnSync(process.execPath, [script, "check"], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };

  // Imports the parser as the evidence poster will, which also proves that importing does not run the check.
  const parse = (value: string, kind: "branch" | "title") => {
    const code = `import { parseTicketKey } from ${JSON.stringify(script)};
process.stdout.write(JSON.stringify(parseTicketKey(${JSON.stringify(value)}, ${JSON.stringify(kind)})));`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      { env: process.env, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout) as string | null;
  };

  it("passes a feat/ and a fix/ branch whose key matches the title key", () => {
    expect(
      check({
        branch: "feat/MBLPT-12-agents-md",
        title: "MBLPT-12 Add AGENTS.md",
      }).status,
    ).toBe(0);
    expect(
      check({ branch: "fix/MBLPT-7-login-crash", title: "MBLPT-7 Fix login" })
        .status,
    ).toBe(0);
    expect(parse("feat/MBLPT-12-agents-md", "branch")).toBe("MBLPT-12");
    expect(parse("MBLPT-12 Add AGENTS.md", "title")).toBe("MBLPT-12");
  });

  it("fails a feat/ branch with no key and shows the naming example", () => {
    const result = check({ branch: "feat/agents-md", title: "Add AGENTS.md" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Branch name");
    expect(result.output).toContain("feat/MBLPT-12-short-name");
  });

  it("fails a fix/ branch whose title has a different key", () => {
    const result = check({
      branch: "fix/MBLPT-7-login-crash",
      title: "MBLPT-8 Fix login",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("PR title");
    expect(result.output).toContain("MBLPT-7");
  });

  it("fails a title with no key on a feat/ branch and shows the title example", () => {
    const result = check({ branch: "feat/MBLPT-12-x", title: "Add AGENTS.md" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("MBLPT-12 Short summary");
  });

  it("passes other branch types without a key and says no key is required", () => {
    for (const branch of [
      "chore/bump-deps",
      "docs/readme",
      "release-please--branches--main",
      "dependabot/npm_and_yarn/x",
      "fix-typo",
    ]) {
      const result = check({ branch, title: "Update things" });
      expect(result.status).toBe(0);
      expect(result.output).toContain("no ticket key is required");
    }
  });

  it("fails a key from another project when JIRA_PROJECT_KEY is set, and names the expected one", () => {
    const branchResult = check({
      branch: "feat/ACME-4-add-login",
      title: "ACME-4 Add login",
      projectKey: "MBLPT",
    });
    expect(branchResult.status).toBe(1);
    expect(branchResult.output).toContain("Branch name");
    expect(branchResult.output).toContain("MBLPT");
    expect(
      check({
        branch: "feat/MBLPT-4-add-login",
        title: "MBLPT-4 Add login",
        projectKey: "MBLPT",
      }).status,
    ).toBe(0);
  });

  it("fails a key followed by more characters, and passes a branch that is only the prefix and key", () => {
    expect(
      check({ branch: "feat/MBLPT-12abc", title: "MBLPT-12 Add" }).status,
    ).toBe(1);
    expect(
      check({ branch: "feat/MBLPT-12", title: "MBLPT-12 Add" }).status,
    ).toBe(0);
  });

  it("fails a lowercase key", () => {
    expect(
      check({ branch: "feat/mblpt-12-x", title: "MBLPT-12 X" }).status,
    ).toBe(1);
  });

  it("fails a title with the key later in the text", () => {
    expect(
      check({ branch: "feat/MBLPT-12-fix", title: "Fix MBLPT-12" }).status,
    ).toBe(1);
  });

  it("reads the key at the start of a branch or after one lowercase type prefix", () => {
    expect(parse("MBLPT-12-agents-md", "branch")).toBe("MBLPT-12");
    expect(parse("chore/MBLPT-5-deps", "branch")).toBe("MBLPT-5");
    expect(parse("fix-typo", "branch")).toBeNull();
    expect(parse("a/b/MBLPT-5-x", "branch")).toBeNull();
    expect(parse("feat/MBLPT-12 Add", "title")).toBeNull();
  });
});
