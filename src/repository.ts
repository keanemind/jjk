import path from "path";
import * as vscode from "vscode";
import spawn from "cross-spawn";

export async function findReposInWorkspace() {
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
}

export type FileStatus = {
  type: "A" | "M" | "D" | "R";
  file: string;
  path: string;
  renameDetails?: {
    from: string;
    to: string;
  };
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
  parentCommit: Change;
};

function parseJJStatus(
  repositoryRoot: string,
  output: string
): RepositoryStatus {
  const lines = output.split("\n");
  const changes: FileStatus[] = [];
  let workingCopy: Change = { changeId: "", commitId: "", description: "" };
  let parentCommit: Change = {
    changeId: "",
    commitId: "",
    description: "",
  };

  const changeRegex = /^(A|M|D|R) (.+)$/;
  const commitRegex =
    /^(Working copy |Parent commit): (\S+) (\S+)(?: (\S+) \|)?(?: (.*))?$/;

  const renameRegex = /^(.+) \{(.+) => (.+)\}$/;

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
          const [_, name, from, to] = renameMatch;
          changes.push({
            type: "R",
            file: name,
            path: path.join(repositoryRoot, name),
            renameDetails: {
              from,
              to,
            },
          });
        }
      } else {
        changes.push({
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
        parentCommit = commitDetails;
      }
    }
  }

  return { fileStatuses: changes, workingCopy, parentCommit };
}
