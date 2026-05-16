import type { AgentTurnChatMessage } from "./runtime/contract.js";

export interface ValidatedChatCompletionRequest {
  model: string;
  messages: AgentTurnChatMessage[];
  stream: true;
}

export type ValidationFailure = {
  status: number;
  body: {
    error: {
      message: string;
      type: string;
      param?: string;
      code?: string;
    };
  };
};

export type ValidationResult =
  | { ok: true; value: ValidatedChatCompletionRequest }
  | { ok: false; failure: ValidationFailure };

export function validateChatCompletionRequest(
  raw: unknown,
  opts?: { defaultModel?: string },
): ValidationResult {
  const defaultModel = opts?.defaultModel ?? "wekruit-prescreen-v1";

  if (raw === null || typeof raw !== "object") {
    return failure(400, "Request body must be a JSON object.", "invalid_request_error");
  }
  const r = raw as Record<string, unknown>;

  if (r.stream !== true) {
    return failure(
      400,
      "stream=true required",
      "invalid_request_error",
      "stream",
      "unsupported_param",
    );
  }

  if (!Array.isArray(r.messages) || r.messages.length === 0) {
    return failure(
      400,
      "messages must be a non-empty array.",
      "invalid_request_error",
      "messages",
    );
  }

  const messages: AgentTurnChatMessage[] = [];
  for (let i = 0; i < r.messages.length; i += 1) {
    const m = r.messages[i];
    if (m === null || typeof m !== "object") {
      return failure(
        400,
        `messages[${i}] must be an object.`,
        "invalid_request_error",
        `messages[${i}]`,
      );
    }
    const mm = m as Record<string, unknown>;
    if (typeof mm.role !== "string" || mm.role.length === 0) {
      return failure(
        400,
        `messages[${i}].role must be a non-empty string.`,
        "invalid_request_error",
        `messages[${i}].role`,
      );
    }
    // OpenAI allows `content` to be string | array (for vision). We only
    // support string in v2.1 (voice path passes plain text).
    const content = typeof mm.content === "string" ? mm.content : "";
    messages.push({ role: mm.role, content });
  }

  const model = typeof r.model === "string" && r.model.length > 0 ? r.model : defaultModel;

  return { ok: true, value: { model, messages, stream: true } };
}

function failure(
  status: number,
  message: string,
  type: string,
  param?: string,
  code?: string,
): ValidationResult {
  return {
    ok: false,
    failure: {
      status,
      body: { error: { message, type, param, code } },
    },
  };
}
