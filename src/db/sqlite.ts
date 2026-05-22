import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { QuestionRecord, SessionRecord } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stageDir = join(__dirname, "../../.stage/spmai");
mkdirSync(stageDir, { recursive: true });

const db = new Database(join(stageDir, "sessions.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL DEFAULT 'cli',
    subject      TEXT NOT NULL DEFAULT 'Sejarah',
    started_at   TEXT NOT NULL,
    completed_at TEXT,
    summary      TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS question_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(id),
    seq              INTEGER NOT NULL,
    topic            TEXT NOT NULL,
    mcq              TEXT NOT NULL,
    student_answer   TEXT,
    correct          INTEGER,
    active_teacher   TEXT,
    dialogue         TEXT,
    feedback_strict  TEXT,
    feedback_feynman TEXT,
    feedback_recap   TEXT,
    feedback_kbat    TEXT,
    created_at       TEXT NOT NULL
  );
`);

export function createSession(
  sessionId: string,
  subject: string
): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, user_id, subject, started_at, summary)
    VALUES (?, 'cli', ?, ?, '{}')
  `);
  stmt.run(sessionId, subject, new Date().toISOString());
}

export function saveQuestionLog(
  sessionId: string,
  q: QuestionRecord
): void {
  const stmt = db.prepare(`
    INSERT INTO question_logs
      (session_id, seq, topic, mcq, student_answer, correct,
       active_teacher, dialogue, feedback_strict, feedback_feynman,
       feedback_recap, feedback_kbat, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    sessionId,
    q.seq,
    q.topic,
    JSON.stringify(q.mcq),
    q.studentAnswer,
    q.correct ? 1 : 0,
    q.activeTeacher,
    JSON.stringify(q.dialogue),
    q.feedback.strict,
    q.feedback.feynman,
    q.feedback.recap,
    q.feedback.kbat,
    new Date().toISOString()
  );
}

export function completeSession(
  sessionId: string,
  summary: { total: number; answered: number; correct: number }
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
): { session: Record<string, unknown>; questions: Record<string, unknown>[] } | null {
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!session) return null;

  const questions = db
    .prepare(
      "SELECT * FROM question_logs WHERE session_id = ? ORDER BY seq"
    )
    .all(sessionId) as Record<string, unknown>[];

  return { session, questions };
}
