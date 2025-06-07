import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import fs from "fs/promises";
import { getParams, toJJUri } from "./uri";
import type { JJDecorationProvider } from "./decorationProvider";
import { logger } from "./logger";
import type { ChildProcess } from "child_process";
import { anyEvent } from "./utils";
import { JJFileSystemProvider } from "./fileSystemProvider";
import * as os from "os";
import * as crypto from "crypto";
import which from "which";

async function getJJVersion(jjPath: string): Promise<string> {
  try {
    const version = (
      await handleCommand(
        spawn(jjPath, ["version"], {
          timeout: 5000,
        }),
      )
    ).toString();

    if (version.startsWith("jj")) {
      return version;
    }
  } catch {
    // Assume the version
  }
  return "jj 0.28.0";
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

async function getConfigArgs(
  extensionDir: string,
  jjVersion: string,
): Promise<string[]> {
  const configPath = path.join(extensionDir, "config.toml");

  // Determine the config option and value based on jj version
  const configOption =
    jjVersion >= "jj 0.25.0" ? "--config-file" : "--config-toml";

  if (configOption === "--config-toml") {
    try {
      const configValue = await fs.readFile(configPath, "utf8");
      return [configOption, configValue];
    } catch (e) {
      logger.error(`Failed to read config file at ${configPath}`);
      throw e;
    }
  } else {
    return [configOption, configPath];
  }
}

/**
 * If jjk.commandTimeout is set, returns that value.
 * Otherwise, returns the provided default timeout, or 30 seconds if no default is provided.
 */
function getCommandTimeout(
  repositoryRoot: string,
  defaultTimeout: number | undefined,
): number {
  const config = vscode.workspace.getConfiguration(
    "jjk",
    vscode.Uri.file(repositoryRoot),
  );
  const configuredTimeout = config.get<number | null>("commandTimeout");
  if (configuredTimeout !== null && configuredTimeout !== undefined) {
    return configuredTimeout;
  }
  return defaultTimeout ?? 30000;
}

/**
 * Gets the configured jj executable path from settings.
 * If no path is configured, searches through common installation paths before falling back to "jj".
 */
async function getJJPath(workspaceFolder: string): Promise<string> {
  const config = vscode.workspace.getConfiguration(
    "jjk",
    workspaceFolder !== undefined
      ? vscode.Uri.file(workspaceFolder)
      : undefined,
  );
  const configuredPath = config.get<string>("jjPath");

  if (configuredPath) {
    if (await which(configuredPath, { nothrow: true })) {
      logger.info(`Using configured jjk.jjPath: ${configuredPath}`);
      return configuredPath;
    } else {
      throw new Error(
        `Configured jjk.jjPath is not an executable file: ${configuredPath}`,
      );
    }
  }

  const jjInPath = await which("jj", { nothrow: true });
  if (jjInPath) {
    logger.info(`Found jj in PATH: ${jjInPath}`);
    return jjInPath;
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
      logger.info(`Found jj in: ${jjInCommonPath}`);
      return jjInCommonPath;
    }
  }

  throw new Error(`jj CLI not found in PATH nor in common locations.`);
}

function spawnJJ(
  jjPath: string,
  args: string[],
  options: Parameters<typeof spawn>[2] & { cwd: string },
) {
  const finalOptions = {
    ...options,
    timeout: getCommandTimeout(options.cwd, options.timeout),
  };

  logger.debug(`spawn: ${jjPath} ${args.join(" ")}`, {
    spawnOptions: finalOptions,
  });

  return spawn(jjPath, args, finalOptions);
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

async function createSCMsInWorkspace(
  decorationProvider: JJDecorationProvider,
  fileSystemProvider: JJFileSystemProvider,
) {
  const repos: RepositorySourceControlManager[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    try {
      const jjPath = await getJJPath(workspaceFolder.uri.fsPath);
      const jjVersion = await getJJVersion(jjPath);
      const jjConfigArgs = await getConfigArgs(extensionDir, jjVersion);

      const repoRoot = (
        await handleCommand(
          spawnJJ(jjPath, ["root", ...jjConfigArgs], {
            timeout: 5000,
            cwd: workspaceFolder.uri.fsPath,
          }),
        )
      )
        .toString()
        .trim();
      repos.push(
        new RepositorySourceControlManager(
          repoRoot,
          decorationProvider,
          fileSystemProvider,
          jjPath,
          jjVersion,
          jjConfigArgs,
        ),
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("no jj repo in")) {
        // Ignore this error, as it means there is no jj repo in this workspace folder
        logger.info(`No jj repo in ${workspaceFolder.uri.fsPath}`);
        continue;
      }
      throw e;
    }
  }
  return repos;
}

export class WorkspaceSourceControlManager {
  repoSCMs: RepositorySourceControlManager[] = [];
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  fileSystemProvider: JJFileSystemProvider;

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
    for (const repo of this.repoSCMs) {
      repo.dispose();
    }
    this.repoSCMs = await createSCMsInWorkspace(
      this.decorationProvider,
      this.fileSystemProvider,
    );
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
  refreshPromise: Promise<void> | undefined;

  fileStatusesByChange: Map<string, FileStatus[]> = new Map();
  trackedFiles: Set<string> = new Set();
  status: RepositoryStatus | undefined;
  parentShowResults: Map<string, Show> = new Map();

  constructor(
    public repositoryRoot: string,
    private decorationProvider: JJDecorationProvider,
    private fileSystemProvider: JJFileSystemProvider,
    jjPath: string,
    jjVersion: string,
    jjConfigArgs: string[],
  ) {
    this.repository = new JJRepository(
      repositoryRoot,
      jjPath,
      jjVersion,
      jjConfigArgs,
    );
    this.subscriptions.push(
      this.repository.onDidRunJJStatus((status) => this.refresh(status)),
    );

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
      (uri) => {
        this.fileSystemProvider.onDidChangeRepository({
          repositoryRoot: this.repositoryRoot,
          uri,
        });
      },
      undefined,
      this.subscriptions,
    );
  }

  async refresh(status: RepositoryStatus) {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshUnsafe(status);
      try {
        await this.refreshPromise;
      } finally {
        this.refreshPromise = undefined;
      }
    } else {
      await this.refreshPromise;
    }
  }

  /**
   * This should never be called concurrently.
   */
  async refreshUnsafe(status: RepositoryStatus) {
    await this.updateState(status);
    this.render();
  }

  async updateState(status: RepositoryStatus) {
    const newTrackedFiles = new Set<string>();
    const newParentShowResults = new Map<string, Show>();
    const newFileStatusesByChange = new Map<string, FileStatus[]>([
      ["@", status.fileStatuses],
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
    }

    this.status = status;
    this.fileStatusesByChange = newFileStatusesByChange;
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
  private _onDidChangeStatus = new vscode.EventEmitter<RepositoryStatus>();
  readonly onDidRunJJStatus: vscode.Event<RepositoryStatus> =
    this._onDidChangeStatus.event;

  statusCache: RepositoryStatus | undefined;
  gitFetchPromise: Promise<void> | undefined;

  constructor(
    public repositoryRoot: string,
    private jjPath: string,
    private jjVersion: string,
    private jjConfigArgs: string[],
  ) {}

  spawnJJ(
    args: string[],
    options: Parameters<typeof spawn>[2] & { cwd: string },
  ) {
    return spawnJJ(this.jjPath, [...args, ...this.jjConfigArgs], options);
  }

  async getStatus(useCache = false): Promise<RepositoryStatus> {
    if (useCache && this.statusCache) {
      return this.statusCache;
    }

    const output = (
      await handleCommand(
        this.spawnJJ(["status", "--color=always"], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
    const status = await parseJJStatus(this.repositoryRoot, output);

    this.statusCache = status;
    return status;
  }

  async status(useCache = false): Promise<RepositoryStatus> {
    const status = await this.getStatus(useCache);
    this._onDidChangeStatus.fire(status);
    return status;
  }

  async fileList() {
    return (
      await handleCommand(
        this.spawnJJ(["file", "list"], {
          timeout: 5000,
          cwd: this.repositoryRoot,
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
    const separator = "ඞjjk";
    const templateFields = [
      "change_id",
      "commit_id",
      "author.name()",
      "author.email()",
      'author.timestamp().local().format("%F %H:%M:%S")',
      "description",
      "empty",
      "conflict",
      "diff.summary()",
    ];
    const template =
      templateFields.join(` ++ "${separator}" ++ `) + ` ++ "${revSeparator}"`;

    const output = (
      await handleCommand(
        this.spawnJJ(
          [
            "log",
            "-T",
            template,
            "--no-graph",
            ...revsets.flatMap((revset) => ["-r", revset]),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
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
      const fields = revResult.split(separator);
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
          case "diff.summary()": {
            const changeRegex = /^(A|M|D|R|C) (.+)$/;
            for (const line of value.split("\n").filter(Boolean)) {
              const changeMatch = changeRegex.exec(line);
              if (changeMatch) {
                const [_, type, file] = changeMatch;

                if (type === "R" || type === "C") {
                  const parsedPaths = parseRenamePaths(file);
                  if (parsedPaths) {
                    ret.fileStatuses.push({
                      type: type,
                      file: parsedPaths.toPath,
                      path: path.join(this.repositoryRoot, parsedPaths.toPath),
                      renamedFrom: parsedPaths.fromPath,
                    });
                  } else {
                    throw new Error(
                      `Unexpected ${type === "R" ? "rename" : "copy"} line: ${line}`,
                    );
                  }
                } else {
                  const normalizedFile = path
                    .normalize(file)
                    .replace(/\\/g, "/");
                  ret.fileStatuses.push({
                    type: type as "A" | "M" | "D",
                    file: normalizedFile,
                    path: path.join(this.repositoryRoot, normalizedFile),
                  });
                }
              } else {
                throw new Error(`Unexpected diff summary line: ${line}`);
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
    return handleCommand(
      this.spawnJJ(
        ["file", "show", "--revision", rev, filepathToFileset(filepath)],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      ),
    );
  }

  async describe(rev: string, message: string) {
    return (
      await handleCommand(
        this.spawnJJ(["describe", "-m", message, rev], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  async new(message?: string, revs?: string[]) {
    try {
      return await handleCommand(
        this.spawnJJ(
          [
            "new",
            ...(message ? ["-m", message] : []),
            ...(revs ? ["-r", ...revs] : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
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

  async squash({
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
    return (
      await handleCommand(
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
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
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
  }: {
    fromRev: string;
    toRev: string;
    filepath: string;
    content: string;
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
        ],
        {
          timeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
          cwd: this.repositoryRoot,
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
        // lines[1] is the fakeeditor executable path
        const leftFolderPath = lines[2];
        const rightFolderPath = lines[3];

        if (lines.length !== 4) {
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

        // Convert filepath to relative path and join with rightFolderPath
        const relativeFilePath = path.relative(this.repositoryRoot, filepath);
        const fileToEdit = path.join(rightFolderPath, relativeFilePath);

        // Ensure right folder is an exact copy of left, then handle the specific file
        void fs
          .rm(rightFolderPath, { recursive: true, force: true })
          .then(() => fs.mkdir(rightFolderPath, { recursive: true }))
          .then(() =>
            fs.cp(leftFolderPath, rightFolderPath, { recursive: true }),
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
    });
  }

  async log(
    rev: string = "::",
    template: string = "builtin_log_compact",
    limit: number = 50,
    noGraph: boolean = false,
  ) {
    return (
      await handleCommand(
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
            timeout: 5000,
            cwd: this.repositoryRoot,
          },
        ),
      )
    ).toString();
  }

  async edit(rev: string) {
    try {
      return await handleCommand(
        this.spawnJJ(["edit", "-r", rev, "--ignore-immutable"], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
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

  async restore(rev?: string, filepaths?: string[]) {
    try {
      return await handleCommand(
        this.spawnJJ(
          [
            "restore",
            "--changes-in",
            rev ? rev : "@",
            ...(filepaths
              ? filepaths.map((filepath) => filepathToFileset(filepath))
              : []),
          ],
          {
            timeout: 5000,
            cwd: this.repositoryRoot,
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

  gitFetch(): Promise<void> {
    if (!this.gitFetchPromise) {
      this.gitFetchPromise = (async () => {
        try {
          await handleCommand(
            this.spawnJJ(["git", "fetch"], {
              timeout: 60_000,
              cwd: this.repositoryRoot,
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
      await handleCommand(
        this.spawnJJ(
          [
            "file",
            "annotate",
            "-r",
            rev,
            filepath, // `jj file annotate` takes a path, not a fileset
          ],
          {
            timeout: 60_000,
            cwd: this.repositoryRoot,
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
      await handleCommand(
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
            timeout: 5000,
            cwd: this.repositoryRoot,
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
      await handleCommand(
        this.spawnJJ(["operation", "undo", id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  async operationRestore(id: string) {
    return (
      await handleCommand(
        this.spawnJJ(["operation", "restore", id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
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
        [
          "diff",
          "--summary",
          "--tool",
          `${fakeEditorPath}`,
          "-r",
          rev,
          filepathToFileset(filepath),
        ],
        {
          timeout: 10_000, // Ensure this is longer than fakeeditor's internal timeout
          cwd: this.repositoryRoot,
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
          // This reject will only matter if the promise wasn't resolved already; that means we'll only
          // see if this if the command exited without sending the sentinel.
          reject(
            new Error(
              `Command exited unexpectedly.\nstdout:${fakeEditorOutputBuffer}\nstderr: ${Buffer.concat(errOutput).toString()}`,
            ),
          );
        }
      });
    });

    const lines = output.trim().split("\n");
    const pidLineIdx =
      lines.findIndex((line) => {
        return line.includes(fakeEditorPath);
      }) - 1;
    if (pidLineIdx < 0) {
      throw new Error("PID line not found.");
    }
    if (pidLineIdx + 2 >= lines.length) {
      throw new Error(`Unexpected output from fakeeditor: ${output}`);
    }

    const summaryLines = lines.slice(0, pidLineIdx);
    const fakeEditorPID = lines[pidLineIdx];
    // lines[pidLineIdx + 1] is the fakeeditor executable path
    const leftFolderPath = lines[pidLineIdx + 2];

    try {
      if (summaryLines.length === 0) {
        // No changes to the file
        return undefined;
      } else if (summaryLines.length > 1) {
        throw new Error(
          `Unexpected number of summary lines (${summaryLines.length}): ${summaryLines.join("\n")}`,
        );
      }

      const summaryLine = summaryLines[0].trim();
      // Check if the file was modified or deleted
      if (/^(M|D)\s+/.test(summaryLine)) {
        const filePath = summaryLine.slice(2).trim();
        const fullPath = path.join(leftFolderPath, filePath);

        return fs.readFile(fullPath);
      } else {
        return undefined;
      }
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
};

export type Show = {
  change: ChangeWithDetails;
  fileStatuses: FileStatus[];
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

  for (const line of lines) {
    if (
      line.startsWith("Working copy changes:") ||
      line.startsWith("The working copy is clean") ||
      line.trim() === ""
    ) {
      continue;
    }

    const ansiStrippedLine = await stripAnsiCodes(line);

    const changeMatch = changeRegex.exec(ansiStrippedLine);
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
    }
  }

  return {
    fileStatuses: fileStatuses,
    workingCopy,
    parentChanges: parentCommits,
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
