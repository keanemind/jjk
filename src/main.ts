import * as vscode from "vscode";
import which from "which";

import "./repository";
import { WorkspaceSourceControlManager } from "./repository";
import type { JJRepository, ChangeWithDetails } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import { JJFileSystemProvider } from "./fileSystemProvider";
import {
  OperationLogManager,
  OperationLogTreeDataProvider,
  OperationTreeItem,
} from "./operationLogTreeView";
import { JJGraphWebview, RefreshArgs } from "./graphWebview";
import { getRev } from "./uri";

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

  // Check for colocated repositories and warn about Git extension
  await checkColocatedRepositories(workspaceSCM, context);

  let operationLogManager: OperationLogManager | undefined;
  let graphWebview: JJGraphWebview;

  vscode.workspace.onDidChangeWorkspaceFolders(
    async () => {
      console.log("Workspace folders changed");
      await workspaceSCM.refresh();
    },
    undefined,
    context.subscriptions,
  );

  let isInitialized = false;
  function init() {
    const selectedRepo = getSelectedRepo(context, workspaceSCM);
    graphWebview = new JJGraphWebview(
      context.extensionUri,
      selectedRepo,
      context,
    );

    const fileSystemProvider = new JJFileSystemProvider(workspaceSCM);
    context.subscriptions.push(fileSystemProvider);
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider("jj", fileSystemProvider, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
    );

    const operationLogTreeDataProvider = new OperationLogTreeDataProvider(
      selectedRepo,
    );
    operationLogManager = new OperationLogManager(operationLogTreeDataProvider);
    context.subscriptions.push(operationLogManager);

    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    context.subscriptions.push(statusBarItem);
    statusBarItem.command = "jj.gitFetch";
    let lastOpenedFileUri: vscode.Uri | undefined;
    const statusBarHandleDidChangeActiveTextEditor = (
      editor: vscode.TextEditor | undefined,
    ) => {
      if (editor && editor.document.uri.scheme === "file") {
        lastOpenedFileUri = editor.document.uri;
        const repository = workspaceSCM.getRepositoryFromUri(lastOpenedFileUri);
        if (repository) {
          const folderName = repository.repositoryRoot.split("/").at(-1)!;
          statusBarItem.text = "$(cloud-download)";
          statusBarItem.tooltip = `${folderName} – Run \`jj git fetch\``;
          statusBarItem.show();
        }
      }
    };
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(
        statusBarHandleDidChangeActiveTextEditor,
      ),
    );
    statusBarHandleDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    const annotationDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 3em",
        textDecoration: "none",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    });
    let annotateInfo:
      | {
          uri: vscode.Uri;
          changeIdsByLine: string[];
        }
      | undefined;
    let activeEditorUri: vscode.Uri | undefined;
    let activeLines: number[] = [];
    const setDecorations = async (
      editor: vscode.TextEditor,
      lines: number[],
    ) => {
      if (
        annotateInfo &&
        annotateInfo.uri === editor.document.uri &&
        activeEditorUri === editor.document.uri &&
        activeLines === lines
      ) {
        const repository = workspaceSCM.getRepositoryFromUri(
          editor.document.uri,
        );
        if (!repository) {
          return;
        }
        // When the file ends in a newline, the last line can be active in the editor but won't get a blame from
        // jj file annotate.
        const safeLines = lines.filter(
          (line) => line !== annotateInfo!.changeIdsByLine.length,
        );
        const changes = new Map<string, ChangeWithDetails>(
          await Promise.all(
            safeLines.map(async (line) => {
              const changeId = annotateInfo!.changeIdsByLine[line];
              const showResult = await repository.show(changeId);
              return [changeId, showResult.change] satisfies [
                string,
                ChangeWithDetails,
              ];
            }),
          ),
        );
        if (
          annotateInfo &&
          annotateInfo.uri === editor.document.uri &&
          activeEditorUri === editor.document.uri &&
          activeLines === lines
        ) {
          const decorations: vscode.DecorationOptions[] = [];
          for (const line of safeLines) {
            const changeId = annotateInfo.changeIdsByLine[line];
            if (!changeId) {
              continue; // Could be possible if `annotateInfo` is stale due to the await
            }
            const change = changes.get(changeId);
            if (!change) {
              continue; // Could be possible if `annotateInfo` is mismatched with `changes` due to a race
            }
            decorations.push({
              renderOptions: {
                after: {
                  backgroundColor: "#00000000",
                  color: "#99999959",
                  contentText: ` ${change.author.name} at ${change.authoredDate} • ${change.description || "(no description)"} • ${change.changeId.substring(
                    0,
                    8,
                  )} `,
                  textDecoration: "none;",
                },
              },
              range: editor.document.validateRange(
                new vscode.Range(line, 2 ** 30 - 1, line, 2 ** 30 - 1),
              ),
            });
          }
          editor.setDecorations(annotationDecoration, decorations);
        }
      }
    };
    const updateAnnotateInfo = async (uri: vscode.Uri) => {
      const repository = workspaceSCM.getRepositoryFromUri(uri);
      if (repository) {
        const changeIdsByLine = await repository.annotate(
          uri.fsPath,
          uri.scheme === "jj" ? getRev(uri) : "@",
        );
        if (activeEditorUri === uri && changeIdsByLine.length > 0) {
          annotateInfo = { changeIdsByLine, uri };
        }
      }
    };
    const handleDidChangeActiveTextEditor = async (
      editor: vscode.TextEditor | undefined,
    ) => {
      if (editor) {
        const uri = editor.document.uri;
        activeEditorUri = uri;
        await updateAnnotateInfo(uri);
        activeLines = editor.selections.map(
          (selection) => selection.active.line,
        );
        await setDecorations(editor, activeLines);
      }
    };
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(
        handleDidChangeActiveTextEditor,
      ),
    );
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(async (e) => {
        activeLines = e.selections.map((selection) => selection.active.line);
        await setDecorations(e.textEditor, activeLines);
      }),
    );
    if (vscode.window.activeTextEditor) {
      void handleDidChangeActiveTextEditor(vscode.window.activeTextEditor);
    }

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
        "jj.restoreResourceState",
        showLoading(
          async (resourceState: vscode.SourceControlResourceState) => {
            try {
              const repository = workspaceSCM.getRepositoryFromUri(
                resourceState.resourceUri,
              );
              if (!repository) {
                throw new Error("Repository not found");
              }
              const group =
                workspaceSCM.getResourceGroupFromResourceState(resourceState);

              await repository.restore(group.id, [
                resourceState.resourceUri.fsPath,
              ]);

              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to restore${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.squashToParentResourceState",
        showLoading(
          async (resourceState: vscode.SourceControlResourceState) => {
            try {
              const repository = workspaceSCM.getRepositoryFromUri(
                resourceState.resourceUri,
              );
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

              await repository.squash({
                fromRev: "@",
                toRev: "@-",
                filepaths: [resourceState.resourceUri.fsPath],
              });
              vscode.window.showInformationMessage(
                "Changes successfully squashed.",
              );
              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to squash${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.squashToWorkingCopyResourceState",
        showLoading(
          async (resourceState: vscode.SourceControlResourceState) => {
            try {
              const repository = workspaceSCM.getRepositoryFromUri(
                resourceState.resourceUri,
              );
              if (!repository) {
                throw new Error("Repository not found");
              }

              const group =
                workspaceSCM.getResourceGroupFromResourceState(resourceState);

              await repository.squash({
                fromRev: group.id,
                toRev: "@",
                filepaths: [resourceState.resourceUri.fsPath],
              });
              vscode.window.showInformationMessage(
                "Changes successfully squashed.",
              );
              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to squash${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.describe",
        async (resourceGroup: vscode.SourceControlResourceGroup) => {
          const repository =
            workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
          if (!repository) {
            throw new Error("Repository not found");
          }

          const showResult = await repository.show(resourceGroup.id);

          const message = await vscode.window.showInputBox({
            prompt: "Provide a description",
            placeHolder: "Change description here...",
            value: showResult.change.description,
          });

          if (message === undefined) {
            return;
          }

          try {
            await repository.describe(resourceGroup.id, message);
            vscode.window.showInformationMessage(
              "Description updated successfully.",
            );
            await updateResources();
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to update description${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.squashToParentResourceGroup",
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
              await repository.squash({ fromRev: "@", toRev: "@-", message });
              vscode.window.showInformationMessage(
                "Changes successfully squashed.",
              );
              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to squash${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.squashToWorkingCopyResourceGroup",
        showLoading(
          async (resourceGroup: vscode.SourceControlResourceGroup) => {
            const repository =
              workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
            if (!repository) {
              throw new Error("Repository not found");
            }
            const status = await repository.status(true);

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
                message = status.workingCopy.description;
              }
            }

            try {
              const repository =
                workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
              if (!repository) {
                throw new Error("Repository not found");
              }
              await repository.squash({
                fromRev: resourceGroup.id,
                toRev: "@",
                message,
              });
              vscode.window.showInformationMessage(
                "Changes successfully squashed.",
              );
              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to squash${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.restoreResourceGroup",
        showLoading(
          async (resourceGroup: vscode.SourceControlResourceGroup) => {
            try {
              const repository =
                workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
              if (!repository) {
                throw new Error("Repository not found");
              }
              await repository.restore(resourceGroup.id);

              await updateResources();
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to restore${error instanceof Error ? `: ${error.message}` : ""}`,
              );
            }
          },
        ),
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.editResourceGroup",
        async (resourceGroup: vscode.SourceControlResourceGroup) => {
          try {
            const repository =
              workspaceSCM.getRepositoryFromResourceGroup(resourceGroup);
            if (!repository) {
              throw new Error("Repository not found");
            }
            await repository.edit(resourceGroup.id);

            await updateResources();
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to switch to change${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.refreshGraphWebview", async () => {
        await graphWebview.refresh(true, true);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.mergeGraphWebview", async () => {
        const selectedNodes = Array.from(graphWebview.selectedNodes);
        if (selectedNodes.length < 2) {
          return;
        }
        const revs = selectedNodes;

        try {
          await graphWebview.repository.new(undefined, revs);

          await updateResources();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create change${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.selectGraphWebviewRepo", async () => {
        const repoNames = workspaceSCM.repoSCMs.map(
          (repo) => repo.repositoryRoot,
        );
        const selectedRepoName = await vscode.window.showQuickPick(repoNames, {
          placeHolder: "Select a repository",
        });

        const selectedRepo = workspaceSCM.repoSCMs.find(
          (repo) => repo.repositoryRoot === selectedRepoName,
        );

        if (selectedRepo) {
          graphWebview.setSelectedRepository(selectedRepo.repository);
          context.workspaceState.update(
            "selectedRepository",
            selectedRepo.repositoryRoot,
          );
          await updateResources();
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.refreshOperationLog", async () => {
        await operationLogTreeDataProvider.refresh();
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.selectOperationLogRepo", async () => {
        const repoNames = workspaceSCM.repoSCMs.map(
          (repo) => repo.repositoryRoot,
        );
        const selectedRepoName = await vscode.window.showQuickPick(repoNames, {
          placeHolder: "Select a repository",
        });

        const selectedRepo = workspaceSCM.repoSCMs.find(
          (repo) => repo.repositoryRoot === selectedRepoName,
        );

        if (selectedRepo) {
          await operationLogManager!.setSelectedRepo(selectedRepo.repository);
          context.workspaceState.update(
            "selectedRepository",
            selectedRepo.repositoryRoot,
          );
          await updateResources();
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.operationUndo",
        async (item: unknown) => {
          if (!(item instanceof OperationTreeItem)) {
            throw new Error("OperationTreeItem expected");
          }
          const repository = workspaceSCM.getRepositoryFromUri(
            vscode.Uri.file(item.repositoryRoot),
          );
          if (!repository) {
            throw new Error("Repository not found");
          }
          await repository.operationUndo(item.operation.id);
          await updateResources();
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.operationRestore",
        async (item: unknown) => {
          if (!(item instanceof OperationTreeItem)) {
            throw new Error("OperationTreeItem expected");
          }
          const repository = workspaceSCM.getRepositoryFromUri(
            vscode.Uri.file(item.repositoryRoot),
          );
          if (!repository) {
            throw new Error("Repository not found");
          }
          await repository.operationRestore(item.operation.id);
          await updateResources();
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.gitFetch", async () => {
        if (lastOpenedFileUri) {
          statusBarItem.text = "$(sync~spin)";
          statusBarItem.tooltip = "Fetching...";
          try {
            await workspaceSCM
              .getRepositoryFromUri(lastOpenedFileUri)
              ?.gitFetch();
          } finally {
            statusBarHandleDidChangeActiveTextEditor(
              vscode.window.activeTextEditor,
            );
          }
        }
      }),
    );

    isInitialized = true;
  }

  async function updateResources(args?: Partial<RefreshArgs>) {
    const defaultArgs: RefreshArgs = {
      preserveScroll: false,
    };
    const finalArgs = { ...defaultArgs, ...args };

    if (workspaceSCM.repoSCMs.length > 0) {
      vscode.commands.executeCommand("setContext", "jj.reposExist", true);
      if (!isInitialized) {
        init();
      }
      const selectedRepo = getSelectedRepo(context, workspaceSCM);
      graphWebview.setSelectedRepository(selectedRepo);

      await graphWebview.refresh(finalArgs.preserveScroll);

      if (operationLogManager) {
        void operationLogManager.setSelectedRepo(selectedRepo);
      }
    } else {
      vscode.commands.executeCommand("setContext", "jj.reposExist", false);
    }

    for (const repoSCM of workspaceSCM.repoSCMs) {
      await repoSCM.repository.status();
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("jj.refresh", showLoading(updateResources)),
  );

  await updateResources();
  const intervalId = setInterval(() => void updateResources(), 5_000);
  context.subscriptions.push({
    dispose() {
      clearInterval(intervalId);
    },
  });
}

function showLoading<T extends unknown[]>(
  callback: (...args: T) => Promise<unknown>,
  ...initialArgs: Partial<T>
) {
  return (...args: T) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl },
      async () => {
        await callback(...(args.length ? args : (initialArgs as T)));
      },
    );
}

function getSelectedRepo(
  context: vscode.ExtensionContext,
  workspaceSCM: WorkspaceSourceControlManager,
): JJRepository {
  const selectedRepo = context.workspaceState.get<string>("selectedRepository");
  let repository: JJRepository;

  if (selectedRepo) {
    repository =
      workspaceSCM.repoSCMs.find((repo) => repo.repositoryRoot === selectedRepo)
        ?.repository || workspaceSCM.repoSCMs[0].repository;
  } else {
    repository = workspaceSCM.repoSCMs[0].repository;
  }

  return repository;
}

// This method is called when your extension is deactivated
export function deactivate() {}

/**
 * Checks if any repositories are colocated (have both .jj and .git directories)
 * and warns the user about potential conflicts with the Git extension
 */
async function checkColocatedRepositories(
  workspaceSCM: WorkspaceSourceControlManager,
  context: vscode.ExtensionContext,
) {
  // Create a map to store status bar items by repo path
  const statusBarItems = new Map<string, vscode.StatusBarItem>();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jj.openGitSettings",
      async (repoPath: string) => {
        if (!repoPath) {
          return;
        }

        const folderUri = vscode.Uri.file(repoPath);
        const settingsUri = vscode.Uri.joinPath(
          folderUri,
          ".vscode",
          "settings.json",
        );
        const parentDir = vscode.Uri.joinPath(folderUri, ".vscode");
        const folderName = repoPath.split("/").at(-1) || repoPath;

        try {
          // Create .vscode directory if it doesn't exist
          try {
            await vscode.workspace.fs.stat(parentDir);
          } catch {
            await vscode.workspace.fs.createDirectory(parentDir);
          }

          // Create a new settings file with git.enabled: false
          const settingsContent = JSON.stringify(
            { "git.enabled": false },
            null,
            4,
          );

          try {
            // Check if settings file already exists
            await vscode.workspace.fs.stat(settingsUri);

            // If we get here, the file exists - open it directly
            await vscode.commands.executeCommand("vscode.open", settingsUri);

            // Show a message with instructions
            vscode.window.showInformationMessage(
              `Please add "git.enabled": false to the settings file for "${folderName}" to avoid conflicts with Jujutsu.`,
            );
          } catch {
            // File doesn't exist, create it
            await vscode.workspace.fs.writeFile(
              settingsUri,
              Buffer.from(settingsContent, "utf8"),
            );

            await vscode.commands.executeCommand("vscode.open", settingsUri);
          }
        } catch (_error) {
          console.log(_error);
        }
      },
    ),
  );

  const checkRepos = async () => {
    console.log("Checking for colocated repositories...");

    const colocatedRepos = [];

    for (const repoSCM of workspaceSCM.repoSCMs) {
      const repoRoot = repoSCM.repositoryRoot;
      const jjDirExists = await fileExists(
        vscode.Uri.joinPath(vscode.Uri.file(repoRoot), ".jj"),
      );
      const gitDirExists = await fileExists(
        vscode.Uri.joinPath(vscode.Uri.file(repoRoot), ".git"),
      );

      if (jjDirExists && gitDirExists) {
        // Check if git.enabled is already set to false in folder settings
        const settingsUri = vscode.Uri.joinPath(
          vscode.Uri.file(repoRoot),
          ".vscode",
          "settings.json",
        );
        let gitEnabledIsFalse = false;

        try {
          const fileData = await vscode.workspace.fs.readFile(settingsUri);
          const fileContent = fileData.toString();

          // Check if "git.enabled": false exists in the file (not as a comment)
          // This regex looks for "git.enabled": false not preceded by // on the same line
          const regex = /(?<!\/\/.*)"git\.enabled"\s*:\s*false/;
          if (regex.test(fileContent)) {
            gitEnabledIsFalse = true;
          }
        } catch (_error) {
          console.log(_error);
          // If file doesn't exist or can't be read, assume git.enabled is not set to false
        }

        // Only add to colocated repos if git.enabled is not already false
        if (!gitEnabledIsFalse) {
          colocatedRepos.push(repoRoot);
        } else {
          // If git.enabled is now false but we had a warning, hide it
          if (statusBarItems.has(repoRoot)) {
            statusBarItems.get(repoRoot)?.dispose();
            statusBarItems.delete(repoRoot);
          }
        }
      }
    }

    // Clean up status bar items for repositories that are no longer in the workspace
    for (const [repoRoot, statusBarItem] of statusBarItems.entries()) {
      if (
        !workspaceSCM.repoSCMs.some((repo) => repo.repositoryRoot === repoRoot)
      ) {
        statusBarItem.dispose();
        statusBarItems.delete(repoRoot);
      }
    }

    // Show warnings for each colocated repository
    for (const repoRoot of colocatedRepos) {
      // Skip if we already have a warning for this repo
      if (statusBarItems.has(repoRoot)) {
        continue;
      }

      const folderName = repoRoot.split("/").at(-1) || repoRoot;
      const message = `Colocated Git and Jujutsu repository detected in "${folderName}". Consider disabling the Git extension to avoid conflicts.`;
      const openSettings = "Open Folder Settings";

      // Create a persistent notification that won't auto-dismiss
      const notification = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100,
      );
      notification.text = `$(warning) Git+JJ Conflict: ${folderName}`;
      notification.tooltip = message;
      notification.command = {
        title: "Open Git Settings",
        command: "jj.openGitSettings",
        arguments: [repoRoot],
      };
      notification.show();

      statusBarItems.set(repoRoot, notification);
      context.subscriptions.push(notification);

      vscode.window
        .showWarningMessage(message, openSettings)
        .then((selection) => {
          if (selection === openSettings) {
            vscode.commands.executeCommand("jj.openGitSettings", repoRoot);
          }
        });
    }
  };

  await checkRepos();

  // Set up a file system watcher for settings.json files
  const settingsWatcher = vscode.workspace.createFileSystemWatcher(
    "**/.vscode/settings.json",
  );

  // Re-check when settings files are changed
  settingsWatcher.onDidChange(async () => {
    await checkRepos();
  });

  settingsWatcher.onDidCreate(async () => {
    await checkRepos();
  });

  // Add the watcher to subscriptions to ensure it's disposed when the extension is deactivated
  context.subscriptions.push(settingsWatcher);

  // Listen for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // Wait for the workspace SCM to update
      setTimeout(() => {
        checkRepos().catch(console.error);
      }, 1000);
    }),
  );
}

/**
 * Checks if a file or directory exists at the given URI
 */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
