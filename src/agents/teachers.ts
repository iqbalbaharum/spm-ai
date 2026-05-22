import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLM } from "./llm.js";
import { config } from "../config.js";
import type {
  ChatMessage,
  DialogueContext,
  PassiveFeedback,
  LLMResponse,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptDir = join(__dirname, "../../prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(promptDir, name), "utf-8");
}

const feynmanPrompt = loadPrompt("teacher_feynman_active.txt");
const strictPrompt = loadPrompt("teacher_strict_active.txt");
const recapPrompt = loadPrompt("teacher_recap_passive.txt");
const kbatPrompt = loadPrompt("teacher_kbat_passive.txt");

export async function activeDialogue(
  teacher: "feynman" | "strict",
  ctx: DialogueContext,
  getUserInput: () => Promise<string>
): Promise<ChatMessage[]> {
  const systemPrompt =
    teacher === "feynman"
      ? buildFeynmanPrompt(ctx)
      : buildStrictPrompt(ctx);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: teacher === "feynman"
      ? `The student answered correctly. Engage them on the keyword "${ctx.mcq.keyword}".`
      : `The student answered "${ctx.studentAnswer}" (wrong). The correct answer is "${ctx.mcq.correctAnswer}". Engage them.`
    },
  ];

  let rounds = 0;

  while (rounds < config.maxActiveRounds) {
    const response = await callLLM(messages, {
      sessionId: ctx.sessionId,
    });
    messages.push({ role: "assistant", content: response.content });

    console.log(`\n  [${teacher === "feynman" ? "Feynman" : "Strict"}]: ${response.content}\n`);

    if (response.dialogueComplete) break;

    const userInput = await getUserInput();
    if (userInput.toLowerCase() === "/done") break;

    messages.push({ role: "user", content: userInput });
    rounds++;
  }

  return messages;
}

export async function passiveFeedback(
  teacher: "recap" | "kbat",
  ctx: DialogueContext
): Promise<string> {
  const prompt =
    teacher === "recap" ? recapPrompt : kbatPrompt;

  const filled = prompt
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{keyword}", ctx.mcq.keyword)
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{isCorrect}", ctx.correct ? "yes" : "no")
    .replace("{correctAnswer}", ctx.mcq.correctAnswer)
    .replace("{explanation}", ctx.mcq.explanation)
    .replace("{topicText}", ctx.topicText)
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    );

  const response = await callLLM(
    [
      { role: "system", content: filled },
      { role: "user", content: "Provide feedback." },
    ],
    { sessionId: ctx.sessionId }
  );

  return response.content;
}

export async function passiveSummaries(
  activeTeacher: "feynman" | "strict",
  ctx: DialogueContext
): Promise<{ strict: string; feynman: string }> {
  const [strict, feynman] = await Promise.all([
    activeTeacher === "strict"
      ? Promise.resolve(generateStrictSummary(ctx))
      : generateOppositeSummary("strict", ctx),
    activeTeacher === "feynman"
      ? Promise.resolve(generateFeynmanSummary(ctx))
      : generateOppositeSummary("feynman", ctx),
  ]);

  return { strict, feynman };
}

async function generateStrictSummary(ctx: DialogueContext): Promise<string> {
  return `The correct answer is ${ctx.mcq.correctAnswer}: ${ctx.mcq.explanation}`;
}

async function generateFeynmanSummary(ctx: DialogueContext): Promise<string> {
  return `You answered correctly. The key concept is "${ctx.mcq.keyword}". ${ctx.mcq.explanation}`;
}

async function generateOppositeSummary(
  teacher: string,
  ctx: DialogueContext
): Promise<string> {
  const prompt =
    teacher === "strict"
      ? `The student answered "${ctx.studentAnswer}" about ${ctx.topic}. Correct answer is ${ctx.mcq.correctAnswer}: ${ctx.mcq.explanation}. Provide a 1-sentence factual summary.`
      : `The student answered correctly about ${ctx.mcq.keyword}. Explain it simply in 1 sentence.`;

  const response = await callLLM(
    [
      {
        role: "system",
        content: `${ctx.subjectInstructions}\n\nYou are a ${teacher} tutor. Be concise.`,
      },
      { role: "user", content: prompt },
    ],
    { sessionId: ctx.sessionId }
  );

  return response.content;
}

function buildFeynmanPrompt(ctx: DialogueContext): string {
  return feynmanPrompt
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{question}", ctx.mcq.question)
    .replace("{correctAnswer}", ctx.mcq.correctAnswer)
    .replace("{explanation}", ctx.mcq.explanation)
    .replace("{keyword}", ctx.mcq.keyword)
    .replace("{topicText}", ctx.topicText)
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    );
}

function buildStrictPrompt(ctx: DialogueContext): string {
  return strictPrompt
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{question}", ctx.mcq.question)
    .replace("{correctAnswer}", ctx.mcq.correctAnswer)
    .replace("{explanation}", ctx.mcq.explanation)
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{keyword}", ctx.mcq.keyword)
    .replace("{topicText}", ctx.topicText)
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    );
}
