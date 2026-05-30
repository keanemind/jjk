import { Context, Effect, Ref } from "effect";
import path from "path";
import type {
  FileStatus,
  RepositoryConfig,
  RepositoryStatus,
  Show,
  JJCliError,
  JJImmutableError,
  RepositoryDataError,
} from "../types";
import { JJCli } from "./JJCli";
import type { ExtensionResources } from "./ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./JjWatchmanSnapshotTriggerRef";
import type { Vscode } from "./Vscode";
import {
  getLatestOperationId,
  getStatus,
  getFileList,
  getShow,
} from "./Repository";

export interface RepoState {
  operationId: string | undefined;
  status: RepositoryStatus | undefined;
  fileStatusesByChange: Map<string, FileStatus[]>;
  conflictedFilesByChange: Map<string, Set<string>>;
  trackedFiles: Set<string>;
  parentShowResults: Map<string, Show>;
}

export class RepoStateRef extends Context.Tag("RepoStateRef")<
  RepoStateRef,
  Ref.Ref<RepoState>
>() {}

export const emptyRepoState: RepoState = {
  operationId: undefined,
  status: undefined,
  fileStatusesByChange: new Map(),
  conflictedFilesByChange: new Map(),
  trackedFiles: new Set(),
  parentShowResults: new Map(),
};

export function computeNewState(
  _current: RepoState,
  operationId: string,
  status: RepositoryStatus,
  trackedFilesList: string[],
  parentShowResults: { changeId: string; show: Show }[],
  repositoryRoot: string,
): RepoState {
  const newTrackedFiles = new Set<string>();
  const newParentShowResultsMap = new Map<string, Show>();
  const newFileStatusesByChange = new Map<string, FileStatus[]>([
    ["@", status.fileStatuses],
  ]);
  const newConflictedFilesByChange = new Map<string, Set<string>>([
    ["@", status.conflictedFiles],
  ]);

  for (const t of trackedFilesList) {
    const pathParts = t.split(path.sep);
    let currentPath = repositoryRoot + path.sep;
    for (const p of pathParts) {
      currentPath += p;
      newTrackedFiles.add(currentPath);
      currentPath += path.sep;
    }
  }

  for (const { changeId, show } of parentShowResults) {
    newParentShowResultsMap.set(changeId, show);
    newFileStatusesByChange.set(changeId, show.fileStatuses);
    newConflictedFilesByChange.set(changeId, show.conflictedFiles);
  }

  return {
    operationId,
    status,
    fileStatusesByChange: newFileStatusesByChange,
    conflictedFilesByChange: newConflictedFilesByChange,
    trackedFiles: newTrackedFiles,
    parentShowResults: newParentShowResultsMap,
  };
}

export const checkForUpdates = (
  config: RepositoryConfig,
): Effect.Effect<
  RepoState | null,
  JJCliError | JJImmutableError | RepositoryDataError,
  | JJCli
  | RepoStateRef
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef
> =>
  Effect.gen(function* () {
    const stateRef = yield* RepoStateRef;
    const latestOpId = yield* getLatestOperationId(config);
    const current = yield* Ref.get(stateRef);
    if (current.operationId === latestOpId) {
      return null;
    }

    const status = yield* getStatus(config);
    const fileList = yield* getFileList(config);
    const parentShows = yield* Effect.all(
      status.parentChanges.map((p) =>
        getShow(config, p.changeId).pipe(
          Effect.map((show) => ({ changeId: p.changeId, show })),
        ),
      ),
      { concurrency: "unbounded" },
    );

    const newState = computeNewState(
      current,
      latestOpId,
      status,
      fileList,
      parentShows,
      config.repositoryRoot,
    );
    yield* Ref.set(stateRef, newState);
    return newState;
  });
