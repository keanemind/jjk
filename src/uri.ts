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

/**
 * Use this for any URI that will go to JJFileSystemProvider.
 */
export function toJJUri(uri: Uri, params: JJUriParams): Uri {
  return uri.with({
    scheme: "jj",
    query: JSON.stringify(params),
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
