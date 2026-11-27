import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const script = join(__dirname, "install-maestro.sh");

// A stand-in for curl: logs the URL and writes a zip holding maestro/bin/maestro, as a Maestro release does, or
// fails when CURL_FAIL is set.
const curlStub = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
echo "$url" >> "$CALL_LOG"
[ -n "$CURL_FAIL" ] && exit 22
src=$(mktemp -d)
mkdir -p "$src/maestro/bin"
printf '#!/bin/sh\\necho maestro\\n' > "$src/maestro/bin/maestro"
chmod +x "$src/maestro/bin/maestro"
(cd "$src" && zip -qr "$out" maestro)
rm -rf "$src"
`;

describe("install-maestro.sh", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-maestro-"));
    for (const sub of ["bin", "temp", "home"]) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, "bin", "curl"), curlStub);
    chmodSync(join(dir, "bin", "curl"), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string> = {}) => {
    const callLog = join(dir, "calls.log");
    const githubPath = join(dir, "github_path");
    writeFileSync(callLog, "");
    writeFileSync(githubPath, "");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: join(dir, "home"),
        RUNNER_TEMP: join(dir, "temp"),
        GITHUB_PATH: githubPath,
        CALL_LOG: callLog,
        MAESTRO_VERSION: "2.6.1",
        ...env,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      urls: readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean),
      path: readFileSync(githubPath, "utf8"),
    };
  };

  it("downloads the asked version into RUNNER_TEMP and puts it on the job's PATH", () => {
    const { status, urls, path } = run();
    expect(status).toBe(0);
    expect(urls).toEqual(["https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.6.1/maestro.zip"]);
    const bin = join(dir, "temp", "maestro-cli", "maestro", "bin");
    expect(path).toBe(`${bin}\n`);
    expect(existsSync(join(bin, "maestro"))).toBe(true);
    expect(existsSync(join(dir, "temp", "maestro.zip"))).toBe(false);
  });

  it("leaves the runner's home alone: no ~/.maestro and no shell profile", () => {
    expect(run().status).toBe(0);
    expect(readdirSync(join(dir, "home"))).toEqual([]);
  });

  it("names the version when the download fails", () => {
    const { status, stderr, path } = run({ CURL_FAIL: "1" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("Could not download Maestro 2.6.1");
    expect(path).toBe("");
  });

  it("refuses to run without a version", () => {
    expect(run({ MAESTRO_VERSION: "" }).status).not.toBe(0);
  });
});

describe("the Maestro jobs", () => {
  const workflows = ["device-checks.yml", "android-regression.yml", "ios-regression.yml"];

  it.each(workflows)("%s installs Maestro with install-maestro.sh at the maestro-version input", (name) => {
    const text = readFileSync(join(root, ".github", "workflows", name), "utf8");
    expect(text).not.toContain("get.maestro.mobile.dev");
    expect(text).toContain('run: bash "$CI_WORKFLOWS_DIR/scripts/ci/install-maestro.sh"');
    expect(text).not.toMatch(/MAESTRO_VERSION: \d/);
    expect(text).toMatch(/maestro-version:\n {8}type: string\n {8}default: 2\.10\.0\n/);
  });
});
