import * as vscode from "vscode";
import { Effect, Ref, Scope } from "effect";
import type { RepoHandle } from "./repoHandle";
import { scopedDisposable } from "./effectUtils";

export interface SelectedRepositoryController {
  readonly onDidChange: vscode.Event<RepoHandle>;
  readonly getSelectedRepo: () => RepoHandle | undefined;
  readonly setSelectedRepo: (repo: RepoHandle) => Effect.Effect<void, Error>;
  readonly reconcileSelection: () => Effect.Effect<void, Error>;
}

export interface SelectedRepositoryControllerDeps {
  readonly repos: () => readonly RepoHandle[];
  readonly initialSelectedRoot: string | undefined;
  readonly persistSelectedRoot: (
    root: string | undefined,
  ) => Effect.Effect<void, Error>;
}

export const makeSelectedRepositoryController = (
  deps: SelectedRepositoryControllerDeps,
): Effect.Effect<SelectedRepositoryController, never, Scope.Scope> =>
  Effect.gen(function* () {
    const selectedRootRef = yield* Ref.make(deps.initialSelectedRoot);
    let currentSelectedRoot = deps.initialSelectedRoot;
    const onDidChangeEmitter = yield* scopedDisposable(
      () => new vscode.EventEmitter<RepoHandle>(),
    );

    const resolveSelectedRepo = (
      selectedRoot: string | undefined,
    ): RepoHandle | undefined => {
      const repos = deps.repos();
      if (repos.length === 0) {
        return undefined;
      }

      if (!selectedRoot) {
        return repos[0];
      }

      return (
        repos.find((repo) => repo.config.repositoryRoot === selectedRoot) ??
        repos[0]
      );
    };

    const emitIfChanged = (
      previousRepo: RepoHandle | undefined,
      nextRepo: RepoHandle | undefined,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        if (
          nextRepo &&
          previousRepo?.config.repositoryRoot !== nextRepo.config.repositoryRoot
        ) {
          onDidChangeEmitter.fire(nextRepo);
        }
      });

    return {
      onDidChange: onDidChangeEmitter.event,
      getSelectedRepo: () => resolveSelectedRepo(currentSelectedRoot),
      setSelectedRepo: (repo) =>
        Effect.gen(function* () {
          const previousRoot = yield* Ref.get(selectedRootRef);
          const previousRepo = resolveSelectedRepo(previousRoot);
          yield* Ref.set(selectedRootRef, repo.config.repositoryRoot);
          currentSelectedRoot = repo.config.repositoryRoot;
          yield* deps.persistSelectedRoot(repo.config.repositoryRoot);
          yield* emitIfChanged(previousRepo, repo);
        }),
      reconcileSelection: () =>
        Effect.gen(function* () {
          const previousRoot = yield* Ref.get(selectedRootRef);
          const previousRepo = resolveSelectedRepo(previousRoot);
          const nextRepo = resolveSelectedRepo(previousRoot);
          const nextRoot = nextRepo?.config.repositoryRoot;

          if (previousRoot !== nextRoot) {
            yield* Ref.set(selectedRootRef, nextRoot);
            currentSelectedRoot = nextRoot;
            yield* deps.persistSelectedRoot(nextRoot);
          }

          yield* emitIfChanged(previousRepo, nextRepo);
        }),
    };
  });
