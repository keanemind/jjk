import * as assert from "assert";
import * as vscode from "vscode";
import type { WorkspaceSourceControlManager } from "../repoHandle";
import type * as UriModule from "../uri";
import type * as GraphWebviewModule from "../graphWebview";

type ExtensionAPI = {
  workspaceSCM: WorkspaceSourceControlManager;
  uri: typeof UriModule;
  repository: {
    parseRenamePaths: (
      input: string,
    ) => { fromPath: string; toPath: string } | null;
    resolveRepoPath: (workspaceRoot: string) => string;
    traverseWorkspaceFolder: (
      workspaceFolder: string,
      maxDepth: number,
      repositoryScanIgnoredFolders: string[],
    ) => Promise<string[]>;
    resolveConfiguredScanFolder: (
      root: string,
      scanPath: string,
    ) => string | undefined;
    fakeEditorPath: string;
    ImmutableError: new (message: string) => Error;
  };
  graphWebview: typeof GraphWebviewModule;
};

export async function getExtensionAPI(): Promise<ExtensionAPI> {
  const extension = vscode.extensions.getExtension<ExtensionAPI>("jjk.jjk");
  assert.ok(extension, "Extension not found");
  if (!extension.isActive) {
    return extension.activate();
  }
  return extension.exports;
}
