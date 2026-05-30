import path from "path";
import * as fsSync from "fs";
import * as os from "os";
import * as vscode from "vscode";
import spawn from "cross-spawn";
import which from "which";
import semver from "semver";
import { Effect } from "effect";
import { getParams, toJJUri } from "./uri";
import { logger } from "./logger";
import {
  getConfigurationValue,
  getWorkspaceFolders,
  Vscode,
} from "./services/Vscode";

export interface DiscoveredRepoInfo {
  jjPath: { filepath: string; source: "configured" | "path" | "common" };
  jjVersion: string;
  repoRoot: string;
}

export function resolveRepoPath(workspaceRoot: string): string {
  const jjRepoPath = path.join(workspaceRoot, ".jj", "repo");
  if (fsSync.statSync(jjRepoPath).isFile()) {
    const contents = fsSync.readFileSync(jjRepoPath, "utf-8");
    return path.resolve(path.join(workspaceRoot, ".jj"), contents);
  }
  return jjRepoPath;
}

function handleCommand(
  childProcess: import("child_process").ChildProcess,
): Effect.Effect<Buffer, Error> {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
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
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function getJJVersion(jjPath: string): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const version = (yield* handleCommand(
      spawn(jjPath, ["version"], {
        timeout: 5000,
      }),
    ))
      .toString()
      .trim();

    if (version.startsWith("jj")) {
      return version.replace(/^jj\s*/, "");
    }

    return yield* Effect.fail(
      new Error(`Failed to parse jj version from ${jjPath}: ${version}`),
    );
  });
}

export function getJJPathEffect(
  workspaceFolder: string,
): Effect.Effect<
  { filepath: string; source: "configured" | "path" | "common" },
  Error,
  Vscode
> {
  return Effect.gen(function* () {
    const configuredPath = yield* getConfigurationValue<string>(
      "jjk",
      "jjPath",
      workspaceFolder !== undefined
        ? vscode.Uri.file(workspaceFolder)
        : undefined,
    );

    if (configuredPath) {
      const configuredExecutable = yield* Effect.tryPromise({
        try: () => which(configuredPath, { nothrow: true }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (configuredExecutable) {
        return { filepath: configuredPath, source: "configured" } as const;
      }
      return yield* Effect.fail(
        new Error(
          `Configured jjk.jjPath is not an executable file: ${configuredPath}`,
        ),
      );
    }

    const jjInPath = yield* Effect.tryPromise({
      try: () => which("jj", { nothrow: true }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    if (jjInPath) {
      return { filepath: jjInPath, source: "path" } as const;
    }

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
      const jjInCommonPath = yield* Effect.tryPromise({
        try: () => which(commonPath, { nothrow: true }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });
      if (jjInCommonPath) {
        return { filepath: jjInCommonPath, source: "common" } as const;
      }
    }

    return yield* Effect.fail(
      new Error(`jj CLI not found in PATH nor in common locations.`),
    );
  });
}

export function discoverRepositoriesEffect(): Effect.Effect<
  Map<string, DiscoveredRepoInfo>,
  never,
  Vscode
> {
  return Effect.gen(function* () {
    const repoInfos = new Map<string, DiscoveredRepoInfo>();

    const workspaceFolders = yield* getWorkspaceFolders();
    for (const workspaceFolder of workspaceFolders) {
      const result = yield* Effect.either(
        Effect.gen(function* () {
          const jjPath = yield* getJJPathEffect(workspaceFolder.uri.fsPath);
          const jjVersion = yield* getJJVersion(jjPath.filepath);

          if (semver.lt(jjVersion, "0.27.0")) {
            return yield* Effect.fail(
              new Error(
                `jj version ${jjVersion} is not supported. Please upgrade to at least jj 0.27.0.`,
              ),
            );
          }

          const repoRoot = (yield* handleCommand(
            spawn(jjPath.filepath, ["--ignore-working-copy", "root"], {
              cwd: workspaceFolder.uri.fsPath,
              timeout: 5000,
            }),
          ))
            .toString()
            .trim();

          const repoUri = vscode.Uri.file(
            repoRoot.replace(/^\\\\\?\\UNC\\/, "\\\\"),
          ).toString();

          if (!repoInfos.has(repoUri)) {
            repoInfos.set(repoUri, {
              jjPath,
              jjVersion,
              repoRoot,
            });
          }
        }),
      );

      if (result._tag === "Left") {
        const e = result.left;
        if (e instanceof Error && e.message.includes("no jj repo in")) {
          logger.debug(`No jj repo in ${workspaceFolder.uri.fsPath}`);
        } else {
          logger.error(
            `Error while initializing jjk in workspace ${workspaceFolder.uri.fsPath}: ${String(e)}`,
          );
        }
      }
    }

    return repoInfos;
  });
}

export function provideOriginalResource(uri: vscode.Uri) {
  if (!["file", "jj"].includes(uri.scheme)) {
    return undefined;
  }

  let rev = "@";
  if (uri.scheme === "jj") {
    const params = getParams(uri);
    if ("diffOriginalRev" in params) {
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
