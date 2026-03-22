import path from "path";
import fs from "fs/promises";
import os from "os";

import { runTests } from "@vscode/test-electron";
import { execJJPromise } from "./utils";

async function createJJRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await execJJPromise("git init", { cwd: dir });
  return dir;
}

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./runner.js");

    // Run 1: single-folder mode
    {
      const testRepoPath = await createJJRepo("jjk-test-single-");
      const userDataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "jjk-test-userdata-"),
      );

      console.log(
        `\n=== Run 1: single-folder mode ===\nRepo: ${testRepoPath}\n`,
      );
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [testRepoPath, `--user-data-dir=${userDataDir}`],
      });
    }

    // Run 2: multi-folder mode
    {
      const testRepoPath = await createJJRepo("jjk-test-multi-");
      // Second folder is NOT a jj repo, so existing tests still see 1 repoSCM
      const extraFolder = await fs.mkdtemp(
        path.join(os.tmpdir(), "jjk-test-extra-"),
      );
      const userDataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "jjk-test-userdata-"),
      );

      // .code-workspace file lives in the extra folder, not inside the jj repo
      const workspaceFile = path.join(extraFolder, "test.code-workspace");
      await fs.writeFile(
        workspaceFile,
        JSON.stringify({
          folders: [{ path: testRepoPath }, { path: extraFolder }],
        }),
      );

      console.log(
        `\n=== Run 2: multi-folder mode ===\nRepo: ${testRepoPath}\nExtra: ${extraFolder}\nWorkspace: ${workspaceFile}\n`,
      );
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [workspaceFile, `--user-data-dir=${userDataDir}`],
      });
    }
  } catch (err) {
    console.error(err);
    console.error("Failed to run tests");
    process.exit(1);
  }
}

void main();
