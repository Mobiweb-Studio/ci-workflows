import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = (name: string) =>
  readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", name),
    "utf8",
  );

/** The text of one top-level job, up to the next job or the end of the file. */
const job = (text: string, name: string) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`no job named ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("release job in the release workflow", () => {
  const text = workflow("release.yml");
  const release = job(text, "release");

  it("starts only from a release created by release-please, and only once opted in", () => {
    expect(text).toMatch(/if: \$\{\{ inputs\.enabled \}\}/);
    expect(text.slice(text.indexOf("\njobs:"))).not.toMatch(/vars\./);
    expect(release).toMatch(
      /needs\.release-please\.outputs\.release_created == 'true'/,
    );
  });

  it("passes the release-please outputs on to the release job", () => {
    const producer = job(text, "release-please");

    expect(producer).toMatch(/id: release/);
    expect(producer).toMatch(
      /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/,
    );
    expect(producer).toMatch(
      /tag_name: \$\{\{ steps\.release\.outputs\.tag_name \}\}/,
    );
  });

  it("is only called: it has no trigger of its own, so the caller decides when it runs", () => {
    expect(text).toMatch(/\non:\n\s+workflow_call:/);
    expect(text).not.toMatch(
      /\n\s+(push|workflow_dispatch|schedule|pull_request):/,
    );
  });

  it("takes the release-please token as the one declared secret and holds no credential of its own", () => {
    expect(text).toMatch(/secrets:\n\s+RELEASE_PLEASE_TOKEN:\n\s+required: false/);
  });

  it("builds the tagged commit, not the head of main", () => {
    expect(release).toMatch(
      /ref: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/,
    );
  });

  it("reads the token from the protected environment and holds no credential", () => {
    expect(release).toMatch(/environment: production-release/);
    expect(release).toMatch(/secrets\.EXPO_TOKEN/);
    expect(release).not.toMatch(/EXPO_TOKEN: ["']?[A-Za-z0-9_-]{20,}/);
  });

  it("gives the job read-only contents, though the caller grants write for release-please", () => {
    expect(release).toMatch(/permissions:\s*\n\s+contents: read/);
  });

  it("builds production, then submits each platform and waits for it", () => {
    expect(release).toMatch(/eas build .*--profile production/);
    expect(release).not.toMatch(/--auto-submit/);
    expect(release).toMatch(
      /eas submit --platform android .*--profile production .*--wait/,
    );
    expect(release).toMatch(
      /eas submit --platform ios .*--profile production .*--wait/,
    );
  });

  it("never names a store production track or review step", () => {
    expect(release).not.toMatch(/--track|releaseStatus|rollout/);
  });
});

describe("OTA hotfix workflow", () => {
  const text = workflow("hotfix-ota.yml");
  const lines = text.split("\n");
  const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
  const publish = at(/eas update/);

  /** The shell script of the step with this name, indented as in the YAML removed. */
  const stepScript = (name: string) => {
    const step = at(new RegExp(`- name: ${name}`));
    const run = lines.findIndex(
      (line, i) => i > step && /^\s+run: \|$/.test(line),
    );
    const body: string[] = [];
    for (const line of lines.slice(run + 1)) {
      if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
      body.push(line.slice(10));
    }
    return body.join("\n");
  };

  it("is only called, and holds the token in the protected environment the caller's dispatch reaches", () => {
    expect(text).toMatch(/\non:\n\s+workflow_call:/);
    expect(text).not.toMatch(
      /\n\s+(push|schedule|pull_request|workflow_dispatch):/,
    );
    expect(text).toMatch(/environment: production-release/);
  });

  it("publishes the ref it was given, not the head of main", () => {
    expect(text).toMatch(/ref: \$\{\{ inputs\.ref \}\}/);
    expect(text).toMatch(/fetch-depth: 0/);
  });

  it("sets the token only after the install and the tests", () => {
    const token = at(/token: \$\{\{ secrets\.EXPO_TOKEN \}\}/);

    expect(text).not.toMatch(/\n {4}env:\n\s+EXPO_TOKEN/);
    expect(at(/pnpm install/)).toBeLessThan(token);
    expect(at(/pnpm test/)).toBeLessThan(token);
  });

  it("runs the type check and tests on the ref before publishing", () => {
    expect(at(/pnpm typecheck/)).toBeGreaterThan(-1);
    expect(at(/pnpm typecheck/)).toBeLessThan(publish);
    expect(at(/pnpm test/)).toBeGreaterThan(-1);
    expect(at(/pnpm test/)).toBeLessThan(publish);
  });

  it("refuses when the native fingerprint is not the one of the build live in each store", () => {
    const check = at(/fingerprint:generate/);

    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(publish);
    expect(text).toMatch(/build:list .*--fingerprint-hash/);
    expect(text).toMatch(/inputs\.android-build-id/);
    expect(text).toMatch(/inputs\.ios-build-id/);
  });

  it("publishes to the production channel with the message", () => {
    expect(lines[publish]).toMatch(/--channel production/);
    expect(lines[publish]).toMatch(/--message "\$MESSAGE"/);
  });

  // Sentry matches an update's source maps to it by an id built into the bundle, so the update
  // must publish the bundle that was exported with them, not bundle again.
  it("exports the bundle with source maps and publishes that export", () => {
    const exported = at(/expo export --dump-sourcemap/);

    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(publish);
    expect(lines[publish]).toMatch(/--skip-bundler/);
  });

  it("uploads the source maps after publishing, from the locked package and not through npx", () => {
    const upload = at(/sentry-expo-upload-sourcemaps/);

    expect(upload).toBeGreaterThan(publish);
    expect(lines[upload]).toMatch(/pnpm exec /);
    expect(lines[upload]).not.toMatch(/npx/);
  });

  it("gives the Sentry token to the upload step only, after the install and the tests", () => {
    const token = at(
      /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/,
    );

    expect(token).toBeGreaterThan(at(/pnpm test/));
    expect(token).toBeGreaterThan(publish);
    expect(text).not.toMatch(/\n {4}env:\n\s+SENTRY_AUTH_TOKEN/);
  });

  describe("the upload step's skip rules, run against a real vendor.json", () => {
    const script = stepScript("Upload the source maps to Sentry");
    const run = (vendor: object, token: string) => {
      const dir = mkdtempSync(join(tmpdir(), "hotfix-upload-"));
      mkdirSync(join(dir, "vendors", "default"), { recursive: true });
      writeFileSync(
        join(dir, "vendors", "default", "vendor.json"),
        JSON.stringify(vendor),
      );
      return execFileSync("bash", ["-c", script], {
        cwd: dir,
        env: { ...process.env, SENTRY_AUTH_TOKEN: token },
        encoding: "utf8",
      });
    };

    it("skips quietly when the vendor has no sentry section, even with a token", () => {
      const output = run({}, "a-token");

      expect(output).toMatch(/skipping the source map upload/i);
      expect(output).not.toMatch(/::warning::/);
    });

    it("warns, and still succeeds, when the vendor has a sentry section but there is no token", () => {
      const output = run({ sentry: { organization: "o", project: "p" } }, "");

      expect(output).toMatch(/::warning::.*skipping the source map upload/i);
    });
  });

  it("warns instead of failing when the upload itself fails", () => {
    const script = stepScript("Upload the source maps to Sentry");

    expect(script).toMatch(
      /if ! pnpm exec sentry-expo-upload-sourcemaps dist; then\n\s+echo "::warning::/,
    );
  });

  it("skips the upload, and still succeeds, when there is no Sentry token", () => {
    const script = stepScript("Upload the source maps to Sentry");

    const output = execFileSync("bash", ["-c", script], {
      env: { ...process.env, SENTRY_AUTH_TOKEN: "" },
      encoding: "utf8",
    });

    expect(output).toMatch(/skipping the source map upload/i);
  });

  it("passes every input to the shell only through an environment variable or a with: value", () => {
    const uses = lines.filter((line) => line.includes("${{ inputs."));

    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(
        /^\s+(runs-on|ref|LIVE_TAG|ANDROID_BUILD_ID|IOS_BUILD_ID|MESSAGE): \$\{\{ inputs\.[\w-]+ \}\}$/,
      );
    }
  });

  describe("the ref guard, run against a real repository", () => {
    const script = stepScript("Require a ref built on the live release");
    // A git hook (pre-push runs these tests) exports GIT_DIR and friends, absolute in a worktree.
    // Left in place, they point every command here at the real repository instead of the
    // throwaway one, so drop them, and ignore the user's own git config too.
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((key) => key.startsWith("GIT_"))
          .map((key) => [key, undefined]),
      ),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();

    /** v1.0.0 is live; main has moved on by one commit since. */
    const repo = () => {
      const cwd = mkdtempSync(join(tmpdir(), "hotfix-guard-"));
      git(cwd, "init", "-q", "-b", "main");
      git(cwd, "config", "user.email", "ci@example.com");
      git(cwd, "config", "user.name", "ci");
      git(cwd, "commit", "-q", "--allow-empty", "-m", "release");
      git(cwd, "tag", "v1.0.0");
      git(cwd, "commit", "-q", "--allow-empty", "-m", "unreleased feature");
      git(cwd, "update-ref", "refs/remotes/origin/main", "main");
      return cwd;
    };

    const run = (cwd: string, liveTag = "v1.0.0") => {
      try {
        execFileSync("bash", ["-eo", "pipefail", "-c", script], {
          cwd,
          env: { ...env, LIVE_TAG: liveTag },
          stdio: "pipe",
        });
        return "accepted";
      } catch {
        return "refused";
      }
    };

    it("accepts the live release tag itself", () => {
      const cwd = repo();
      git(cwd, "checkout", "-q", "v1.0.0");

      expect(run(cwd)).toBe("accepted");
    });

    it("accepts a branch cut from the tag with the fix cherry-picked", () => {
      const cwd = repo();
      git(cwd, "checkout", "-q", "-b", "hotfix", "v1.0.0");
      git(cwd, "commit", "-q", "--allow-empty", "-m", "the fix");

      expect(run(cwd)).toBe("accepted");
    });

    it("refuses main, which carries unreleased commits", () => {
      const cwd = repo();

      expect(run(cwd)).toBe("refused");
    });

    it("refuses a branch cut from main", () => {
      const cwd = repo();
      git(cwd, "checkout", "-q", "-b", "feature", "main");
      git(cwd, "commit", "-q", "--allow-empty", "-m", "more work");

      expect(run(cwd)).toBe("refused");
    });

    it("refuses a ref that does not contain the live tag", () => {
      const cwd = repo();
      git(cwd, "checkout", "-q", "--orphan", "other");
      git(cwd, "commit", "-q", "--allow-empty", "-m", "unrelated");

      expect(run(cwd)).toBe("refused");
    });

    it("refuses a live tag that is not a release tag or does not exist", () => {
      const cwd = repo();
      git(cwd, "checkout", "-q", "v1.0.0");

      expect(run(cwd, "main")).toBe("refused");
      expect(run(cwd, "v9.9.9")).toBe("refused");
    });
  });
});
