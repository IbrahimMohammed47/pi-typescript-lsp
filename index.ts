import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  configuredServerPath,
  formatLspConfigGuide,
  getLspConfig,
  isExcludedPath,
  loadLspConfig,
} from "./src/config";
import { shutdownClient } from "./src/client";
import {
  MAX_FORMATTED_DIAGNOSTIC_ERRORS,
  runTypeScriptCheck,
} from "./src/diagnostics";
import { isTsJsSourceFile, resolveProjectPath } from "./src/path";
import { registerTools } from "./src/tools";

type ToolResultEvent = {
  toolName: string;
  isError?: boolean;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

export default function typescriptLspExtension(pi: ExtensionAPI) {
  const defaultServerPath = resolve(
    __dirname,
    "node_modules/.bin/typescript-language-server",
  );
  const typescriptPackagePath = resolve(
    __dirname,
    "node_modules/typescript/package.json",
  );
  const typescriptBinPath = resolve(__dirname, "node_modules/typescript/bin/tsc");

  pi.on("session_start", async (_event, ctx) => {
    const missing: string[] = [];
    const lspConfig = loadLspConfig(ctx.cwd, defaultServerPath);
    const serverPath = configuredServerPath(ctx.cwd, defaultServerPath);
    if (lspConfig.enabled && !existsSync(serverPath))
      missing.push("typescript-language-server");
    if (lspConfig.enabled && !existsSync(typescriptPackagePath))
      missing.push("typescript");
    if (!missing.length) return;

    (ctx as any).ui?.notify(
      `TypeScript LSP extension missing dependencies: ${missing.join(", ")}. Run: cd ${__dirname} && npm install`,
      "warning",
    );
  });

  (pi as any).registerCommand?.("lsp", {
    description:
      "Show TypeScript LSP extension config guide, current values, defaults, and .pi/typescript-lsp.json override instructions.",
    handler: async (_args: unknown, ctx: { cwd: string; ui: { notify(message: string, kind: string): void } }) => {
      ctx.ui.notify(formatLspConfigGuide(ctx.cwd, defaultServerPath), "info");
    },
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit")
      return undefined;
    if (event.isError) return undefined;

    const inputPath = getToolResultPath(event.input);
    if (!inputPath) return undefined;

    const path = resolveProjectPath(ctx.cwd, inputPath);
    if (!isTsJsSourceFile(path)) return undefined;

    try {
      const lspConfig = getLspConfig();
      if (!lspConfig.enabled || !lspConfig.autoDiagnostics) return undefined;
      if (isExcludedPath(ctx.cwd, path)) return undefined;
      const summary = await runTypeScriptCheck(
        ctx,
        configuredServerPath(ctx.cwd, defaultServerPath),
        typescriptBinPath,
        path,
        lspConfig.autoDiagnosticsWaitMs,
        MAX_FORMATTED_DIAGNOSTIC_ERRORS,
      );
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `TypeScript diagnostics after ${event.toolName}:\n${summary}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `TypeScript diagnostics unavailable after ${event.toolName}: ${(error as Error).message}`,
          },
        ],
      };
    }
  });

  registerTools(pi, { defaultServerPath, typescriptBinPath });

  pi.on("session_shutdown", shutdownClient);
}

function getToolResultPath(input: Record<string, unknown>): string | undefined {
  return typeof input?.path === "string" && input.path.trim()
    ? input.path
    : undefined;
}
