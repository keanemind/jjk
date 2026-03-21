import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execJJPromise } from "./utils";
import type { WorkspaceSourceControlManager } from "../repository";

/**
 * Get the extension's test API (the return value of activate()).
 */
type ExtensionAPI = {
  workspaceSCM: WorkspaceSourceControlManager;
};

async function getExtensionAPI(): Promise<ExtensionAPI> {
  const extension = vscode.extensions.getExtension<ExtensionAPI>("jjk.jjk");
  assert.ok(extension, "Extension not found");
  if (!extension.isActive) {
    return extension.activate();
  }
  return extension.exports;
}

suite("SCM Integration Tests", () => {
  let workspaceSCM: WorkspaceSourceControlManager;
  let repoRoot: string;
  let originalOperation: string;

  suiteSetup(async function () {
    this.timeout(30_000);

    const api = await getExtensionAPI();
    workspaceSCM = api.workspaceSCM;

    // Wait for initial repo detection if needed
    if (workspaceSCM.repoSCMs.length === 0) {
      await workspaceSCM.refresh();
      for (let i = 0; i < 10 && workspaceSCM.repoSCMs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await workspaceSCM.refresh();
      }
    }

    assert.ok(workspaceSCM.repoSCMs.length > 0, "No jj repositories detected");
    repoRoot = workspaceSCM.repoSCMs[0].repositoryRoot;

    // Ensure state is fully populated
    await vscode.commands.executeCommand("jj.refresh");

    const output = await execJJPromise(
      'operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async function () {
    this.timeout(10_000);
    await execJJPromise(`operation restore ${originalOperation}`);
    // Let the extension pick up the restored state
    await vscode.commands.executeCommand("jj.refresh");
  });

  test("edit file → save → verify resource groups → jj.new → verify state", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];

    // Working copy should start clean (no file changes)
    const initialResourceStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      initialResourceStates.length,
      0,
      `Expected clean working copy, but found ${initialResourceStates.length} files: ${initialResourceStates.map((s) => s.resourceUri.fsPath).join(", ")}`,
    );

    // Create a new file in the repo
    const testFileName = "test-integration-file.txt";
    const testFilePath = path.join(repoRoot, testFileName);
    await fs.writeFile(testFilePath, "hello from integration test\n");

    // Open and save the file through VS Code (triggers file watchers)
    const doc = await vscode.workspace.openTextDocument(testFilePath);
    await vscode.window.showTextDocument(doc);
    await doc.save();

    // Refresh — this snapshots the working copy and updates SCM state.
    // jj.refresh awaits the full poll() cycle, so state is current when it resolves.
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the file shows up in the working copy resource group
    const workingCopyStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    const addedFile = workingCopyStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      addedFile,
      `Expected ${testFileName} in working copy resource group, but found: ${workingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );

    // Record the current working copy change ID
    const workingCopyChangeIdBefore = repoSCM.status?.workingCopy.changeId;
    assert.ok(workingCopyChangeIdBefore, "Expected a working copy change ID");

    // Execute jj.new via the source control.
    // The command handler calls repository.new() but does not await a refresh.
    // The file watcher will eventually trigger checkForUpdates, but we force
    // a refresh afterwards to get deterministic timing.
    await vscode.commands.executeCommand("jj.new", repoSCM.sourceControl);
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the working copy is now empty (new change has no modifications)
    const postNewWorkingCopyStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      postNewWorkingCopyStates.length,
      0,
      `Expected empty working copy after jj.new, but found ${postNewWorkingCopyStates.length} files: ${postNewWorkingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ")}`,
    );

    // Verify the working copy change ID has changed
    const workingCopyChangeIdAfter = repoSCM.status?.workingCopy.changeId;
    assert.ok(
      workingCopyChangeIdAfter,
      "Expected a working copy change ID after jj.new",
    );
    assert.notStrictEqual(
      workingCopyChangeIdAfter,
      workingCopyChangeIdBefore,
      "Working copy change ID should have changed after jj.new",
    );

    // Verify the file now shows up in a parent resource group
    assert.ok(
      repoSCM.parentResourceGroups.length > 0,
      "Expected at least one parent resource group after jj.new",
    );
    const parentStates = repoSCM.parentResourceGroups.flatMap(
      (g) => g.resourceStates,
    );
    const fileInParent = parentStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      fileInParent,
      `Expected ${testFileName} in parent resource group, but found: ${parentStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );
  });
});
