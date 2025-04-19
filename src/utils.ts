import { sep } from "path";
import { Event, Disposable } from "vscode";

export const isMacintosh = process.platform === "darwin";
export const isWindows = process.platform === "win32";

export function dispose<T extends Disposable>(disposables: T[]): T[] {
  disposables.forEach((d) => void d.dispose());
  return [];
}

export function toDisposable(dispose: () => void): Disposable {
  return { dispose };
}

export function combinedDisposable(disposables: Disposable[]): Disposable {
  return toDisposable(() => dispose(disposables));
}

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

export function anyEvent<T>(...events: Event<T>[]): Event<T> {
  return (
    listener: (e: T) => unknown,
    thisArgs?: unknown,
    disposables?: Disposable[],
  ) => {
    const result = combinedDisposable(
      events.map((event) => event((i) => listener.call(thisArgs, i))),
    );

    disposables?.push(result);

    return result;
  };
}

export function onceEvent<T>(event: Event<T>): Event<T> {
  return (
    listener: (e: T) => unknown,
    thisArgs?: unknown,
    disposables?: Disposable[],
  ) => {
    const result = event(
      (e) => {
        result.dispose();
        return listener.call(thisArgs, e);
      },
      null,
      disposables,
    );

    return result;
  };
}

export function eventToPromise<T>(event: Event<T>): Promise<T> {
  return new Promise<T>((c) => onceEvent(event)(c));
}

function normalizePath(path: string): string {
  // Windows & Mac are currently being handled
  // as case insensitive file systems in VS Code.
  if (isWindows || isMacintosh) {
    return path.toLowerCase();
  }

  return path;
}

export function isDescendant(parent: string, descendant: string): boolean {
  if (parent === descendant) {
    return true;
  }

  if (parent.charAt(parent.length - 1) !== sep) {
    parent += sep;
  }

  return normalizePath(descendant).startsWith(normalizePath(parent));
}

export function pathEquals(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Creates a throttled version of an async function that ensures the underlying
 * function (`fn`) is called at most once concurrently.
 *
 * If the throttled function is called while `fn` is already running:
 * - It schedules `fn` to run again immediately after the current run finishes.
 * - Only one run can be scheduled this way.
 * - If called multiple times while a run is active and another is scheduled,
 *   the arguments for the scheduled run are updated to the latest arguments provided.
 * - The promise returned by calls made while active/scheduled will resolve or
 *   reject with the result of the *next* scheduled run.
 *
 * @template T The return type of the async function's Promise.
 * @template A The argument types of the async function.
 * @param fn The async function to throttle.
 * @returns A new function that throttles calls to `fn`.
 */
export function createThrottledAsyncFn<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  enum State {
    Idle,
    Running,
    Queued,
  }
  let state = State.Idle;
  let queuedArgs: A | null = null;
  // Promise returned to callers who triggered the queued run
  let queuedRunPromise: Promise<T> | null = null;
  let queuedRunResolver: ((value: T) => void) | null = null;
  let queuedRunRejector:
    | Parameters<ConstructorParameters<typeof Promise>["0"]>["1"]
    | null = null;

  const throttledFn = (...args: A): Promise<T> => {
    queuedArgs = args; // Always store the latest args for a potential queued run

    if (state === State.Running || state === State.Queued) {
      // If already running or queued, ensure we are in Queued state
      // and return the promise for the queued run.
      if (state !== State.Queued) {
        state = State.Queued;
        queuedRunPromise = new Promise<T>((resolve, reject) => {
          queuedRunResolver = resolve;
          queuedRunRejector = reject;
        });
      }
      // This assertion is safe because we ensure queuedRunPromise is set when state becomes Queued.
      return queuedRunPromise!;
    }

    // State is Idle, transition to Running
    state = State.Running;
    // Execute with current args. Capture the promise for this specific run.
    const runPromise = fn(...args);

    // Set up the logic to handle completion of the current run
    runPromise.then(
      (_result) => {
        // --- Success path ---
        if (state === State.Queued) {
          // A run was queued while this one was running.
          const resolver = queuedRunResolver!;
          const rejector = queuedRunRejector!;
          const nextArgs = queuedArgs!; // Use the last stored args

          // Reset queue state *before* starting the next run
          queuedRunPromise = null;
          queuedRunResolver = null;
          queuedRunRejector = null;
          queuedArgs = null;
          state = State.Idle; // Temporarily Idle, the recursive call below will set it back to Running

          // Start the next run recursively.
          // Link its result back to the promise we returned to the queued caller(s).
          throttledFn(...nextArgs).then(resolver, rejector);
        } else {
          // No run was queued, simply return to Idle state.
          state = State.Idle;
        }
        // Note: We don't return the result here; the original runPromise already holds it.
      },
      (error) => {
        // --- Error path ---
        if (state === State.Queued) {
          // A run was queued, but the current one failed.
          // Reject the promise that was returned to the queued caller(s).
          const rejector = queuedRunRejector!;

          // Reset queue state
          queuedRunPromise = null;
          queuedRunResolver = null;
          queuedRunRejector = null;
          queuedArgs = null;
          state = State.Idle;

          rejector(error); // Reject the queued promise
        } else {
          // No run was queued, simply return to Idle state.
          state = State.Idle;
        }
        // Note: We don't re-throw the error here; the original runPromise already handles rejection.
      },
    );

    // Return the promise for the *current* execution immediately.
    return runPromise;
  };

  return throttledFn;
}

/**
 * Creates a debounced version of a function that delays invoking `fn`
 * until `delay` milliseconds have elapsed since the last time the
 * debounced function was invoked.
 *
 * @template A The argument types of the function.
 * @param fn The function to debounce.
 * @param delay The number of milliseconds to delay.
 * @returns A new debounced function.
 */
export function createDebouncedFn<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const debouncedFn = (...args: A): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
    }

    timerId = setTimeout(() => {
      timerId = null; // Clear the timerId *before* calling fn
      fn(...args); // Call the original function with the latest arguments
    }, delay);
  };

  return debouncedFn;
}
