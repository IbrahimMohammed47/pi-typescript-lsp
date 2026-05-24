import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function safeFileURLToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

export function resolveProjectPath(cwd: string, input: string): string {
  return isAbsolute(input) ? input : resolve(cwd, input);
}

export function relative(cwd: string, file: string): string {
  return file.startsWith(cwd) ? file.slice(cwd.length + 1) : file;
}

export function isTsJsSourceFile(file: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(file);
}
