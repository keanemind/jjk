import * as crypto from "crypto";
import * as os from "os";
import path from "path";
import fs from "fs/promises";
import * as vscode from "vscode";
import { Context, Effect, Layer } from "effect";

export interface FakeeditorSession {
  readonly envVars: Record<string, string>;
  readonly succeed: Effect.Effect<void, Error>;
  readonly cleanup: Effect.Effect<void, Error>;
}

export interface ExtensionResourcesService {
  readonly extensionDir: string;
  readonly configTomlPath: string;
  readonly fakeEditorPath: string;
  readonly createFakeeditorSession: () => Effect.Effect<
    FakeeditorSession,
    Error
  >;
}

export class ExtensionResources extends Context.Tag("ExtensionResources")<
  ExtensionResources,
  ExtensionResourcesService
>() {}

export interface ExtensionResourcesConfig {
  readonly extensionDir: string;
  readonly configTomlPath: string;
  readonly fakeEditorPath: string;
}

export function resolveExtensionResources(
  extensionUri: vscode.Uri,
  customFakeEditorPath?: string | null,
): ExtensionResourcesConfig {
  const extensionDir = vscode.Uri.joinPath(
    extensionUri,
    extensionUri.fsPath.includes("extensions") ? "dist" : "src",
  ).fsPath;

  const fakeEditorExecutableName = getFakeEditorExecutableName();
  const fakeEditorPath =
    customFakeEditorPath ??
    (fakeEditorExecutableName
      ? path.join(
          extensionDir,
          "fakeeditor",
          "zig-out",
          "bin",
          fakeEditorExecutableName,
        )
      : "");

  return {
    extensionDir,
    configTomlPath: path.join(extensionDir, "config.toml"),
    fakeEditorPath,
  };
}

export function ExtensionResourcesLive(
  config: ExtensionResourcesConfig,
): Layer.Layer<ExtensionResources> {
  return Layer.succeed(ExtensionResources, {
    ...config,
    createFakeeditorSession: () =>
      Effect.gen(function* () {
        const random = yield* Effect.sync(() =>
          crypto.randomBytes(16).toString("hex"),
        );
        const signalDir = path.join(os.tmpdir(), `jjk-signal-${random}`);
        const signalFilePath = path.join(signalDir, "0");

        yield* Effect.tryPromise({
          try: () => fs.mkdir(signalDir, { recursive: true }),
          catch: toError,
        });

        return {
          envVars: { JJ_FAKEEDITOR_SIGNAL_DIR: signalDir },
          succeed: Effect.tryPromise({
            try: () => fs.writeFile(signalFilePath, ""),
            catch: (error) =>
              toErrorWithPrefix(
                error,
                `Failed to write signal file '${signalFilePath}'`,
              ),
          }),
          cleanup: Effect.tryPromise({
            try: () => fs.rm(signalDir, { recursive: true, force: true }),
            catch: (error) =>
              toErrorWithPrefix(
                error,
                `Failed to cleanup signal directory '${signalDir}'`,
              ),
          }),
        } satisfies FakeeditorSession;
      }),
  });
}

function getFakeEditorExecutableName(): string | undefined {
  const fakeEditorExecutables: {
    [platform in typeof process.platform]?: {
      [arch in typeof process.arch]?: string;
    };
  } = {
    freebsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    netbsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    openbsd: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    linux: {
      arm: "fakeeditor_linux_arm",
      arm64: "fakeeditor_linux_aarch64",
      x64: "fakeeditor_linux_x86_64",
    },
    win32: {
      arm64: "fakeeditor_windows_aarch64.exe",
      x64: "fakeeditor_windows_x86_64.exe",
    },
    darwin: {
      arm64: "fakeeditor_macos_aarch64",
      x64: "fakeeditor_macos_x86_64",
    },
  };

  return fakeEditorExecutables[process.platform]?.[process.arch];
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function toErrorWithPrefix(cause: unknown, prefix: string): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${prefix}: ${message}`);
}
