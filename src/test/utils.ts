import { exec } from "child_process";

/**
 * Gets the jj executable path to use in tests.
 * Uses environment variable JJ_PATH if set, otherwise defaults to "jj".
 */
export function getJJPath(): string {
  return process.env.JJ_PATH || "jj";
}

export function execPromise(
  command: string,
  options?: Parameters<typeof exec>["1"],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 1000, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/**
 * Executes a jj command using the configured jj path.
 */
export function execJJPromise(
  args: string,
  options?: Parameters<typeof exec>["1"],
): Promise<{ stdout: string; stderr: string }> {
  const jjPath = getJJPath();
  const command = `${jjPath} ${args}`;
  return execPromise(command, options);
}
