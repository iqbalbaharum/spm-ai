import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuizQuestion } from "../types.js";
import { isMcq } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stageDir = join(__dirname, "../../.stage/spmai");
mkdirSync(stageDir, { recursive: true });

const db = new Database(join(stageDir, "sessions.db"));

// Enable WAL mode for better concurrent access
db.pragma("journal_mode = WAL");

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL DEFAULT 'cli',
      subject        TEXT NOT NULL DEFAULT 'Sejarah',
      started_at     TEXT NOT NULL,
      completed_at   TEXT,
      summary        TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS question_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      seq              INTEGER NOT NULL,
      topic            TEXT NOT NULL,
      question         TEXT NOT NULL,
      options          TEXT,
      correct_answer   TEXT,
      keyword          TEXT,
      student_answer   TEXT,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_recall (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      role             TEXT NOT NULL,
      content          TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      instructor       TEXT NOT NULL,
      text             TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mastery_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          TEXT NOT NULL,
      topic            TEXT NOT NULL,
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      score            REAL NOT NULL,
      created_at       TEXT NOT NULL
    );
  `);

  // Add status/rounds/system_prompt columns to sessions if missing
  const sessCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessCols.some((c) => c.name === "status")) {
    db.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'awaiting-answer'");
    db.exec("ALTER TABLE sessions ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }

  migrateFromLegacy();
}

function migrateFromLegacy(): void {
  // Check if legacy mcq column exists
  const cols = db.prepare("PRAGMA table_info(question_logs)").all() as { name: string }[];
  const hasMcq = cols.some((c) => c.name === "mcq");
  if (!hasMcq) return; // already migrated

  // Add new columns if they don't exist
  const hasQuestion = cols.some((c) => c.name === "question");
  if (!hasQuestion) {
    db.exec("ALTER TABLE question_logs ADD COLUMN question TEXT");
    db.exec("ALTER TABLE question_logs ADD COLUMN options TEXT");
    db.exec("ALTER TABLE question_logs ADD COLUMN correct_answer TEXT");
    db.exec("ALTER TABLE question_logs ADD COLUMN keyword TEXT");
  }

  // Migrate mcq JSON → new columns
  const rows = db.prepare(
    "SELECT id, mcq, dialogue, feedback_strict, feedback_feynman, feedback_recap, feedback_kbat, feedback_propernouns FROM question_logs WHERE question IS NULL OR question = ''"
  ).all() as {
    id: number;
    mcq: string;
    dialogue: string | null;
    feedback_strict: string | null;
    feedback_feynman: string | null;
    feedback_recap: string | null;
    feedback_kbat: string | null;
    feedback_propernouns: string | null;
  }[];

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.mcq);
      db.prepare(
        "UPDATE question_logs SET question = ?, options = ?, correct_answer = ?, keyword = ? WHERE id = ?"
      ).run(
        parsed.question || "",
        parsed.options ? JSON.stringify(parsed.options) : null,
        parsed.correctAnswer || null,
        parsed.keyword || null,
        row.id
      );
    } catch {
      // skip malformed JSON
    }

    // Migrate dialogue → active_recall
    if (row.dialogue) {
      try {
        const messages = JSON.parse(row.dialogue) as { role: string; content: string }[];
        const insert = db.prepare(
          "INSERT INTO active_recall (session_id, role, content, created_at) VALUES (?, ?, ?, ?)"
        );
        const now = new Date().toISOString();
        for (const msg of messages) {
          insert.run(
            (db.prepare("SELECT session_id FROM question_logs WHERE id = ?").get(row.id) as { session_id: string }).session_id,
            msg.role,
            msg.content,
            now
          );
        }
      } catch {
        // skip malformed dialogue
      }
    }

    // Migrate feedback_* → feedback
    type FeedbackEntry = { instructor: string; text: string | null };
    const feedbacks: FeedbackEntry[] = [
      { instructor: "strict", text: row.feedback_strict },
      { instructor: "feynman", text: row.feedback_feynman },
      { instructor: "recap", text: row.feedback_recap },
      { instructor: "kbat", text: row.feedback_kbat },
      { instructor: "propernouns", text: row.feedback_propernouns },
    ];
    const sessionId = (db.prepare("SELECT session_id FROM question_logs WHERE id = ?").get(row.id) as { session_id: string }).session_id;
    const fbInsert = db.prepare(
      "INSERT INTO feedback (session_id, instructor, text, created_at) VALUES (?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    for (const fb of feedbacks) {
      if (fb.text && fb.text.trim()) {
        fbInsert.run(sessionId, fb.instructor, fb.text, now);
      }
    }
  }

  // Drop legacy columns (SQLite 3.35.0+ supports DROP COLUMN)
  for (const col of ["mcq", "dialogue", "feedback_strict", "feedback_feynman", "feedback_recap", "feedback_kbat", "feedback_propernouns", "active_teacher"]) {
    try {
      db.exec(`ALTER TABLE question_logs DROP COLUMN ${col}`);
    } catch {
      // column may not exist
    }
  }
}

export function createSession(
  sessionId: string,
  subject: string,
  userId?: string
): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, subject, started_at, summary)
    VALUES (?, ?, ?, ?, '{}')
  `);
  stmt.run(sessionId, userId || 'cli', subject, new Date().toISOString());
}

export function updateSessionStatus(sessionId: string, status: string): void {
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, sessionId);
}

export function updateSessionRounds(sessionId: string, rounds: number): void {
  db.prepare("UPDATE sessions SET rounds = ? WHERE id = ?").run(rounds, sessionId);
}

export function updateStudentAnswer(sessionId: string, answer: string): void {
  db.prepare("UPDATE question_logs SET student_answer = ? WHERE session_id = ?").run(answer, sessionId);
}

export function checkSession(sessionId: string, userId: string): boolean {
  const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as { user_id: string } | undefined;
  return row !== undefined && row.user_id === userId;
}

export function saveQuestionLog(
  sessionId: string,
  q: {
    seq: number;
    topic: string;
    question: QuizQuestion;
    studentAnswer: string | null;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO question_logs
      (session_id, seq, topic, question, options, correct_answer, keyword, student_answer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let options: string | null = null;
  let correctAnswer: string | null = null;
  let keyword = "";

  if (isMcq(q.question)) {
    options = JSON.stringify(q.question.options);
    correctAnswer = q.question.correctAnswer;
    keyword = q.question.keyword;
  } else {
    keyword = q.question.keyword;
  }

  stmt.run(
    sessionId,
    q.seq,
    q.topic,
    q.question.question,
    options,
    correctAnswer,
    keyword,
    q.studentAnswer,
    new Date().toISOString()
  );
}

export function saveActiveRecallMessage(
  sessionId: string,
  role: string,
  content: string
): void {
  db.prepare(
    "INSERT INTO active_recall (session_id, role, content, created_at) VALUES (?, ?, ?, ?)"
  ).run(sessionId, role, content, new Date().toISOString());
}

export function saveFeedback(
  sessionId: string,
  instructor: string,
  text: string
): void {
  db.prepare(
    "INSERT INTO feedback (session_id, instructor, text, created_at) VALUES (?, ?, ?, ?)"
  ).run(sessionId, instructor, text, new Date().toISOString());
}

export function completeSession(
  sessionId: string,
  summary: Record<string, unknown>
): void {
  const stmt = db.prepare(`
    UPDATE sessions SET completed_at = ?, summary = ?
    WHERE id = ?
  `);
  stmt.run(new Date().toISOString(), JSON.stringify(summary), sessionId);
}

export function getSessionHistory(): Array<{
  id: string;
  date: string;
  summary: string;
}> {
  const rows = db
    .prepare(
      `SELECT id, started_at AS date, summary
       FROM sessions ORDER BY started_at DESC LIMIT 20`
    )
    .all() as Array<{ id: string; date: string; summary: string }>;

  return rows;
}

export function getSessionDetail(
  sessionId: string
): {
  session: Record<string, unknown>;
  questions: Record<string, unknown>[];
  activeRecall: Record<string, unknown>[];
  feedbacks: Record<string, unknown>[];
} | null {
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!session) return null;

  const questions = db
    .prepare(
      "SELECT * FROM question_logs WHERE session_id = ? ORDER BY seq"
    )
    .all(sessionId) as Record<string, unknown>[];

  const activeRecall = db
    .prepare(
      "SELECT * FROM active_recall WHERE session_id = ? ORDER BY id"
    )
    .all(sessionId) as Record<string, unknown>[];

  const feedbacks = db
    .prepare(
      "SELECT * FROM feedback WHERE session_id = ? ORDER BY id"
    )
    .all(sessionId) as Record<string, unknown>[];

  return { session, questions, activeRecall, feedbacks };
}

export function getUsedQuestions(userId: string, topic: string): string[] {
  const rows = db
    .prepare(`
      SELECT ql.question FROM question_logs ql
      JOIN sessions s ON s.id = ql.session_id
      WHERE s.user_id = ? AND ql.topic = ?
      ORDER BY ql.created_at DESC
    `)
    .all(userId, topic) as { question: string }[];

  return rows.map((r) => r.question).filter(Boolean);
}

export function getActiveRecall(sessionId: string): { role: string; content: string }[] {
  return db
    .prepare(
      "SELECT role, content FROM active_recall WHERE session_id = ? ORDER BY id"
    )
    .all(sessionId) as { role: string; content: string }[];
}

export function getFeedbacks(sessionId: string): { instructor: string; text: string }[] {
  return db
    .prepare(
      "SELECT instructor, text FROM feedback WHERE session_id = ? ORDER BY id"
    )
    .all(sessionId) as { instructor: string; text: string }[];
}

export function saveMasteryLog(userId: string, topic: string, sessionId: string, score: number): void {
  db.prepare(
    "INSERT INTO mastery_log (user_id, topic, session_id, score, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, topic, sessionId, score, new Date().toISOString());
}

export function getScoreHistory(userId: string, topic: string): { score: number }[] {
  return db.prepare(
    "SELECT score FROM mastery_log WHERE user_id = ? AND topic = ? ORDER BY created_at ASC"
  ).all(userId, topic) as { score: number }[];
}

// Run init on import
initDb();
