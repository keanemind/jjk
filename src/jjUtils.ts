import path from "path";
import * as fsSync from "fs";
import fs from "fs/promises";
import * as os from "os";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import which from "which";
import semver from "semver";
import { Effect } from "effect";
import { getParams, toJJUri } from "./uri";
import { logger } from "./logger";
import {
  getConfigurationValue,
  getWorkspaceFolders,
  Vscode,
} from "./services/Vscode";
import { isDescendant, pathEquals } from "./utils";

export interface DiscoveredRepoInfo {
  jjPath: { filepath: string; source: "configured" | "path" | "common" };
  jjVersion: string;
  repoRoot: string;
}

export function resolveRepoPath(workspaceRoot: string): string {
  const jjRepoPath = path.join(workspaceRoot, ".jj", "repo");
  if (fsSync.statSync(jjRepoPath).isFile()) {
    const contents = fsSync.readFileSync(jjRepoPath, "utf-8");
    return path.resolve(path.join(workspaceRoot, ".jj"), contents);
  }
  return jjRepoPath;
}

function handleCommand(
  childProcess: import("child_process").ChildProcess,
): Effect.Effect<Buffer, Error> {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        const output: Buffer[] = [];
        const errOutput: Buffer[] = [];
        childProcess.stdout!.on("data", (data: Buffer) => {
          output.push(data);
        });
        childProcess.stderr!.on("data", (data: Buffer) => {
          errOutput.push(data);
        });
        childProcess.on("error", (error: Error) => {
          reject(new Error(`Spawning command failed: ${error.message}`));
        });
        childProcess.on("close", (code, signal) => {
          if (code) {
            reject(
              new Error(
                `Command failed with exit code ${code}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
              ),
            );
          } else if (signal) {
            reject(
              new Error(
                `Command failed with signal ${signal}.\nstdout: ${Buffer.concat(output).toString()}\nstderr: ${Buffer.concat(errOutput).toString()}`,
              ),
            );
          } else {
            resolve(Buffer.concat(output));
          }
        });
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function getJJVersion(jjPath: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const version = (yield* handleCommand(
      spawn(jjPath, ["version"], {
        timeout: 5000,
      }),
    ))
      .toString()
      .trim();

    if (version.startsWith("jj")) {
      return version.replace(/^jj\s*/, "");
    }

    return yield* Effect.fail(
      new Error(`Failed to parse jj version from ${jjPath}: ${version}`),
    );
  });
}

export function getJJPathEffect(
  workspaceFolder: string,
): Effect.Effect<
  { filepath: string; source: "configured" | "path" | "common" },
  Error,
  Vscode
> {
  return Effect.gen(function* () {
    const configuredPath = yield* getConfigurationValue<string>(
      "jjk",
      "jjPath",
      workspaceFolder !== undefined
        ? vscode.Uri.file(workspaceFolder)
        : undefined,
    );

    if (configuredPath) {
      const configuredExecutable = yield* Effect.tryPromise({
        try: () => which(configuredPath, { nothrow: true }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (configuredExecutable) {
        return { filepath: configuredPath, source: "configured" } as const;
      }
      return yield* Effect.fail(
        new Error(
          `Configured jjk.jjPath is not an executable file: ${configuredPath}`,
        ),
      );
    }

    const jjInPath = yield* Effect.tryPromise({
      try: () => which("jj", { nothrow: true }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    if (jjInPath) {
      return { filepath: jjInPath, source: "path" } as const;
    }

    const commonPaths = [
      path.join(os.homedir(), ".cargo", "bin", "jj"),
      path.join(os.homedir(), ".cargo", "bin", "jj.exe"),
      path.join(os.homedir(), ".nix-profile", "bin", "jj"),
      path.join(os.homedir(), ".local", "bin", "jj"),
      path.join(os.homedir(), "bin", "jj"),
      "/usr/bin/jj",
      "/home/linuxbrew/.linuxbrew/bin/jj",
      "/usr/local/bin/jj",
      "/opt/homebrew/bin/jj",
      "/opt/local/bin/jj",
    ];

    for (const commonPath of commonPaths) {
      const jjInCommonPath = yield* Effect.tryPromise({
        try: () => which(commonPath, { nothrow: true }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (jjInCommonPath) {
        return { filepath: jjInCommonPath, source: "common" } as const;
      }
    }

    return yield* Effect.fail(
      new Error(`jj CLI not found in PATH nor in common locations.`),
    );
  });
}

/**
 * Builds the list of directories that should be probed with `jj root`.
 *
 * A VS Code workspace folder is always a candidate because opening a repo root
 * must continue to work even when automatic nested detection is disabled. When
 * nested detection is enabled, immediate children are considered by default,
 * matching VS Code Git's guarded scan shape without requiring users to create
 * a multi-root workspace for sibling repos under a container directory. For
 * example, opening `~/code` can discover `~/code/foo` and `~/code/bar` without
 * also walking every descendant under those repos.
 *
 * `jjk.scanRepositories` is a narrow escape hatch for known relative paths. It
 * is intentionally relative to the workspace folder so a shared setting cannot
 * make this extension crawl arbitrary absolute paths on another machine.
 */
function getRepositoryScanFolders(
  workspaceFolder: vscode.WorkspaceFolder,
): Effect.Effect<Set<string>, never, Vscode> {
  return Effect.gen(function* () {
    const root = workspaceFolder.uri.fsPath;
    const result = new Set<string>([root]);
    const configScope = workspaceFolder.uri;

    if (yield* shouldScanWorkspaceSubfolders(configScope)) {
      const repositoryScanMaxDepth =
        (yield* getConfigurationValue<number>(
          "jjk",
          "repositoryScanMaxDepth",
          configScope,
        )) ?? 1;
      const repositoryScanIgnoredFolders = (yield* getConfigurationValue<
        string[]
      >("jjk", "repositoryScanIgnoredFolders", configScope)) ?? [
        "node_modules",
      ];

      for (const folder of yield* traverseWorkspaceFolder(
        root,
        repositoryScanMaxDepth,
        repositoryScanIgnoredFolders,
      )) {
        result.add(folder);
      }
    }

    const scanRepositories =
      (yield* getConfigurationValue<string[]>(
        "jjk",
        "scanRepositories",
        configScope,
      )) ?? [];
    for (const folder of getConfiguredScanFolders(root, scanRepositories)) {
      result.add(folder);
    }

    return result;
  });
}

/**
 * Decides whether workspace children should be scanned automatically.
 *
 * The setting mirrors VS Code Git's public shape so users can transfer the same
 * mental model to jjk. Both `true` and `"subFolders"` mean "probe workspace
 * children"; `false` still leaves the opened workspace folder and explicit
 * `jjk.scanRepositories` entries in place.
 */
function shouldScanWorkspaceSubfolders(
  configScope: vscode.ConfigurationScope,
): Effect.Effect<boolean, never, Vscode> {
  return Effect.map(
    getConfigurationValue<boolean | "subFolders">(
      "jjk",
      "autoRepositoryDetection",
      configScope,
    ),
    (autoRepositoryDetection) =>
      autoRepositoryDetection === undefined ||
      autoRepositoryDetection === true ||
      autoRepositoryDetection === "subFolders",
  );
}

/**
 * Expands explicit scan paths from settings into workspace-local candidates.
 *
 * These entries are for repos that live outside the bounded automatic scan, for
 * example a known grandchild repo when `jjk.repositoryScanMaxDepth` is left at
 * the default. If the workspace is `~/code`, an entry like `tools/jjk` probes
 * `~/code/tools/jjk` even though only direct children are scanned
 * automatically. Keeping entries relative to the workspace prevents a shared
 * setting from causing this extension to probe unrelated absolute paths on
 * another machine.
 */
function getConfiguredScanFolders(
  root: string,
  scanRepositories: string[],
): string[] {
  const result: string[] = [];

  for (const scanPath of scanRepositories) {
    const scanFolder = resolveConfiguredScanFolder(root, scanPath);
    if (scanFolder === undefined) {
      continue;
    }

    result.push(scanFolder);
  }

  return result;
}

/**
 * Resolves one `jjk.scanRepositories` entry into a workspace-local probe.
 *
 * `scanRepositories` names candidate workspaces, not repository metadata
 * directories. Accepting `.jj` or `.git` would just make `jj root` walk back to
 * the same checkout while making the configured path harder to reason about.
 *
 * The returned path must stay inside the opened workspace after normalization.
 * For example, `tools/jjk` under `~/code` is accepted as `~/code/tools/jjk`,
 * but `../other` and `tools/../../other` are rejected because they escape the
 * workspace root.
 */
export function resolveConfiguredScanFolder(
  root: string,
  scanPath: string,
): string | undefined {
  const normalizedScanPath = path.normalize(scanPath);

  if (normalizedScanPath === ".jj" || normalizedScanPath === ".git") {
    logger.debug(
      `Skipping unsupported '${scanPath}' entry in jjk.scanRepositories setting.`,
    );
    return undefined;
  }

  if (path.isAbsolute(scanPath)) {
    logger.warn(
      "Skipping absolute path in jjk.scanRepositories setting: " + scanPath,
    );
    return undefined;
  }

  const scanFolder = path.resolve(root, scanPath);
  if (!isDescendant(root, scanFolder)) {
    logger.warn(
      "Skipping path outside workspace in jjk.scanRepositories setting: " +
        scanPath,
    );
    return undefined;
  }

  return scanFolder;
}

/**
 * Returns subfolders that are worth probing as possible repository roots.
 *
 * The workspace folder itself is not returned here; `getRepositoryScanFolders`
 * owns that invariant so callers can combine the root, automatic discovery, and
 * explicit scan paths in one deduplicated set. `maxDepth` follows the Git
 * extension setting shape: `1` means direct children, so `~/code/foo` is
 * returned but `~/code/foo/crate` is not; `-1` means unlimited. A folder is a
 * candidate as soon as traversal reaches it, even if its children cannot be
 * read. For example, an unreadable `~/code/foo` at depth 1 is still worth a
 * `jj root` probe because the probe does not require listing `foo` first.
 *
 * `.jj` and `.git` are repository metadata, not useful candidate workspaces.
 * Skipping them avoids an extra `jj root` per colocated repo and prevents
 * deeper metadata internals from becoming scan roots when depth is unlimited.
 */
export function traverseWorkspaceFolder(
  workspaceFolder: string,
  maxDepth: number,
  repositoryScanIgnoredFolders: string[],
): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const result: string[] = [];
    const foldersToTraverse = [{ path: workspaceFolder, depth: 0 }];

    while (foldersToTraverse.length > 0) {
      const currentFolder = foldersToTraverse.shift()!;

      if (currentFolder.depth !== 0) {
        result.push(currentFolder.path);
      }

      if (currentFolder.depth >= maxDepth && maxDepth !== -1) {
        continue;
      }

      const children = yield* readWorkspaceChildren(currentFolder.path);

      if (children === undefined) {
        continue;
      }

      foldersToTraverse.push(
        ...children
          .filter((dirent) =>
            isWorkspaceScanFolder(dirent, repositoryScanIgnoredFolders),
          )
          .map((dirent) => ({
            path: path.join(currentFolder.path, dirent.name),
            depth: currentFolder.depth + 1,
          })),
      );
    }

    return result;
  });
}

/**
 * Reads one directory during repository discovery without aborting the scan.
 *
 * Workspace scans should be best-effort: unreadable generated folders,
 * permission-limited directories, or deleted paths should not prevent other
 * sibling repositories from being discovered.
 */
function readWorkspaceChildren(
  folder: string,
): Effect.Effect<fsSync.Dirent[] | undefined> {
  return Effect.tryPromise({
    try: () => fs.readdir(folder, { withFileTypes: true }),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.catchAll((err) => {
      logger.warn(
        `Unable to read workspace folder '${folder}': ${String(err)}`,
      );
      return Effect.succeed(undefined);
    }),
  );
}

/**
 * Applies the traversal policy for automatic workspace scans.
 *
 * The scan only descends into directories that could be useful workspace roots.
 * Repository metadata directories are skipped because they cannot be opened as
 * jj workspaces, and user-configured ignored folders let large dependency trees
 * stay out of the probe set.
 */
function isWorkspaceScanFolder(
  dirent: fsSync.Dirent,
  repositoryScanIgnoredFolders: string[],
): boolean {
  return (
    dirent.isDirectory() &&
    dirent.name !== ".jj" &&
    dirent.name !== ".git" &&
    !repositoryScanIgnoredFolders.some((folder) =>
      pathEquals(dirent.name, folder),
    )
  );
}

/**
 * Converts a candidate folder into canonical repository information.
 *
 * Most candidate folders are just probes. The important output is not the
 * candidate path, but the root reported by `jj root`, because several
 * candidates can resolve to the same repository through parent lookup,
 * symlinks, or explicit scan paths. For example, probing both `~/code/foo` and
 * `~/code/foo/src` should open one repo keyed by `~/code/foo`, not two source
 * control managers.
 *
 * `jj root` is the first jj command on purpose. During a workspace scan, most
 * candidates may be ordinary folders. Waiting to call `jj version` until after
 * a root is found avoids one extra process spawn for every non-repo child.
 */
function discoverRepository(
  candidateFolder: string,
): Effect.Effect<[string, DiscoveredRepoInfo], Error, Vscode> {
  return Effect.gen(function* () {
    const jjPath = yield* getJJPathEffect(candidateFolder);
    const repoRoot = (yield* handleCommand(
      spawn(jjPath.filepath, ["--ignore-working-copy", "root"], {
        cwd: candidateFolder,
        timeout: 5000,
      }),
    ))
      .toString()
      .trim();

    const jjVersion = yield* getJJVersion(jjPath.filepath);
    if (semver.lt(jjVersion, "0.27.0")) {
      return yield* Effect.fail(
        new Error(
          `jj version ${jjVersion} is not supported. Please upgrade to at least jj 0.27.0.`,
        ),
      );
    }

    return [
      repositoryUriFromRoot(repoRoot),
      {
        jjPath,
        jjVersion,
        repoRoot,
      },
    ];
  });
}

/**
 * Converts a canonical jj root into the URI key used to track open repos.
 *
 * Repository identity is keyed by VS Code's URI string form, so UNC roots need
 * normalization before the key is compared against existing repo handles.
 */
function repositoryUriFromRoot(repoRoot: string): string {
  return vscode.Uri.file(repoRoot.replace(/^\\\\\?\\UNC\\/, "\\\\")).toString();
}

export function discoverRepositoriesEffect(): Effect.Effect<
  Map<string, DiscoveredRepoInfo>,
  never,
  Vscode
> {
  return Effect.gen(function* () {
    const repoInfos = new Map<string, DiscoveredRepoInfo>();

    const workspaceFolders = yield* getWorkspaceFolders();
    for (const workspaceFolder of workspaceFolders) {
      const candidateFolders = yield* getRepositoryScanFolders(workspaceFolder);

      for (const candidateFolder of candidateFolders) {
        const result = yield* Effect.either(
          discoverRepository(candidateFolder),
        );
        if (result._tag === "Right") {
          const [repoUri, repoInfo] = result.right;
          repoInfos.set(repoUri, repoInfos.get(repoUri) ?? repoInfo);
          continue;
        }

        const e = result.left;
        if (e.message.includes("no jj repo in")) {
          logger.debug(`No jj repo in ${candidateFolder}`);
        } else {
          logger.error(
            `Error while initializing jjk in workspace ${candidateFolder}: ${String(e)}`,
          );
        }
      }
    }

    return repoInfos;
  });
}

export function provideOriginalResource(uri: vscode.Uri) {
  if (!["file", "jj"].includes(uri.scheme)) {
    return undefined;
  }

  let rev = "@";
  if (uri.scheme === "jj") {
    const params = getParams(uri);
    if ("diffOriginalRev" in params) {
      return undefined;
    }
    rev = params.rev;
  }
  const filePath = uri.fsPath;
  const originalUri = toJJUri(vscode.Uri.file(filePath), {
    diffOriginalRev: rev,
  });

  return originalUri;
}
