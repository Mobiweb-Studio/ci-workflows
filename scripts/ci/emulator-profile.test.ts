import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const files = readdirSync(join(root, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => join(".github", "workflows", name));

// Without a hardware profile, avdmanager gives the AVD Android's default 320x640 screen at 160 dpi. On it a
// screen's lower buttons sit under the app's tab bar, and Maestro flows that pass on a phone time out (ICligo,
// November 2026). Every emulator gets that phone screen unless a project asks for the small one.
describe("reactivecircus/android-emulator-runner", () => {
  it("is used by the Android workflows", () => {
    const users = files.filter((path) =>
      readFileSync(join(root, path), "utf8").includes("uses: reactivecircus/android-emulator-runner@"),
    );
    expect(users).toEqual(
      expect.arrayContaining([".github/workflows/android-regression.yml", ".github/workflows/device-checks.yml"]),
    );
  });

  it.each(files)("%s gives every emulator pixel_6, or the android-profile input whose default is pixel_6", (path) => {
    const text = readFileSync(join(root, path), "utf8");
    const uses = text.split("uses: reactivecircus/android-emulator-runner@").slice(1);
    for (const rest of uses) {
      const step = rest.slice(0, rest.search(/\n +- /));
      expect(step).toMatch(/\n +profile: (pixel_6|\$\{\{ inputs\.android-profile \}\})\n/);
    }
    if (text.includes("inputs.android-profile")) {
      expect(text).toMatch(/android-profile:\n {8}type: string\n {8}default: pixel_6\n/);
    }
  });

  // Empty is the opt-in to Android's default 320x640 screen, the size of EAS's emulator (ICligo PR #417).
  it("lets the Maestro jobs, and only them, take a smaller screen", () => {
    const device = readFileSync(join(root, ".github", "workflows", "device-checks.yml"), "utf8");
    const profiles = [...device.matchAll(/\n +profile: (.+)\n/g)].map((m) => m[1]);
    expect(profiles).toEqual(["${{ inputs.android-profile }}", "pixel_6"]);
    const regression = readFileSync(join(root, ".github", "workflows", "android-regression.yml"), "utf8");
    expect(regression).toContain("profile: ${{ inputs.android-profile }}\n");
  });
});
