import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";

async function findReposInWorkspace() {
  const repos: Repository[] = [];
  for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
    const repoRoot = await new Promise<string | undefined>(
      (resolve, reject) => {
        const childProcess = spawn("jj", ["root"], {
          timeout: 5000,
          cwd: workspaceFolder.uri.fsPath,
        });
        let output = "";
        childProcess.on("close", (code) => {
          if (output.includes("There is no jj repo in")) {
            resolve(undefined);
          } else {
            resolve(output.trim());
          }
        });
        childProcess.stdout!.on("data", (data: string) => {
          output += data;
        });
      }
    );
    if (repoRoot) {
      repos.push(new Repository(repoRoot));
    }
  }
  return repos;
}

export class Repositories {
  repos: Repository[] = [];

  async init() {
    this.repos = await findReposInWorkspace();
  }

  getRepository(uri: vscode.Uri) {
    return this.repos.find((repo) => {
      return uri.fsPath.startsWith(vscode.Uri.file(repo.repositoryRoot).fsPath);
    });
  }
}

class Repository {
  constructor(public repositoryRoot: string) {}

  status() {
    return new Promise<RepositoryStatus>((resolve, reject) => {
      const childProcess = spawn("jj", ["status"], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      });
      let output = "";
      childProcess.on("close", (code) => {
        resolve(parseJJStatus(this.repositoryRoot, output));
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
  }

  show(rev: string) {
    return new Promise<Show>((resolve, reject) => {
      const childProcess = spawn("jj", ["show", "-s", "-r", rev], {
        timeout: 5000,
        cwd: this.repositoryRoot,
      });
      let output = "";
      childProcess.on("close", (code) => {
        try {
          resolve(parseJJShow(this.repositoryRoot, output));
        } catch (e) {
          reject(e);
        }
      });
      childProcess.stdout!.on("data", (data: string) => {
        output += data;
      });
    });
  }

  readFile(rev: string, path: string) {
    return new Promise<Buffer>((resolve, reject) => {
      const childProcess = spawn(
        "jj",
        ["file", "show", "--no-pager", "--revision", rev, path],
        {
          timeout: 5000,
          cwd: this.repositoryRoot,
        }
      );
      const buffers: Buffer[] = [];
      childProcess.on("close", (code) => {
        resolve(Buffer.concat(buffers));
      });
      childProcess.stdout!.on("data", (data: Buffer) => {
        buffers.push(data);
      });
    });
  }

  describe(message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const childProcess = spawn("jj", ["describe", "-m", message], {
        cwd: this.repositoryRoot,
      });

      childProcess.on("close", () => {
        resolve();
      });
    });
  }

  new(message?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const childProcess = spawn(
        "jj",
        ["new", ...(message ? ["-m", message] : [])],
        {
          cwd: this.repositoryRoot,
        }
      );

      childProcess.on("close", () => {
        resolve();
      });
    });
  }
}

export type FileStatus = {
  type: "A" | "M" | "D" | "R";
  file: string;
  path: string;
  renamedFrom?: string;
};

export type Change = {
  changeId: string;
  commitId: string;
  branch?: string;
  description: string;
};

export type RepositoryStatus = {
  fileStatuses: FileStatus[];
  workingCopy: Change;
  parentChanges: Change[];
};

export type Show = {
  change: Change;
  fileStatuses: FileStatus[];
};

function parseJJStatus(
  repositoryRoot: string,
  output: string
): RepositoryStatus {
  const lines = output.split("\n");
  const fileStatuses: FileStatus[] = [];
  let workingCopy: Change = { changeId: "", commitId: "", description: "" };
  let parentCommits: Change[] = [];

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
      const finalDescription =
        trimmedDescription === "(no description set)" ? "" : trimmedDescription;

      const commitDetails: Change = {
        changeId: id,
        commitId: hash,
        branch: branch,
        description: finalDescription,
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

function parseJJShow(repositoryRoot: string, output: string): Show {
  const changeRegex = /^(A|M|D|R) (.+)$/;
  const renameRegex = /^\{(.+) => (.+)\}$/;

  const lines = output.split("\n");

  if (lines[0]?.includes("resolved to more than one revision")) {
    throw new Error(lines[0]);
  }

  const ret: Show = {
    change: { changeId: "", commitId: "", description: "" },
    fileStatuses: [],
  };

  for (const line of lines) {
    if (line.trim() === "" || line[0] === " ") {
      continue;
    }

    const changeMatch = changeRegex.exec(line);
    if (changeMatch) {
      const [_, type, file] = changeMatch;

      if (type === "R" && renameRegex.test(file)) {
        const renameMatch = renameRegex.exec(file);
        if (renameMatch) {
          const [_, from, to] = renameMatch;
          ret.fileStatuses.push({
            type: "R",
            file: to,
            path: path.join(repositoryRoot, to),
            renamedFrom: from,
          });
        }
      } else {
        ret.fileStatuses.push({
          type: type as "A" | "M" | "D" | "R",
          file,
          path: path.join(repositoryRoot, file),
        });
      }
    } else if (line.startsWith("Commit ID: ")) {
      ret.change.commitId = line.split(" ")[2];
    } else if (line.startsWith("Change ID: ")) {
      ret.change.changeId = line.split(" ")[2];
    }
  }

  return ret;
}
