import * as vscode from 'vscode';
import { Repositories } from './repository';

export class ChangeNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string,
    tooltip: string,
    contextValue: string
  ) {
    super(description);
    this.label = label;
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = contextValue;
  }
}

export class JJGraphProvider implements vscode.TreeDataProvider<ChangeNode> {
  _onDidChangeTreeData: vscode.EventEmitter<ChangeNode | undefined | null | void> = new vscode.EventEmitter();
  onDidChangeTreeData: vscode.Event<ChangeNode | undefined | null | void> = this._onDidChangeTreeData.event;

  logData: ChangeNode[] = [];

  repositories: Repositories;

  constructor(repositories: Repositories) {
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
    const logOutput = await this.repositories.repos[0].log();
    this.logData = logOutput;
    this._onDidChangeTreeData.fire();
  }
}