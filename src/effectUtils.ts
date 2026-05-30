import { Effect, Exit, Scope } from "effect";

interface DisposableLike {
  dispose(): unknown;
}

export const scopedDisposable = <A extends DisposableLike>(
  acquire: () => A,
): Effect.Effect<A, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(acquire), (resource) =>
    Effect.sync(() => {
      resource.dispose();
    }),
  );

export const closeScope = (scope: Scope.CloseableScope): Effect.Effect<void> =>
  Scope.close(scope, Exit.void);
