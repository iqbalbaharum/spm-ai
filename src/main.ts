#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import { runQuiz } from "./agents/coordinator.js";
import { config } from "./config.js";

const rl = readline.createInterface({ input, output });

async function getUserInput(): Promise<string> {
  try {
    return (await rl.question("")).trim();
  } catch {
    return "";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "quiz";

  const subjectIdx = args.indexOf("--subject");
  const subject = subjectIdx !== -1 && args[subjectIdx + 1] ? args[subjectIdx + 1].toLowerCase() : undefined;

  switch (cmd) {
    case "quiz": {
      const count = parseInt(args[1], 10) || config.defaultQuizCount;
      await runQuiz(count, subject, getUserInput);
      break;
    }

    case "history": {
      const { getSessionHistory } = await import("./db/sqlite.js");
      const sessions = getSessionHistory();
      if (sessions.length === 0) {
        console.log("  No sessions yet.");
      } else {
        for (const s of sessions) {
          const summary = JSON.parse(s.summary);
          console.log(
            `  ${s.date.slice(0, 19)}  ${s.id}  ` +
              `${summary.correct}/${summary.total} correct`
          );
        }
      }
      break;
    }

    case "session": {
      const sessionId = args[1];
      if (!sessionId) {
        console.log("  Usage: spm session <session-id>");
        break;
      }
      const { getSessionDetail } = await import("./db/sqlite.js");
      const detail = getSessionDetail(sessionId);
      if (!detail) {
        console.log("  Session not found.");
        break;
      }
      console.log(`  Session: ${detail.session.id}`);
      console.log(`  Date: ${String(detail.session.started_at).slice(0, 19)}`);
      console.log(`  Questions: ${detail.questions.length}\n`);
      for (const q of detail.questions) {
        const mcq = JSON.parse(q.mcq as string);
        const seq = q.seq as number;
        const correct = q.correct as number | null;
        const status =
          correct === null
            ? chalk.yellow("SKIP")
            : correct
              ? chalk.green("CORRECT")
              : chalk.red("WRONG");
        console.log(`  [${seq}] ${status} — ${mcq.question.slice(0, 60)}...`);
      }
      break;
    }

    default:
      console.log(`
  Usage:
    spm quiz [n] [--subject <subject>]  Start a quiz
    spm history                          Show recent sessions
    spm session <id>                     Show session details
`);
  }

  rl.close();
}

main().catch((err) => {
  console.error(chalk.red("  Error:"), err.message);
  process.exit(1);
});
