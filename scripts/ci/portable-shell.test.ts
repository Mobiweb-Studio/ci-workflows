import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The shared scripts and the workflows' `run:` steps also run on self-hosted Macs, whose /bin/bash is 3.2 and whose
// tools are BSD's. A bash 4 builtin or a GNU-only flag passes on ubuntu-latest, where this repository's own CI runs,
// and fails on the Mac: ICligo's sync stopped at `mapfile: command not found` with nothing copied (ICligo PR #361).
// This list holds the constructs that broke or would break there; each has a portable form.
const FORBIDDEN: [RegExp, string][] = [
  [/\b(mapfile|readarray)\b/, "bash 4: read lines with `while IFS= read -r line; do ...; done`"],
  [/\b(declare|local|typeset)\s+-[a-zA-Z]*A\b/, "bash 4 associative array: use files, or two plain arrays"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}/, "bash 4 case conversion: use `tr '[:upper:]' '[:lower:]'`"],
  [/&>>|\|&/, "bash 4 redirection: write `>> file 2>&1` or `2>&1 |`"],
  [/\bcoproc\b|\bwait -n\b/, "bash 4 builtin"],
  [/\breadlink -f\b/, "GNU readlink: use `cd \"$(dirname ...)\" && pwd`"],
  [/\bsed -i\b/, "in-place sed differs between GNU and BSD: write to a temporary file and move it"],
  [/\bgrep -[a-zA-Z]*P/, "GNU grep -P: use -E"],
  [/\bdate -d\b/, "GNU date -d: use node, or date -u +FORMAT"],
  [/\bstat -c\b/, "GNU stat -c: use wc -c or ls"],
  [/-printf\b/, "GNU find -printf: use -exec or a loop"],
  [/\bxargs -[a-zA-Z]*r\b/, "GNU xargs -r: test for empty input first"],
  [/\bbase64 -w\b/, "GNU base64 -w: pipe through tr -d '\\n'"],
  [/\bhead -n -\d|\btac\b/, "GNU head/tac: use tail -r or awk"],
  [/(^|[\s;&|])timeout \d/, "GNU coreutils timeout is not on macOS: use the step's timeout-minutes"],
];

const root = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".git")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [
  ...walk(join(root, "scripts")).filter((path) => path.endsWith(".sh")),
  ...walk(join(root, "actions")).filter((path) => path.endsWith("action.yml")),
  ...readdirSync(join(root, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => join(root, ".github", "workflows", name)),
].map((path) => relative(root, path));

// Comments may name a construct to explain why it is not used.
const code = (path: string) =>
  readFileSync(join(root, path), "utf8")
    .split("\n")
    .map((line, i) => [i + 1, line.replace(/(^|\s)#.*$/, "")] as const);

describe("shell that runs on a self-hosted Mac", () => {
  it("covers the shared scripts, the actions and the workflows", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "scripts/ci/run-maestro.sh",
        "scripts/agent-qa/run-agent.sh",
        "actions/device-apk/action.yml",
        ".github/workflows/device-checks.yml",
      ]),
    );
  });

  it.each(files)("%s uses only bash 3.2 and BSD-compatible commands", (path) => {
    const found = code(path).flatMap(([line, text]) =>
      FORBIDDEN.filter(([pattern]) => pattern.test(text)).map(([, why]) => `${path}:${line}: ${text.trim()} (${why})`),
    );
    expect(found).toEqual([]);
  });

  it("catches the constructs it lists", () => {
    const caught = (text: string) => FORBIDDEN.some(([pattern]) => pattern.test(text));
    for (const bad of [
      "mapfile -t files < <(git ls-files)",
      "declare -A seen",
      'echo "${name,,}"',
      "cmd &>> log",
      "sed -i 's/a/b/' file",
      "grep -oP '\\d+'",
      "date -d yesterday",
      "readlink -f .",
      "timeout 60 adb wait-for-device",
    ]) {
      expect(caught(bad)).toBe(true);
    }
    for (const good of ["while IFS= read -r line; do", "sort -V", 'echo "${name}"', "timeout-minutes: 5"]) {
      expect(caught(good)).toBe(false);
    }
  });
});
