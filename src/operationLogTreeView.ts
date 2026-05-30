import {
  EventEmitter,
  TreeDataProvider,
  TreeItem,
  Event,
  TreeView,
  window,
  MarkdownString,
} from "vscode";
import path from "path";
import type { RepoHandle } from "./repoHandle";
import type { Operation } from "./types";

interface OperationLogManagerDeps {
  readonly initialRepo: RepoHandle;
  readonly loadOperations: (repo: RepoHandle) => Promise<readonly Operation[]>;
}

export class OperationLogManager {
  private readonly subscriptions: {
    dispose(): unknown;
  }[] = [];
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<
    OperationTreeItem | undefined | null | void
  >();
  private readonly operationLogTreeDataProvider: OperationLogTreeDataProvider;
  private readonly operationLogTreeView: TreeView<OperationTreeItem>;
  private selectedRepo: RepoHandle;
  private operationTreeItems: OperationTreeItem[] = [];

  constructor(private readonly deps: OperationLogManagerDeps) {
    this.selectedRepo = deps.initialRepo;
    this.operationLogTreeDataProvider = new OperationLogTreeDataProvider(
      () => this.operationTreeItems,
      this.onDidChangeTreeDataEmitter.event,
    );
    this.operationLogTreeView = window.createTreeView<OperationTreeItem>(
      "jjOperationLog",
      {
        treeDataProvider: this.operationLogTreeDataProvider,
      },
    );
    this.operationLogTreeView.title = `Operation Log (${path.basename(
      this.selectedRepo.config.repositoryRoot,
    )})`;
    this.subscriptions.push(this.operationLogTreeView);
  }

  async setSelectedRepo(repo: RepoHandle) {
    const prevRepo = this.selectedRepo;
    this.selectedRepo = repo;
    this.operationLogTreeView.title = `Operation Log (${path.basename(
      repo.config.repositoryRoot,
    )})`;
    if (prevRepo.config.repositoryRoot !== repo.config.repositoryRoot) {
      await this.refresh();
    }
  }

  async refresh() {
    const prev = this.operationTreeItems;
    const operations = await this.deps.loadOperations(this.selectedRepo);
    this.operationTreeItems = operations.map(
      (op) =>
        new OperationTreeItem(op, this.selectedRepo.config.repositoryRoot),
    );
    if (
      prev.length !== this.operationTreeItems.length ||
      !prev.every((op, i) => op.id === this.operationTreeItems[i].operation.id)
    ) {
      this.onDidChangeTreeDataEmitter.fire();
    }
  }

  getSelectedRepo() {
    return this.selectedRepo;
  }

  dispose() {
    this.onDidChangeTreeDataEmitter.dispose();
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
  constructor(
    private readonly getOperationTreeItems: () => readonly OperationTreeItem[],
    readonly onDidChangeTreeData: Event<
      OperationTreeItem | undefined | null | void
    >,
  ) {}

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  getChildren(): OperationTreeItem[] {
    return [...this.getOperationTreeItems()];
  }
}
