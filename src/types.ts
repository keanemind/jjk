import { Data } from "effect";

export type FileStatusType = "A" | "M" | "D" | "R" | "C";

export type FileStatus = {
  type: FileStatusType;
  file: string;
  path: string;
  renamedFrom?: string;
};

export interface Change {
  changeId: string;
  commitId: string;
  bookmarks?: string[];
  description: string;
  isEmpty: boolean;
  isConflict: boolean;
}

export interface ChangeWithDetails extends Change {
  author: {
    name: string;
    email: string;
  };
  authoredDate: string;
  parentChangeIds: string[];
  parentCommitIds: string[];
}

export type RepositoryStatus = {
  fileStatuses: FileStatus[];
  workingCopy: Change;
  parentChanges: Change[];
  conflictedFiles: Set<string>;
};

export type Show = {
  change: ChangeWithDetails;
  fileStatuses: FileStatus[];
  conflictedFiles: Set<string>;
};

export type Operation = {
  id: string;
  description: string;
  tags: string;
  start: string;
  user: string;
  snapshot: boolean;
};

export class JJCliError extends Data.TaggedError("JJCliError")<{
  message: string;
}> {}

export class JJImmutableError extends Data.TaggedError("JJImmutableError")<{
  message: string;
}> {}

export class RepositoryDataError extends Data.TaggedError(
  "RepositoryDataError",
)<{
  message: string;
}> {}

export interface RepositoryConfig {
  repositoryRoot: string;
  jjPath: string;
  jjVersion: string;
}
