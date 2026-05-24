import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Json, LspPosition, LspRange } from "./shared-types";
import { getClient } from "./client";
import { configuredServerPath, filterWorkspaceSymbolsByExclude } from "./config";
import { runTypeScriptCheck, MAX_FORMATTED_DIAGNOSTIC_ERRORS } from "./diagnostics";
import { codeActionResult, rangeForWholeFile, workspaceEditResult } from "./edits";
import {
  filterImportCodeActions,
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnosticChoices,
  formatDocumentSymbols,
  formatHover,
  formatLocationsSection,
  formatWorkspaceSymbols,
  jsonTextResult,
  normalizeLocations,
  renderLspCall,
} from "./format";
import { resolveProjectPath } from "./path";
import {
  openWorkspaceSeedDocument,
  resolveSymbolTarget,
  scanWorkspaceSymbols,
  targetToLegacy,
} from "./symbols";
import {
  CHECK_PARAMS,
  FIND_SYMBOLS_PARAMS,
  IMPORT_FIX_PARAMS,
  RENAME_PARAMS,
  SYMBOL_CONTEXT_PARAMS,
} from "./schemas";

export function registerTools(
  pi: ExtensionAPI,
  paths: { defaultServerPath: string; typescriptBinPath: string },
): void {
  pi.registerTool({
    name: "ts_symbol_context",
    label: "TS Symbol Context",
    description:
      "TypeScript symbol info: hover/type, definition, references, implementations, call hierarchy. Use first for named TS/JS symbols. Target by {file,symbol} when file is known, or {query} when file is unknown.",
    promptSnippet:
      "Use first for named TS/JS symbols: explain, definition, refs, callers/callees. Prefer over grep-based search for symbol questions.",
    promptGuidelines: [
      "Use ts_symbol_context first for named TS/JS symbols; use grep-based search only for raw text/paths/non-symbols.",
      "If ts_symbol_context returns multiple symbols, retry with selectIndex.",
      "ts_symbol_context defaults to hover + definition; request references/callHierarchy only when needed.",
    ],
    parameters: SYMBOL_CONTEXT_PARAMS,
    renderCall(args) {
      return renderLspCall("ts_symbol_context", args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await getClient(
        ctx,
        configuredServerPath(ctx.cwd, paths.defaultServerPath),
      );
      const target = await resolveSymbolTarget(
        c,
        ctx.cwd,
        targetToLegacy(params.target),
      );
      if ("content" in target) return target;

      const include = params.include || {};
      const wantHover = include.hover !== false;
      const wantDefinition = include.definition !== false;
      const wantReferences = include.references === true;
      const sections: string[] = [];
      const details: Json = { target };

      if (wantHover) {
        const hover = await bestHover(c, target.uri, target.position);
        details.hover = hover;
        sections.push(`## hover\n${formatHover(hover)}`);
      }
      if (wantDefinition) {
        const locations = normalizeLocations(
          await c.definition(target.uri, target.position),
        );
        details.definition = locations;
        sections.push(
          formatLocationsSection("definition", "definition", locations, ctx.cwd),
        );
      }
      if (include.typeDefinition) {
        const locations = normalizeLocations(
          await c.typeDefinition(target.uri, target.position),
        );
        details.typeDefinition = locations;
        sections.push(
          formatLocationsSection(
            "type definition",
            "type definition",
            locations,
            ctx.cwd,
          ),
        );
      }
      if (include.implementation) {
        const locations = normalizeLocations(
          await c.implementation(target.uri, target.position),
        );
        details.implementation = locations;
        sections.push(
          formatLocationsSection(
            "implementation",
            "implementation",
            locations,
            ctx.cwd,
          ),
        );
      }
      if (wantReferences) {
        const locations = normalizeLocations(
          await c.references(
            target.uri,
            target.position,
            params.includeDeclaration !== false,
          ),
        );
        details.references = locations;
        sections.push(
          formatLocationsSection("references", "references", locations, ctx.cwd),
        );
      }
      if (include.callHierarchy) {
        const items =
          (await c.prepareCallHierarchy(target.uri, target.position)) || [];
        const item = Array.isArray(items) ? items[0] : items;
        details.callHierarchyItem = item;
        if (!item) {
          sections.push("## call hierarchy\nNo call hierarchy item.");
        } else {
          if (
            include.callHierarchy === "incoming" ||
            include.callHierarchy === "both"
          ) {
            const calls = await c.incomingCalls(item);
            details.incomingCalls = calls;
            sections.push(
              `## incoming calls\n${formatCallHierarchy(calls, ctx.cwd, "incoming")}`,
            );
          }
          if (
            include.callHierarchy === "outgoing" ||
            include.callHierarchy === "both"
          ) {
            const calls = await c.outgoingCalls(item);
            details.outgoingCalls = calls;
            sections.push(
              `## outgoing calls\n${formatCallHierarchy(calls, ctx.cwd, "outgoing")}`,
            );
          }
        }
      }

      return jsonTextResult(sections.join("\n\n"), details);
    },
  });

  pi.registerTool({
    name: "ts_find_symbols",
    label: "TS Symbol Search",
    description:
      "Find TS/JS symbols by workspace query, or outline one file. Use when symbol name is known but file is unknown.",
    promptSnippet:
      "Use first when TS/JS symbol name is known but file unknown. Prefer over grep-based search for symbols.",
    promptGuidelines: [
      "Use ts_find_symbols with query for workspace symbol search, or file for outline; do not pass both.",
      "Use ts_find_symbols results as targets for ts_symbol_context or ts_rename.",
    ],
    parameters: FIND_SYMBOLS_PARAMS,
    renderCall(args) {
      return renderLspCall("ts_find_symbols", args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await getClient(
        ctx,
        configuredServerPath(ctx.cwd, paths.defaultServerPath),
      );
      if (!!params.query === !!params.file)
        throw new Error("ts_find_symbols requires exactly one of query or file");
      if (params.query) {
        await openWorkspaceSeedDocument(c, ctx.cwd);
        let symbols = filterWorkspaceSymbolsByExclude(
          (await c.workspaceSymbols(params.query)) || [],
          ctx.cwd,
        );
        if (!symbols.length)
          symbols = await scanWorkspaceSymbols(
            c,
            ctx.cwd,
            params.query,
            params.limit || 50,
          );
        symbols = symbols.slice(0, params.limit || 50);
        return jsonTextResult(formatWorkspaceSymbols(symbols, ctx.cwd), {
          symbols,
        });
      }
      const path = resolveProjectPath(ctx.cwd, params.file);
      const uri = await c.openDocument(path);
      const symbols = await c.documentSymbols(uri);
      return jsonTextResult(formatDocumentSymbols(symbols), { symbols });
    },
  });

  pi.registerTool({
    name: "ts_errors_check",
    label: "TS Errors Check",
    description:
      "Check whether TypeScript is broken. Pass file when checking a recent change or known problem file; omit file when no file is known.",
    promptSnippet:
      "Use ts_errors_check for TypeScript errors and post-edit verification. Pass file when one is relevant.",
    parameters: CHECK_PARAMS,
    renderCall(args) {
      return renderLspCall("ts_errors_check", args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const maxErrors = params.maxErrors || MAX_FORMATTED_DIAGNOSTIC_ERRORS;
      const file = params.file
        ? resolveProjectPath(ctx.cwd, params.file)
        : undefined;
      const summary = await runTypeScriptCheck(
        ctx,
        configuredServerPath(ctx.cwd, paths.defaultServerPath),
        paths.typescriptBinPath,
        file,
        params.waitMs || 1200,
        maxErrors,
      );
      return jsonTextResult(summary, { maxErrors });
    },
  });

  pi.registerTool({
    name: "ts_import_fix",
    label: "TS Import Fix",
    description:
      "Fix imports in one TS/JS file: auto-import for import diagnostic, or organize imports when diagnosticIndex omitted. Preview by default; apply:true writes changes.",
    promptSnippet:
      "Use ts_import_fix for missing imports or import cleanup. Otherwise edit manually.",
    parameters: IMPORT_FIX_PARAMS,
    renderCall(args) {
      return renderLspCall("ts_import_fix", args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await getClient(
        ctx,
        configuredServerPath(ctx.cwd, paths.defaultServerPath),
      );
      const path = resolveProjectPath(ctx.cwd, params.file);
      const uri = await c.openDocument(path);

      if (params.diagnosticIndex === undefined) {
        const actions =
          (await c.codeActions(uri, rangeForWholeFile(path), [
            "source.organizeImports",
          ])) || [];
        if (params.applyIndex === undefined && actions.length > 1)
          return jsonTextResult(formatCodeActions(actions), { actions });
        const action =
          actions[
            params.applyIndex ??
              actions.findIndex((a: Json) => a.edit || a.command)
          ];
        if (!action)
          return jsonTextResult("No organize imports action.", { actions });
        return codeActionResult(
          c,
          action,
          ctx.cwd,
          params.apply === true,
          "organize imports",
        );
      }

      const diagnostics =
        (await c.getDiagnostics(uri, params.waitMs || 300))[uri] || [];
      const diagnosticSelection = selectDiagnostic(
        diagnostics,
        params.diagnosticIndex,
      );
      if ("content" in diagnosticSelection) return diagnosticSelection;
      const actions = filterImportCodeActions(
        (await c.codeActions(uri, diagnosticSelection.range, ["quickfix"])) || [],
      );
      if (params.applyIndex === undefined)
        return jsonTextResult(formatCodeActions(actions), {
          actions,
          diagnostic: diagnosticSelection.diagnostic,
        });
      const action = actions[params.applyIndex];
      if (!action)
        throw new Error(`No import action at index ${params.applyIndex}`);
      return codeActionResult(
        c,
        action,
        ctx.cwd,
        params.apply === true,
        "import fix",
      );
    },
  });

  pi.registerTool({
    name: "ts_rename",
    label: "TS Rename",
    description:
      "Safely rename TS/JS symbol across files. Target by {file,symbol} or {query}. Previews by default.",
    promptSnippet:
      "Use immediately for TS/JS rename requests. Prefer over manual search/replace.",
    promptGuidelines: [
      "Use ts_rename for TS/JS rename requests; use {query} or ts_find_symbols when file is unknown.",
      "If ts_rename returns multiple symbols, retry with selectIndex.",
      "ts_rename previews by default; pass apply:true only when edit requested/accepted.",
    ],
    parameters: RENAME_PARAMS,
    renderCall(args) {
      return renderLspCall("ts_rename", args);
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await getClient(
        ctx,
        configuredServerPath(ctx.cwd, paths.defaultServerPath),
      );
      const target = await resolveSymbolTarget(
        c,
        ctx.cwd,
        targetToLegacy(params.target),
      );
      if ("content" in target) return target;
      const edit = await c.rename(target.uri, target.position, params.newName);
      return workspaceEditResult(edit, ctx.cwd, params.apply === true);
    },
  });
}

async function bestHover(
  client: { hover(uri: string, position: LspPosition, verbosityLevel?: number): Promise<Json> },
  uri: string,
  position: LspPosition,
): Promise<Json> {
  const hover = await client.hover(uri, position);
  if (!hover?.canIncreaseVerbosityLevel) return hover;
  try {
    return await client.hover(uri, position, 1);
  } catch {
    return hover;
  }
}

function selectDiagnostic(diagnostics: Json[], diagnosticIndex?: number) {
  if (!diagnostics.length)
    return jsonTextResult("No diagnostics found for codeActions.", {
      diagnostics,
    });
  if (diagnosticIndex !== undefined) {
    const diagnostic = diagnostics[diagnosticIndex];
    if (!diagnostic)
      return jsonTextResult(`No diagnostic at index ${diagnosticIndex}.`, {
        diagnostics,
      });
    return { diagnostic, range: diagnostic.range as LspRange };
  }
  if (diagnostics.length === 1)
    return {
      diagnostic: diagnostics[0],
      range: diagnostics[0].range as LspRange,
    };
  return jsonTextResult(formatDiagnosticChoices(diagnostics), { diagnostics });
}
