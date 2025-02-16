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
import { WorkspaceSourceControlManager } from "./repository";

const THREE_MINUTES = 1000 * 60 * 3;

export class JJFileSystemProvider implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private mtime = Date.now();

  private fileCache = new Map<string, { timestamp: number; content: Buffer }>();

  private cleanupInterval: NodeJS.Timeout;

  constructor(private repositories: WorkspaceSourceControlManager) {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [uri, value] of this.fileCache) {
        if (now - value.timestamp > THREE_MINUTES) {
          this.fileCache.delete(uri);
        }
      }
    }, 1000 * 30);
  }

  dispose() {
    clearInterval(this.cleanupInterval);
  }

  watch(): Disposable {
    return new Disposable(() => {});
  }

  async stat(uri: Uri): Promise<FileStat> {
    const { rev } = getJJUriParams(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
    if (!repository) {
      throw FileSystemError.FileNotFound();
    }

    const cacheValue = this.fileCache.get(uri.toString());
    if (cacheValue) {
      return {
        type: FileType.File,
        size: cacheValue.content.length,
        mtime: this.mtime,
        ctime: 0,
      };
    }

    let size = 0;
    try {
      const data = await repository.readFile(rev, uri.fsPath);
      size = data.length;
      this.fileCache.set(uri.toString(), {
        timestamp: Date.now(),
        content: data,
      });
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
    const { rev } = getJJUriParams(uri);

    const repository = this.repositories.getRepositoryFromUri(uri);
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
