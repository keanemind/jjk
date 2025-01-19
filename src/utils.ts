import { Event, Disposable } from "vscode";

export function filterEvent<T>(
  event: Event<T>,
  filter: (e: T) => boolean,
): Event<T> {
  return (
    listener: (e: T) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
    thisArgs?: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    disposables?: Disposable[],
  ) => event((e) => filter(e) && listener.call(thisArgs, e), null, disposables); // eslint-disable-line @typescript-eslint/no-unsafe-return
}
