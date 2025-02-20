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
import { getRev } from "./uri";
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
    const rev = getRev(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    let size = 0;
    try {
      const data = await repository.readFile(rev, uri.fsPath);
      size = data.length;
    } catch (e) {
      if (e instanceof Error && e.message.includes("No such path")) {
        throw FileSystemError.FileNotFound();
      }
      throw e;
    }
    return { type: FileType.File, size: size, mtime: this.mtime, ctime: 0 };
  }

  readDirectory(): Thenable<[string, FileType][]> {
    throw new Error("Method not implemented.");
  }

  createDirectory(): void {
    throw new Error("Method not implemented.");
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    const rev = getRev(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    try {
      const data = await repository.readFile(rev, uri.fsPath);
      return data;
    } catch (e) {
      if (e instanceof Error && e.message.includes("No such path")) {
        throw FileSystemError.FileNotFound();
      }
      throw e;
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
