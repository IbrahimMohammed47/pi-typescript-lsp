import { Type } from "typebox";

export const SYMBOL_TARGET_PARAMS = Type.Union([
  Type.Object({
    file: Type.String({
      description:
        "Path to TypeScript/TSX/JavaScript file containing the symbol, relative to cwd or absolute.",
    }),
    symbol: Type.String({
      description:
        "Symbol name to resolve inside file. Exact match preferred; partial match allowed when unambiguous.",
    }),
    selectIndex: Type.Optional(
      Type.Number({
        description:
          "0-based candidate index from an ambiguity response. Use only after tool asks for it.",
      }),
    ),
  }),
  Type.Object({
    query: Type.String({
      description:
        "Workspace symbol name/prefix when file is unknown. Use symbol names, not file/path search.",
    }),
    selectIndex: Type.Optional(
      Type.Number({
        description:
          "0-based candidate index from an ambiguity response. Use only after tool asks for it.",
      }),
    ),
  }),
]);

export const SYMBOL_CONTEXT_PARAMS = Type.Object({
  target: SYMBOL_TARGET_PARAMS,
  include: Type.Optional(
    Type.Object(
      {
        definition: Type.Optional(Type.Boolean()),
        typeDefinition: Type.Optional(Type.Boolean()),
        hover: Type.Optional(Type.Boolean()),
        references: Type.Optional(Type.Boolean()),
        implementation: Type.Optional(Type.Boolean()),
        callHierarchy: Type.Optional(
          Type.Union([
            Type.Literal("incoming"),
            Type.Literal("outgoing"),
            Type.Literal("both"),
          ]),
        ),
      },
      {
        description:
          "Context sections to include. Defaults to hover, definition, and references for fast symbol understanding.",
      },
    ),
  ),
  includeDeclaration: Type.Optional(
    Type.Boolean({ description: "For references; default true" }),
  ),
});

export const FIND_SYMBOLS_PARAMS = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Workspace symbol name/prefix to search. Use when you know a symbol name but not its file.",
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        "File to outline with document symbols, relative to cwd or absolute.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum workspace symbol results; default 50",
    }),
  ),
});

export const CHECK_PARAMS = Type.Object({
  file: Type.Optional(
    Type.String({
      description:
        "File related to TypeScript change or error, relative to cwd or absolute. Optional.",
    }),
  ),
  waitMs: Type.Optional(
    Type.Number({ description: "Diagnostics wait time; default 1200" }),
  ),
  maxErrors: Type.Optional(
    Type.Number({ description: "Maximum TypeScript errors to show; default 20" }),
  ),
});

export const IMPORT_FIX_PARAMS = Type.Object({
  file: Type.String({
    description:
      "TypeScript/TSX/JavaScript file whose imports need fixing, relative to cwd or absolute.",
  }),
  diagnosticIndex: Type.Optional(
    Type.Number({
      description:
        "0-based diagnostic index for missing/invalid import. Omit to organize imports.",
    }),
  ),
  waitMs: Type.Optional(
    Type.Number({
      description: "Diagnostics wait time; default 300",
    }),
  ),
  applyIndex: Type.Optional(
    Type.Number({
      description:
        "0-based action index to apply/preview after listing actions. Omit to list available fixes.",
    }),
  ),
  apply: Type.Optional(
    Type.Boolean({
      description: "Apply edit to disk; default false previews only.",
    }),
  ),
});

export const RENAME_PARAMS = Type.Object({
  target: SYMBOL_TARGET_PARAMS,
  newName: Type.String({ description: "New symbol name" }),
  apply: Type.Optional(
    Type.Boolean({
      description: "Apply rename to disk; default false previews only.",
    }),
  ),
});
