# pi TypeScript LSP extension

High-level TypeScript language-server tools for coding agents.

Agents usually work with files, symbols, tasks, and edits—not editor cursor offsets. This extension wraps TypeScript LSP features into a small tool set for semantic code work:

- find/understand symbols
- check TypeScript errors
- fix or organize imports
- rename symbols safely

Use normal filesystem tools (`read`, `edit`, `bash`/`rg`/`find`) for file discovery, text search, docs, config, and surgical edits. Use LSP tools when TypeScript semantics matter.

## Installation

From npm:

```bash
pi install npm:pi-typescript-lsp
```

From GitHub:

```bash
pi install git:git@github.com:IbrahimMohammed47/pi-typescript-lsp.git
```

Manual development install:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone git@github.com:IbrahimMohammed47/pi-typescript-lsp.git pi-typescript-lsp
cd pi-typescript-lsp
npm install
```

Reload running pi session after install/update:

```text
/reload
```

## Tools

### `ts_symbol_context`

Understand known TS/JS symbol. Defaults to hover/type info + definition. Add references, implementations, type definition, or call hierarchy only when needed.

```json
{ "target": { "file": "src/auth.ts", "symbol": "getAccessToken" } }
```

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" },
  "include": { "references": true, "hover": false, "definition": false }
}
```

```json
{
  "target": { "query": "CacheStore" },
  "include": { "implementation": true }
}
```

If multiple candidates return, retry with `selectIndex`.

### `ts_find_symbols`

Language-aware symbol search or file outline.

```json
{ "query": "SessionManager", "limit": 20 }
```

```json
{ "file": "src/router.ts" }
```

Not for filename or plain text search; use `rg`/filesystem tools.

### `ts_errors_check`

Check TypeScript errors. Pass `file` for recent/known changes; omit for project check.

```json
{ "file": "src/session.ts" }
```

```json
{ "maxErrors": 50 }
```

With `file`, extension checks file diagnostics first, then project typecheck if file is clean. Project check uses `npm run typecheck` when available, otherwise bundled `tsc --noEmit --pretty false`. Output is capped by `maxErrors` (default `20`).

### `ts_import_fix`

Fix imports in one TS/JS file via LSP code actions.

```json
{ "file": "src/session.ts", "diagnosticIndex": 0 }
```

```json
{ "file": "src/session.ts", "diagnosticIndex": 0, "applyIndex": 0 }
```

```json
{ "file": "src/session.ts", "diagnosticIndex": 0, "applyIndex": 0, "apply": true }
```

Organize imports by omitting `diagnosticIndex`:

```json
{ "file": "src/session.ts", "apply": true }
```

Previews by default; writes only with `apply: true`.

### `ts_rename`

Safely rename symbol across files.

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" },
  "newName": "readAccessToken"
}
```

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" },
  "newName": "readAccessToken",
  "apply": true
}
```

Prefer over manual search/replace for symbol renames.

## Automatic diagnostics

After successful native `write` or `edit` calls on TS/JS source files, extension can run same checks as `ts_errors_check`: edited file first, then project typecheck if clean.

Controlled by config.

## `/lsp` command and config

`/lsp` is read-only. It shows current config, defaults, option docs, default sources, and example override file.

Project override file:

```text
.pi/typescript-lsp.json
```

Defaults come from:

1. built-ins
2. nearest `tsconfig.json`, `jsconfig.json`, or `tsconfig.*.json` (`exclude` only)
3. project-local `node_modules/.bin/typescript-language-server`, when found
4. `.pi/typescript-lsp.json`, when present

Example:

```json
{
  "enabled": true,
  "autoDiagnostics": true,
  "autoDiagnosticsWaitMs": 800,
  "maxFileSizeBytes": 2097152,
  "serverPath": "auto",
  "exclude": ["node_modules", "dist", "build", "coverage"]
}
```

Same example: `examples/typescript-lsp.json`.

### Config options

- `enabled` (`boolean`, default `true`): master switch for tools and automatic diagnostics.
- `autoDiagnostics` (`boolean`, default `true`): append diagnostics after successful native `write`/`edit` calls.
- `autoDiagnosticsWaitMs` (`number`, default `800`): wait time before project typecheck fallback.
- `maxFileSizeBytes` (`number`, default `2097152`): max file size opened by LSP client.
- `serverPath` (`string`, default `"auto"`): bundled server by default; relative/absolute override allowed.
- `exclude` (`string[]`): ignored paths/globs for discovery and automatic diagnostics. Override replaces current `exclude`.

## Development

Dependencies:

- `typescript-language-server`
- `typescript`

Reinstall if needed:

```bash
cd ~/.pi/agent/extensions/pi-typescript-lsp
npm install
```

Checks:

```bash
npm run typecheck
npm test
npm run pack:dry-run
```

## Notes and limitations

- Server starts lazily on first LSP tool call.
- Server root is current pi working directory.
- File paths can be absolute or relative to pi cwd.
- Documents sync from disk before symbol/file requests.
- Files larger than `maxFileSizeBytes` are rejected.
- Server shuts down on pi session shutdown/reload, with kill fallback.
- Workspace symbol search depends on TypeScript server indexing/warmup; fallback scan opens likely source files.
- Project typecheck can be slow on large repositories.
- JavaScript projects work best with `jsconfig.json`.
- Text search is intentionally out of scope; use `rg`/filesystem tools.

## Good agent behavior

Good:

```text
Use ts_symbol_context for getAccessToken in src/auth.ts to understand type/definition.
Use ts_symbol_context include.references=true to find semantic usages before changing behavior.
Use ts_errors_check with changed file after TS edits to catch local and downstream errors.
```

Avoid:

```text
Use LSP to search all files containing "token".
```

Use `rg`/filesystem tools for broad text search.

## License

MIT. See `LICENSE`.
