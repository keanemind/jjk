import { spawn } from "child_process";

export async function describeCommit(repoPath: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn("jj", ["describe", "-m", message], {
      cwd: repoPath,
    });

    let errorOutput = "";
    childProcess.stderr!.on("data", (data) => {
      errorOutput += data;
    });

    childProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to describe commit: ${errorOutput.trim()}`));
      }
    });
  });
}