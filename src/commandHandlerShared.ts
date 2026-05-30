import * as vscode from "vscode";
import { Effect } from "effect";
import type { JJCli } from "./services/JJCli";
import type { ExtensionResources } from "./services/ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./services/JjWatchmanSnapshotTriggerRef";
import type { Vscode } from "./services/Vscode";
import { showQuickPick } from "./services/Vscode";
import type { RepoHandle } from "./repoHandle";
import type { JJGraphWebview } from "./graphWebview";
import type { OperationLogManager } from "./operationLogTreeView";
import type { SelectedRepositoryController } from "./selectedRepository";
import type { RepoLocator } from "./repoLocator";
import type { RepoState } from "./services/RepoState";
import { JJImmutableError } from "./types";
import type { JJCliError } from "./types";

export type RepoEffectEnv =
  | JJCli
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef;
export type RepoCommandEffect<A = unknown> = Effect.Effect<
  A,
  JJCliError | JJImmutableError | Error,
  RepoEffectEnv
>;

export type RepoEffectRunner = <A, E>(
  repo: RepoHandle,
  effect: Effect.Effect<A, E, RepoEffectEnv>,
) => Effect.Effect<A, Error>;

export type RepoCommandRunner = (
  repo: RepoHandle,
  effect: RepoCommandEffect,
  errorLabel: string,
) => Promise<void>;

export type ExtensionEffectRunner = <A>(
  effect: Effect.Effect<A, Error, Vscode>,
  errorLabel: string,
) => Promise<A | undefined>;

export type ExtensionEffectDispatcher = (
  effect: Effect.Effect<unknown, Error, Vscode>,
  errorLabel: string,
) => void;

export type SourceControlProgress = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Vscode>;

export interface CommandHandlerDeps {
  readonly repos: () => readonly RepoHandle[];
  readonly repoLocator: RepoLocator;
  readonly selectedRepoController: Pick<
    SelectedRepositoryController,
    "setSelectedRepo"
  >;
  readonly getGraphWebview: () => JJGraphWebview | undefined;
  readonly getOperationLogManager: () => OperationLogManager | undefined;
  readonly getLastOpenedFileUri: () => vscode.Uri | undefined;
  readonly markGitFetchStarted: () => void;
  readonly refreshGitFetchStatus: () => Effect.Effect<void, Error, Vscode>;
  readonly syncReposWithWorkspaceFolders: () => Effect.Effect<
    void,
    never,
    Vscode
  >;
  readonly poll: () => Effect.Effect<void, never, Vscode>;
  readonly getCheckColocatedReposEffect: () =>
    | Effect.Effect<void, Error, Vscode>
    | undefined;
  readonly runExtensionEffect: ExtensionEffectRunner;
  readonly dispatchExtensionEffect: ExtensionEffectDispatcher;
  readonly runRepoCommand: RepoCommandRunner;
  readonly runRepoEffect: RepoEffectRunner;
  readonly retryImmutable: <A>(
    effect: RepoCommandEffect<A>,
    confirmPrompt: string,
    retryEffect: RepoCommandEffect<A>,
  ) => RepoCommandEffect<A | undefined>;
  readonly withSourceControlProgress: SourceControlProgress;
}

export const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const readRepoState = (repo: RepoHandle): RepoState => repo.currentState;

export const selectRepositoryEffect = (
  deps: CommandHandlerDeps,
): Effect.Effect<void, Error, Vscode> =>
  Effect.gen(function* () {
    const repoNames = deps.repos().map((repo) => repo.config.repositoryRoot);
    const selectedRepoName = yield* showQuickPick(repoNames, {
      placeHolder: "Select a repository",
    });
    const selectedRepo = deps
      .repos()
      .find((repo) => repo.config.repositoryRoot === selectedRepoName);
    if (selectedRepo) {
      yield* deps.selectedRepoController.setSelectedRepo(selectedRepo);
    }
  });
