import { Context, Effect, Layer, Ref, Stream } from "effect";
import spawn from "cross-spawn";
import { JJCliError, JJImmutableError } from "../types";
import type { RepositoryConfig } from "../types";
import { logger } from "../logger";
import type { ExtensionResourcesConfig } from "./ExtensionResources";
import { getFolderConfigurationValue, type Vscode } from "./Vscode";
import { JjWatchmanRegisterSnapshotTriggerRef } from "./JjWatchmanSnapshotTriggerRef";

export interface FakeeditorHandle {
  /** Stdout content received before the sentinel */
  readonly output: string;
  /** Call this to signal the fakeeditor to proceed, then wait for process exit */
  readonly succeedAndWait: () => Promise<void>;
  /** Kill the fakeeditor process */
  readonly killFakeeditor: (pid: string) => void;
}

export class JJCli extends Context.Tag("JJCli")<
  JJCli,
  {
    readonly run: (
      args: string[],
      opts?: {
        timeout?: number;
        ignoreWorkingCopy?: boolean;
        env?: Record<string, string>;
      },
    ) => Effect.Effect<string, JJCliError | JJImmutableError, Vscode>;
    readonly runBuffer: (
      args: string[],
      opts?: {
        timeout?: number;
        ignoreWorkingCopy?: boolean;
        env?: Record<string, string>;
      },
    ) => Effect.Effect<Buffer, JJCliError | JJImmutableError, Vscode>;
    readonly runStreaming: (
      args: string[],
    ) => Stream.Stream<string, JJCliError, Vscode>;
    /** Run a command with fakeeditor. Resolves when the sentinel is seen in stdout,
     *  returning a handle to interact with the process. */
    readonly runWithFakeeditor: (
      args: string[],
      opts?: {
        timeout?: number;
        env?: Record<string, string>;
      },
    ) => Effect.Effect<FakeeditorHandle, JJCliError | JJImmutableError, Vscode>;
  }
>() {}

function getCommandTimeout(
  repositoryRoot: string | undefined,
  defaultTimeout: number | undefined,
): Effect.Effect<number, never, Vscode> {
  return Effect.gen(function* () {
    if (repositoryRoot) {
      const configuredTimeout = yield* getFolderConfigurationValue<
        number | null
      >("jjk", "commandTimeout", repositoryRoot);
      if (configuredTimeout !== null && configuredTimeout !== undefined) {
        return configuredTimeout;
      }
    }
    return defaultTimeout ?? 30000;
  });
}

export const getPollIgnoreWorkingCopyArgs = (
  repositoryRoot: string,
): Effect.Effect<
  string[],
  never,
  Vscode | JjWatchmanRegisterSnapshotTriggerRef
> =>
  Effect.gen(function* () {
    const pollSnapshot = yield* getFolderConfigurationValue<boolean>(
      "jjk",
      "pollSnapshotWorkingCopy",
      repositoryRoot,
    );
    const watchmanRef = yield* JjWatchmanRegisterSnapshotTriggerRef;
    const watchmanRegistersSnapshotTrigger = yield* Ref.get(watchmanRef);
    const ignoreWorkingCopy =
      pollSnapshot === false || watchmanRegistersSnapshotTrigger;
    return ignoreWorkingCopy ? ["--ignore-working-copy"] : [];
  });

function convertJJErrors(e: Error): JJCliError | JJImmutableError {
  if (e.message.includes("is immutable")) {
    return new JJImmutableError({ message: e.message });
  }
  return new JJCliError({ message: e.message });
}

export function JJCliLive(
  config: RepositoryConfig,
  resources: ExtensionResourcesConfig,
): Layer.Layer<JJCli> {
  const jjConfigArgs = ["--config-file", resources.configTomlPath];

  function spawnJJ(
    args: string[],
    opts?: {
      timeout?: number;
      ignoreWorkingCopy?: boolean;
      env?: Record<string, string>;
    },
  ): Effect.Effect<ReturnType<typeof spawn>, never, Vscode> {
    return Effect.gen(function* () {
      const allArgs = [
        ...(opts?.ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
        ...args,
        ...jjConfigArgs,
      ];

      const timeout = yield* getCommandTimeout(
        config.repositoryRoot,
        opts?.timeout,
      );

      const spawnOptions: Parameters<typeof spawn>[2] = {
        cwd: config.repositoryRoot,
        timeout,
        ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
      };

      logger.info(
        `spawn: ${JSON.stringify([config.jjPath, ...allArgs])} ${JSON.stringify({ spawnOptions })}`,
      );

      return spawn(config.jjPath, allArgs, spawnOptions);
    });
  }

  return Layer.succeed(JJCli, {
    run: (args, opts) =>
      Effect.gen(function* () {
        const child = yield* spawnJJ(args, opts);
        const buffer = yield* Effect.tryPromise({
          try: () =>
            new Promise<Buffer>((resolve, reject) => {
              const output: Buffer[] = [];
              const errOutput: Buffer[] = [];
              child.stdout!.on("data", (data: Buffer) => {
                output.push(data);
              });
              child.stderr!.on("data", (data: Buffer) => {
                errOutput.push(data);
              });
              child.on("error", (error: Error) => {
                reject(new Error(`Spawning command failed: ${error.message}`));
              });
              child.on("close", (code, signal) => {
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
          catch: (e) => convertJJErrors(e as Error),
        });
        return buffer.toString();
      }),

    runBuffer: (args, opts) =>
      Effect.gen(function* () {
        const child = yield* spawnJJ(args, opts);
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<Buffer>((resolve, reject) => {
              const output: Buffer[] = [];
              const errOutput: Buffer[] = [];
              child.stdout!.on("data", (data: Buffer) => {
                output.push(data);
              });
              child.stderr!.on("data", (data: Buffer) => {
                errOutput.push(data);
              });
              child.on("error", (error: Error) => {
                reject(new Error(`Spawning command failed: ${error.message}`));
              });
              child.on("close", (code, signal) => {
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
          catch: (e) => convertJJErrors(e as Error),
        });
      }),

    runStreaming: (args) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const child = yield* spawnJJ(args, { timeout: 0 });
          child.stdout!.setEncoding("utf8");

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              child.kill();
            }),
          );

          return Stream.async<string, JJCliError>((emit) => {
            child.stdout!.on("data", (chunk: string) => {
              void emit.single(chunk);
            });
            child.stdout!.on("end", () => {
              void emit.end();
            });
            child.on("error", (err) => {
              void emit.fail(new JJCliError({ message: err.message }));
            });
            let stderr = "";
            child.stderr!.on("data", (data: string) => {
              stderr += data;
            });
            child.on("close", (code) => {
              if (code !== 0 && code !== null) {
                void emit.fail(
                  new JJCliError({
                    message: `jj exited with code ${code}: ${stderr}`,
                  }),
                );
              }
            });
          });
        }),
      ),

    runWithFakeeditor: (args, opts) =>
      Effect.gen(function* () {
        const child = yield* spawnJJ(args, opts);
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<FakeeditorHandle>((resolve, reject) => {
              const SENTINEL = "FAKEEDITOR_OUTPUT_END\n";
              let stdoutBuffer = "";
              let errOutput = "";

              child.stdout!.on("data", (data: Buffer) => {
                stdoutBuffer += data.toString();

                if (!stdoutBuffer.includes(SENTINEL)) {
                  return;
                }

                const output = stdoutBuffer.substring(
                  0,
                  stdoutBuffer.indexOf(SENTINEL),
                );

                resolve({
                  output,
                  succeedAndWait: () =>
                    new Promise<void>((resolveWait, rejectWait) => {
                      child.on("close", (code, signal) => {
                        if (code) {
                          rejectWait(
                            new Error(
                              `Command failed with exit code ${code}.\nstdout: ${stdoutBuffer}\nstderr: ${errOutput}`,
                            ),
                          );
                        } else if (signal) {
                          rejectWait(
                            new Error(
                              `Command failed with signal ${signal}.\nstdout: ${stdoutBuffer}\nstderr: ${errOutput}`,
                            ),
                          );
                        } else {
                          resolveWait();
                        }
                      });
                    }),
                  killFakeeditor: (pid: string) => {
                    try {
                      process.kill(parseInt(pid), "SIGTERM");
                    } catch (killError) {
                      logger.error(
                        `Failed to kill fakeeditor (PID: ${pid}): ${killError instanceof Error ? killError : ""}`,
                      );
                    }
                  },
                });
              });

              child.stderr!.on("data", (data: Buffer) => {
                errOutput += data.toString();
              });

              child.on("error", (error: Error) => {
                reject(new Error(`Spawning command failed: ${error.message}`));
              });

              child.on("close", (code, signal) => {
                if (code) {
                  reject(
                    new Error(
                      `Command failed with exit code ${code}.\nstdout: ${stdoutBuffer}\nstderr: ${errOutput}`,
                    ),
                  );
                } else if (signal) {
                  reject(
                    new Error(
                      `Command failed with signal ${signal}.\nstdout: ${stdoutBuffer}\nstderr: ${errOutput}`,
                    ),
                  );
                } else {
                  reject(
                    new Error(
                      `Command exited without fakeeditor sentinel.\nstdout: ${stdoutBuffer}\nstderr: ${errOutput}`,
                    ),
                  );
                }
              });
            }),
          catch: (e) => convertJJErrors(e as Error),
        });
      }),
  });
}
