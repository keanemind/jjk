import {
  FileDecorationProvider,
  FileDecoration,
  Uri,
  EventEmitter,
  Event,
  ThemeColor,
} from "vscode";
import { RepositoryStatus } from "./repository";

export class JJDecorationProvider implements FileDecorationProvider {
  private decorations = new Map<string, FileDecoration>();

  private readonly _onDidChangeDecorations = new EventEmitter<Uri[]>();
  readonly onDidChangeFileDecorations: Event<Uri[]> =
    this._onDidChangeDecorations.event;

  onDidRunStatus(status: RepositoryStatus) {
    this.decorations.clear();
    for (const fileStatus of status.fileStatuses) {
      this.decorations.set(Uri.file(fileStatus.path).toString(), {
        badge: fileStatus.type,
        tooltip: fileStatus.file,
        color: new ThemeColor("jjDecoration.modifiedResourceForeground"),
      });
    }
    this._onDidChangeDecorations.fire(
      [...this.decorations.keys()].map((uri) => Uri.parse(uri))
    );
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    return this.decorations.get(uri.toString());
  }
}
