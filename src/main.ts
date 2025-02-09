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

    const operationLogTreeDataProvider = new OperationLogTreeDataProvider(selectedRepo);
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
        const changes = new Map<string, ChangeWithDetails>(
          await Promise.all(
            lines.map(async (line) => {
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
          for (const line of lines) {
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
        const changeIdsByLine = await repository.annotate(uri.fsPath);
        if (activeEditorUri === uri) {
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
      workspaceSCM.repoSCMs.find(
        (repo) => repo.repositoryRoot === selectedRepo,
      )?.repository || workspaceSCM.repoSCMs[0].repository;
  } else {
    repository = workspaceSCM.repoSCMs[0].repository;
  }

  return repository;
}

// This method is called when your extension is deactivated
export function deactivate() {}
