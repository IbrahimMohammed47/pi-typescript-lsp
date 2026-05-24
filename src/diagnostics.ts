import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Json } from "./shared-types";
import { getClient } from "./client";
import { formatDiagnostics, isErrorDiagnostic } from "./format";

export const MAX_FORMATTED_DIAGNOSTIC_ERRORS = 20;
const PROJECT_TYPECHECK_TIMEOUT_MS = 30_000;

export async function runTypeScriptCheck(
  ctx: ExtensionContext,
  serverPath: string,
  typescriptBinPath: string,
  file: string | undefined,
  waitMs: number,
  maxErrors = MAX_FORMATTED_DIAGNOSTIC_ERRORS,
): Promise<string> {
  if (file) {
    const c = await getClient(ctx, serverPath);
    const uri = await c.openDocument(file);
    const diagnostics = await c.getDiagnostics(uri, waitMs);
    if (countErrorDiagnostics(diagnostics) > 0)
      return formatDiagnostics(diagnostics, ctx.cwd, maxErrors);
  }

  const command = projectTypecheckCommand(ctx.cwd, typescriptBinPath);
  const result = await runCommand(command.command, command.args, ctx.cwd);
  const projectSummary = formatProjectTypecheckOutput(result, command.display, maxErrors);
  if (file && projectSummary === "No TypeScript errors reported.")
    return "No TypeScript errors reported.";
  return projectSummary;
}

function countErrorDiagnostics(diagnostics: Record<string, Json[]>): number {
  let count = 0;
  for (const items of Object.values(diagnostics)) {
    for (const item of items) if (isErrorDiagnostic(item)) count++;
  }
  return count;
}

function projectTypecheckCommand(
  cwd: string,
  typescriptBinPath: string,
): { command: string; args: string[]; display: string } {
  if (hasTypecheckScript(cwd))
    return {
      command: "npm",
      args: ["run", "typecheck"],
      display: "npm run typecheck",
    };
  return {
    command: process.execPath,
    args: [typescriptBinPath, "--noEmit", "--pretty", "false"],
    display: "tsc --noEmit --pretty false",
  };
}

function hasTypecheckScript(cwd: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
    return typeof pkg?.scripts?.typecheck === "string";
  } catch {
    return false;
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: "pipe", env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }, PROJECT_TYPECHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

function formatProjectTypecheckOutput(
  result: { code: number | null; stdout: string; stderr: string; timedOut: boolean },
  command: string,
  maxErrors: number,
): string {
  const text = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const errorLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\berror TS\d+\b/.test(line));

  if (!errorLines.length) {
    if (result.timedOut) return `Project typecheck timed out after ${PROJECT_TYPECHECK_TIMEOUT_MS}ms: ${command}`;
    if (result.code === 0) return "No TypeScript errors reported.";
    const fallback = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxErrors);
    return [`Project typecheck failed (${command}) but no TS error lines were found.`, ...fallback].join("\n");
  }

  const shown = errorLines.slice(0, maxErrors);
  if (errorLines.length > shown.length)
    shown.push(`... ${errorLines.length - shown.length} more TypeScript error(s) hidden (limit ${maxErrors}).`);
  if (result.timedOut)
    shown.push(`Project typecheck timed out after ${PROJECT_TYPECHECK_TIMEOUT_MS}ms; results may be incomplete.`);
  return shown.join("\n");
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
