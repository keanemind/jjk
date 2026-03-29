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

  test("diffOriginalRev reads directly from the original revision first", async function () {
    const testFilePath = path.join(repoRoot, "deleted-file.txt");
    const expected = Buffer.from("before delete\n");
    let getDiffOriginalCalls = 0;

    // Deleted files should resolve through `<rev>-` immediately. If this test
    // reaches getDiffOriginal(), the provider skipped the cheap path.
    const repository = {
      readFile(rev: string, filepath: string): Promise<Uint8Array> {
        assert.strictEqual(rev, "@-");
        assert.strictEqual(filepath, testFilePath);
        return Promise.resolve(expected);
      },
      getDiffOriginal(): Promise<Buffer | undefined> {
        getDiffOriginalCalls += 1;
        return Promise.resolve(Buffer.from("unexpected\n"));
      },
    };

    const provider = workspaceSCM.fileSystemProvider;
    const originalGetRepositoryFromUri = workspaceSCM.getRepositoryFromUri.bind(
      workspaceSCM,
    );

    workspaceSCM.getRepositoryFromUri = () => repository as never;
    try {
      const data = await provider.readFile(
        toJJUri(vscode.Uri.file(testFilePath), { diffOriginalRev: "@" }),
      );
      assert.deepStrictEqual(Buffer.from(data), expected);
      assert.strictEqual(
        getDiffOriginalCalls,
        0,
        "Expected direct readFile() to satisfy deleted-file reads",
      );
    } finally {
      workspaceSCM.getRepositoryFromUri = originalGetRepositoryFromUri;
    }
  });

  test("diffOriginalRev reads renamed content from the parent commit", async function () {
    const renamedFilePath = path.join(repoRoot, "renamed-file.txt");
    const originalFilePath = path.join(repoRoot, "old-name.txt");
    const expected = Buffer.from("before rename\n");
    let getDiffOriginalCalls = 0;
    const readCalls: { rev: string; filepath: string }[] = [];

    // Renames cannot be read from `<rev>-` at the new path, so the provider
    // must use `show(rev)` metadata to map back to the old path in the parent.
    const repository = {
      repositoryRoot: repoRoot,
      readFile(rev: string, filepath: string): Promise<Uint8Array> {
        readCalls.push({ rev, filepath });
        if (rev === "@-") {
          return Promise.reject(new Error("No such path"));
        }
        assert.strictEqual(rev, "parent-1");
        assert.strictEqual(filepath, originalFilePath);
        return Promise.resolve(expected);
      },
      show() {
        return Promise.resolve({
          change: { parentCommitIds: ["parent-1"] },
          fileStatuses: [
            {
              path: renamedFilePath,
              renamedFrom: "old-name.txt",
            },
          ],
        });
      },
      getDiffOriginal(rev: string, filepath: string): Promise<Buffer> {
        getDiffOriginalCalls += 1;
        assert.strictEqual(rev, "@");
        assert.strictEqual(filepath, renamedFilePath);
        return Promise.resolve(expected);
      },
    };

    const provider = workspaceSCM.fileSystemProvider;
    const originalGetRepositoryFromUri = workspaceSCM.getRepositoryFromUri.bind(
      workspaceSCM,
    );

    workspaceSCM.getRepositoryFromUri = () => repository as never;
    try {
      const data = await provider.readFile(
        toJJUri(vscode.Uri.file(renamedFilePath), { diffOriginalRev: "@" }),
      );
      assert.deepStrictEqual(Buffer.from(data), expected);
      assert.deepStrictEqual(readCalls, [
        { rev: "@-", filepath: renamedFilePath },
        { rev: "parent-1", filepath: originalFilePath },
      ]);
      assert.strictEqual(getDiffOriginalCalls, 0);
    } finally {
      workspaceSCM.getRepositoryFromUri = originalGetRepositoryFromUri;
    }
  });

  test(
    "diffOriginalRev resolves renamed content across multiple parents",
    async function () {
      const renamedFilePath = path.join(repoRoot, "renamed-merge-file.txt");
      const originalFilePath = path.join(repoRoot, "a.txt");
      const expected = Buffer.from("before rename\n");
      let getDiffOriginalCalls = 0;
      const readCalls: { rev: string; filepath: string }[] = [];

      // In merge commits, `@-` can be ambiguous. The provider should still
      // resolve the rename by probing each concrete parent commit from
      // `show(rev)` before falling back to diff extraction.
      const repository = {
        repositoryRoot: repoRoot,
        readFile(rev: string, filepath: string): Promise<Uint8Array> {
          readCalls.push({ rev, filepath });
          if (rev === "@-") {
            return Promise.reject(
              new Error("Revset `@-` resolved to more than one revision"),
            );
          }
          if (rev === "parent-1") {
            return Promise.reject(new Error("No such path"));
          }
          assert.strictEqual(rev, "parent-2");
          assert.strictEqual(filepath, originalFilePath);
          return Promise.resolve(expected);
        },
        show() {
          return Promise.resolve({
            change: { parentCommitIds: ["parent-1", "parent-2"] },
            fileStatuses: [
              {
                path: renamedFilePath,
                renamedFrom: "a.txt",
              },
            ],
          });
        },
        getDiffOriginal(rev: string, filepath: string): Promise<Buffer> {
          getDiffOriginalCalls += 1;
          assert.strictEqual(rev, "@");
          assert.strictEqual(filepath, renamedFilePath);
          return Promise.resolve(expected);
        },
      };

      const provider = workspaceSCM.fileSystemProvider;
      const originalGetRepositoryFromUri =
        workspaceSCM.getRepositoryFromUri.bind(workspaceSCM);

      workspaceSCM.getRepositoryFromUri = () => repository as never;
      try {
        const data = await provider.readFile(
          toJJUri(vscode.Uri.file(renamedFilePath), { diffOriginalRev: "@" }),
        );
        assert.deepStrictEqual(Buffer.from(data), expected);
        assert.deepStrictEqual(readCalls, [
          { rev: "@-", filepath: renamedFilePath },
          { rev: "parent-1", filepath: originalFilePath },
          { rev: "parent-2", filepath: originalFilePath },
        ]);
        assert.strictEqual(getDiffOriginalCalls, 0);
      } finally {
        workspaceSCM.getRepositoryFromUri = originalGetRepositoryFromUri;
      }
    },
  );
});
