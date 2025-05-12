import * as vscode from "vscode";
import * as fs from "fs";
import type { JJRepository } from "./repository";
import path from "path";

type Message = {
  command: "selectChange";
  selectedNodes: string[];
} | {
  command: "updateRevset";
  revset: string;
} | {
  command: "editChange";
  changeId: string;
} | {
  command: "webviewReady";
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
  public webview?: vscode.Webview;
  public revset: string;
  public mode: "expanded" | "compact";
  public repository: JJRepository;
  public logData: ChangeNode[] = [];
  public selectedNodes: Set<string> = new Set();

  constructor(
    private readonly extensionUri: vscode.Uri,
    repo: JJRepository,
    private readonly context: vscode.ExtensionContext,
    initialRevset: string = "::",
    mode: "expanded" | "compact" = 'compact',
    register: boolean = true,
  ) {
    this.repository = repo;
    this.mode = mode;
    this.revset = initialRevset;

    if (register) {
      // Register the webview provider
      context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("jjGraphWebview", this, {
          webviewOptions: {
            retainContextWhenHidden: true,
          },
        }),
      );
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    this.panel = webviewView;
    this.panel.title = `Source Control Graph (${path.basename(this.repository.repositoryRoot)})`;
    await this.resolveWebview(webviewView.webview);
  }

  public async resolveWebview(
    webview: vscode.Webview,
  ): Promise<void> {
    this.webview = webview;    

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webview.html = this.getWebviewContent(webview);

    await new Promise<void>((resolve) => {
      const messageListener = webview.onDidReceiveMessage(
        (message: Message) => {
          if (message.command === "webviewReady") {
            messageListener.dispose();
            resolve();
          }
        },
      );
    });

    webview.onDidReceiveMessage(async (message: Message) => {
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
        case "updateRevset":
          this.revset = message.revset;
          await this.refresh(true, true);
          break;
        case "selectChange":
          this.selectedNodes = new Set(message.selectedNodes);
          vscode.commands.executeCommand(
            "setContext",
            "jjGraphView.nodesSelected",
            message.selectedNodes.length,
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
    if (!this.webview) {
      return;
    }
    const currChanges = this.logData;

    let changes = parseJJLog(await this.repository.log(this.revset));
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
      this.webview.postMessage({
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
    html = html.replace("${mode}", this.mode);
    html = html.replace("${initialRevset}", this.revset);

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

type JJLogNode = {
  id: string;
  commit_id: string;
  description: string;
  is_working_copy: boolean;
  is_empty: boolean;
  email: string;
  timestamp: string;
  parents: string[];
};

export function parseJJLog(output: string): ChangeNode[] {
  const nodes = output.trim().split("\n").map((x) => {
    const start = x.indexOf("{");
    const end = x.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return;
    }
    return JSON.parse(x.slice(start, end + 1)) as JJLogNode;
  }).filter((x): x is JJLogNode => x !== undefined);

  return nodes.map((node) => {
    let formattedLine = "";
    const changeId = node.id.slice(0, 8);
    const commitId = node.commit_id.slice(0, 8);

    if (node.is_empty) {
      formattedLine = "(empty) ";
    }
    
    if (node.description === "") {
      formattedLine += "(no description set) ";
    } else {
      formattedLine += node.description;
    }

    formattedLine += ` • ${changeId}`;
    formattedLine += ` • ${commitId}`;

    let branchType = "◆";
    if (node.is_working_copy) {
      branchType = "@";
    }

    return new ChangeNode(
      formattedLine,
      `${node.email} ${node.timestamp}`,
      changeId,
      changeId,
      node.parents,
      branchType,
    );
  });
}
