import * as vscode from "vscode";
import path from "path";
import { toJJUri } from "./uri";
import type { Change, FileStatus } from "./types";
import type { RepoState } from "./services/RepoState";

export interface RenderData {
  workingCopy: Change;
  workingCopyFileStatuses: FileStatus[];
  parentChanges: { change: Change; fileStatuses: FileStatus[] }[];
  totalFileCount: number;
}

export function computeRenderData(state: RepoState): RenderData | null {
  if (!state.status?.workingCopy) {
    return null;
  }

  const parentChanges = state.status.parentChanges.map((parentChange) => {
    const show = state.parentShowResults.get(parentChange.changeId);
    return {
      change: parentChange,
      fileStatuses: show ? show.fileStatuses : [],
    };
  });

  return {
    workingCopy: state.status.workingCopy,
    workingCopyFileStatuses: state.status.fileStatuses,
    parentChanges,
    totalFileCount: state.status.fileStatuses.length,
  };
}

function getLabel(prefix: string, change: Change) {
  return `${prefix} [${change.changeId}]${
    change.description ? ` • ${change.description}` : ""
  }${change.isEmpty ? " (empty)" : ""}${
    change.isConflict ? " (conflict)" : ""
  }${change.description ? "" : " (no description)"}`;
}

function getResourceStateCommand(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
  diffTitleSuffix: string,
): vscode.Command {
  if (fileStatus.type === "A") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [afterUri],
    };
  } else if (fileStatus.type === "D") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [
        beforeUri,
        {} satisfies vscode.TextDocumentShowOptions,
        `${fileStatus.file} (Deleted)`,
      ],
    };
  }
  return {
    title: "Open",
    command: "vscode.diff",
    arguments: [
      beforeUri,
      afterUri,
      (fileStatus.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
        `${fileStatus.file} ${diffTitleSuffix}`,
    ],
  };
}

export function applyRenderData(
  renderData: RenderData,
  sourceControl: vscode.SourceControl,
  workingCopyGroup: vscode.SourceControlResourceGroup,
  parentGroups: vscode.SourceControlResourceGroup[],
): vscode.SourceControlResourceGroup[] {
  // Update working copy
  workingCopyGroup.label = getLabel("Working Copy", renderData.workingCopy);
  workingCopyGroup.resourceStates = renderData.workingCopyFileStatuses.map(
    (fileStatus) => ({
      resourceUri: vscode.Uri.file(fileStatus.path),
      decorations: {
        strikeThrough: fileStatus.type === "D",
        tooltip: path.basename(fileStatus.file),
      },
      command: getResourceStateCommand(
        fileStatus,
        toJJUri(vscode.Uri.file(`${fileStatus.path}`), {
          diffOriginalRev: "@",
        }),
        vscode.Uri.file(fileStatus.path),
        "(Working Copy)",
      ),
    }),
  );
  sourceControl.count = renderData.totalFileCount;

  // Update parent groups: dispose stale ones
  const updatedGroups: vscode.SourceControlResourceGroup[] = [];
  for (const group of parentGroups) {
    const parentChange = renderData.parentChanges.find(
      (p) => p.change.changeId === group.id,
    );
    if (!parentChange) {
      group.dispose();
    } else {
      group.label = getLabel("Parent Commit", parentChange.change);
      updatedGroups.push(group);
    }
  }

  // Create new groups or update existing
  for (const {
    change: parentChange,
    fileStatuses,
  } of renderData.parentChanges) {
    let parentChangeResourceGroup: vscode.SourceControlResourceGroup;

    const existingGroup = updatedGroups.find(
      (group) => group.id === parentChange.changeId,
    );
    if (!existingGroup) {
      parentChangeResourceGroup = sourceControl.createResourceGroup(
        parentChange.changeId,
        getLabel("Parent Commit", parentChange),
      );
      updatedGroups.push(parentChangeResourceGroup);
    } else {
      parentChangeResourceGroup = existingGroup;
    }

    parentChangeResourceGroup.resourceStates = fileStatuses.map(
      (parentStatus) => ({
        resourceUri: toJJUri(vscode.Uri.file(parentStatus.path), {
          rev: parentChange.changeId,
        }),
        decorations: {
          strikeThrough: parentStatus.type === "D",
          tooltip: path.basename(parentStatus.file),
        },
        command: getResourceStateCommand(
          parentStatus,
          toJJUri(vscode.Uri.file(parentStatus.path), {
            diffOriginalRev: parentChange.changeId,
          }),
          toJJUri(vscode.Uri.file(parentStatus.path), {
            rev: parentChange.changeId,
          }),
          `(${parentChange.changeId})`,
        ),
      }),
    );
  }

  return updatedGroups;
}
