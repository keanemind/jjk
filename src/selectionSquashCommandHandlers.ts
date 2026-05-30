import * as vscode from "vscode";
import { Effect } from "effect";
import { match } from "arktype";
import { linesDiffComputers } from "./vendor/vscode/editor/common/diff/linesDiffComputers";
import {
  showErrorMessage,
  showQuickPick,
  getActiveTextEditor,
  openTextDocument,
} from "./services/Vscode";
import { getShow, jjSquashContent, log } from "./services/Repository";
import type { InitCommandHandlers } from "./commands";
import type { CommandHandlerDeps } from "./commandHandlerShared";
import { readRepoState } from "./commandHandlerShared";
import {
  applyLineChanges,
  intersectDiffWithRange,
  toLineChanges,
  toLineRanges,
} from "./lineDiffUtils";
import { getActiveTextEditorDiff } from "./utils";
import { getParams, toJJUri } from "./uri";

type LinesDiffComputer = {
  readonly computeDiff: (
    originalLines: string[],
    modifiedLines: string[],
    options: {
      ignoreTrimWhitespace: boolean;
      maxComputationTimeMs: number;
      computeMoves: boolean;
    },
  ) => ReturnType<
    ReturnType<typeof linesDiffComputers.getDefault>["computeDiff"]
  >;
};

const computeAndSquashSelectedDiffEffect = (
  deps: CommandHandlerDeps,
  targetRepo: Parameters<CommandHandlerDeps["runRepoCommand"]>[0],
  diffComputer: LinesDiffComputer,
  originalUri: vscode.Uri,
  editor: vscode.TextEditor,
  destinationRev: string,
): Effect.Effect<void, Error, import("./services/Vscode").Vscode> =>
  Effect.gen(function* () {
    const originalDocument = yield* openTextDocument(originalUri);
    const originalLines = originalDocument.getText().split("\n");
    const editorLines = editor.document.getText().split("\n");
    const diff = diffComputer.computeDiff(originalLines, editorLines, {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 5000,
      computeMoves: false,
    });

    const lineChanges = toLineChanges(diff);
    const selectedLines = toLineRanges(editor.selections, editor.document);
    const selectedChanges = lineChanges
      .map((change) =>
        selectedLines.reduce(
          (result, range) =>
            result || intersectDiffWithRange(editor.document, change, range),
          null as (typeof lineChanges)[number] | null,
        ),
      )
      .filter(
        (change): change is (typeof lineChanges)[number] => change !== null,
      );

    if (selectedChanges.length === 0) {
      yield* Effect.forkDaemon(
        showErrorMessage("The selection range does not contain any changes."),
      );
      return;
    }

    const result = applyLineChanges(
      originalDocument,
      editor.document,
      selectedChanges,
    );

    yield* deps.runRepoEffect(
      targetRepo,
      deps
        .retryImmutable(
          jjSquashContent(targetRepo.config, {
            fromRev: "@",
            toRev: destinationRev,
            content: result,
            filepath: originalUri.fsPath,
          }),
          "The target change is immutable. Squash anyway?",
          jjSquashContent(targetRepo.config, {
            fromRev: "@",
            toRev: destinationRev,
            content: result,
            filepath: originalUri.fsPath,
            ignoreImmutable: true,
          }),
        )
        .pipe(Effect.asVoid),
    );
  });

const squashSelectedRangesEffect = (
  deps: CommandHandlerDeps,
): Effect.Effect<void, Error, import("./services/Vscode").Vscode> =>
  Effect.gen(function* () {
    const textEditor = yield* getActiveTextEditor();
    if (!textEditor) {
      return;
    }

    const repo = deps.repoLocator.findRepoByUri(textEditor.document.uri);
    if (!repo) {
      return;
    }

    const state = readRepoState(repo);
    if (!state.status) {
      return;
    }

    const items: ({ changeId: string } & vscode.QuickPickItem)[] = [];
    const childChanges = yield* deps
      .runRepoEffect(
        repo,
        log(repo.config, "all:@+", 'change_id ++ "\\n"', undefined, true),
      )
      .pipe(Effect.catchAll(() => Effect.succeed("")));

    for (const changeId of childChanges.trim().split("\n").filter(Boolean)) {
      const show = yield* deps.runRepoEffect(
        repo,
        getShow(repo.config, changeId),
      );
      items.push({
        label: `$(arrow-up) Child: ${changeId.substring(0, 8)}`,
        description: show.change.description || "(no description)",
        alwaysShow: true,
        changeId,
      });
    }

    for (const parent of state.status.parentChanges) {
      items.push({
        label: `$(arrow-down) Parent: ${parent.changeId.substring(0, 8)}`,
        description: parent.description || "(no description)",
        alwaysShow: true,
        changeId: parent.changeId,
      });
    }

    const selected = yield* showQuickPick(items, {
      placeHolder: "Select destination change for squashing selected lines",
      ignoreFocusOut: true,
    });
    if (!selected) {
      return;
    }

    const destinationRev = selected.changeId;
    const diffInput = getActiveTextEditorDiff();
    const status = state.status;

    if (
      diffInput &&
      diffInput.modified.scheme === "file" &&
      diffInput.original.scheme === "jj" &&
      match({})
        .case({ diffOriginalRev: "string" }, ({ diffOriginalRev }) =>
          [
            "@",
            status.workingCopy.changeId,
            status.workingCopy.commitId,
          ].includes(diffOriginalRev),
        )
        .default(() => false)(getParams(diffInput.original))
    ) {
      yield* computeAndSquashSelectedDiffEffect(
        deps,
        repo,
        linesDiffComputers.getDefault(),
        diffInput.original,
        textEditor,
        destinationRev,
      );
      return;
    }

    if (textEditor.document.uri.scheme === "file") {
      yield* computeAndSquashSelectedDiffEffect(
        deps,
        repo,
        linesDiffComputers.getLegacy(),
        toJJUri(textEditor.document.uri, {
          diffOriginalRev: status.workingCopy.commitId,
        }),
        textEditor,
        destinationRev,
      );
    }
  });

export const createSelectionSquashInitHandlers = (
  deps: CommandHandlerDeps,
): Pick<InitCommandHandlers, "squashSelectedRanges"> => ({
  squashSelectedRanges: () => {
    deps.dispatchExtensionEffect(
      squashSelectedRangesEffect(deps),
      "Failed to squash selection",
    );
  },
});
