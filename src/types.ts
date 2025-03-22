import type { JJDecorationProvider } from "./decorationProvider";

export type FileDecorationProviderGetter = (
  ...params: ConstructorParameters<typeof JJDecorationProvider>
) => JJDecorationProvider;
