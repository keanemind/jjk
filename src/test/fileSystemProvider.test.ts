import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { WorkspaceSourceControlManager } from "../repoHandle";
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

  async function readJJText(
    filePath: string,
    params: Parameters<typeof UriModule.toJJUri>[1],
  ): Promise<string> {
    const uri = toJJUri(vscode.Uri.file(filePath), params);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString();
  }

  // Builds a chain @-- (adds file=v1) -> @- (modifies file to v2) -> @, and
  // returns the change ids of the two ancestor commits.
  async function buildChangeChain(
    fileName: string,
    v1: string,
    v2: string,
  ): Promise<{ filePath: string; changeAdd: string; changeModify: string }> {
    const filePath = path.join(repoRoot, fileName);
    const opts = { cwd: repoRoot };

    await execJJPromise('new -m "fsp-add"', opts);
    await fs.writeFile(filePath, v1);
    await execJJPromise('new -m "fsp-modify"', opts);
    await fs.writeFile(filePath, v2);
    await execJJPromise('new -m "fsp-tip"', opts);

    const changeAdd = (
      await execJJPromise('log -r @-- --no-graph -T "change_id"', opts)
    ).stdout.trim();
    const changeModify = (
      await execJJPromise('log -r @- --no-graph -T "change_id"', opts)
    ).stdout.trim();
    return { filePath, changeAdd, changeModify };
  }

  test("diffOriginalRev reads the file content from before the change", async function () {
    this.timeout(30_000);

    const { filePath, changeModify } = await buildChangeChain(
      "test-fsp-difforig.txt",
      "v1\n",
      "v2\n",
    );

    assert.strictEqual(
      await readJJText(filePath, { diffOriginalRev: changeModify }),
      "v1\n",
      "Original side should be the content before the change",
    );
    assert.strictEqual(
      await readJJText(filePath, { rev: changeModify }),
      "v2\n",
      "Modified side should be the content at the change",
    );
  });

  test("diffOriginalRev is empty when the file did not exist before the change", async function () {
    this.timeout(30_000);

    const { filePath, changeAdd } = await buildChangeChain(
      "test-fsp-added.txt",
      "v1\n",
      "v2\n",
    );

    assert.strictEqual(
      await readJJText(filePath, { diffOriginalRev: changeAdd }),
      "",
      "A file added by the change has no original content",
    );
  });

  test("openChangeFileDiff reveals the requested line", async function () {
    this.timeout(30_000);

    const { filePath, changeModify } = await buildChangeChain(
      "test-fsp-scroll.txt",
      "a\nb\nc\nd\ne\nf\n",
      "a\nb\nC\nd\ne\nf\n",
    );

    const targetLine = 3;
    await vscode.commands.executeCommand(
      "jj.openChangeFileDiff",
      changeModify,
      filePath,
      targetLine,
    );

    let editor: vscode.TextEditor | undefined;
    for (let i = 0; i < 20; i++) {
      editor = vscode.window.activeTextEditor;
      if (editor && editor.selection.active.line === targetLine) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(editor, "Expected an active diff editor");
    assert.strictEqual(
      editor.selection.active.line,
      targetLine,
      "Diff should be scrolled to the requested line",
    );

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
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
