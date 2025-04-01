import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import { getRev, toJJUri, withRev } from "./uri";
import type { JJDecorationProvider } from "./decorationProvider";
import { logger } from "./logger";

function spawnJJ(args: string[], options: Parameters<typeof spawn>[2]) {
  logger.info(`spawn: jj ${args.join(" ")}`, {
    spawnOptions: options,
  });
  return spawn("jj", [...args, "--color", "never", "--no-pager"], options);
}

async function createSCMsInWorkspace(decorationProvider: JJDecorationProvider) {
  const repos: RepositorySourceControlManager[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    const repoRoot = await new Promise<string | undefined>((resolve) => {
      const childProcess = spawnJJ(["root"], {
        timeout: 5000,
        cwd: workspaceFolder.uri.fsPath,
      });
      let output = "";
      childProcess.on("close", () => {
        if (output.includes("There is no jj repo in")) {
          resolve(undefined);
        } else {
          resolve(output.trim());
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
    if (repoRoot) {
      repos.push(
        new RepositorySourceControlManager(repoRoot, decorationProvider),
      );
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
          const show = await this.repository.show("@-");
          return toJJUri(withRev(uri, show.change.commitId));
        } else if (uri.scheme === "jj") {
          const rev = getRev(uri);
          const show = await this.repository.show(`${rev}-`);
          return toJJUri(withRev(uri, show.change.commitId));
        }
      },
    };
  }

  async refresh(status: RepositoryStatus) {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshUnsafe(status);
      await this.refreshPromise;
      this.refreshPromise = undefined;
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

    const status = await new Promise<RepositoryStatus>((resolve) => {
      const childProcess = spawnJJ(["status"], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      });
      let output = "";
      childProcess.on("close", () => {
        resolve(parseJJStatus(this.repositoryRoot, output));
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });

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

  fileList() {
    return new Promise<string[]>((resolve) => {
      const childProcess = spawnJJ(["file", "list"], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      });
      let output = "";
      childProcess.on("close", () => {
        resolve(output.trim().split("\n"));
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
  }

  show(rev: string) {
    return new Promise<Show>((resolve, reject) => {
      const separator = "ඞjjk\n";
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
        templateFields.join(` ++ "${separator}" ++ `) + ` ++ "${separator}"`;

      const childProcess = spawnJJ(
        ["log", "-T", template, "--no-graph", "-r", rev],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      );
      let output = "";
      let errOutput = "";
      childProcess.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`jj show exited with code ${code}: ${errOutput}`));
          return;
        }
        try {
          if (!output) {
            throw new Error(
              "No output from jj log. Maybe the revision couldn't be found?",
            );
          }
          const results = output.split(separator);
          if (results.length > templateFields.length + 1) {
            throw new Error(
              "Separator found in a field value. This is not supported.",
            );
          } else if (results.length < templateFields.length + 1) {
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

          for (let i = 0; i < results.length; i++) {
            const field = results[i];
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

          resolve(ret);
        } catch (e) {
          reject(e);
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
      childProcess.stderr!.on("data", (data: string) => {
        errOutput += data;
      });
    });
  }

  readFile(rev: string, filepath: string) {
    return new Promise<Buffer>((resolve, reject) => {
      const relativeFilepath = path.relative(this.repositoryRoot, filepath);
      const childProcess = spawnJJ(
        ["file", "show", "--revision", rev, relativeFilepath],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      );
      const buffers: Buffer[] = [];
      let errOutput = "";
      childProcess.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(`jj file show exited with code ${code}: ${errOutput}`),
          );
          return;
        }
        resolve(Buffer.concat(buffers));
      });
      childProcess.stdout!.on("data", (data: Buffer) => {
        buffers.push(data);
      });
      childProcess.stderr!.on("data", (data: string) => {
        errOutput += data;
      });
    });
  }

  describe(rev: string, message: string): Promise<void> {
    return new Promise((resolve) => {
      const childProcess = spawnJJ(["describe", "-m", message, rev], {
        cwd: this.repositoryRoot,
      });

      childProcess.on("close", () => {
        resolve();
      });
    });
  }

  new(message?: string, revs?: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const childProcess = spawnJJ(
        [
          "new",
          ...(message ? ["-m", message] : []),
          ...(revs ? ["-r", ...revs] : []),
        ],
        {
          cwd: this.repositoryRoot,
        },
      );

      let output = "";
      childProcess.stderr!.on("data", (data: string) => {
        output += data;
      });

      childProcess.on("close", () => {
        const match = output.match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          reject(new Error(errorMessage));
        } else {
          resolve();
        }
      });
    });
  }

  squash({
    fromRev,
    toRev,
    message,
    filepaths,
  }: {
    fromRev: string;
    toRev: string;
    message?: string;
    filepaths?: string[];
  }): Promise<void> {
    return new Promise((resolve) => {
      const childProcess = spawnJJ(
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
          cwd: this.repositoryRoot,
        },
      );

      childProcess.on("close", () => {
        resolve();
      });
    });
  }

  log(
    rev: string = "::",
    template: string = "builtin_log_compact",
    limit: number = 50,
    noGraph: boolean = false,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const childProcess = spawnJJ(
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
          cwd: this.repositoryRoot,
        },
      );

      let output = "";
      childProcess.on("close", () => {
        try {
          resolve(output);
        } catch (e) {
          reject(e);
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
  }

  edit(rev: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawnJJ(["edit", "-r", rev, "--ignore-immutable"], {
        cwd: this.repositoryRoot,
      });
      let output = "";
      childProcess.stderr!.on("data", (data: string) => {
        output += data;
      });

      childProcess.on("close", () => {
        const match = output.trim().match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          reject(new Error(errorMessage));
        } else {
          resolve();
        }
      });
    });
  }

  restore(rev?: string, filepaths?: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const childProcess = spawnJJ(
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
          cwd: this.repositoryRoot,
        },
      );

      let output = "";
      childProcess.stderr!.on("data", (data: string) => {
        output += data;
      });

      childProcess.on("close", () => {
        const match = output.match(/error:\s*([\s\S]+)$/i);
        if (match) {
          const errorMessage = match[1];
          reject(new Error(errorMessage));
        } else {
          resolve();
        }
      });
    });
  }

  gitFetch(): Promise<void> {
    if (!this.gitFetchPromise) {
      this.gitFetchPromise = new Promise<void>((resolve, reject) => {
        const childProcess = spawnJJ(["git", "fetch"], {
          cwd: this.repositoryRoot,
        });

        let output = "";
        childProcess.stderr!.on("data", (data: string) => {
          output += data;
        });

        childProcess.on("close", (code) => {
          this.gitFetchPromise = undefined;
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(output));
          }
        });
      });
    }
    return this.gitFetchPromise;
  }

  async annotate(filepath: string, rev: string): Promise<string[]> {
    const commandPromise = new Promise<string>((resolve, reject) => {
      const childProcess = spawnJJ(
        [
          "file",
          "annotate",
          "-r",
          rev,
          path.relative(this.repositoryRoot, filepath),
        ],
        {
          cwd: this.repositoryRoot,
        },
      );

      let output = "";
      childProcess.on("close", (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`jj file annotate exited with code ${code}`));
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
    const output = await commandPromise;
    if (output === "") {
      return [];
    }
    const lines = output.trim().split("\n");
    const changeIdsByLine = lines.map((line) => line.split(" ")[0]);
    return changeIdsByLine;
  }

  operationLog(): Promise<Operation[]> {
    return new Promise((resolve, reject) => {
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

      const childProcess = spawnJJ(
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
      );
      let output = "";
      childProcess.on("close", (code, signal) => {
        if (code === 0) {
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
          resolve(ret);
        } else {
          reject(
            new Error(`jj operation log exited with code ${code} (${signal})`),
          );
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
  }

  operationUndo(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawnJJ(["operation", "undo", id], {
        cwd: this.repositoryRoot,
      });

      let output = "";
      childProcess.stderr!.on("data", (data: string) => {
        output += data;
      });

      childProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(output));
        }
      });
    });
  }

  operationRestore(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawnJJ(["operation", "restore", id], {
        cwd: this.repositoryRoot,
      });

      let output = "";
      childProcess.stderr!.on("data", (data: string) => {
        output += data;
      });

      childProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(output));
        }
      });
    });
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

function parseJJStatus(
  repositoryRoot: string,
  output: string,
): RepositoryStatus {
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
    /^(Working copy |Parent commit): (\S+) (\S+)(?: (\S+) \|)?(?: (.*))?$/;
  const renameRegex = /^\{(.+) => (.+)\}$/;

  for (const line of lines) {
    if (line.startsWith("Working copy changes:") || line.trim() === "") {
      continue;
    }

    const changeMatch = changeRegex.exec(line);
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
      const [_, type, id, hash, branch, description] = commitMatch;

      const trimmedDescription = description.trim();
      const finalDescription = trimmedDescription.endsWith(
        "(no description set)",
      )
        ? ""
        : trimmedDescription;

      const commitDetails: Change = {
        changeId: id,
        commitId: hash,
        branch: branch,
        description: finalDescription,
        isEmpty: false,
        isConflict: false,
      };

      if (type === "Working copy ") {
        workingCopy = commitDetails;
      } else if (type === "Parent commit") {
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
