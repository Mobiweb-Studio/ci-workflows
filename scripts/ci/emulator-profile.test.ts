import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const files = readdirSync(join(root, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => join(".github", "workflows", name));

// Without a hardware profile, avdmanager gives the AVD Android's default 320x640 screen at 160 dpi. On it a
// screen's lower buttons sit under the app's tab bar, and Maestro flows that pass on a phone time out (ICligo,
// November 2026). Every emulator gets the same phone screen.
describe("reactivecircus/android-emulator-runner", () => {
  it("is used by the Android workflows", () => {
    const users = files.filter((path) =>
      readFileSync(join(root, path), "utf8").includes("uses: reactivecircus/android-emulator-runner@"),
    );
    expect(users).toEqual(
      expect.arrayContaining([".github/workflows/android-regression.yml", ".github/workflows/device-checks.yml"]),
    );
  });

  it.each(files)("%s gives every emulator the pixel_6 phone profile", (path) => {
    const text = readFileSync(join(root, path), "utf8");
    const uses = text.split("uses: reactivecircus/android-emulator-runner@").slice(1);
    for (const rest of uses) {
      const step = rest.slice(0, rest.search(/\n +- /));
      expect(step).toMatch(/\n +profile: pixel_6\n/);
    }
  });
});
