import { spawn } from "child_process";

export async function createCommit(repoPath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn("jj", ["new"], {
      cwd: repoPath,
    });

    let output = "";
    childProcess.stderr!.on("data", (data) => {
    console.log('error');
      output += data;
    });

    childProcess.on("close", (code) => {
        resolve(output);
    });
  });
}