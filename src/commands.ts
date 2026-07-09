import * as vscode from "vscode";

type RegisterScoped = <A extends { dispose(): unknown }>(
  acquire: () => A,
) => Promise<A>;

export interface InitCommandHandlers {
  readonly newChange: (sourceControl: vscode.SourceControl) => unknown;
  readonly openFileResourceState: (
    resourceState: vscode.SourceControlResourceState,
  ) => unknown;
  readonly openFileEditor: (uri: vscode.Uri) => unknown;
  readonly openDiffEditor: (uri: vscode.Uri) => unknown;
  readonly restoreResourceState: (
    ...resourceStates: vscode.SourceControlResourceState[]
  ) => unknown;
  readonly squashToParentResourceState: (
    ...resourceStates: vscode.SourceControlResourceState[]
  ) => unknown;
  readonly squashToWorkingCopyResourceState: (
    ...resourceStates: vscode.SourceControlResourceState[]
  ) => unknown;
  readonly describeChange: (
    resourceGroup: vscode.SourceControlResourceGroup,
  ) => unknown;
  readonly squashToParentResourceGroup: (
    resourceGroup: vscode.SourceControlResourceGroup,
  ) => unknown;
  readonly squashToWorkingCopyResourceGroup: (
    resourceGroup: vscode.SourceControlResourceGroup,
  ) => unknown;
  readonly restoreResourceGroup: (
    resourceGroup: vscode.SourceControlResourceGroup,
  ) => unknown;
  readonly editResourceGroup: (
    resourceGroup: vscode.SourceControlResourceGroup,
  ) => unknown;
  readonly refreshGraphWebview: () => unknown;
  readonly newGraphWebview: () => unknown;
  readonly selectGraphWebviewRepo: () => unknown;
  readonly refreshOperationLog: () => unknown;
  readonly selectOperationLogRepo: () => unknown;
  readonly operationUndo: (item: unknown) => unknown;
  readonly operationRestore: (item: unknown) => unknown;
  readonly gitFetch: () => unknown;
  readonly squashSelectedRanges: () => unknown;
  readonly openParentChange: (uri: vscode.Uri) => unknown;
  readonly openChildChange: (uri: vscode.Uri) => unknown;
  readonly viewChange: (repositoryRoot: string, changeId: string) => unknown;
  readonly openChangeFileDiff: (
    changeId: string,
    fsPath: string,
    line?: number,
  ) => unknown;
}

export interface GlobalCommandHandlers {
  readonly refresh: () => unknown;
  readonly openFolderGitSettings: (repoPath: string) => unknown;
  readonly checkColocatedRepos: () => unknown;
  readonly openFileInWorkingCopyResourceState: (
    resourceState: vscode.SourceControlResourceState,
  ) => unknown;
  readonly openFileInWorkingCopyEditor: (uri: vscode.Uri) => unknown;
}

export interface ColocatedWarningCommandHandlers {
  readonly showColocatedWarnings: () => unknown;
}

export async function registerInitCommands(
  registerScoped: RegisterScoped,
  handlers: InitCommandHandlers,
): Promise<void> {
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.new", handlers.newChange),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openFileResourceState",
      handlers.openFileResourceState,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openFileEditor",
      handlers.openFileEditor,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openDiffEditor",
      handlers.openDiffEditor,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.restoreResourceState",
      handlers.restoreResourceState,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.squashToParentResourceState",
      handlers.squashToParentResourceState,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.squashToWorkingCopyResourceState",
      handlers.squashToWorkingCopyResourceState,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.describe", handlers.describeChange),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.squashToParentResourceGroup",
      handlers.squashToParentResourceGroup,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.squashToWorkingCopyResourceGroup",
      handlers.squashToWorkingCopyResourceGroup,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.restoreResourceGroup",
      handlers.restoreResourceGroup,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.editResourceGroup",
      handlers.editResourceGroup,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.refreshGraphWebview",
      handlers.refreshGraphWebview,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.newGraphWebview",
      handlers.newGraphWebview,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.selectGraphWebviewRepo",
      handlers.selectGraphWebviewRepo,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.refreshOperationLog",
      handlers.refreshOperationLog,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.selectOperationLogRepo",
      handlers.selectOperationLogRepo,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.operationUndo", handlers.operationUndo),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.operationRestore",
      handlers.operationRestore,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.gitFetch", handlers.gitFetch),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.squashSelectedRanges",
      handlers.squashSelectedRanges,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openParentChange",
      handlers.openParentChange,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openChildChange",
      handlers.openChildChange,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.viewChange", handlers.viewChange),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openChangeFileDiff",
      handlers.openChangeFileDiff,
    ),
  );
}

export async function registerGlobalCommands(
  registerScoped: RegisterScoped,
  handlers: GlobalCommandHandlers,
): Promise<void> {
  await registerScoped(() =>
    vscode.commands.registerCommand("jj.refresh", handlers.refresh),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openFolderGitSettings",
      handlers.openFolderGitSettings,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.checkColocatedRepos",
      handlers.checkColocatedRepos,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openFileInWorkingCopyResourceState",
      handlers.openFileInWorkingCopyResourceState,
    ),
  );
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.openFileInWorkingCopyEditor",
      handlers.openFileInWorkingCopyEditor,
    ),
  );
}

export async function registerColocatedWarningCommand(
  registerScoped: RegisterScoped,
  handlers: ColocatedWarningCommandHandlers,
): Promise<void> {
  await registerScoped(() =>
    vscode.commands.registerCommand(
      "jj.showColocatedWarnings",
      handlers.showColocatedWarnings,
    ),
  );
}
