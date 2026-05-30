import * as vscode from "vscode";
import type { LinesDiff } from "./vendor/vscode/editor/common/diff/linesDiffComputer";

export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

export function toLineChanges(diffInformation: LinesDiff): LineChange[] {
  return diffInformation.changes.map((change) => {
    const originalStartLineNumber =
      change.original.startLineNumber === change.original.endLineNumberExclusive
        ? change.original.startLineNumber - 1
        : change.original.startLineNumber;
    const originalEndLineNumber =
      change.original.startLineNumber === change.original.endLineNumberExclusive
        ? 0
        : change.original.endLineNumberExclusive - 1;
    const modifiedStartLineNumber =
      change.modified.startLineNumber === change.modified.endLineNumberExclusive
        ? change.modified.startLineNumber - 1
        : change.modified.startLineNumber;
    const modifiedEndLineNumber =
      change.modified.startLineNumber === change.modified.endLineNumberExclusive
        ? 0
        : change.modified.endLineNumberExclusive - 1;

    return {
      originalStartLineNumber,
      originalEndLineNumber,
      modifiedStartLineNumber,
      modifiedEndLineNumber,
    };
  });
}

export function toLineRanges(
  selections: readonly vscode.Selection[],
  textDocument: vscode.TextDocument,
): vscode.Range[] {
  const lineRanges = selections.map((selection) => {
    const startLine = textDocument.lineAt(selection.start.line);
    const endLine = textDocument.lineAt(selection.end.line);
    return new vscode.Range(startLine.range.start, endLine.range.end);
  });

  lineRanges.sort((left, right) => left.start.line - right.start.line);

  const mergedRanges = lineRanges.reduce((result, range) => {
    if (result.length === 0) {
      result.push(range);
      return result;
    }

    const [last, ...rest] = result;
    const intersection = range.intersection(last);
    if (intersection) {
      return [intersection, ...rest];
    }
    if (range.start.line === last.end.line + 1) {
      return [new vscode.Range(last.start, range.end), ...rest];
    }

    return [range, ...result];
  }, [] as vscode.Range[]);

  mergedRanges.reverse();
  return mergedRanges;
}

export function intersectDiffWithRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
  range: vscode.Range,
): LineChange | null {
  const modifiedRange = getModifiedRange(textDocument, diff);
  const intersection = range.intersection(modifiedRange);
  if (!intersection) {
    return null;
  }

  if (diff.modifiedEndLineNumber === 0) {
    return diff;
  }

  const modifiedStartLineNumber = intersection.start.line + 1;
  const modifiedEndLineNumber = intersection.end.line + 1;

  if (
    diff.originalEndLineNumber - diff.originalStartLineNumber ===
    diff.modifiedEndLineNumber - diff.modifiedStartLineNumber
  ) {
    const delta = modifiedStartLineNumber - diff.modifiedStartLineNumber;
    const length = modifiedEndLineNumber - modifiedStartLineNumber;

    return {
      originalStartLineNumber: diff.originalStartLineNumber + delta,
      originalEndLineNumber: diff.originalStartLineNumber + delta + length,
      modifiedStartLineNumber,
      modifiedEndLineNumber,
    };
  }

  return {
    originalStartLineNumber: diff.originalStartLineNumber,
    originalEndLineNumber: diff.originalEndLineNumber,
    modifiedStartLineNumber,
    modifiedEndLineNumber,
  };
}

function getModifiedRange(
  textDocument: vscode.TextDocument,
  diff: LineChange,
): vscode.Range {
  if (diff.modifiedEndLineNumber !== 0) {
    return new vscode.Range(
      textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.start,
      textDocument.lineAt(diff.modifiedEndLineNumber - 1).range.end,
    );
  }

  if (diff.modifiedStartLineNumber === 0) {
    return new vscode.Range(
      textDocument.lineAt(diff.modifiedStartLineNumber).range.end,
      textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
    );
  }

  if (textDocument.lineCount === diff.modifiedStartLineNumber) {
    return new vscode.Range(
      textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
      textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
    );
  }

  return new vscode.Range(
    textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end,
    textDocument.lineAt(diff.modifiedStartLineNumber).range.start,
  );
}

export function applyLineChanges(
  original: vscode.TextDocument,
  modified: vscode.TextDocument,
  diffs: readonly LineChange[],
): string {
  const result: string[] = [];
  let currentLine = 0;

  for (const diff of diffs) {
    const isInsertion = diff.originalEndLineNumber === 0;
    const isDeletion = diff.modifiedEndLineNumber === 0;

    let endLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalStartLineNumber - 1;
    let endCharacter = 0;

    if (isDeletion && diff.originalEndLineNumber === original.lineCount) {
      endLine -= 1;
      endCharacter = original.lineAt(endLine).range.end.character;
    }

    result.push(
      original.getText(new vscode.Range(currentLine, 0, endLine, endCharacter)),
    );

    if (!isDeletion) {
      let fromLine = diff.modifiedStartLineNumber - 1;
      let fromCharacter = 0;

      if (isInsertion && diff.originalStartLineNumber === original.lineCount) {
        fromLine -= 1;
        fromCharacter = modified.lineAt(fromLine).range.end.character;
      }

      result.push(
        modified.getText(
          new vscode.Range(
            fromLine,
            fromCharacter,
            diff.modifiedEndLineNumber,
            0,
          ),
        ),
      );
    }

    currentLine = isInsertion
      ? diff.originalStartLineNumber
      : diff.originalEndLineNumber;
  }

  result.push(
    original.getText(new vscode.Range(currentLine, 0, original.lineCount, 0)),
  );

  return result.join("");
}
