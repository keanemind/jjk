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
  window,
  FileChangeType,
  workspace,
} from "vscode";
import { getParams } from "./uri";
import type { WorkspaceSourceControlManager } from "./repository";
import {
  createThrottledAsyncFn,
  eventToPromise,
  filterEvent,
  isDescendant,
  pathEquals,
} from "./utils";

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

export class JJFileSystemProvider implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private changedRepositoryRoots = new Set<string>();
  cache = new Map<string, CacheRow>();
  private mtime = Date.now();
  private disposables: Disposable[] = [];

  constructor(private repositories: WorkspaceSourceControlManager) {
    setInterval(() => this.cleanup(), FIVE_MINUTES);
  }

  dispose() {}

  onDidChangeRepository({ repositoryRoot }: { repositoryRoot: string }): void {
    this.changedRepositoryRoots.add(repositoryRoot);
    void this.fireChangeEvents();
  }

  fireChangeEvents = createThrottledAsyncFn(this._fireChangeEvents.bind(this));
  private async _fireChangeEvents(): Promise<void> {
    if (!window.state.focused) {
      const onDidFocusWindow = filterEvent(
        window.onDidChangeWindowState,
        (e) => e.focused,
      );
      await eventToPromise(onDidFocusWindow);
    }

    const events: FileChangeEvent[] = [];

    for (const { uri } of this.cache.values()) {
      for (const root of this.changedRepositoryRoots) {
        if (isDescendant(root, uri.fsPath)) {
          events.push({ type: FileChangeType.Changed, uri });
          break;
        }
      }
    }

    if (events.length > 0) {
      this.mtime = new Date().getTime();
      this._onDidChangeFile.fire(events);
    }

    this.changedRepositoryRoots.clear();
  }

  cleanup(): void {
    const now = new Date().getTime();
    const cache = new Map<string, CacheRow>();

    for (const row of this.cache.values()) {
      const path = row.uri.fsPath;
      const isOpen = workspace.textDocuments
        .filter((d) => ["file", "jj"].includes(d.uri.scheme))
        .some((d) => pathEquals(d.uri.fsPath, path));

      if (isOpen || now - row.timestamp < THREE_MINUTES) {
        cache.set(row.uri.toString(), row);
      } else {
        // TODO: should fire delete events?
      }
    }

    this.cache = cache;
  }

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

    const timestamp = new Date().getTime();
    const cacheValue: CacheRow = { uri, timestamp };

    this.cache.set(uri.toString(), cacheValue);

    if ("diffOriginalRev" in params) {
      return await this.readDiffOriginalFile(
        repository,
        params.diffOriginalRev,
        uri.fsPath,
      );
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

  /**
   * Resolves the left side of a diff-backed `jj:` URI such as
   * `jj:/repo/file.txt?{"diffOriginalRev":"@"}`.
   *
   * For that URI, the editor wants the old side of the diff for `file.txt` in
   * `@`. The same rule applies to any other revision string. This method first
   * tries the parent side at the same path, then rename metadata from
   * `show(rev)`, and finally the diff-tool fallback.
   */
  private async readDiffOriginalFile(
    repository: NonNullable<
      ReturnType<WorkspaceSourceControlManager["getRepositoryFromUri"]>
    >,
    rev: string,
    filepath: string,
  ): Promise<Uint8Array> {
    const directContent = await this.tryReadDirectDiffOriginal(
      repository,
      rev,
      filepath,
    );
    if (directContent) {
      return directContent;
    }

    const renamedContent = await this.tryReadRenamedDiffOriginal(
      repository,
      rev,
      filepath,
    );
    if (renamedContent) {
      return renamedContent;
    }

    const originalContent = await repository.getDiffOriginal(rev, filepath);
    if (originalContent) {
      return originalContent;
    }

    throw FileSystemError.FileNotFound();
  }

  /**
   * Tries the same path in the parent of the requested revision.
   *
   * Example: if the diff is for `@`, jj spells the parent side as `@-`, so
   * this helper first tries `repository.readFile("@-", filepath)`. Other
   * revision strings follow the same pattern.
   *
   * Returns `undefined` when that path is missing in the parent or when the
   * parent expression resolves to multiple revisions.
   */
  private async tryReadDirectDiffOriginal(
    repository: NonNullable<
      ReturnType<WorkspaceSourceControlManager["getRepositoryFromUri"]>
    >,
    rev: string,
    filepath: string,
  ): Promise<Uint8Array | undefined> {
    try {
      return await repository.readFile(`${rev}-`, filepath);
    } catch (e) {
      if (this.isMissingOrAmbiguousDiffPath(e)) {
        return undefined;
      }
      throw e;
    }
  }

  /**
   * Tries to resolve the old content when the current path no longer matches
   * the path in the parent revision.
   *
   * Example: if `show("@")` says `renamed-a.txt` came from `a.txt`, this
   * helper probes the concrete parent commits with `/repo/a.txt`. Other
   * revisions follow the same lookup flow.
   */
  private async tryReadRenamedDiffOriginal(
    repository: NonNullable<
      ReturnType<WorkspaceSourceControlManager["getRepositoryFromUri"]>
    >,
    rev: string,
    filepath: string,
  ): Promise<Uint8Array | undefined> {
    const showResult = await repository.show(rev);
    const fileStatus = showResult.fileStatuses.find((status) =>
      pathEquals(status.path, filepath),
    );
    if (!fileStatus) {
      return undefined;
    }

    const originalPath =
      fileStatus.renamedFrom !== undefined
        ? Uri.joinPath(
            Uri.file(repository.repositoryRoot),
            fileStatus.renamedFrom,
          ).fsPath
        : filepath;

    for (const parentCommitId of showResult.change.parentCommitIds) {
      try {
        return await repository.readFile(parentCommitId, originalPath);
      } catch (e) {
        if (e instanceof Error && e.message.includes("No such path")) {
          continue;
        }
        throw e;
      }
    }

    return undefined;
  }

  /**
   * Returns true when a direct parent-side read should fall through to rename
   * handling instead of surfacing immediately.
   *
   * In practice that means either "this path does not exist in the parent" or
   * "the parent expression matched more than one revision".
   *
   * This currently matches jj's human-readable error text, so it may need
   * updating if jj changes those messages.
   */
  private isMissingOrAmbiguousDiffPath(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes("No such path") ||
        error.message.includes("resolved to more than one revision"))
    );
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
