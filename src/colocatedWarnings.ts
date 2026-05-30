import * as vscode from "vscode";
import { Effect } from "effect";
import type { RepoHandle } from "./repoHandle";
import {
  executeCommand,
  getConfigurationValue,
  showWarningMessage,
  stat,
  type Vscode,
} from "./services/Vscode";
import { registerColocatedWarningCommand } from "./commands";

type RegisterScoped = <A extends { dispose(): unknown }>(
  acquire: () => A,
) => Promise<A>;

export interface ColocatedWarningsController {
  readonly checkRepos: (
    specificFolders?: readonly string[],
  ) => Effect.Effect<void, Error, Vscode>;
}

export interface ColocatedWarningsDeps {
  readonly repos: () => readonly RepoHandle[];
  readonly registerScoped: RegisterScoped;
  readonly dispatchExtensionEffect: (
    effect: Effect.Effect<unknown, Error, Vscode>,
    errorLabel: string,
  ) => void;
}

export async function setupColocatedWarnings(
  deps: ColocatedWarningsDeps,
): Promise<ColocatedWarningsController> {
  const statusBarItem = await deps.registerScoped(() =>
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
  );
  const reposWithWarnings = new Set<string>();
  const reposWithShownWarnings = new Set<string>();

  const fileExistsEffect = (
    uri: vscode.Uri,
  ): Effect.Effect<boolean, never, Vscode> =>
    stat(uri).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );

  const showColocatedWarningEffect = (
    repoRoot: string,
  ): Effect.Effect<void, Error, Vscode> =>
    Effect.gen(function* () {
      const folderName = repoRoot.split("/").at(-1) || repoRoot;
      const message = `Colocated Jujutsu and Git repository detected in "${folderName}". Consider disabling the Git extension to avoid conflicts.`;
      const openSettings = "Open Folder Settings";
      const selection = yield* showWarningMessage(message, openSettings);
      if (selection === openSettings) {
        yield* executeCommand("jj.openFolderGitSettings", repoRoot);
      }
    });

  const updateWarningStatusBar = (): Effect.Effect<void> =>
    Effect.sync(() => {
      if (reposWithWarnings.size > 0) {
        statusBarItem.text = `$(warning) JJK Issues (${reposWithWarnings.size})`;
        statusBarItem.tooltip = "Click to view colocated repository warnings";
        statusBarItem.command = "jj.showColocatedWarnings";
        statusBarItem.show();
        return;
      }

      statusBarItem.hide();
    });

  const showCurrentWarningsEffect = (): Effect.Effect<void, Error, Vscode> =>
    Effect.forEach(Array.from(reposWithWarnings), showColocatedWarningEffect, {
      discard: true,
    });

  await registerColocatedWarningCommand(deps.registerScoped, {
    showColocatedWarnings: () => {
      deps.dispatchExtensionEffect(
        showCurrentWarningsEffect(),
        "Failed to show colocated repository warnings",
      );
    },
  });

  return {
    checkRepos: (specificFolders) =>
      Effect.gen(function* () {
        const reposNeedingWarning: string[] = [];

        for (const repo of deps.repos()) {
          const repoRoot = repo.config.repositoryRoot;
          if (specificFolders && !specificFolders.includes(repoRoot)) {
            continue;
          }

          const repoUri = vscode.Uri.file(repoRoot);
          const jjDirExists = yield* fileExistsEffect(
            vscode.Uri.joinPath(repoUri, ".jj"),
          );
          const gitDirExists = yield* fileExistsEffect(
            vscode.Uri.joinPath(repoUri, ".git"),
          );

          if (!jjDirExists || !gitDirExists) {
            reposWithWarnings.delete(repoRoot);
            reposWithShownWarnings.delete(repoRoot);
            continue;
          }

          const isGitEnabled = yield* getConfigurationValue<boolean>(
            "git",
            "enabled",
            repoUri,
          );
          if (!isGitEnabled) {
            reposWithWarnings.delete(repoRoot);
            reposWithShownWarnings.delete(repoRoot);
            continue;
          }

          if (!reposWithShownWarnings.has(repoRoot)) {
            reposWithShownWarnings.add(repoRoot);
            reposNeedingWarning.push(repoRoot);
          }
          reposWithWarnings.add(repoRoot);
        }

        yield* updateWarningStatusBar();
        if (reposNeedingWarning.length > 0) {
          yield* Effect.sync(() => {
            deps.dispatchExtensionEffect(
              Effect.forEach(reposNeedingWarning, showColocatedWarningEffect, {
                discard: true,
              }),
              "Failed to show colocated repository warnings",
            );
          });
        }
      }),
  };
}
