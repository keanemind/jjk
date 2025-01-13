import * as vscode from "vscode";
import which from "which";
import path from "node:path";

import "./repository";
import { WorkspaceSourceControlManager, Show } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import { JJFileSystemProvider } from "./fileSystemProvider";
import { toJJUri } from "./uri";
import { ChangeNode, JJGraphProvider } from "./graphProvider";

export async function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "jjk" is now active!');

  const logger = vscode.window.createOutputChannel("Jujutsu Kaizen", {
    log: true,
  });
  context.subscriptions.push(logger);

  const decorationProvider = new JJDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  // Check if the jj CLI is installed
  const jjPath = await which("jj", { nothrow: true });
  if (!jjPath) {
    throw new Error("jj CLI not found");
  }

  const workspaceSCM = new WorkspaceSourceControlManager(decorationProvider);
  await workspaceSCM.refresh();
  context.subscriptions.push(workspaceSCM);

  const logProvider = new JJGraphProvider(workspaceSCM);

  vscode.workspace.onDidChangeWorkspaceFolders(
    async (e) => {
      console.log("Workspace folders changed");
      await workspaceSCM.refresh();
    },
    undefined,
    context.subscriptions,
  );

  let isInitialized = false;
  function init() {
    const fileSystemProvider = new JJFileSystemProvider(workspaceSCM);
    context.subscriptions.push(fileSystemProvider);
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider("jj", fileSystemProvider, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.new",
        async (sourceControl: vscode.SourceControl) => {
          const repository =
            workspaceSCM.getRepositoryFromSourceControl(sourceControl);
          if (!repository) {
            throw new Error("Repository not found");
          }
          const message = sourceControl.inputBox.value.trim() || undefined;
          await repository.new(message);
          sourceControl.inputBox.value = "";
          await updateResources();
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openFile",
        async (resourceState: vscode.SourceControlResourceState) => {
          const opts: vscode.TextDocumentShowOptions = {
            preserveFocus: false,
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          };
          await vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(resourceState.resourceUri.fsPath),
            {
              ...opts,
            },
          );
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.describe",
        async (resourceGroup: vscode.SourceControlResourceGroup) => {
          const message = await vscode.window.showInputBox({
            prompt: "Provide a description",
            placeHolder: "Change description here...",
          });

          if (message === undefined) {
            return;
          }

          try {
            const repository =
              workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
            if (!repository) {
              throw new Error("Repository not found");
            }
            await repository.describe(resourceGroup.id, message);
            vscode.window.showInformationMessage(
              "Description updated successfully.",
            );
            await updateResources();
          } catch (error: any) {
            vscode.window.showErrorMessage(
              `Failed to update description: ${error.message}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.squash",
        showLoading(
          async (resourceGroup: vscode.SourceControlResourceGroup) => {
            const repository =
              workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
            if (!repository) {
              throw new Error("Repository not found");
            }
            const status = await repository.status(true);
            if (status.parentChanges.length > 1) {
              vscode.window.showErrorMessage(
                `Squash failed. Revision has multiple parents.`,
              );
              return;
            }

            let message: string | undefined;
            if (
              status.workingCopy.description !== "" &&
              status.parentChanges[0].description !== ""
            ) {
              message = await vscode.window.showInputBox({
                prompt: "Provide a description",
                placeHolder: "Set description here...",
              });

              if (message === undefined) {
                return;
              } else if (message === "") {
                message = status.parentChanges[0].description;
              }
            }

            try {
              const repository =
                workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
              if (!repository) {
                throw new Error("Repository not found");
              }
              await repository.squash(message);
              vscode.window.showInformationMessage(
                "Changes successfully squashed.",
              );
              await updateResources();
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `Failed to squash: ${error.message}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.edit", async (node: ChangeNode) => {
        try {
          await workspaceSCM.repoSCMs[0].repository.edit(
            node.contextValue as string,
          );
          await updateResources();
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Failed to switch to change: ${error}`,
          );
        }
      }),
    );

    vscode.commands.registerCommand("jj.merge", async () => {
      const selectedNodes = logProvider.treeView.selection as ChangeNode[];
      if (selectedNodes.length < 2) {
        return;
      }
      const revs = selectedNodes.map((node) => node.contextValue as string);

      try {
        await workspaceSCM.repoSCMs[0].repository.new(undefined, revs);
        await updateResources();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create change: ${error}`);
      }
    });

    isInitialized = true;
  }

  async function updateResources() {
    await logProvider.treeDataProvider.refresh();

    if (workspaceSCM.repoSCMs.length > 0 && !isInitialized) {
      init();
    }

    for (const repoSCM of workspaceSCM.repoSCMs) {
      await repoSCM.repository.status();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("jj.refresh", showLoading(updateResources)),
  );

  await updateResources();
  const intervalId = setInterval(updateResources, 5_000);
  context.subscriptions.push({
    dispose() {
      clearInterval(intervalId);
    },
  });
}

function showLoading<T extends unknown[]>(
  callback: (...args: T) => Promise<void>,
) {
  return (...args: T) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl },
      async () => {
        await callback(...args);
      },
    );
}

// This method is called when your extension is deactivated
export function deactivate() {}
