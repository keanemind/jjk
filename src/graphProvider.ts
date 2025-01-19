import * as vscode from "vscode";
import type { JJRepository } from "./repository";

export class ChangeNode extends vscode.TreeItem {
  parentChangeIds?: string[];
  constructor(
    label: string,
    description: string,
    tooltip: string,
    contextValue: string,
    parentChangeIds?: string[],
  ) {
    super(description);
    this.label = label;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = contextValue;
    this.parentChangeIds = parentChangeIds;

    /* TODO Checkbox selection for multi-select actions (abandon, merge?)
    this.checkboxState = isSelected ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    */
  }
}

export class JJGraphProvider {
  treeDataProvider: JJGraphTreeDataProvider;
  treeView: vscode.TreeView<ChangeNode>;

  constructor(repo: JJRepository) {
    this.treeDataProvider = new JJGraphTreeDataProvider(repo);
    this.treeView = vscode.window.createTreeView("jjGraphView", {
      treeDataProvider: this.treeDataProvider,
      canSelectMany: true,
    });

    const defaultTreeViewMessage =
      "Hold Ctrl/Cmd ⌘ and click to select multiple nodes for additional actions.";
    this.treeView.message = defaultTreeViewMessage;

    this.treeView.onDidChangeSelection((event) => {
      const selectedNodes = event.selection;

      if (selectedNodes.length > 1) {
        const unselectableNode = selectedNodes.find(
          (node) => node.contextValue === "",
        );
        if (unselectableNode) {
          vscode.commands.executeCommand(
            "setContext",
            "jjGraphView.multipleNodesSelected",
            0,
          );
          this.treeView.message = "One or more invalid nodes are selected.";
          return;
        }
      }
      this.treeView.message = defaultTreeViewMessage;

      const multipleNodesSelected = event.selection.length > 1;
      vscode.commands.executeCommand(
        "setContext",
        "jjGraphView.multipleNodesSelected",
        multipleNodesSelected,
      );
    });

    /* TODO Checkbox selection for multi-select actions (abandon, merge?)
    this.treeView.onDidChangeCheckboxState((event) => {
      event.items.forEach(([node, checkboxState]) => {
        node.checkboxState = checkboxState;
      });
    });
    */

    vscode.commands.registerCommand("jj.refreshLog", () => {
      void this.treeDataProvider.refresh(true);
    });
  }

  updateTreeViewMessage(message: string) {
    this.treeView.message = message;
  }
}

class JJGraphTreeDataProvider implements vscode.TreeDataProvider<ChangeNode> {
  _onDidChangeTreeData: vscode.EventEmitter<
    ChangeNode | undefined | null | void
  > = new vscode.EventEmitter();
  onDidChangeTreeData: vscode.Event<ChangeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  logData: ChangeNode[] = [];
  repository: JJRepository;

  constructor(repo: JJRepository) {
    this.repository = repo;
    void this.refresh();
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ChangeNode[] {
    return this.logData;
  }

  setCurrentRepo(repo: JJRepository): void {
    this.repository = repo;
  }

  async refresh(showLoading: boolean = false): Promise<void> {
    const currData = this.logData;
    const logOutput = await this.repository.log();
    this.logData = parseJJLog(logOutput);

    if (
      showLoading === true ||
      this.areChangeNodesEqual(currData, this.logData) === false
    ) {
      this._onDidChangeTreeData.fire();
    }
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

    const symbolFormatted = symbolsMatch
      ? symbolsMatch[0].replace(/\s/g, "   ").trimEnd()
      : "";

    let formattedLine;
    if (symbolFormatted !== "") {
      formattedLine = `${symbolFormatted}   ${description}${changeId === "zzzzzzzz" ? "root()" : ""} • ${changeId} • ${commitIdMatch ? commitIdMatch[0] : ""}`;
    } else {
      formattedLine = "";
    }

    // Create a ChangeNode for the odd line with the appended description
    changeNodes.push(
      new ChangeNode(
        formattedLine,
        `${emailMatch ? emailMatch[0] : ""} ${timestampMatch ? timestampMatch[0] : ""}`,
        changeId,
        changeId,
      ),
    );

    // Create a ChangeNode for the remaining even line
    if (evenLine) {
      const formattedEvenLine = evenLine.replace(/(?<![a-zA-Z0-9)])\s/g, "   ");
      changeNodes.push(new ChangeNode(formattedEvenLine, "", "", ""));
    }
  }

  return changeNodes;
}
