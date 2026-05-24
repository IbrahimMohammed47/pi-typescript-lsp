import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Json, LspLocation, SymbolCandidate } from "./shared-types";
import { relative } from "./path";

export function formatDiagnosticChoices(diagnostics: Json[]): string {
  return [
    "Multiple diagnostics found. Retry codeActions with diagnosticIndex:",
    ...diagnostics
      .slice(0, 50)
      .map(
        (diagnostic, index) =>
          `${index}. ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} TS${diagnostic.code ?? ""} ${diagnostic.message}`,
      ),
  ].join("\n");
}

export function normalizeLocations(raw: Json): LspLocation[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((item) => ({
      uri: item.uri || item.targetUri,
      range: item.range || item.targetSelectionRange || item.targetRange,
    }))
    .filter((x) => x.uri && x.range);
}

export function formatLocationsSection(
  symbol: string,
  label: string,
  locations: LspLocation[],
  cwd: string,
): string {
  return `## ${symbol}\n${label}: ${locations.length} result(s)\n${formatLocationsList(locations, cwd)}`.trimEnd();
}

export function formatLocationsList(locations: LspLocation[], cwd: string): string {
  const lines: string[] = [];
  for (const loc of locations.slice(0, 100)) {
    lines.push(formatLocation(loc, cwd));
    const snippet = snippetFor(loc);
    if (snippet) lines.push(snippet);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatLocation(loc: LspLocation, cwd: string): string {
  const file = fileURLToPath(loc.uri);
  return `${relative(cwd, file)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

export function snippetFor(loc: LspLocation): string {
  try {
    const file = fileURLToPath(loc.uri);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const start = Math.max(0, loc.range.start.line - 2);
    const end = Math.min(lines.length, loc.range.start.line + 3);
    return lines
      .slice(start, end)
      .map((line, idx) => `${String(start + idx + 1).padStart(4)} | ${line}`)
      .join("\n");
  } catch {
    return "";
  }
}

export function formatHover(hover: Json): string {
  if (!hover) return "No hover result.";
  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedString).join("\n\n");
  if (contents?.value) return contents.value;
  return JSON.stringify(hover, null, 2);
}

export function markedString(value: Json): string {
  if (typeof value === "string") return value;
  if (value?.language && value?.value)
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  return JSON.stringify(value);
}

export function formatWorkspaceEdit(
  changes: Array<{ uri: string; edits: Json[] }>,
  cwd: string,
): string {
  if (!changes.length) return "No edits.";
  return changes
    .map(
      (change) =>
        `${relative(cwd, fileURLToPath(change.uri))}: ${change.edits.length} edit(s)`,
    )
    .join("\n");
}

export function formatCodeActions(actions: Json[]): string {
  if (!actions.length) return "No code actions.";
  return actions
    .map(
      (a, i) =>
        `${i}. ${a.title || a.command?.title || "Untitled"}${a.kind ? ` [${a.kind}]` : ""}${a.edit ? " edit" : ""}${a.command ? " command" : ""}`,
    )
    .join("\n");
}

export function filterImportCodeActions(actions: Json[]): Json[] {
  return actions.filter((action) => {
    const title = String(action.title || action.command?.title || "").toLowerCase();
    const kind = String(action.kind || "").toLowerCase();
    return kind.includes("source.addmissingimports") || /\b(import|imports)\b/.test(title);
  });
}

export function formatCallHierarchy(
  calls: Json[],
  cwd: string,
  direction: string,
): string {
  if (!calls?.length) return `No ${direction} calls.`;
  return calls
    .map((call) => {
      const item = direction === "outgoing" ? call.to : call.from;
      const range = item?.selectionRange || item?.range;
      const loc =
        item?.uri && range
          ? formatLocation({ uri: item.uri, range }, cwd)
          : "unknown";
      return `- ${item?.name || "unknown"} — ${loc}`;
    })
    .join("\n");
}

export function formatSymbolCandidates(
  candidates: SymbolCandidate[],
  cwd: string,
): string {
  return [
    "Multiple symbols found. Retry with selectIndex:",
    ...candidates.slice(0, 50).map((candidate, index) => {
      const loc = formatLocation(
        { uri: candidate.uri, range: candidate.range },
        cwd,
      );
      const container = candidate.containerName
        ? ` (${candidate.containerName})`
        : "";
      return `${index}. ${candidate.name}${container} — ${loc}`;
    }),
  ].join("\n");
}

export function formatDocumentSymbols(symbols: Json[]): string {
  if (!symbols?.length) return "No document symbols.";
  const out: string[] = [];
  const walk = (items: Json[], depth: number) => {
    for (const s of items) {
      const range = s.selectionRange || s.range || s.location?.range;
      const pos = range
        ? `:${range.start.line + 1}:${range.start.character + 1}`
        : "";
      out.push(
        `${"  ".repeat(depth)}- ${s.name}${s.detail ? ` ${s.detail}` : ""}${pos}`,
      );
      if (s.children) walk(s.children, depth + 1);
    }
  };
  walk(symbols, 0);
  return out.join("\n");
}

export function formatWorkspaceSymbols(symbols: Json[], cwd: string): string {
  if (!symbols.length) return "No workspace symbols.";
  return symbols
    .map((s) => {
      const loc = s.location;
      const pos = loc?.uri ? formatLocation(loc, cwd) : "unknown";
      return `- ${s.name}${s.containerName ? ` (${s.containerName})` : ""} — ${pos}`;
    })
    .join("\n");
}

export function formatDiagnostics(
  diagnostics: Record<string, Json[]>,
  cwd: string,
  maxErrors = 20,
): string {
  const out: string[] = [];
  let totalErrors = 0;
  let hiddenNonErrors = 0;

  for (const [uri, items] of Object.entries(diagnostics)) {
    for (const d of items) {
      if (!isErrorDiagnostic(d)) {
        hiddenNonErrors++;
        continue;
      }
      totalErrors++;
      if (out.length >= maxErrors) continue;
      out.push(
        `${relative(cwd, fileURLToPath(uri))}:${d.range.start.line + 1}:${d.range.start.character + 1} error TS${d.code ?? ""} ${d.message}`,
      );
    }
  }

  if (out.length) {
    if (totalErrors > out.length)
      out.push(
        `... ${totalErrors - out.length} more TypeScript error(s) hidden (limit ${maxErrors}).`,
      );
    if (hiddenNonErrors)
      out.push(`${hiddenNonErrors} non-error diagnostic(s) hidden.`);
    return out.join("\n");
  }

  if (hiddenNonErrors)
    return `No TypeScript errors. ${hiddenNonErrors} non-error diagnostic(s) hidden.`;
  return "No TypeScript errors reported.";
}

export function isErrorDiagnostic(diagnostic: Json): boolean {
  return diagnostic.severity === undefined || diagnostic.severity === 1;
}

export function renderLspCall(toolName: string, args: Json) {
  const text = `${toolName}(${JSON.stringify(args)})`;
  return {
    render(width: number) {
      return text.split("\n").map((line) => truncateLine(line, width));
    },
  };
}

export function truncateLine(line: string, width: number): string {
  if (width <= 0 || line.length <= width) return line;
  if (width <= 1) return "…";
  return `${line.slice(0, width - 1)}…`;
}

export function jsonTextResult(text: string, details: Json) {
  return { content: [{ type: "text" as const, text }], details };
}
