import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLM, callLLMStructured } from "./llm.js";
import { config } from "../config.js";
import type {
  ChatMessage,
  DialogueContext,
  EvalResult,
  PassiveFeedback,
  LLMResponse,
} from "../types.js";
import { isMcq } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptDir = join(__dirname, "../../prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(promptDir, name), "utf-8");
}

function getKeyword(ctx: DialogueContext): string {
  return "keyword" in ctx.question ? ctx.question.keyword : "";
}

export function buildTeacherPrompt(teacher: string, ctx: DialogueContext): string {
  const activeSubject = ctx.subjectInstructions
    ? (Object.entries(config.subjectConfigs).find(
        ([, c]) => c.instructions === ctx.subjectInstructions
      )?.[0] ?? "sejarah")
    : "sejarah";
  const subjectConfig = config.subjectConfigs[activeSubject] || config.subjectConfigs["sejarah"];
  const teacherCfg = subjectConfig.teachers[teacher];
  if (!teacherCfg) throw new Error(`Teacher "${teacher}" not configured for subject "${activeSubject}"`);

  const template = loadPrompt(teacherCfg.prompt);
  const q = ctx.question;

  let result = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{topicText}", ctx.topicText)
    .replace("{keyword}", getKeyword(ctx))
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace(
      "{examQuestions}",
      ctx.examQuestions.map((x) => `- ${x}`).join("\n") || "(none available)"
    );

  if (isMcq(q)) {
    result = result
      .replace("{question}", q.question)
      .replace("{correctAnswer}", q.correctAnswer)
      .replace("{explanation}", q.explanation);
  } else {
    result = result
      .replace("{question}", q.question)
      .replace("{markingScheme}", q.markingScheme);
  }

  if (ctx.evalResult) {
    result = result
      .replace("{score}", String(ctx.evalResult.score ?? ""))
      .replace("{maxScore}", String(ctx.evalResult.maxScore ?? ""))
      .replace("{evalFeedback}", ctx.evalResult.feedback);
  }

  return result;
}

export async function evaluateSubjective(ctx: DialogueContext): Promise<EvalResult> {
  const q = ctx.question;
  if (isMcq(q)) {
    return { feynmanEligible: ctx.correct, feedback: "" };
  }

  const evalPrompt = `{subjectInstructions}

You are an SPM Bahasa Melayu examiner. Evaluate the student's essay against the marking scheme.

Question: "${q.question}"
Marking Scheme: "${q.markingScheme}"
Topic Content: "${ctx.topicText}"

Student's Essay: "${ctx.studentAnswer}"

Evaluate the essay based on the marking scheme. Return JSON:
{
  "feynmanEligible": true/false,
  "score": <number>,
  "maxScore": <number>,
  "feedback": "Brief evaluation notes in Bahasa Melayu explaining what the student did well or missed"
}

- feynmanEligible = true if score >= 50% of maxScore
- score = estimated marks earned
- maxScore = total marks available
- feedback = constructive evaluation (2-3 sentences)

Valid JSON only. No markdown fences.`;

  const result = await callLLMStructured<{ feynmanEligible: boolean; score: number; maxScore: number; feedback: string }>(
    [
      { role: "system", content: evalPrompt.replace("{subjectInstructions}", ctx.subjectInstructions) },
      { role: "user", content: "Evaluate this essay." },
    ],
    { sessionId: ctx.sessionId }
  );

  return {
    feynmanEligible: result.feynmanEligible,
    score: result.score,
    maxScore: result.maxScore,
    feedback: result.feedback,
  };
}

export async function activeDialogue(
  teacher: "feynman" | "strict",
  ctx: DialogueContext,
  getUserInput: () => Promise<string>
): Promise<ChatMessage[]> {
  const systemPrompt = buildTeacherPrompt(teacher, ctx);

  let initialUserContent: string;
  if (isMcq(ctx.question)) {
    initialUserContent = teacher === "feynman"
      ? `The student answered correctly. Engage them on the keyword "${getKeyword(ctx)}".`
      : `The student answered "${ctx.studentAnswer}" (wrong). The correct answer is "${ctx.question.correctAnswer}". Engage them.`;
  } else {
    initialUserContent = teacher === "feynman"
      ? `The student did well (${ctx.evalResult?.score}/${ctx.evalResult?.maxScore}). Engage them.`
      : `The student needs improvement (${ctx.evalResult?.score}/${ctx.evalResult?.maxScore}). Engage them.`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: initialUserContent },
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
  const promptName = teacher === "recap" ? "teacher_recap_passive.txt" : "teacher_kbat_passive.txt";
  const template = loadPrompt(promptName);

  const q = ctx.question;
  let result = template
    .replace("{subjectInstructions}", ctx.subjectInstructions)
    .replace("{topic}", ctx.topic)
    .replace("{keyword}", getKeyword(ctx))
    .replace("{studentAnswer}", ctx.studentAnswer)
    .replace("{isCorrect}", ctx.correct ? "yes" : "no")
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
  const q = ctx.question;
  if (isMcq(q)) {
    return `The correct answer is ${q.correctAnswer}: ${q.explanation}`;
  }
  if (ctx.evalResult) {
    return `Mark: ${ctx.evalResult.score}/${ctx.evalResult.maxScore}. ${ctx.evalResult.feedback}`;
  }
  return "Evaluation completed.";
}

async function generateFeynmanSummary(ctx: DialogueContext): Promise<string> {
  const q = ctx.question;
  if (isMcq(q)) {
    return `You answered correctly. The key concept is "${q.keyword}". ${q.explanation}`;
  }
  if (ctx.evalResult) {
    return `Good work! You scored ${ctx.evalResult.score}/${ctx.evalResult.maxScore}. ${ctx.evalResult.feedback}`;
  }
  return "Well done!";
}

async function generateOppositeSummary(
  teacher: string,
  ctx: DialogueContext
): Promise<string> {
  const q = ctx.question;
  if (isMcq(q)) {
    const prompt =
      teacher === "strict"
        ? `The student answered "${ctx.studentAnswer}" about ${ctx.topic}. Correct answer is ${q.correctAnswer}: ${q.explanation}. Provide a 1-sentence factual summary.`
        : `The student answered correctly about ${q.keyword}. Explain it simply in 1 sentence.`;

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

  const prompt =
    teacher === "strict"
      ? `The student scored ${ctx.evalResult?.score}/${ctx.evalResult?.maxScore} on ${ctx.topic}. Provide a 1-sentence factual summary of what they need to improve.`
      : `The student scored ${ctx.evalResult?.score}/${ctx.evalResult?.maxScore} on ${ctx.topic}. Summarize what they did well in 1 sentence.`;

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
