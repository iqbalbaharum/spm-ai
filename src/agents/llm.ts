import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { config } from "../config.js";
import type { ChatMessage, LLMResponse, LLMOptions, TeacherResponse } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = join(__dirname, "../../.stage/llm");
mkdirSync(logDir, { recursive: true });

const client = new OpenAI({
  baseURL: config.openrouterBaseUrl,
  apiKey: config.openrouterApiKey,
});

function truncateDeep(val: unknown, maxLen: number): unknown {
  if (typeof val === "string" && val.length > maxLen) {
    return val.slice(0, maxLen) + `... [truncated, total ${val.length} chars]`;
  }
  if (Array.isArray(val)) {
    return val.map((v) => truncateDeep(v, maxLen));
  }
  if (val && typeof val === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      obj[k] = truncateDeep(v, maxLen);
    }
    return obj;
  }
  return val;
}

export function logEvent(
  sessionId: string | undefined,
  direction: "in" | "out" | "ctx",
  data: Record<string, unknown>
): void {
  if (config.logLlm === "off" || !sessionId) return;

  let payload: Record<string, unknown> = {
    t: new Date().toISOString(),
    d: direction,
    ...data,
  };

  if (config.logLlm === "truncated") {
    payload = truncateDeep(payload, 500) as Record<string, unknown>;
  }

  try {
    appendFileSync(join(logDir, `${sessionId}.jsonl`), JSON.stringify(payload) + "\n", "utf-8");
  } catch (e) {
    console.error("LLM log write failed:", e);
  }
}

export async function callLLM(
  messages: ChatMessage[],
  options?: LLMOptions
): Promise<LLMResponse> {
  logEvent(options?.sessionId, "in", { messages });

  const resp = await client.chat.completions.create({
    model: options?.model || config.openrouterModel,
    messages,
    max_tokens: options?.maxTokens ?? 1024,
  });

  const content = resp.choices[0]?.message?.content?.trim() || "";

  const usage = resp.usage
    ? { prompt_tokens: resp.usage.prompt_tokens, completion_tokens: resp.usage.completion_tokens }
    : undefined;

  logEvent(options?.sessionId, "out", { content, usage });

  const dialogueComplete =
    (content.includes("DIALOGUE_COMPLETE: true") ||
     content.includes("DIALOGUE_COMPLETE:true")) &&
    !content.includes("?");

  const cleaned = content
    .replace(/DIALOGUE_COMPLETE:\s*true/g, "")
    .trim();

  return { content: cleaned, dialogueComplete };
}

export async function callLLMStructured<T>(
  messages: ChatMessage[],
  options?: LLMOptions
): Promise<T> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logEvent(options?.sessionId, "in", { attempt, messages });

      const resp = await client.chat.completions.create({
        model: options?.model || config.openrouterModel,
        messages,
        max_tokens: 2048,
        response_format: { type: "json_object" },
      });

      let content = resp.choices[0]?.message?.content?.trim() || "";

      content = content
        .replace(/^```(?:json)?\s*\n?/m, "")
        .replace(/\n?```\s*$/m, "")
        .trim();

      const usage = resp.usage
        ? { prompt_tokens: resp.usage.prompt_tokens, completion_tokens: resp.usage.completion_tokens }
        : undefined;

      logEvent(options?.sessionId, "out", { content, usage });

      return JSON.parse(content) as T;
    } catch (err) {
      if (attempt === maxAttempts) throw err;

      await new Promise(r => setTimeout(r, 200));

      const detail = err instanceof SyntaxError
        ? `JSON parse error: ${err.message}`
        : `Error: ${err instanceof Error ? err.message : String(err)}`;

      messages = [
        ...messages,
        { role: "assistant", content: "[Response format was invalid]" },
        { role: "user", content: `Your previous response could not be parsed. ${detail} Please respond with ONLY a valid JSON object with the required fields. Do NOT include markdown code fences.` },
      ];
    }
  }

  throw new Error("callLLMStructured exhausted retries");
}

export function asTeacherResponse(raw: unknown): TeacherResponse {
  if (raw && typeof raw === "object") {
    const msg = (raw as Record<string, unknown>).message;
    const cleaned = typeof msg === "string" && msg.length > 0
      ? msg.replace(/[*_`\[]/g, "")
      : "Terima kasih. Sila teruskan pembelajaran.";
    return { message: cleaned };
  }
  return { message: "Terima kasih. Sesi diteruskan." };
}
