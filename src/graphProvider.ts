import * as vscode from "vscode";
import type { WorkspaceSourceControlManager } from "./repository";

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

  constructor(repositories: WorkspaceSourceControlManager) {
    this.treeDataProvider = new JJGraphTreeDataProvider(repositories);

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
      this.treeDataProvider.refresh();
    });
  }

  get selectedItems(): readonly ChangeNode[] {
    return this.treeView.selection;
  }
}

class JJGraphTreeDataProvider implements vscode.TreeDataProvider<ChangeNode> {
  _onDidChangeTreeData: vscode.EventEmitter<
    ChangeNode | undefined | null | void
  > = new vscode.EventEmitter();
  onDidChangeTreeData: vscode.Event<ChangeNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  logData: ChangeNode[] = [];

  repositories: WorkspaceSourceControlManager;

  constructor(repositories: WorkspaceSourceControlManager) {
    this.repositories = repositories;
    this.refresh();
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ChangeNode[] {
    return this.logData;
  }

  async refresh(): Promise<void> {
    const logOutput = await this.repositories.repoSCMs[0].repository.log();
    this.logData = logOutput;
    this._onDidChangeTreeData.fire();
  }
}
