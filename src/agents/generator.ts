import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLMStructured } from "./llm.js";
import type { ChatMessage, GeneratorInput, MCQ } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptTemplate = readFileSync(
  join(__dirname, "../../prompts/generate_quiz.txt"),
  "utf-8"
);

interface RawMCQ {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  keyword?: string;
}

export async function generateMCQ(input: GeneratorInput): Promise<MCQ> {
  const systemPrompt = promptTemplate
    .replace("{subjectInstructions}", input.subjectInstructions)
    .replace("{topicName}", input.topicName)
    .replace("{topicText}", input.topicText)
    .replace(
      "{examQuestions}",
      input.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    );

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Generate 1 MCQ in JSON format." },
  ];

  const raw = await callLLMStructured<RawMCQ>(messages, {
    sessionId: input.sessionId,
  });

  let keyword = raw.keyword?.trim() || "";

  if (!isValidKeyword(keyword, input.topicText)) {
    keyword = await retryKeyword(input.topicText, input.sessionId);
  }

  if (!isValidKeyword(keyword, input.topicText)) {
    keyword = extractKeyword(input.topicText);
  }

  return {
    question: raw.question,
    options: raw.options as [string, string, string, string],
    correctAnswer: raw.correctAnswer as "A" | "B" | "C" | "D",
    explanation: raw.explanation,
    keyword,
  };
}

function isValidKeyword(keyword: string, topicText: string): boolean {
  const kw = keyword.trim();
  if (!kw || kw.length < 3 || !isNaN(Number(kw))) return false;
  return topicText.toLowerCase().includes(kw.toLowerCase());
}

async function retryKeyword(
  topicText: string,
  sessionId?: string
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are an SPM examiner. Extract ONE meaningful keyword (proper noun, event, treaty, concept) from the topic content below. Return JSON: {\"keyword\": \"...\"}",
    },
    { role: "user", content: topicText },
  ];

  try {
    const result = await callLLMStructured<{ keyword: string }>(messages, {
      sessionId,
    });
    return result.keyword?.trim() || "";
  } catch {
    return "";
  }
}

function extractKeyword(text: string): string {
  const stopWords = new Set([
    "apakah", "mengapakah", "bagaimanakah", "kenapakah",
    "berikan", "jelaskan", "nyatakan", "senaraikan",
    "a", "an", "the", "yang", "dan", "atau", "ini", "itu",
    "pada", "dan", "dengan", "untuk", "dalam", "adalah", "bahawa",
    "selepas", "sebelum", "ketika", "serta", "mereka", "saya", "anda",
  ]);
  const words = text.replace(/[?.,;:!()"']/g, "").split(/\s+/);
  const candidates = words.filter(
    (w) => !stopWords.has(w.toLowerCase()) && w.length > 3 && isNaN(Number(w))
  );
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || words[words.length - 1] || "topic";
}
