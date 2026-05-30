import { Context, Duration, Effect, Ref, Schedule, Stream } from "effect";
import { JJCli } from "./JJCli";
import type { ExtensionResources } from "./ExtensionResources";
import type { Vscode } from "./Vscode";
import { logger } from "../logger";

/** jj layered config key (repo-local overrides apply when cwd is the repo). */
export const JJ_WATCHMAN_REGISTER_SNAPSHOT_TRIGGER_KEY =
  "fsmonitor.watchman.register-snapshot-trigger";

/**
 * Latest observed value of {@link JJ_WATCHMAN_REGISTER_SNAPSHOT_TRIGGER_KEY}.
 * Updated on an independent {@link Schedule} in a background fiber; readers
 * (e.g. poll / event loop) share it via `yield*` like {@link RepoStateRef}.
 */
export class JjWatchmanRegisterSnapshotTriggerRef extends Context.Tag(
  "JjWatchmanRegisterSnapshotTriggerRef",
)<JjWatchmanRegisterSnapshotTriggerRef, Ref.Ref<boolean>>() {}

export function parseJjConfigBoolOutput(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}

const refreshWatchmanRegisterSnapshotTriggerOnce = Effect.gen(function* () {
  const cli = yield* JJCli;
  const ref = yield* JjWatchmanRegisterSnapshotTriggerRef;
  const output = yield* cli
    .run(["config", "get", JJ_WATCHMAN_REGISTER_SNAPSHOT_TRIGGER_KEY], {
      ignoreWorkingCopy: true,
      timeout: 10_000,
    })
    .pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          logger.debug(
            `jj config get ${JJ_WATCHMAN_REGISTER_SNAPSHOT_TRIGGER_KEY} failed: ${String(e)}`,
          );
          return "";
        }),
      ),
    );
  yield* Ref.set(ref, parseJjConfigBoolOutput(output));
});

/**
 * Runs until interrupted: {@link Schedule.spaced} ticks drive polls so jj
 * config can change outside the workspace without file watchers. Same
 * {@link Ref} is provided in the repo Layer as
 * {@link JjWatchmanRegisterSnapshotTriggerRef}.
 */
export const watchmanRegisterSnapshotTriggerPollLoop: Effect.Effect<
  void,
  never,
  JJCli | JjWatchmanRegisterSnapshotTriggerRef | Vscode | ExtensionResources
> = Stream.fromSchedule(Schedule.spaced(Duration.minutes(2))).pipe(
  Stream.runForEach(() => refreshWatchmanRegisterSnapshotTriggerOnce),
);

/** Prime the ref before starting the spaced loop (first spaced delay otherwise waits). */
export const watchmanRegisterSnapshotTriggerInitialRefresh: Effect.Effect<
  void,
  never,
  JJCli | JjWatchmanRegisterSnapshotTriggerRef | Vscode | ExtensionResources
> = refreshWatchmanRegisterSnapshotTriggerOnce;
