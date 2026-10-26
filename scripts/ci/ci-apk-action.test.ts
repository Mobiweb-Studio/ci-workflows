import { readFileSync } from "node:fs";
import { join } from "node:path";

const action = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "actions",
    "build-android-apk",
    "action.yml",
  ),
  "utf8",
);

// The CI APK is built with no APP_ENV, so it would report as production once a project's
// reference vendor has a Sentry DSN, and it has no upload token to give the Sentry plugin.
describe("the CI device-check APK build", () => {
  it("switches crash reporting off for every later step", () => {
    expect(action).toMatch(/echo "CRASH_REPORTING=off" >> "\$GITHUB_ENV"/);
  });

  it("switches the source map upload off for every later step", () => {
    expect(action).toMatch(
      /echo "SENTRY_DISABLE_AUTO_UPLOAD=true" >> "\$GITHUB_ENV"/,
    );
  });
});
