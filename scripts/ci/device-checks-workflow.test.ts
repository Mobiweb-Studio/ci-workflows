import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { jobs } from "./workflow-jobs";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(
  join(root, ".github", "workflows", "device-checks.yml"),
  "utf8",
);

const blocks = jobs(workflow);

describe("device-checks.yml", () => {
  it("replaces the two workflows it was merged from", () => {
    for (const old of ["maestro-android.yml", "qa-agent.yml"]) {
      expect(existsSync(join(root, ".github", "workflows", old))).toBe(false);
    }
  });

  it("has the eight jobs, with the check names unchanged and jira-evidence last", () => {
    expect(Object.keys(blocks)).toEqual([
      "changes",
      "gate",
      "apk",
      "maestro-android",
      "maestro-ios",
      "ios-app-link",
      "qa-agent",
      "jira-evidence",
    ]);
  });

  it("is only called, and refuses an event that gives fork code the secrets", () => {
    const triggers = workflow.slice(
      workflow.indexOf("\non:\n"),
      workflow.indexOf("\njobs:\n"),
    );
    expect(triggers).toContain("  workflow_call:");
    expect(triggers).not.toMatch(/\n {2}(pull_request|push|workflow_dispatch):/);
    expect(workflow).not.toMatch(/^ *pull_request_target:/m);
    expect(workflow).not.toMatch(/^ *workflow_run:/m);
    // The first job stops any event but pull_request, so a project that changes its trigger cannot hand fork code the token.
    const guard = blocks.changes.indexOf('"$EVENT_NAME" != "pull_request"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(blocks.changes.indexOf("actions/checkout@v7"));
  });

  it("leaves the concurrency group to the caller", () => {
    expect(workflow).not.toContain("concurrency:");
  });

  it("takes the runner as an input and hard-codes none", () => {
    for (const [name, text] of Object.entries(blocks)) {
      if (name === "maestro-ios") continue;
      expect(text).toMatch(/^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/m);
    }
    expect(workflow).toMatch(
      /runner:\n {8}type: string\n {8}default: blacksmith-[a-z0-9-]+\n/,
    );
    expect(workflow.replace(/default: blacksmith-[a-z0-9-]+/, "")).not.toMatch(
      /blacksmith-[a-z0-9-]+/,
    );
  });

  it("reads no repository variable and refers to no local action", () => {
    const code = workflow.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bvars\./);
    expect(code).not.toContain("./.github/actions");
  });

  it("has no EAS path left", () => {
    expect(workflow).not.toMatch(/\beas\b|EXPO_TOKEN|DEVICE_BUILD_SOURCE/i);
  });

  it("gives the QA environment to the QA job alone", () => {
    for (const [name, text] of Object.entries(blocks)) {
      expect(/^ {4}environment: qa-agent$/m.test(text)).toBe(
        name === "qa-agent",
      );
    }
  });

  it("lets a project that declined a device check switch it off, and runs both by default", () => {
    expect(workflow).toMatch(/maestro:\n {8}type: boolean\n {8}default: true\n/);
    expect(workflow).toMatch(/qa-agent:\n {8}type: boolean\n {8}default: true\n/);
    expect(blocks.changes).toContain(
      "run_maestro: ${{ steps.maestro.outputs.run == 'true' && inputs.maestro }}",
    );
    expect(blocks.changes).toContain(
      "run_qa: ${{ steps.qa.outputs.run == 'true' && inputs.qa-agent }}",
    );
  });

  it("asks the gate once for each check", () => {
    expect(blocks.changes).toMatch(/check: maestro/);
    expect(blocks.changes).toMatch(/check: qa/);
  });

  it("waits in a gate job for the four checks before it, and for nothing else", () => {
    expect(blocks.gate).toMatch(/^ {4}needs: changes$/m);
    expect(blocks.gate).toMatch(
      /permissions:\n {6}contents: read\n {6}checks: read/,
    );
    const checkout = blocks.gate.indexOf("actions/checkout@v7");
    const wait = blocks.gate.indexOf("ci-workflows/actions/wait-for-checks@");
    expect(checkout).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(checkout);
    // The names come from an input, whose default is what the shared ci and docs-check workflows report
    // when their caller jobs are named ci and docs-check.
    expect(blocks.gate).toContain("checks: ${{ inputs.earlier-checks }}");
    const names = /earlier-checks:\n {8}type: string\n {8}default: \|\n((?: {10}.+\n)+)/.exec(
      workflow,
    );
    expect(
      names?.[1]
        .split("\n")
        .map((n) => n.trim())
        .filter(Boolean),
    ).toEqual([
      "ci / commits",
      "docs-check / docs-check",
      "ci / secret-scan",
      "ci / checks",
    ]);
    expect(blocks.gate).toContain("github-token: ${{ github.token }}");
    expect(blocks.gate).not.toMatch(/secrets\./);
  });

  it("runs the gate only when a device check runs, as the apk job does", () => {
    const condition =
      "if: ${{ needs.changes.outputs.run_maestro == 'true' || needs.changes.outputs.run_qa == 'true' }}";
    expect(blocks.gate).toContain(condition);
    expect(blocks.apk).toContain(condition);
  });

  it("starts the apk job only after the gate passed", () => {
    expect(blocks.apk).toMatch(/^ {4}needs: \[changes, gate\]$/m);
    expect(blocks.apk).not.toContain("!cancelled()");
  });

  it("makes the one APK with the device-apk action and holds no secret but the optional npm token", () => {
    expect(blocks.apk).toContain("ci-workflows/actions/device-apk@");
    expect(blocks.apk).toContain("name: device-apk\n");
    expect(blocks.apk.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.NPM_AUTH_TOKEN"]);
    expect(blocks.apk).not.toMatch(/^ {4}environment:/m);
  });

  it.each(["maestro-android", "qa-agent"])(
    "%s still runs when the gate or the apk job fails, and then fails on its own",
    (name) => {
      const text = blocks[name];
      expect(text).toMatch(/needs: \[changes, gate, apk\]/);
      expect(text).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && /m);
      // The guard is the first step after the checkout and reads the gate's and the apk job's results.
      const guard = text.indexOf(
        "needs.gate.result != 'success' || needs.apk.result != 'success'",
      );
      expect(guard).toBeGreaterThan(-1);
      expect(text.indexOf("actions/checkout@v7")).toBeLessThan(guard);
      expect(guard).toBeLessThan(text.indexOf("download-artifact"));
      expect(text).toContain("exit 1");
    },
  );

  it.each(["maestro-android", "qa-agent"])(
    "%s installs the shared APK from the build output path",
    (name) => {
      const text = blocks[name];
      expect(text).toMatch(
        /download-artifact@v8\s+with:\s+name: device-apk\n\s+path: android\/app\/build\/outputs\/apk\/release/,
      );
      expect(text).toContain("ci-workflows/actions/device-check-env@");
      expect(text).not.toContain("build-android-apk");
      expect(text).toContain(
        "adb install android/app/build/outputs/apk/release/app-release.apk",
      );
    },
  );

  it.each([
    ["maestro-android", "maestro-android"],
    ["qa-agent", "qa-agent"],
    ["qa-agent", "qa-report"],
  ])("%s keeps its %s upload for 15 days", (job, artifact) => {
    expect(blocks[job]).toMatch(
      new RegExp(`name: ${artifact}\\n[\\s\\S]*?retention-days: 15\\n`),
    );
    expect(blocks[job]).not.toMatch(/retention-days: (?!15\n)/);
  });

  it.each(["device-apk", "maestro-android", "qa-agent", "qa-report"])(
    "replaces the %s artifact of an earlier attempt when a failed job is re-run",
    (artifact) => {
      const start = workflow.indexOf(`name: ${artifact}\n`);
      expect(start).toBeGreaterThan(-1);
      const step = workflow.slice(
        start,
        workflow.indexOf("\n      - name:", start),
      );
      expect(step).toContain("overwrite: true");
    },
  );

  it("uses one major of upload-artifact", () => {
    const versions = workflow.match(/actions\/upload-artifact@v\d+/g) ?? [];
    expect(versions).toHaveLength(6);
    expect(new Set(versions)).toEqual(new Set(["actions/upload-artifact@v7"]));
  });

  it("uploads qa-report.json and qa-status.txt as qa-report after the report step", () => {
    const text = blocks["qa-agent"];
    const report = text.indexOf("- name: Write the report");
    const upload = text.indexOf("name: qa-report\n");
    expect(report).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(report);
    const step = text.slice(text.lastIndexOf("- name:", upload), upload);
    expect(step).toContain("if: ${{ !cancelled() }}");
    expect(text.slice(upload)).toMatch(
      /path: \|\n\s+qa-report\.json\n\s+qa-status\.txt\n/,
    );
  });

  describe("maestro-ios", () => {
    const text = blocks["maestro-ios"];

    it("is off unless the caller names an iOS runner, and runs on that runner alone", () => {
      expect(workflow).toMatch(/ios-runner:\n {8}type: string\n {8}default: ""\n/);
      expect(text).toContain("inputs.ios-runner != ''");
      expect(text).toContain(
        "runs-on: ${{ startsWith(inputs.ios-runner, '[') && fromJSON(inputs.ios-runner) || inputs.ios-runner }}",
      );
    });

    it("runs when Maestro runs, after the gate, and fails on its own when the gate did not pass", () => {
      expect(text).toMatch(/^ {4}needs: \[changes, gate\]$/m);
      expect(text).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && /m);
      expect(text).toContain("needs.changes.outputs.run_maestro == 'true'");
      const guard = text.indexOf("if: ${{ needs.gate.result != 'success' }}");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(text.indexOf("device-ios-app@"));
    });

    it("keeps fork code and every secret off the runner, which can be a shared Mac", () => {
      expect(text).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(text).not.toMatch(/secrets\./);
      expect(text).not.toMatch(/^ {4}environment:/m);
    });

    it("gets the app itself, repacked by fingerprint or built, for the vendor's iOS bundle id", () => {
      expect(text).not.toContain("actions/device-apk@");
      expect(text).toMatch(/device-check-env@main\n\s+with:\n\s+reference-vendor: .+\n\s+platform: ios\n/);
      expect(text).toContain("ci-workflows/actions/device-ios-app@");
      expect(text).toContain("app-source: ${{ steps.app.outputs.source }}");
    });

    it("runs the flows on a simulator of its own and deletes it whatever happened", () => {
      expect(text).toContain("MAESTRO_PLATFORM: ios");
      expect(text).toContain('ios-simulator.sh" create "$APP_PATH"');
      expect(text).toContain('scripts/ci/run-maestro.sh"');
      const last = text.slice(text.lastIndexOf("- name:"));
      expect(last).toContain("if: always()");
      expect(last).toContain('ios-simulator.sh" delete');
    });

    it("keeps its report for 15 days and the simulator app for 7, also when a flow failed", () => {
      expect(text).toMatch(/name: maestro-ios\n[\s\S]*?retention-days: 15\n/);
      expect(text).toMatch(/name: ios-simulator-app\n[\s\S]*?retention-days: 7\n/);
      expect(text.match(/if: \$\{\{ !cancelled\(\) && steps\.app\.outputs\.app-path != '' \}\}/g)).toHaveLength(2);
    });
  });

  describe("ios-app-link", () => {
    const text = blocks["ios-app-link"];

    it("comments the simulator app's link from the main runner, never from the iOS one", () => {
      expect(text).toMatch(/^ {4}needs: maestro-ios$/m);
      expect(text).toContain("if: ${{ !cancelled() && needs.maestro-ios.outputs.app-url != '' }}");
      expect(text).toMatch(/^ {4}runs-on: \$\{\{ inputs\.runner \}\}$/m);
      expect(blocks["maestro-ios"]).not.toContain("pull-requests: write");
      expect(blocks["maestro-ios"]).not.toContain("github.token");
    });

    it("keeps one comment up to date by its marker, with the token and nothing else", () => {
      expect(text).toMatch(/permissions:\n {6}contents: read\n {6}pull-requests: write\n/);
      expect(text).toContain('upsert-pr-comment.sh" ios-simulator-app "$PR_NUMBER" ios-app-comment.md');
      expect(text).toContain("APP_URL: ${{ needs.maestro-ios.outputs.app-url }}");
      expect(text).not.toMatch(/secrets\./);
    });
  });

  it("keeps the QA agent to PRs from this repository", () => {
    expect(blocks["qa-agent"]).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  describe("jira-evidence", () => {
    const text = blocks["jira-evidence"] ?? "";

    it("needs the gate, the apk job and both device jobs", () => {
      expect(text).toMatch(
        /^ {4}needs: \[changes, gate, apk, maestro-android, maestro-ios, qa-agent\]$/m,
      );
    });

    it("starts with !cancelled(), runs only when opted in, a device check ran and the PR is from this repository", () => {
      expect(text).toContain(
        "if: ${{ !cancelled() && inputs.jira-evidence && (needs.changes.outputs.run_maestro == 'true' || needs.changes.outputs.run_qa == 'true') && github.event.pull_request.head.repo.full_name == github.repository }}",
      );
    });

    it("uses the jira-evidence environment and reads only", () => {
      expect(text).toMatch(/^ {4}environment: jira-evidence$/m);
      expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
    });

    it("downloads the three artifacts of this run into one folder each, tolerating a missing one", () => {
      for (const name of ["qa-agent", "qa-report", "maestro-android", "maestro-ios"]) {
        expect(text).toMatch(
          new RegExp(
            `continue-on-error: true\\n\\s+with:\\n\\s+name: ${name}\\n\\s+path: evidence/${name}\\n`,
          ),
        );
      }
    });

    it("runs the poster in run mode with the job results, the branch and the run link", () => {
      expect(text).toContain('node "$CI_WORKFLOWS_DIR/scripts/ci/jira-evidence.mjs" run');
      for (const line of [
        "MAESTRO_RESULT: ${{ needs.maestro-android.result }}",
        "MAESTRO_IOS_RESULT: ${{ needs.maestro-ios.result }}",
        "GATE_RESULT: ${{ needs.gate.result }}",
        "APK_RESULT: ${{ needs.apk.result }}",
        "BRANCH: ${{ github.head_ref }}",
        "PR_URL: ${{ github.event.pull_request.html_url }}",
        "RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
        "EVIDENCE_DIR: evidence",
        "JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}",
      ]) {
        expect(text).toContain(line);
      }
    });

    it("gives the Jira token to the poster step alone", () => {
      expect(text.match(/secrets\./g)).toHaveLength(1);
      const poster = text.slice(text.lastIndexOf("- name:"));
      expect(poster).toContain("secrets.JIRA_API_TOKEN");
    });
  });
});
