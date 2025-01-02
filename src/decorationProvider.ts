import {
  FileDecorationProvider,
  FileDecoration,
  Uri,
  EventEmitter,
  Event,
  ThemeColor,
} from "vscode";
import { FileStatus, RepositoryStatus } from "./repository";

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

  addDecorators(uris: Uri[], fileStatuses: FileStatus[]) {
    uris.forEach((uri, index) => {
      this.decorations.set(uri.toString(), {
        badge: fileStatuses[index].type,
        tooltip: fileStatuses[index].file,
        color: new ThemeColor("jjDecoration.modifiedResourceForeground"),
      });

      this._onDidChangeDecorations.fire(
        [...this.decorations.keys()].map((uri) => Uri.parse(uri))
      );
    });
  }

  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    return this.decorations.get(uri.toString());
  }
}
