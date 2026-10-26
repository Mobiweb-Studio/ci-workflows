import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "device-check-mode.mjs");

type Input = {
  check?: string;
  base?: string;
  defaultBranch?: string;
  draft?: boolean;
  labels?: string[];
  action?: string;
  label?: string;
  baseChanged?: boolean;
  files?: string[];
};

describe("device-check-mode", () => {
  let dir: string;
  let validList: string;
  let counter = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "device-check-mode-"));
    validList = join(dir, "valid-files.txt");
    writeFileSync(validList, "src/App.tsx");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const spawnScript = (env: Record<string, string>, command: string) => {
    const result = spawnSync(process.execPath, [script, command], {
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  // Runs the script as the workflows do: inputs in the environment, a file that lists the changed files.
  const run = (command: "decide" | "comment", input: Input = {}) => {
    const listPath = join(dir, `files-${counter++}.txt`);
    writeFileSync(listPath, (input.files ?? ["src/App.tsx"]).join("\n"));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      BASE_REF: input.base ?? "main",
      DEFAULT_BRANCH: input.defaultBranch ?? "main",
      IS_DRAFT: String(input.draft ?? false),
      LABELS: (input.labels ?? []).join("\n"),
      EVENT_ACTION: input.action ?? "synchronize",
      EVENT_LABEL: input.label ?? "",
      BASE_CHANGED: String(input.baseChanged ?? false),
      CHANGED_FILES: listPath,
    };
    if (input.check !== undefined) env.CHECK = input.check;
    return spawnScript(env, command);
  };

  const decide = (input: Input) => {
    const outputs = [];
    for (const check of ["maestro", "qa"]) {
      const result = run("decide", { ...input, check });
      expect(result.status).toBe(0);
      outputs.push(result.stdout.trim().split("\n"));
    }
    return outputs;
  };

  describe("rules", () => {
    it.each([
      ["a PR into a story branch", { base: "us/story" }, "false", "other-base"],
      [
        "a PR into a story branch with only docs changed",
        { base: "us/story", files: ["docs/ai/lifecycle.md"] },
        "false",
        "no-app-changes",
      ],
      [
        "a story-branch PR with run-device-checks",
        { base: "us/story", labels: ["run-device-checks"] },
        "true",
        "on-demand",
      ],

      [
        "a story label on a story-branch PR does not bypass its base",
        { base: "us/story", labels: ["us"] },
        "false",
        "other-base",
      ],
      [
        "the skip label on a story-branch PR changes nothing",
        { base: "us/story", labels: ["skip-device-checks"] },
        "false",
        "other-base",
      ],
      [
        "on demand wins over the skip label on a story-branch PR",
        {
          base: "us/story",
          labels: ["run-device-checks", "skip-device-checks"],
        },
        "true",
        "on-demand",
      ],
      [
        "a draft PR into main with the skip label",
        { draft: true, labels: ["skip-device-checks"] },
        "false",
        "draft",
      ],
      [
        "the same while it is a draft",
        { base: "us/story", labels: ["run-device-checks"], draft: true },
        "true",
        "on-demand",
      ],
      ["a ready PR into main", {}, "true", "full"],
      ["a draft PR into main", { draft: true }, "false", "draft"],
      [
        "a draft story PR into main",
        { draft: true, labels: ["us"] },
        "false",
        "draft",
      ],
      [
        "a PR into main with skip-device-checks",
        { labels: ["skip-device-checks"] },
        "false",
        "skipped-by-label",
      ],
      [
        "a PR into main with us and skip-device-checks",
        { labels: ["us", "skip-device-checks"] },
        "true",
        "story-pr",
      ],
      [
        "a story PR into main with no app changes",
        { labels: ["us"], files: ["README.md"] },
        "false",
        "no-app-changes",
      ],
      [
        "an unrelated label event on a ready PR into main",
        {
          action: "labeled",
          label: "qa-acknowledged",
          labels: ["qa-acknowledged"],
        },
        "false",
        "unrelated-label",
      ],
      [
        "an unrelated unlabeled event",
        { action: "unlabeled", label: "qa-acknowledged" },
        "false",
        "unrelated-label",
      ],
      [
        "the no-docs label being added, which re-evaluates the gate so a fixed docs check recovers it",
        { action: "labeled", label: "no-docs", labels: ["no-docs"] },
        "true",
        "full",
      ],
      [
        "the no-docs label being removed",
        { action: "unlabeled", label: "no-docs" },
        "true",
        "full",
      ],
      [
        "the skip label being added",
        {
          action: "labeled",
          label: "skip-device-checks",
          labels: ["skip-device-checks"],
        },
        "false",
        "skipped-by-label",
      ],
      [
        "the skip label being removed",
        { action: "unlabeled", label: "skip-device-checks" },
        "true",
        "full",
      ],
      [
        "the us label being added",
        { action: "labeled", label: "us", labels: ["us"] },
        "true",
        "story-pr",
      ],
      [
        "the on-demand label being added to a story-branch PR",
        {
          action: "labeled",
          label: "run-device-checks",
          base: "us/story",
          labels: ["run-device-checks"],
        },
        "true",
        "on-demand",
      ],
      [
        "a draft PR marked ready",
        { action: "ready_for_review" },
        "true",
        "full",
      ],
      [
        "a ready PR converted to draft",
        { action: "converted_to_draft", draft: true },
        "false",
        "draft",
      ],
    ] as [string, Input, string, string][])(
      "%s",
      (_name, input, expectedRun, reason) => {
        for (const output of decide(input)) {
          expect(output).toEqual([`run=${expectedRun}`, `reason=${reason}`]);
        }
      },
    );

    it("matches labels by their exact name", () => {
      for (const labels of [
        ["skip-device-checks-later"],
        ["Skip-Device-Checks"],
        ["no-skip-device-checks"],
      ]) {
        for (const output of decide({ labels })) {
          expect(output).toEqual(["run=true", "reason=full"]);
        }
      }
    });

    it("reads labels and file lists with Windows line endings", () => {
      const listPath = join(dir, "crlf.txt");
      writeFileSync(listPath, "README.md\r\nsrc/a.ts\r\n");
      const result = spawnScript(
        {
          PATH: process.env.PATH ?? "",
          CHECK: "maestro",
          BASE_REF: "main",
          DEFAULT_BRANCH: "main",
          IS_DRAFT: "false",
          LABELS: "skip-device-checks\r\n",
          EVENT_ACTION: "synchronize",
          CHANGED_FILES: listPath,
        },
        "decide",
      );
      expect(result.stdout).toBe("run=false\nreason=skipped-by-label\n");
    });

    it("treats the default branch name as an input", () => {
      for (const output of decide({
        base: "master",
        defaultBranch: "master",
      })) {
        expect(output).toEqual(["run=true", "reason=full"]);
      }
      for (const output of decide({ base: "main", defaultBranch: "master" })) {
        expect(output).toEqual(["run=false", "reason=other-base"]);
      }
    });

    it("skips with no app changes when the file list is empty", () => {
      for (const output of decide({ files: [] })) {
        expect(output).toEqual(["run=false", "reason=no-app-changes"]);
      }
    });
  });

  describe("path lists", () => {
    const outcome = (file: string) => {
      const [maestro, qa] = decide({ files: [file] });
      return [maestro[0], qa[0]];
    };

    it("runs both checks for app code and package files", () => {
      for (const file of [
        "src/shared/ui/Button.tsx",
        "app/_layout.tsx",
        "vendors/default/vendor.json",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "app.config.ts",
        "metro.config.js",
        "jest.config.js",
        "babel.config.js",
        "index.ts",
        ".npmrc",
        ".nvmrc",
        "tsconfig.json",
      ]) {
        expect(outcome(file)).toEqual(["run=true", "run=true"]);
      }
    });

    it("runs only Maestro for its flows", () => {
      expect(outcome(".maestro/flows/x.yaml")).toEqual([
        "run=true",
        "run=false",
      ]);
    });

    it("runs only the QA agent for its files", () => {
      expect(outcome("scripts/agent-qa/instructions.md")).toEqual([
        "run=false",
        "run=true",
      ]);
    });

    it("runs both checks when the project's device-checks caller changes", () => {
      expect(outcome(".github/workflows/device-checks.yml")).toEqual([
        "run=true",
        "run=true",
      ]);
    });

    it("ignores the files the shared workflows repository carries, which a project no longer has", () => {
      for (const file of [
        ".github/actions/device-apk/action.yml",
        "scripts/ci/device-apk-key.mjs",
        "scripts/ci/wait-for-checks.mjs",
        "scripts/ci/device-check-mode.mjs",
      ]) {
        expect(outcome(file)).toEqual(["run=false", "run=false"]);
      }
    });

    it("runs neither check for documentation and unrelated files", () => {
      for (const file of [
        "docs/ai/lifecycle.md",
        "README.md",
        ".github/workflows/ci.yml",
        "eas.json",
        ".github/workflows/maestro-android.yml",
        ".github/workflows/qa-agent.yml",
        "src-notes.md",
        "docs/package.json",
        "package.json.bak",
        "packages/app/index.ts",
      ]) {
        expect(outcome(file)).toEqual(["run=false", "run=false"]);
      }
    });

    it("runs a check when one of several changed files matches", () => {
      const [maestro, qa] = decide({
        files: ["README.md", "docs/x.md", "src/a.ts"],
      });
      expect(maestro[0]).toBe("run=true");
      expect(qa[0]).toBe("run=true");
    });
  });

  describe("invalid input", () => {
    const validEnv = (): Record<string, string> => ({
      PATH: process.env.PATH ?? "",
      CHECK: "maestro",
      BASE_REF: "main",
      DEFAULT_BRANCH: "main",
      IS_DRAFT: "false",
      LABELS: "",
      EVENT_ACTION: "synchronize",
      CHANGED_FILES: validList,
    });

    const runWith = (env: Record<string, string>, command = "decide") =>
      spawnScript(env, command);

    it("accepts the valid environment these cases start from", () => {
      expect(runWith(validEnv()).status).toBe(0);
    });

    it.each([
      ["no check", { CHECK: "" }],
      ["an unknown check", { CHECK: "detox" }],
      ["a draft flag that is neither true nor false", { IS_DRAFT: "maybe" }],
      ["a file list that cannot be read", { CHANGED_FILES: "/does/not/exist" }],
      [
        "a label event that does not name its label",
        { EVENT_ACTION: "labeled" },
      ],
      [
        "an unlabeled event that does not name its label",
        { EVENT_ACTION: "unlabeled" },
      ],
      [
        "a base-changed flag that is neither true nor false",
        { BASE_CHANGED: "yes" },
      ],
    ])("fails on %s and prints no decision", (_name, change) => {
      const result = runWith({ ...validEnv(), ...change });
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain("run=");
      expect(result.stderr).toContain("device-check-mode:");
    });

    it.each([
      "CHECK",
      "BASE_REF",
      "DEFAULT_BRANCH",
      "IS_DRAFT",
      "EVENT_ACTION",
      "CHANGED_FILES",
    ])("fails when %s is missing", (name) => {
      const env = validEnv();
      delete env[name];
      const result = runWith(env);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("run=");
    });

    it("fails on an unknown command", () => {
      const result = runWith(validEnv(), "explain");
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("run=");
    });
  });

  describe("comment", () => {
    const comment = (input: Input) => {
      const result = run("comment", input);
      expect(result.status).toBe(0);
      return result.stdout;
    };

    it("names both checks for a full run", () => {
      const text = comment({});
      expect(text).toContain("`maestro-android`");
      expect(text).toContain("`qa-agent`");
      expect(text).toContain("full run");
    });

    it("says a story PR is a full run because of the label", () => {
      expect(comment({ labels: ["us"] })).toContain("full run (story PR)");
    });

    it("says the checks were skipped by label", () => {
      expect(comment({ labels: ["skip-device-checks"] })).toContain(
        "skip-device-checks",
      );
    });

    it("says the checks wait while the PR is a draft", () => {
      expect(comment({ draft: true })).toContain("draft");
    });

    it("says no app files changed, per check", () => {
      const text = comment({ files: [".maestro/flows/x.yaml"] });
      const maestroLine = text
        .split("\n")
        .find((line) => line.includes("maestro-android"));
      const qaLine = text.split("\n").find((line) => line.includes("qa-agent"));
      expect(maestroLine).toContain("full run");
      expect(qaLine).toContain("no app files");
    });

    it("says a PR into a story branch does not run them", () => {
      expect(comment({ base: "us/story" })).toContain("us/story");
    });

    it("tells people a retarget to the default branch did not start the checks", () => {
      const text = comment({ action: "edited", baseChanged: true });
      expect(text).toContain("retarget");
      expect(text).toContain("push a commit or re-run");
    });

    it("describes the PR as it is when an unrelated label started the run", () => {
      const text = comment({
        action: "labeled",
        label: "qa-acknowledged",
        labels: ["qa-acknowledged", "skip-device-checks"],
      });
      expect(text).toContain("skipped by the `skip-device-checks` label");
      expect(text).not.toContain("does not affect");
    });

    it("does not mention a retarget for an edit that kept the base", () => {
      expect(comment({ action: "edited", baseChanged: false })).not.toContain(
        "retarget",
      );
    });

    it("does not mention a retarget when the new base is not the default branch", () => {
      expect(
        comment({ action: "edited", baseChanged: true, base: "us/story" }),
      ).not.toContain("retarget");
    });
  });
});
