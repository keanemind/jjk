import * as vscode from "vscode";
import path from "path";
import "./repository";
import {
  initExtensionDir,
  provideOriginalResource,
  WorkspaceSourceControlManager,
} from "./repository";
import type { JJRepository, ChangeWithDetails } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import {
  OperationLogManager,
  OperationLogTreeDataProvider,
  OperationTreeItem,
} from "./operationLogTreeView";
import { JJGraphWebview, RefreshArgs } from "./graphWebview";
import { getParams, toJJUri } from "./uri";
import { logger } from "./logger";
import { LogOutputChannelTransport } from "./vendor/winston-transport-vscode/logOutputChannelTransport";
import winston from "winston";
import { linesDiffComputers } from "./vendor/vscode/editor/common/diff/linesDiffComputers";
import {
  ILinesDiffComputer,
  LinesDiff,
} from "./vendor/vscode/editor/common/diff/linesDiffComputer";
import { match } from "arktype";
import { getActiveTextEditorDiff } from "./utils";

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

  initExtensionDir(context.extensionUri);

  const decorationProvider = new JJDecorationProvider((decorationProvider) => {
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(decorationProvider),
    );
  });

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
      if (!["file", "jj"].includes(uri.scheme)) {
        annotateInfo = undefined;
        return;
      }
      let rev = "@";
      if (uri.scheme === "jj") {
        const params = getParams(uri);
        if ("diffOriginalRev" in params) {
          rev = `${params.diffOriginalRev}-`; // note that this may refer to multiple revs, which we handle below
        } else {
          rev = params.rev;
        }
      }

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

      try {
        const changeIdsByLine = await repository.annotate(uri.fsPath, rev);
        if (activeEditorUri === uri && changeIdsByLine.length > 0) {
          annotateInfo = { changeIdsByLine, uri };
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("more than one revision")
        ) {
          annotateInfo = undefined;
        } else {
          throw error;
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
          try {
            const repository =
              workspaceSCM.getRepositoryFromSourceControl(sourceControl);
            if (!repository) {
              throw new Error("Repository not found");
            }
            const message = sourceControl.inputBox.value.trim() || undefined;
            await repository.new(message);
            sourceControl.inputBox.value = "";
            await updateResources();
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to create change${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openFileResourceState",
        async (resourceState: vscode.SourceControlResourceState) => {
          const opts: vscode.TextDocumentShowOptions = {
            preserveFocus: false,
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          };
          try {
            await vscode.commands.executeCommand(
              "vscode.open",
              vscode.Uri.file(resourceState.resourceUri.fsPath),
              {
                ...opts,
              },
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open file${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openFileEditor",
        async (uri: vscode.Uri) => {
          try {
            if (!["file", "jj"].includes(uri.scheme)) {
              return undefined;
            }

            let rev = "@";
            if (uri.scheme === "jj") {
              const params = getParams(uri);
              if ("diffOriginalRev" in params) {
                rev = params.diffOriginalRev;
              } else {
                rev = params.rev;
              }
            }

            await vscode.commands.executeCommand(
              "vscode.open",
              uri,
              {},
              `${path.basename(uri.fsPath)} (${rev.substring(0, 8)})`,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open file${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openDiffEditor",
        async (uri: vscode.Uri) => {
          try {
            const originalUri = provideOriginalResource(uri);
            if (!originalUri) {
              throw new Error("Original resource not found");
            }
            const params = getParams(originalUri);
            if (!("diffOriginalRev" in params)) {
              throw new Error(
                "Original resource does not have a diffOriginalRev. This is a bug.",
              );
            }
            await vscode.commands.executeCommand(
              "vscode.diff",
              originalUri,
              uri,
              `${path.basename(uri.fsPath)} (${params.diffOriginalRev.substring(0, 8)})`,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open diff${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
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

              let destinationParentChange = status.parentChanges[0];
              if (status.parentChanges.length > 1) {
                const parentOptions = status.parentChanges.map((parent) => ({
                  label: parent.changeId,
                  description: parent.description || "(no description)",
                  parent,
                }));
                const selection = await vscode.window.showQuickPick(
                  parentOptions,
                  {
                    placeHolder: "Select parent to squash into",
                  },
                );
                if (!selection) {
                  return;
                }
                destinationParentChange = selection.parent;
              } else if (status.parentChanges.length === 0) {
                throw new Error("No parent changes found");
              }

              let message: string | undefined;
              if (
                status.fileStatuses.length === 1 && // this is the only file in the source change
                status.workingCopy.description !== "" &&
                destinationParentChange.description !== ""
              ) {
                message = await vscode.window.showInputBox({
                  prompt: "Provide a description",
                  placeHolder: "Set description here...",
                });

                if (message === undefined) {
                  return;
                } else if (message === "") {
                  message = destinationParentChange.description;
                }
              }

              await repository.squash({
                fromRev: "@",
                toRev: destinationParentChange.changeId,
                message,
                filepaths: [resourceState.resourceUri.fsPath],
              });
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

            let destinationParentChange = status.parentChanges[0];
            if (status.parentChanges.length > 1) {
              const parentOptions = status.parentChanges.map((parent) => ({
                label: parent.changeId,
                description: parent.description || "(no description)",
                parent,
              }));
              const selection = await vscode.window.showQuickPick(
                parentOptions,
                {
                  placeHolder: "Select parent to squash into",
                },
              );
              if (!selection) {
                return;
              }
              destinationParentChange = selection.parent;
            } else if (status.parentChanges.length === 0) {
              throw new Error("No parent changes found");
            }

            let message: string | undefined;
            if (
              status.workingCopy.description !== "" &&
              destinationParentChange.description !== ""
            ) {
              message = await vscode.window.showInputBox({
                prompt: "Provide a description",
                placeHolder: "Set description here...",
              });

              if (message === undefined) {
                return;
              } else if (message === "") {
                message = destinationParentChange.description;
              }
            }

            try {
              await repository.squash({
                fromRev: "@",
                toRev: destinationParentChange.changeId,
                message,
              });
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
        try {
          await graphWebview.refresh(true, true);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to refresh graph${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.newGraphWebview", async () => {
        const selectedNodes = Array.from(graphWebview.selectedNodes);
        if (selectedNodes.length < 1) {
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
        try {
          const repoNames = workspaceSCM.repoSCMs.map(
            (repo) => repo.repositoryRoot,
          );
          const selectedRepoName = await vscode.window.showQuickPick(
            repoNames,
            {
              placeHolder: "Select a repository",
            },
          );

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
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to select repository${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.refreshOperationLog", async () => {
        try {
          await operationLogTreeDataProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to refresh operation log${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.selectOperationLogRepo", async () => {
        try {
          const repoNames = workspaceSCM.repoSCMs.map(
            (repo) => repo.repositoryRoot,
          );
          const selectedRepoName = await vscode.window.showQuickPick(
            repoNames,
            {
              placeHolder: "Select a repository",
            },
          );

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
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to select repository${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.operationUndo",
        async (item: unknown) => {
          try {
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
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to undo operation${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.operationRestore",
        async (item: unknown) => {
          try {
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
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to restore operation${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
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
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to fetch from remote${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          } finally {
            statusBarHandleDidChangeActiveTextEditor(
              vscode.window.activeTextEditor,
            );
          }
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.squashSelectedRanges", async () => {
        // this is based on the Git extension's git.stageSelectedRanges function
        // https://github.com/microsoft/vscode/blob/bd05fbbcb0dbc153f85dd118b5729bde34b91f2f/extensions/git/src/commands.ts#L1646
        try {
          const textEditor = vscode.window.activeTextEditor;
          if (!textEditor) {
            return;
          }

          const repository = workspaceSCM.getRepositoryFromUri(
            textEditor.document.uri,
          );
          if (!repository) {
            return;
          }

          const items: ({ changeId: string } & vscode.QuickPickItem)[] = [];

          try {
            const childChanges = await repository.log(
              "all:@+",
              'change_id ++ "\n"',
              undefined,
              true,
            );

            items.push(
              ...(await Promise.all(
                childChanges
                  .trim()
                  .split("\n")
                  .map(async (changeId) => {
                    const show = await repository.show(changeId);
                    return {
                      label: `$(arrow-up) Child: ${changeId.substring(0, 8)}`,
                      description:
                        show.change.description || "(no description)",
                      alwaysShow: true,
                      changeId,
                    };
                  }),
              )),
            );
          } catch (_) {
            // No child changes or error, continue with just parents
          }

          const status = await repository.status(true);
          for (const parent of status.parentChanges) {
            items.push({
              label: `$(arrow-down) Parent: ${parent.changeId.substring(0, 8)}`,
              description: parent.description || "(no description)",
              alwaysShow: true,
              changeId: parent.changeId,
            });
          }

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder:
              "Select destination change for squashing selected lines",
            ignoreFocusOut: true,
          });

          if (!selected) {
            return;
          }

          const destinationRev = selected.changeId;

          async function computeAndSquashSelectedDiff(
            repository: JJRepository,
            diffComputer: ILinesDiffComputer,
            originalUri: vscode.Uri,
            textEditor: vscode.TextEditor,
          ) {
            const originalDocument =
              await vscode.workspace.openTextDocument(originalUri);
            const originalLines = originalDocument.getText().split("\n");
            const editorLines = textEditor.document.getText().split("\n");
            const diff = diffComputer.computeDiff(originalLines, editorLines, {
              ignoreTrimWhitespace: false,
              maxComputationTimeMs: 5000,
              computeMoves: false,
            });

            const lineChanges = toLineChanges(diff);
            const selectedLines = toLineRanges(
              textEditor.selections,
              textEditor.document,
            );
            const selectedChanges = lineChanges
              .map((change) =>
                selectedLines.reduce<LineChange | null>(
                  (result, range) =>
                    result ||
                    intersectDiffWithRange(textEditor.document, change, range),
                  null,
                ),
              )
              .filter((d) => !!d);

            if (!selectedChanges.length) {
              vscode.window.showErrorMessage(
                "The selection range does not contain any changes.",
              );
              return;
            }

            const result = applyLineChanges(
              originalDocument,
              textEditor.document,
              selectedChanges,
            );

            await repository.squashContent({
              fromRev: "@",
              toRev: destinationRev,
              content: result,
              filepath: originalUri.fsPath,
            });
          }

          const diffInput = getActiveTextEditorDiff();

          if (
            diffInput &&
            diffInput.modified.scheme === "file" &&
            diffInput.original.scheme === "jj" &&
            match({})
              .case({ diffOriginalRev: "string" }, ({ diffOriginalRev }) =>
                [
                  "@",
                  status.workingCopy.changeId,
                  status.workingCopy.commitId,
                ].includes(diffOriginalRev),
              )
              .default(() => false)(getParams(diffInput.original))
          ) {
            await computeAndSquashSelectedDiff(
              repository,
              linesDiffComputers.getDefault(),
              diffInput.original,
              textEditor,
            );
            await updateResources();
          } else if (textEditor.document.uri.scheme === "file") {
            await computeAndSquashSelectedDiff(
              repository,
              linesDiffComputers.getLegacy(),
              toJJUri(textEditor.document.uri, {
                diffOriginalRev: status.workingCopy.commitId,
              }),
              textEditor,
            );
            await updateResources();
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to squash selection${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openParentChange",
        async (uri: vscode.Uri) => {
          try {
            if (!["file", "jj"].includes(uri.scheme)) {
              return undefined;
            }

            let currentRev = "@";
            if (uri.scheme === "jj") {
              const params = getParams(uri);
              if ("diffOriginalRev" in params) {
                currentRev = params.diffOriginalRev;
              } else {
                currentRev = params.rev;
              }
            }

            const repository = workspaceSCM.getRepositoryFromUri(uri);
            if (!repository) {
              throw new Error("Repository not found");
            }

            const parentChangesOutput = (
              await repository.log(
                `all:${currentRev}-`,
                'change_id ++ "\n"',
                undefined,
                true,
              )
            ).trim();

            if (parentChangesOutput === "") {
              throw new Error("No parent changes found");
            }

            const parentChanges = parentChangesOutput.split("\n");

            if (parentChanges.length === 0) {
              throw new Error("No parent changes found");
            }

            let selectedParentChange: string;
            if (parentChanges.length === 1) {
              selectedParentChange = parentChanges[0];
            } else {
              const items = (await Promise.all(
                parentChanges.map(async (changeId) => {
                  const show = await repository.show(changeId);
                  return {
                    label: `$(arrow-down) Parent: ${changeId.substring(0, 8)}`,
                    description: show.change.description || "(no description)",
                    alwaysShow: true,
                    changeId,
                  };
                }),
              )) satisfies vscode.QuickPickItem[];

              const selection = await vscode.window.showQuickPick(items, {
                placeHolder: "Select parent change to open",
              });
              if (!selection) {
                return;
              }

              selectedParentChange = selection.changeId;
            }

            if (getActiveTextEditorDiff()) {
              await vscode.commands.executeCommand(
                "vscode.diff",
                toJJUri(uri, {
                  diffOriginalRev: selectedParentChange,
                }),
                toJJUri(uri, {
                  rev: selectedParentChange,
                }),
                `${path.basename(uri.fsPath)} (${selectedParentChange.substring(0, 8)})`,
              );
            } else {
              await vscode.commands.executeCommand(
                "vscode.open",
                toJJUri(uri, {
                  rev: selectedParentChange,
                }),
                {},
                `${path.basename(uri.fsPath)} (${selectedParentChange.substring(0, 8)})`,
              );
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open parent change${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "jj.openChildChange",
        async (uri: vscode.Uri) => {
          try {
            if (!["file", "jj"].includes(uri.scheme)) {
              return undefined;
            }

            let currentRev = "@";
            if (uri.scheme === "jj") {
              const params = getParams(uri);
              if ("diffOriginalRev" in params) {
                currentRev = params.diffOriginalRev;
              } else {
                currentRev = params.rev;
              }
            }

            const repository = workspaceSCM.getRepositoryFromUri(uri);
            if (!repository) {
              throw new Error("Repository not found");
            }

            const childChangesOutput = (
              await repository.log(
                `all:${currentRev}+`,
                'change_id ++ "\n"',
                undefined,
                true,
              )
            ).trim();

            if (childChangesOutput === "") {
              throw new Error("No child changes found");
            }

            const childChanges = childChangesOutput.split("\n");

            if (childChanges.length === 0) {
              throw new Error("No child changes found");
            }

            let selectedChildChange: string;
            if (childChanges.length === 1) {
              selectedChildChange = childChanges[0];
            } else {
              const items = (await Promise.all(
                childChanges.map(async (changeId) => {
                  const show = await repository.show(changeId);
                  return {
                    label: `$(arrow-up) Child: ${changeId.substring(0, 8)}`,
                    description: show.change.description || "(no description)",
                    alwaysShow: true,
                    changeId,
                  };
                }),
              )) satisfies vscode.QuickPickItem[];

              const selection = await vscode.window.showQuickPick(items, {
                placeHolder: "Select child change to open",
              });
              if (!selection) {
                return;
              }

              selectedChildChange = selection.changeId;
            }

            if (getActiveTextEditorDiff()) {
              await vscode.commands.executeCommand(
                "vscode.diff",
                toJJUri(uri, {
                  diffOriginalRev: selectedChildChange,
                }),
                toJJUri(uri, {
                  rev: selectedChildChange,
                }),
                `${path.basename(uri.fsPath)} (${selectedChildChange.substring(0, 8)})`,
              );
            } else {
              await vscode.commands.executeCommand(
                "vscode.open",
                toJJUri(uri, {
                  rev: selectedChildChange,
                }),
                {},
                `${path.basename(uri.fsPath)} (${selectedChildChange.substring(0, 8)})`,
              );
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to open child change${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
        },
      ),
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

function toLineChanges(diffInformation: LinesDiff): LineChange[] {
  return diffInformation.changes.map((x) => {
    let originalStartLineNumber: number;
    let originalEndLineNumber: number;
    let modifiedStartLineNumber: number;
    let modifiedEndLineNumber: number;

    if (x.original.startLineNumber === x.original.endLineNumberExclusive) {
      // Insertion
      originalStartLineNumber = x.original.startLineNumber - 1;
      originalEndLineNumber = 0;
    } else {
      originalStartLineNumber = x.original.startLineNumber;
      originalEndLineNumber = x.original.endLineNumberExclusive - 1;
    }

    if (x.modified.startLineNumber === x.modified.endLineNumberExclusive) {
      // Deletion
      modifiedStartLineNumber = x.modified.startLineNumber - 1;
      modifiedEndLineNumber = 0;
    } else {
      modifiedStartLineNumber = x.modified.startLineNumber;
      modifiedEndLineNumber = x.modified.endLineNumberExclusive - 1;
    }

    return {
      originalStartLineNumber,
      originalEndLineNumber,
      modifiedStartLineNumber,
      modifiedEndLineNumber,
    };
  });
}

function toLineRanges(
  selections: readonly vscode.Selection[],
  textDocument: vscode.TextDocument,
): vscode.Range[] {
  const lineRanges = selections.map((s) => {
    const startLine = textDocument.lineAt(s.start.line);
    const endLine = textDocument.lineAt(s.end.line);
    return new vscode.Range(startLine.range.start, endLine.range.end);
  });

  lineRanges.sort((a, b) => a.start.line - b.start.line);

  const result = lineRanges.reduce((result, l) => {
    if (result.length === 0) {
      result.push(l);
      return result;
    }

    const [last, ...rest] = result;
    const intersection = l.intersection(last);

    if (intersection) {
      return [intersection, ...rest];
    }

    if (l.start.line === last.end.line + 1) {
      const merge = new vscode.Range(last.start, l.end);
      return [merge, ...rest];
    }

    return [l, ...result];
  }, [] as vscode.Range[]);

  result.reverse();

  return result;
}

interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

function intersectDiffWithRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
  range: vscode.Range,
): LineChange | null {
  const modifiedRange = getModifiedRange(textDocument, diff);
  const intersection = range.intersection(modifiedRange);

  if (!intersection) {
    return null;
  }

  if (diff.modifiedEndLineNumber === 0) {
    return diff;
  } else {
    const modifiedStartLineNumber = intersection.start.line + 1;
    const modifiedEndLineNumber = intersection.end.line + 1;

    // heuristic: same number of lines on both sides, let's assume line by line
    if (
      diff.originalEndLineNumber - diff.originalStartLineNumber ===
      diff.modifiedEndLineNumber - diff.modifiedStartLineNumber
    ) {
      const delta = modifiedStartLineNumber - diff.modifiedStartLineNumber;
      const length = modifiedEndLineNumber - modifiedStartLineNumber;

      return {
        originalStartLineNumber: diff.originalStartLineNumber + delta,
        originalEndLineNumber: diff.originalStartLineNumber + delta + length,
        modifiedStartLineNumber,
        modifiedEndLineNumber,
      };
    } else {
      return {
        originalStartLineNumber: diff.originalStartLineNumber,
        originalEndLineNumber: diff.originalEndLineNumber,
        modifiedStartLineNumber,
        modifiedEndLineNumber,
      };
    }
  }
}

function getModifiedRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
): vscode.Range {
  if (diff.modifiedEndLineNumber === 0) {
    if (diff.modifiedStartLineNumber === 0) {
      return new vscode.Range(
        textDocument.lineAt(diff.modifiedStartLineNumber).range.end,
        textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
      );
    } else if (textDocument.lineCount === diff.modifiedStartLineNumber) {
      return new vscode.Range(
        textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
        textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
      );
    } else {
      return new vscode.Range(
        textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
        textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
      );
    }
  } else {
    return new vscode.Range(
      textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.start,
      textDocument.lineAt(diff.modifiedEndLineNumber - 1).range.end,
    );
  }
}

function applyLineChanges(
  original: vscode.TextDocument,
  modified: vscode.TextDocument,
  diffs: LineChange[],
): string {
  const result: string[] = [];
  let currentLine = 0;

  for (const diff of diffs) {
    const isInsertion = diff.originalEndLineNumber === 0;
    const isDeletion = diff.modifiedEndLineNumber === 0;

    let endLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalStartLineNumber - 1;
    let endCharacter = 0;

    // if this is a deletion at the very end of the document,then we need to account
    // for a newline at the end of the last line which may have been deleted
    // https://github.com/microsoft/vscode/issues/59670
    if (isDeletion && diff.originalEndLineNumber === original.lineCount) {
      endLine -= 1;
      endCharacter = original.lineAt(endLine).range.end.character;
    }

    result.push(
      original.getText(new vscode.Range(currentLine, 0, endLine, endCharacter)),
    );

    if (!isDeletion) {
      let fromLine = diff.modifiedStartLineNumber - 1;
      let fromCharacter = 0;

      // if this is an insertion at the very end of the document,
      // then we must start the next range after the last character of the
      // previous line, in order to take the correct eol
      if (isInsertion && diff.originalStartLineNumber === original.lineCount) {
        fromLine -= 1;
        fromCharacter = modified.lineAt(fromLine).range.end.character;
      }

      result.push(
        modified.getText(
          new vscode.Range(
            fromLine,
            fromCharacter,
            diff.modifiedEndLineNumber,
            0,
          ),
        ),
      );
    }

    currentLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalEndLineNumber;
  }

  result.push(
    original.getText(new vscode.Range(currentLine, 0, original.lineCount, 0)),
  );

  return result.join("");
}
