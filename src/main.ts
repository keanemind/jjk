import * as vscode from "vscode";
import which from "which";
import path from "node:path";

import "./repository";
import { Repositories } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import { JJFileSystemProvider } from "./fileSystemProvider";
import { toJJUri } from "./uri";
import { describeCommit } from "./describe";


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

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand("jjk.helloWorld", () => {
      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage("Hello World from Jujutsu Kaizen!");
    })
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

  const fileSystemProvider = new JJFileSystemProvider(repositories);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("jj", fileSystemProvider, {
      isReadonly: true,
      isCaseSensitive: true,
    })
  );

  // Determine if the workspace contains a jj repository
  if (repositories.repos.length > 0) {
    const fsWatcher = vscode.workspace.createFileSystemWatcher("**");
    context.subscriptions.push(fsWatcher);

    const jjSCM = vscode.scm.createSourceControl("jj", "Jujutsu");
    const workingCopy = jjSCM.createResourceGroup(
      "workingCopy",
      "Working Copy"
    );

    const status = await repositories.repos[0].status();
    decorationProvider.onDidRunStatus(status);
    workingCopy.resourceStates = status.fileStatuses.map((fileStatus) => {
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
              status.parentCommit.changeId
            ),
            toJJUri(
              vscode.Uri.file(fileStatus.path),
              status.workingCopy.changeId
            ),
            fileStatus.file + " (Working Copy)",
          ],
        },
      };
    });

    // Set up the SourceControlInputBox
    jjSCM.inputBox.placeholder = "Change commit message (Ctrl+Enter)";
    
    const acceptInputCommand = vscode.commands.registerCommand("jjk.describe", async () => {
      const newCommitMessage = jjSCM.inputBox.value.trim();
      if (!newCommitMessage) {
        vscode.window.showErrorMessage("Commit message cannot be empty.");
        return;
      }

      try {
        logger.appendLine(`Running jj describe with message: "${newCommitMessage}"`);
        await describeCommit(repositories.repos[0].repositoryRoot, newCommitMessage);
        jjSCM.inputBox.value = "";
        vscode.window.showInformationMessage("Commit message updated successfully.");
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to update commit message: ${error.message}`);
      }
    });

    // Link the acceptInputCommand to the SourceControl instance
    jjSCM.acceptInputCommand = {
      command: "jjk.describe",
      title: "Change Commit Message",
    };

    // Add a button to the Source Control view
    const describeButton = vscode.commands.registerCommand(
      "jjk.describeButton",
      async () => {
        vscode.commands.executeCommand("jjk.describe");
      }
    );

    context.subscriptions.push(
      acceptInputCommand,
      describeButton,
      jjSCM
    );
  }
}


// This method is called when your extension is deactivated
export function deactivate() {}
