import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getExtensionAPI } from "./extensionApi";

suite("resolveRepoPath", () => {
  let tmpDir: string;
  let resolveRepoPath: (workspaceRoot: string) => string;

  suiteSetup(async () => {
    ({ resolveRepoPath } = (await getExtensionAPI()).repository);
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
});
