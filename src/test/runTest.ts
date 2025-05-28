import path from "path";
import fs from "fs/promises";
import os from "os";

import { runTests } from "@vscode/test-electron";
import { execJJPromise } from "./utils";

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test runner script (output from esbuild)
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./runner.js");

    const testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), "jjk-test-"));

    console.log(`Creating test repo in ${testRepoPath}`);
    await execJJPromise("init --git", {
      cwd: testRepoPath,
    });

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testRepoPath],
    });
  } catch (err) {
    console.error(err);
    console.error("Failed to run tests");
    process.exit(1);
  }
}

void main();
