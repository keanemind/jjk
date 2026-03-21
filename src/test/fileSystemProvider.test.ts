import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { WorkspaceSourceControlManager } from "../repository";
import type * as UriModule from "../uri";

const THREE_MINUTES = 1000 * 60 * 3;

suite("JJFileSystemProvider", () => {
  let workspaceSCM: WorkspaceSourceControlManager;
  let toJJUri: typeof UriModule.toJJUri;
  let repoRoot: string;
  let originalOperation: string;

  suiteSetup(async function () {
    this.timeout(30_000);

    const api = await getExtensionAPI();
    workspaceSCM = api.workspaceSCM;
    toJJUri = api.uri.toJJUri;

    if (workspaceSCM.repoSCMs.length === 0) {
      await workspaceSCM.refresh();
      for (let i = 0; i < 10 && workspaceSCM.repoSCMs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await workspaceSCM.refresh();
      }
    }

    assert.ok(workspaceSCM.repoSCMs.length > 0, "No jj repositories detected");
    repoRoot = workspaceSCM.repoSCMs[0].repositoryRoot;

    const output = await execJJPromise(
      'operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async function () {
    this.timeout(10_000);
    await execJJPromise(`operation restore ${originalOperation}`);
    await vscode.commands.executeCommand("jj.refresh");
  });

  test("cleanup retains cache entries for open jj:// documents", async function () {
    this.timeout(30_000);

    // Create a file so there's something to read at rev @
    const testFileName = "test-fsp-cleanup.txt";
    const testFilePath = path.join(repoRoot, testFileName);
    await fs.writeFile(testFilePath, "content for fsp test\n");

    // Refresh so jj snapshots the new file
    await vscode.commands.executeCommand("jj.refresh");

    // Build a jj:// URI and open it — this calls readFile() (populating the
    // cache) and adds the document to workspace.textDocuments.
    const jjUri = toJJUri(vscode.Uri.file(testFilePath), { rev: "@" });
    const doc = await vscode.workspace.openTextDocument(jjUri);
    await vscode.window.showTextDocument(doc);

    const provider = workspaceSCM.fileSystemProvider;
    const cacheKey = jjUri.toString();

    // Verify the cache was populated
    assert.ok(
      provider.cache.has(cacheKey),
      "Expected cache to contain jj:// URI after readFile",
    );

    // Backdate the cache entry so it's older than THREE_MINUTES,
    // making it eligible for eviction unless it's detected as "open"
    const entry = provider.cache.get(cacheKey)!;
    entry.timestamp = Date.now() - THREE_MINUTES - 1000;

    // Run cleanup
    provider.cleanup();

    // The document is still open, so cleanup should have retained it.
    assert.ok(
      provider.cache.has(cacheKey),
      "Cache entry for an open jj:// document should survive cleanup",
    );
  });
});
