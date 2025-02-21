import { Uri } from "vscode";

export interface JJUriParams {
  rev: string;
}

function isJJUriParams(params: unknown): params is JJUriParams {
  return (
    typeof params === "object" &&
    params !== null &&
    Object.hasOwnProperty.call(params, "rev") &&
    typeof (params as { rev: unknown }).rev === "string"
  );
}

export function withRev(uri: Uri, rev: string): Uri {
  return uri.with({
    query: JSON.stringify({ rev } satisfies JJUriParams),
  });
}

/**
 * Use this for any URI that will go to JJFileSystemProvider. This just sets the scheme to "jj".
 * Note that URIs that go to JJFileSystemProvider must have a rev in the query; see `withRev`.
 */
export function toJJUri(uri: Uri): Uri {
  return uri.with({
    scheme: "jj",
  });
}

export function getRev(uri: Uri) {
  if (uri.query === "") {
    throw new Error("URI has no query");
  }
  const parsed = JSON.parse(uri.query) as unknown;
  if (!isJJUriParams(parsed)) {
    throw new Error("URI query is not JJUriParams");
  }
  return parsed.rev;
}

export function getRevOpt(uri: Uri) {
  if (uri.query === "") {
    return;
  }
  const parsed = JSON.parse(uri.query) as unknown;
  if (!isJJUriParams(parsed)) {
    return;
  }
  return parsed.rev;
}
