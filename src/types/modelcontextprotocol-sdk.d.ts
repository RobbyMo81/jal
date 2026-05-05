// src/types/modelcontextprotocol-sdk.d.ts
declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export class McpServer {
    constructor(options: { name: string; version: string });
    tool(
      name: string,
      description: string,
      schemaOrHandler: any,
      handlerIfSchema?: (...args: any[]) => Promise<any>,
    ): void;
    connect(transport: any): Promise<void>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor();
    connect(): Promise<void>;
  }
}
