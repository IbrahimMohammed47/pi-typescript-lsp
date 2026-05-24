# pi TypeScript LSP extension

TypeScript language-server tools designed for coding agents, not human editor UIs.

Traditional LSP APIs expose many small operations (`hover`, `definition`, `references`) at exact line/character positions. That shape works for humans because editors already know cursor position and render results interactively. Coding agents are different: they reason in files, symbols, tasks, and edits. Exact UTF-16 offsets and many tiny tools add distraction, token cost, and failure modes.

This extension therefore exposes a small set of high-level, intent-shaped tools:

- find or understand a symbol
- check TypeScript errors
- fix/import-organize safely
- rename safely

It keeps native filesystem tools (`read`, `edit`, `bash`/`rg`/`find`) useful for file discovery and text search, while using LSP only where semantic TypeScript knowledge matters.

## Installation

Install as a pi package from npm:

```bash
pi install npm:pi-typescript-lsp
```

Or install from GitHub:

```bash
pi install git:git@github.com:IbrahimMohammed47/pi-typescript-lsp.git
```

For manual development installs:

```bash
mkdir -p ~/.pi/agent/extensions
cd ~/.pi/agent/extensions
git clone git@github.com:IbrahimMohammed47/pi-typescript-lsp.git pi-typescript-lsp
cd pi-typescript-lsp
npm install
```

Pi auto-discovers extensions on startup. In a running pi session, reload after install/update:

```text
/reload
```

## Why this design

### Less tools beats many low-level tools

Agents receive tool descriptions in context. Too many tools increase choice noise and make models over-tool or pick wrong primitives. A small tool set is easier to learn and easier to steer.

### High-level tools beat line/character LSP calls

Raw LSP is cursor-oriented. Agents usually do not know exact line/character positions without reading files, counting offsets, and risking UTF-16 mistakes. Symbol/query targeting is more natural:

```json
{ "target": { "file": "src/auth.ts", "symbol": "getAccessToken" } }
```

instead of:

```json
{ "path": "src/auth.ts", "line": 42, "character": 17 }
```

### Use LSP for semantics, native tools for text

Use native tools for:

- finding files
- broad text search
- reading known code
- surgical edits
- config/docs/JSON/CSS

Use LSP tools for:

- symbol definitions and type info
- semantic references/usages
- implementations and call hierarchy
- TypeScript diagnostics and project typecheck
- missing-import fixes / organize imports
- safe cross-file rename

## Tools

### `ts_symbol_context`

Understand one known TypeScript/JavaScript symbol.

Default output is low-noise: hover/type info + definition. Request references, implementations, type definition, or call hierarchy only when needed. For TypeScript 5.9+, hover detail is automatically expanded when server says more detail is available.

Examples:

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" }
}
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

If multiple candidates are returned, retry with `selectIndex`.

### `ts_find_symbols`

Language-aware symbol search or file outline.

Use `query` when symbol name is known but file is unknown:

```json
{ "query": "SessionManager", "limit": 20 }
```

Use `file` to outline classes/functions/methods/exports in one file:

```json
{ "file": "src/router.ts" }
```

Not for filename or plain text search; use filesystem tools/`rg` for that.

### `ts_errors_check`

Check TypeScript errors. Pass `file` when checking a recent change or known problem file; omit it when no file is known.

```json
{ "file": "src/session.ts" }
```

```json
{ "maxErrors": 50 }
```

When `file` is provided, the extension first checks that file with LSP diagnostics. If the file has no errors, it runs project typecheck to catch downstream breakage. When `file` is omitted, it runs project typecheck directly.

Project typecheck uses `npm run typecheck` when present, otherwise bundled `typescript` via `tsc --noEmit --pretty false`. Output shows TypeScript errors only and is capped by `maxErrors` (default `20`).

### `ts_import_fix`

Fix imports in one TS/JS file using LSP code actions.

Auto-import for a diagnostic:

```json
{ "file": "src/session.ts", "diagnosticIndex": 0 }
```

Preview selected import fix:

```json
{ "file": "src/session.ts", "diagnosticIndex": 0, "applyIndex": 0 }
```

Apply selected import fix:

```json
{ "file": "src/session.ts", "diagnosticIndex": 0, "applyIndex": 0, "apply": true }
```

Organize imports by omitting `diagnosticIndex`:

```json
{ "file": "src/session.ts", "apply": true }
```

Previews by default; writes only with `apply: true`.

### `ts_rename`

Safely rename a symbol across files using TypeScript LSP.

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" },
  "newName": "readAccessToken"
}
```

Apply after preview/user intent:

```json
{
  "target": { "file": "src/auth.ts", "symbol": "getAccessToken" },
  "newName": "readAccessToken",
  "apply": true
}
```

Prefer this over manual search/replace for symbol renames.

## Automatic diagnostics after edits

After successful native `write` or `edit` calls on TS/JS source files, extension runs the same TypeScript check as `ts_errors_check` with the changed file.

That means it checks the edited file first, then runs project typecheck if the file itself is clean. This catches downstream errors caused by signature/type/export changes.

Automatic diagnostics are controlled by config.

## `/lsp` command and config

`/lsp` is read-only. It shows:

- current config values
- built-in defaults
- where current defaults came from
- descriptions for each option
- example override file

Project override file:

```text
.pi/typescript-lsp.json
```

Defaults are derived on session start from:

1. built-in defaults
2. current directory `tsconfig.json`, `jsconfig.json`, or `tsconfig.*.json` (`exclude` only)
3. project-local `node_modules/.bin/typescript-language-server` when found
4. `.pi/typescript-lsp.json` override, if present

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

Same example is available at `examples/typescript-lsp.json`.

### Config options

- `enabled` (`boolean`, default `true`)
  - Master switch for all TypeScript LSP tools and automatic diagnostics.

- `autoDiagnostics` (`boolean`, default `true`)
  - Append TypeScript diagnostics after successful native `write`/`edit` calls.

- `autoDiagnosticsWaitMs` (`number`, default `800`)
  - Wait time for edited-file LSP diagnostics before project typecheck fallback.

- `maxFileSizeBytes` (`number`, default `2097152`)
  - Maximum file size opened by LSP client. Prevents huge/generated files from hurting performance.

- `serverPath` (`string`, default `"auto"`)
  - `"auto"` uses bundled `typescript-language-server`. Relative or absolute path can override.

- `exclude` (`string[]`, default common build/vendor dirs plus `tsconfig`/`jsconfig` exclude)
  - Paths/globs ignored by extension file discovery and automatic diagnostics. Project override replaces current `exclude`.

## Dependencies

Uses local extension dependencies:

- `typescript-language-server`
- `typescript`

If dependencies vanish, reinstall:

```bash
cd ~/.pi/agent/extensions/pi-typescript-lsp
npm install
```

## Development checks

```bash
npm run typecheck
npm test
npm run pack:dry-run
```

## Operational notes

- Server starts lazily on first LSP tool call.
- Server root is current pi working directory.
- File paths can be absolute or relative to pi cwd.
- Documents are synced from disk before each symbol/file request.
- Files larger than `maxFileSizeBytes` are rejected before read.
- Extension shuts server down on pi session shutdown/reload with kill fallback.

## Known limitations

- Workspace symbol search depends on TypeScript server indexing/warmup; fallback scan opens likely source files.
- Project typecheck can be slow on large repositories.
- Huge/generated files are skipped by `maxFileSizeBytes`.
- JavaScript projects work best with `jsconfig.json`.
- Text search is intentionally out of scope; use `rg`/filesystem tools.

## License

MIT. See `LICENSE`.

## Good agent behavior

Good:

```text
Use ts_symbol_context for getAccessToken in src/auth.ts to understand type/definition.
```

```text
Use ts_symbol_context include.references=true to find semantic usages before changing behavior.
```

```text
Use ts_errors_check with changed file after TS edits to catch local and downstream errors.
```

Avoid:

```text
Use LSP to search all files containing "token".
```

Use `rg`/filesystem tools for broad text search instead.
