import * as vscode from "vscode";
import path from "path";
import type { RepoHandle } from "./repoHandle";

export interface RepoLocator {
  readonly findRepoBySourceControl: (
    sc: vscode.SourceControl,
  ) => RepoHandle | undefined;
  readonly findRepoByUri: (uri: vscode.Uri) => RepoHandle | undefined;
  readonly findRepoByResourceGroup: (
    rg: vscode.SourceControlResourceGroup,
  ) => RepoHandle | undefined;
  readonly getResourceGroupFromResourceState: (
    resourceState: vscode.SourceControlResourceState,
  ) => vscode.SourceControlResourceGroup;
  readonly getSharedResourceGroup: (
    resourceStates: readonly vscode.SourceControlResourceState[],
  ) => vscode.SourceControlResourceGroup;
}

export const makeRepoLocator = (
  repos: () => readonly RepoHandle[],
): RepoLocator => ({
  findRepoBySourceControl: (sc) =>
    repos().find((repo) => repo.sourceControl === sc),
  findRepoByUri: (uri) =>
    repos().find(
      (repo) =>
        !path.relative(repo.config.repositoryRoot, uri.fsPath).startsWith(".."),
    ),
  findRepoByResourceGroup: (rg) =>
    repos().find(
      (repo) => repo.workingCopyGroup === rg || repo.parentGroups.includes(rg),
    ),
  getResourceGroupFromResourceState: (resourceState) => {
    const resourceUri = resourceState.resourceUri;

    for (const repo of repos()) {
      const groups = [repo.workingCopyGroup, ...repo.parentGroups];
      for (const group of groups) {
        if (
          group.resourceStates.some(
            (state) => state.resourceUri.toString() === resourceUri.toString(),
          )
        ) {
          return group;
        }
      }
    }

    throw new Error("Resource state not found in any resource group");
  },
  getSharedResourceGroup: (resourceStates) => {
    if (resourceStates.length === 0) {
      throw new Error("No resources found");
    }

    const [first, ...rest] = resourceStates;
    const locator = makeRepoLocator(repos);
    const firstGroup = locator.getResourceGroupFromResourceState(first);
    for (const resourceState of rest) {
      if (
        locator.getResourceGroupFromResourceState(resourceState) !== firstGroup
      ) {
        throw new Error(
          "All selected resources must belong to the same resource group",
        );
      }
    }
    return firstGroup;
  },
});
