import * as vscode from "vscode";
import type { Bookmark } from "./repository";

const LOCAL_GIT_REMOTE = "git";

export type BookmarkMenuItem = vscode.QuickPickItem &
  (
    | {
        action: "createBookmark";
        bookmarkName?: string;
      }
    | {
        action: "editBookmark";
        bookmark: string;
      }
  );

export function validateBookmarkName(
  value: string,
  existingNames: Set<string>,
) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Bookmark name is required";
  }
  if (/\s/.test(trimmed)) {
    return "Bookmark names cannot contain whitespace";
  }
  if (existingNames.has(trimmed)) {
    return `Bookmark '${trimmed}' already exists`;
  }
  return undefined;
}

function bookmarkRefName(bookmark: Bookmark) {
  return bookmark.remote
    ? `${bookmark.name}@${bookmark.remote}`
    : bookmark.name;
}

function compareBookmarks(a: Bookmark, b: Bookmark) {
  const nameComparison = a.name.localeCompare(b.name);
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return (a.remote ?? "").localeCompare(b.remote ?? "");
}

function formatBookmarkDetail(bookmark: Bookmark) {
  if (bookmark.isConflict) {
    return "conflicted bookmark";
  }

  const idText = [bookmark.changeId, bookmark.commitId].filter(Boolean).join(" ");
  const description = bookmark.description || "(no description)";
  return idText ? `${idText} ${description}` : description;
}

function createBookmarkMenuItem(name?: string): BookmarkMenuItem {
  const bookmarkName = name?.trim() || undefined;
  return {
    label: bookmarkName
      ? `$(plus) Create Bookmark '${bookmarkName}'`
      : "$(plus) Create Bookmark...",
    detail: "Create a new bookmark at the current change",
    action: "createBookmark",
    bookmarkName,
    alwaysShow: true,
  };
}

export function buildBookmarkMenuItems({
  bookmarks,
  currentBookmarks,
  query,
}: {
  bookmarks: Bookmark[];
  currentBookmarks: Set<string>;
  query?: string;
}) {
  const trackedRemoteBookmarkKeys = new Set(
    bookmarks
      .filter(
        (bookmark) =>
          bookmark.isTracked &&
          bookmark.remote &&
          bookmark.remote !== LOCAL_GIT_REMOTE,
      )
      .map(bookmarkRefName),
  );
  const trackedRemotesByName = new Map<string, string[]>();
  for (const bookmark of bookmarks) {
    if (
      !bookmark.isTracked ||
      !bookmark.remote ||
      bookmark.remote === LOCAL_GIT_REMOTE
    ) {
      continue;
    }
    const remotes = trackedRemotesByName.get(bookmark.name) ?? [];
    remotes.push(bookmark.remote);
    trackedRemotesByName.set(bookmark.name, remotes);
  }

  const localBookmarkItems: BookmarkMenuItem[] = bookmarks
    .filter((bookmark) => !bookmark.remote && !bookmark.isConflict)
    .sort(compareBookmarks)
    .map((bookmark) => {
      const trackedRemotes = [
        ...(trackedRemotesByName.get(bookmark.name) ?? []),
      ]
        .sort((a, b) => a.localeCompare(b))
        .join(", ");
      const descriptions = [
        ...(currentBookmarks.has(bookmark.name) ? ["current"] : []),
        ...(trackedRemotes ? [`tracks ${trackedRemotes}`] : []),
      ];

      return {
        label: `$(bookmark) ${bookmark.name}`,
        description:
          descriptions.length > 0 ? descriptions.join(" - ") : undefined,
        detail: formatBookmarkDetail(bookmark),
        bookmark: bookmark.name,
        action: "editBookmark",
      };
    });

  const remoteBookmarkItems: BookmarkMenuItem[] = bookmarks
    .filter(
      (bookmark) =>
        bookmark.remote &&
        bookmark.remote !== LOCAL_GIT_REMOTE &&
        !bookmark.isConflict &&
        !trackedRemoteBookmarkKeys.has(bookmarkRefName(bookmark)),
    )
    .sort(compareBookmarks)
    .map((bookmark) => {
      const name = bookmarkRefName(bookmark);
      return {
        label: `$(bookmark) ${name}`,
        description: "remote",
        detail: formatBookmarkDetail(bookmark),
        bookmark: name,
        action: "editBookmark",
      };
    });

  const items: (BookmarkMenuItem | vscode.QuickPickItem)[] = [];
  const trimmedQuery = query?.trim();
  const existingLocalBookmarkNames = new Set(
    bookmarks
      .filter((bookmark) => !bookmark.remote)
      .map((bookmark) => bookmark.name.toLocaleLowerCase()),
  );

  if (
    !trimmedQuery ||
    !existingLocalBookmarkNames.has(trimmedQuery.toLocaleLowerCase())
  ) {
    items.push(createBookmarkMenuItem(trimmedQuery));
  }

  if (localBookmarkItems.length > 0) {
    items.push(
      {
        label: "Bookmarks",
        kind: vscode.QuickPickItemKind.Separator,
      },
      ...localBookmarkItems,
    );
  }

  if (remoteBookmarkItems.length > 0) {
    items.push(
      {
        label: "Remote Bookmarks",
        kind: vscode.QuickPickItemKind.Separator,
      },
      ...remoteBookmarkItems,
    );
  }

  return items;
}
