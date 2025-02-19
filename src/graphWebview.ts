import * as vscode from "vscode";
import * as fs from "fs";
import type { JJRepository } from "./repository";
import path from "path";

type Message = {
  command: string;
  changeId: string;
  selectedNodes: string[];
};

export type RefreshArgs = {
  preserveScroll: boolean;
};

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

export class JJGraphWebview implements vscode.WebviewViewProvider {
  subscriptions: {
    dispose(): unknown;
  }[] = [];

  public panel?: vscode.WebviewView;
  public repository: JJRepository;
  public logData: ChangeNode[] = [];
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
        case "editChange":
          try {
            await this.repository.edit(message.changeId);

            await vscode.commands.executeCommand("jj.refresh", {
              preserveScroll: true,
            });
          } catch (error: unknown) {
            vscode.window.showErrorMessage(
              `Failed to switch to change: ${error as string}`,
            );
          }
          break;
        case "selectChange":
          this.selectedNodes = new Set(message.selectedNodes);
          vscode.commands.executeCommand(
            "setContext",
            "jjGraphView.multipleNodesSelected",
            message.selectedNodes.length > 1,
          );
          break;
      }
    });

    await this.refresh();
  }

  public setSelectedRepository(repo: JJRepository) {
    this.repository = repo;
    if (this.panel) {
      this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;
    }
  }

  public async refresh(
    preserveScroll: boolean = false,
    force: boolean = false,
  ) {
    if (!this.panel) {
      return;
    }
    const currChanges = this.logData;

    let changes = parseJJLog(await this.repository.log());
    changes = await this.getChangeNodesWithParents(changes);
    this.logData = changes;

    // Get the old status from cache before fetching new status
    const oldStatus = this.repository.statusCache;
    const status = await this.repository.getStatus();
    const workingCopyId = status.workingCopy.changeId;

    if (
      force ||
      !oldStatus || // Handle first run when cache is empty
      status.workingCopy.changeId !== oldStatus.workingCopy.changeId ||
      !this.areChangeNodesEqual(currChanges, changes)
    ) {
      this.selectedNodes.clear();
      this.panel.webview.postMessage({
        command: "updateGraph",
        changes: changes,
        workingCopyId,
        preserveScroll,
      });
    }
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
        nodeA.label === nodeB.label &&
        nodeA.tooltip === nodeB.tooltip &&
        nodeA.description === nodeB.description &&
        nodeA.contextValue === nodeB.contextValue
      );
    });
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

export function parseJJLog(output: string): ChangeNode[] {
  const lines = output.split("\n");
  const changeNodes: ChangeNode[] = [];

  for (let i = 0; i < lines.length; i += 2) {
    const oddLine = lines[i];
    let evenLine = lines[i + 1] || "";

    let changeId = "";
    if (i % 2 === 0) {
      // Check if the line is odd-numbered (0-based index, so 0, 2, 4... are odd lines)
      const match = oddLine.match(/\b([a-zA-Z0-9]+)\b/); // Match the first group of alphanumeric characters
      if (match) {
        changeId = match[1];
      }
    }

    // Match the first alphanumeric character or opening parenthesis and everything after it
    const match = evenLine.match(/([a-zA-Z0-9(].*)/);
    const description = match ? match[1] : "";

    // Remove the description from the even line
    if (description) {
      evenLine = evenLine.replace(description, "");
    }

    const emailMatch = oddLine.match(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    );
    const timestampMatch = oddLine.match(
      /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/,
    );
    const symbolsMatch = oddLine.match(/^[^a-zA-Z0-9(]+/);
    const commitIdMatch = oddLine.match(/([a-zA-Z0-9]{8})$/);

    // Add this: Find first occurrence of @, ○, or ◆
    const branchTypeMatch = symbolsMatch
      ? symbolsMatch[0].match(/[@○◆]/)
      : null;
    const branchType = branchTypeMatch ? branchTypeMatch[0] : undefined;
    const formattedLine = `${description}${changeId === "zzzzzzzz" ? "root()" : ""} • ${changeId} • ${commitIdMatch ? commitIdMatch[0] : ""}`;

    // Create a ChangeNode for the odd line with the appended description
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
