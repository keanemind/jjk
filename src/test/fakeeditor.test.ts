import * as assert from "assert";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execPromise } from "./utils";
import { fakeEditorPath, initExtensionDir } from "../repository";
import * as vscode from "vscode";
import { ExecException, spawn } from "child_process";

// Helper to check if a process is running
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Just check, don't actually send a signal
    return true;
  } catch {
    return false;
  }
}

function isExecException(e: unknown): e is ExecException {
  return typeof e === "object" && e !== null && "code" in e;
}

suite("fakeeditor", () => {
  initExtensionDir(vscode.extensions.getExtension("jjk.jjk")!.extensionUri);

  test("fails when JJ_FAKEEDITOR_SIGNAL_DIR is missing", async () => {
    await assert.rejects(
      async () => execPromise(fakeEditorPath, { timeout: 6000 }),
      (err: unknown) => {
        assert.ok(
          isExecException(err),
          "Expected error to be an ExecException",
        );
        assert.ok(err.code !== undefined, "Expected error to have a code");
        assert.strictEqual(err.code, 1);
        return true;
      },
    );
  });

  test("fails when JJ_FAKEEDITOR_SIGNAL_DIR is invalid", async () => {
    await assert.rejects(
      async () =>
        execPromise(fakeEditorPath, {
          env: { ...process.env, JJ_FAKEEDITOR_SIGNAL_DIR: "/no/such/dir" },
          timeout: 6000,
        }),
      (err: unknown) => {
        assert.ok(
          isExecException(err),
          "Expected error to be an ExecException",
        );
        assert.ok(err.code !== undefined, "Expected error to have a code");
        assert.strictEqual(err.code, 1);
        return true;
      },
    );
  });

  test("exits 0 immediately if signal file exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakeeditor-"));
    const signalPath = path.join(tmp, "0");
    fs.writeFileSync(signalPath, "");
    const result = await execPromise(fakeEditorPath, {
      env: { ...process.env, JJ_FAKEEDITOR_SIGNAL_DIR: tmp },
      timeout: 6000,
    });
    assert.strictEqual(result.stderr, "");
    assert.ok(result.stdout.includes("FAKEEDITOR_OUTPUT_END"));
  });

  test("exits 0 when signal file is created after delay", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakeeditor-"));
    const signalPath = path.join(tmp, "0");
    const delayMs = 150; // 3 × POLLING_INTERVAL

    const child = spawn(fakeEditorPath, [], {
      env: { ...process.env, JJ_FAKEEDITOR_SIGNAL_DIR: tmp },
    });

    if (!child.pid) {
      throw new Error("Failed to spawn process");
    }

    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });

    const exitPromise = new Promise<number>((resolve, reject) => {
      child.on("exit", (code, signal) => {
        if (code === null) {
          reject(new Error(`Process exited from signal: ${signal}`));
        } else {
          resolve(code);
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    assert.ok(
      isProcessRunning(child.pid),
      "Process should still be running before file is created",
    );

    const beforeWrite = Date.now();
    fs.writeFileSync(signalPath, "");

    const exitCode = await exitPromise;
    const responseTime = Date.now() - beforeWrite;

    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes("FAKEEDITOR_OUTPUT_END"));
    // Should detect and respond to the file within about 2 polling intervals
    assert.ok(
      responseTime <= 150,
      `Should exit quickly after file creation (took ${responseTime}ms)`,
    );
  });

  test("exits with error after timeout when no signal file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakeeditor-"));
    const startTime = Date.now();

    await assert.rejects(
      async () =>
        execPromise(fakeEditorPath, {
          env: { ...process.env, JJ_FAKEEDITOR_SIGNAL_DIR: tmp },
          timeout: 6000,
        }),
      (err: unknown) => {
        const elapsed = Date.now() - startTime;
        assert.ok(
          isExecException(err),
          "Expected error to be an ExecException",
        );
        assert.ok(err.code !== undefined, "Expected error to have a code");
        assert.strictEqual(err.code, 1);
        assert.ok(elapsed >= 5000, "Should wait for TOTAL_TIMEOUT");
        assert.ok(elapsed < 5500, "Should not wait much longer than timeout");
        return true;
      },
    );
  });

  test("exits with error when signal directory has bad permissions", async () => {
    // Skip on Windows as chmod behaves differently
    if (process.platform === "win32") {
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakeeditor-"));
    fs.chmodSync(tmp, 0o000); // No read/write/execute for anyone

    await assert.rejects(
      async () =>
        execPromise(fakeEditorPath, {
          env: { ...process.env, JJ_FAKEEDITOR_SIGNAL_DIR: tmp },
          timeout: 6000,
        }),
      (err: unknown) => {
        assert.ok(
          isExecException(err),
          "Expected error to be an ExecException",
        );
        assert.ok(err.code !== undefined, "Expected error to have a code");
        assert.strictEqual(err.code, 1);
        return true;
      },
    );
  });
});
