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
import { getJJUriParams } from "./uri";
import { Repositories } from "./repository";

export class JJFileSystemProvider implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private mtime = Date.now();

  private fileCache = new Map<string, { timestamp: number; content: Buffer }>();

  constructor(private repositories: Repositories) {}

  watch(): Disposable {
    return new Disposable(() => {});
  }

  async stat(uri: Uri): Promise<FileStat> {
    const { rev } = getJJUriParams(uri);

    const repository = this.repositories.getRepository(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    let size = 0;
    try {
      const data = await repository.readFile(rev, uri.fsPath);
      size = data.length;
      this.fileCache.set(uri.toString(), {
        timestamp: Date.now(),
        content: data,
      });
    } catch {
      // noop
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
    const { rev } = getJJUriParams(uri);

    const repository = this.repositories.getRepository(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    const cacheValue = this.fileCache.get(uri.toString());
    if (cacheValue) {
      return cacheValue.content;
    }

    try {
      const data = await repository.readFile(rev, uri.fsPath);
      this.fileCache.set(uri.toString(), {
        timestamp: Date.now(),
        content: data,
      });
      return data;
    } catch (err) {
      // File does not exist in git. This could be
      // because the file is untracked or ignored
      throw FileSystemError.FileNotFound();
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
