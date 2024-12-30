import { Uri } from "vscode";

export interface JJUriParams {
  rev: string;
}

/**
 * @param uri
 * @param rev revision
 * @returns
 */
export function toJJUri(uri: Uri, rev: string): Uri {
  return uri.with({
    scheme: "jj",
    query: JSON.stringify({ rev } satisfies JJUriParams),
  });
}

export function getJJUriParams(uri: Uri): JJUriParams {
  return JSON.parse(uri.query);
}
