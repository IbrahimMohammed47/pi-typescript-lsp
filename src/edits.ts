import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TypeScriptLspClient } from "./lsp-client";
import type { Json, LspPosition, LspRange } from "./shared-types";
import { formatWorkspaceEdit, jsonTextResult } from "./format";

export async function codeActionResult(
  client: TypeScriptLspClient,
  action: Json,
  cwd: string,
  apply: boolean,
  label: string,
) {
  if (action.edit) return workspaceEditResult(action.edit, cwd, apply);
  if (action.command && apply)
    return jsonTextResult(`Executed ${label} command.`, {
      result: await client.executeCommand(
        action.command.command || action.command,
        action.command.arguments,
      ),
    });
  return jsonTextResult(
    `Selected ${label} has no edit. Pass apply:true to execute command if present.`,
    { action },
  );
}

export function workspaceEditResult(edit: Json, cwd: string, apply: boolean) {
  const changes = workspaceEditChanges(edit);
  const summary = formatWorkspaceEdit(changes, cwd);
  if (apply) applyWorkspaceChanges(changes);
  return jsonTextResult(
    `${apply ? "Applied" : "Preview"} workspace edit\n${summary}`,
    {
      edit,
      applied: apply,
    },
  );
}

export function workspaceEditChanges(
  edit: Json,
): Array<{ uri: string; edits: Json[] }> {
  const out: Array<{ uri: string; edits: Json[] }> = [];
  for (const [uri, edits] of Object.entries(edit?.changes || {})) {
    out.push({ uri, edits: edits as Json[] });
  }
  for (const change of edit?.documentChanges || []) {
    if (change?.kind) continue;
    const uri = change?.textDocument?.uri;
    if (uri) out.push({ uri, edits: change.edits || [] });
  }
  return out;
}

export function applyWorkspaceChanges(changes: Array<{ uri: string; edits: Json[] }>) {
  for (const change of changes) {
    const file = fileURLToPath(change.uri);
    let text = readFileSync(file, "utf8");
    for (const edit of [...change.edits].sort(compareEditsDesc)) {
      text = applyTextEdit(text, edit);
    }
    writeFileSync(file, text);
  }
}

export function rangeForWholeFile(path: string): LspRange {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lines[lastLine]?.length || 0 },
  };
}

function compareEditsDesc(a: Json, b: Json): number {
  return (
    b.range.start.line - a.range.start.line ||
    b.range.start.character - a.range.start.character
  );
}

function applyTextEdit(text: string, edit: Json): string {
  const start = offsetAt(text, edit.range.start);
  const end = offsetAt(text, edit.range.end);
  return text.slice(0, start) + (edit.newText || "") + text.slice(end);
}

function offsetAt(text: string, pos: LspPosition): number {
  let offset = 0;
  let line = 0;
  while (line < pos.line) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
    line++;
  }
  return Math.min(text.length, offset + pos.character);
}
