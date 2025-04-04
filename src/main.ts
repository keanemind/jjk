import * as vscode from "vscode";
import which from "which";

import "./repository";
import { initJJVersion, WorkspaceSourceControlManager } from "./repository";
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
import { logger } from "./logger";
import { LogOutputChannelTransport } from "./vendor/winston-transport-vscode/logOutputChannelTransport";
import winston from "winston";
import { initConfigArgs } from "./repository";

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Jujutsu Kaizen", {
    log: true,
  });
  const loggerTransport = new LogOutputChannelTransport({
    outputChannel,
    format: winston.format.simple(),
  });
  logger.add(loggerTransport);
  context.subscriptions.push({
    dispose() {
      logger.remove(loggerTransport);
      outputChannel.dispose();
    },
  });

  logger.info("Extension activated");

  await initJJVersion();
  await initConfigArgs(context.extensionUri);

  const decorationProvider = new JJDecorationProvider((decorationProvider) => {
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(decorationProvider),
    );
  });

  // Check if the jj CLI is installed
  const jjPath = await which("jj", { nothrow: true });
  if (!jjPath) {
    throw new Error("jj CLI not found");
  }

  const workspaceSCM = new WorkspaceSourceControlManager(decorationProvider);
  await workspaceSCM.refresh();
  context.subscriptions.push(workspaceSCM);

  let checkReposFunction: (specificFolders?: string[]) => Promise<void>;

  // Check for colocated repositories and warn about Git extension
  await checkColocatedRepositories(workspaceSCM, context);

  let operationLogManager: OperationLogManager | undefined;
  let graphWebview: JJGraphWebview;

  vscode.workspace.onDidChangeWorkspaceFolders(
    async () => {
      logger.info("Workspace folders changed");
      await workspaceSCM.refresh();
      await checkReposFunction();
    },
    undefined,
    context.subscriptions,
  );

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration("git")) {
      logger.info("Git configuration changed");
      const workspaceFolders = vscode.workspace.workspaceFolders || [];

      const affectedFolders = workspaceFolders
        .filter((folder) => e.affectsConfiguration("git", folder.uri))
        .map((folder) => folder.uri.fsPath);

      if (affectedFolders.length > 0) {
        await checkReposFunction(affectedFolders);
      }
    }
  });

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
      const repository = workspaceSCM.getRepositoryFromUri(editor.document.uri);
      if (!repository) {
        return;
      }
      const config = vscode.workspace.getConfiguration(
        "jjk",
        vscode.Uri.file(repository.repositoryRoot),
      );
      if (!config.get("enableAnnotations")) {
        editor.setDecorations(annotationDecoration, []);
        return;
      }

      if (
        annotateInfo &&
        annotateInfo.uri === editor.document.uri &&
        activeEditorUri === editor.document.uri &&
        activeLines === lines
      ) {
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
      if (!repository) {
        return;
      }
      const config = vscode.workspace.getConfiguration(
        "jjk",
        vscode.Uri.file(repository.repositoryRoot),
      );
      if (!config.get("enableAnnotations")) {
        annotateInfo = undefined;
        return;
      }

      const changeIdsByLine = await repository.annotate(
        uri.fsPath,
        uri.scheme === "jj" ? getRev(uri) : "@",
      );
      if (activeEditorUri === uri && changeIdsByLine.length > 0) {
        annotateInfo = { changeIdsByLine, uri };
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
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(async (e) => {
        const editor = vscode.window.activeTextEditor;
        if (
          editor &&
          editor.document.uri.toString() === e.document.uri.toString()
        ) {
          await setDecorations(editor, activeLines);
        }
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

              let message: string | undefined;
              if (
                status.fileStatuses.length === 1 && // this is the only file in the source change
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

              await repository.squash({
                fromRev: "@",
                toRev: "@-",
                message,
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
              const status = await repository.status(true);

              const resourceGroup =
                workspaceSCM.getResourceGroupFromResourceState(resourceState);

              const parentChange = status.parentChanges.find(
                (change) => change.changeId === resourceGroup.id,
              );
              if (parentChange === undefined) {
                throw new Error(
                  "Parent change we're squashing from was not found in status",
                );
              }

              let message: string | undefined;
              if (
                resourceGroup.resourceStates.length === 1 && // this is the only file in the source change
                status.workingCopy.description !== "" &&
                parentChange.description !== ""
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

              await repository.squash({
                fromRev: resourceGroup.id,
                toRev: "@",
                message,
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

            const parentChange = status.parentChanges.find(
              (change) => change.changeId === resourceGroup.id,
            );
            if (parentChange === undefined) {
              throw new Error(
                "Parent change we're squashing from was not found in status",
              );
            }

            let message: string | undefined;
            if (
              status.workingCopy.description !== "" &&
              parentChange.description !== ""
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jj.openFolderGitSettings",
      async (repoPath: string) => {
        if (!repoPath) {
          return;
        }
        await vscode.commands.executeCommand("workbench.action.openSettings", {
          query: "git.enabled",
        });
        await vscode.commands.executeCommand(
          "_workbench.action.openFolderSettings",
          vscode.Uri.file(repoPath),
        );
      },
    ),
  );

  /**
   * Checks if any repositories are colocated (have both .jj and .git directories)
   * and warns the user about potential conflicts with the Git extension
   */
  async function checkColocatedRepositories(
    workspaceSCM: WorkspaceSourceControlManager,
    context: vscode.ExtensionContext,
  ) {
    // Create a single persistent status bar item
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    context.subscriptions.push(statusBarItem);

    // Keep track of which repos have warnings
    const reposWithWarnings = new Set<string>();

    const checkRepos = async (specificFolders?: string[]) => {
      const colocatedRepos = [];

      for (const repoSCM of workspaceSCM.repoSCMs) {
        const repoRoot = repoSCM.repositoryRoot;

        // Skip if we're checking specific folders and this isn't one of them
        if (specificFolders && !specificFolders.includes(repoRoot)) {
          continue;
        }

        const jjDirExists = await fileExists(
          vscode.Uri.joinPath(vscode.Uri.file(repoRoot), ".jj"),
        );
        const gitDirExists = await fileExists(
          vscode.Uri.joinPath(vscode.Uri.file(repoRoot), ".git"),
        );

        if (jjDirExists && gitDirExists) {
          const isGitEnabled = vscode.workspace
            .getConfiguration("git", vscode.Uri.file(repoRoot))
            .get("enabled");

          if (isGitEnabled) {
            colocatedRepos.push(repoRoot);
            reposWithWarnings.add(repoRoot);
          } else {
            reposWithWarnings.delete(repoRoot);
          }
        }
      }

      if (reposWithWarnings.size > 0) {
        const count = reposWithWarnings.size;
        statusBarItem.text = `$(warning) JJK Issues (${count})`;
        statusBarItem.tooltip = "Click to view colocated repository warnings";
        statusBarItem.command = "jj.showColocatedWarnings";
        statusBarItem.show();
      } else {
        statusBarItem.hide();
      }

      for (const repoRoot of colocatedRepos) {
        const folderName = repoRoot.split("/").at(-1) || repoRoot;
        const message = `Colocated Jujutsu and Git repository detected in "${folderName}". Consider disabling the Git extension to avoid conflicts.`;
        const openSettings = "Open Folder Settings";

        vscode.window
          .showWarningMessage(message, openSettings)
          .then((selection) => {
            if (selection === openSettings) {
              vscode.commands.executeCommand(
                "jj.openFolderGitSettings",
                repoRoot,
              );
            }
          });
      }
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.showColocatedWarnings", () => {
        for (const repoRoot of reposWithWarnings) {
          const folderName = repoRoot.split("/").at(-1) || repoRoot;
          const message = `Colocated Jujutsu and Git repository detected in "${folderName}". Consider disabling the Git extension to avoid conflicts.`;
          const openSettings = "Open Folder Settings";

          vscode.window
            .showWarningMessage(message, openSettings)
            .then((selection) => {
              if (selection === openSettings) {
                vscode.commands.executeCommand(
                  "jj.openFolderGitSettings",
                  repoRoot,
                );
              }
            });
        }
      }),
    );

    checkReposFunction = checkRepos;

    await checkRepos();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("jj.checkColocatedRepos", async () => {
      if (checkReposFunction) {
        await checkReposFunction();
      }
    }),
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

export function deactivate() {}

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
