export type { Json, LspPosition, LspRange } from "./lsp-client";

export type LspLocation = { uri: string; range: import("./lsp-client").LspRange };

export type SymbolCandidate = {
  name: string;
  uri: string;
  range: import("./lsp-client").LspRange;
  containerName?: string;
};
