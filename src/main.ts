import * as vscode from "vscode";
import which from "which";
import path from "node:path";

import "./repository";
import { Repositories, Show } from "./repository";
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

    workingCopyResourceGroup = jjSCM.createResourceGroup("@", "Working Copy");
    context.subscriptions.push(workingCopyResourceGroup);

    // Set up the SourceControlInputBox
    jjSCM.inputBox.placeholder = "Describe new change (Ctrl+Enter)";

    // Link the acceptInputCommand to the SourceControl instance
    jjSCM.acceptInputCommand = {
      command: "jj.new",
      title: "Create new change",
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.new", async () => {
        const message = jjSCM!.inputBox.value.trim() || undefined;
        await repositories.repos[0].new(message);
        jjSCM!.inputBox.value = "";
      })
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
            await repositories.repos[0].describe(resourceGroup.id, message);
            vscode.window.showInformationMessage(
              "Description updated successfully."
            );
          } catch (error: any) {
            vscode.window.showErrorMessage(
              `Failed to update description: ${error.message}`
            );
          }
        }
      )
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
      workingCopyResourceGroup!.label = `Working Copy | ${
        status.workingCopy.changeId
      }${
        status.workingCopy.description
          ? `: ${status.workingCopy.description}`
          : " (no description set)"
      }`;
      workingCopyResourceGroup!.resourceStates = status.fileStatuses.map(
        (fileStatus) => {
          return {
            resourceUri: vscode.Uri.file(fileStatus.path),
            decorations: {
              strikeThrough: fileStatus.type === "D",
              tooltip: path.basename(fileStatus.file),
            },
            command:
              status.parentChanges.length === 1
                ? {
                    title: "Open",
                    command: "vscode.diff",
                    arguments: [
                      toJJUri(
                        vscode.Uri.file(fileStatus.path),
                        status.parentChanges[0].changeId
                      ),
                      vscode.Uri.file(fileStatus.path),
                      (fileStatus.renamedFrom
                        ? `${fileStatus.renamedFrom} => `
                        : "") + `${fileStatus.file} (Working Copy)`,
                    ],
                  }
                : undefined,
          };
        }
      );

      for (const group of parentResourceGroups) {
        group.dispose();
      }
      parentResourceGroups = [];

      for (const parentChange of status.parentChanges) {
        let parentChangeResourceGroup:
          | vscode.SourceControlResourceGroup
          | undefined;
        parentChangeResourceGroup = jjSCM.createResourceGroup(
          parentChange.changeId,
          parentChange.description
            ? `Parent Change | ${parentChange.changeId}: ${parentChange.description}`
            : `Parent Change | ${parentChange.changeId} (no description set)`
        );
        parentResourceGroups.push(parentChangeResourceGroup);
        context.subscriptions.push(parentChangeResourceGroup);

        const showResult = await repositories.repos[0].show(
          parentChange.changeId
        );

        let grandparentShowResult: Show | undefined;
        try {
          grandparentShowResult = await repositories.repos[0].show(
            `${parentChange.changeId}-`
          );
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.includes("resolved to more than one revision")
          ) {
            // Leave grandparentShowResult as undefined
          } else {
            throw e;
          }
        }

        parentChangeResourceGroup!.resourceStates = showResult.fileStatuses.map(
          (parentStatus) => {
            return {
              resourceUri: toJJUri(
                vscode.Uri.file(parentStatus.path),
                parentChange.changeId
              ),
              decorations: {
                strikeThrough: parentStatus.type === "D",
                tooltip: path.basename(parentStatus.file),
              },
              command: grandparentShowResult
                ? {
                    title: "Open",
                    command: "vscode.diff",
                    arguments: [
                      toJJUri(
                        vscode.Uri.file(parentStatus.path),
                        grandparentShowResult.change.changeId
                      ),
                      toJJUri(
                        vscode.Uri.file(parentStatus.path),
                        parentChange.changeId
                      ),
                      (parentStatus.renamedFrom
                        ? `${parentStatus.renamedFrom} => `
                        : "") + `${parentStatus.file} (Parent Change)`,
                    ],
                  }
                : undefined,
            };
          }
        );

        decorationProvider.addDecorators(
          showResult.fileStatuses.map((status) =>
            toJJUri(vscode.Uri.file(status.path), parentChange.changeId)
          ),
          showResult.fileStatuses
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
