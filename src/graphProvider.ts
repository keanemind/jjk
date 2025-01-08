import * as vscode from 'vscode';
import { Repositories } from './repository';

export class CommitNode extends vscode.TreeItem {
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
    this.contextValue = this.contextValue;
  }
}

export class JJGraphProvider implements vscode.TreeDataProvider<CommitNode> {
  _onDidChangeTreeData: vscode.EventEmitter<CommitNode | undefined | null | void> = new vscode.EventEmitter();
  onDidChangeTreeData: vscode.Event<CommitNode | undefined | null | void> = this._onDidChangeTreeData.event;

  logData: CommitNode[] = [];

  repositories: Repositories;

  constructor(repositories: Repositories) {
    this.repositories = repositories;
    this.refresh();
  }

  getTreeItem(element: CommitNode): vscode.TreeItem {
    return element;
  }

  getChildren(): CommitNode[] {
    return this.logData;
  }

  async refresh(): Promise<void> {
    const logOutput = await this.repositories.repos[0].log();
    this.logData = logOutput;
    this._onDidChangeTreeData.fire();
  }
}