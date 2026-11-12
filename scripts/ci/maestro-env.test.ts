import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "maestro-env.sh");

describe("maestro-env", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maestro-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (maestroEnv: string | undefined, args = ["export"]) => {
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    const result = spawnSync("bash", [script, ...args], {
      env: {
        PATH: process.env.PATH,
        GITHUB_ENV: githubEnv,
        ...(maestroEnv === undefined ? {} : { MAESTRO_ENV: maestroEnv }),
      },
      encoding: "utf8",
    });
    return { ...result, githubEnv: readFileSync(githubEnv, "utf8") };
  };

  it("masks each value before it exports the variables to the later steps", () => {
    const result = run(
      "# the test user\nMAESTRO_TP_IDENTIFIER=tp@example.test\n\r\nMAESTRO_TP_PASSWORD=p=ss word\r\nMAESTRO_EMPTY=",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "::add-mask::tp@example.test\n::add-mask::p=ss word\n",
    );
    expect(result.githubEnv).toBe(
      "MAESTRO_TP_IDENTIFIER=tp@example.test\nMAESTRO_TP_PASSWORD=p=ss word\nMAESTRO_EMPTY=\n",
    );
  });

  it("replaces each value with *** in the text files of the given folders, and leaves images alone", () => {
    const tests = join(dir, "tests");
    mkdirSync(join(tests, "flow"), { recursive: true });
    writeFileSync(
      join(tests, "flow", "commands.json"),
      '{"text":"tp@example.test"},{"text":"p.ss$1"},{"text":"tp@example.test"}',
    );
    writeFileSync(join(tests, "flow", "shot.png"), "tp@example.test");
    writeFileSync(join(dir, "report.xml"), "<failure>p.ss$1</failure>");
    const result = run(
      "MAESTRO_TP_IDENTIFIER=tp@example.test\nMAESTRO_TP_PASSWORD=p.ss$1\nMAESTRO_EMPTY=",
      ["redact", tests, join(dir, "report.xml")],
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
    expect(readFileSync(join(tests, "flow", "commands.json"), "utf8")).toBe(
      '{"text":"***"},{"text":"***"},{"text":"***"}',
    );
    expect(readFileSync(join(dir, "report.xml"), "utf8")).toBe(
      "<failure>***</failure>",
    );
    expect(readFileSync(join(tests, "flow", "shot.png"), "utf8")).toBe(
      "tp@example.test",
    );
  });

  it("does nothing without MAESTRO_ENV", () => {
    const result = run(undefined);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.githubEnv).toBe("");
  });

  it.each(["OTHER_NAME=s3cret", "MAESTRO_lower=s3cret", "MAESTRO_s3cret"])(
    "refuses %s, naming the line but not its value",
    (line) => {
      const result = run(`MAESTRO_OK=fine\n${line}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Line 2 of MAESTRO_ENV");
      expect(result.stderr + result.stdout).not.toContain("s3cret");
    },
  );
});

const workflow = (name: string) =>
  readFileSync(join(__dirname, "..", "..", ".github", "workflows", name), "utf8");
const job = (text: string, name: string) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next);
};

// The values reach only the jobs that run Maestro, before the flows, and leave Maestro's output before its upload.
describe("the Maestro variables in the shared workflows", () => {
  it.each([
    ["device-checks.yml", "maestro-android"],
    ["device-checks.yml", "maestro-ios"],
    ["ios-regression.yml", "regression"],
  ])("%s %s exports them before the flows and redacts them before the upload", (file, name) => {
    const text = job(workflow(file), name);
    const exported = text.indexOf("maestro-env.sh\" export");
    const flows = text.indexOf("run-maestro.sh");
    const redacted = text.indexOf("maestro-env.sh\" redact");
    const upload = text.indexOf("actions/upload-artifact@");
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(flows);
    expect(redacted).toBeGreaterThan(flows);
    expect(redacted).toBeLessThan(upload);
    expect(text.slice(text.lastIndexOf("- name:", redacted), redacted)).toContain("if: always()");
  });

  it("never reach the QA agent", () => {
    expect(job(workflow("device-checks.yml"), "qa-agent")).not.toContain("MAESTRO_ENV");
  });
});
