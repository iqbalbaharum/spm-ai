import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLMStructured, logEvent } from "./llm.js";
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

interface EvalResult {
  valid: boolean;
  fixed?: RawMCQ;
}

const evalSystemPrompt = `You are an SPM examiner. Evaluate this MCQ for structural and grammatical correctness.

Topic context: {topicText}

MCQ:
Question: {question}
A: {options[0]}
B: {options[1]}
C: {options[2]}
D: {options[3]}
Correct Answer: {correctAnswer}
Explanation: {explanation}
Keyword: {keyword}

Check:
- Question is clear, ends with "?", no garbled or corrupted text
- All 4 options start with "A."/"B."/"C."/"D.", are complete meaningful sentences, no garbled text
- Options are distinct (not duplicates)
- correctAnswer is A/B/C/D
- Explanation is accurate and matches the topic context

If valid, return: {"valid": true}
If invalid, return the corrected version:
{"valid": false, "fixed": {"question": "...", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correctAnswer": "A", "explanation": "...", "keyword": "..."}}

Valid JSON only. No markdown fences.`;

export async function generateMCQ(input: GeneratorInput): Promise<MCQ> {
  const systemPrompt = promptTemplate
    .replace("{subjectInstructions}", input.subjectInstructions)
    .replace("{topicName}", input.topicName)
    .replace("{topicText}", input.topicText)
    .replace(
      "{examQuestions}",
      input.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    );

  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Generate 1 MCQ in JSON format." },
  ];

  const maxAttempts = 3;
  let raw: RawMCQ;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = attempt === 1
      ? baseMessages
      : [
          ...baseMessages,
          { role: "assistant", content: "[Previous question was invalid]" },
          { role: "user", content: "The previous question had issues. Generate a completely NEW question fixing all issues." },
        ];

    raw = await callLLMStructured<RawMCQ>(messages, {
      sessionId: input.sessionId,
    });

    const evalResult = await callLLMStructured<EvalResult>(
      [
        {
          role: "system",
          content: evalSystemPrompt
            .replace("{topicText}", input.topicText)
            .replace("{question}", raw.question)
            .replace("{options[0]}", raw.options[0] || "")
            .replace("{options[1]}", raw.options[1] || "")
            .replace("{options[2]}", raw.options[2] || "")
            .replace("{options[3]}", raw.options[3] || "")
            .replace("{correctAnswer}", raw.correctAnswer)
            .replace("{explanation}", raw.explanation)
            .replace("{keyword}", raw.keyword || ""),
        },
        { role: "user", content: "Evaluate this MCQ." },
      ],
      { sessionId: input.sessionId }
    );

    logEvent(input.sessionId, "eval", {
      attempt,
      topic: input.topicName,
      question: raw.question,
      evalValid: evalResult.valid,
      evalHasFixed: !!evalResult.fixed,
    });

    if (evalResult.valid) break;

    if (evalResult.fixed) {
      raw = evalResult.fixed;
      break;
    }

    if (attempt === maxAttempts) {
      throw new Error(`Failed to generate valid MCQ after ${maxAttempts} attempts`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  const rawOut = raw!;

  let keyword = rawOut.keyword?.trim() || "";

  if (!isValidKeyword(keyword, input.topicText)) {
    keyword = await retryKeyword(input.topicText, input.sessionId);
  }

  if (!isValidKeyword(keyword, input.topicText)) {
    keyword = extractKeyword(input.topicText);
  }

  return {
    question: rawOut.question,
    options: rawOut.options as [string, string, string, string],
    correctAnswer: rawOut.correctAnswer as "A" | "B" | "C" | "D",
    explanation: rawOut.explanation,
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
