import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { WorkspaceSourceControlManager } from "../repoHandle";

async function createTempJJRepo(prefix: string): Promise<string> {
  // Use realpath to resolve macOS /var -> /private/var symlinks,
  // since `jj root` returns the resolved path.
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  await execJJPromise("git init", { cwd: dir });
  return dir;
}

async function createNestedJJRepos(): Promise<{
  outerRepoPath: string;
  innerRepoPath: string;
}> {
  const outerRepoPath = await createTempJJRepo("jjk-test-nested-outer-");
  const innerRepoPath = path.join(outerRepoPath, "inner");

  await fs.mkdir(innerRepoPath, { recursive: true });
  await execJJPromise("git init", { cwd: innerRepoPath });

  return { outerRepoPath, innerRepoPath };
}

suite("Dynamic Workspace Folder Tests", () => {
  let workspaceSCM: WorkspaceSourceControlManager;

  suiteSetup(async function () {
    this.timeout(30_000);

    const api = await getExtensionAPI();
    workspaceSCM = api.workspaceSCM;

    await vscode.commands.executeCommand("jj.refresh");
    assert.ok(workspaceSCM.repoSCMs.length > 0, "No jj repositories detected");
  });

  test("adding a workspace folder with a jj repo discovers it", async function () {
    this.timeout(30_000);

    const initialRepoCount = workspaceSCM.repoSCMs.length;

    const secondRepoPath = await createTempJJRepo("jjk-test-second-");

    const countBefore = (vscode.workspace.workspaceFolders || []).length;
    const success = vscode.workspace.updateWorkspaceFolders(countBefore, 0, {
      uri: vscode.Uri.file(secondRepoPath),
    });
    assert.ok(success, "updateWorkspaceFolders returned false");
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((vscode.workspace.workspaceFolders || []).length > countBefore) {
        break;
      }
    }

    await vscode.commands.executeCommand("jj.refresh");

    assert.strictEqual(
      workspaceSCM.repoSCMs.length,
      initialRepoCount + 1,
      `Expected ${initialRepoCount + 1} repos after adding workspace folder, ` +
        `but found ${workspaceSCM.repoSCMs.length}`,
    );

    const secondRepoSCM = workspaceSCM.repoSCMs.find(
      (r) => r.repositoryRoot === secondRepoPath,
    );
    assert.ok(
      secondRepoSCM,
      `Expected to find repo with root ${secondRepoPath}, ` +
        `but found: ${workspaceSCM.repoSCMs.map((r) => r.repositoryRoot).join(", ")}`,
    );
  });

  test("workspace scan discovers nested jj repos", async function () {
    this.timeout(30_000);

    const initialRepoCount = workspaceSCM.repoSCMs.length;
    const { outerRepoPath, innerRepoPath } = await createNestedJJRepos();

    const countBefore = (vscode.workspace.workspaceFolders || []).length;
    const success = vscode.workspace.updateWorkspaceFolders(countBefore, 0, {
      uri: vscode.Uri.file(outerRepoPath),
    });
    if (!success) {
      // Single-folder mode permits the first single->multi transition but can
      // reject additional workspace folder updates.
      this.skip();
    }

    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if ((vscode.workspace.workspaceFolders || []).length > countBefore) {
        break;
      }
    }

    await vscode.commands.executeCommand("jj.refresh");

    assert.strictEqual(
      workspaceSCM.repoSCMs.length,
      initialRepoCount + 2,
      `Expected ${initialRepoCount + 2} repos after adding nested workspace, ` +
        `but found ${workspaceSCM.repoSCMs.length}`,
    );

    assert.ok(
      workspaceSCM.repoSCMs.some((r) => r.repositoryRoot === outerRepoPath),
      `Expected to find outer repo with root ${outerRepoPath}`,
    );
    assert.ok(
      workspaceSCM.repoSCMs.some((r) => r.repositoryRoot === innerRepoPath),
      `Expected to find inner repo with root ${innerRepoPath}`,
    );

    const innerFile = vscode.Uri.file(path.join(innerRepoPath, "file.txt"));
    assert.strictEqual(
      workspaceSCM.getRepositoryFromUri(innerFile)?.repositoryRoot,
      innerRepoPath,
      "Expected the deepest nested repo to own files below its root",
    );
  });

  test("removing a workspace folder removes the repo", async function () {
    this.timeout(30_000);

    // updateWorkspaceFolders for removal only works when VS Code starts in
    // multi-root mode (via .code-workspace). In single-folder mode, the
    // single→multi transition locks out further modifications.
    // This may have to do with https://github.com/microsoft/vscode/issues/69335#issuecomment-521105295
    if (!vscode.workspace.workspaceFile) {
      this.skip();
    }

    // The previous test added a folder. Wait for refresh to settle before
    // attempting removal — removal fails if a refresh is still in-flight.
    await vscode.commands.executeCommand("jj.refresh");

    const repoCountBefore = workspaceSCM.repoSCMs.length;
    const folderCountBefore = (vscode.workspace.workspaceFolders || []).length;

    // Find the folder added by the previous test (the last one)
    const lastIndex = folderCountBefore - 1;
    const folderToRemove = vscode.workspace.workspaceFolders![lastIndex];
    const reposInRemovedFolder = workspaceSCM.repoSCMs.filter((repo) => {
      const relativePath = path.relative(
        folderToRemove.uri.fsPath,
        repo.repositoryRoot,
      );
      return !relativePath.startsWith("..");
    }).length;

    const removeSuccess = vscode.workspace.updateWorkspaceFolders(lastIndex, 1);
    assert.ok(
      removeSuccess,
      `updateWorkspaceFolders (remove) returned false for folder ${folderToRemove.uri.fsPath}`,
    );

    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (
        (vscode.workspace.workspaceFolders || []).length < folderCountBefore
      ) {
        break;
      }
    }

    await vscode.commands.executeCommand("jj.refresh");

    assert.strictEqual(
      workspaceSCM.repoSCMs.length,
      repoCountBefore - reposInRemovedFolder,
      `Expected ${
        repoCountBefore - reposInRemovedFolder
      } repos after removing workspace folder, ` +
        `but found ${workspaceSCM.repoSCMs.length}`,
    );
  });
});
