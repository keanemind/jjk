import * as vscode from "vscode";
import * as fs from "fs";
import path from "path";
import type { RepoHandle } from "./repoHandle";

type Message = {
  command: string;
  changeId?: string;
  selectedNodes?: string[];
};

export interface GraphChangeDetails {
  readonly fullDescription: string;
  readonly stats: {
    readonly total: number;
    readonly added: number;
    readonly modified: number;
    readonly removed: number;
    readonly renamed: number;
    readonly copied: number;
  };
}

export interface GraphRenderData {
  readonly changes: ChangeNode[];
  readonly workingCopyId: string;
}

export interface JJGraphWebviewDeps {
  readonly loadGraph: (repo: RepoHandle) => Promise<GraphRenderData>;
  readonly editChange: (repo: RepoHandle, changeId: string) => Promise<void>;
  readonly newChangeFrom: (repo: RepoHandle, changeId: string) => Promise<void>;
  readonly requestChangeDetails: (
    repo: RepoHandle,
    changeId: string,
  ) => Promise<GraphChangeDetails | undefined>;
  readonly setNodesSelectedContext: (count: number) => Promise<void>;
}

export class ChangeNode {
  // The parser keeps row metadata decomposed so the webview can lay out jj-style columns without
  // having to reverse-engineer a preformatted label string.
  description: string;
  fullDescription: string;
  tooltip: string;
  contextValue: string;
  parentChangeIds?: string[];
  branchType?: string;
  changeId: string;
  commitId: string;
  author: string;
  authorDisplay: string;
  timestamp: string;
  refName: string;
  isEmpty: boolean;
  isConflict: boolean;
  hasDescription: boolean;
  isElided: boolean;
  symbolColumn: number;
  constructor(
    description: string,
    fullDescription: string,
    tooltip: string,
    contextValue: string,
    changeId: string,
    commitId: string,
    author: string,
    authorDisplay: string,
    timestamp: string,
    refName: string,
    isEmpty: boolean,
    isConflict: boolean,
    hasDescription: boolean,
    isElided: boolean,
    symbolColumn: number,
    parentChangeIds?: string[],
    branchType?: string,
  ) {
    this.description = description;
    this.fullDescription = fullDescription;
    this.tooltip = tooltip;
    this.contextValue = contextValue;
    this.changeId = changeId;
    this.commitId = commitId;
    this.author = author;
    this.authorDisplay = authorDisplay;
    this.timestamp = timestamp;
    this.refName = refName;
    this.isEmpty = isEmpty;
    this.isConflict = isConflict;
    this.hasDescription = hasDescription;
    this.isElided = isElided;
    this.symbolColumn = symbolColumn;
    this.parentChangeIds = parentChangeIds;
    this.branchType = branchType;
  }
}

export class JJGraphWebview implements vscode.WebviewViewProvider {
  private panel?: vscode.WebviewView;
  private repo: RepoHandle;
  private selectedNodes: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    repo: RepoHandle,
    private readonly deps: JJGraphWebviewDeps,
  ) {
    this.repo = repo;
  }

  getSelectedRepo(): RepoHandle {
    return this.repo;
  }

  getSelectedNodes(): readonly string[] {
    return [...this.selectedNodes];
  }

  private awaitWebviewReady(webview: vscode.Webview): Promise<void> {
    return new Promise((resolve) => {
      const messageListener = webview.onDidReceiveMessage(
        (message: Message) => {
          if (message.command === "webviewReady") {
            messageListener.dispose();
            resolve();
          }
        },
      );
    });
  }

  private async postMessage(message: unknown): Promise<void> {
    if (!this.panel) {
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: Message): Promise<void> {
    switch (message.command) {
      case "editChange": {
        if (!message.changeId) {
          return;
        }
        await this.deps.editChange(this.repo, message.changeId);
        return;
      }
      case "newChangeFrom": {
        if (!message.changeId) {
          return;
        }
        await this.deps.newChangeFrom(this.repo, message.changeId);
        return;
      }
      case "selectChange": {
        this.selectedNodes = new Set(message.selectedNodes ?? []);
        await this.deps.setNodesSelectedContext(
          message.selectedNodes?.length ?? 0,
        );
        return;
      }
      case "requestChangeDetails":
        if (!message.changeId) {
          return;
        }
        await this.postMessage({
          command: "changeDetails",
          changeId: message.changeId,
          details: await this.deps.requestChangeDetails(
            this.repo,
            message.changeId,
          ),
        });
        return;
      default:
        return;
    }
  }

  private async refreshView(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const renderData = await this.deps.loadGraph(this.repo);
    this.selectedNodes.clear();
    await this.postMessage({
      command: "updateGraph",
      changes: renderData.changes,
      workingCopyId: renderData.workingCopyId,
      preserveScroll: true,
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.panel = webviewView;
    this.panel.title = `Source Control Graph (${path.basename(this.repo.config.repositoryRoot)})`;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    return this.awaitWebviewReady(webviewView.webview).then(() => {
      webviewView.webview.onDidReceiveMessage((message: Message) => {
        void this.handleMessage(message).catch(() => {
          // Errors are surfaced by the injected handlers when possible; dropped
          // webview messages should not break the view lifecycle.
        });
      });

      return this.refreshView();
    });
  }

  public setSelectedRepository(repo: RepoHandle): Promise<void> {
    const prevRepo = this.repo;
    this.repo = repo;
    if (this.panel) {
      this.panel.title = `Source Control Graph (${path.basename(this.repo.config.repositoryRoot)})`;
    }
    if (prevRepo.config.repositoryRoot !== repo.config.repositoryRoot) {
      return this.refreshView();
    }
    return Promise.resolve();
  }

  public refresh(): Promise<void> {
    return this.refreshView();
  }

  private getWebviewContent(webview: vscode.Webview) {
    const webviewPath = this.extensionUri.fsPath.includes("extensions")
      ? "dist"
      : "src";

    const cssPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      "webview",
      "graph.css",
    );
    const cssUri = webview.asWebviewUri(cssPath);

    const codiconPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath === "dist"
        ? "dist/codicons"
        : "node_modules/@vscode/codicons/dist",
      "codicon.css",
    );
    const codiconUri = webview.asWebviewUri(codiconPath);

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      webviewPath,
      "webview",
      "graph.html",
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    html = html.replace("${cssUri}", cssUri.toString());
    html = html.replace("${codiconUri}", codiconUri.toString());

    return html;
  }

  static addParentIds(
    changeNodes: ChangeNode[],
    parentOutput: string,
  ): ChangeNode[] {
    const lines = parentOutput.split("\n");
    const parentMap = new Map<string, string[]>();

    for (const line of lines) {
      const ids = line.match(/[a-zA-Z0-9]+/g) || [];
      if (ids.length < 1 || ids[0] === "root") {
        continue;
      }

      const [changeId, ...parentIds] = ids;
      if (!changeId) {
        continue;
      }

      parentMap.set(
        changeId.substring(0, 8),
        parentIds.map((id) => id.substring(0, 8)),
      );
    }

    return changeNodes.map((node) => {
      if (node.contextValue) {
        node.parentChangeIds = parentMap.get(node.contextValue) || [];
      }
      return node;
    });
  }

  dispose() {
    this.selectedNodes.clear();
  }
}

export function parseJJLog(output: string): ChangeNode[] {
  // The graph uses a text `jj log` template instead of a structured API. Parse it once here so the
  // renderer can work with explicit row fields and lane coordinates.
  const lines = output.split("\n");
  const changeNodes: ChangeNode[] = [];
  const timestampPattern = /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/;
  const commitIdPattern = /(?:^|\s)([a-f0-9]{8,})$/i;
  const rootPattern =
    /^([^a-zA-Z0-9(]*)([@○◆])\s+([a-z0-9]{8,})\s+(root\(\))\s+([a-f0-9]{8,})$/i;

  const stripGraphPrefix = (line: string) =>
    line.replace(/^[^a-zA-Z0-9(~]+/, "").trim();

  const isGraphContinuationLine = (line: string) =>
    /^[^a-zA-Z0-9~]*[│├╯╰╮╭─ ]/.test(line) || /^[^a-zA-Z0-9~]*$/.test(line);

  const isEntryStartLine = (line: string) => {
    const trimmedLine = line.trimEnd();
    if (!trimmedLine) {
      return false;
    }

    const strippedLine = stripGraphPrefix(trimmedLine);
    return (
      rootPattern.test(trimmedLine) ||
      strippedLine === "~" ||
      strippedLine === "~  (elided revisions)" ||
      timestampPattern.test(trimmedLine)
    );
  };

  const getSymbolColumn = (line: string, branchType?: string) =>
    branchType ? Math.max(0, line.indexOf(branchType)) : 0;

  const getAuthorDisplay = (author: string) => {
    if (!author.includes("@")) {
      return author;
    }
    const localPart = author.slice(0, author.indexOf("@"));
    return localPart || author;
  };

  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i]?.trimEnd();
    if (!headerLine) {
      continue;
    }

    const elidedLine = stripGraphPrefix(headerLine);
    if (elidedLine === "~" || elidedLine === "~  (elided revisions)") {
      changeNodes.push(
        new ChangeNode(
          "Older revisions hidden",
          "Older revisions hidden",
          "Older revisions are hidden by the current jj log limit.",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          false,
          false,
          false,
          true,
          getSymbolColumn(headerLine, "~"),
          undefined,
          "~",
        ),
      );
      continue;
    }

    // The compact row layout only reserves one visible summary line, but the hover needs the full
    // body block. Keep both representations so the webview does not have to widen the list rows.
    const descriptionLines: string[] = [];
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1] ?? "";
      if (isEntryStartLine(nextLine) || !isGraphContinuationLine(nextLine)) {
        break;
      }

      descriptionLines.push(stripGraphPrefix(nextLine.trimEnd()));
      i++;
    }

    const summarySource =
      descriptionLines.find((line) => line.trim().length > 0) ?? "";
    const isEmpty = summarySource.includes("(empty)");
    const isConflict = summarySource.includes("(conflict)");
    const cleanedDescription = summarySource
      .replace(/\(empty\)\s*/g, "")
      .replace(/\(conflict\)\s*/g, "")
      .trim();
    const cleanedDescriptionLines = descriptionLines.map((line) =>
      line.replace(/\(empty\)\s*/g, "").replace(/\(conflict\)\s*/g, ""),
    );
    const fullDescription = cleanedDescriptionLines.join("\n").trim();
    const hasDescription =
      fullDescription.length > 0 && fullDescription !== "(no description set)";
    const description = hasDescription
      ? cleanedDescription
      : "(no description set)";
    const fullDescriptionText = hasDescription
      ? fullDescription
      : "(no description set)";

    const rootMatch = headerLine.match(rootPattern);
    if (rootMatch) {
      const [, , branchType, changeId, refName, commitId] = rootMatch;
      const symbolColumn = getSymbolColumn(headerLine, branchType);
      const normalizedDescription = hasDescription ? description : "";

      changeNodes.push(
        new ChangeNode(
          normalizedDescription,
          normalizedDescription,
          `Change: ${changeId}\nCommit: ${commitId}\nRef: ${refName}${
            isEmpty ? "\nStatus: empty" : ""
          }`,
          changeId,
          changeId,
          commitId,
          "",
          "",
          "",
          refName,
          isEmpty,
          false,
          normalizedDescription.length > 0,
          false,
          symbolColumn,
          undefined,
          branchType,
        ),
      );
      continue;
    }

    if (!timestampPattern.test(headerLine)) {
      continue;
    }

    const timestampMatch = headerLine.match(timestampPattern);
    if (!timestampMatch || timestampMatch.index === undefined) {
      continue;
    }

    const beforeTimestamp = headerLine.slice(0, timestampMatch.index).trimEnd();
    const afterTimestamp = headerLine
      .slice(timestampMatch.index + timestampMatch[0].length)
      .trim();

    const changeIdMatch = beforeTimestamp.match(/([a-z0-9]{8,})\s+(\S+)$/i);
    const isConflictHeader = afterTimestamp.endsWith("(conflict)");
    const afterTimestampClean = isConflictHeader
      ? afterTimestamp.slice(0, -"(conflict)".length).trimEnd()
      : afterTimestamp;
    const commitIdMatch = afterTimestampClean.match(commitIdPattern);
    const symbolsMatch = headerLine.match(/^[^a-zA-Z0-9(]+/);
    const branchTypeMatch = symbolsMatch
      ? symbolsMatch[0].match(/[@○◆×]/)
      : null;

    if (!changeIdMatch || !commitIdMatch || commitIdMatch.index === undefined) {
      continue;
    }

    const changeId = changeIdMatch[1];
    const author = changeIdMatch[2];
    const timestamp = timestampMatch[0];
    const branchType = branchTypeMatch ? branchTypeMatch[0] : undefined;
    const commitId = commitIdMatch[1];
    const symbolColumn = getSymbolColumn(headerLine, branchType);
    const refName = afterTimestampClean
      .slice(0, commitIdMatch.index)
      .trim()
      .replace(/\s+/g, " ");
    const tooltipLines = [
      `${author} • ${timestamp}`,
      `Change: ${changeId}`,
      `Commit: ${commitId}`,
      refName ? `Ref: ${refName}` : "",
      isEmpty ? "Status: empty" : "",
      isConflict ? "Status: conflict" : "",
      hasDescription
        ? `Description: ${fullDescriptionText}`
        : "Description: (no description set)",
    ].filter(Boolean);

    changeNodes.push(
      new ChangeNode(
        description,
        fullDescriptionText,
        tooltipLines.join("\n"),
        changeId,
        changeId,
        commitId,
        author,
        getAuthorDisplay(author),
        timestamp,
        refName,
        isEmpty,
        isConflict || isConflictHeader,
        hasDescription,
        false,
        symbolColumn,
        undefined,
        branchType,
      ),
    );
  }

  return changeNodes;
}
