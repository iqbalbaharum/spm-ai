#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { generateQuestion } from "./agents/generator.js";
import {
  buildTeacherPrompt,
  evaluateSubjective,
  passiveFeedback,
  passiveSummaries,
  extractProperNouns,
} from "./agents/teachers.js";
import { callLLMStructured, asTeacherResponse } from "./agents/llm.js";
import { getParetoTopics, getTopicWithQuestions, closeDb } from "./db/neo4j.js";
import {
  createSession,
  saveQuestionLog,
  completeSession,
  saveSessionState,
  getSessionDetail,
} from "./db/sqlite.js";
import { config } from "./config.js";
import type {
  ChatMessage,
  QuizQuestion,
  DialogueContext,
  PassiveFeedback,
  QuestionRecord,
  SubjectConfig,
  TopicSummary,
  TopicWithQuestions,
} from "./types.js";
import { isMcq } from "./types.js";

const SERVER_NAME = "spm-ai-mcp";
const SERVER_VERSION = "0.1.0";
const PORT = parseInt(process.env.MCP_PORT || "3100", 10);

function sessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}-mcp-${rand}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface SessionState {
  sessionId: string;
  subject: string;
  subjectConfig: SubjectConfig;
  topic: TopicSummary;
  topicData: TopicWithQuestions;
  question: QuizQuestion;
  studentAnswer: string;
  correct: boolean;
  evalResult?: { feynmanEligible: boolean; score?: number; maxScore?: number; feedback: string };
  activeTeacher: "feynman" | "strict";
  status: "awaiting-answer" | "in-dialogue" | "complete";
  messages: ChatMessage[];
  rounds: number;
}

const sessions = new Map<string, SessionState>();

function buildDialogueContext(state: SessionState): DialogueContext {
  return {
    question: state.question,
    studentAnswer: state.studentAnswer,
    correct: state.correct,
    evalResult: state.evalResult,
    topic: state.topic.name,
    topicText: state.topicData.text,
    examQuestions: state.topicData.examQuestions,
    subjectInstructions: state.subjectConfig.instructions,
    sessionId: state.sessionId,
  };
}

const MAX_ROUNDS = 1;

async function completeSessionAndGetResult(
  state: SessionState
): Promise<Record<string, unknown>> {
  const ctx = buildDialogueContext(state);
  const activeTeacher = state.activeTeacher;
  const subjectConfig = state.subjectConfig;

  let summaries = { strict: "", feynman: "" };
  try {
    summaries = await passiveSummaries(activeTeacher, ctx);
  } catch {
    // fallback handled below
  }

  let recap = "";
  if (subjectConfig.passiveFeedback.includes("recap")) {
    try {
      recap = await passiveFeedback("recap", ctx);
    } catch {
      recap = "(feedback unavailable)";
    }
  }

  let propernouns = "";
  if (subjectConfig.passiveFeedback.includes("propernouns")) {
    try {
      propernouns = await extractProperNouns(ctx);
    } catch {
      propernouns = "";
    }
  }

  const feedback: PassiveFeedback = {
    strict: summaries.strict,
    feynman: summaries.feynman,
    recap,
    kbat: "",
    propernouns,
  };

  const finalParts = [
    `─── Feedback Summary ───`,
    ``,
    `  [${subjectConfig.teachers[activeTeacher]?.displayName || activeTeacher} Summary]`,
    `  ${generateInlineSummary(activeTeacher, ctx)}`,
  ];

  if (recap) {
    finalParts.push(``, `  [Recap]`, `  ${recap}`);
  }

  if (propernouns) {
    finalParts.push(``, `  [Kata Nama Khas]`, `  ${propernouns}`);
  }

  const finalResponse = finalParts.join("\n");

  const record: QuestionRecord = {
    seq: 1,
    topic: state.topic.name,
    question: state.question,
    studentAnswer: state.studentAnswer,
    correct: state.correct,
    evalResult: state.evalResult,
    activeTeacher,
    dialogue: state.messages,
    feedback,
  };

  saveQuestionLog(state.sessionId, record);

  const summary = {
    total: 1,
    answered: 1,
    correct: state.correct ? 1 : 0,
  };
  completeSession(state.sessionId, summary);

  state.status = "complete";

  return {
    completed: true,
    response: finalResponse,
    teacher: activeTeacher,
    mode: subjectConfig.mode,
    feedback,
    summary,
  };
}

function generateInlineSummary(teacher: string, ctx: DialogueContext): string {
  if (isMcq(ctx.question)) {
    if (teacher === "feynman") {
      return `You answered correctly. The key concept is "${ctx.question.keyword}". ${ctx.question.explanation}`;
    }
    return `The correct answer is ${ctx.question.correctAnswer}: ${ctx.question.explanation}`;
  }
  if (ctx.evalResult) {
    if (teacher === "feynman") {
      return `Good work! You scored ${ctx.evalResult.score}/${ctx.evalResult.maxScore}. ${ctx.evalResult.feedback}`;
    }
    return `Mark: ${ctx.evalResult.score}/${ctx.evalResult.maxScore}. ${ctx.evalResult.feedback}`;
  }
  return "Session completed.";
}

function asToolResponse(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function asErrorResponse(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

function reconstructCompletedResponse(sessionId: string): Record<string, unknown> | null {
  const detail = getSessionDetail(sessionId);
  if (!detail || !detail.questions[0]) return null;

  const q = detail.questions[0];
  const question = typeof q.mcq === "string" ? JSON.parse(q.mcq) : q.mcq;
  const mode = question && "options" in question ? "mcq" : "subjective";

  const feedback: PassiveFeedback = {
    strict: q.feedback_strict as string || "",
    feynman: q.feedback_feynman as string || "",
    recap: q.feedback_recap as string || "",
    kbat: q.feedback_kbat as string || "",
    propernouns: q.feedback_propernouns as string || "",
  };

  return {
    completed: true,
    response: feedback.recap || "(completed)",
    teacher: q.active_teacher,
    mode,
    feedback,
    summary: typeof detail.session.summary === "string"
      ? JSON.parse(detail.session.summary)
      : detail.session.summary,
  };
}

// --- Tool handlers ---

export async function handleListTools() {
  return {
    tools: [
      {
        name: "get_question",
        description:
          "Get a quiz question for a given SPM subject. Returns the question, options (if MCQ), marking_scheme (if subjective), keyword, topic, and a session_id for subsequent answer_loop calls.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "Subject name (e.g. sejarah, bahasa-melayu)",
            },
          },
          required: ["subject"],
        },
      },
      {
        name: "answer_loop",
        description:
          "Submit an answer or continue the dialogue for an active session. First call provides the MCQ answer (A/B/C/D) or essay text. Subsequent calls provide the student's dialogue response. Returns { completed, response, ... } — when completed is true, the session is finished and feedback is included.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID from get_question",
            },
            answer: {
              type: "string",
              description:
                "MCQ answer (A/B/C/D) or essay text on first call, or dialogue text on subsequent calls",
            },
          },
          required: ["session_id", "answer"],
        },
      },
    ],
  };
}

export async function handleGetQuestion(args: Record<string, unknown>) {
  const subject = ((args?.subject as string) || "").toLowerCase();
  if (!subject) {
    return asErrorResponse("subject is required");
  }

  const subjectConfig: SubjectConfig =
    config.subjectConfigs[subject] ||
    config.subjectConfigs["sejarah"] || {
      language: "Bahasa Malaysia",
      instructions: "",
      mode: "mcq",
      teachers: {},
      passiveFeedback: [],
      prompts: { generate: "generate_quiz.txt" },
    };

  const topics = await getParetoTopics(subject);
  if (topics.length === 0) {
    return asErrorResponse(
      `No topics found for subject "${subject}" in Neo4j`
    );
  }

  const selectedTopic = shuffle(topics)[0];
  const topicData = await getTopicWithQuestions(selectedTopic.name);

  const sid = sessionId();

  const question = await generateQuestion({
    topicName: selectedTopic.name,
    topicText: topicData.text,
    examQuestions: topicData.examQuestions,
    subjectInstructions: subjectConfig.instructions,
    mode: subjectConfig.mode,
    sessionId: sid,
  });

  createSession(sid, subject);

  const state: SessionState = {
    sessionId: sid,
    subject,
    subjectConfig,
    topic: selectedTopic,
    topicData,
    question,
    studentAnswer: "",
    correct: false,
    activeTeacher: "feynman",
    status: "awaiting-answer",
    messages: [],
    rounds: 0,
  };
  sessions.set(sid, state);
  saveSessionState(sid, state);

  if (isMcq(question)) {
    return asToolResponse({
      session_id: sid,
      question: question.question,
      options: question.options,
      keyword: question.keyword,
      topic: selectedTopic.name,
      mode: "mcq",
    });
  }

  return asToolResponse({
    session_id: sid,
    question: question.question,
    marking_scheme: question.markingScheme,
    keyword: question.keyword,
    topic: selectedTopic.name,
    mode: "subjective",
  });
}

export async function handleAnswerLoop(args: Record<string, unknown>) {
  const sessionIdArg = args?.session_id as string;
  const answer = args?.answer as string;

  if (!sessionIdArg) return asErrorResponse("session_id is required");
  if (!answer) return asErrorResponse("answer is required");

  const state = sessions.get(sessionIdArg);
  if (!state) {
    return asErrorResponse(
      `Session "${sessionIdArg}" not found. It may have expired or already completed.`
    );
  }
  if (state.status === "complete") {
    const result = reconstructCompletedResponse(sessionIdArg);
    if (result) return asToolResponse(result);
    return asErrorResponse(
      `Session "${sessionIdArg}" is already complete.`
    );
  }

  if (state.status === "awaiting-answer") {
    state.studentAnswer = answer;

    if (isMcq(state.question)) {
      const correct = answer.toUpperCase() === state.question.correctAnswer;
      state.correct = correct;
      state.activeTeacher = correct ? "feynman" : "strict";
    } else {
      const ctx = buildDialogueContext(state);
      const evalResult = await evaluateSubjective(ctx);
      state.evalResult = evalResult;
      state.correct = evalResult.feynmanEligible;
      state.activeTeacher = evalResult.feynmanEligible ? "feynman" : "strict";
    }

    const ctx = buildDialogueContext(state);
    const systemPrompt = buildTeacherPrompt(state.activeTeacher, ctx);

    const initialUserContent = isMcq(state.question)
      ? state.activeTeacher === "feynman"
        ? `The student answered correctly. Engage them on the keyword "${state.question.keyword}".`
        : `The student answered "${answer}" (wrong). The correct answer is "${state.question.correctAnswer}". Engage them.`
      : state.activeTeacher === "feynman"
        ? `The student did well (${state.evalResult?.score}/${state.evalResult?.maxScore}). Engage them.`
        : `The student needs improvement (${state.evalResult?.score}/${state.evalResult?.maxScore}). Engage them.`;

    state.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: initialUserContent },
    ];

    const raw = await callLLMStructured<unknown>(state.messages, {
      sessionId: state.sessionId,
    });
    const teacherMsg = asTeacherResponse(raw);
    state.messages.push({
      role: "assistant",
      content: teacherMsg.message,
    });
    saveSessionState(state.sessionId, state);

    state.status = "in-dialogue";
    state.rounds = 0;

    return asToolResponse({
      completed: false,
      response: teacherMsg.message,
      teacher: state.activeTeacher,
      eval: state.evalResult
        ? { score: state.evalResult.score, maxScore: state.evalResult.maxScore }
        : undefined,
    });
  }

  if (state.status === "in-dialogue") {
    state.rounds++;

    state.messages.push({ role: "user", content: answer });

    if (state.rounds >= MAX_ROUNDS) {
      return asToolResponse(await completeSessionAndGetResult(state));
    }

    const raw = await callLLMStructured<unknown>(state.messages, {
      sessionId: state.sessionId,
    });
    const teacherMsg = asTeacherResponse(raw);
    state.messages.push({
      role: "assistant",
      content: teacherMsg.message,
    });
    saveSessionState(state.sessionId, state);

    return asToolResponse({
      completed: false,
      response: teacherMsg.message,
    });
  }

  return asErrorResponse(`Unexpected session status: ${state.status}`);
}

async function main() {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): Server {
    const srv = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );
    srv.setRequestHandler(ListToolsRequestSchema, handleListTools);
    srv.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case "get_question":
            return await handleGetQuestion(args ?? {});
          case "answer_loop":
            return await handleAnswerLoop(args ?? {});
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return asErrorResponse(message);
      }
    });
    return srv;
  }

  function bufferBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: "use /mcp" })
        );
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionIdHeader ? transports.get(sessionIdHeader) : undefined;

      if (!transport) {
        let newSessionId: string | undefined;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId ??= crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
          onsessionclosed: (sid) => {
            transports.delete(sid);
          },
        });
        await createServer().connect(transport);
      }

      const bodyStr = await bufferBody(req);

      let rpcMethod: string | undefined;
      if (bodyStr) {
        try {
          rpcMethod = JSON.parse(bodyStr).method;
        } catch {
          // not JSON-RPC
        }
      }

      if (config.mcpLogRequests) {
        const tag = sessionIdHeader ? sessionIdHeader.slice(0, 8) : "new";
        console.error(`  ⇄  ${req.method} /mcp [${tag}] ${rpcMethod ?? "—"}`);
      }

      const parsedBody = bodyStr ? JSON.parse(bodyStr) : undefined;
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            id: null,
          })
        );
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.error(
      `spm-ai MCP server listening on http://localhost:${PORT}/mcp`
    );
  });
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}

process.on("SIGINT", async () => {
  await closeDb();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeDb();
  process.exit(0);
});

// --- Exports for testing ---
export {
  sessions,
  sessionId,
  shuffle,
  completeSessionAndGetResult,
  asToolResponse,
  asErrorResponse,
};
