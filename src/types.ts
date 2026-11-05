export interface RouterConfig {
  host: string;
  port: number;
  routerApiKey: string;
  userToken: string;
  bearerToken: string;
  rawCookie: string;
  baseUrl: string;
  models: string[];
  thinkingEnabled: boolean;
  requestTimeoutMs: number;
  maxBodyBytes: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: unknown;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
}

export interface OpenAIResponsesRequest {
  model?: string;
  input?: unknown;
  stream?: boolean;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  tools?: unknown;
  tool_choice?: unknown;
}

export type Json = Record<string, unknown>;
