/** Serializable WebMCP types exposed by the CLI/library bridge. */

export interface WebMCPToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMCPToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  origin?: string;
  annotations?: WebMCPToolAnnotations;
}

export interface WebMCPStatus {
  available: boolean;
  url: string;
  secureContext: boolean;
  originAgentCluster: boolean | null;
  crossOriginIsolated: boolean;
  toolsPolicy: boolean | null;
  reason?: string;
}

export interface WebMCPListResult {
  status: WebMCPStatus;
  tools: WebMCPToolDescriptor[];
}
