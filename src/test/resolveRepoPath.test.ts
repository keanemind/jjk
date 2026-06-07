import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getExtensionAPI } from "./extensionApi";

suite("resolveRepoPath", () => {
  let tmpDir: string;
  let resolveRepoPath: (workspaceRoot: string) => string;
  let traverseWorkspaceFolder: (
    workspaceFolder: string,
    maxDepth: number,
    repositoryScanIgnoredFolders: string[],
  ) => Promise<string[]>;
  let resolveConfiguredScanFolder: (
    root: string,
    scanPath: string,
  ) => string | undefined;

  suiteSetup(async () => {
    ({ resolveRepoPath, traverseWorkspaceFolder, resolveConfiguredScanFolder } =
      (await getExtensionAPI()).repository);
  });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jjk-test-"));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("primary workspace: .jj/repo is a directory", () => {
    const workspaceRoot = path.join(tmpDir, "primary");
    fs.mkdirSync(
      path.join(workspaceRoot, ".jj", "repo", "op_store", "operations"),
      { recursive: true },
    );

    const result = resolveRepoPath(workspaceRoot);
    assert.strictEqual(result, path.join(workspaceRoot, ".jj", "repo"));
  });

  test("secondary workspace: .jj/repo is a file with absolute path", () => {
    const primaryRepoDir = path.join(tmpDir, "primary", ".jj", "repo");
    fs.mkdirSync(path.join(primaryRepoDir, "op_store", "operations"), {
      recursive: true,
    });

    const secondaryRoot = path.join(tmpDir, "secondary");
    fs.mkdirSync(path.join(secondaryRoot, ".jj"), { recursive: true });
    fs.writeFileSync(path.join(secondaryRoot, ".jj", "repo"), primaryRepoDir);

    const result = resolveRepoPath(secondaryRoot);
    assert.strictEqual(result, primaryRepoDir);
  });

  test("secondary workspace: .jj/repo is a file with relative path", () => {
    const primaryRepoDir = path.join(tmpDir, "primary", ".jj", "repo");
    fs.mkdirSync(path.join(primaryRepoDir, "op_store", "operations"), {
      recursive: true,
    });

    const secondaryRoot = path.join(tmpDir, "secondary");
    fs.mkdirSync(path.join(secondaryRoot, ".jj"), { recursive: true });

    const relativePath = path.relative(
      path.join(secondaryRoot, ".jj"),
      primaryRepoDir,
    );
    fs.writeFileSync(path.join(secondaryRoot, ".jj", "repo"), relativePath);

    const result = resolveRepoPath(secondaryRoot);
    assert.strictEqual(
      fs.realpathSync(result),
      fs.realpathSync(primaryRepoDir),
    );
  });

  test("traverseWorkspaceFolder respects depth and ignored folders", async () => {
    fs.mkdirSync(path.join(tmpDir, "root", "one", "nested"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "root", "node_modules", "ignored"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "root", ".jj", "repo"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "root", ".git", "ignored"), {
      recursive: true,
    });

    const result = await traverseWorkspaceFolder(path.join(tmpDir, "root"), 1, [
      "node_modules",
    ]);

    assert.deepStrictEqual(result.sort(), [path.join(tmpDir, "root", "one")]);
  });

  test("traverseWorkspaceFolder includes unreadable max-depth folders", async () => {
    const unreadableFolder = path.join(tmpDir, "root", "unreadable");
    fs.mkdirSync(unreadableFolder, { recursive: true });
    fs.chmodSync(unreadableFolder, 0o000);

    try {
      const result = await traverseWorkspaceFolder(
        path.join(tmpDir, "root"),
        1,
        [],
      );

      assert.deepStrictEqual(result, [unreadableFolder]);
    } finally {
      fs.chmodSync(unreadableFolder, 0o700);
    }
  });

  test("resolveConfiguredScanFolder rejects paths outside the workspace", () => {
    const root = path.join(tmpDir, "root");

    assert.strictEqual(
      resolveConfiguredScanFolder(root, "tools/jjk"),
      path.join(root, "tools", "jjk"),
    );
    assert.strictEqual(
      resolveConfiguredScanFolder(root, "../other"),
      undefined,
    );
    assert.strictEqual(
      resolveConfiguredScanFolder(root, "tools/../../other"),
      undefined,
    );
  });
});
