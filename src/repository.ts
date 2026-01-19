import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import fs from "fs/promises";
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

  logger.debug(`spawn: ${jjPath} ${args.join(" ")}`, {
    spawnOptions: finalOptions,
  });

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
              ["root"],
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

    if (isAnyRepoChanged) {
      const repoSCMs: RepositorySourceControlManager[] = [];
      for (const [
        workspaceFolder,
        { repoRoot, jjPath, jjVersion },
      ] of newRepoInfos.entries()) {
        logger.info(
          `Initializing jjk in workspace ${workspaceFolder}. Using ${jjVersion} at ${jjPath.filepath} (${jjPath.source}).`,
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

      for (const repoSCM of this.repoSCMs) {
        repoSCM.dispose();
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
        repo.parentResourceGroups.includes(resourceGroup)
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
        repo.parentResourceGroups.includes(resourceGroup),
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

class RepositorySourceControlManager {
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
  fileStatusesByChange: Map<string, FileStatus[]> = new Map();
  conflictedFilesByChange: Map<string, Set<string>> = new Map();
  trackedFiles: Set<string> = new Set();
  status: RepositoryStatus | undefined;
  parentShowResults: Map<string, Show> = new Map();

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

    const watcherOperations = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.join(this.repositoryRoot, ".jj/repo/op_store/operations"),
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

      await this.updateState(status);
      this.render();

      this._onDidUpdate.fire(undefined);
    }
  }

  async updateState(status: RepositoryStatus) {
    const newTrackedFiles = new Set<string>();
    const newParentShowResults = new Map<string, Show>();
    const newFileStatusesByChange = new Map<string, FileStatus[]>([
      ["@", status.fileStatuses],
    ]);
    const newConflictedFilesByChange = new Map<string, Set<string>>([
      ["@", status.conflictedFiles],
    ]);

    const trackedFilesList = await this.repository.fileList();
    for (const t of trackedFilesList) {
      const pathParts = t.split(path.sep);
      let currentPath = this.repositoryRoot + path.sep;
      for (const p of pathParts) {
        currentPath += p;
        newTrackedFiles.add(currentPath);
        currentPath += path.sep;
      }
    }

    const parentShowPromises = status.parentChanges.map(
      async (parentChange) => {
        const showResult = await this.repository.show(parentChange.changeId);
        return { changeId: parentChange.changeId, showResult };
      },
    );

    const parentShowResultsArray = await Promise.all(parentShowPromises);

    for (const { changeId, showResult } of parentShowResultsArray) {
      newParentShowResults.set(changeId, showResult);
      newFileStatusesByChange.set(changeId, showResult.fileStatuses);
      newConflictedFilesByChange.set(changeId, showResult.conflictedFiles);
    }

    this.status = status;
    this.fileStatusesByChange = newFileStatusesByChange;
    this.conflictedFilesByChange = newConflictedFilesByChange;
    this.parentShowResults = newParentShowResults;
    this.trackedFiles = newTrackedFiles;
  }

  static getLabel(prefix: string, change: Change) {
    return `${prefix} [${change.changeId}]${
      change.description ? ` • ${change.description}` : ""
    }${change.isEmpty ? " (empty)" : ""}${
      change.isConflict ? " (conflict)" : ""
    }${change.description ? "" : " (no description)"}`;
  }

  render() {
    if (!this.status?.workingCopy) {
      throw new Error(
        "Cannot render source control without a current working copy change.",
      );
    }

    this.workingCopyResourceGroup.label =
      RepositorySourceControlManager.getLabel(
        "Working Copy",
        this.status.workingCopy,
      );
    this.workingCopyResourceGroup.resourceStates = this.status.fileStatuses.map(
      (fileStatus) => {
        return {
          resourceUri: vscode.Uri.file(fileStatus.path),
          decorations: {
            strikeThrough: fileStatus.type === "D",
            tooltip: path.basename(fileStatus.file),
          },
          command: getResourceStateCommand(
            fileStatus,
            toJJUri(vscode.Uri.file(`${fileStatus.path}`), {
              diffOriginalRev: "@",
            }),
            vscode.Uri.file(fileStatus.path),
            "(Working Copy)",
          ),
        };
      },
    );
    this.sourceControl.count = this.status.fileStatuses.length;

    const updatedGroups: vscode.SourceControlResourceGroup[] = [];
    for (const group of this.parentResourceGroups) {
      const parentChange = this.status.parentChanges.find(
        (change) => change.changeId === group.id,
      );
      if (!parentChange) {
        group.dispose();
      } else {
        group.label = RepositorySourceControlManager.getLabel(
          "Parent Commit",
          parentChange,
        );
        updatedGroups.push(group);
      }
    }
    this.parentResourceGroups = updatedGroups;

    for (const parentChange of this.status.parentChanges) {
      let parentChangeResourceGroup!: vscode.SourceControlResourceGroup;

      const parentGroup = this.parentResourceGroups.find(
        (group) => group.id === parentChange.changeId,
      );
      if (!parentGroup) {
        parentChangeResourceGroup = this.sourceControl.createResourceGroup(
          parentChange.changeId,
          RepositorySourceControlManager.getLabel(
            "Parent Commit",
            parentChange,
          ),
        );
        this.parentResourceGroups.push(parentChangeResourceGroup);
      } else {
        parentChangeResourceGroup = parentGroup;
      }

      const showResult = this.parentShowResults.get(parentChange.changeId);
      if (showResult) {
        parentChangeResourceGroup.resourceStates = showResult.fileStatuses.map(
          (parentStatus) => {
            return {
              resourceUri: toJJUri(vscode.Uri.file(parentStatus.path), {
                rev: parentChange.changeId,
              }),
              decorations: {
                strikeThrough: parentStatus.type === "D",
                tooltip: path.basename(parentStatus.file),
              },
              command: getResourceStateCommand(
                parentStatus,
                toJJUri(vscode.Uri.file(parentStatus.path), {
                  diffOriginalRev: parentChange.changeId,
                }),
                toJJUri(vscode.Uri.file(parentStatus.path), {
                  rev: parentChange.changeId,
                }),
                `(${parentChange.changeId})`,
              ),
            };
          },
        );
      }
    }

    this.decorationProvider.onRefresh(
      this.fileStatusesByChange,
      this.trackedFiles,
      this.conflictedFilesByChange,
    );
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const group of this.parentResourceGroups) {
      group.dispose();
    }
  }
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

  /**
   * Note: this command may itself snapshot the working copy and add an operation to the log, in which case it will
   * return the new operation id.
   */
  async getLatestOperationId() {
    return (
      await handleJJCommand(
        this.spawnJJ([
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
        this.spawnJJ(["status", "--color=always"], {
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
        this.spawnJJ(["file", "list"], {
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
    const summarySeparator = "@?!"; // characters that are illegal in filepaths
    const templateFields = [
      "change_id",
      "commit_id",
      "author.name()",
      "author.email()",
      'author.timestamp().local().format("%F %H:%M:%S")',
      "description",
      "empty",
      "conflict",
      `diff.files().map(|entry| entry.status() ++ "${summarySeparator}" ++ entry.source().path().display() ++ "${summarySeparator}" ++ entry.target().path().display() ++ "${summarySeparator}" ++ entry.target().conflict()).join("\n")`,
    ];
    const template =
      templateFields.join(` ++ "${fieldSeparator}" ++ `) +
      ` ++ "${revSeparator}"`;

    const output = (
      await handleJJCommand(
        this.spawnJJ(
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
    return revResults.map((revResult) => {
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
          case "author.name()":
            ret.change.author.name = value;
            break;
          case "author.email()":
            ret.change.author.email = value;
            break;
          case 'author.timestamp().local().format("%F %H:%M:%S")':
            ret.change.authoredDate = value;
            break;
          case "description":
            ret.change.description = value;
            break;
          case "empty":
            ret.change.isEmpty = value === "true";
            break;
          case "conflict":
            ret.change.isConflict = value === "true";
            break;
          default: {
            for (const line of value.split("\n").filter(Boolean)) {
              const [status, rawSourcePath, rawTargetPath, conflict] =
                line.split(summarySeparator);
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
                      status === "added"
                        ? "A"
                        : status === "removed"
                          ? "D"
                          : "M",
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
    });
  }

  readFile(rev: string, filepath: string) {
    return handleJJCommand(
      this.spawnJJ(
        ["file", "show", "--revision", rev, filepathToFileset(filepath)],
        {
          defaultTimeout: 5000,
        },
      ),
    );
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
        this.spawnJJ(
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
        this.spawnJJ(
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
        this.spawnJJ(
          [
            "operation",
            "log",
            "--limit",
            "10",
            "--no-graph",
            "--at-operation=@",
            "--ignore-working-copy",
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
        this.spawnJJ(["operation", "undo", id], {
          defaultTimeout: 5000,
        }),
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
      const childProcess = this.spawnJJ(
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

  const changeRegex = /^(A|M|D|R|C) (.+)$/;
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

    const changeMatch = changeRegex.exec(ansiStrippedTrimmedLine);
    if (changeMatch) {
      const [_, type, file] = changeMatch;

      if (type === "R" || type === "C") {
        const parsedPaths = parseRenamePaths(file);
        if (parsedPaths) {
          fileStatuses.push({
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
        fileStatuses.push({
          type: type as "A" | "M" | "D",
          file: normalizedFile,
          path: path.join(repositoryRoot, normalizedFile),
        });
      }
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
