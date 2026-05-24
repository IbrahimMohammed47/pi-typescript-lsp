import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Json = any;
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspPosition = { line: number; character: number };

type Pending = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
};

export class TypeScriptLspClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private opened = new Set<string>();
  private openedFiles = new Map<string, string>();
  private diagnostics = new Map<string, Json[]>();
  private initPromise?: Promise<void>;

  constructor(
    private cwd: string,
    private serverPath: string,
    private options: {
      maxFileSizeBytes: () => number;
      applyWorkspaceChanges: (changes: Array<{ uri: string; edits: Json[] }>) => void;
      workspaceEditChanges: (edit: Json) => Array<{ uri: string; edits: Json[] }>;
    },
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    this.proc = spawn(this.serverPath, ["--stdio"], {
      cwd: this.cwd,
      stdio: "pipe",
      env: { ...process.env },
    });

    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      console.error(`[typescript-lsp] ${chunk.toString().trimEnd()}`);
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(
        `typescript-language-server exited code=${code} signal=${signal}`,
      );
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.proc = undefined;
      this.initPromise = undefined;
      this.opened.clear();
      this.openedFiles.clear();
      this.diagnostics.clear();
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.cwd).toString(),
      workspaceFolders: [
        {
          uri: pathToFileURL(this.cwd).toString(),
          name: this.cwd.split(/[\\/]/).pop() || this.cwd,
        },
      ],
      capabilities: {
        textDocument: {
          definition: { linkSupport: false },
          declaration: { linkSupport: false },
          typeDefinition: { linkSupport: false },
          implementation: { linkSupport: false },
          references: {},
          rename: { prepareSupport: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ["quickfix", "source.organizeImports"] },
            },
          },
          callHierarchy: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { symbol: true, workspaceFolders: true },
      },
      initializationOptions: {
        hostInfo: "pi-typescript-lsp-extension",
        supportsHoverVerbosity: true,
      },
    });
    this.notify("initialized", {});
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try {
      await this.request("shutdown", {}, 3000);
    } catch {}
    try {
      this.notify("exit", {});
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
          resolve();
        }, 600).unref();
      }, 600);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async openDocument(filePath: string): Promise<string> {
    await this.ensureStarted();
    const size = statSync(filePath).size;
    if (size > this.options.maxFileSizeBytes())
      throw new Error(
        `File too large for TypeScript LSP (${size} bytes > ${this.options.maxFileSizeBytes()}): ${filePath}`,
      );
    const uri = pathToFileURL(filePath).toString();
    const text = readFileSync(filePath, "utf8");
    this.openedFiles.set(uri, filePath);
    if (!this.opened.has(uri)) {
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdFor(filePath),
          version: 1,
          text,
        },
      });
      this.opened.add(uri);
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  definition(uri: string, position: LspPosition) {
    return this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
  }

  references(uri: string, position: LspPosition, includeDeclaration: boolean) {
    return this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  rename(uri: string, position: LspPosition, newName: string) {
    return this.request("textDocument/rename", {
      textDocument: { uri },
      position,
      newName,
    });
  }

  codeActions(uri: string, range: LspRange, only?: string[]) {
    return this.request("textDocument/codeAction", {
      textDocument: { uri },
      range,
      context: { diagnostics: this.diagnostics.get(uri) || [], only },
    });
  }

  implementation(uri: string, position: LspPosition) {
    return this.request("textDocument/implementation", {
      textDocument: { uri },
      position,
    });
  }

  typeDefinition(uri: string, position: LspPosition) {
    return this.request("textDocument/typeDefinition", {
      textDocument: { uri },
      position,
    });
  }

  prepareCallHierarchy(uri: string, position: LspPosition) {
    return this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri },
      position,
    });
  }

  incomingCalls(item: Json) {
    return this.request("callHierarchy/incomingCalls", { item });
  }

  outgoingCalls(item: Json) {
    return this.request("callHierarchy/outgoingCalls", { item });
  }

  executeCommand(command: string, args?: Json[]) {
    return this.request("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  hover(uri: string, position: LspPosition, verbosityLevel?: number) {
    return this.request("textDocument/hover", {
      textDocument: { uri },
      position,
      ...(verbosityLevel === undefined ? {} : { verbosityLevel }),
    });
  }

  documentSymbols(uri: string) {
    return this.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  workspaceSymbols(query: string) {
    return this.request("workspace/symbol", { query });
  }

  async getDiagnostics(
    uri?: string,
    waitMs = 1200,
  ): Promise<Record<string, Json[]>> {
    await this.ensureStarted();
    await sleep(waitMs);
    if (uri) return { [uri]: this.diagnostics.get(uri) || [] };
    return Object.fromEntries(this.diagnostics.entries());
  }

  private request(
    method: string,
    params: Json,
    timeoutMs = 15000,
  ): Promise<Json> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private notify(method: string, params: Json) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: Json) {
    if (!this.proc)
      throw new Error("typescript-language-server is not running");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\n\r\n`,
      "ascii",
    );
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error(`Invalid LSP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(message: Json) {
    if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(
        message.params.uri,
        message.params.diagnostics || [],
      );
      return;
    }
    if (
      message.method === "workspace/configuration" &&
      message.id !== undefined
    ) {
      this.sendResponse(
        message.id,
        (message.params?.items || []).map((item: Json) =>
          this.configurationFor(item?.scopeUri, item?.section),
        ),
      );
      return;
    }
    if (
      message.method === "workspace/workspaceFolders" &&
      message.id !== undefined
    ) {
      const uri = pathToFileURL(this.cwd).toString();
      this.sendResponse(message.id, [
        { uri, name: this.cwd.split(/[\\/]/).pop() || this.cwd },
      ]);
      return;
    }
    if (
      [
        "client/registerCapability",
        "client/unregisterCapability",
        "window/workDoneProgress/create",
      ].includes(message.method) &&
      message.id !== undefined
    ) {
      this.sendResponse(message.id, null);
      return;
    }
    if (message.method === "workspace/applyEdit" && message.id !== undefined) {
      try {
        this.options.applyWorkspaceChanges(
          this.options.workspaceEditChanges(message.params?.edit),
        );
        this.sendResponse(message.id, { applied: true });
      } catch (error) {
        this.sendResponse(message.id, {
          applied: false,
          failureReason: String(error),
        });
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      else pending.resolve(message.result);
    }
  }

  private sendResponse(id: string | number, result: Json) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private configurationFor(scopeUri?: string, section?: string): Json {
    const file = scopeUri
      ? this.openedFiles.get(scopeUri) || safeFileURLToPath(scopeUri)
      : undefined;
    const formatting = inferFormattingOptions(file);
    if (section === "formattingOptions") return formatting;
    return {
      formattingOptions: formatting,
      typescript: { format: formatting },
      javascript: { format: formatting },
    };
  }
}

function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function inferFormattingOptions(file?: string): {
  tabSize: number;
  insertSpaces: boolean;
} {
  return (
    (file && inferFormattingFromEditorConfig(file)) ||
    (file && inferFormattingFromFile(file)) || {
      tabSize: 2,
      insertSpaces: true,
    }
  );
}

function inferFormattingFromEditorConfig(
  file: string,
): { tabSize: number; insertSpaces: boolean } | undefined {
  let dir = dirname(file);
  while (true) {
    const editorConfig = resolve(dir, ".editorconfig");
    if (existsSync(editorConfig)) {
      const parsed = parseEditorConfig(readFileSync(editorConfig, "utf8"));
      if (parsed) return parsed;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseEditorConfig(
  text: string,
): { tabSize: number; insertSpaces: boolean } | undefined {
  let indentStyle: string | undefined;
  let indentSize: string | undefined;
  let tabWidth: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "indent_style") indentStyle = match[2];
    if (key === "indent_size") indentSize = match[2];
    if (key === "tab_width") tabWidth = match[2];
  }
  if (!indentStyle && !indentSize && !tabWidth) return undefined;
  const insertSpaces = indentStyle !== "tab";
  const size = Number(indentSize === "tab" ? tabWidth : indentSize || tabWidth);
  return {
    tabSize: Number.isFinite(size) && size > 0 ? size : 2,
    insertSpaces,
  };
}

function inferFormattingFromFile(
  file: string,
): { tabSize: number; insertSpaces: boolean } | undefined {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).slice(0, 200);
    let tabs = 0;
    const spaces: Record<number, number> = {};
    for (const line of lines) {
      const match = /^(\s+)\S/.exec(line);
      if (!match) continue;
      const indent = match[1];
      if (indent.includes("\t")) tabs++;
      const spaceCount = indent.match(/^ +/)?.[0]?.length || 0;
      if (spaceCount > 0 && spaceCount <= 8)
        spaces[spaceCount] = (spaces[spaceCount] || 0) + 1;
    }
    if (tabs > 0 && tabs >= Object.values(spaces).reduce((a, b) => a + b, 0))
      return { tabSize: 2, insertSpaces: false };
    const best = Object.entries(spaces).sort((a, b) => b[1] - a[1])[0];
    return best ? { tabSize: Number(best[0]), insertSpaces: true } : undefined;
  } catch {
    return undefined;
  }
}

function languageIdFor(file: string): string {
  if (file.endsWith(".tsx")) return "typescriptreact";
  if (file.endsWith(".jsx")) return "javascriptreact";
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return "javascript";
  return "typescript";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
