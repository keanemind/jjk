import path from "path";
import ansiRegex from "ansi-regex";
import type {
  Change,
  FileStatus,
  Operation,
  RepositoryStatus,
  Show,
} from "./types";
import {
  CommitT,
  Expr,
  OperationT,
  concat,
  jjIf,
  str,
  stringify,
  template,
  type RecordTemplate,
} from "./jjTemplate";

const commit = new CommitT();
const operation = new OperationT();

export const SHOW_FILE_SEPARATOR = "j@j@k";
export const SHOW_FILE_FIELD_SEPARATOR = "@?!"; // characters that are illegal in filepaths

const parentIdList = (getId: (p: CommitT) => Expr) =>
  jjIf(
    commit.parents(),
    concat(
      str("["),
      commit
        .parents()
        .map("p", (p) => stringify(getId(p)).escape_json())
        .join(","),
      str("]"),
    ),
    str("[]"),
  );

const showDiffExpr = commit
  .diff()
  .files()
  .map("entry", (e) =>
    concat(
      e.status(),
      str(SHOW_FILE_FIELD_SEPARATOR),
      e.source().path().display(),
      str(SHOW_FILE_FIELD_SEPARATOR),
      e.target().path().display(),
      str(SHOW_FILE_FIELD_SEPARATOR),
      e.target().conflict(),
    ),
  )
  .join(SHOW_FILE_SEPARATOR);

export const showRecordTemplate = template({
  fieldSeparator: "ඞjjk",
  recordSeparator: "jjkඞ\n",
})
  .field("changeId", commit.change_id())
  .field("commitId", commit.commit_id())
  .field(
    "parentChangeIds",
    parentIdList((p) => p.change_id()),
  )
  .field(
    "parentCommitIds",
    parentIdList((p) => p.commit_id()),
  )
  .field("authorName", commit.author().name())
  .field("authorEmail", commit.author().email())
  .field(
    "authoredDate",
    commit.author().timestamp().local().format(str("%F %H:%M:%S")),
  )
  .field("description", commit.description().escape_json())
  .field("empty", commit.empty())
  .field("conflict", commit.conflict())
  .field("diffFiles", showDiffExpr)
  .build();

export const showPaginatedRecordTemplate = template({
  fieldSeparator: "ඞjjk",
  recordSeparator: "jjkඞ\n",
  startSentinel: "ඞSTARTඞ",
})
  .field("changeId", commit.change_id())
  .field("commitId", commit.commit_id())
  .field(
    "parentChangeIds",
    parentIdList((p) => p.change_id()),
  )
  .field(
    "parentCommitIds",
    parentIdList((p) => p.commit_id()),
  )
  .field("authorName", commit.author().name())
  .field("authorEmail", commit.author().email())
  .field(
    "authoredDate",
    commit.author().timestamp().local().format(str("%F %H:%M:%S")),
  )
  .field("description", commit.description().escape_json())
  .field("empty", commit.empty())
  .field("conflict", commit.conflict())
  .field("diffFiles", showDiffExpr)
  .build();

export const operationRecordTemplate = template({
  fieldSeparator: "kjjඞ",
  recordSeparator: "ඞඞඞ\n",
})
  .field("id", operation.id())
  .field("description", operation.description())
  .field("tags", operation.tags())
  .field("start", operation.time().start())
  .field("user", operation.user())
  .field("snapshot", operation.snapshot())
  .build();

// --- ANSI processing ---

const ansiPattern = ansiRegex();

function stripAnsiCodes(input: string) {
  return input.replace(ansiPattern, "");
}

function extractColoredRegions(input: string) {
  let isColored = false;
  const result: { text: string; colored: boolean }[] = [];

  let lastIndex = 0;

  for (const match of input.matchAll(ansiPattern)) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (matchStart > lastIndex) {
      result.push({
        text: input.slice(lastIndex, matchStart),
        colored: isColored,
      });
    }

    const code = match[0];
    if (code === "\x1b[0m" || code === "\x1b[39m") {
      isColored = false;
    } else if (
      /\x1b\[3[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      /\x1b\[9[0-7]m/.test(code) || // eslint-disable-line no-control-regex
      /\x1b\[38;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      /\x1b\[48;5;\d+m/.test(code) || // eslint-disable-line no-control-regex
      /\x1b\[38;2;\d+;\d+;\d+m/.test(code) || // eslint-disable-line no-control-regex
      /\x1b\[48;2;\d+;\d+;\d+m/.test(code) // eslint-disable-line no-control-regex
    ) {
      isColored = true;
    }

    lastIndex = matchEnd;
  }

  if (lastIndex < input.length) {
    result.push({ text: input.slice(lastIndex), colored: isColored });
  }

  return result;
}

// --- Rename parsing ---

const renameRegex = /^(.*)\{\s*(.*?)\s*=>\s*(.*?)\s*\}(.*)$/;

export function parseRenamePaths(
  file: string,
): { fromPath: string; toPath: string } | null {
  const renameMatch = renameRegex.exec(file);
  if (renameMatch) {
    const [_, prefix, fromPart, toPart, suffix] = renameMatch;
    const rawFromPath = prefix + fromPart + suffix;
    const rawToPath = prefix + toPart + suffix;
    const fromPath = path.normalize(rawFromPath).replace(/\\/g, "/");
    const toPath = path.normalize(rawToPath).replace(/\\/g, "/");
    return { fromPath, toPath };
  }
  return null;
}

// --- Status parsing ---

export function parseStatus(
  repositoryRoot: string,
  output: string,
): RepositoryStatus {
  const lines = output.split("\n");
  const fileStatuses: FileStatus[] = [];
  const conflictedFiles = new Set<string>();
  let workingCopy: Change = {
    changeId: "",
    commitId: "",
    description: "",
    isEmpty: false,
    isConflict: false,
  };
  const parentCommits: Change[] = [];

  const changeRegex = /^(A|M|D|R|C) (.+)$/;
  const commitRegex =
    /^(Working copy|Parent commit)\s*(\(@-?\))?\s*:\s+(\S+)\s+(\S+)(?:\s+(.+?)\s+\|)?(?:\s+(.*))?$/;

  let isParsingConflicts = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const ansiStrippedTrimmedLine = stripAnsiCodes(trimmedLine);

    if (
      ansiStrippedTrimmedLine === "" ||
      ansiStrippedTrimmedLine.startsWith("Working copy changes:") ||
      ansiStrippedTrimmedLine.startsWith("The working copy is clean")
    ) {
      continue;
    }

    if (
      ansiStrippedTrimmedLine.includes(
        "There are unresolved conflicts at these paths:",
      )
    ) {
      isParsingConflicts = true;
      continue;
    }

    if (isParsingConflicts) {
      const regions = extractColoredRegions(trimmedLine);
      let filePath = "";
      let firstColoredRegionIndex = -1;
      for (let i = 0; i < regions.length; i++) {
        if (regions[i].colored) {
          firstColoredRegionIndex = i;
          break;
        }
        filePath += regions[i].text;
      }
      filePath = filePath.trim();

      if (ansiStrippedTrimmedLine.includes("To resolve the conflicts")) {
        isParsingConflicts = false;
        continue;
      }

      if (filePath && firstColoredRegionIndex !== -1) {
        const normalizedFile = path.normalize(filePath).replace(/\\/g, "/");
        conflictedFiles.add(path.join(repositoryRoot, normalizedFile));
      } else {
        isParsingConflicts = false;
      }
    }

    const changeMatch = changeRegex.exec(ansiStrippedTrimmedLine);
    if (changeMatch) {
      const [_, type, file] = changeMatch;

      if (type === "R" || type === "C") {
        const parsedPaths = parseRenamePaths(file);
        if (parsedPaths) {
          fileStatuses.push({
            type: type,
            file: parsedPaths.toPath,
            path: path.join(repositoryRoot, parsedPaths.toPath),
            renamedFrom: parsedPaths.fromPath,
          });
        } else {
          throw new Error(
            `Unexpected ${type === "R" ? "rename" : "copy"} line: ${line}`,
          );
        }
      } else {
        const normalizedFile = path.normalize(file).replace(/\\/g, "/");
        fileStatuses.push({
          type: type as "A" | "M" | "D",
          file: normalizedFile,
          path: path.join(repositoryRoot, normalizedFile),
        });
      }
      continue;
    }

    const commitMatch = commitRegex.exec(line);
    if (commitMatch) {
      isParsingConflicts = false;
      const [
        _firstMatch,
        type,
        _at,
        changeId,
        commitId,
        bookmarks,
        descriptionSection,
      ] = commitMatch as unknown as [string, ...(string | undefined)[]];

      if (!type || !changeId || !commitId || !descriptionSection) {
        throw new Error(`Unexpected commit line: ${line}`);
      }

      const descriptionRegions = extractColoredRegions(
        descriptionSection.trim(),
      );
      const cleanedDescription = descriptionRegions
        .filter((region) => !region.colored)
        .map((region) => region.text)
        .join("")
        .trim();
      const jjDescriptors = descriptionRegions
        .filter((region) => region.colored)
        .map((region) => region.text)
        .join("");
      const isEmpty = jjDescriptors.includes("(empty)");
      const isConflict = jjDescriptors.includes("(conflict)");

      const commitDetails: Change = {
        changeId: stripAnsiCodes(changeId),
        commitId: stripAnsiCodes(commitId),
        bookmarks: bookmarks
          ? stripAnsiCodes(bookmarks).split(/\s+/)
          : undefined,
        description: cleanedDescription,
        isEmpty,
        isConflict,
      };

      if (stripAnsiCodes(type) === "Working copy") {
        workingCopy = commitDetails;
      } else if (stripAnsiCodes(type) === "Parent commit") {
        parentCommits.push(commitDetails);
      }
      continue;
    }
  }

  return {
    fileStatuses,
    workingCopy,
    parentChanges: parentCommits,
    conflictedFiles,
  };
}

// --- Show result parsing ---

export function parseShowResult(
  repositoryRoot: string,
  revResult: string,
  rt: RecordTemplate,
  summaryFileSeparator: string,
  summaryFileFieldSeparator: string,
): Show {
  const parseJsonStringArray = (value: string, fieldName: string) => {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`Unexpected ${fieldName} JSON payload.`);
    }
    return parsed.map((item) => String(item));
  };
  const fields = revResult.split(rt.fieldSeparator);
  if (fields.length > rt.fields.length) {
    throw new Error("Separator found in a field value. This is not supported.");
  } else if (fields.length < rt.fields.length) {
    throw new Error("Missing fields in the output.");
  }
  const ret: Show = {
    change: {
      changeId: "",
      commitId: "",
      parentChangeIds: [],
      parentCommitIds: [],
      description: "",
      author: {
        email: "",
        name: "",
      },
      authoredDate: "",
      isEmpty: false,
      isConflict: false,
    },
    fileStatuses: [],
    conflictedFiles: new Set<string>(),
  };

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const value = field.trim();
    switch (rt.fields[i].name) {
      case "changeId":
        ret.change.changeId = value;
        break;
      case "commitId":
        ret.change.commitId = value;
        break;
      case "parentChangeIds": {
        ret.change.parentChangeIds = parseJsonStringArray(
          value,
          "parent change ids",
        );
        break;
      }
      case "parentCommitIds": {
        ret.change.parentCommitIds = parseJsonStringArray(
          value,
          "parent commit ids",
        );
        break;
      }
      case "authorName":
        ret.change.author.name = value;
        break;
      case "authorEmail":
        ret.change.author.email = value;
        break;
      case "authoredDate":
        ret.change.authoredDate = value;
        break;
      case "description":
        {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed !== "string") {
            throw new Error("Unexpected description JSON payload.");
          }
          ret.change.description = parsed;
        }
        break;
      case "empty":
        ret.change.isEmpty = value === "true";
        break;
      case "conflict":
        ret.change.isConflict = value === "true";
        break;
      case "diffFiles": {
        for (const line of value.split(summaryFileSeparator).filter(Boolean)) {
          const [status, rawSourcePath, rawTargetPath, conflict] = line.split(
            summaryFileFieldSeparator,
          );
          const sourcePath = path.normalize(rawSourcePath).replace(/\\/g, "/");
          const targetPath = path.normalize(rawTargetPath).replace(/\\/g, "/");
          if (
            ["modified", "added", "removed", "copied", "renamed"].includes(
              status,
            )
          ) {
            if (status === "renamed" || status === "copied") {
              ret.fileStatuses.push({
                type: status === "renamed" ? "R" : "C",
                file: path.basename(targetPath),
                path: path.join(repositoryRoot, targetPath),
                renamedFrom: sourcePath,
              });
            } else {
              ret.fileStatuses.push({
                type:
                  status === "added" ? "A" : status === "removed" ? "D" : "M",
                file: path.basename(targetPath),
                path: path.join(repositoryRoot, targetPath),
              });
            }
            if (conflict === "true") {
              ret.conflictedFiles.add(path.join(repositoryRoot, targetPath));
            }
          } else {
            throw new Error(`Unexpected diff custom summary line: ${line}`);
          }
        }
        break;
      }
      default:
        throw new Error(`Unexpected show field: ${rt.fields[i].name}`);
    }
  }

  return ret;
}

// --- Operation log parsing ---

export function parseOperationLog(
  raw: string,
  rt: RecordTemplate,
): Operation[] {
  const ret: Operation[] = [];
  const lines = raw.split(rt.recordSeparator).slice(0, -1);
  for (const line of lines) {
    const results = line.split(rt.fieldSeparator);
    if (results.length > rt.fields.length) {
      throw new Error(
        "Separator found in a field value. This is not supported.",
      );
    } else if (results.length < rt.fields.length) {
      throw new Error("Missing fields in the output.");
    }
    const op: Operation = {
      id: "",
      description: "",
      tags: "",
      start: "",
      user: "",
      snapshot: false,
    };

    for (let i = 0; i < results.length; i++) {
      const field = results[i];
      const value = field.trim();
      switch (rt.fields[i].name) {
        case "id":
          op.id = value;
          break;
        case "description":
          op.description = value;
          break;
        case "tags":
          op.tags = value;
          break;
        case "start":
          op.start = value;
          break;
        case "user":
          op.user = value;
          break;
        case "snapshot":
          op.snapshot = value === "true";
          break;
        default:
          throw new Error(
            `Unexpected operation log field: ${rt.fields[i].name}`,
          );
      }
    }
    ret.push(op);
  }

  return ret;
}

// --- Log parsing (for graph webview) ---

export class ChangeNode {
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  parentChangeIds?: string[];
  branchType?: string;
  constructor(
    label: string,
    description: string,
    tooltip: string,
    contextValue: string,
    parentChangeIds?: string[],
    branchType?: string,
  ) {
    this.label = label;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = contextValue;
    this.parentChangeIds = parentChangeIds;
    this.branchType = branchType;
  }
}

export function parseLog(output: string): ChangeNode[] {
  const lines = output.split("\n");
  const changeNodes: ChangeNode[] = [];

  for (let i = 0; i < lines.length; i += 2) {
    const oddLine = lines[i];
    const evenLine = lines[i + 1] || "";

    let changeId = "";
    if (i % 2 === 0) {
      const match = oddLine.match(/\b([a-zA-Z0-9]+)\b/);
      if (match) {
        changeId = match[1];
      }
    }

    const match = evenLine.match(/([a-zA-Z0-9(].*)/);
    const description = match ? match[1] : "";

    const emailMatch = oddLine.match(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    );
    const timestampMatch = oddLine.match(
      /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/,
    );
    const symbolsMatch = oddLine.match(/^[^a-zA-Z0-9(]+/);
    const commitIdMatch = oddLine.match(/([a-zA-Z0-9]{8})$/);

    const branchTypeMatch = symbolsMatch
      ? symbolsMatch[0].match(/[@○◆]/)
      : null;
    const branchType = branchTypeMatch ? branchTypeMatch[0] : undefined;
    const formattedLine = `${description}${changeId === "zzzzzzzz" ? "root()" : ""} • ${changeId} • ${commitIdMatch ? commitIdMatch[0] : ""}`;

    changeNodes.push(
      new ChangeNode(
        formattedLine,
        `${emailMatch ? emailMatch[0] : ""} ${timestampMatch ? timestampMatch[0] : ""}`,
        changeId,
        changeId,
        undefined,
        branchType,
      ),
    );
  }
  return changeNodes;
}
