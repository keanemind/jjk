import {
  FileSystemProvider,
  FileSystemError,
  EventEmitter,
  Event,
  FileChangeEvent,
  Disposable,
  Uri,
  FileStat,
  FileType,
} from "vscode";
import { getParams } from "./uri";
import { WorkspaceSourceControlManager } from "./repository";

export class JJFileSystemProvider implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private mtime = Date.now();

  constructor(private repositories: WorkspaceSourceControlManager) {}

  dispose() {}

  watch(): Disposable {
    return new Disposable(() => {});
  }

  async stat(uri: Uri): Promise<FileStat> {
    return {
      type: FileType.File,
      size: (await this.readFile(uri)).length,
      mtime: this.mtime,
      ctime: 0,
    };
  }

  readDirectory(): Thenable<[string, FileType][]> {
    throw new Error("Method not implemented.");
  }

  createDirectory(): void {
    throw new Error("Method not implemented.");
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const params = getParams(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    if ("diffOriginalRev" in params) {
      const originalContent = await repository.getDiffOriginal(
        params.diffOriginalRev,
        uri.fsPath,
      );
      if (!originalContent) {
        throw FileSystemError.FileNotFound();
      }
      return originalContent;
    } else {
      try {
        const data = await repository.readFile(params.rev, uri.fsPath);
        return data;
      } catch (e) {
        if (e instanceof Error && e.message.includes("No such path")) {
          throw FileSystemError.FileNotFound();
        }
        throw e;
      }
    }
  }

  writeFile(): void {
    throw new Error("Method not implemented.");
  }

  delete(): void {
    throw new Error("Method not implemented.");
  }

  rename(): void {
    throw new Error("Method not implemented.");
  }
}
