import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLM, callLLMStructured } from "./llm.js";
import type { ChatMessage, DialogueContext, ActiveRecallResponse } from "../types.js";
import { isMcq } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptDir = join(__dirname, "../../prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(promptDir, name), "utf-8");
}

function getKeyword(ctx: DialogueContext): string {
  return "keyword" in ctx.question ? ctx.question.keyword : "";
}

export function buildActiveRecallPrompt(ctx: DialogueContext): string {
  const template = loadPrompt("teacher_active_recall.txt");
  const q = ctx.question;

  let result = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{topicText}", ctx.topicText)
    .replace("{question}", q.question)
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{keyword}", getKeyword(ctx))
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((x) => `- ${x}`).join("\n") || "(none available)"
    );

  if (isMcq(q)) {
    result = result
      .replace("{correctAnswer}", q.correctAnswer)
      .replace("{explanation}", q.explanation);
  } else {
    result = result
      .replace("{correctAnswer}", "N/A")
      .replace("{explanation}", q.markingScheme);
  }

  return result;
}

export async function passiveFeedback(
  teacher: "recap" | "kbat",
  ctx: DialogueContext
): Promise<string> {
  const promptName = teacher === "recap" ? "teacher_recap_passive.txt" : "teacher_kbat_passive.txt";
  const template = loadPrompt(promptName);

  const q = ctx.question;
  const isCorrect = isMcq(q) && q.correctAnswer?.toUpperCase() === ctx.studentAnswer?.toUpperCase();

  let result = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{keyword}", getKeyword(ctx))
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{isCorrect}", isCorrect ? "benar" : "tidak tepat")
    .replace("{topicText}", ctx.topicText)
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((x) => `- ${x}`).join("\n") || "(none available)"
    );

  if (isMcq(q)) {
    result = result
      .replace("{correctAnswer}", q.correctAnswer)
      .replace("{explanation}", q.explanation);
  }

  const response = await callLLM(
    [
      { role: "system", content: result },
      { role: "user", content: "Provide feedback." },
    ],
    { sessionId: ctx.sessionId }
  );

  return response.content;
}

interface ProperNounsItem {
  term: string;
  description: string;
}

export async function extractProperNouns(
  ctx: DialogueContext
): Promise<string> {
  const template = loadPrompt("teacher_propernouns_passive.txt");

  const filled = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topicText}", ctx.topicText);

  try {
    const result = await callLLMStructured<{ items: ProperNounsItem[] }>(
      [
        { role: "system", content: filled },
        { role: "user", content: "Extract proper nouns." },
      ],
      { sessionId: ctx.sessionId }
    );

    const validItems = (result.items || []).filter(
      (item) =>
        item &&
        typeof item.term === "string" &&
        item.term.trim().length > 0 &&
        typeof item.description === "string" &&
        item.description.trim().length > 0 &&
        item.description.trim() !== "undefined"
    );

    if (validItems.length === 0) return "";

    return validItems
      .map((item) => `• ${item.term.trim()} — ${item.description.trim()}`)
      .join("\n");
  } catch {
    return "";
  }
}

export async function generateRecapSummary(
  ctx: DialogueContext
): Promise<string> {
  const q = ctx.question;
  if (isMcq(q)) {
    return `Konsep utama ialah "${q.keyword}". ${q.explanation}`;
  }
  return "Session completed.";
}

export async function evaluateSubjectiveAnswer(
  ctx: DialogueContext
): Promise<{ score: number; maxScore: number; feedback: string }> {
  const q = ctx.question;
  if (isMcq(q)) {
    return { score: 0, maxScore: 0, feedback: "" };
  }

  const evalPrompt = `{subjectInstructions}

You are an SPM examiner. Evaluate the student's essay against the marking scheme.

Question: "${q.question}"
Marking Scheme: "${q.markingScheme}"
Topic Content: "${ctx.topicText}"

Student's Essay: "${ctx.studentAnswer}"

Evaluate the essay based on the marking scheme. Return JSON:
{
  "score": <number>,
  "maxScore": <number>,
  "feedback": "Brief evaluation notes explaining what the student did well or missed"
}

Valid JSON only. No markdown fences.`;

  const result = await callLLMStructured<{ score: number; maxScore: number; feedback: string }>(
    [
      { role: "system", content: evalPrompt.replace("{subjectInstructions}", ctx.subjectInstructions) },
      { role: "user", content: "Evaluate this essay." },
    ],
    { sessionId: ctx.sessionId }
  );

  return {
    score: result.score,
    maxScore: result.maxScore,
    feedback: result.feedback,
  };
}
