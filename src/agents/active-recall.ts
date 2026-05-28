import { callLLMStructured } from "./llm.js";
import type { ChatMessage, LLMOptions, ActiveRecallResponse } from "../types.js";

const MAX_ATTEMPTS = 3;

export async function callActiveRecallWithRetry(
  messages: ChatMessage[],
  options?: LLMOptions,
): Promise<ActiveRecallResponse> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let result: ActiveRecallResponse | null = null;
    try {
      result = await callLLMStructured<ActiveRecallResponse>(messages, options);
      if (isValidActiveRecall(result)) return result;
    } catch {
      // callLLMStructured exhausted its own retries
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new Error("Active recall LLM failed to return valid response after 3 attempts");
    }

    messages.push(
      { role: "assistant", content: result ? JSON.stringify(result) : "[Response format was invalid]" },
      { role: "user", content: "Format tidak sah. Balas dengan JSON object yang mempunyai \"message\" (string) dan \"complete\" (boolean). Jangan gunakan array." },
    );
  }

  throw new Error("Active recall LLM failed to return valid response after 3 attempts");
}

function isValidActiveRecall(v: unknown): v is ActiveRecallResponse {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as ActiveRecallResponse).message === "string" &&
    typeof (v as ActiveRecallResponse).complete === "boolean"
  );
}
