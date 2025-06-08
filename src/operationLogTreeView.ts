import {
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Event,
  TreeView,
  window,
  MarkdownString,
} from "vscode";
import { JJRepository, Operation } from "./repository";
import path from "path";

export class OperationLogManager {
  subscriptions: {
    dispose(): unknown;
  }[] = [];
  operationLogTreeView: TreeView<OperationTreeItem>;

  constructor(
    public operationLogTreeDataProvider: OperationLogTreeDataProvider,
  ) {
    this.operationLogTreeView = window.createTreeView<OperationTreeItem>(
      "jjOperationLog",
      {
        treeDataProvider: operationLogTreeDataProvider,
      },
    );
    this.operationLogTreeView.title = `Operation Log (${path.basename(
      operationLogTreeDataProvider.getSelectedRepo().repositoryRoot,
    )})`;
    this.subscriptions.push(this.operationLogTreeView);
  }

  async setSelectedRepo(repo: JJRepository) {
    await this.operationLogTreeDataProvider.setSelectedRepo(repo);
    this.operationLogTreeView.title = `Operation Log (${path.basename(
      repo.repositoryRoot,
    )})`;
  }

  async refresh() {
    await this.operationLogTreeDataProvider.refresh();
  }

  dispose() {
    this.subscriptions.forEach((s) => s.dispose());
  }
}

export class OperationTreeItem extends TreeItem {
  constructor(
    public readonly operation: Operation,
    public readonly repositoryRoot: string,
  ) {
    super(
      operation.tags.startsWith("args: ")
        ? operation.tags.slice(6)
        : operation.tags,
    );
    this.id = operation.id;
    this.description = operation.description;
    this.tooltip = new MarkdownString(
      `**${operation.start}**  \n${operation.tags}  \n${operation.description}`,
    );
  }
}

export class OperationLogTreeDataProvider implements TreeDataProvider<unknown> {
  _onDidChangeTreeData: EventEmitter<
    OperationTreeItem | undefined | null | void
  > = new EventEmitter();
  onDidChangeTreeData: Event<OperationTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  operationTreeItems: OperationTreeItem[] = [];

  constructor(private selectedRepository: JJRepository) {}

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  getChildren(): OperationTreeItem[] {
    return this.operationTreeItems;
  }

  async refresh() {
    const prev = this.operationTreeItems;
    const operations = await this.selectedRepository.operationLog();
    this.operationTreeItems = operations.map(
      (op) => new OperationTreeItem(op, this.selectedRepository.repositoryRoot),
    );
    if (
      prev.length !== this.operationTreeItems.length ||
      !prev.every((op, i) => op.id === this.operationTreeItems[i].operation.id)
    ) {
      this._onDidChangeTreeData.fire();
    }
  }

  async setSelectedRepo(repo: JJRepository) {
    const prevRepo = this.selectedRepository;
    this.selectedRepository = repo;
    if (prevRepo.repositoryRoot !== repo.repositoryRoot) {
      await this.refresh();
    }
  }

  getSelectedRepo() {
    return this.selectedRepository;
  }
}
