import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import fs from "fs/promises";
import * as fsSync from "fs";
import { getParams, toJJUri } from "./uri";
import type { JJDecorationProvider } from "./decorationProvider";
import { logger } from "./logger";
import type { ChildProcess } from "child_process";
import { anyEvent, pathEquals } from "./utils";
import { JJFileSystemProvider } from "./fileSystemProvider";
import * as os from "os";
import * as crypto from "crypto";
import which from "which";
import semver from "semver";

async function getJJVersion(jjPath: string): Promise<string> {
  const version = (
    await handleCommand(
      spawn(jjPath, ["version"], {
        timeout: 5000,
      }),
    )
  )
    .toString()
    .trim();

  if (version.startsWith("jj")) {
    return version.replace(/^jj\s*/, "");
  }

  throw new Error(`Failed to parse jj version from ${jjPath}: ${version}`);
}

export let extensionDir = "";
export let fakeEditorPath = "";
export function initExtensionDir(extensionUri: vscode.Uri) {
  extensionDir = vscode.Uri.joinPath(
    extensionUri,
    extensionUri.fsPath.includes("extensions") ? "dist" : "src",
  ).fsPath;

  const config = vscode.workspace.getConfiguration("jjk");
  const customPath = config.get<string | null>("fakeEditorPath");
  if (customPath !== null && customPath !== undefined) {
    fakeEditorPath = customPath;
    return;
  }

  const fakeEditorExecutables: {
    [platform in typeof process.platform]?: {
      [arch in typeof process.arch]?: string;
    };
  } = {
    freebsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    netbsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    openbsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    linux: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    win32: {
      arm64: "fakeeditor_windows_aarch64.exe",
      x64: "fakeeditor_windows_x86_64.exe",
    },
    darwin: {
      arm64: "fakeeditor_macos_aarch64",
      x64: "fakeeditor_macos_x86_64",
    },
  };

  const fakeEditorExecutableName =
    fakeEditorExecutables[process.platform]?.[process.arch];
  if (fakeEditorExecutableName) {
    fakeEditorPath = path.join(
      extensionDir,
      "fakeeditor",
      "zig-out",
      "bin",
      fakeEditorExecutableName,
    );
  }
}

/**
 * If jjk.commandTimeout is set, returns that value.
 * Otherwise, returns the provided default timeout, or 30 seconds if no default is provided.
 */
function getCommandTimeout(
  repositoryRoot: string | undefined,
  defaultTimeout: number | undefined,
): number {
  if (repositoryRoot) {
    const config = vscode.workspace.getConfiguration(
      "jjk",
      vscode.Uri.file(repositoryRoot),
    );
    const configuredTimeout = config.get<number | null>("commandTimeout");
    if (configuredTimeout !== null && configuredTimeout !== undefined) {
      return configuredTimeout;
    }
  }
  return defaultTimeout ?? 30000;
}

/**
 * Resolves the repo directory for a jj workspace. In primary workspaces,
 * .jj/repo is a directory. In secondary workspaces (created via
 * `jj workspace add`), .jj/repo is a file containing the path to the
 * primary repo's .jj/repo directory.
 */
export function resolveRepoPath(workspaceRoot: string): string {
  const jjRepoPath = path.join(workspaceRoot, ".jj", "repo");
  if (fsSync.statSync(jjRepoPath).isFile()) {
    const contents = fsSync.readFileSync(jjRepoPath, "utf-8");
    return path.resolve(path.join(workspaceRoot, ".jj"), contents);
  }
  return jjRepoPath;
}

/**
 * Returns ["--ignore-working-copy"] if pollSnapshotWorkingCopy is disabled, otherwise returns an empty array.
 * This controls whether the poll command (getLatestOperationId) snapshots the working copy.
 */
function getPollIgnoreWorkingCopyArgs(repositoryRoot: string): string[] {
  const config = vscode.workspace.getConfiguration(
    "jjk",
    vscode.Uri.file(repositoryRoot),
  );
  const pollSnapshot = config.get<boolean>("pollSnapshotWorkingCopy");
  if (pollSnapshot === false) {
    return ["--ignore-working-copy"];
  }
  return [];
}

/**
 * Gets the configured jj executable path from settings.
 * If no path is configured, searches through common installation paths before falling back to "jj".
 */
async function getJJPath(
  workspaceFolder: string,
): Promise<{ filepath: string; source: "configured" | "path" | "common" }> {
  const config = vscode.workspace.getConfiguration(
    "jjk",
    workspaceFolder !== undefined
      ? vscode.Uri.file(workspaceFolder)
      : undefined,
  );
  const configuredPath = config.get<string>("jjPath");

  if (configuredPath) {
    if (await which(configuredPath, { nothrow: true })) {
      return { filepath: configuredPath, source: "configured" };
    } else {
      throw new Error(
        `Configured jjk.jjPath is not an executable file: ${configuredPath}`,
      );
    }
  }

  const jjInPath = await which("jj", { nothrow: true });
  if (jjInPath) {
    return { filepath: jjInPath, source: "path" };
  }

  // It's particularly important to check common locations on MacOS because of https://github.com/microsoft/vscode/issues/30847#issuecomment-420399383
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
    const jjInCommonPath = await which(commonPath, { nothrow: true });
    if (jjInCommonPath) {
      return { filepath: jjInCommonPath, source: "common" };
    }
  }

  throw new Error(`jj CLI not found in PATH nor in common locations.`);
}

function spawnJJ(
  jjPath: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
  {
    repositoryRoot,
    defaultTimeout,
  }: {
    repositoryRoot: string | undefined;
    defaultTimeout: number | undefined;
  },
) {
  const finalOptions = {
    ...options,
    cwd: options?.cwd ?? repositoryRoot, // precedence: options.cwd > repositoryRoot > undefined
    timeout:
      options?.timeout ?? getCommandTimeout(repositoryRoot, defaultTimeout), // precedence: options.timeout > jjk.commandTimeout config > defaultTimeout > 30s
  } satisfies Parameters<typeof spawn>[2];

  logger.info(
    `spawn: ${JSON.stringify([jjPath, ...args])} ${JSON.stringify({ spawnOptions: finalOptions })}`,
  );

  return spawn(jjPath, args, finalOptions);
}

function handleJJCommand(childProcess: ChildProcess) {
  return handleCommand(childProcess).catch(convertJJErrors);
}

function handleCommand(childProcess: ChildProcess) {
  return new Promise<Buffer>((resolve, reject) => {
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
  });
}

export class ImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableError";
  }
}

/**
 * Detects common error messages from jj and converts them to custom error instances to make them easier to selectively
 * handle.
 */
function convertJJErrors(e: unknown): never {
  if (e instanceof Error) {
    if (e.message.includes("is immutable")) {
      throw new ImmutableError(e.message);
    }
  }
  throw e;
}

export class WorkspaceSourceControlManager {
  repoInfos:
    | Map<
        string,
        {
          jjPath: Awaited<ReturnType<typeof getJJPath>>;
          jjVersion: string;
          repoRoot: string;
        }
      >
    | undefined;
  repoSCMs: RepositorySourceControlManager[] = [];
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  fileSystemProvider: JJFileSystemProvider;

  private _onDidRepoUpdate = new vscode.EventEmitter<{
    repoSCM: RepositorySourceControlManager;
  }>();
  readonly onDidRepoUpdate: vscode.Event<{
    repoSCM: RepositorySourceControlManager;
  }> = this._onDidRepoUpdate.event;

  constructor(private decorationProvider: JJDecorationProvider) {
    this.fileSystemProvider = new JJFileSystemProvider(this);
    this.subscriptions.push(this.fileSystemProvider);
    this.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(
        "jj",
        this.fileSystemProvider,
        {
          isReadonly: true,
          isCaseSensitive: true,
        },
      ),
    );
  }

  async refresh() {
    const newRepoInfos = new Map<
      string,
      {
        jjPath: Awaited<ReturnType<typeof getJJPath>>;
        jjVersion: string;
        repoRoot: string;
      }
    >();
    for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
      try {
        const jjPath = await getJJPath(workspaceFolder.uri.fsPath);
        const jjVersion = await getJJVersion(jjPath.filepath);

        if (semver.lt(jjVersion, "0.26.0")) {
          throw new Error(
            `jj version ${jjVersion} is not supported. Please upgrade to at least jj 0.26.0.`,
          );
        }

        const repoRoot = (
          await handleCommand(
            spawnJJ(
              jjPath.filepath,
              ["--ignore-working-copy", "root"],
              {
                cwd: workspaceFolder.uri.fsPath,
              },
              {
                repositoryRoot: undefined,
                defaultTimeout: 5000,
              },
            ),
          )
        )
          .toString()
          .trim();

        const repoUri = vscode.Uri.file(
          repoRoot.replace(/^\\\\\?\\UNC\\/, "\\\\"),
        ).toString();

        if (!newRepoInfos.has(repoUri)) {
          newRepoInfos.set(repoUri, {
            jjPath,
            jjVersion,
            repoRoot,
          });
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("no jj repo in")) {
          logger.debug(`No jj repo in ${workspaceFolder.uri.fsPath}`);
        } else {
          logger.error(
            `Error while initializing jjk in workspace ${workspaceFolder.uri.fsPath}: ${String(e)}`,
          );
        }
        continue;
      }
    }

    let isAnyRepoChanged = false;
    for (const [key, value] of newRepoInfos) {
      const oldValue = this.repoInfos?.get(key);
      if (!oldValue) {
        isAnyRepoChanged = true;
        logger.info(`Detected new jj repo in workspace: ${key}`);
      } else if (
        oldValue.jjVersion !== value.jjVersion ||
        oldValue.jjPath.filepath !== value.jjPath.filepath ||
        oldValue.repoRoot !== value.repoRoot
      ) {
        isAnyRepoChanged = true;
        logger.info(
          `Detected change that requires reinitialization in workspace: ${key}`,
        );
      }
    }
    for (const key of this.repoInfos?.keys() || []) {
      if (!newRepoInfos.has(key)) {
        isAnyRepoChanged = true;
        logger.info(`Detected jj repo removal in workspace: ${key}`);
      }
    }
    this.repoInfos = newRepoInfos;
    this.decorationProvider.removeStaleRepositories(
      [...newRepoInfos.values()].map(({ repoRoot }) => repoRoot),
    );

    if (isAnyRepoChanged) {
      const existingByUri = new Map<string, RepositorySourceControlManager>();
      for (const repoSCM of this.repoSCMs) {
        const uri = vscode.Uri.file(repoSCM.repositoryRoot).toString();
        existingByUri.set(uri, repoSCM);
      }

      for (const [uri, repoSCM] of existingByUri) {
        if (!newRepoInfos.has(uri)) {
          logger.info(`Removing repo: ${uri}`);
          repoSCM.dispose();
        }
      }

      const repoSCMs: RepositorySourceControlManager[] = [];
      for (const [
        repoUri,
        { repoRoot, jjPath, jjVersion },
      ] of newRepoInfos.entries()) {
        const existing = existingByUri.get(repoUri);
        if (existing) {
          repoSCMs.push(existing);
        } else {
          logger.info(
            `Initializing jjk in workspace ${repoUri}. Using ${jjVersion} at ${jjPath.filepath} (${jjPath.source}).`,
          );
          const repoSCM = new RepositorySourceControlManager(
            repoRoot,
            this.decorationProvider,
            this.fileSystemProvider,
            jjPath.filepath,
            jjVersion,
          );
          repoSCM.onDidUpdate(
            () => {
              this._onDidRepoUpdate.fire({ repoSCM });
            },
            undefined,
            repoSCM.subscriptions,
          );
          repoSCMs.push(repoSCM);
        }
      }

      this.repoSCMs = repoSCMs;
    }
    return isAnyRepoChanged;
  }

  getRepositoryFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith("..");
    })?.repository;
  }

  getRepositoryFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find((repo) => {
      return (
        resourceGroup === repo.workingCopyResourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup) ||
        repo.baseComparisonGroups.includes(resourceGroup)
      );
    })?.repository;
  }

  getRepositoryFromSourceControl(sourceControl: vscode.SourceControl) {
    return this.repoSCMs.find((repo) => repo.sourceControl === sourceControl)
      ?.repository;
  }

  getRepositorySourceControlManagerFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return !path.relative(repo.repositoryRoot, uri.fsPath).startsWith("..");
    });
  }

  getRepositorySourceControlManagerFromResourceGroup(
    resourceGroup: vscode.SourceControlResourceGroup,
  ) {
    return this.repoSCMs.find(
      (repo) =>
        repo.workingCopyResourceGroup === resourceGroup ||
        repo.parentResourceGroups.includes(resourceGroup) ||
        repo.baseComparisonGroups.includes(resourceGroup),
    );
  }

  getResourceGroupFromResourceState(
    resourceState: vscode.SourceControlResourceState,
  ) {
    const resourceUri = resourceState.resourceUri;

    for (const repo of this.repoSCMs) {
      const groups = [
        repo.workingCopyResourceGroup,
        ...repo.parentResourceGroups,
        ...repo.baseComparisonGroups,
      ];

      for (const group of groups) {
        if (
          group.resourceStates.some(
            (state) => state.resourceUri.toString() === resourceUri.toString(),
          )
        ) {
          return group;
        }
      }
    }

    throw new Error("Resource state not found in any resource group");
  }

  dispose() {
    for (const subscription of this.repoSCMs) {
      subscription.dispose();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

export function provideOriginalResource(uri: vscode.Uri) {
  if (!["file", "jj"].includes(uri.scheme)) {
    return undefined;
  }

  let rev = "@";
  if (uri.scheme === "jj") {
    const params = getParams(uri);
    if ("diffOriginalRev" in params) {
      // It doesn't make sense to show a quick diff for the left side of a diff. Diffception?
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

type BaseComparisonResult =
  | { kind: "ok"; fileStatuses: FileStatus[]; toRevision: string }
  | { kind: "error"; toRevision: string; error: string };

/** Settings that affect both data fetching and rendering, read once per cycle. */
type RefreshConfig = {
  showParentCommit: boolean;
  showBaseComparison: boolean;
  baseRevision: string;
};

/**
 * Immutable snapshot of all repo state computed in a single refresh cycle.
 * Assigned atomically so readers never see a mix of stale and fresh data.
 */
type RepoSnapshot = {
  status: RepositoryStatus;
  fileStatusesByChange: Map<string, FileStatus[]>;
  conflictedFilesByChange: Map<string, Set<string>>;
  parentShowResults: Map<string, Show>;
  baseComparisonResult: BaseComparisonResult | undefined;
  trackedFiles: Set<string>;
};

/**
 * Filters an array of resource groups, disposing those not in `validIds` and
 * returning the survivors. Used by render() to reconcile both parent commit
 * and base comparison groups against the latest data.
 */
function reconcileGroups(
  groups: vscode.SourceControlResourceGroup[],
  validIds: Set<string>,
): vscode.SourceControlResourceGroup[] {
  const kept: vscode.SourceControlResourceGroup[] = [];
  for (const group of groups) {
    if (validIds.has(group.id)) {
      kept.push(group);
    } else {
      group.dispose();
    }
  }
  return kept;
}

export class RepositorySourceControlManager {
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  sourceControl: vscode.SourceControl;
  workingCopyResourceGroup: vscode.SourceControlResourceGroup;
  parentResourceGroups: vscode.SourceControlResourceGroup[] = [];
  repository: JJRepository;
  checkForUpdatesPromise: Promise<void> | undefined;

  private _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate: vscode.Event<void> = this._onDidUpdate.event;

  operationId: string | undefined; // the latest operation id seen by this manager
  snapshot: RepoSnapshot | undefined;

  baseComparisonGroups: vscode.SourceControlResourceGroup[] = [];

  /**
   * Determines the "--to" revision for the base comparison, implementing the
   * additive model: base covers trunk()→@--, parent covers @--→@-, working
   * copy covers @-→@. Returns null if the base comparison should be suppressed
   * (merge commits, where the additive property can't be maintained).
   */
  static getBaseComparisonTarget(
    status: RepositoryStatus,
    parentShowResults: Map<string, Show>,
    showParentCommit: boolean,
  ): string | null {
    const parents = status.parentChanges;

    // Merge commit at @: multiple parents, additive model breaks down
    if (parents.length !== 1) {
      return null;
    }

    const parentChangeId = parents[0].changeId;

    if (showParentCommit) {
      // Target is parent's parent (@--). Get it from the show() result.
      const parentShow = parentShowResults.get(parentChangeId);
      if (!parentShow) {
        return null;
      }

      const grandparentIds = parentShow.change.parentChangeIds;
      // Parent is a merge commit: additive model breaks down
      if (grandparentIds.length !== 1) {
        return null;
      }

      return grandparentIds[0];
    } else {
      // Parent hidden: target is @- itself
      return parentChangeId;
    }
  }

  constructor(
    public repositoryRoot: string,
    private decorationProvider: JJDecorationProvider,
    private fileSystemProvider: JJFileSystemProvider,
    jjPath: string,
    jjVersion: string,
  ) {
    this.repository = new JJRepository(repositoryRoot, jjPath, jjVersion);

    this.sourceControl = vscode.scm.createSourceControl(
      "jj",
      path.basename(repositoryRoot),
      vscode.Uri.file(repositoryRoot),
    );
    this.subscriptions.push(this.sourceControl);

    this.workingCopyResourceGroup = this.sourceControl.createResourceGroup(
      "@",
      "Working Copy",
    );
    this.subscriptions.push(this.workingCopyResourceGroup);

    // Set up the SourceControlInputBox
    this.sourceControl.inputBox.placeholder =
      "Describe new change (Ctrl+Enter)";

    // Link the acceptInputCommand to the SourceControl instance
    this.sourceControl.acceptInputCommand = {
      command: "jj.new",
      title: "Create new change",
      arguments: [this.sourceControl],
    };

    this.sourceControl.quickDiffProvider = {
      provideOriginalResource,
    };

    const repoPath = resolveRepoPath(this.repositoryRoot);
    const watcherOperations = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.join(repoPath, "op_store", "operations"),
        "*",
      ),
    );
    this.subscriptions.push(watcherOperations);
    const repoChangedWatchEvent = anyEvent(
      watcherOperations.onDidCreate,
      watcherOperations.onDidChange,
      watcherOperations.onDidDelete,
    );
    repoChangedWatchEvent(
      async (_uri) => {
        this.fileSystemProvider.onDidChangeRepository({
          repositoryRoot: this.repositoryRoot,
        });
        await this.checkForUpdates();
      },
      undefined,
      this.subscriptions,
    );
  }

  async checkForUpdates() {
    if (!this.checkForUpdatesPromise) {
      this.checkForUpdatesPromise = this.checkForUpdatesUnsafe();
      try {
        await this.checkForUpdatesPromise;
      } finally {
        this.checkForUpdatesPromise = undefined;
      }
    } else {
      await this.checkForUpdatesPromise;
    }
  }

  /**
   * This should never be called concurrently.
   */
  async checkForUpdatesUnsafe() {
    const latestOperationId = await this.repository.getLatestOperationId();
    if (this.operationId !== latestOperationId) {
      this.operationId = latestOperationId;
      const status = await this.repository.status();

      const vsConfig = vscode.workspace.getConfiguration(
        "jjk",
        vscode.Uri.file(this.repositoryRoot),
      );
      const config: RefreshConfig = {
        showParentCommit: vsConfig.get<boolean>("showParentCommit") ?? true,
        showBaseComparison:
          vsConfig.get<boolean>("showBaseComparison") ?? false,
        baseRevision: vsConfig.get<string>("baseRevision") ?? "trunk()",
      };

      this.snapshot = await this.buildSnapshot(status, config);
      this.render(config);

      this._onDidUpdate.fire(undefined);
    }
  }

  async buildSnapshot(
    status: RepositoryStatus,
    config: RefreshConfig,
  ): Promise<RepoSnapshot> {
    const trackedFiles = new Set<string>();
    const parentShowResults = new Map<string, Show>();
    const fileStatusesByChange = new Map<string, FileStatus[]>([
      ["@", status.fileStatuses],
    ]);
    const conflictedFilesByChange = new Map<string, Set<string>>([
      ["@", status.conflictedFiles],
    ]);

    const trackedFilesList = await this.repository.fileList();
    for (const t of trackedFilesList) {
      const pathParts = t.split(path.sep);
      let currentPath = this.repositoryRoot + path.sep;
      for (const p of pathParts) {
        currentPath += p;
        trackedFiles.add(currentPath);
        currentPath += path.sep;
      }
    }

    if (config.showParentCommit) {
      const parentShowPromises = status.parentChanges.map(
        async (parentChange) => {
          const showResult = await this.repository.show(parentChange.changeId);
          return { changeId: parentChange.changeId, showResult };
        },
      );

      const parentShowResultsArray = await Promise.all(parentShowPromises);

      for (const { changeId, showResult } of parentShowResultsArray) {
        parentShowResults.set(changeId, showResult);
        fileStatusesByChange.set(changeId, showResult.fileStatuses);
        conflictedFilesByChange.set(changeId, showResult.conflictedFiles);
      }
    }

    // Base comparison: fetch diff from base revision to the additive target.
    // This runs after parent show() completes because getBaseComparisonTarget
    // needs parentShowResults to determine @-- (the parent's parent).
    let baseComparisonResult: BaseComparisonResult | undefined;

    if (config.showBaseComparison) {
      const toRevision = RepositorySourceControlManager.getBaseComparisonTarget(
        status,
        parentShowResults,
        config.showParentCommit,
      );

      if (toRevision !== null) {
        try {
          const fileStatuses = await this.repository.diffSummary(
            config.baseRevision,
            toRevision,
          );
          baseComparisonResult = { kind: "ok", fileStatuses, toRevision };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // Parse jj's "error: <detail>" stderr format; falls back to a
          // truncated message if jj ever changes its output format.
          const shortMessage =
            message.match(/error:\s*([\s\S]+?)(?:\n|$)/i)?.[1] ??
            message.substring(0, 80);
          baseComparisonResult = {
            kind: "error",
            toRevision,
            error: shortMessage,
          };
          logger.warn(
            `Base comparison failed for revset "${config.baseRevision}": ${message}`,
          );
        }
      }
    }

    // Add base comparison file statuses to the map so the decoration provider
    // can show A/M/D badges. The key is the toRevision (the revision used in
    // the resourceUri), which matches how provideFileDecoration extracts the
    // rev from jj:// URIs.
    if (baseComparisonResult?.kind === "ok") {
      fileStatusesByChange.set(
        baseComparisonResult.toRevision,
        baseComparisonResult.fileStatuses,
      );
    }

    return {
      status,
      fileStatusesByChange,
      conflictedFilesByChange,
      parentShowResults,
      baseComparisonResult,
      trackedFiles,
    };
  }

  static getLabel(prefix: string, change: Change) {
    return `${prefix} [${change.changeId}]${
      change.description ? ` • ${change.description}` : ""
    }${change.isEmpty ? " (empty)" : ""}${
      change.isConflict ? " (conflict)" : ""
    }${change.description ? "" : " (no description)"}`;
  }

  render(config: RefreshConfig) {
    const snapshot = this.snapshot;
    if (!snapshot?.status.workingCopy) {
      throw new Error(
        "Cannot render source control without a current working copy change.",
      );
    }

    this.renderWorkingCopy(snapshot);
    this.renderParentGroups(snapshot, config);
    this.renderBaseComparisonGroup(snapshot, config);

    this.decorationProvider.onRefresh(
      this.repositoryRoot,
      snapshot.fileStatusesByChange,
      snapshot.trackedFiles,
      snapshot.conflictedFilesByChange,
    );
  }

  private renderWorkingCopy(snapshot: RepoSnapshot) {
    this.workingCopyResourceGroup.label =
      RepositorySourceControlManager.getLabel(
        "Working Copy",
        snapshot.status.workingCopy,
      );
    this.workingCopyResourceGroup.resourceStates =
      snapshot.status.fileStatuses.map((fileStatus) =>
        toResourceState(
          fileStatus,
          toJJUri(vscode.Uri.file(fileStatus.path), { diffOriginalRev: "@" }),
          vscode.Uri.file(fileStatus.path),
          "(Working Copy)",
        ),
      );
    this.sourceControl.count = snapshot.status.fileStatuses.length;
  }

  private renderParentGroups(snapshot: RepoSnapshot, config: RefreshConfig) {
    const validParentIds = new Set(
      config.showParentCommit
        ? snapshot.status.parentChanges.map((c) => c.changeId)
        : [],
    );
    this.parentResourceGroups = reconcileGroups(
      this.parentResourceGroups,
      validParentIds,
    );

    for (const parentChange of snapshot.status.parentChanges) {
      if (!validParentIds.has(parentChange.changeId)) {
        continue;
      }

      let group = this.parentResourceGroups.find(
        (g) => g.id === parentChange.changeId,
      );
      if (!group) {
        group = this.sourceControl.createResourceGroup(
          parentChange.changeId,
          "",
        );
        this.parentResourceGroups.push(group);
      }

      group.label = RepositorySourceControlManager.getLabel(
        "Parent Commit",
        parentChange,
      );

      const showResult = snapshot.parentShowResults.get(parentChange.changeId);
      if (showResult) {
        group.resourceStates = showResult.fileStatuses.map((parentStatus) =>
          toResourceState(
            parentStatus,
            toJJUri(vscode.Uri.file(parentStatus.path), {
              diffOriginalRev: parentChange.changeId,
            }),
            toJJUri(vscode.Uri.file(parentStatus.path), {
              rev: parentChange.changeId,
            }),
            `(${parentChange.changeId})`,
          ),
        );
      }
    }
  }

  private renderBaseComparisonGroup(
    snapshot: RepoSnapshot,
    config: RefreshConfig,
  ) {
    const validBaseIds = new Set(
      snapshot.baseComparisonResult ? ["base-comparison"] : [],
    );
    this.baseComparisonGroups = reconcileGroups(
      this.baseComparisonGroups,
      validBaseIds,
    );

    if (!config.showBaseComparison || !snapshot.baseComparisonResult) {
      return;
    }

    let group = this.baseComparisonGroups.find(
      (g) => g.id === "base-comparison",
    );
    if (!group) {
      group = this.sourceControl.createResourceGroup("base-comparison", "");
      this.baseComparisonGroups.push(group);
    }

    const result = snapshot.baseComparisonResult;
    switch (result.kind) {
      case "error":
        group.label = `Changes since ${config.baseRevision} (error: ${result.error})`;
        group.resourceStates = [];
        break;
      case "ok":
        group.label = `Changes since ${config.baseRevision}`;
        group.resourceStates = result.fileStatuses.map((fileStatus) =>
          toResourceState(
            fileStatus,
            toJJUri(vscode.Uri.file(fileStatus.path), {
              rev: config.baseRevision,
            }),
            toJJUri(vscode.Uri.file(fileStatus.path), {
              rev: result.toRevision,
            }),
            `(${config.baseRevision})`,
          ),
        );
        break;
    }
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const group of this.parentResourceGroups) {
      group.dispose();
    }
    for (const group of this.baseComparisonGroups) {
      group.dispose();
    }
  }
}

function toResourceState(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
  diffTitleSuffix: string,
): vscode.SourceControlResourceState {
  return {
    resourceUri: afterUri,
    decorations: {
      strikeThrough: fileStatus.type === "D",
      tooltip: path.basename(fileStatus.file),
    },
    command: getResourceStateCommand(
      fileStatus,
      beforeUri,
      afterUri,
      diffTitleSuffix,
    ),
  };
}

function getResourceStateCommand(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
  diffTitleSuffix: string,
): vscode.Command {
  if (fileStatus.type === "A") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [afterUri],
    };
  } else if (fileStatus.type === "D") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [
        beforeUri,
        {} satisfies vscode.TextDocumentShowOptions,
        `${fileStatus.file} (Deleted)`,
      ],
    };
  }
  return {
    title: "Open",
    command: "vscode.diff",
    arguments: [
      beforeUri,
      afterUri,
      (fileStatus.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
        `${fileStatus.file} ${diffTitleSuffix}`,
    ],
  };
}

export class JJRepository {
  statusCache: RepositoryStatus | undefined;
  gitFetchPromise: Promise<void> | undefined;

  constructor(
    public repositoryRoot: string,
    private jjPath: string,
    private jjVersion: string,
  ) {}

  spawnJJ(
    args: string[],
    { defaultTimeout }: { defaultTimeout?: number } = {},
    options?: Parameters<typeof spawn>[2],
  ) {
    const jjConfigArgs = [
      "--config-file",
      path.join(extensionDir, "config.toml"),
    ];
    return spawnJJ(this.jjPath, [...args, ...jjConfigArgs], options, {
      repositoryRoot: this.repositoryRoot,
      defaultTimeout,
    });
  }

  spawnJJRead(
    args: string[],
    arg2: { defaultTimeout?: number } = {},
    options?: Parameters<typeof spawn>[2],
  ) {
    return this.spawnJJ(["--ignore-working-copy", ...args], arg2, options);
  }

  /**
   * Note: this command may itself snapshot the working copy and add an operation to the log, in which case it will
   * return the new operation id.
   */
  async getLatestOperationId() {
    return (
      await handleJJCommand(
        this.spawnJJ([
          ...getPollIgnoreWorkingCopyArgs(this.repositoryRoot),
          "operation",
          "log",
          "--limit",
          "1",
          "-T",
          "self.id()",
          "--no-graph",
        ]),
      )
    )
      .toString()
      .trim();
  }

  async getStatus(useCache = false): Promise<RepositoryStatus> {
    if (useCache && this.statusCache) {
      return this.statusCache;
    }

    const output = (
      await handleJJCommand(
        this.spawnJJRead(["status", "--color=always"], {
          defaultTimeout: 5000,
        }),
      )
    ).toString();
    const status = await parseJJStatus(this.repositoryRoot, output);

    this.statusCache = status;
    return status;
  }

  async status(useCache = false): Promise<RepositoryStatus> {
    const status = await this.getStatus(useCache);
    return status;
  }

  async fileList() {
    return (
      await handleJJCommand(
        this.spawnJJRead(["file", "list"], {
          defaultTimeout: 5000,
        }),
      )
    )
      .toString()
      .trim()
      .split("\n");
  }

  async show(rev: string) {
    const results = await this.showAll([rev]);
    if (results.length > 1) {
      throw new Error("Multiple results found for the given revision.");
    }
    if (results.length === 0) {
      throw new Error("No results found for the given revision.");
    }
    return results[0];
  }

  async showAll(revsets: string[]) {
    const revSeparator = "jjkඞ\n";
    const fieldSeparator = "ඞjjk";
    const summaryFileSeparator = "j@j@k";
    const summaryFileFieldSeparator = "@?!"; // characters that are illegal in filepaths
    const templateFields = [
      "change_id",
      "commit_id",
      'if(parents, "[" ++ parents.map(|p| stringify(p.change_id()).escape_json()).join(",") ++ "]", "[]")',
      'if(parents, "[" ++ parents.map(|p| stringify(p.commit_id()).escape_json()).join(",") ++ "]", "[]")',
      "author.name()",
      "author.email()",
      'author.timestamp().local().format("%F %H:%M:%S")',
      "description.escape_json()",
      "empty",
      "conflict",
      `diff.files().map(|entry| entry.status() ++ "${summaryFileFieldSeparator}" ++ entry.source().path().display() ++ "${summaryFileFieldSeparator}" ++ entry.target().path().display() ++ "${summaryFileFieldSeparator}" ++ entry.target().conflict()).join("${summaryFileSeparator}")`,
    ];
    const template =
      templateFields.join(` ++ "${fieldSeparator}" ++ `) +
      ` ++ "${revSeparator}"`;

    const output = (
      await handleJJCommand(
        this.spawnJJRead(
          [
            "log",
            "-T",
            template,
            "--no-graph",
            ...revsets.flatMap((revset) => ["-r", revset]),
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();

    if (!output) {
      throw new Error(
        "No output from jj log. Maybe the revision couldn't be found?",
      );
    }

    const revResults = output.split(revSeparator).slice(0, -1); // the output ends in a separator so remove the empty string at the end
    return revResults.map((revResult) =>
      this.parseShowResult(
        revResult,
        templateFields,
        fieldSeparator,
        summaryFileSeparator,
        summaryFileFieldSeparator,
      ),
    );
  }

  showAllPaginated(revsets: string[]): {
    next: () => Promise<Show | null>;
    kill: () => void;
  } {
    // This function does NOT pass --no-graph to jj log because it needs the changes to be ordered for graph rendering.
    /*
      @  start [data] end
      ○  start [data] end
      ○  start [data] end
      ○  start [data] end
      │ ○  start [data] end
      ├─╯
      ○  start [data] end
      │ ○    start [data] end
      │ ├─╮
      │ ○ │  start [data] end
      ├─╯ │
      ○   │  start [data] end
      ○   │  start [data] end
      ├───╯
    */
    // Note that if we just split by "end" (revSeparator), we'd get graph symbols at the beginning. This is why we need
    // a start sentinel.

    const startSentinel = "ඞSTARTඞ";
    const revSeparator = "jjkඞ\n";
    const fieldSeparator = "ඞjjk";
    const summaryFileSeparator = "j@j@k";
    const summaryFileFieldSeparator = "@?!"; // characters that are illegal in filepaths
    const templateFields = [
      "change_id",
      "commit_id",
      'if(parents, "[" ++ parents.map(|p| stringify(p.change_id()).escape_json()).join(",") ++ "]", "[]")',
      'if(parents, "[" ++ parents.map(|p| stringify(p.commit_id()).escape_json()).join(",") ++ "]", "[]")',
      "author.name()",
      "author.email()",
      'author.timestamp().local().format("%F %H:%M:%S")',
      "description.escape_json()",
      "empty",
      "conflict",
      `diff.files().map(|entry| entry.status() ++ "${summaryFileFieldSeparator}" ++ entry.source().path().display() ++ "${summaryFileFieldSeparator}" ++ entry.target().path().display() ++ "${summaryFileFieldSeparator}" ++ entry.target().conflict()).join("${summaryFileSeparator}")`,
    ];
    const template =
      `"${startSentinel}" ++ ` +
      templateFields.join(` ++ "${fieldSeparator}" ++ `) +
      ` ++ "${revSeparator}"`;

    const childProcess = this.spawnJJ(
      ["log", "-T", template, ...revsets.flatMap((revset) => ["-r", revset])],
      undefined,
      { timeout: 0 }, // no timeout
    );

    childProcess.stdout!.setEncoding("utf8");

    let stderr = "";
    childProcess.stderr!.on("data", (data) => {
      stderr += data;
    });

    const exitPromise = new Promise<void>((resolve, reject) => {
      childProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`jj log exited with code ${code}: ${stderr}`));
        }
      });
      childProcess.on("error", (err) => {
        reject(err);
      });
    });

    const generator = async function* (this: JJRepository) {
      let buffer = "";
      for await (const chunk of childProcess.stdout!) {
        buffer += chunk;
        let separatorIndex = buffer.indexOf(revSeparator);
        while (separatorIndex !== -1) {
          const revSliceWithGraphSymbols = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + revSeparator.length);

          const startIndex = revSliceWithGraphSymbols.indexOf(startSentinel);
          if (startIndex === -1) {
            throw new Error("Failed to find start sentinel in jj log output");
          }
          const revResult = revSliceWithGraphSymbols.slice(
            startIndex + startSentinel.length,
          );

          yield this.parseShowResult(
            revResult,
            templateFields,
            fieldSeparator,
            summaryFileSeparator,
            summaryFileFieldSeparator,
          );
          separatorIndex = buffer.indexOf(revSeparator);
        }
      }

      await exitPromise;
    }.call(this);

    return {
      next: async () => {
        const result = await generator.next();
        return result.done ? null : result.value;
      },
      kill: () => {
        childProcess.kill();
      },
    };
  }

  private parseShowResult(
    revResult: string,
    templateFields: string[],
    fieldSeparator: string,
    summaryFileSeparator: string,
    summaryFileFieldSeparator: string,
  ): Show {
    const parseJsonStringArray = (value: string, fieldName: string) => {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error(`Unexpected ${fieldName} JSON payload.`);
      }
      return parsed.map((item) => String(item));
    };
    const fields = revResult.split(fieldSeparator);
    if (fields.length > templateFields.length) {
      throw new Error(
        "Separator found in a field value. This is not supported.",
      );
    } else if (fields.length < templateFields.length) {
      throw new Error("Missing fields in the output.");
    }
    const ret: Show = {
      change: {
        changeId: "",
        commitId: "",
        parentChangeIds: [],
        parentCommitIds: [],
        description: "",
        author: {
          email: "",
          name: "",
        },
        authoredDate: "",
        isEmpty: false,
        isConflict: false,
      },
      fileStatuses: [],
      conflictedFiles: new Set<string>(),
    };

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const value = field.trim();
      switch (templateFields[i]) {
        case "change_id":
          ret.change.changeId = value;
          break;
        case "commit_id":
          ret.change.commitId = value;
          break;
        case 'if(parents, "[" ++ parents.map(|p| stringify(p.change_id()).escape_json()).join(",") ++ "]", "[]")': {
          ret.change.parentChangeIds = parseJsonStringArray(
            value,
            "parent change ids",
          );
          break;
        }
        case 'if(parents, "[" ++ parents.map(|p| stringify(p.commit_id()).escape_json()).join(",") ++ "]", "[]")': {
          ret.change.parentCommitIds = parseJsonStringArray(
            value,
            "parent commit ids",
          );
          break;
        }
        case "author.name()":
          ret.change.author.name = value;
          break;
        case "author.email()":
          ret.change.author.email = value;
          break;
        case 'author.timestamp().local().format("%F %H:%M:%S")':
          ret.change.authoredDate = value;
          break;
        case "description.escape_json()":
          {
            const parsed: unknown = JSON.parse(value);
            if (typeof parsed !== "string") {
              throw new Error("Unexpected description JSON payload.");
            }
            ret.change.description = parsed;
          }
          break;
        case "empty":
          ret.change.isEmpty = value === "true";
          break;
        case "conflict":
          ret.change.isConflict = value === "true";
          break;
        default: {
          for (const line of value
            .split(summaryFileSeparator)
            .filter(Boolean)) {
            const [status, rawSourcePath, rawTargetPath, conflict] = line.split(
              summaryFileFieldSeparator,
            );
            const sourcePath = path
              .normalize(rawSourcePath)
              .replace(/\\/g, "/");
            const targetPath = path
              .normalize(rawTargetPath)
              .replace(/\\/g, "/");
            if (
              ["modified", "added", "removed", "copied", "renamed"].includes(
                status,
              )
            ) {
              if (status === "renamed" || status === "copied") {
                ret.fileStatuses.push({
                  type: status === "renamed" ? "R" : "C",
                  file: path.basename(targetPath),
                  path: path.join(this.repositoryRoot, targetPath),
                  renamedFrom: sourcePath,
                });
              } else {
                ret.fileStatuses.push({
                  type:
                    status === "added" ? "A" : status === "removed" ? "D" : "M",
                  file: path.basename(targetPath),
                  path: path.join(this.repositoryRoot, targetPath),
                });
              }
              if (conflict === "true") {
                ret.conflictedFiles.add(
                  path.join(this.repositoryRoot, targetPath),
                );
              }
            } else {
              throw new Error(`Unexpected diff custom summary line: ${line}`);
            }
          }
          break;
        }
      }
    }

    return ret;
  }

  readFile(rev: string, filepath: string) {
    return handleJJCommand(
      this.spawnJJRead(
        ["file", "show", "--revision", rev, filepathToFileset(filepath)],
        {
          defaultTimeout: 5000,
        },
      ),
    );
  }

  /**
   * Returns the file statuses between two revisions using `jj diff --summary`.
   * Uses spawnJJRead (--ignore-working-copy) since the poll cycle already
   * snapshots the working copy before this is called.
   */
  async diffSummary(from: string, to: string): Promise<FileStatus[]> {
    const output = (
      await handleJJCommand(
        this.spawnJJRead(["diff", "--summary", "--from", from, "--to", to], {
          defaultTimeout: 10_000,
        }),
      )
    ).toString();

    const fileStatuses: FileStatus[] = [];
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      // jj diff --summary output is plain ASCII (no ANSI color codes)
      parseFileStatusLine(this.repositoryRoot, line, fileStatuses);
    }
    return fileStatuses;
  }

  /**
   * Returns local bookmark names that are ancestors of @, suitable as base
   * revision presets.
   */
  async bookmarksOfAncestors(): Promise<string[]> {
    try {
      const output = (
        await handleJJCommand(
          this.spawnJJRead(
            [
              "log",
              "--no-graph",
              "-r",
              "bookmarks() & ::@",
              "-T",
              'local_bookmarks.join("\\n") ++ "\\n"',
            ],
            { defaultTimeout: 5000 },
          ),
        )
      )
        .toString()
        .trim();

      if (!output) {
        return [];
      }
      return output.split("\n").filter(Boolean);
    } catch (e) {
      logger.warn(`Failed to list bookmarks: ${String(e)}`);
      return [];
    }
  }

  async describeRetryImmutable(rev: string, message: string) {
    try {
      return await this.describe(rev, message);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(["Continue"], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.describe(rev, message, true);
      }
      throw e;
    }
  }

  async describe(rev: string, message: string, ignoreImmutable = false) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            "describe",
            "-m",
            message,
            rev,
            ...(ignoreImmutable ? ["--ignore-immutable"] : []),
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();
  }

  async new(message?: string, revs?: string[]) {
    try {
      return await handleJJCommand(
        this.spawnJJ(
          [
            "new",
            ...(message ? ["-m", message] : []),
            ...(revs ? ["-r", ...revs] : []),
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      );
    } catch (error) {
      if (error instanceof Error) {
        const match = error.message.match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          throw new Error(errorMessage);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  async squashRetryImmutable({
    fromRev,
    toRev,
    message,
    filepaths,
  }: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
  }) {
    try {
      return await this.squash({
        fromRev,
        toRev,
        message,
        filepaths,
      });
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(["Continue"], {
          title: `${toRev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.squash({
          fromRev,
          toRev,
          message,
          filepaths,
          ignoreImmutable: true,
        });
      }
      throw e;
    }
  }

  async squash({
    fromRev,
    toRev,
    message,
    filepaths,
    ignoreImmutable = false,
  }: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
    ignoreImmutable?: boolean;
  }) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            "squash",
            "--from",
            fromRev,
            "--into",
            toRev,
            ...(message ? ["-m", message] : []),
            ...(filepaths
              ? filepaths.map((filepath) => filepathToFileset(filepath))
              : []),
            ...(ignoreImmutable ? ["--ignore-immutable"] : []),
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();
  }

  async squashContentRetryImmutable({
    fromRev,
    toRev,
    filepath,
    content,
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
  }) {
    try {
      return await this.squashContent({
        fromRev,
        toRev,
        filepath,
        content,
      });
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(["Continue"], {
          title: `${toRev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.squashContent({
          fromRev,
          toRev,
          filepath,
          content,
          ignoreImmutable: true,
        });
      }
      throw e;
    }
  }

  /**
   * Squashes a portion of the changes in a file from one revision into another.
   *
   * @param options.fromRev - The revision to squash changes from.
   * @param options.toRev - The revision to squash changes into.
   * @param options.filepath - The path of the file whose changes will be moved.
   * @param options.content - The contents of the file at filepath with some of the changes in fromRev applied to it;
   *                          those changes will be moved to the destination revision.
   */
  async squashContent({
    fromRev,
    toRev,
    filepath,
    content,
    ignoreImmutable = false,
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
    ignoreImmutable?: boolean;
  }): Promise<void> {
    const { succeedFakeeditor, cleanup, envVars } = await prepareFakeeditor();
    return new Promise<void>((resolve, reject) => {
      const childProcess = this.spawnJJ(
        [
          "squash",
          "--from",
          fromRev,
          "--into",
          toRev,
          "--interactive",
          "--tool",
          `${fakeEditorPath}`,
          "--use-destination-message",
          ...(ignoreImmutable ? ["--ignore-immutable"] : []),
        ],
        {
          defaultTimeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
        },
        {
          env: { ...process.env, ...envVars },
        },
      );

      let fakeEditorOutputBuffer = "";
      const FAKEEDITOR_SENTINEL = "FAKEEDITOR_OUTPUT_END\n";

      childProcess.stdout!.on("data", (data: Buffer) => {
        fakeEditorOutputBuffer += data.toString();

        if (!fakeEditorOutputBuffer.includes(FAKEEDITOR_SENTINEL)) {
          // Wait for more data if sentinel not yet received
          return;
        }

        const output = fakeEditorOutputBuffer.substring(
          0,
          fakeEditorOutputBuffer.indexOf(FAKEEDITOR_SENTINEL),
        );

        const lines = output.trim().split("\n");
        const fakeEditorPID = lines[0];
        const fakeEditorCWD = lines[1];
        // lines[2] is the fakeeditor executable path
        const leftFolderPath = lines[3];
        const rightFolderPath = lines[4];

        if (lines.length !== 5) {
          if (fakeEditorPID) {
            try {
              process.kill(parseInt(fakeEditorPID), "SIGTERM");
            } catch (killError) {
              logger.error(
                `Failed to kill fakeeditor (PID: ${fakeEditorPID}) after validation error: ${killError instanceof Error ? killError : ""}`,
              );
            }
          }
          void cleanup();
          reject(new Error(`Unexpected output from fakeeditor: ${output}`));
          return;
        }

        if (
          !fakeEditorPID ||
          !fakeEditorCWD ||
          !leftFolderPath ||
          !leftFolderPath.endsWith("left") ||
          !rightFolderPath ||
          !rightFolderPath.endsWith("right")
        ) {
          if (fakeEditorPID) {
            try {
              process.kill(parseInt(fakeEditorPID), "SIGTERM");
            } catch (killError) {
              logger.error(
                `Failed to kill fakeeditor (PID: ${fakeEditorPID}) after validation error: ${killError instanceof Error ? killError : ""}`,
              );
            }
          }
          void cleanup();
          reject(new Error(`Unexpected output from fakeeditor: ${output}`));
          return;
        }

        const leftFolderAbsolutePath = path.isAbsolute(leftFolderPath)
          ? leftFolderPath
          : path.join(fakeEditorCWD, leftFolderPath);
        const rightFolderAbsolutePath = path.isAbsolute(rightFolderPath)
          ? rightFolderPath
          : path.join(fakeEditorCWD, rightFolderPath);

        // Convert filepath to relative path and join with rightFolderPath
        const relativeFilePath = path.relative(this.repositoryRoot, filepath);
        const fileToEdit = path.join(rightFolderAbsolutePath, relativeFilePath);

        // Ensure right folder is an exact copy of left, then handle the specific file
        void fs
          .rm(rightFolderAbsolutePath, { recursive: true, force: true })
          .then(() => fs.mkdir(rightFolderAbsolutePath, { recursive: true }))
          .then(() =>
            fs.cp(leftFolderAbsolutePath, rightFolderAbsolutePath, {
              recursive: true,
            }),
          )
          .then(() => fs.rm(fileToEdit, { force: true })) // remove the specific file we're about to write to avoid its read-only permissions copied from the left folder
          .then(() => fs.writeFile(fileToEdit, content))
          .then(succeedFakeeditor)
          .catch((error) => {
            if (fakeEditorPID) {
              try {
                process.kill(parseInt(fakeEditorPID), "SIGTERM");
              } catch (killError) {
                logger.error(
                  `Failed to send SIGTERM to fakeeditor (PID: ${fakeEditorPID}) during error handling: ${killError instanceof Error ? killError : ""}`,
                );
              }
            }
            void cleanup();
            reject(error); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
          });
      });

      let errOutput = "";
      childProcess.stderr!.on("data", (data: Buffer) => {
        errOutput += data.toString();
      });

      childProcess.on("close", (code, signal) => {
        void cleanup();
        if (code) {
          reject(
            new Error(
              `Command failed with exit code ${code}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${errOutput}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `Command failed with signal ${signal}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${errOutput}`,
            ),
          );
        } else {
          resolve();
        }
      });
    }).catch(convertJJErrors);
  }

  async log(
    rev: string = "::",
    template: string = "builtin_log_compact",
    limit: number = 50,
    noGraph: boolean = false,
  ) {
    return (
      await handleJJCommand(
        this.spawnJJRead(
          [
            "log",
            "-r",
            rev,
            "-n",
            limit.toString(),
            "-T",
            template,
            ...(noGraph ? ["--no-graph"] : []),
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();
  }

  async editRetryImmutable(rev: string) {
    try {
      return await this.edit(rev);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(["Continue"], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.edit(rev, true);
      }
      throw e;
    }
  }

  async edit(rev: string, ignoreImmutable = false) {
    return await handleJJCommand(
      this.spawnJJ(
        ["edit", "-r", rev, ...(ignoreImmutable ? ["--ignore-immutable"] : [])],
        {
          defaultTimeout: 5000,
        },
      ),
    );
  }

  async restoreRetryImmutable(rev?: string, filepaths?: string[]) {
    try {
      return await this.restore(rev, filepaths);
    } catch (e) {
      if (e instanceof ImmutableError) {
        const choice = await vscode.window.showQuickPick(["Continue"], {
          title: `${rev} is immutable, are you sure?`,
        });
        if (!choice) {
          return;
        }
        return await this.restore(rev, filepaths, true);
      }
      throw e;
    }
  }

  async restore(rev?: string, filepaths?: string[], ignoreImmutable = false) {
    return await handleJJCommand(
      this.spawnJJ(
        [
          "restore",
          "--changes-in",
          rev ? rev : "@",
          ...(filepaths
            ? filepaths.map((filepath) => filepathToFileset(filepath))
            : []),
          ...(ignoreImmutable ? ["--ignore-immutable"] : []),
        ],
        {
          defaultTimeout: 5000,
        },
      ),
    );
  }

  gitFetch(): Promise<void> {
    if (!this.gitFetchPromise) {
      this.gitFetchPromise = (async () => {
        try {
          await handleJJCommand(
            this.spawnJJ(["git", "fetch"], {
              defaultTimeout: 60_000,
            }),
          );
        } finally {
          this.gitFetchPromise = undefined;
        }
      })();
    }
    return this.gitFetchPromise;
  }

  async annotate(filepath: string, rev: string): Promise<string[]> {
    const output = (
      await handleJJCommand(
        this.spawnJJRead(
          [
            "file",
            "annotate",
            "-r",
            rev,
            filepath, // `jj file annotate` takes a path, not a fileset
          ],
          {
            defaultTimeout: 60_000,
          },
        ),
      )
    ).toString();
    if (output === "") {
      return [];
    }
    const lines = output.trim().split("\n");
    const changeIdsByLine = lines.map((line) => line.split(" ")[0]);
    return changeIdsByLine;
  }

  async operationLog(): Promise<Operation[]> {
    const operationSeparator = "ඞඞඞ\n";
    const fieldSeparator = "kjjඞ";
    const templateFields = [
      "self.id()",
      "self.description()",
      "self.tags()",
      "self.time().start()",
      "self.user()",
      "self.snapshot()",
    ];
    const template =
      templateFields.join(` ++ "${fieldSeparator}" ++ `) +
      ` ++ "${operationSeparator}"`;

    const output = (
      await handleJJCommand(
        this.spawnJJRead(
          [
            "operation",
            "log",
            "--limit",
            "10",
            "--no-graph",
            "--at-operation=@",
            "-T",
            template,
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();

    const ret: Operation[] = [];
    const lines = output.split(operationSeparator).slice(0, -1); // the output ends in a separator so remove the empty string at the end
    for (const line of lines) {
      const results = line.split(fieldSeparator);
      if (results.length > templateFields.length) {
        throw new Error(
          "Separator found in a field value. This is not supported.",
        );
      } else if (results.length < templateFields.length) {
        throw new Error("Missing fields in the output.");
      }
      const op: Operation = {
        id: "",
        description: "",
        tags: "",
        start: "",
        user: "",
        snapshot: false,
      };

      for (let i = 0; i < results.length; i++) {
        const field = results[i];
        const value = field.trim();
        switch (templateFields[i]) {
          case "self.id()":
            op.id = value;
            break;
          case "self.description()":
            op.description = value;
            break;
          case "self.tags()":
            op.tags = value;
            break;
          case "self.time().start()":
            op.start = value;
            break;
          case "self.user()":
            op.user = value;
            break;
          case "self.snapshot()":
            op.snapshot = value === "true";
            break;
        }
      }
      ret.push(op);
    }

    return ret;
  }

  async operationUndo(id: string) {
    return (
      await handleJJCommand(
        this.spawnJJ(
          [
            "operation",
            semver.gte(this.jjVersion, "0.33.0") ? "revert" : "undo",
            id,
          ],
          {
            defaultTimeout: 5000,
          },
        ),
      )
    ).toString();
  }

  async operationRestore(id: string) {
    return (
      await handleJJCommand(
        this.spawnJJ(["operation", "restore", id], {
          defaultTimeout: 5000,
        }),
      )
    ).toString();
  }

  /**
   * @returns undefined if the file was not modified in `rev`
   */
  async getDiffOriginal(
    rev: string,
    filepath: string,
  ): Promise<Buffer | undefined> {
    const { cleanup, envVars } = await prepareFakeeditor();

    const output = await new Promise<string>((resolve, reject) => {
      const childProcess = this.spawnJJRead(
        // We don't pass the filepath to diff because we need the left folder to have all files,
        // in case the file was renamed or copied. If we knew the status of the file, we could
        // pass the previous filename in addition to the current filename upon seeing a rename or copy.
        // We don't have the status though, which is why we're using `--summary` here.
        ["diff", "--summary", "--tool", `${fakeEditorPath}`, "-r", rev],
        {
          defaultTimeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
        },
        {
          env: { ...process.env, ...envVars },
        },
      );

      let fakeEditorOutputBuffer = "";
      const FAKEEDITOR_SENTINEL = "FAKEEDITOR_OUTPUT_END\n";

      childProcess.stdout!.on("data", (data: Buffer) => {
        fakeEditorOutputBuffer += data.toString();

        if (!fakeEditorOutputBuffer.includes(FAKEEDITOR_SENTINEL)) {
          // Wait for more data if sentinel not yet received
          return;
        }

        const completeOutput = fakeEditorOutputBuffer.substring(
          0,
          fakeEditorOutputBuffer.indexOf(FAKEEDITOR_SENTINEL),
        );
        resolve(completeOutput);
      });

      const errOutput: Buffer[] = [];
      childProcess.stderr!.on("data", (data: Buffer) => {
        errOutput.push(data);
      });

      childProcess.on("error", (error: Error) => {
        void cleanup();
        reject(new Error(`Spawning command failed: ${error.message}`));
      });

      childProcess.on("close", (code, signal) => {
        void cleanup();
        if (code) {
          reject(
            new Error(
              `Command failed with exit code ${code}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else if (signal) {
          reject(
            new Error(
              `Command failed with signal ${signal}.\nstdout: ${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        } else {
          // This reject will only matter if the promise wasn't resolved already;
          // that means we'll only see this if the command exited without sending the sentinel.
          reject(
            new Error(
              `Command exited unexpectedly.\nstdout:${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        }
      });
    }).catch(convertJJErrors);

    const lines = output.trim().split("\n");
    const pidLineIdx =
      lines.findIndex((line) => {
        return line.includes(fakeEditorPath);
      }) - 2;
    if (pidLineIdx < 0) {
      throw new Error("PID line not found.");
    }
    if (pidLineIdx + 3 >= lines.length) {
      throw new Error(`Unexpected output from fakeeditor: ${output}`);
    }

    const summaryLines = lines.slice(0, pidLineIdx);
    const fakeEditorPID = lines[pidLineIdx];
    const fakeEditorCWD = lines[pidLineIdx + 1];
    // lines[pidLineIdx + 2] is the fakeeditor executable path
    const leftFolderPath = lines[pidLineIdx + 3];

    const leftFolderAbsolutePath = path.isAbsolute(leftFolderPath)
      ? leftFolderPath
      : path.join(fakeEditorCWD, leftFolderPath);

    try {
      let pathInLeftFolder: string | undefined;

      for (const summaryLineRaw of summaryLines) {
        const summaryLine = summaryLineRaw.trim();

        const type = summaryLine.charAt(0);
        const file = summaryLine.slice(2).trim();

        if (type === "M" || type === "D") {
          const normalizedSummaryPath = path
            .join(this.repositoryRoot, file)
            .replace(/\\/g, "/");
          const normalizedTargetPath = path
            .normalize(filepath)
            .replace(/\\/g, "/");
          if (pathEquals(normalizedSummaryPath, normalizedTargetPath)) {
            pathInLeftFolder = file;
            break;
          }
        } else if (type === "R" || type === "C") {
          const parseResult = parseRenamePaths(file);
          if (!parseResult) {
            throw new Error(`Unexpected rename line: ${summaryLineRaw}`);
          }

          const normalizedSummaryPath = path
            .join(this.repositoryRoot, parseResult.toPath)
            .replace(/\\/g, "/");
          const normalizedTargetPath = path
            .normalize(filepath)
            .replace(/\\/g, "/");
          if (pathEquals(normalizedSummaryPath, normalizedTargetPath)) {
            // The file was renamed TO our target filepath, so we need its OLD path from the left folder
            pathInLeftFolder = parseResult.fromPath;
            break;
          }
        }
      }

      if (pathInLeftFolder) {
        const fullPath = path.join(leftFolderAbsolutePath, pathInLeftFolder);
        try {
          return await fs.readFile(fullPath);
        } catch (e) {
          logger.error(
            `Failed to read original file content from left folder at ${fullPath}: ${String(
              e,
            )}`,
          );
          throw e;
        }
      }

      // File was either added or unchanged in this revision.
      return undefined;
    } finally {
      try {
        process.kill(parseInt(fakeEditorPID), "SIGTERM");
      } catch (killError) {
        logger.error(
          `Failed to kill fakeeditor (PID: ${fakeEditorPID}) in getDiffOriginal: ${killError instanceof Error ? killError : ""}`,
        );
      }
    }
  }
}

export type FileStatusType = "A" | "M" | "D" | "R" | "C";

export type FileStatus = {
  type: FileStatusType;
  file: string;
  path: string;
  renamedFrom?: string;
};

export interface Change {
  changeId: string;
  commitId: string;
  bookmarks?: string[];
  description: string;
  isEmpty: boolean;
  isConflict: boolean;
}

export interface ChangeWithDetails extends Change {
  author: {
    name: string;
    email: string;
  };
  authoredDate: string;
  parentChangeIds: string[];
  parentCommitIds: string[];
}

export type RepositoryStatus = {
  fileStatuses: FileStatus[];
  workingCopy: Change;
  parentChanges: Change[];
  conflictedFiles: Set<string>;
};

export type Show = {
  change: ChangeWithDetails;
  fileStatuses: FileStatus[];
  conflictedFiles: Set<string>;
};

export type Operation = {
  id: string;
  description: string;
  tags: string;
  start: string;
  user: string;
  snapshot: boolean;
};

const changeRegex = /^(A|M|D|R|C) (.+)$/;

/**
 * Parses a single file status line matching the `A|M|D|R|C <path>` format
 * produced by both `jj status` and `jj diff --summary`. Appends the result
 * to `out`. Returns true if the line matched, false otherwise.
 */
export function parseFileStatusLine(
  repositoryRoot: string,
  line: string,
  out: FileStatus[],
): boolean {
  const changeMatch = changeRegex.exec(line);
  if (!changeMatch) {
    return false;
  }

  const [_, type, file] = changeMatch;

  if (type === "R" || type === "C") {
    const parsedPaths = parseRenamePaths(file);
    if (parsedPaths) {
      out.push({
        type: type,
        file: parsedPaths.toPath,
        path: path.join(repositoryRoot, parsedPaths.toPath),
        renamedFrom: parsedPaths.fromPath,
      });
    } else {
      throw new Error(
        `Unexpected ${type === "R" ? "rename" : "copy"} line: ${line}`,
      );
    }
  } else {
    const normalizedFile = path.normalize(file).replace(/\\/g, "/");
    out.push({
      type: type as "A" | "M" | "D",
      file: normalizedFile,
      path: path.join(repositoryRoot, normalizedFile),
    });
  }
  return true;
}

async function parseJJStatus(
  repositoryRoot: string,
  output: string,
): Promise<RepositoryStatus> {
  const lines = output.split("\n");
  const fileStatuses: FileStatus[] = [];
  const conflictedFiles = new Set<string>();
  let workingCopy: Change = {
    changeId: "",
    commitId: "",
    description: "",
    isEmpty: false,
    isConflict: false,
  };
  const parentCommits: Change[] = [];

  const commitRegex =
    /^(Working copy|Parent commit)\s*(\(@-?\))?\s*:\s+(\S+)\s+(\S+)(?:\s+(.+?)\s+\|)?(?:\s+(.*))?$/;

  let isParsingConflicts = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const ansiStrippedTrimmedLine = await stripAnsiCodes(trimmedLine);

    if (
      ansiStrippedTrimmedLine === "" ||
      ansiStrippedTrimmedLine.startsWith("Working copy changes:") ||
      ansiStrippedTrimmedLine.startsWith("The working copy is clean")
    ) {
      continue;
    }

    if (
      ansiStrippedTrimmedLine.includes(
        "There are unresolved conflicts at these paths:",
      )
    ) {
      isParsingConflicts = true;
      continue;
    }

    if (isParsingConflicts) {
      const regions = await extractColoredRegions(trimmedLine);
      let filePath = "";
      let firstColoredRegionIndex = -1;
      for (let i = 0; i < regions.length; i++) {
        if (regions[i].colored) {
          firstColoredRegionIndex = i;
          break;
        }
        filePath += regions[i].text;
      }
      filePath = filePath.trim();

      if (ansiStrippedTrimmedLine.includes("To resolve the conflicts")) {
        isParsingConflicts = false;
        continue;
      }

      // If filePath is non-empty and we found a colored region after it, it's a conflict line
      if (filePath && firstColoredRegionIndex !== -1) {
        const normalizedFile = path.normalize(filePath).replace(/\\/g, "/");
        conflictedFiles.add(path.join(repositoryRoot, normalizedFile));
      } else {
        isParsingConflicts = false;
      }
    }

    if (
      parseFileStatusLine(repositoryRoot, ansiStrippedTrimmedLine, fileStatuses)
    ) {
      continue;
    }

    const commitMatch = commitRegex.exec(line);
    if (commitMatch) {
      isParsingConflicts = false;
      const [
        _firstMatch,
        type,
        _at,
        changeId,
        commitId,
        bookmarks,
        descriptionSection,
      ] = commitMatch as unknown as [string, ...(string | undefined)[]];

      if (!type || !changeId || !commitId || !descriptionSection) {
        throw new Error(`Unexpected commit line: ${line}`);
      }

      const descriptionRegions = await extractColoredRegions(
        descriptionSection.trim(),
      );
      const cleanedDescription = descriptionRegions
        .filter((region) => !region.colored)
        .map((region) => region.text)
        .join("")
        .trim();
      const jjDescriptors = descriptionRegions
        .filter((region) => region.colored)
        .map((region) => region.text)
        .join("");
      const isEmpty = jjDescriptors.includes("(empty)");
      const isConflict = jjDescriptors.includes("(conflict)");

      const commitDetails: Change = {
        changeId: await stripAnsiCodes(changeId),
        commitId: await stripAnsiCodes(commitId),
        bookmarks: bookmarks
          ? (await stripAnsiCodes(bookmarks)).split(/\s+/)
          : undefined,
        description: cleanedDescription,
        isEmpty,
        isConflict,
      };

      if ((await stripAnsiCodes(type)) === "Working copy") {
        workingCopy = commitDetails;
      } else if ((await stripAnsiCodes(type)) === "Parent commit") {
        parentCommits.push(commitDetails);
      }
      continue;
    }
  }

  return {
    fileStatuses: fileStatuses,
    workingCopy,
    parentChanges: parentCommits,
    conflictedFiles: conflictedFiles,
  };
}

async function extractColoredRegions(input: string) {
  const { default: ansiRegex } = await import("ansi-regex");
  const regex = ansiRegex();
  let isColored = false;
  const result: { text: string; colored: boolean }[] = [];

  let lastIndex = 0;

  for (const match of input.matchAll(regex)) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (matchStart > lastIndex) {
      result.push({
        text: input.slice(lastIndex, matchStart),
        colored: isColored,
      });
    }

    const code = match[0];
    // Update color state
    if (code === "\x1b[0m" || code === "\x1b[39m") {
      isColored = false;
    } else if (
      // standard foreground colors (30–37)
      /\x1b\[3[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      // bright foreground (90–97)
      /\x1b\[9[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      // 256-color foreground
      /\x1b\[38;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // 256-color background
      /\x1b\[48;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // truecolor fg
      /\x1b\[38;2;\d+;\d+;\d+m/.test(code) || // eslint-disable-line no-control-regex
      // truecolor bg
      /\x1b\[48;2;\d+;\d+;\d+m/.test(code) // eslint-disable-line no-control-regex
    ) {
      isColored = true;
    }

    lastIndex = matchEnd;
  }

  // Remaining text after the last match
  if (lastIndex < input.length) {
    result.push({ text: input.slice(lastIndex), colored: isColored });
  }

  return result;
}

async function stripAnsiCodes(input: string) {
  const { default: ansiRegex } = await import("ansi-regex");
  const regex = ansiRegex();
  return input.replace(regex, "");
}

const renameRegex = /^(.*)\{\s*(.*?)\s*=>\s*(.*?)\s*\}(.*)$/;

export function parseRenamePaths(
  file: string,
): { fromPath: string; toPath: string } | null {
  const renameMatch = renameRegex.exec(file);
  if (renameMatch) {
    const [_, prefix, fromPart, toPart, suffix] = renameMatch;
    const rawFromPath = prefix + fromPart + suffix;
    const rawToPath = prefix + toPart + suffix;
    const fromPath = path.normalize(rawFromPath).replace(/\\/g, "/");
    const toPath = path.normalize(rawToPath).replace(/\\/g, "/");
    return { fromPath, toPath };
  }
  return null;
}

function filepathToFileset(filepath: string): string {
  return `file:"${filepath.replaceAll(/\\/g, "\\\\")}"`;
}

async function prepareFakeeditor(): Promise<{
  succeedFakeeditor: () => Promise<void>;
  cleanup: () => Promise<void>;
  envVars: { [key: string]: string };
}> {
  const random = crypto.randomBytes(16).toString("hex");
  const signalDir = path.join(os.tmpdir(), `jjk-signal-${random}`);

  await fs.mkdir(signalDir, { recursive: true });

  return {
    envVars: { JJ_FAKEEDITOR_SIGNAL_DIR: signalDir },
    succeedFakeeditor: async () => {
      const signalFilePath = path.join(signalDir, "0");
      try {
        await fs.writeFile(signalFilePath, "");
      } catch (error) {
        throw new Error(
          `Failed to write signal file '${signalFilePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    cleanup: async () => {
      try {
        await fs.rm(signalDir, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `Failed to cleanup signal directory '${signalDir}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
