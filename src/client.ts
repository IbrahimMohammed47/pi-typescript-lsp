import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { TypeScriptLspClient } from "./lsp-client";
import { applyWorkspaceChanges, workspaceEditChanges } from "./edits";
import { getLspConfig } from "./config";

let client: TypeScriptLspClient | undefined;
let clientCwd: string | undefined;

export async function getClient(
  ctx: ExtensionContext,
  serverPath: string,
): Promise<TypeScriptLspClient> {
  const lspConfig = getLspConfig();
  if (!lspConfig.enabled)
    throw new Error("TypeScript LSP disabled. Run /lsp enable to re-enable.");
  if (!existsSync(serverPath))
    throw new Error(
      `typescript-language-server not found: ${serverPath}. Run npm install in extension directory.`,
    );
  if (!client || clientCwd !== ctx.cwd) {
    await client?.shutdown();
    client = new TypeScriptLspClient(ctx.cwd, serverPath, {
      maxFileSizeBytes: () => getLspConfig().maxFileSizeBytes,
      applyWorkspaceChanges,
      workspaceEditChanges,
    });
    clientCwd = ctx.cwd;
  }
  return client;
}

export async function shutdownClient(): Promise<void> {
  await client?.shutdown();
  client = undefined;
  clientCwd = undefined;
}
