import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callLLMStructured, logEvent } from "./llm.js";
import type { ChatMessage, GeneratorInput, MCQ, SubjectiveQuestion, QuizQuestion } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptDir = join(__dirname, "../../prompts");

function loadPrompt(name: string): string {
  return readFileSync(join(promptDir, name), "utf-8");
}

interface RawMCQ {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  keyword?: string;
}

interface RawSubjective {
  question: string;
  markingScheme: string;
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

export async function generateQuestion(input: GeneratorInput): Promise<QuizQuestion> {
  if (input.mode === "mcq") {
    return generateMCQ(input);
  }
  return generateSubjective(input);
}

async function generateMCQ(input: GeneratorInput): Promise<MCQ> {
  const promptTemplate = loadPrompt("generate_quiz.txt");

  const usedQuestions = input.usedQuestions?.length
    ? input.usedQuestions.map((q) => `- ${q}`).join("\n")
    : "(none)";

  const systemPrompt = promptTemplate
    .replace("{subjectInstructions}", input.subjectInstructions)
    .replace("{topicName}", input.topicName)
    .replace("{topicText}", input.topicText)
    .replace(
      "{examQuestions}",
      input.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    )
    .replace("{usedQuestions}", usedQuestions);

  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Generate 1 MCQ in JSON format." },
  ];

  const maxAttempts = 3;
  const maxFixAttempts = 3;

  function buildEvalMessages(q: RawMCQ): ChatMessage[] {
    return [
      {
        role: "system",
        content: evalSystemPrompt
          .replace("{topicText}", input.topicText)
          .replace("{question}", q.question)
          .replace("{options[0]}", q.options[0] || "")
          .replace("{options[1]}", q.options[1] || "")
          .replace("{options[2]}", q.options[2] || "")
          .replace("{options[3]}", q.options[3] || "")
          .replace("{correctAnswer}", q.correctAnswer)
          .replace("{explanation}", q.explanation)
          .replace("{keyword}", q.keyword || ""),
      },
      { role: "user", content: "Evaluate this MCQ." },
    ];
  }

  function buildFixPrompt(q: RawMCQ, error: string): ChatMessage[] {
    return [
      {
        role: "system",
        content: "You are an SPM examiner. Fix the MCQ below based on the error. Return valid RawMCQ JSON only. No markdown fences.",
      },
      {
        role: "user",
        content: `Error: ${error}\n\nMCQ to fix:\n${JSON.stringify(q, null, 2)}\n\nReturn the corrected JSON.`,
      },
    ];
  }

  let raw: RawMCQ;
  let validated = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages: ChatMessage[] = attempt === 1
      ? baseMessages
      : [
          ...baseMessages,
          { role: "assistant", content: "[Previous question was invalid]" },
          { role: "user", content: "The previous question had issues. Generate a completely NEW question fixing all issues." },
        ];

    const generated = await callLLMStructured<RawMCQ>(messages, {
      sessionId: input.sessionId,
    });

    // Inner fix-validate loop — preserve generated question, don't discard on bad eval
    let current = generated;
    validated = false;

    for (let fix = 0; fix < maxFixAttempts; fix++) {
      let evalResult: EvalResult;
      try {
        evalResult = await callLLMStructured<EvalResult>(
          buildEvalMessages(current),
          { sessionId: input.sessionId }
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logEvent(input.sessionId, "ctx", {
          eventType: "eval",
          attempt,
          fix,
          topic: input.topicName,
          question: current.question,
          evalValid: false,
          evalError: errorMsg,
        });
        if (fix < maxFixAttempts - 1) {
          current = await callLLMStructured<RawMCQ>(
            buildFixPrompt(current, errorMsg),
            { sessionId: input.sessionId }
          );
          continue;
        }
        break;
      }

      logEvent(input.sessionId, "ctx", {
        eventType: "eval",
        attempt,
        fix,
        topic: input.topicName,
        question: current.question,
        evalValid: evalResult.valid,
        evalHasFixed: !!evalResult.fixed,
      });

      if (evalResult.valid) {
        validated = true;
        break;
      }

      if (evalResult.fixed) {
        current = evalResult.fixed;
        continue;
      }

      // valid=false, no fixed version — ask LLM to fix
      if (fix < maxFixAttempts - 1) {
        current = await callLLMStructured<RawMCQ>(
          buildFixPrompt(current, "The question failed validation but no corrected version was provided"),
          { sessionId: input.sessionId }
        );
      }
    }

    if (validated) {
      raw = current;
      break;
    }

    if (attempt === maxAttempts) {
      throw new Error(`Failed to generate valid MCQ after ${maxAttempts} generation attempts`);
    }
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

async function generateSubjective(input: GeneratorInput): Promise<SubjectiveQuestion> {
  const promptTemplate = loadPrompt("generate_bm_soalan.txt");

  const usedQuestions = input.usedQuestions?.length
    ? input.usedQuestions.map((q) => `- ${q}`).join("\n")
    : "(none)";

  const systemPrompt = promptTemplate
    .replace("{subjectInstructions}", input.subjectInstructions)
    .replace("{topicName}", input.topicName)
    .replace("{topicText}", input.topicText)
    .replace(
      "{examQuestions}",
      input.examQuestions.map((q) => `- ${q}`).join("\n") || "(none available)"
    )
    .replace("{usedQuestions}", usedQuestions);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Generate 1 subjective question in JSON format." },
  ];

  const raw = await callLLMStructured<RawSubjective>(messages, {
    sessionId: input.sessionId,
  });

  return {
    question: raw.question,
    markingScheme: raw.markingScheme,
    keyword: raw.keyword?.trim() || extractKeyword(input.topicText),
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
