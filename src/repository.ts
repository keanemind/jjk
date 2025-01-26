import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import { ChangeNode } from "./graphProvider";
import type { JJDecorationProvider } from "./decorationProvider";
import { toJJUri } from "./uri";

async function createSCMsInWorkspace(decorationProvider: JJDecorationProvider) {
  const repos: RepositorySourceControlManager[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    const repoRoot = await new Promise<string | undefined>((resolve) => {
      const childProcess = spawn("jj", ["root"], {
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
  }

  async refresh(status: RepositoryStatus) {
    this.decorationProvider.onDidRunStatus(status);

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
          resourceUri: vscode.Uri.file(fileStatus.path),
          decorations: {
            strikeThrough: fileStatus.type === "D",
            tooltip: path.basename(fileStatus.file),
          },
          command:
            status.parentChanges.length === 1
              ? {
                  title: "Open",
                  command: "vscode.diff",
                  arguments: [
                    toJJUri(
                      vscode.Uri.file(fileStatus.path),
                      status.parentChanges[0].changeId,
                    ),
                    vscode.Uri.file(fileStatus.path),
                    (fileStatus.renamedFrom
                      ? `${fileStatus.renamedFrom} => `
                      : "") + `${fileStatus.file} (Working Copy)`,
                  ],
                }
              : undefined,
        };
      },
    );

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
        this.subscriptions.push(parentChangeResourceGroup);
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
          e.message.includes("resolved to more than one revision")
        ) {
          // Leave grandparentShowResult as undefined
        } else {
          throw e;
        }
      }

      parentChangeResourceGroup.resourceStates = showResult.fileStatuses.map(
        (parentStatus) => {
          return {
            resourceUri: toJJUri(
              vscode.Uri.file(parentStatus.path),
              parentChange.changeId,
            ),
            decorations: {
              strikeThrough: parentStatus.type === "D",
              tooltip: path.basename(parentStatus.file),
            },
            command: grandparentShowResult
              ? {
                  title: "Open",
                  command: "vscode.diff",
                  arguments: [
                    toJJUri(
                      vscode.Uri.file(parentStatus.path),
                      grandparentShowResult.change.changeId,
                    ),
                    toJJUri(
                      vscode.Uri.file(parentStatus.path),
                      parentChange.changeId,
                    ),
                    (parentStatus.renamedFrom
                      ? `${parentStatus.renamedFrom} => `
                      : "") + `${parentStatus.file} (Parent Change)`,
                  ],
                }
              : undefined,
          };
        },
      );

      this.decorationProvider.addDecorators(
        showResult.fileStatuses.map((status) =>
          toJJUri(vscode.Uri.file(status.path), parentChange.changeId),
        ),
        showResult.fileStatuses,
      );
    }
  }

  dispose() {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

export class JJRepository {
  private _onDidChangeStatus = new vscode.EventEmitter<RepositoryStatus>();
  readonly onDidRunJJStatus: vscode.Event<RepositoryStatus> =
    this._onDidChangeStatus.event;

  statusCache: RepositoryStatus | undefined;
  gitFetchPromise: Promise<void> | undefined;

  constructor(public repositoryRoot: string) {}

  status(readCache = false) {
    if (readCache && this.statusCache) {
      return Promise.resolve(this.statusCache);
    }
    return new Promise<RepositoryStatus>((resolve) => {
      const childProcess = spawn("jj", ["status"], {
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
    }).then((status) => {
      this.statusCache = status;
      this._onDidChangeStatus.fire(status);
      return status;
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

      const childProcess = spawn(
        "jj",
        ["show", "--no-pager", "-T", template, rev],
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

  readFile(rev: string, path: string) {
    return new Promise<Buffer>((resolve) => {
      const childProcess = spawn(
        "jj",
        ["file", "show", "--no-pager", "--revision", rev, path],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        },
      );
      const buffers: Buffer[] = [];
      childProcess.on("close", () => {
        resolve(Buffer.concat(buffers));
      });
      childProcess.stdout!.on("data", (data: Buffer) => {
        buffers.push(data);
      });
    });
  }

  describe(rev: string, message: string): Promise<void> {
    return new Promise((resolve) => {
      const childProcess = spawn("jj", ["describe", "-m", message, rev], {
        cwd: this.repositoryRoot,
      });

      childProcess.on("close", () => {
        resolve();
      });
    });
  }

  new(message?: string, revs?: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const childProcess = spawn(
        "jj",
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
      const childProcess = spawn(
        "jj",
        [
          "squash",
          "--from",
          fromRev,
          "--into",
          toRev,
          ...(message ? ["-m", message] : []),
          ...(filepaths ? filepaths : []),
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

  log(): Promise<ChangeNode[]> {
    return new Promise((resolve, reject) => {
      const childProcess = spawn("jj", ["log", "-r", "::", "--limit", "50"], {
        cwd: this.repositoryRoot,
      });

      let output = "";
      childProcess.on("close", () => {
        try {
          resolve(parseJJLog(output));
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
      const childProcess = spawn(
        "jj",
        ["edit", "-r", rev, "--ignore-immutable"],
        {
          cwd: this.repositoryRoot,
        },
      );
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

  restore(rev?: string, files?: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const childProcess = spawn(
        "jj",
        ["restore", "--changes-in", rev ? rev : "@", ...(files ? files : [])],
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
        const childProcess = spawn("jj", ["git", "fetch"], {
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

  async annotate(file: string): Promise<string[]> {
    const commandPromise = new Promise<string>((resolve, reject) => {
      const childProcess = spawn("jj", ["file", "annotate", file], {
        cwd: this.repositoryRoot,
      });

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
    const lines = output.trim().split("\n");
    const changeIdsByLine = lines.map((line) => line.split(" ")[0]);
    return changeIdsByLine;
  }

  operationLog(): Promise<Operation[]> {
    return new Promise((resolve, reject) => {
      const separator = "ඞjjk";
      const templateFields = [
        "self.id()",
        "self.description()",
        "self.tags()",
        "self.time().start()",
        "self.user()",
        "self.snapshot()",
      ];
      const template =
        templateFields.join(` ++ "${separator}" ++ `) + ' ++ "\n"';

      const childProcess = spawn(
        "jj",
        [
          "operation",
          "log",
          "--limit",
          "10",
          "--no-graph",
          "--no-pager",
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
          const lines = output.trim().split("\n");
          for (const line of lines) {
            const results = line.split(separator);
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
      const childProcess = spawn("jj", ["operation", "undo", id], {
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
      const childProcess = spawn("jj", ["operation", "restore", id], {
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

function parseJJLog(output: string): ChangeNode[] {
  const lines = output.split("\n");
  const changeNodes: ChangeNode[] = [];

  for (let i = 0; i < lines.length; i += 2) {
    const oddLine = lines[i];
    let evenLine = lines[i + 1] || "";

    let changeId = "";
    if (i % 2 === 0) {
      // Check if the line is odd-numbered (0-based index, so 0, 2, 4... are odd lines)
      const match = oddLine.match(/\b([a-zA-Z0-9]+)\b/); // Match the first group of alphanumeric characters
      if (match) {
        changeId = match[1];
      }
    }

    // Match the first alphanumeric character or opening parenthesis and everything after it
    const match = evenLine.match(/([a-zA-Z0-9(].*)/);
    const description = match ? match[1] : "";

    // Remove the description from the even line
    if (description) {
      evenLine = evenLine.replace(description, "");
    }

    const emailMatch = oddLine.match(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    );
    const timestampMatch = oddLine.match(
      /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/,
    );
    const symbolsMatch = oddLine.match(/^[^a-zA-Z0-9(]+/);
    const commitIdMatch = oddLine.match(/([a-zA-Z0-9]{8})$/);

    const symbolFormatted = symbolsMatch
      ? symbolsMatch[0].replace(/\s/g, "   ").trimEnd()
      : "";

    let formattedLine;
    if (symbolFormatted !== "") {
      formattedLine = `${symbolFormatted}   ${description}${changeId === "zzzzzzzz" ? "root()" : ""} • ${changeId} • ${commitIdMatch ? commitIdMatch[0] : ""}`;
    } else {
      formattedLine = "";
    }

    // Create a ChangeNode for the odd line with the appended description
    changeNodes.push(
      new ChangeNode(
        formattedLine,
        `${emailMatch ? emailMatch[0] : ""} ${timestampMatch ? timestampMatch[0] : ""}`,
        changeId,
        changeId,
      ),
    );

    // Create a ChangeNode for the remaining even line
    if (evenLine) {
      const formattedEvenLine = evenLine.replace(/(?<![a-zA-Z0-9)])\s/g, "   ");
      changeNodes.push(new ChangeNode(formattedEvenLine, "", "", ""));
    }
  }

  return changeNodes;
}

export type FileStatus = {
  type: "A" | "M" | "D" | "R";
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
