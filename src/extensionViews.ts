import * as vscode from "vscode";
import { Effect, Scope } from "effect";
import { JJGraphWebview, parseJJLog } from "./graphWebview";
import { OperationLogManager } from "./operationLogTreeView";
import {
  getOperationLog,
  getShow,
  jjEdit,
  jjNew,
  log,
} from "./services/Repository";
import type { RepoHandle } from "./repoHandle";
import type { SelectedRepositoryController } from "./selectedRepository";
import type { Vscode } from "./services/Vscode";
import { getActiveTextEditor } from "./services/Vscode";
import { setupAnnotations } from "./annotations";
import type { RepoEffectEnv, RepoCommandEffect } from "./commandHandlerShared";

export interface ExtensionViews {
  readonly graphWebview: JJGraphWebview | undefined;
  readonly operationLogManager: OperationLogManager | undefined;
  readonly getLastOpenedFileUri: () => vscode.Uri | undefined;
  readonly markGitFetchStarted: () => void;
  readonly refreshGitFetchStatus: () => Effect.Effect<void, Error, Vscode>;
}

export interface InitializeExtensionViewsDeps {
  readonly extensionUri: vscode.Uri;
  readonly repos: () => readonly RepoHandle[];
  readonly selectedRepoController: SelectedRepositoryController;
  readonly findRepoByUri: (uri: vscode.Uri) => RepoHandle | undefined;
  readonly registerScoped: <A extends { dispose(): unknown }>(
    acquire: () => A,
  ) => Promise<A>;
  readonly runInExtensionScope: <A, E>(
    effect: Effect.Effect<A, E, Vscode | Scope.Scope>,
  ) => Promise<A>;
  readonly dispatchExtensionEffect: (
    effect: Effect.Effect<unknown, Error, Vscode>,
    errorLabel: string,
  ) => void;
  readonly runRepoCommand: (
    repo: RepoHandle,
    effect: RepoCommandEffect,
    errorLabel: string,
  ) => Promise<void>;
  readonly runRepoEffect: <A, E>(
    repo: RepoHandle,
    effect: Effect.Effect<A, E, RepoEffectEnv>,
  ) => Effect.Effect<A, Error>;
  readonly retryImmutable: <A>(
    effect: RepoCommandEffect<A>,
    confirmPrompt: string,
    retryEffect: RepoCommandEffect<A>,
  ) => RepoCommandEffect<A | undefined>;
  readonly setGraphNodesSelectedContext: (count: number) => Promise<void>;
}

export async function initializeExtensionViews(
  deps: InitializeExtensionViewsDeps,
): Promise<ExtensionViews | undefined> {
  if (deps.repos().length === 0) {
    return undefined;
  }

  const initialSelectedRepo = deps.selectedRepoController.getSelectedRepo();
  if (!initialSelectedRepo) {
    return undefined;
  }

  let lastOpenedFileUri: vscode.Uri | undefined;

  const loadGraphRenderData = async (
    repo: RepoHandle,
  ): Promise<{
    changes: ReturnType<typeof parseJJLog>;
    workingCopyId: string;
  }> =>
    repo.runPromise(
      Effect.gen(function* () {
        const logOutput = yield* log(repo.config);
        const parentOutput = yield* log(
          repo.config,
          "::",
          `
          if(root,
            "root()",
            concat(
              self.change_id().short(),
              " ",
              parents.map(|p| p.change_id().short()).join(" "),
              "\n"
            )
          )
          `,
          50,
          false,
        );

        const changes = JJGraphWebview.addParentIds(
          parseJJLog(logOutput),
          parentOutput,
        );
        return {
          changes,
          workingCopyId: repo.currentState.status?.workingCopy.changeId ?? "",
        };
      }),
    );

  const requestGraphChangeDetails = async (
    repo: RepoHandle,
    changeId: string,
  ): Promise<
    | {
        fullDescription: string;
        stats: {
          total: number;
          added: number;
          modified: number;
          removed: number;
          renamed: number;
          copied: number;
        };
      }
    | undefined
  > =>
    repo
      .runPromise(
        getShow(repo.config, changeId).pipe(
          Effect.map((showResult) => ({
            fullDescription:
              showResult.change.description || "(no description set)",
            stats: {
              total: showResult.fileStatuses.length,
              added: showResult.fileStatuses.filter((file) => file.type === "A")
                .length,
              modified: showResult.fileStatuses.filter(
                (file) => file.type === "M",
              ).length,
              removed: showResult.fileStatuses.filter(
                (file) => file.type === "D",
              ).length,
              renamed: showResult.fileStatuses.filter(
                (file) => file.type === "R",
              ).length,
              copied: showResult.fileStatuses.filter(
                (file) => file.type === "C",
              ).length,
            },
          })),
        ),
      )
      .catch(() => undefined);

  const graphWebview = new JJGraphWebview(
    deps.extensionUri,
    initialSelectedRepo,
    {
      loadGraph: loadGraphRenderData,
      editChange: (repo, changeId) =>
        deps.runRepoCommand(
          repo,
          deps.retryImmutable(
            jjEdit(repo.config, changeId),
            "The change is immutable. Edit anyway?",
            jjEdit(repo.config, changeId, true),
          ),
          "Failed to switch to change",
        ),
      newChangeFrom: (repo, changeId) =>
        deps.runRepoCommand(
          repo,
          jjNew(repo.config, undefined, [changeId]),
          "Failed to create change",
        ),
      requestChangeDetails: requestGraphChangeDetails,
      setNodesSelectedContext: deps.setGraphNodesSelectedContext,
    },
  );

  await deps.registerScoped(() =>
    vscode.window.registerWebviewViewProvider("jjGraphWebview", graphWebview, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );
  await deps.registerScoped(() =>
    deps.selectedRepoController.onDidChange((repo) => {
      deps.dispatchExtensionEffect(
        Effect.promise(
          () => graphWebview?.setSelectedRepository(repo) ?? Promise.resolve(),
        ),
        "Failed to update graph repository selection",
      );
    }),
  );

  const operationLogManager = await deps.registerScoped(
    () =>
      new OperationLogManager({
        initialRepo: initialSelectedRepo,
        loadOperations: (repo) => repo.runPromise(getOperationLog(repo.config)),
      }),
  );
  await deps.registerScoped(() =>
    deps.selectedRepoController.onDidChange((repo) => {
      deps.dispatchExtensionEffect(
        Effect.promise(
          () => operationLogManager?.setSelectedRepo(repo) ?? Promise.resolve(),
        ),
        "Failed to update operation log repository selection",
      );
    }),
  );

  const statusBarItem = await deps.registerScoped(() =>
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
  );
  statusBarItem.command = "jj.gitFetch";

  const statusBarHandleDidChangeActiveTextEditor = (
    editor: vscode.TextEditor | undefined,
  ) => {
    if (editor && editor.document.uri.scheme === "file") {
      lastOpenedFileUri = editor.document.uri;
      const repo = deps.findRepoByUri(lastOpenedFileUri);
      if (repo) {
        const folderName = repo.config.repositoryRoot.split("/").at(-1)!;
        statusBarItem.text = "$(cloud-download)";
        statusBarItem.tooltip = `${folderName} – Run \`jj git fetch\``;
        statusBarItem.show();
      }
    }
  };
  await deps.registerScoped(() =>
    vscode.window.onDidChangeActiveTextEditor(
      statusBarHandleDidChangeActiveTextEditor,
    ),
  );
  deps.dispatchExtensionEffect(
    getActiveTextEditor().pipe(
      Effect.tap((editor) =>
        Effect.sync(() => {
          statusBarHandleDidChangeActiveTextEditor(editor);
        }),
      ),
    ),
    "Failed to initialize git fetch status bar",
  );

  await setupAnnotations({
    registerScoped: deps.registerScoped,
    runInExtensionScope: deps.runInExtensionScope,
    dispatchExtensionEffect: deps.dispatchExtensionEffect,
    findRepoByUri: deps.findRepoByUri,
    runRepoEffect: deps.runRepoEffect,
  });

  return {
    graphWebview,
    operationLogManager,
    getLastOpenedFileUri: () => lastOpenedFileUri,
    markGitFetchStarted: () => {
      statusBarItem.text = "$(sync~spin)";
      statusBarItem.tooltip = "Fetching...";
    },
    refreshGitFetchStatus: () =>
      getActiveTextEditor().pipe(
        Effect.tap((editor) =>
          Effect.sync(() => {
            statusBarHandleDidChangeActiveTextEditor(editor);
          }),
        ),
      ),
  };
}
