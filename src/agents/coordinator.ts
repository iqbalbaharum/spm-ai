import chalk from "chalk";
import { generateMCQ } from "./generator.js";
import { activeDialogue, passiveFeedback, passiveSummaries, extractProperNouns } from "./teachers.js";
import { getParetoTopics, getTopicWithQuestions } from "../db/neo4j.js";
import { createSession, saveQuestionLog, completeSession } from "../db/sqlite.js";
import { config } from "../config.js";
import { logEvent } from "./llm.js";
import type {
  TopicSummary,
  QuestionRecord,
  PassiveFeedback,
  DialogueContext,
  SubjectConfig,
} from "../types.js";

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
  const subjectConfig: SubjectConfig = config.subjectConfigs[activeSubject] || config.subjectConfigs["sejarah"] || { language: "Bahasa Malaysia", instructions: "" };
  const sid = sessionId();
  createSession(sid, activeSubject);

  logEvent(sid, "ctx", { type: "pareto", selected: selected.map((t) => ({ name: t.name, subject: t.subject, form: t.form, chapter: t.chapter, questionCount: t.questionCount })) });

  const records: QuestionRecord[] = [];

  for (let i = 0; i < selected.length; i++) {
    const topic = selected[i];
    console.log(
      chalk.cyan(
        `  ═══════ Question ${i + 1} of ${selected.length} ═══════`
      )
    );
    console.log(chalk.dim(`  Topic: ${topic.name}\n`));

    const topicData = await getTopicWithQuestions(topic.name);
    logEvent(sid, "ctx", { type: "topic", topicName: topicData.name, topicText: topicData.text, examQuestions: topicData.examQuestions });
    const mcq = await generateMCQ({
      topicName: topic.name,
      topicText: topicData.text,
      examQuestions: topicData.examQuestions,
      subjectInstructions: subjectConfig.instructions,
      sessionId: sid,
    });

    displayMCQ(mcq);

    const answer = (await getUserInput()).trim().toUpperCase();

    if (answer === "/skip") {
      records.push({
        seq: i + 1,
        topic: topic.name,
        mcq,
        studentAnswer: null,
        correct: null,
        activeTeacher: null,
        dialogue: [],
        feedback: { strict: "", feynman: "", recap: "", kbat: "", propernouns: "" },
      });
      console.log(chalk.yellow("  Skipped.\n"));
      continue;
    }

    const correct = answer === mcq.correctAnswer;
    const ctx: DialogueContext = { mcq, studentAnswer: answer, correct, topic: topic.name, topicText: topicData.text, examQuestions: topicData.examQuestions, subjectInstructions: subjectConfig.instructions, sessionId: sid };

    if (correct) {
      console.log(chalk.green(`  ✓ Correct!\n`));
    } else {
      console.log(
        chalk.red(
          `  ✗ Wrong. Correct answer: ${mcq.correctAnswer}\n`
        )
      );
    }

    const activeTeacher = correct ? "feynman" : "strict";
    const dialogue = await activeDialogue(activeTeacher, ctx, getUserInput);

    console.log(chalk.dim("\n  ─── Feedback Summary ───\n"));

    const [passive, summaries, propernouns] = await Promise.all([
      Promise.all([
        passiveFeedback("recap", ctx),
        passiveFeedback("kbat", ctx),
      ]),
      passiveSummaries(activeTeacher, ctx),
      extractProperNouns(ctx).catch(() => "(feedback unavailable)"),
    ]);

    const [recap, kbat] = passive;
    const feedback: PassiveFeedback = {
      strict: summaries.strict,
      feynman: summaries.feynman,
      recap,
      kbat,
      propernouns,
    };

    displayFeedback(activeTeacher, feedback);

    records.push({
      seq: i + 1,
      topic: topic.name,
      mcq,
      studentAnswer: answer,
      correct,
      activeTeacher,
      dialogue,
      feedback,
    });

    if (i < selected.length - 1) {
      console.log(chalk.dim("\n  Press Enter for next question..."));
      await getUserInput();
    }
  }

  const answered = records.filter((r) => r.studentAnswer !== null);
  const correctCount = answered.filter((r) => r.correct).length;
  const summary = { total: records.length, answered: answered.length, correct: correctCount };

  for (const r of records) {
    saveQuestionLog(sid, r);
  }
  completeSession(sid, summary);

  console.log(chalk.bold("\n  ═══════ Session Complete ═══════"));
  console.log(chalk.green(`  Score: ${correctCount}/${records.length} (${Math.round((correctCount / records.length) * 100)}%)\n`));
}

function displayMCQ(mcq: {
  question: string;
  options: [string, string, string, string];
}): void {
  console.log(`  ${mcq.question}\n`);
  for (const opt of mcq.options) {
    console.log(`    ${opt}`);
  }
  console.log();
  process.stdout.write(chalk.cyan("  Your answer (A/B/C/D) or /skip: "));
}

function displayFeedback(
  activeTeacher: string,
  feedback: PassiveFeedback
): void {
  const activeLabel = activeTeacher === "feynman" ? "Feynman" : "Strict";
  const passiveSummary =
    activeTeacher === "feynman" ? feedback.strict : feedback.feynman;

  console.log(chalk.dim(`  [${activeLabel} Summary]`));
  console.log(`  ${passiveSummary}\n`);

  console.log(chalk.dim(`  [Recap]`));
  console.log(`  ${feedback.recap}\n`);

  if (feedback.propernouns) {
    console.log(chalk.dim(`  [Kata Nama Khas]`));
    console.log(`  ${feedback.propernouns}\n`);
  }

  console.log(chalk.dim(`  [KBAT]`));
  console.log(`  ${feedback.kbat}\n`);
}
