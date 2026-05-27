import chalk from "chalk";
import { generateQuestion } from "./generator.js";
import {
  buildActiveRecallPrompt,
  passiveFeedback,
  extractProperNouns,
  generateRecapSummary,
} from "./teachers.js";
import { callLLMStructured } from "./llm.js";
import { getParetoTopics, getTopicWithQuestions } from "../db/neo4j.js";
import {
  createSession,
  saveQuestionLog,
  saveActiveRecallMessage,
  saveFeedback,
  completeSession,
  getUsedQuestions,
  getFeedbacks,
} from "../db/sqlite.js";
import { config } from "../config.js";
import type {
  TopicSummary,
  SubjectConfig,
  QuizQuestion,
  DialogueContext,
  ActiveRecallResponse,
} from "../types.js";
import { isMcq } from "../types.js";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-cli-${rand}`;
}

const MAX_ACTIVE_RECALL_ROUNDS = 3;

export async function runQuiz(
  count: number,
  subject: string | undefined,
  getUserInput: () => Promise<string>
): Promise<void> {
  console.log(chalk.bold("\n  ╔══ SPM Quiz ═════════════════════════════╗\n"));

  const topics = await getParetoTopics(subject);
  if (topics.length === 0) {
    console.log(chalk.red("  No topics found in Neo4j."));
    return;
  }

  const selected = shuffle(topics).slice(0, count);
  const activeSubject: string = (selected[0]?.subject || subject || "sejarah").toLowerCase();
  const subjectConfig: SubjectConfig = config.subjectConfigs[activeSubject] || config.subjectConfigs["sejarah"] || {
    language: "Bahasa Malaysia",
    instructions: "",
    mode: "mcq",
    teachers: {},
    passiveFeedback: [],
    prompts: { generate: "generate_quiz.txt" },
  };
  const sid = sessionId();
  createSession(sid, activeSubject);

  for (let i = 0; i < selected.length; i++) {
    const topic = selected[i];
    console.log(
      chalk.cyan(
        `  ═══════ Question ${i + 1} of ${selected.length} ═══════`
      )
    );
    console.log(chalk.dim(`  Topic: ${topic.name}\n`));

    const topicData = await getTopicWithQuestions(topic.name);

    const usedQuestions = getUsedQuestions("cli", topic.name);

    const question = await generateQuestion({
      topicName: topic.name,
      topicText: topicData.text,
      examQuestions: topicData.examQuestions,
      subjectInstructions: subjectConfig.instructions,
      mode: subjectConfig.mode,
      sessionId: sid,
      usedQuestions,
    });

    displayQuestion(question, subjectConfig.mode);

    const answer = (await getUserInput()).trim();

    if (answer === "/skip") {
      saveQuestionLog(sid, {
        seq: i + 1,
        topic: topic.name,
        question,
        studentAnswer: null,
      });
      console.log(chalk.yellow("  Skipped.\n"));
      continue;
    }

    const ctx: DialogueContext = {
      question,
      studentAnswer: answer,
      topic: topic.name,
      topicText: topicData.text,
      examQuestions: topicData.examQuestions,
      subjectInstructions: subjectConfig.instructions,
      sessionId: sid,
    };

    // Active recall
    const systemPrompt = buildActiveRecallPrompt(ctx);
    saveActiveRecallMessage(sid, "system", systemPrompt);

    const initialUserMsg = isMcq(question)
      ? `The student answered "${answer}". Begin the active recall session.`
      : `The student submitted their essay. Begin the active recall session.`;

    saveActiveRecallMessage(sid, "user", initialUserMsg);

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: initialUserMsg },
    ];

    let complete = false;
    let rounds = 0;

    while (!complete && rounds < MAX_ACTIVE_RECALL_ROUNDS) {
      const result = await callLLMStructured<ActiveRecallResponse>(
        messages.map((m) => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
        { sessionId: sid }
      );

      messages.push({ role: "assistant", content: result.message });
      saveActiveRecallMessage(sid, "assistant", result.message);

      console.log(`\n  [Tutor]: ${result.message}\n`);

      if (result.complete) {
        complete = true;
        break;
      }

      const userInput = await getUserInput();
      if (userInput.toLowerCase() === "/done") break;

      messages.push({ role: "user", content: userInput });
      saveActiveRecallMessage(sid, "user", userInput);
      rounds++;
    }

    // Passive feedback
    console.log(chalk.dim("\n  ─── Feedback ───\n"));

    let recap = "";
    if (subjectConfig.passiveFeedback.includes("recap")) {
      recap = await passiveFeedback("recap", ctx).catch(() => "");
    }
    let propernouns = "";
    if (subjectConfig.passiveFeedback.includes("propernouns")) {
      propernouns = await extractProperNouns(ctx).catch(() => "");
    }

    if (recap) saveFeedback(sid, "recap", recap);
    if (propernouns) saveFeedback(sid, "propernouns", propernouns);

    const summary = await generateRecapSummary(ctx);
    console.log(chalk.dim(`  [Summary]`));
    console.log(`  ${summary}\n`);

    if (recap) {
      console.log(chalk.dim(`  [Recap]`));
      console.log(`  ${recap}\n`);
    }
    if (propernouns) {
      console.log(chalk.dim(`  [Kata Nama Khas]`));
      console.log(`  ${propernouns}\n`);
    }

    saveQuestionLog(sid, {
      seq: i + 1,
      topic: topic.name,
      question,
      studentAnswer: answer,
    });

    if (i < selected.length - 1) {
      console.log(chalk.dim("  Press Enter for next question..."));
      await getUserInput();
    }
  }

  completeSession(sid, { total: selected.length });

  console.log(chalk.bold("\n  ═══════ Session Complete ═══════"));
}

function displayQuestion(question: QuizQuestion, mode: string): void {
  console.log(`  ${question.question}\n`);
  if (isMcq(question)) {
    for (const opt of question.options) {
      console.log(`    ${opt}`);
    }
    console.log();
    process.stdout.write(chalk.cyan("  Your answer (A/B/C/D) or /skip: "));
  } else {
    console.log(chalk.dim(`  Marking Scheme: ${question.markingScheme}\n`));
    process.stdout.write(chalk.cyan("  Your answer (text) or /skip: "));
  }
}
