import * as vscode from "vscode";
import * as fs from "fs";
import type { JJRepository } from "./repository";
import path from "path";

type Message = {
  command: string;
  changeId?: string;
  selectedNodes?: string[];
};

function buildChangeStats(fileStatuses: Array<{ type: string }>): {
  total: number;
  added: number;
  modified: number;
  removed: number;
  renamed: number;
  copied: number;
} {
  // Keep the hover payload aggregation in one place so the message contract stays aligned with the
  // webview formatter when new file-status kinds are added.
  return {
    total: fileStatuses.length,
    added: fileStatuses.filter((file) => file.type === "A").length,
    modified: fileStatuses.filter((file) => file.type === "M").length,
    removed: fileStatuses.filter((file) => file.type === "D").length,
    renamed: fileStatuses.filter((file) => file.type === "R").length,
    copied: fileStatuses.filter((file) => file.type === "C").length,
  };
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
  subscriptions: {
    dispose(): unknown;
  }[] = [];

  public panel?: vscode.WebviewView;
  public repository: JJRepository;
  public selectedNodes: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    repo: JJRepository,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.repository = repo;

    // Register the webview provider
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("jjGraphWebview", this, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }),
    );
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.panel = webviewView;
    this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getWebviewContent(webviewView.webview);

    await new Promise<void>((resolve) => {
      const messageListener = webviewView.webview.onDidReceiveMessage(
        (message: Message) => {
          if (message.command === "webviewReady") {
            messageListener.dispose();
            resolve();
          }
        },
      );
    });

    webviewView.webview.onDidReceiveMessage(async (message: Message) => {
      switch (message.command) {
        case "openChanges":
          try {
            await vscode.commands.executeCommand(
              "jj.openChangeDiff",
              this.repository.repositoryRoot,
              message.changeId,
            );
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to open changes: ${error as string}`,
            );
          }
          break;
        case "editChange":
          if (!message.changeId) {
            break;
          }
          try {
            await this.repository.editRetryImmutable(message.changeId);
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to switch to change: ${error as string}`,
            );
          }
          break;
        case "newChangeFrom":
          if (!message.changeId) {
            break;
          }
          try {
            await this.repository.new(undefined, [message.changeId]);
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to create change${error instanceof Error ? `: ${error.message}` : ""}`,
            );
          }
          break;
        case "selectChange":
          this.selectedNodes = new Set(message.selectedNodes ?? []);
          vscode.commands.executeCommand(
            "setContext",
            "jjGraphView.nodesSelected",
            message.selectedNodes?.length ?? 0,
          );
          break;
        case "requestChangeDetails":
          if (!message.changeId) {
            break;
          }
          try {
            // Keep the list rows cheap to render by fetching the full description only when the
            // user asks for hover details on a specific change.
            const showResult = await this.repository.show(message.changeId);
            this.panel?.webview.postMessage({
              command: "changeDetails",
              changeId: message.changeId,
              details: {
                fullDescription:
                  showResult.change.description || "(no description set)",
                stats: buildChangeStats(showResult.fileStatuses),
              },
            });
          } catch {
            this.panel?.webview.postMessage({
              command: "changeDetails",
              changeId: message.changeId,
              details: undefined,
            });
          }
          break;
      }
    });

    await this.refresh();
  }

  public async setSelectedRepository(repo: JJRepository) {
    const prevRepo = this.repository;
    this.repository = repo;
    if (this.panel) {
      this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;
    }
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh();
    }
  }

  public async refresh() {
    if (!this.panel) {
      return;
    }

    let changes = parseJJLog(await this.repository.log());
    changes = await this.getChangeNodesWithParents(changes);

    const status = await this.repository.getStatus(true);
    const workingCopyId = status.workingCopy.changeId;

    this.selectedNodes.clear();
    this.panel.webview.postMessage({
      command: "updateGraph",
      changes: changes,
      workingCopyId,
      preserveScroll: true,
    });
  }

  private getWebviewContent(webview: vscode.Webview) {
    // In development, files are in src/webview
    // In production (bundled extension), files are in dist/webview
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

    // Replace placeholders in the HTML
    html = html.replace("${cssUri}", cssUri.toString());
    html = html.replace("${codiconUri}", codiconUri.toString());

    return html;
  }

  private async getChangeNodesWithParents(
    changeNodes: ChangeNode[],
  ): Promise<ChangeNode[]> {
    // The visible log template does not include explicit parent IDs, so fetch a second compact map
    // keyed by the same short change IDs that the graph rows render.
    const output = await this.repository.log(
      "::", // get all changes
      `
        if(root,
          "root()",
          concat(
            self.change_id().short(),
            " ",
            parents.map(|p| p.change_id().short()).join(" "),
            "\n"
          )
        )
        `,
      50,
      false,
    );

    const lines = output.split("\n");

    // Build a map of change IDs to their parent IDs
    const parentMap = new Map<string, string[]>();

    for (const line of lines) {
      // Extract only alphanumeric strings from the line
      const ids = line.match(/[a-zA-Z0-9]+/g) || [];
      if (ids.length < 1) {
        continue;
      }

      // Check for root() after cleaning up symbols
      if (ids[0] === "root") {
        continue;
      }

      const [changeId, ...parentIds] = ids;
      if (!changeId) {
        continue;
      }

      // Take only the first 8 characters of each ID
      parentMap.set(
        changeId.substring(0, 8),
        parentIds.map((id) => id.substring(0, 8)),
      );
    }

    // Assign parents to nodes using the map
    const res = changeNodes.map((node) => {
      if (node.contextValue) {
        node.parentChangeIds = parentMap.get(node.contextValue) || [];
      }
      return node;
    });

    return res;
  }

  areChangeNodesEqual(a: ChangeNode[], b: ChangeNode[]): boolean {
    if (a.length !== b.length) {
      return false;
    }

    return a.every((nodeA, index) => {
      const nodeB = b[index];
      return (
        nodeA.tooltip === nodeB.tooltip &&
        nodeA.description === nodeB.description &&
        nodeA.fullDescription === nodeB.fullDescription &&
        nodeA.contextValue === nodeB.contextValue &&
        nodeA.changeId === nodeB.changeId &&
        nodeA.commitId === nodeB.commitId &&
        nodeA.author === nodeB.author &&
        nodeA.authorDisplay === nodeB.authorDisplay &&
        nodeA.timestamp === nodeB.timestamp &&
        nodeA.refName === nodeB.refName &&
        nodeA.isEmpty === nodeB.isEmpty &&
        nodeA.isConflict === nodeB.isConflict &&
        nodeA.hasDescription === nodeB.hasDescription &&
        nodeA.isElided === nodeB.isElided &&
        nodeA.symbolColumn === nodeB.symbolColumn
      );
    });
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
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
