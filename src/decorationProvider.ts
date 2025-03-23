import {
  FileDecorationProvider,
  FileDecoration,
  Uri,
  EventEmitter,
  Event,
  ThemeColor,
} from "vscode";
import { FileStatus, FileStatusType } from "./repository";
import { getRevOpt, withRev } from "./uri";

const colorOfType = (type: FileStatusType) => {
  switch (type) {
    case "A":
      return new ThemeColor("jjDecoration.addedResourceForeground");
    case "M":
      return new ThemeColor("jjDecoration.modifiedResourceForeground");
    case "D":
      return new ThemeColor("jjDecoration.deletedResourceForeground");
    case "R":
      return new ThemeColor("jjDecoration.modifiedResourceForeground");
  }
};

export class JJDecorationProvider implements FileDecorationProvider {
  private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
  readonly onDidChangeFileDecorations: Event<Uri[]> =
    this._onDidChangeDecorations.event;
  private decorations = new Map<string, FileDecoration>();
  private trackedFiles = new Set<string>();
  private hasData = false;

  /**
   * @param register Function that will register this provider with vscode.
   * This will be called lazily once the provider has data to show.
   */
  constructor(private register: (provider: JJDecorationProvider) => void) {}

  /**
   * Updates the internal state of the provider with new decorations. If
   * being called for the first time, registers the provider with vscode.
   * Otherwise, fires an event to notify vscode of the updated decorations.
   */
  onRefresh(
    fileStatusesByChange: Map<string, FileStatus[]>,
    trackedFiles: Set<string>,
  ) {
    const nextDecorations = new Map<string, FileDecoration>();
    for (const [changeId, fileStatuses] of fileStatusesByChange) {
      for (const fileStatus of fileStatuses) {
        const key = getKey(Uri.file(fileStatus.path).fsPath, changeId);
        nextDecorations.set(key, {
          badge: fileStatus.type,
          tooltip: fileStatus.file,
          color: colorOfType(fileStatus.type),
        });
      }
    }

    const changedDecorationKeys = new Set<string>();
    for (const [key, fileDecoration] of nextDecorations) {
      if (
        !this.decorations.has(key) ||
        this.decorations.get(key)!.badge !== fileDecoration.badge
      ) {
        changedDecorationKeys.add(key);
      }
    }
    for (const key of this.decorations.keys()) {
      if (!nextDecorations.has(key)) {
        changedDecorationKeys.add(key);
      }
    }

    const changedTrackedFiles = new Set<string>([
      ...[...trackedFiles.values()].filter(
        (file) => !this.trackedFiles.has(file),
      ),
      ...[...this.trackedFiles.values()].filter(
        (file) => !trackedFiles.has(file),
      ),
    ]);

    this.decorations = nextDecorations;
    this.trackedFiles = trackedFiles;

    if (!this.hasData) {
      this.hasData = true;
      // Register the provider with vscode now that we have data to show.
      this.register(this);
      return;
    }

    const changedUris = [
      ...[...changedDecorationKeys.keys()].map((key) => {
        const [fsPath, rev] = key.split(":");
        return withRev(Uri.file(fsPath), rev);
      }),
      ...[...changedDecorationKeys.keys()]
        .filter((key) => {
          const [_, rev] = key.split(":");
          return rev === "@";
        })
        .map((key) => {
          const [fsPath] = key.split(":");
          return Uri.file(fsPath);
        }),
      ...[...changedTrackedFiles.values()].map((file) => Uri.file(file)),
    ];

    this._onDidChangeDecorations.fire(changedUris);
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    const rev = getRevOpt(uri) ?? "@";
    const key = getKey(uri.fsPath, rev);
    if (rev === "@" && !this.decorations.has(key)) {
      if (!this.trackedFiles.has(uri.fsPath)) {
        return {
          color: new ThemeColor("jjDecoration.ignoredResourceForeground"),
        };
      }
    }
    return this.decorations.get(key);
  }
}

function getKey(fsPath: string, rev: string) {
  return `${fsPath}:${rev}`;
}
