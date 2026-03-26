import * as assert from "assert";
import * as vscode from "vscode";
import type * as RepositoryModule from "../repository";
import type { WorkspaceSourceControlManager } from "../repository";
import type * as UriModule from "../uri";
import type * as GraphWebviewModule from "../graphWebview";

type ExtensionAPI = {
  workspaceSCM: WorkspaceSourceControlManager;
  uri: typeof UriModule;
  repository: typeof RepositoryModule;
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
