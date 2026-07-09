import * as vscode from "vscode";
import { Effect, Ref, Scope } from "effect";
import type { JJCli } from "./services/JJCli";
import type { ExtensionResources } from "./services/ExtensionResources";
import type { Vscode } from "./services/Vscode";
import { getActiveTextEditor, getConfigurationValue } from "./services/Vscode";
import { annotate, getOriginalPath, getShow } from "./services/Repository";
import type { RepoHandle } from "./repoHandle";
import { getParams } from "./uri";
import type { ChangeWithDetails } from "./types";

import type { JjWatchmanRegisterSnapshotTriggerRef } from "./services/JjWatchmanSnapshotTriggerRef";

type RepoEffectEnv =
  | JJCli
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef;

interface AnnotationState {
  readonly annotateInfo: AnnotationInfo | undefined;
  readonly activeEditorUri: vscode.Uri | undefined;
  readonly activeLines: readonly number[];
}

interface AnnotationInfo {
  readonly uri: vscode.Uri;
  readonly changeIdsByLine: readonly string[];
}

export interface AnnotationDeps {
  readonly registerScoped: <A extends { dispose(): unknown }>(
    acquire: () => A,
  ) => Promise<A>;
  readonly runInExtensionScope: <A, E>(
    effect: Effect.Effect<A, E, Vscode | Scope.Scope>,
  ) => Promise<A>;
  readonly dispatchExtensionEffect: (
    effect: Effect.Effect<unknown, Error, Vscode>,
    errorLabel: string,
  ) => void;
  readonly findRepoByUri: (uri: vscode.Uri) => RepoHandle | undefined;
  readonly runRepoEffect: <A, E>(
    repo: RepoHandle,
    effect: Effect.Effect<A, E, RepoEffectEnv>,
  ) => Effect.Effect<A, Error>;
}

export async function setupAnnotations(deps: AnnotationDeps): Promise<void> {
  const annotationDecoration = await deps.registerScoped(() =>
    vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 3em",
        textDecoration: "none",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
    }),
  );
  const annotationState = await deps.runInExtensionScope(
    Ref.make<AnnotationState>({
      annotateInfo: undefined,
      activeEditorUri: undefined,
      activeLines: [],
    }),
  );

  const uriEquals = (
    left: vscode.Uri | undefined,
    right: vscode.Uri | undefined,
  ) => left?.toString() === right?.toString();
  const sameLines = (left: readonly number[], right: readonly number[]) =>
    left.length === right.length &&
    left.every((line, index) => line === right[index]);
  const getAnnotationRev = (uri: vscode.Uri): string => {
    if (uri.scheme !== "jj") {
      return "@";
    }
    const params = getParams(uri);
    return "diffOriginalRev" in params
      ? `${params.diffOriginalRev}-`
      : params.rev;
  };
  const clearAnnotations = (editor: vscode.TextEditor) =>
    Effect.sync(() => {
      editor.setDecorations(annotationDecoration, []);
    });
  const getAnnotationsEnabled = (repo: RepoHandle) =>
    getConfigurationValue<boolean>(
      "jjk",
      "enableAnnotations",
      vscode.Uri.file(repo.config.repositoryRoot),
    );

  const updateAnnotateInfoEffect = (
    uri: vscode.Uri,
  ): Effect.Effect<void, Error, Vscode> =>
    Effect.gen(function* () {
      if (!["file", "jj"].includes(uri.scheme)) {
        yield* Ref.update(annotationState, (state) => ({
          ...state,
          annotateInfo: undefined,
        }));
        return;
      }

      const repo = deps.findRepoByUri(uri);
      if (!repo) {
        yield* Ref.update(annotationState, (state) => ({
          ...state,
          annotateInfo: undefined,
        }));
        return;
      }

      const annotationsEnabled = yield* getAnnotationsEnabled(repo);
      if (!annotationsEnabled) {
        yield* Ref.update(annotationState, (state) => ({
          ...state,
          annotateInfo: undefined,
        }));
        return;
      }

      const rev = getAnnotationRev(uri);
      const params = uri.scheme === "jj" ? getParams(uri) : undefined;
      const annotateEffect =
        params && "diffOriginalRev" in params
          ? getOriginalPath(
              repo.config,
              params.diffOriginalRev,
              uri.fsPath,
            ).pipe(
              Effect.flatMap((originalPath) =>
                annotate(repo.config, originalPath, rev),
              ),
            )
          : annotate(repo.config, uri.fsPath, rev);
      const changeIdsByLine = yield* deps
        .runRepoEffect(repo, annotateEffect)
        .pipe(
          Effect.catchIf(
            (error) => error.message.includes("more than one revision"),
            () => Effect.succeed<string[]>([]),
          ),
        );

      yield* Ref.update(annotationState, (state) => ({
        ...state,
        annotateInfo:
          uriEquals(state.activeEditorUri, uri) && changeIdsByLine.length > 0
            ? { uri, changeIdsByLine }
            : undefined,
      }));
    });

  const setDecorationsEffect = (
    editor: vscode.TextEditor,
    lines: readonly number[],
  ): Effect.Effect<void, Error, Vscode> =>
    Effect.gen(function* () {
      const repo = deps.findRepoByUri(editor.document.uri);
      if (!repo) {
        return;
      }

      const annotationsEnabled = yield* getAnnotationsEnabled(repo);
      if (!annotationsEnabled) {
        yield* clearAnnotations(editor);
        return;
      }

      const state = yield* Ref.get(annotationState);
      if (
        !state.annotateInfo ||
        !uriEquals(state.annotateInfo.uri, editor.document.uri) ||
        !uriEquals(state.activeEditorUri, editor.document.uri) ||
        !sameLines(state.activeLines, lines)
      ) {
        return;
      }

      const annotateInfo = state.annotateInfo;
      const safeLines = lines.filter(
        (line) => line !== annotateInfo.changeIdsByLine.length,
      );
      const changes = new Map(
        yield* Effect.forEach(
          safeLines,
          (line) => {
            const changeId = annotateInfo.changeIdsByLine[line];
            if (!changeId) {
              return Effect.succeed(undefined);
            }
            return deps
              .runRepoEffect(repo, getShow(repo.config, changeId))
              .pipe(
                Effect.map(
                  (showResult) => [changeId, showResult.change] as const,
                ),
              );
          },
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map((entries) =>
            entries.filter(
              (entry): entry is readonly [string, ChangeWithDetails] =>
                entry !== undefined,
            ),
          ),
        ),
      );

      const nextState = yield* Ref.get(annotationState);
      if (
        !nextState.annotateInfo ||
        !uriEquals(nextState.annotateInfo.uri, editor.document.uri) ||
        !uriEquals(nextState.activeEditorUri, editor.document.uri) ||
        !sameLines(nextState.activeLines, lines)
      ) {
        return;
      }

      const decorations: vscode.DecorationOptions[] = [];
      for (const line of safeLines) {
        const changeId = nextState.annotateInfo.changeIdsByLine[line];
        if (!changeId) {
          continue;
        }

        const change = changes.get(changeId);
        if (!change) {
          continue;
        }

        decorations.push({
          renderOptions: {
            after: {
              backgroundColor: "#00000000",
              color: "#99999959",
              contentText: ` ${change.author.name} at ${change.authoredDate} • ${change.description || "(no description)"} • ${change.changeId.substring(0, 8)} `,
              textDecoration: "none;",
            },
          },
          range: editor.document.validateRange(
            new vscode.Range(line, 2 ** 30 - 1, line, 2 ** 30 - 1),
          ),
        });
      }

      yield* Effect.sync(() => {
        editor.setDecorations(annotationDecoration, decorations);
      });
    });

  const provideHoverEffect = (
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Effect.Effect<vscode.Hover | undefined, Error, Vscode> =>
    Effect.gen(function* () {
      const state = yield* Ref.get(annotationState);
      if (
        !state.annotateInfo ||
        !uriEquals(state.annotateInfo.uri, document.uri) ||
        !state.activeLines.includes(position.line)
      ) {
        return undefined;
      }

      // The annotation is rendered after the end of the line, and VS Code
      // anchors hovers over it at the last character of the line
      const annotationRange = document.validateRange(
        new vscode.Range(
          position.line,
          2 ** 30 - 1,
          position.line,
          2 ** 30 - 1,
        ),
      );
      if (annotationRange.start.character !== position.character) {
        return undefined;
      }

      const changeId = state.annotateInfo.changeIdsByLine[position.line];
      if (!changeId) {
        return undefined;
      }

      const repo = deps.findRepoByUri(document.uri);
      if (!repo) {
        return undefined;
      }

      const showResult = yield* deps.runRepoEffect(
        repo,
        getShow(repo.config, changeId),
      );
      const change = showResult.change;
      const shortChangeId = change.changeId.substring(0, 8);
      const viewChangeArgs = encodeURIComponent(
        JSON.stringify([repo.config.repositoryRoot, change.changeId]),
      );
      const openChangesArgs = encodeURIComponent(
        JSON.stringify([change.changeId, document.uri.fsPath, position.line]),
      );
      const message = new vscode.MarkdownString(undefined, true);
      message.isTrusted = {
        enabledCommands: ["jj.viewChange", "jj.openChangeFileDiff"],
      };
      message.appendMarkdown(
        `**${change.author.name}** (${change.author.email}) — ${change.authoredDate}\n\n`,
      );
      message.appendMarkdown(`${change.description || "(no description)"}\n\n`);
      message.appendMarkdown("---\n\n");
      message.appendMarkdown(
        `[$(git-commit) ${shortChangeId}](command:jj.viewChange?${viewChangeArgs} "View all changes in ${shortChangeId}")` +
          ` &nbsp;|&nbsp; ` +
          `[$(compare-changes)](command:jj.openChangeFileDiff?${openChangesArgs} "Open Changes")`,
      );
      return new vscode.Hover(message, annotationRange);
    });

  const handleDidChangeActiveTextEditorEffect = (
    editor: vscode.TextEditor | undefined,
  ): Effect.Effect<void, Error, Vscode> =>
    Effect.gen(function* () {
      if (!editor) {
        yield* Ref.update(annotationState, (state) => ({
          ...state,
          activeEditorUri: undefined,
          annotateInfo: undefined,
          activeLines: [],
        }));
        return;
      }

      const activeLines = editor.selections.map(
        (selection) => selection.active.line,
      );
      yield* Ref.update(annotationState, (state) => ({
        ...state,
        activeEditorUri: editor.document.uri,
        activeLines,
      }));
      yield* updateAnnotateInfoEffect(editor.document.uri);
      yield* setDecorationsEffect(editor, activeLines);
    });

  await deps.registerScoped(() =>
    vscode.languages.registerHoverProvider(
      [{ scheme: "file" }, { scheme: "jj" }],
      {
        provideHover: (document, position) =>
          deps.runInExtensionScope(
            provideHoverEffect(document, position).pipe(
              Effect.catchAll(() => Effect.succeed(undefined)),
            ),
          ),
      },
    ),
  );
  await deps.registerScoped(() =>
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      deps.dispatchExtensionEffect(
        handleDidChangeActiveTextEditorEffect(editor),
        "Failed to update annotations for active editor",
      );
    }),
  );
  await deps.registerScoped(() =>
    vscode.window.onDidChangeTextEditorSelection((event) => {
      deps.dispatchExtensionEffect(
        Effect.gen(function* () {
          const activeLines = event.selections.map(
            (selection) => selection.active.line,
          );
          yield* Ref.update(annotationState, (state) => ({
            ...state,
            activeLines,
          }));
          yield* setDecorationsEffect(event.textEditor, activeLines);
        }),
        "Failed to update annotations for text selection",
      );
    }),
  );
  await deps.registerScoped(() =>
    vscode.workspace.onDidChangeTextDocument((event) => {
      deps.dispatchExtensionEffect(
        Effect.gen(function* () {
          const editor = yield* getActiveTextEditor();
          if (
            !editor ||
            editor.document.uri.toString() !== event.document.uri.toString()
          ) {
            return;
          }

          const state = yield* Ref.get(annotationState);
          yield* setDecorationsEffect(editor, state.activeLines);
        }),
        "Failed to refresh annotations after document change",
      );
    }),
  );
  deps.dispatchExtensionEffect(
    getActiveTextEditor().pipe(
      Effect.flatMap((currentEditor) =>
        currentEditor
          ? handleDidChangeActiveTextEditorEffect(currentEditor)
          : Effect.void,
      ),
    ),
    "Failed to initialize annotations",
  );
}
