import * as vscode from "vscode";
import which from "which";

import "./repository";
import { WorkspaceSourceControlManager } from "./repository";
import type { JJRepository, ChangeWithDetails } from "./repository";
import { JJDecorationProvider } from "./decorationProvider";
import { JJFileSystemProvider } from "./fileSystemProvider";
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

  let logProvider: JJGraphProvider;

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
    logProvider = new JJGraphProvider(
      getSelectedGraphRepo(context, workspaceSCM),
    );
    const fileSystemProvider = new JJFileSystemProvider(workspaceSCM);
    context.subscriptions.push(fileSystemProvider);
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider("jj", fileSystemProvider, {
        isReadonly: true,
        isCaseSensitive: true,
      }),
    );

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
          changes: Map<string, ChangeWithDetails>;
        }
      | undefined;
    let activeEditorUri: vscode.Uri | undefined;
    const setDecorations = (editor: vscode.TextEditor, lines: number[]) => {
      if (
        activeEditorUri === editor.document.uri &&
        annotateInfo &&
        annotateInfo.uri === editor.document.uri
      ) {
        const decorations = lines.map((line) => {
          const changeId = annotateInfo!.changeIdsByLine[line];
          const change = annotateInfo!.changes.get(changeId)!;
          return {
            renderOptions: {
              after: {
                backgroundColor: "#00000000",
                color: "#99999959",
                contentText: ` ${change.author.name} at ${change.date} • ${change.description || "(no description)"} • ${change.changeId.substring(
                  0,
                  8,
                )} `,
                textDecoration: "none;",
              },
            },
            range: editor.document.validateRange(
              new vscode.Range(line, 2 ** 30 - 1, line, 2 ** 30 - 1),
            ),
          } satisfies vscode.DecorationOptions;
        });
        editor.setDecorations(annotationDecoration, decorations);
      }
    };
    const updateAnnotateInfo = async (uri: vscode.Uri) => {
      const repository = workspaceSCM.getRepositoryFromUri(uri);
      if (repository) {
        const result = await repository.annotate(uri.fsPath);
        if (activeEditorUri === uri) {
          annotateInfo = { ...result, uri };
        }
      }
    };
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(
        async (editor: vscode.TextEditor | undefined) => {
          if (editor) {
            const uri = editor.document.uri;
            activeEditorUri = uri;
            await updateAnnotateInfo(uri);
            const activeLines = editor.selections.map(
              (selection) => selection.active.line,
            );
            setDecorations(editor, activeLines);
          }
        },
      ),
    );
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const activeLines = e.selections.map(
          (selection) => selection.active.line,
        );
        setDecorations(e.textEditor, activeLines);
      }),
    );
    if (vscode.window.activeTextEditor) {
      void updateAnnotateInfo(vscode.window.activeTextEditor.document.uri);
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
        "jj.editGraph",
        async (node: ChangeNode) => {
          try {
            await logProvider.treeDataProvider.repository.edit(
              node.contextValue as string,
            );
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
      vscode.commands.registerCommand("jj.merge", async () => {
        const selectedNodes = logProvider.treeView.selection as ChangeNode[];
        if (selectedNodes.length < 2) {
          return;
        }
        const revs = selectedNodes.map((node) => node.contextValue as string);

        try {
          await logProvider.treeDataProvider.repository.new(undefined, revs);
          await updateResources();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create change${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("jj.selectGraphRepo", async () => {
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
          logProvider.treeDataProvider.setCurrentRepo(selectedRepo.repository);
          context.workspaceState.update(
            "graphRepoRoot",
            selectedRepo.repositoryRoot,
          );
          void logProvider.treeDataProvider.refresh();
        }
      }),
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

  async function updateResources() {
    if (workspaceSCM.repoSCMs.length > 0) {
      vscode.commands.executeCommand("setContext", "jj.reposExist", true);
      if (!isInitialized) {
        init();
      }
      const graphRepo = getSelectedGraphRepo(context, workspaceSCM);
      logProvider.treeDataProvider.setCurrentRepo(graphRepo);
      context.workspaceState.update("graphRepoRoot", graphRepo.repositoryRoot);
      await logProvider.treeDataProvider.refresh();
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

function getSelectedGraphRepo(
  context: vscode.ExtensionContext,
  workspaceSCM: WorkspaceSourceControlManager,
): JJRepository {
  const graphRepoRoot = context.workspaceState.get<string>("graphRepoRoot");
  let graphRepo: JJRepository;

  if (graphRepoRoot) {
    graphRepo =
      workspaceSCM.repoSCMs.find(
        (repo) => repo.repositoryRoot === graphRepoRoot,
      )?.repository || workspaceSCM.repoSCMs[0].repository;
  } else {
    graphRepo = workspaceSCM.repoSCMs[0].repository;
  }

  return graphRepo;
}

// This method is called when your extension is deactivated
export function deactivate() {}
