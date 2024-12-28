import { Event, Disposable } from "vscode";

export function filterEvent<T>(
  event: Event<T>,
  filter: (e: T) => boolean
): Event<T> {
  return (
    listener: (e: T) => any,
    thisArgs?: any,
    disposables?: Disposable[]
  ) => event((e) => filter(e) && listener.call(thisArgs, e), null, disposables);
}
