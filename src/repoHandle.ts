import * as vscode from "vscode";
import type { Effect } from "effect";
import type { JJCli } from "./services/JJCli";
import type { ExtensionResources } from "./services/ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./services/JjWatchmanSnapshotTriggerRef";
import type { RepoState, RepoStateRef } from "./services/RepoState";
import type { Vscode } from "./services/Vscode";
import type { RepositoryConfig, RepositoryStatus, Show } from "./types";
import type { JJFileSystemProviderNew } from "./fileSystemProviderNew";

export interface RepoHandle {
  config: RepositoryConfig;
  runPromise: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | JJCli
      | RepoStateRef
      | Vscode
      | ExtensionResources
      | JjWatchmanRegisterSnapshotTriggerRef
    >,
  ) => Promise<A>;
  currentState: RepoState;
  sourceControl: vscode.SourceControl;
  workingCopyGroup: vscode.SourceControlResourceGroup;
  parentGroups: vscode.SourceControlResourceGroup[];
  onDidUpdateEmitter: vscode.EventEmitter<void>;
  dispose(): Promise<void>;
}

export interface RepositorySourceControlManager {
  readonly repositoryRoot: string;
  readonly sourceControl: vscode.SourceControl;
  readonly workingCopyResourceGroup: vscode.SourceControlResourceGroup;
  readonly parentResourceGroups: vscode.SourceControlResourceGroup[];
  readonly status: RepositoryStatus | undefined;
  readonly parentShowResults: Map<string, Show>;
  readonly onDidUpdate: vscode.Event<void>;
  readonly repository: { repositoryRoot: string };
}

export interface WorkspaceSourceControlManager {
  repoSCMs: RepositorySourceControlManager[];
  fileSystemProvider: JJFileSystemProviderNew;
  refresh(): Promise<boolean>;
  getRepositoryFromUri(uri: vscode.Uri): { repositoryRoot: string } | undefined;
  getRepositoryFromResourceGroup(
    rg: vscode.SourceControlResourceGroup,
  ): { repositoryRoot: string } | undefined;
  getRepositoryFromSourceControl(
    sc: vscode.SourceControl,
  ): { repositoryRoot: string } | undefined;
  getRepositorySourceControlManagerFromUri(
    uri: vscode.Uri,
  ): RepositorySourceControlManager | undefined;
  getRepositorySourceControlManagerFromResourceGroup(
    rg: vscode.SourceControlResourceGroup,
  ): RepositorySourceControlManager | undefined;
}

export interface JJRepository {
  repositoryRoot: string;
}
