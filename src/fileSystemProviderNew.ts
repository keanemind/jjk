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
import path from "path";
import { Duration, Effect } from "effect";
import { getParams } from "./uri";
import {
  createThrottledAsyncFn,
  eventToPromise,
  filterEvent,
  isDescendant,
  pathEquals,
} from "./utils";
import {
  getDiffOriginal,
  readFile as readFileEffect,
} from "./services/Repository";
import type { RepoHandle } from "./repoHandle";

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

export class JJFileSystemProviderNew implements FileSystemProvider {
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private changedRepositoryRoots = new Set<string>();
  cache = new Map<string, CacheRow>();
  private mtime = Date.now();

  constructor(private getRepos: () => RepoHandle[]) {}

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
    const repos = this.getRepos();

    const repo = repos.find((r) => {
      return !path
        .relative(r.config.repositoryRoot, uri.fsPath)
        .startsWith("..");
    });
    if (!repo) {
      throw FileSystemError.FileNotFound();
    }

    const timestamp = new Date().getTime();
    const cacheValue: CacheRow = { uri, timestamp };
    this.cache.set(uri.toString(), cacheValue);

    const rev =
      "diffOriginalRev" in params ? params.diffOriginalRev : params.rev;

    // The original side of a diff for `rev` is the file's content before `rev`,
    // i.e. at the parent. A file absent there (added or renamed in `rev`) has an
    // empty original, matching a plain "file added" diff.
    const readOriginalAtParent = readFileEffect(
      repo.config,
      `${rev}-`,
      uri.fsPath,
    ).pipe(
      Effect.catchAll((e) =>
        e instanceof Error && e.message.includes("No such path")
          ? Effect.succeed(new Uint8Array())
          : Effect.fail(e),
      ),
    );

    const effect =
      "diffOriginalRev" in params
        ? // Try getDiffOriginal first (fakeeditor-based, handles renames correctly),
          // then fall back to reading the parent revision directly.
          getDiffOriginal(repo.config, rev, uri.fsPath).pipe(
            Effect.flatMap((data) =>
              data ? Effect.succeed(data) : readOriginalAtParent,
            ),
            Effect.catchAll(() => readOriginalAtParent),
          )
        : readFileEffect(repo.config, rev, uri.fsPath);

    try {
      return await repo.runPromise(effect);
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

export const runFileSystemProviderCleanup = (
  provider: JJFileSystemProviderNew,
): Effect.Effect<void, never, import("effect").Scope.Scope> =>
  Effect.forkScoped(
    Effect.forever(
      Effect.sync(() => provider.cleanup()).pipe(
        Effect.delay(Duration.millis(FIVE_MINUTES)),
      ),
    ),
  ).pipe(Effect.asVoid);
