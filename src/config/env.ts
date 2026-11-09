export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  MCP_PUBLIC_URL?: string;
  MCP_ALLOWED_ORIGINS?: string;
  RESEARCH_CACHE?: KVNamespace;
  MCP_AUTH_TOKEN: string;
  MCP_OWNER_ID: string;
  MCP_SCOPES?: string;
  GENERATION_MODE?: "client" | "server";
  MODEL_PROVIDER?: "openai" | "nvidia";
  NVIDIA_API_KEY?: string;
  NVIDIA_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  TAVILY_API_KEY?: string;
  ZERNIO_API_KEY?: string;
  ZERNIO_ACCOUNT_ID?: string;
  X_USERNAME?: string;
  DAILY_TOOL_LIMIT?: string;
}
export interface Identity {
  ownerId: string;
  scopes: Set<string>;
}
