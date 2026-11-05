export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function openAIError(status: number, message: string, code: string): {
  status: number;
  body: Record<string, unknown>;
} {
  return {
    status,
    body: {
      error: {
        message,
        type: "invalid_request_error",
        code,
      },
    },
  };
}
