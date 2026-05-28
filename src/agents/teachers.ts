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

function stripYamlFrontmatter(text: string): string {
  return text.replace(/^---[\s\S]*?---\n*/, "");
}

function stripWikiLinks(text: string): string {
  return text.replace(/\[\[[^\]]+\]\]/g, "");
}

function stripExamWrappers(text: string): string {
  return text
    .replace(/:::subjective_part\s*\{[^}]*\}\s*/g, "")
    .replace(/^:::\s*$/gm, "");
}

function cleanTopicText(text: string): string {
  return stripWikiLinks(stripYamlFrontmatter(text));
}

function getKeyword(ctx: DialogueContext): string {
  return "keyword" in ctx.question ? ctx.question.keyword : "";
}

function buildMessagesWithConversation(
  systemPrompt: string,
  conversation: { role: string; content: string }[],
  userMessage: string
): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...conversation
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as ChatMessage["role"], content: m.content })),
    { role: "user", content: userMessage },
  ];
}

export function buildActiveRecallPrompt(ctx: DialogueContext): string {
  const template = loadPrompt("teacher_active_recall.txt");
  const q = ctx.question;

  let result = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{topicText}", cleanTopicText(ctx.topicText))
    .replace("{question}", q.question)
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{keyword}", getKeyword(ctx))
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((x) => `- ${stripExamWrappers(x)}`).join("\n") || "(none available)"
    );

  if (isMcq(q)) {
    result = result.replace("{correctAnswer}", q.correctAnswer);
  } else {
    result = result.replace("{correctAnswer}", "N/A");
  }

  return result;
}

export async function recapFeedback(
  ctx: DialogueContext,
  conversation: { role: string; content: string }[]
): Promise<string> {
  const template = loadPrompt("teacher_recap_passive.txt");

  const systemPrompt = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{keyword}", getKeyword(ctx))
    .replace("{topicText}", cleanTopicText(ctx.topicText));

  const messages = buildMessagesWithConversation(systemPrompt, conversation, "Provide feedback.");

  const response = await callLLM(messages, { sessionId: ctx.sessionId });
  return response.content;
}

export async function extractProperNouns(
  ctx: DialogueContext,
  conversation: { role: string; content: string }[]
): Promise<string> {
  const template = loadPrompt("teacher_propernouns_passive.txt");

  const systemPrompt = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{question}", ctx.question.question)
    .replace("{correctAnswer}", isMcq(ctx.question) ? ctx.question.correctAnswer : "N/A")
    .replace("{keyword}", getKeyword(ctx))
    .replace("{topicText}", cleanTopicText(ctx.topicText));

  const messages = buildMessagesWithConversation(systemPrompt, conversation, "Evaluate the student's use of proper nouns.");

  try {
    const response = await callLLM(messages, { sessionId: ctx.sessionId });
    return response.content;
  } catch {
    return "";
  }
}

export async function generateRecapSummary(
  ctx: DialogueContext,
  conversation: { role: string; content: string }[]
): Promise<string> {
  const template = loadPrompt("teacher_summary_passive.txt");

  const systemPrompt = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{question}", ctx.question.question)
    .replace("{correctAnswer}", isMcq(ctx.question) ? ctx.question.correctAnswer : "N/A")
    .replace("{keyword}", getKeyword(ctx))
    .replace("{topicText}", cleanTopicText(ctx.topicText));

  const messages = buildMessagesWithConversation(systemPrompt, conversation, "Summarize the student's performance.");

  const response = await callLLM(messages, { sessionId: ctx.sessionId });
  return response.content;
}

export async function analyzeKnowledgeGaps(
  ctx: DialogueContext,
  conversation: { role: string; content: string }[]
): Promise<string> {
  const template = loadPrompt("teacher_gap_analysis.txt");

  const systemPrompt = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{question}", ctx.question.question)
    .replace("{correctAnswer}", isMcq(ctx.question) ? ctx.question.correctAnswer : "N/A")
    .replace("{keyword}", getKeyword(ctx))
    .replace("{topicText}", cleanTopicText(ctx.topicText));

  const messages = buildMessagesWithConversation(systemPrompt, conversation, "Analyze the student's knowledge gaps.");

  try {
    const response = await callLLM(messages, { sessionId: ctx.sessionId });
    return response.content;
  } catch {
    return "";
  }
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
Topic Content: "${cleanTopicText(ctx.topicText)}"

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
