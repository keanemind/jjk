import * as vscode from "vscode";
import path from "path";
import { Effect, Fiber, Layer, Ref, Scope, Stream } from "effect";
import type { ManagedRuntime } from "effect";
import { JJCliLive } from "./services/JJCli";
import {
  RepoStateRef,
  emptyRepoState,
  checkForUpdates,
} from "./services/RepoState";
import {
  JjWatchmanRegisterSnapshotTriggerRef,
  watchmanRegisterSnapshotTriggerInitialRefresh,
  watchmanRegisterSnapshotTriggerPollLoop,
} from "./services/JjWatchmanSnapshotTriggerRef";
import type { RepoState } from "./services/RepoState";
import { repoEventLoop } from "./eventLoop";
import { computeRenderData, applyRenderData } from "./render";
import {
  resolveRepoPath,
  discoverRepositoriesEffect,
  provideOriginalResource,
} from "./jjUtils";
import { logger } from "./logger";
import type { RepoHandle } from "./repoHandle";
import type { JJDecorationProvider } from "./decorationProvider";
import type { JJFileSystemProviderNew } from "./fileSystemProviderNew";
import type { Vscode } from "./services/Vscode";
import { setContext } from "./services/Vscode";
import type { ExtensionResources } from "./services/ExtensionResources";
import { closeScope, scopedDisposable } from "./effectUtils";
import type { JJGraphWebview } from "./graphWebview";
import type { OperationLogManager } from "./operationLogTreeView";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export interface RepoLifecycleDeps {
  readonly repos: RepoHandle[];
  readonly runInExtensionScope: <A, E>(
    effect: Effect.Effect<A, E, Vscode | Scope.Scope>,
  ) => Promise<A>;
  readonly extensionRuntime: ManagedRuntime.ManagedRuntime<Vscode, never>;
  readonly extensionResourcesConfig: Parameters<typeof JJCliLive>[1];
  readonly extensionResourcesLayer: Layer.Layer<ExtensionResources>;
  readonly decorationProvider: JJDecorationProvider;
  readonly fileSystemProvider: JJFileSystemProviderNew;
  readonly getGraphWebview: () => JJGraphWebview | undefined;
  readonly getOperationLogManager: () => OperationLogManager | undefined;
  readonly reconcileSelectedRepo: () => Promise<void>;
}

export interface RepoLifecycle {
  readonly initializeDiscoveredRepos: () => Promise<void>;
  readonly syncReposWithWorkspaceFolders: () => Effect.Effect<
    void,
    never,
    Vscode
  >;
  readonly poll: () => Effect.Effect<void, never, Vscode>;
}

export const makeRepoLifecycle = (deps: RepoLifecycleDeps): RepoLifecycle => {
  const applyRepoStateUpdate = (repo: RepoHandle, newState: RepoState) => {
    repo.currentState = newState;
    const renderData = computeRenderData(newState);
    if (renderData) {
      repo.parentGroups = applyRenderData(
        renderData,
        repo.sourceControl,
        repo.workingCopyGroup,
        repo.parentGroups,
      );
    }

    deps.decorationProvider.onRefresh(
      repo.config.repositoryRoot,
      newState.fileStatusesByChange,
      newState.trackedFiles,
      newState.conflictedFilesByChange,
    );
    deps.fileSystemProvider.onDidChangeRepository({
      repositoryRoot: repo.config.repositoryRoot,
    });
    repo.onDidUpdateEmitter.fire();

    const operationLogManager = deps.getOperationLogManager();
    if (
      operationLogManager &&
      operationLogManager.getSelectedRepo().config.repositoryRoot ===
        repo.config.repositoryRoot
    ) {
      void operationLogManager.refresh();
    }

    const graphWebview = deps.getGraphWebview();
    if (
      graphWebview &&
      graphWebview.getSelectedRepo().config.repositoryRoot ===
        repo.config.repositoryRoot
    ) {
      void graphWebview.refresh();
    }
  };

  const initializeRepo = async (info: {
    repoRoot: string;
    jjPath: { filepath: string; source: string };
    jjVersion: string;
  }) => {
    const repo = await deps.runInExtensionScope(
      Effect.gen(function* () {
        const repoScope = yield* Effect.acquireRelease(
          Scope.make(),
          closeScope,
        );
        const config = {
          repositoryRoot: info.repoRoot,
          jjPath: info.jjPath.filepath,
          jjVersion: info.jjVersion,
        };

        const cliLayer = JJCliLive(config, deps.extensionResourcesConfig);
        const stateRef = yield* Ref.make(emptyRepoState);
        const stateRefLayer = Layer.succeed(RepoStateRef, stateRef);
        const watchmanRegisterTriggerRef = yield* Ref.make(false);
        const watchmanTriggerLayer = Layer.succeed(
          JjWatchmanRegisterSnapshotTriggerRef,
          watchmanRegisterTriggerRef,
        );
        const repoLayer = Layer.mergeAll(
          cliLayer,
          stateRefLayer,
          watchmanTriggerLayer,
          deps.extensionResourcesLayer,
        );

        yield* watchmanRegisterSnapshotTriggerInitialRefresh.pipe(
          Effect.provide(repoLayer),
        );

        const sourceControl = yield* Scope.extend(
          scopedDisposable(() =>
            vscode.scm.createSourceControl(
              "jj",
              path.basename(info.repoRoot),
              vscode.Uri.file(info.repoRoot),
            ),
          ),
          repoScope,
        );

        const workingCopyGroup = yield* Scope.extend(
          scopedDisposable(() =>
            sourceControl.createResourceGroup("@", "Working Copy"),
          ),
          repoScope,
        );

        sourceControl.inputBox.placeholder = "Describe new change (Ctrl+Enter)";
        sourceControl.acceptInputCommand = {
          command: "jj.new",
          title: "Create new change",
          arguments: [sourceControl],
        };
        sourceControl.quickDiffProvider = {
          provideOriginalResource,
        };

        const repoPath = resolveRepoPath(info.repoRoot);
        const watcherOperations = yield* Scope.extend(
          scopedDisposable(() =>
            vscode.workspace.createFileSystemWatcher(
              new vscode.RelativePattern(
                path.join(repoPath, "op_store", "operations"),
                "*",
              ),
            ),
          ),
          repoScope,
        );

        const watcherStream = Stream.async<void>((emit) => {
          const handler = () => {
            void emit.single(undefined);
          };
          watcherOperations.onDidCreate(handler);
          watcherOperations.onDidChange(handler);
          watcherOperations.onDidDelete(handler);
        });

        const onDidUpdateEmitter = yield* Scope.extend(
          scopedDisposable(() => new vscode.EventEmitter<void>()),
          repoScope,
        );

        const repo: RepoHandle = {
          config,
          runPromise: (effect) =>
            deps.extensionRuntime.runPromise(
              effect.pipe(Effect.provide(repoLayer)),
            ),
          currentState: emptyRepoState,
          sourceControl,
          workingCopyGroup,
          parentGroups: [],
          onDidUpdateEmitter,
          dispose: () =>
            deps.extensionRuntime.runPromise(closeScope(repoScope)),
        };

        const onStateChanged = (newState: RepoState): Effect.Effect<void> =>
          Effect.sync(() => applyRepoStateUpdate(repo, newState));

        yield* Scope.extend(
          Effect.acquireRelease(
            Effect.sync(() =>
              deps.extensionRuntime.runFork(
                repoEventLoop({
                  repoConfig: config,
                  watcherStream,
                  onStateChanged,
                }).pipe(Effect.provide(repoLayer)),
              ),
            ),
            Fiber.interrupt,
          ),
          repoScope,
        );

        yield* Scope.extend(
          Effect.acquireRelease(
            Effect.sync(() =>
              deps.extensionRuntime.runFork(
                watchmanRegisterSnapshotTriggerPollLoop.pipe(
                  Effect.provide(repoLayer),
                ),
              ),
            ),
            Fiber.interrupt,
          ),
          repoScope,
        );

        return repo;
      }),
    );

    deps.repos.push(repo);
    logger.info(
      `Initialized jjk for ${info.repoRoot}. Using ${info.jjVersion} at ${info.jjPath.filepath} (${info.jjPath.source}).`,
    );
  };

  /**
   * Performs full workspace repository discovery and reconciles open handles.
   *
   * This is intentionally used for activation, workspace-folder changes, manual
   * refreshes, and repository-discovery setting changes. It may probe many
   * workspace children, so steady-state polling should refresh known repos
   * instead of calling this on every interval.
   */
  const syncReposWithWorkspaceFolders = () =>
    Effect.gen(function* () {
      const currentRepoInfos = yield* discoverRepositoriesEffect();
      const currentRoots = new Set(
        [...currentRepoInfos.values()].map((info) => info.repoRoot),
      );

      for (let i = deps.repos.length - 1; i >= 0; i--) {
        const repo = deps.repos[i];
        if (!currentRoots.has(repo.config.repositoryRoot)) {
          logger.info(`Removing repo ${repo.config.repositoryRoot}`);
          yield* Effect.promise(() => repo.dispose()).pipe(
            Effect.catchAllCause((cause) => {
              logger.error(
                `Failed to dispose repo ${repo.config.repositoryRoot}: ${String(cause)}`,
              );
              return Effect.void;
            }),
          );
          deps.repos.splice(i, 1);
        }
      }

      for (const [, info] of currentRepoInfos) {
        if (
          deps.repos.some(
            (repo) => repo.config.repositoryRoot === info.repoRoot,
          )
        ) {
          continue;
        }
        logger.info(`Discovered new repo ${info.repoRoot}`);
        yield* Effect.promise(() => initializeRepo(info)).pipe(
          Effect.catchAllCause((cause) => {
            logger.error(
              `Failed to initialize repo ${info.repoRoot}: ${String(cause)}`,
            );
            return Effect.void;
          }),
        );
      }

      yield* setContext("jj.reposExist", deps.repos.length > 0).pipe(
        Effect.catchAll(() => Effect.void),
      );

      yield* Effect.tryPromise({
        try: () => deps.reconcileSelectedRepo(),
        catch: toError,
      }).pipe(Effect.catchAll(() => Effect.void));

      yield* Effect.sync(() => {
        deps.decorationProvider.removeStaleRepositories(
          deps.repos.map((repo) => repo.config.repositoryRoot),
        );
      });
    });

  /**
   * Refreshes already-open repositories without scanning workspace children.
   *
   * Repository refresh has two different costs. Full discovery scans workspace
   * roots, configured scan paths, and bounded subfolders to find new repos.
   * Known-repo refresh only updates existing repo state, which is cheap enough
   * for periodic polling. If no repos are open yet, still run full discovery so
   * a repo initialized or cloned after activation can appear without reload.
   */
  const poll = () =>
    deps.repos.length === 0
      ? syncReposWithWorkspaceFolders()
      : Effect.forEach(
          deps.repos,
          (repo) =>
            Effect.promise(() =>
              repo.runPromise(
                checkForUpdates(repo.config).pipe(
                  Effect.tap((state) => {
                    if (!state) {
                      return Effect.void;
                    }
                    return Effect.sync(() => applyRepoStateUpdate(repo, state));
                  }),
                ),
              ),
            ).pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  logger.error(
                    `Update error for ${repo.config.repositoryRoot}: ${String(cause)}`,
                  );
                }),
              ),
            ),
          { discard: true },
        );

  return {
    initializeDiscoveredRepos: async () => {
      const repoInfos = await deps.runInExtensionScope(
        discoverRepositoriesEffect(),
      );
      for (const [, info] of repoInfos) {
        await initializeRepo(info);
      }
    },
    syncReposWithWorkspaceFolders,
    poll,
  };
};
