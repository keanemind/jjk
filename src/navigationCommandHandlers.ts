import * as vscode from "vscode";
import path from "path";
import { Effect } from "effect";
import type { InitCommandHandlers, GlobalCommandHandlers } from "./commands";
import type {
  CommandHandlerDeps,
  RepoCommandEffect,
} from "./commandHandlerShared";
import { selectRepositoryEffect, toError } from "./commandHandlerShared";
import { executeCommand, showQuickPick } from "./services/Vscode";
import {
  getShow,
  gitFetch,
  jjNew,
  log,
  operationRestore,
  operationUndo,
} from "./services/Repository";
import { getActiveTextEditorDiff, pathEquals } from "./utils";
import { getParams, toJJUri } from "./uri";
import { provideOriginalResource } from "./jjUtils";
import { OperationTreeItem } from "./operationLogTreeView";

const getCurrentRev = (uri: vscode.Uri): string => {
  if (uri.scheme !== "jj") {
    return "@";
  }

  const params = getParams(uri);
  return "diffOriginalRev" in params ? params.diffOriginalRev : params.rev;
};

const pickRelatedChange = (
  repo: Parameters<CommandHandlerDeps["runRepoCommand"]>[0],
  uri: vscode.Uri,
  revsetSuffix: "+" | "-",
  direction: "Parent" | "Child",
): RepoCommandEffect<string | undefined> =>
  Effect.gen(function* () {
    const icon = direction === "Parent" ? "arrow-down" : "arrow-up";
    const changesOutput = yield* log(
      repo.config,
      `all:${getCurrentRev(uri)}${revsetSuffix}`,
      'change_id ++ "\\n"',
      undefined,
      true,
    );
    const changes = changesOutput.trim().split("\n").filter(Boolean);
    if (changes.length === 0) {
      return undefined;
    }
    if (changes.length === 1) {
      return changes[0];
    }

    const items: ({ changeId: string } & vscode.QuickPickItem)[] =
      yield* Effect.forEach(changes, (changeId) =>
        Effect.map(getShow(repo.config, changeId), (show) => ({
          label: `$(${icon}) ${direction}: ${changeId.substring(0, 8)}`,
          description: show.change.description || "(no description)",
          alwaysShow: true,
          changeId,
        })),
      );
    const selection = yield* showQuickPick(items, {
      placeHolder: `Select ${direction.toLowerCase()} change to open`,
    });
    return selection?.changeId;
  });

const openRelatedChangeEffect = (
  deps: CommandHandlerDeps,
  uri: vscode.Uri,
  revsetSuffix: "+" | "-",
  direction: "Parent" | "Child",
): Effect.Effect<void, Error, import("./services/Vscode").Vscode> => {
  if (!["file", "jj"].includes(uri.scheme)) {
    return Effect.void;
  }

  const repo = deps.repoLocator.findRepoByUri(uri);
  if (!repo) {
    return Effect.void;
  }

  return deps.runRepoEffect(
    repo,
    Effect.gen(function* () {
      const selectedChange = yield* pickRelatedChange(
        repo,
        uri,
        revsetSuffix,
        direction,
      );
      if (!selectedChange) {
        return;
      }

      if (getActiveTextEditorDiff()) {
        yield* executeCommand(
          "vscode.diff",
          toJJUri(uri, { diffOriginalRev: selectedChange }),
          toJJUri(uri, { rev: selectedChange }),
          `${path.basename(uri.fsPath)} (${selectedChange.substring(0, 8)})`,
        );
        return;
      }

      yield* executeCommand(
        "vscode.open",
        toJJUri(uri, { rev: selectedChange }),
        {},
        `${path.basename(uri.fsPath)} (${selectedChange.substring(0, 8)})`,
      );
    }),
  );
};

export const createNavigationInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<
  InitCommandHandlers,
  | "openFileResourceState"
  | "openFileEditor"
  | "openDiffEditor"
  | "refreshGraphWebview"
  | "newGraphWebview"
  | "selectGraphWebviewRepo"
  | "refreshOperationLog"
  | "selectOperationLogRepo"
  | "operationUndo"
  | "operationRestore"
  | "gitFetch"
  | "openParentChange"
  | "openChildChange"
  | "viewChange"
  | "openChangeFileDiff"
> => ({
  openFileResourceState: (resourceState) =>
    deps.runExtensionEffect(
      executeCommand(
        "vscode.open",
        vscode.Uri.file(resourceState.resourceUri.fsPath),
        {
          preserveFocus: false,
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
        },
      ),
      "Failed to open file",
    ),
  openFileEditor: (uri) => {
    if (!["file", "jj"].includes(uri.scheme)) {
      return;
    }

    const rev = getCurrentRev(uri);
    return deps.runExtensionEffect(
      executeCommand(
        "vscode.open",
        uri,
        {},
        `${path.basename(uri.fsPath)} (${rev.substring(0, 8)})`,
      ),
      "Failed to open file",
    );
  },
  openDiffEditor: (uri) => {
    const originalUri = provideOriginalResource(uri);
    if (!originalUri) {
      return;
    }

    const params = getParams(originalUri);
    if (!("diffOriginalRev" in params)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(originalUri);
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      Effect.gen(function* () {
        const showResult = yield* getShow(repo.config, params.diffOriginalRev);
        const fileStatus = showResult.fileStatuses.find((file) =>
          pathEquals(file.path, originalUri.path),
        );
        const diffTitleSuffix =
          params.diffOriginalRev === "@"
            ? "(Working Copy)"
            : `(${params.diffOriginalRev.substring(0, 8)})`;
        yield* executeCommand(
          "vscode.diff",
          originalUri,
          uri,
          (fileStatus?.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
            `${path.relative(repo.config.repositoryRoot, originalUri.path)} ${diffTitleSuffix}`,
        );
      }),
      "Failed to open diff",
    );
  },
  refreshGraphWebview: () =>
    deps.runExtensionEffect(
      (() => {
        const graphWebview = deps.getGraphWebview();
        return graphWebview
          ? Effect.tryPromise({
              try: () => graphWebview.refresh(),
              catch: toError,
            })
          : Effect.void;
      })(),
      "Failed to refresh graph",
    ),
  newGraphWebview: () => {
    deps.dispatchExtensionEffect(
      Effect.gen(function* () {
        const graphWebview = deps.getGraphWebview();
        if (!graphWebview) {
          return;
        }

        const selectedNodes = graphWebview.getSelectedNodes();
        if (selectedNodes.length === 0) {
          return;
        }

        const selectedRepo = graphWebview.getSelectedRepo();
        yield* deps
          .runRepoEffect(
            selectedRepo,
            jjNew(selectedRepo.config, undefined, [...selectedNodes]),
          )
          .pipe(Effect.asVoid);
      }),
      "Failed to create change",
    );
  },
  selectGraphWebviewRepo: () =>
    deps.runExtensionEffect(
      selectRepositoryEffect(deps),
      "Failed to select repository",
    ),
  refreshOperationLog: () =>
    deps.runExtensionEffect(
      (() => {
        const operationLogManager = deps.getOperationLogManager();
        return operationLogManager
          ? Effect.tryPromise({
              try: () => operationLogManager.refresh(),
              catch: toError,
            })
          : Effect.void;
      })(),
      "Failed to refresh operation log",
    ),
  selectOperationLogRepo: () =>
    deps.runExtensionEffect(
      selectRepositoryEffect(deps),
      "Failed to select repository",
    ),
  operationUndo: (item) => {
    if (!(item instanceof OperationTreeItem)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(
      vscode.Uri.file(item.repositoryRoot),
    );
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      operationUndo(repo.config, item.operation.id),
      "Failed to undo operation",
    );
  },
  operationRestore: (item) => {
    if (!(item instanceof OperationTreeItem)) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(
      vscode.Uri.file(item.repositoryRoot),
    );
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      operationRestore(repo.config, item.operation.id),
      "Failed to restore operation",
    );
  },
  gitFetch: () => {
    deps.dispatchExtensionEffect(
      Effect.gen(function* () {
        const lastOpenedFileUri = deps.getLastOpenedFileUri();
        if (!lastOpenedFileUri) {
          return;
        }

        const repo = deps.repoLocator.findRepoByUri(lastOpenedFileUri);
        if (!repo) {
          return;
        }

        yield* Effect.sync(() => {
          deps.markGitFetchStarted();
        });

        yield* deps
          .runRepoEffect(repo, gitFetch(repo.config))
          .pipe(Effect.asVoid);
      }).pipe(
        Effect.ensuring(
          deps.refreshGitFetchStatus().pipe(Effect.catchAll(() => Effect.void)),
        ),
      ),
      "Failed to fetch from remote",
    );
  },
  openParentChange: (uri) => {
    deps.dispatchExtensionEffect(
      openRelatedChangeEffect(deps, uri, "-", "Parent"),
      "Failed to open parent change",
    );
  },
  openChildChange: (uri) => {
    deps.dispatchExtensionEffect(
      openRelatedChangeEffect(deps, uri, "+", "Child"),
      "Failed to open child change",
    );
  },
  viewChange: (repositoryRoot, changeId) => {
    const repo = deps.repoLocator.findRepoByUri(
      vscode.Uri.file(repositoryRoot),
    );
    if (!repo) {
      return;
    }

    return deps.runRepoCommand(
      repo,
      Effect.gen(function* () {
        const showResult = yield* getShow(repo.config, changeId);
        const resources = showResult.fileStatuses.map((fileStatus) => {
          const fileUri = vscode.Uri.file(fileStatus.path);
          return [
            fileUri,
            fileStatus.type === "A"
              ? undefined
              : toJJUri(fileUri, { diffOriginalRev: changeId }),
            fileStatus.type === "D"
              ? undefined
              : toJJUri(fileUri, { rev: changeId }),
          ];
        });
        yield* executeCommand(
          "vscode.changes",
          `Changes in ${changeId.substring(0, 8)}`,
          resources,
        );
      }),
      "Failed to view change",
    );
  },
  openChangeFileDiff: (changeId, fsPath, line) => {
    const fileUri = vscode.Uri.file(fsPath);
    const options: vscode.TextDocumentShowOptions | undefined =
      line !== undefined
        ? { selection: new vscode.Range(line, 0, line, 0) }
        : undefined;
    return deps.runExtensionEffect(
      executeCommand(
        "vscode.diff",
        toJJUri(fileUri, { diffOriginalRev: changeId }),
        toJJUri(fileUri, { rev: changeId }),
        `${path.basename(fsPath)} (${changeId.substring(0, 8)})`,
        options,
      ),
      "Failed to open changes",
    );
  },
});

export const createWorkspaceCommandHandlers = (
  deps: CommandHandlerDeps,
): GlobalCommandHandlers => ({
  refresh: () =>
    deps.runExtensionEffect(
      deps.withSourceControlProgress(
        deps.syncReposWithWorkspaceFolders().pipe(Effect.zipRight(deps.poll())),
      ),
      "Failed to refresh",
    ),
  openFolderGitSettings: (repoPath) => {
    if (!repoPath) {
      return;
    }

    return deps.runExtensionEffect(
      Effect.gen(function* () {
        yield* executeCommand("workbench.action.openSettings", {
          query: "git.enabled",
        });
        yield* executeCommand(
          "_workbench.action.openFolderSettings",
          vscode.Uri.file(repoPath),
        );
      }),
      "Failed to open folder Git settings",
    );
  },
  checkColocatedRepos: () => {
    deps.dispatchExtensionEffect(
      deps.getCheckColocatedReposEffect() ?? Effect.void,
      "Failed to check colocated repositories",
    );
  },
  openFileInWorkingCopyResourceState: (resourceState) =>
    deps.runExtensionEffect(
      executeCommand(
        "vscode.open",
        vscode.Uri.file(resourceState.resourceUri.fsPath),
        {},
      ),
      "Failed to open file",
    ),
  openFileInWorkingCopyEditor: (uri) =>
    deps.runExtensionEffect(
      executeCommand("vscode.open", vscode.Uri.file(uri.fsPath), {}),
      "Failed to open file",
    ),
});
