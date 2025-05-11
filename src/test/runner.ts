import path from "path";
import Mocha from "mocha";

export function run(
  testsRoot: string, // This will be out/test/runner.js
  cb: (error: unknown, failures?: number) => void,
): void {
  const mocha = new Mocha({
    ui: "tdd",
    timeout: 30_000,
  });

  // Path to the bundled file containing all tests
  const allTestsBundlePath = path.resolve(
    path.dirname(testsRoot),
    "all-tests.js",
  );

  mocha.addFile(allTestsBundlePath);

  try {
    mocha.run((failures) => {
      cb(null, failures);
    });
  } catch (err) {
    console.error("Error running Mocha tests:", err);
    cb(err);
  }
}
