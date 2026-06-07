import * as vscode from "vscode";
import { Effect } from "effect";
import type { ManagedRuntime } from "effect";
import type { JJCli } from "./services/JJCli";
import type { ExtensionResources } from "./services/ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./services/JjWatchmanSnapshotTriggerRef";
import type { Vscode } from "./services/Vscode";
import {
  showErrorMessage,
  showQuickPick,
  withProgress,
} from "./services/Vscode";
import { JJImmutableError } from "./types";
import type { JJCliError } from "./types";
import type { RepoHandle } from "./repoHandle";

export const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

type RunRepoCommandEnv =
  | JJCli
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef;

export const retryImmutable = <A>(
  effect: Effect.Effect<
    A,
    JJCliError | JJImmutableError | Error,
    RunRepoCommandEnv
  >,
  confirmPrompt: string,
  retryEffect: Effect.Effect<
    A,
    JJCliError | JJImmutableError | Error,
    RunRepoCommandEnv
  >,
): Effect.Effect<
  A | undefined,
  JJCliError | JJImmutableError | Error,
  RunRepoCommandEnv
> =>
  effect.pipe(
    Effect.catchTag(
      "JJImmutableError",
      (): Effect.Effect<
        A | undefined,
        JJCliError | JJImmutableError | Error,
        RunRepoCommandEnv
      > =>
        Effect.gen(function* () {
          const choice = yield* showQuickPick(["Continue"], {
            title: confirmPrompt,
          });
          if (!choice) {
            return undefined as A | undefined;
          }
          return yield* retryEffect;
        }),
    ),
  );

export const createExtensionEffectRunner = (
  extensionRuntime: ManagedRuntime.ManagedRuntime<Vscode, never>,
) => {
  const runExtensionEffect = async <A>(
    effect: Effect.Effect<A, Error, Vscode>,
    errorLabel: string,
  ): Promise<A | undefined> => {
    try {
      return await extensionRuntime.runPromise(effect);
    } catch (err) {
      void extensionRuntime.runPromise(
        showErrorMessage(
          `${errorLabel}${err instanceof Error ? `: ${err.message}` : ""}`,
        ),
      );
      return undefined;
    }
  };

  const dispatchExtensionEffect = (
    effect: Effect.Effect<unknown, Error, Vscode>,
    errorLabel: string,
  ): void => {
    void runExtensionEffect(effect, errorLabel);
  };

  return {
    runExtensionEffect,
    dispatchExtensionEffect,
  };
};

export const runRepoCommand = (
  repo: RepoHandle,
  effect: Effect.Effect<
    unknown,
    JJCliError | JJImmutableError | Error,
    RunRepoCommandEnv
  >,
  errorLabel: string,
): Promise<void> =>
  repo.runPromise(Effect.asVoid(effect)).catch((err) => {
    void repo.runPromise(
      showErrorMessage(
        `${errorLabel}${err instanceof Error ? `: ${err.message}` : ""}`,
      ),
    );
  });

export const runRepoEffect = <A, E>(
  repo: RepoHandle,
  effect: Effect.Effect<A, E, RunRepoCommandEnv>,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => repo.runPromise(effect),
    catch: toError,
  });

export const withSourceControlProgress = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Vscode> =>
  withProgress({ location: vscode.ProgressLocation.SourceControl }, effect);
