import {
  FileDecorationProvider,
  FileDecoration,
  Uri,
  EventEmitter,
  Event,
  ThemeColor,
} from "vscode";
import { FileStatus, FileStatusType } from "./repository";
import { getParams, toJJUri } from "./uri";

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
    conflictedFiles: Map<string, Set<string>>,
  ) {
    if (process.platform === "win32") {
      trackedFiles = convertSetToLowercase(trackedFiles);
    }
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
    for (const [changeId, files] of conflictedFiles) {
      for (const file of files) {
        const key = getKey(Uri.file(file).fsPath, changeId);
        const existingDecoration = nextDecorations.get(key);
        if (!existingDecoration) {
          nextDecorations.set(key, {
            badge: "!",
            color: new ThemeColor(
              "gitDecoration.conflictingResourceForeground",
            ),
          });
        } else {
          nextDecorations.set(key, {
            ...existingDecoration,
            badge: `${existingDecoration.badge}!`,
            color: new ThemeColor(
              "gitDecoration.conflictingResourceForeground",
            ),
          });
        }
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
        const { fsPath, rev } = parseKey(key);
        return toJJUri(Uri.file(fsPath), { rev });
      }),
      ...[...changedDecorationKeys.keys()]
        .filter((key) => {
          const { rev } = parseKey(key);
          return rev === "@";
        })
        .map((key) => {
          const { fsPath } = parseKey(key);
          return Uri.file(fsPath);
        }),
      ...[...changedTrackedFiles.values()].map((file) => Uri.file(file)),
    ];

    this._onDidChangeDecorations.fire(changedUris);
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    if (!this.hasData) {
      throw new Error(
        "provideFileDecoration was called before data was available",
      );
    }
    let rev = "@";
    if (uri.scheme === "jj") {
      const params = getParams(uri);
      if ("diffOriginalRev" in params) {
        // It doesn't make sense to show a decoration for the left side of a diff, even if that left side is a
        // single rev, because we never show the left side of a diff by itself; it'll always be part of a diff view.
        return undefined;
      }
      rev = params.rev;
    }
    const key = getKey(uri.fsPath, rev);
    if (rev === "@" && !this.decorations.has(key)) {
      const fsPath =
        process.platform === "win32" ? uri.fsPath.toLowerCase() : uri.fsPath;
      if (!this.trackedFiles.has(fsPath)) {
        return {
          color: new ThemeColor("jjDecoration.ignoredResourceForeground"),
        };
      }
    }
    return this.decorations.get(key);
  }
}

function getKey(fsPath: string, rev: string) {
  fsPath = process.platform === "win32" ? fsPath.toLowerCase() : fsPath;
  return JSON.stringify({ fsPath, rev });
}

function parseKey(key: string) {
  return JSON.parse(key) as { fsPath: string; rev: string };
}

function convertSetToLowercase<T>(originalSet: Set<T>): Set<T> {
  const lowercaseSet = new Set<T>();

  for (const item of originalSet) {
    if (typeof item === "string") {
      lowercaseSet.add(item.toLowerCase() as unknown as T);
    } else {
      lowercaseSet.add(item);
    }
  }

  return lowercaseSet;
}
