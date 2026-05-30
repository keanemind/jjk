import { Duration, Effect, Queue, Stream } from "effect";
import { JJCli } from "./services/JJCli";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./services/JjWatchmanSnapshotTriggerRef";
import type { ExtensionResources } from "./services/ExtensionResources";
import { checkForUpdates, RepoStateRef } from "./services/RepoState";
import type { RepoState } from "./services/RepoState";
import type { Vscode } from "./services/Vscode";
import type { RepositoryConfig } from "./types";
import { logger } from "./logger";

export interface RepoEventLoopDeps {
  repoConfig: RepositoryConfig;
  watcherStream: Stream.Stream<void>;
  onStateChanged: (newState: RepoState) => Effect.Effect<void>;
}

export const repoEventLoop = (
  deps: RepoEventLoopDeps,
): Effect.Effect<
  never,
  never,
  | JJCli
  | RepoStateRef
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef
> =>
  Effect.gen(function* () {
    const updateQueue = yield* Queue.unbounded<
      "poll" | "watcher" | "command"
    >();

    // File watcher fiber — feeds the queue
    yield* Effect.fork(
      Stream.runForEach(deps.watcherStream, () =>
        Queue.offer(updateQueue, "watcher"),
      ),
    );

    // Poll fiber — feeds the queue on interval
    yield* Effect.fork(
      Effect.forever(
        Queue.offer(updateQueue, "poll").pipe(
          Effect.delay(Duration.seconds(5)),
        ),
      ),
    );

    // Single consumer — debounced, runs update pipeline
    yield* Stream.fromQueue(updateQueue).pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.runForEach(() =>
        checkForUpdates(deps.repoConfig).pipe(
          Effect.tap((newState) =>
            newState ? deps.onStateChanged(newState) : Effect.void,
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => logger.error(`Update error: ${String(error)}`)),
          ),
        ),
      ),
    );

    return yield* Effect.never;
  });
