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

export async function evaluateScore(
  ctx: DialogueContext,
  feedbacks: { instructor: string; text: string }[],
): Promise<number> {
  const template = loadPrompt("teacher_score_evaluation.txt");
  const validScores = [0, 0.25, 0.5, 0.75, 1.0];

  const feedbackText = feedbacks
    .filter((f) => f.instructor !== "summary")
    .map((f) => `[${f.instructor}]\n${f.text}`)
    .join("\n\n");

  const systemPrompt = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{feedbacks}", feedbackText || "(none available)");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Score this student." },
  ];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await callLLM(messages, { sessionId: ctx.sessionId });
      const content = response.content.trim();

      const match = content.match(/\{"score":\s*([\d.]+)\}/);
      if (!match) throw new Error("No score JSON found");

      const score = parseFloat(match[1]);
      if (validScores.includes(score)) return score;
    } catch {
      if (attempt === 3) break;
      messages.push(
        { role: "assistant", content: "[INVALID]" },
        { role: "user", content: "FAILED: Must include {\"score\": <0.0|0.25|0.50|0.75|1.0>} in your response." },
      );
    }
  }

  return 0;
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
