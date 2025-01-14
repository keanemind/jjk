import * as vscode from "vscode";
import type { JJRepository } from "./repository";

export class ChangeNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    tooltip: string,
    contextValue: string,
  ) {
    super(description);
    this.label = label;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = contextValue;

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
      this.treeDataProvider.refresh(true);
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
    this.refresh();
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
    this.logData = logOutput;

    if (
      showLoading === true ||
      this.areChangeNodesEqual(currData, logOutput) === false
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
