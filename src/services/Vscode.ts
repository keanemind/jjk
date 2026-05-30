import * as vscode from "vscode";
import { Context, Effect, Layer } from "effect";

export interface VscodeService {
  readonly getWorkspaceFolders: () => Effect.Effect<
    readonly vscode.WorkspaceFolder[]
  >;
  readonly getConfigurationValue: <A>(
    section: string,
    key: string,
    scope?: vscode.ConfigurationScope,
  ) => Effect.Effect<A | undefined>;
  readonly getFolderConfigurationValue: <A>(
    section: string,
    key: string,
    folderPath: string,
  ) => Effect.Effect<A | undefined>;
  readonly executeCommand: <T = unknown>(
    command: string,
    ...args: unknown[]
  ) => Effect.Effect<T, Error>;
  readonly showQuickPick: <T extends vscode.QuickPickItem | string>(
    items: readonly T[],
    options?: vscode.QuickPickOptions,
  ) => Effect.Effect<T | undefined>;
  readonly showInputBox: (
    options?: vscode.InputBoxOptions,
  ) => Effect.Effect<string | undefined>;
  readonly showErrorMessage: (
    message: string,
  ) => Effect.Effect<string | undefined>;
  readonly showWarningMessage: <T extends string>(
    message: string,
    ...items: T[]
  ) => Effect.Effect<T | undefined>;
  readonly openTextDocument: (
    uri: vscode.Uri,
  ) => Effect.Effect<vscode.TextDocument, Error>;
  readonly updateWorkspaceState: (
    key: string,
    value: unknown,
  ) => Effect.Effect<void, Error>;
  readonly stat: (uri: vscode.Uri) => Effect.Effect<vscode.FileStat, Error>;
  readonly getActiveTextEditor: () => Effect.Effect<
    vscode.TextEditor | undefined
  >;
}

export class Vscode extends Context.Tag("Vscode")<Vscode, VscodeService>() {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isStringQuickPickItems(
  items: readonly (vscode.QuickPickItem | string)[],
): items is readonly string[] {
  return items.every((item) => typeof item === "string");
}

function isObjectQuickPickItems(
  items: readonly (vscode.QuickPickItem | string)[],
): items is readonly vscode.QuickPickItem[] {
  return items.every((item) => typeof item !== "string");
}

export function VscodeLive(
  context: vscode.ExtensionContext,
): Layer.Layer<Vscode> {
  return Layer.succeed(Vscode, {
    getWorkspaceFolders: () =>
      Effect.sync(() => vscode.workspace.workspaceFolders ?? []),
    getConfigurationValue: <A>(
      section: string,
      key: string,
      scope?: vscode.ConfigurationScope,
    ) =>
      Effect.sync(() =>
        vscode.workspace.getConfiguration(section, scope).get<A>(key),
      ),
    getFolderConfigurationValue: <A>(
      section: string,
      key: string,
      folderPath: string,
    ) =>
      Effect.sync(() =>
        vscode.workspace
          .getConfiguration(section, vscode.Uri.file(folderPath))
          .get<A>(key),
      ),
    executeCommand: <T = unknown>(command: string, ...args: unknown[]) =>
      Effect.tryPromise({
        try: () => vscode.commands.executeCommand<T>(command, ...args),
        catch: toError,
      }),
    showQuickPick: <T extends vscode.QuickPickItem | string>(
      items: readonly T[],
      options?: vscode.QuickPickOptions,
    ) =>
      Effect.promise(() => {
        if (isStringQuickPickItems(items)) {
          return vscode.window.showQuickPick(items, options) as Thenable<
            T | undefined
          >;
        }
        if (isObjectQuickPickItems(items)) {
          return vscode.window.showQuickPick(items, options) as Thenable<
            T | undefined
          >;
        }
        return Promise.resolve(undefined);
      }),
    showInputBox: (options?: vscode.InputBoxOptions) =>
      Effect.promise(() => vscode.window.showInputBox(options)),
    showErrorMessage: (message: string) =>
      Effect.promise(() => vscode.window.showErrorMessage(message)),
    showWarningMessage: <T extends string>(message: string, ...items: T[]) =>
      Effect.promise(() => vscode.window.showWarningMessage(message, ...items)),
    openTextDocument: (uri: vscode.Uri) =>
      Effect.tryPromise({
        try: () => vscode.workspace.openTextDocument(uri),
        catch: toError,
      }),
    updateWorkspaceState: (key: string, value: unknown) =>
      Effect.tryPromise({
        try: () => context.workspaceState.update(key, value),
        catch: toError,
      }),
    stat: (uri: vscode.Uri) =>
      Effect.tryPromise({
        try: () => vscode.workspace.fs.stat(uri),
        catch: toError,
      }),
    getActiveTextEditor: () =>
      Effect.sync(() => vscode.window.activeTextEditor),
  });
}

export const getWorkspaceFolders = (): Effect.Effect<
  readonly vscode.WorkspaceFolder[],
  never,
  Vscode
> => Effect.flatMap(Vscode, (service) => service.getWorkspaceFolders());

export const getConfigurationValue = <A>(
  section: string,
  key: string,
  scope?: vscode.ConfigurationScope,
): Effect.Effect<A | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) =>
    service.getConfigurationValue<A>(section, key, scope),
  );

export const getFolderConfigurationValue = <A>(
  section: string,
  key: string,
  folderPath: string,
): Effect.Effect<A | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) =>
    service.getFolderConfigurationValue<A>(section, key, folderPath),
  );

export const executeCommand = <T = unknown>(
  command: string,
  ...args: unknown[]
): Effect.Effect<T, Error, Vscode> =>
  Effect.flatMap(Vscode, (service) =>
    service.executeCommand<T>(command, ...args),
  );

export const showQuickPick = <T extends vscode.QuickPickItem | string>(
  items: readonly T[],
  options?: vscode.QuickPickOptions,
): Effect.Effect<T | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.showQuickPick(items, options));

export const showInputBox = (
  options?: vscode.InputBoxOptions,
): Effect.Effect<string | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.showInputBox(options));

export const showErrorMessage = (
  message: string,
): Effect.Effect<string | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.showErrorMessage(message));

export const showWarningMessage = <T extends string>(
  message: string,
  ...items: T[]
): Effect.Effect<T | undefined, never, Vscode> =>
  Effect.flatMap(Vscode, (service) =>
    service.showWarningMessage(message, ...items),
  );

export const openTextDocument = (
  uri: vscode.Uri,
): Effect.Effect<vscode.TextDocument, Error, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.openTextDocument(uri));

export const updateWorkspaceState = (
  key: string,
  value: unknown,
): Effect.Effect<void, Error, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.updateWorkspaceState(key, value));

export const stat = (
  uri: vscode.Uri,
): Effect.Effect<vscode.FileStat, Error, Vscode> =>
  Effect.flatMap(Vscode, (service) => service.stat(uri));

export const getActiveTextEditor = (): Effect.Effect<
  vscode.TextEditor | undefined,
  never,
  Vscode
> => Effect.flatMap(Vscode, (service) => service.getActiveTextEditor());

export const setContext = (
  key: string,
  value: unknown,
): Effect.Effect<unknown, Error, Vscode> =>
  executeCommand("setContext", key, value);

export const withProgress = <A, E, R>(
  options: vscode.ProgressOptions,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Vscode> =>
  Effect.flatMap(Vscode, () =>
    Effect.contextWithEffect((context) =>
      Effect.tryPromise({
        try: () =>
          vscode.window.withProgress(options, () =>
            Effect.runPromise(effect.pipe(Effect.provide(context))),
          ),
        catch: (cause) => cause as E,
      }),
    ),
  );
