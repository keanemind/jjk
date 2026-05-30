import * as vscode from "vscode";
import type {
  RepositorySourceControlManager,
  RepoHandle,
  WorkspaceSourceControlManager,
} from "./repoHandle";
import type { JJFileSystemProviderNew } from "./fileSystemProviderNew";
import type { RepoLocator } from "./repoLocator";

export interface WorkspaceScmCompatLayer extends WorkspaceSourceControlManager {
  readonly getResourceGroupFromResourceState: (
    resourceState: vscode.SourceControlResourceState,
  ) => vscode.SourceControlResourceGroup;
  readonly dispose: () => void;
}

export function buildRepoSCMProxy(
  repo: RepoHandle,
): RepositorySourceControlManager {
  return {
    get repositoryRoot() {
      return repo.config.repositoryRoot;
    },
    get sourceControl() {
      return repo.sourceControl;
    },
    get workingCopyResourceGroup() {
      return repo.workingCopyGroup;
    },
    get parentResourceGroups() {
      return repo.parentGroups;
    },
    get status() {
      return repo.currentState.status;
    },
    get parentShowResults() {
      return repo.currentState.parentShowResults;
    },
    get onDidUpdate() {
      return repo.onDidUpdateEmitter.event;
    },
    get repository() {
      return {
        repositoryRoot: repo.config.repositoryRoot,
      };
    },
  };
}

export function buildWorkspaceSCMCompatLayer(
  repos: () => readonly RepoHandle[],
  fileSystemProvider: JJFileSystemProviderNew,
  repoLocator: RepoLocator,
): WorkspaceScmCompatLayer {
  return {
    get repoSCMs() {
      return repos().map((repo) => buildRepoSCMProxy(repo));
    },
    fileSystemProvider,
    refresh() {
      return Promise.resolve(false);
    },
    getRepositoryFromUri(uri) {
      const repo = repoLocator.findRepoByUri(uri);
      return repo ? { repositoryRoot: repo.config.repositoryRoot } : undefined;
    },
    getRepositoryFromResourceGroup(resourceGroup) {
      const repo = repoLocator.findRepoByResourceGroup(resourceGroup);
      return repo ? { repositoryRoot: repo.config.repositoryRoot } : undefined;
    },
    getRepositoryFromSourceControl(sourceControl) {
      const repo = repoLocator.findRepoBySourceControl(sourceControl);
      return repo ? { repositoryRoot: repo.config.repositoryRoot } : undefined;
    },
    getRepositorySourceControlManagerFromUri(uri) {
      const repo = repoLocator.findRepoByUri(uri);
      return repo ? buildRepoSCMProxy(repo) : undefined;
    },
    getRepositorySourceControlManagerFromResourceGroup(resourceGroup) {
      const repo = repoLocator.findRepoByResourceGroup(resourceGroup);
      return repo ? buildRepoSCMProxy(repo) : undefined;
    },
    getResourceGroupFromResourceState(resourceState) {
      return repoLocator.getResourceGroupFromResourceState(resourceState);
    },
    dispose() {
      // Runtimes are disposed via the extension subscription scope.
    },
  };
}
