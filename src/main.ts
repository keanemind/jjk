import * as vscode from "vscode";
import which from "which";
import path from "node:path";

import "./repository";
import { Repositories } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import { JJFileSystemProvider } from "./fileSystemProvider";
import { toJJUri } from "./uri";

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
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  // Check if the jj CLI is installed
  const jjPath = await which("jj", { nothrow: true });
  if (!jjPath) {
    throw new Error("jj CLI not found");
  }

  const repositories = new Repositories();
  await repositories.init();

  vscode.workspace.onDidChangeWorkspaceFolders(
    async (e) => {
      console.log("Workspace folders changed");
      await repositories.init();
    },
    undefined,
    context.subscriptions
  );

  let jjSCM: vscode.SourceControl;
  let workingCopyResourceGroup: vscode.SourceControlResourceGroup | undefined;

  function init() {
    const fileSystemProvider = new JJFileSystemProvider(repositories);
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider("jj", fileSystemProvider, {
        isReadonly: true,
        isCaseSensitive: true,
      })
    );

    jjSCM = vscode.scm.createSourceControl("jj", "Jujutsu");
    context.subscriptions.push(jjSCM);

    workingCopyResourceGroup = jjSCM.createResourceGroup(
      "workingCopy",
      "Working Copy"
    );

    context.subscriptions.push(workingCopyResourceGroup);

    // Set up the SourceControlInputBox
    jjSCM.inputBox.placeholder = "Change commit message (Ctrl+Enter)";

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.describe", async () => {
        const newCommitMessage = jjSCM!.inputBox.value.trim();
        if (!newCommitMessage) {
          vscode.window.showErrorMessage("Commit message cannot be empty.");
          return;
        }

        try {
          logger.appendLine(
            `Running jj describe with message: "${newCommitMessage}"`
          );
          await repositories.repos[0].describeCommit(newCommitMessage);
          jjSCM!.inputBox.value = "";
          vscode.window.showInformationMessage(
            "Commit message updated successfully."
          );
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Failed to update commit message: ${error.message}`
          );
        }
      })
    );

    // Link the acceptInputCommand to the SourceControl instance
    jjSCM.acceptInputCommand = {
      command: "jj.describe",
      title: "Change Commit Message",
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.new", async () => {
        await repositories.repos[0].createCommit();
      })
    );
  }

  let parentResourceGroups: vscode.SourceControlResourceGroup[] = [];

  async function updateResources() {
    if (repositories.repos.length > 0) {
      if (!jjSCM) {
        init();
      }

      const status = await repositories.repos[0].status();
      decorationProvider.onDidRunStatus(status);
      workingCopyResourceGroup!.resourceStates = status.fileStatuses.map(
        (fileStatus) => {
          return {
            resourceUri: vscode.Uri.file(fileStatus.path),
            decorations: {
              strikeThrough: fileStatus.type === "D",
              tooltip: path.basename(fileStatus.file),
            },
            command: {
              title: "Open",
              command: "vscode.diff",
              arguments: [
                toJJUri(
                  vscode.Uri.file(fileStatus.path),
                  status.parentChanges[0].changeId
                ),
                vscode.Uri.file(fileStatus.path),
                fileStatus.file + " (Working Copy)",
              ],
            },
          };
        }
      );

      for (const group of parentResourceGroups){
        group.dispose();
      }
      parentResourceGroups = [];

      for (const parentCommit of status.parentChanges) {
        let parentCommitResourceGroup: vscode.SourceControlResourceGroup | undefined;
        parentCommitResourceGroup = jjSCM.createResourceGroup(
          parentCommit.changeId,
          parentCommit.description ? `Parent Commit | ${parentCommit.changeId}: ${parentCommit.description}`
          : `Parent Commit | ${parentCommit.changeId} (no description set)`
        );
        parentResourceGroups.push(parentCommitResourceGroup);
        
        context.subscriptions.push(parentCommitResourceGroup);


        const parentStatuses = await repositories.repos[0].show(parentCommit.changeId);

        parentCommitResourceGroup!.resourceStates = parentStatuses.map(
          (parentStatus) => {
            return {
              resourceUri: toJJUri(
                vscode.Uri.file(parentStatus.path),
                parentCommit.changeId
              ),
              decorations: {
                strikeThrough: parentStatus.type === "D",
                tooltip: path.basename(parentStatus.file),
              },
              command: {
                title: "Open",
                command: "vscode.diff",
                arguments: [
                  toJJUri(
                    vscode.Uri.file(parentStatus.path),
                    parentCommit.changeId
                  ),
                  vscode.Uri.file(parentStatus.path),
                  parentStatus.file + " (Parent Commit)",
                ],
              },
            };
          }
        );

        decorationProvider.addDecorators(
          parentStatuses.map((status) => toJJUri(vscode.Uri.file(status.path), parentCommit.changeId)),
          parentStatuses
        );
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("jj.refresh", updateResources)
  );

  await updateResources();
  const intervalId = setInterval(updateResources, 5_000);
  context.subscriptions.push({
    dispose() {
      clearInterval(intervalId);
    },
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
