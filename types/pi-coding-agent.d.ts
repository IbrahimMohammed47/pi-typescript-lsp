declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = {
    registerTool(tool: any): void;
    on(event: string, handler: (...args: any[]) => any): void;
  };

  export type ExtensionContext = {
    cwd: string;
  };
}
