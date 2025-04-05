import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import { getRev, toJJUri, withRev } from "./uri";
import type { JJDecorationProvider } from "./decorationProvider";
import { logger } from "./logger";
import type { ChildProcess } from "child_process";
import fs from "fs";

let jjVersion = "jj 0.28.0";
let configArgs: string[] = []; // Single global array for config arguments

export async function initJJVersion() {
  try {
    const version = (
      await handleCommand(
        spawn("jj", ["version"], {
          timeout: 5000,
        }),
      )
    ).toString();

    if (version.startsWith("jj")) {
      jjVersion = version;
    }
  } catch {
    // Assume the version
  }
  logger.info(jjVersion);
}

export async function initConfigArgs(extensionUri: vscode.Uri) {
  // Determine if we're in development or production mode
  const configDir = extensionUri.fsPath.includes("extensions") ? "dist" : "src";

  const configPath = vscode.Uri.joinPath(
    extensionUri,
    configDir,
    "config.toml",
  ).fsPath;

  // Determine the config option and value based on jj version
  const configOption =
    jjVersion >= "jj 0.25.0" ? "--config-file" : "--config-toml";

  if (configOption === "--config-toml") {
    try {
      const configValue = await fs.promises.readFile(configPath, "utf8");
      configArgs = [configOption, configValue];
    } catch (e) {
      logger.error(`Failed to read config file at ${configPath}`);
      throw e;
    }
  } else {
    configArgs = [configOption, configPath];
  }
}

function spawnJJ(args: string[], options: Parameters<typeof spawn>[2]) {
  const allArgs = [...args, ...configArgs];
  logger.debug(`spawn: jj ${allArgs.join(" ")}`, {
    spawnOptions: options,
  });

  return spawn("jj", allArgs, options);
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

async function createSCMsInWorkspace(decorationProvider: JJDecorationProvider) {
  const repos: RepositorySourceControlManager[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    try {
      const output = (
        await handleCommand(
          spawnJJ(["root"], {
            timeout: 5000,
            cwd: workspaceFolder.uri.fsPath,
          }),
        )
      ).toString();
      const repoRoot = output.trim();
      repos.push(
        new RepositorySourceControlManager(repoRoot, decorationProvider),
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

  constructor(private decorationProvider: JJDecorationProvider) {}

  async refresh() {
    for (const repo of this.repoSCMs) {
      repo.dispose();
    }
    this.repoSCMs = await createSCMsInWorkspace(this.decorationProvider);
  }

  getRepositoryFromUri(uri: vscode.Uri) {
    return this.repoSCMs.find((repo) => {
      return uri.fsPath.startsWith(vscode.Uri.file(repo.repositoryRoot).fsPath);
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
  }
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

  constructor(
    public repositoryRoot: string,
    private decorationProvider: JJDecorationProvider,
  ) {
    this.repository = new JJRepository(repositoryRoot);
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
      provideOriginalResource: async (uri) => {
        // Convert to a specific commitId so our fileSystemProvider can cache properly
        if (uri.scheme === "file") {
          const status = await this.repository.getStatus(true);
          if (status.parentChanges.length === 1) {
            return toJJUri(withRev(uri, status.parentChanges[0].commitId));
          }
        } else if (uri.scheme === "jj") {
          const rev = getRev(uri);
          const showResults = await this.repository.showAll([`${rev}-`]);
          if (showResults.length === 1) {
            return toJJUri(withRev(uri, showResults[0].change.commitId));
          }
        }
      },
    };
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
    const fileStatusesByChange = new Map<string, FileStatus[]>([
      ["@", status.fileStatuses],
    ]);

    this.workingCopyResourceGroup.label = `Working Copy (${
      status.workingCopy.changeId
    }) ${
      status.workingCopy.description
        ? `• ${status.workingCopy.description}`
        : "(no description set)"
    }`;
    this.workingCopyResourceGroup.resourceStates = status.fileStatuses.map(
      (fileStatus) => {
        return {
          resourceUri: withRev(vscode.Uri.file(fileStatus.path), "@"),
          decorations: {
            strikeThrough: fileStatus.type === "D",
            tooltip: path.basename(fileStatus.file),
          },
          command:
            status.parentChanges.length === 1
              ? getResourceStateCommand(
                  fileStatus,
                  toJJUri(
                    withRev(
                      vscode.Uri.file(fileStatus.path),
                      status.parentChanges[0].changeId,
                    ),
                  ),
                  vscode.Uri.file(fileStatus.path),
                  "(Working Copy)",
                )
              : undefined,
        };
      },
    );
    this.sourceControl.count = status.fileStatuses.length;

    const updatedGroups: vscode.SourceControlResourceGroup[] = [];
    for (const group of this.parentResourceGroups) {
      const parentChange = status.parentChanges.find(
        (change) => change.changeId === group.id,
      );
      if (!parentChange) {
        group.dispose();
      } else {
        group.label = `Parent Commit (${parentChange.changeId}) ${
          parentChange.description
            ? `• ${parentChange.description}`
            : "(no description set)"
        }`;
        updatedGroups.push(group);
      }
    }

    this.parentResourceGroups = updatedGroups;

    const trackedFilesList = await this.repository.fileList();
    const trackedFiles = new Set<string>();

    for (const t of trackedFilesList) {
      const pathParts = t.split(path.sep);
      let currentPath = this.repositoryRoot + path.sep;
      for (const p of pathParts) {
        currentPath += p;
        trackedFiles.add(currentPath);
        currentPath += path.sep;
      }
    }

    for (const parentChange of status.parentChanges) {
      let parentChangeResourceGroup:
        | vscode.SourceControlResourceGroup
        | undefined;

      const parentGroup = this.parentResourceGroups.find(
        (group) => group.id === parentChange.changeId,
      );
      if (!parentGroup) {
        parentChangeResourceGroup = this.sourceControl.createResourceGroup(
          parentChange.changeId,
          parentChange.description
            ? `Parent Commit (${parentChange.changeId}) • ${parentChange.description}`
            : `Parent Commit (${parentChange.changeId}) (no description set)`,
        );

        this.parentResourceGroups.push(parentChangeResourceGroup);
      } else {
        parentChangeResourceGroup = parentGroup;
      }

      const showResult = await this.repository.show(parentChange.changeId);

      let grandparentShowResult: Show | undefined;
      try {
        grandparentShowResult = await this.repository.show(
          `${parentChange.changeId}-`,
        );
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message.includes("resolved to more than one revision") ||
            e.message.includes("No output"))
        ) {
          // Leave grandparentShowResult as undefined
        } else {
          throw e;
        }
      }

      parentChangeResourceGroup.resourceStates = showResult.fileStatuses.map(
        (parentStatus) => {
          return {
            resourceUri: withRev(
              vscode.Uri.file(parentStatus.path),
              parentChange.changeId,
            ),
            decorations: {
              strikeThrough: parentStatus.type === "D",
              tooltip: path.basename(parentStatus.file),
            },
            command: grandparentShowResult
              ? getResourceStateCommand(
                  parentStatus,
                  toJJUri(
                    withRev(
                      vscode.Uri.file(parentStatus.path),
                      grandparentShowResult.change.changeId,
                    ),
                  ),
                  toJJUri(
                    withRev(
                      vscode.Uri.file(parentStatus.path),
                      parentChange.changeId,
                    ),
                  ),
                  "(Parent Change)",
                )
              : undefined,
          };
        },
      );

      fileStatusesByChange.set(parentChange.changeId, showResult.fileStatuses);
    }

    this.decorationProvider.onRefresh(fileStatusesByChange, trackedFiles);
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

  async getStatus(useCache = false): Promise<RepositoryStatus> {
    if (useCache && this.statusCache) {
      return this.statusCache;
    }

    const output = (
      await handleCommand(
        spawnJJ(["status", "--color=always"], {
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

  gitFetchPromise: Promise<void> | undefined;

  constructor(public repositoryRoot: string) {}

  async fileList() {
    return (
      await handleCommand(
        spawnJJ(["file", "list"], {
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
        spawnJJ(
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
            const changeRegex = /^(A|M|D|R) (.+)$/;
            const renameRegex = /\{(.+) => (.+)\}$/;
            for (const line of value.split("\n").filter(Boolean)) {
              const changeMatch = changeRegex.exec(line);
              if (changeMatch) {
                const [_, type, file] = changeMatch;

                if (type === "R") {
                  if (renameRegex.test(file)) {
                    const renameMatch = renameRegex.exec(file);
                    if (renameMatch) {
                      const [_, from, to] = renameMatch;
                      ret.fileStatuses.push({
                        type: "R",
                        file: to,
                        path: path.join(this.repositoryRoot, to),
                        renamedFrom: from,
                      });
                    }
                  } else {
                    throw new Error(`Unexpected rename line: ${line}`);
                  }
                } else {
                  ret.fileStatuses.push({
                    type: type as "A" | "M" | "D",
                    file,
                    path: path.join(this.repositoryRoot, file),
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
    const relativeFilepath = path.relative(this.repositoryRoot, filepath);
    return handleCommand(
      spawnJJ(["file", "show", "--revision", rev, relativeFilepath], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      }),
    );
  }

  async describe(rev: string, message: string) {
    return (
      await handleCommand(
        spawnJJ(["describe", "-m", message, rev], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  async new(message?: string, revs?: string[]) {
    try {
      return await handleCommand(
        spawnJJ(
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
        spawnJJ(
          [
            "squash",
            "--from",
            fromRev,
            "--into",
            toRev,
            ...(message ? ["-m", message] : []),
            ...(filepaths
              ? filepaths.map((filepath) =>
                  path.relative(this.repositoryRoot, filepath),
                )
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

  async log(
    rev: string = "::",
    template: string = "builtin_log_compact",
    limit: number = 50,
    noGraph: boolean = false,
  ) {
    return (
      await handleCommand(
        spawnJJ(
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
        spawnJJ(["edit", "-r", rev, "--ignore-immutable"], {
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
        spawnJJ(
          [
            "restore",
            "--changes-in",
            rev ? rev : "@",
            ...(filepaths
              ? filepaths.map((filepath) =>
                  path.relative(this.repositoryRoot, filepath),
                )
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
            spawnJJ(["git", "fetch"], {
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
        spawnJJ(
          [
            "file",
            "annotate",
            "-r",
            rev,
            path.relative(this.repositoryRoot, filepath),
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
        spawnJJ(
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
        spawnJJ(["operation", "undo", id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }

  async operationRestore(id: string) {
    return (
      await handleCommand(
        spawnJJ(["operation", "restore", id], {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }),
      )
    ).toString();
  }
}

export type FileStatusType = "A" | "M" | "D" | "R";

export type FileStatus = {
  type: FileStatusType;
  file: string;
  path: string;
  renamedFrom?: string;
};

export interface Change {
  changeId: string;
  commitId: string;
  branch?: string;
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

  const changeRegex = /^(A|M|D|R) (.+)$/;
  const commitRegex =
    /^(Working copy|Parent commit)\s*(\(@-?\))?\s*:\s+(\S+)\s+(\S+)(?:\s+(\S+)\s+\|)?(?:\s+(.*))?$/;
  const renameRegex = /^\{(.+) => (.+)\}$/;

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

      if (type === "R" && renameRegex.test(file)) {
        const renameMatch = renameRegex.exec(file);
        if (renameMatch) {
          const [_, from, to] = renameMatch;
          fileStatuses.push({
            type: "R",
            file: to,
            path: path.join(repositoryRoot, to),
            renamedFrom: from,
          });
        }
      } else {
        fileStatuses.push({
          type: type as "A" | "M" | "D" | "R",
          file,
          path: path.join(repositoryRoot, file),
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
        branch,
        descriptionSection,
      ] = commitMatch as unknown as [string, ...(string | undefined)[]];

      if (!type || !changeId || !commitId || !descriptionSection) {
        throw new Error(`Unexpected commit line: ${line}`);
      }

      const cleanedDescription = (
        await extractColoredRegions(descriptionSection.trim())
      )
        .filter((region) => !region.colored)
        .map((region) => region.text)
        .join("")
        .trim();

      const commitDetails: Change = {
        changeId: await stripAnsiCodes(changeId),
        commitId: await stripAnsiCodes(commitId),
        branch: branch ? await stripAnsiCodes(branch) : undefined,
        description: cleanedDescription,
        isEmpty: false,
        isConflict: false,
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
