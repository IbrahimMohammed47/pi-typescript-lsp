import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "./shared-types";
import { relative } from "./path";

export type LspConfig = {
  enabled: boolean;
  autoDiagnostics: boolean;
  autoDiagnosticsWaitMs: number;
  maxFileSizeBytes: number;
  serverPath: string;
  exclude: string[];
  source: string;
};

export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  autoDiagnostics: true,
  autoDiagnosticsWaitMs: 800,
  maxFileSizeBytes: 2 * 1024 * 1024,
  serverPath: "auto",
  exclude: [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
  ],
  source: "built-in defaults",
};

let lspConfig: LspConfig = { ...DEFAULT_LSP_CONFIG };

export function getLspConfig(): LspConfig {
  return lspConfig;
}

export function loadLspConfig(cwd: string, defaultServerPath: string): LspConfig {
  lspConfig = deriveLspConfigFromProject(cwd, defaultServerPath);
  return lspConfig;
}

export function deriveLspConfigFromProject(
  cwd: string,
  defaultServerPath: string,
): LspConfig {
  const configFile = findTypeScriptConfigFile(cwd);
  const tsConfig = configFile ? readJsonConfig(configFile) : undefined;
  const projectOverrideFile = resolve(cwd, ".pi/typescript-lsp.json");
  const projectOverride = existsSync(projectOverrideFile)
    ? readJsonConfig(projectOverrideFile)
    : undefined;
  const exclude = Array.isArray(tsConfig?.exclude)
    ? [...new Set([...DEFAULT_LSP_CONFIG.exclude, ...tsConfig.exclude])]
    : [...DEFAULT_LSP_CONFIG.exclude];
  const derived: LspConfig = {
    ...DEFAULT_LSP_CONFIG,
    serverPath: existsSync(
      resolve(cwd, "node_modules/.bin/typescript-language-server"),
    )
      ? "node_modules/.bin/typescript-language-server"
      : defaultServerPath,
    exclude,
    source: configFile
      ? `${relative(cwd, configFile)} exclude + project/default server path`
      : "built-in defaults + project/default server path",
  };
  const merged = applyLspConfigOverride(derived, projectOverride);
  return {
    ...merged,
    source: projectOverride
      ? `${derived.source} + .pi/typescript-lsp.json override`
      : derived.source,
  };
}

export function configuredServerPath(cwd: string, defaultServerPath: string): string {
  if (!lspConfig.serverPath || lspConfig.serverPath === "auto")
    return defaultServerPath;
  return isAbsolute(lspConfig.serverPath)
    ? lspConfig.serverPath
    : resolve(cwd, lspConfig.serverPath);
}

export function isExcludedPath(cwd: string, file: string): boolean {
  const rel = relative(cwd, file).replace(/\\/g, "/");
  return lspConfig.exclude.some((pattern) => matchesPathPattern(rel, pattern));
}

export function filterWorkspaceSymbolsByExclude(symbols: Json[], cwd: string): Json[] {
  return symbols.filter((symbol) => {
    const uri = symbol?.location?.uri;
    return !uri || !isExcludedPath(cwd, fileURLToPath(uri));
  });
}

export function formatLspConfigGuide(cwd: string, defaultServerPath: string): string {
  return [
    "TypeScript LSP config guide",
    "",
    "This command is read-only. To override defaults, create project file:",
    "  .pi/typescript-lsp.json",
    "",
    "Defaults are derived on session start from built-in defaults + tsconfig/jsconfig exclude + project-local language server when found. Project override file wins.",
    "",
    "Current values:",
    `  source: ${lspConfig.source}`,
    `  resolvedServerPath: ${configuredServerPath(cwd, defaultServerPath)}`,
    `  enabled: ${lspConfig.enabled}`,
    `  autoDiagnostics: ${lspConfig.autoDiagnostics}`,
    `  autoDiagnosticsWaitMs: ${lspConfig.autoDiagnosticsWaitMs}`,
    `  maxFileSizeBytes: ${lspConfig.maxFileSizeBytes}`,
    `  serverPath: ${JSON.stringify(lspConfig.serverPath)}`,
    `  exclude: ${JSON.stringify(lspConfig.exclude)}`,
    "",
    "Built-in defaults before project detection/override:",
    `  enabled: ${DEFAULT_LSP_CONFIG.enabled}`,
    `  autoDiagnostics: ${DEFAULT_LSP_CONFIG.autoDiagnostics}`,
    `  autoDiagnosticsWaitMs: ${DEFAULT_LSP_CONFIG.autoDiagnosticsWaitMs}`,
    `  maxFileSizeBytes: ${DEFAULT_LSP_CONFIG.maxFileSizeBytes}`,
    `  serverPath: ${JSON.stringify(DEFAULT_LSP_CONFIG.serverPath)}`,
    `  exclude: ${JSON.stringify(DEFAULT_LSP_CONFIG.exclude)}`,
    "",
    "Options:",
    "  enabled (boolean)",
    "    Master switch for all TypeScript LSP tools and automatic diagnostics.",
    "  autoDiagnostics (boolean)",
    "    Append TypeScript diagnostics after successful native write/edit tool calls.",
    "  autoDiagnosticsWaitMs (number)",
    "    Wait time for automatic diagnostics after write/edit. Higher is more complete but slower.",
    "  maxFileSizeBytes (number)",
    "    Maximum file size opened by the LSP client to avoid huge generated files.",
    "  serverPath (string)",
    "    typescript-language-server path. Use 'auto' for bundled server, or relative/absolute override.",
    "  exclude (string[])",
    "    Paths/globs ignored by extension file discovery and automatic diagnostics. Seeded from tsconfig/jsconfig exclude when present; project override replaces current exclude.",
    "",
    "Example .pi/typescript-lsp.json:",
    JSON.stringify(
      {
        enabled: true,
        autoDiagnostics: true,
        autoDiagnosticsWaitMs: 800,
        maxFileSizeBytes: 2097152,
        serverPath: "auto",
        exclude: ["node_modules", "dist", "build", "coverage"],
      },
      null,
      2,
    ),
  ].join("\n");
}

function findTypeScriptConfigFile(cwd: string): string | undefined {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = resolve(cwd, name);
    if (existsSync(file)) return file;
  }
  try {
    const match = readdirSync(cwd).find((name) =>
      /^tsconfig\..+\.json$/.test(name),
    );
    return match ? resolve(cwd, match) : undefined;
  } catch {
    return undefined;
  }
}

function readJsonConfig(file: string): Json | undefined {
  try {
    return JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function applyLspConfigOverride(config: LspConfig, override: Json): LspConfig {
  if (!override || typeof override !== "object") return config;
  const next = { ...config };
  if (typeof override.enabled === "boolean") next.enabled = override.enabled;
  if (typeof override.autoDiagnostics === "boolean")
    next.autoDiagnostics = override.autoDiagnostics;
  if (typeof override.autoDiagnosticsWaitMs === "number")
    next.autoDiagnosticsWaitMs = override.autoDiagnosticsWaitMs;
  if (typeof override.maxFileSizeBytes === "number")
    next.maxFileSizeBytes = override.maxFileSizeBytes;
  if (typeof override.serverPath === "string")
    next.serverPath = override.serverPath;
  if (Array.isArray(override.exclude))
    next.exclude = override.exclude.filter(
      (item: unknown): item is string => typeof item === "string",
    );
  return next;
}

function matchesPathPattern(rel: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (!/[?*]/.test(normalized))
    return (
      rel === normalized ||
      rel.startsWith(`${normalized}/`) ||
      rel.endsWith(`/${normalized}`)
    );
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(rel);
}
