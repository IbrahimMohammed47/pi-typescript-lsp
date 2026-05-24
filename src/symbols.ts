import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeScriptLspClient } from "./lsp-client";
import type { Json, LspPosition, SymbolCandidate } from "./shared-types";
import { isExcludedPath } from "./config";
import { formatSymbolCandidates, jsonTextResult } from "./format";
import { isTsJsSourceFile, resolveProjectPath } from "./path";

export function targetToLegacy(target: Json): {
  file?: string;
  symbols?: string[];
  query?: string;
  selectIndex?: number;
} {
  if (target.file && target.symbol)
    return {
      file: target.file,
      symbols: [target.symbol],
      selectIndex: target.selectIndex,
    };
  return { query: target.query, selectIndex: target.selectIndex };
}

export async function resolveSymbolTarget(
  client: TypeScriptLspClient,
  cwd: string,
  params: {
    file?: string;
    symbols?: string[];
    query?: string;
    selectIndex?: number;
  },
): Promise<
  | { path: string; uri: string; position: LspPosition }
  | ReturnType<typeof jsonTextResult>
> {
  const symbol = params.symbols?.[0];
  if (params.file && symbol) {
    const path = resolveProjectPath(cwd, params.file);
    const uri = await client.openDocument(path);
    const symbols = (await client.documentSymbols(uri)) || [];
    const candidates = flattenDocumentSymbols(symbols, uri);
    const exact = candidates.filter((candidate) => candidate.name === symbol);
    const matches = exact.length
      ? exact
      : candidates.filter((candidate) =>
          candidate.name.toLowerCase().includes(symbol.toLowerCase()),
        );
    return selectSymbolCandidate(matches, cwd, params.selectIndex);
  }

  const query = params.query || symbol;
  if (query) {
    await openWorkspaceSeedDocument(client, cwd);
    let symbols = (await client.workspaceSymbols(query)) || [];
    let matches = normalizeWorkspaceSymbolCandidates(symbols).filter(
      (candidate) => !isExcludedPath(cwd, fileURLToPath(candidate.uri)),
    );
    if (!matches.length) {
      symbols = await scanWorkspaceSymbols(client, cwd, query, 100);
      matches = normalizeWorkspaceSymbolCandidates(symbols);
    }
    return selectSymbolCandidate(matches, cwd, params.selectIndex);
  }

  throw new Error("symbol target requires file+symbols[] or query");
}

export async function openWorkspaceSeedDocument(
  client: TypeScriptLspClient,
  cwd: string,
): Promise<void> {
  for (const seed of findSeedSourceFiles(cwd, 32)) {
    try {
      await client.openDocument(seed);
    } catch {
      // Ignore bad seed files; workspace symbol warmup is best-effort.
    }
  }
}

export async function scanWorkspaceSymbols(
  client: TypeScriptLspClient,
  cwd: string,
  query: string,
  limit: number,
): Promise<Json[]> {
  const out: Json[] = [];
  const lower = query.toLowerCase();
  for (const file of findSeedSourceFiles(cwd, 250)) {
    if (out.length >= limit) break;
    try {
      const uri = await client.openDocument(file);
      const symbols = flattenDocumentSymbols(
        (await client.documentSymbols(uri)) || [],
        uri,
      );
      for (const symbol of symbols) {
        if (!symbol.name.toLowerCase().includes(lower)) continue;
        out.push({
          name: symbol.name,
          containerName: symbol.containerName,
          location: { uri: symbol.uri, range: symbol.range },
        });
        if (out.length >= limit) break;
      }
    } catch {
      // Best-effort fallback for language servers that return empty workspace/symbol.
    }
  }
  return out;
}

export function flattenDocumentSymbols(
  symbols: Json[],
  uri: string,
): SymbolCandidate[] {
  const out: SymbolCandidate[] = [];
  const walk = (items: Json[]) => {
    for (const item of items || []) {
      const range = item.selectionRange || item.location?.range || item.range;
      const itemUri = item.location?.uri || uri;
      if (item.name && range) {
        out.push({
          name: item.name,
          uri: itemUri,
          range,
          containerName: item.containerName,
        });
      }
      if (item.children) walk(item.children);
    }
  };
  walk(symbols);
  return out;
}

export function normalizeWorkspaceSymbolCandidates(
  symbols: Json[],
): SymbolCandidate[] {
  return (symbols || [])
    .map((item) => ({
      name: item.name,
      uri: item.location?.uri,
      range: item.location?.range,
      containerName: item.containerName,
    }))
    .filter((item) => item.name && item.uri && item.range);
}

function selectSymbolCandidate(
  candidates: SymbolCandidate[],
  cwd: string,
  selectIndex?: number,
) {
  if (!candidates.length)
    return jsonTextResult("No matching symbols found.", { candidates });
  if (selectIndex !== undefined) {
    const candidate = candidates[selectIndex];
    if (!candidate)
      return jsonTextResult(`No symbol candidate at index ${selectIndex}.`, {
        candidates,
      });
    return symbolCandidateTarget(candidate);
  }
  if (candidates.length === 1) return symbolCandidateTarget(candidates[0]);
  return jsonTextResult(formatSymbolCandidates(candidates, cwd), {
    candidates,
  });
}

function symbolCandidateTarget(candidate: SymbolCandidate) {
  return {
    path: fileURLToPath(candidate.uri),
    uri: candidate.uri,
    position: candidate.range.start,
  };
}

function findSeedSourceFiles(cwd: string, limit: number): string[] {
  const preferredDirs = ["app", "src", "components", "lib", "utils", "pages"];
  const out: string[] = [];
  for (const dir of preferredDirs) {
    const path = resolve(cwd, dir);
    if (existsSync(path)) collectSeedSourceFiles(cwd, path, limit, out);
    if (out.length >= limit) return out.slice(0, limit);
  }
  collectSeedSourceFiles(cwd, cwd, limit, out);
  return [...new Set(out)].slice(0, limit);
}

function collectSeedSourceFiles(
  cwd: string,
  startDir: string,
  limit: number,
  out: string[],
): void {
  const queue = [startDir];
  const ignored = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
  ]);

  while (queue.length && out.length < limit) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (ignored.has(entry)) continue;
      const path = resolve(dir, entry);
      if (isExcludedPath(cwd, path)) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) queue.push(path);
      else files.push(path);
    }

    for (const file of files) {
      if (isGoodSeedSourceFile(file)) out.push(file);
      if (out.length >= limit) return;
    }
  }
}

function isGoodSeedSourceFile(file: string): boolean {
  const name = file.split(/[\\/]/).pop() || file;
  if (!isTsJsSourceFile(file)) return false;
  if (/\.d\.[cm]?ts$/.test(name)) return false;
  if (
    /^(next|postcss|tailwind|vite|vitest|jest|eslint|prettier)\.config\./.test(
      name,
    )
  )
    return false;
  return true;
}
