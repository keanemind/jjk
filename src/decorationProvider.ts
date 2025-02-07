import {
  FileDecorationProvider,
  FileDecoration,
  Uri,
  EventEmitter,
  Event,
  ThemeColor,
} from "vscode";
import { FileStatus } from "./repository";
import { toJJUri } from "./uri";

export class JJDecorationProvider implements FileDecorationProvider {
  private decorations = new Map<string, FileDecoration>();

  private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
  readonly onDidChangeFileDecorations: Event<Uri[]> =
    this._onDidChangeDecorations.event;

  onRefresh(fileStatusesByChange: Map<string, FileStatus[]>) {
    const nextDecorations = new Map<string, FileDecoration>();
    for (const [changeId, fileStatuses] of fileStatusesByChange) {
      for (const fileStatus of fileStatuses) {
        const key =
          changeId === "@"
            ? Uri.file(fileStatus.path).toString()
            : toJJUri(Uri.file(fileStatus.path), changeId).toString();
        nextDecorations.set(key, {
          badge: fileStatus.type,
          tooltip: fileStatus.file,
          color: new ThemeColor("jjDecoration.modifiedResourceForeground"),
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

    this.decorations = nextDecorations;
    this._onDidChangeDecorations.fire(
      [...changedDecorationKeys.keys()].map((uri) => Uri.parse(uri)),
    );
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    return this.decorations.get(uri.toString());
  }
}
