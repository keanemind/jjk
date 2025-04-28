import * as assert from "assert";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from "vscode";
import { execPromise } from "../utils";
// import * as myExtension from '../../extension';

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  let originalOperation: string;
  suiteSetup(async () => {
    // Wait for a refresh so the repo is detected
    await new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });

    const output = await execPromise(
      'jj operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async () => {
    await execPromise(`jj operation restore ${originalOperation}`);
  });

  test("Sample test", () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

  test("Sanity check: `jj status` succeeds", async () => {
    await assert.doesNotReject(execPromise("jj status"));
  });
});
