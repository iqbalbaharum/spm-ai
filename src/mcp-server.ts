#!/usr/bin/env node

import http from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { generateMCQ } from "./agents/generator.js";
import {
  buildFeynmanPrompt,
  buildStrictPrompt,
  passiveFeedback,
  passiveSummaries,
} from "./agents/teachers.js";
import { callLLM } from "./agents/llm.js";
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
  MCQ,
  DialogueContext,
  PassiveFeedback,
  QuestionRecord,
  SubjectConfig,
  TopicSummary,
  TopicWithQuestions,
} from "./types.js";

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
  mcq: MCQ;
  studentAnswer: string;
  correct: boolean;
  activeTeacher: "feynman" | "strict";
  status: "awaiting-answer" | "in-dialogue" | "complete";
  messages: ChatMessage[];
  rounds: number;
}

const sessions = new Map<string, SessionState>();

function buildDialogueContext(state: SessionState): DialogueContext {
  return {
    mcq: state.mcq,
    studentAnswer: state.studentAnswer,
    correct: state.correct,
    topic: state.topic.name,
    topicText: state.topicData.text,
    examQuestions: state.topicData.examQuestions,
    subjectInstructions: state.subjectConfig.instructions,
    sessionId: state.sessionId,
  };
}

async function completeSessionAndGetResult(
  state: SessionState
): Promise<Record<string, unknown>> {
  const ctx = buildDialogueContext(state);
  const activeTeacher = state.activeTeacher;

  let recap = "";
  let kbat = "";
  try {
    recap = await passiveFeedback("recap", ctx);
  } catch {
    recap = "(feedback unavailable)";
  }
  try {
    kbat = await passiveFeedback("kbat", ctx);
  } catch {
    kbat = "(feedback unavailable)";
  }

  let summaries = { strict: "", feynman: "" };
  try {
    summaries = await passiveSummaries(activeTeacher, ctx);
  } catch {
    summaries = {
      strict:
        activeTeacher === "feynman"
          ? ctx.mcq.explanation
          : "(feedback unavailable)",
      feynman:
        activeTeacher === "strict"
          ? `The key concept is "${ctx.mcq.keyword}". ${ctx.mcq.explanation}`
          : "(feedback unavailable)",
    };
  }

  const feedback: PassiveFeedback = {
    strict: summaries.strict,
    feynman: summaries.feynman,
    recap,
    kbat,
  };

  const lastAssistantMsg = [...state.messages]
    .reverse()
    .find((m) => m.role === "assistant");

  const record: QuestionRecord = {
    seq: 1,
    topic: state.topic.name,
    mcq: state.mcq,
    studentAnswer: state.studentAnswer,
    correct: state.correct,
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
    response: lastAssistantMsg?.content || "",
    teacher: activeTeacher,
    feedback,
    summary,
  };
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
  const dialogue = typeof q.dialogue === "string" ? JSON.parse(q.dialogue) : q.dialogue;
  const lastAssistantMsg = [...(dialogue as ChatMessage[])]
    .reverse()
    .find((m) => m.role === "assistant");

  return {
    completed: true,
    response: lastAssistantMsg?.content || "",
    teacher: q.active_teacher,
    feedback: {
      strict: q.feedback_strict,
      feynman: q.feedback_feynman,
      recap: q.feedback_recap,
      kbat: q.feedback_kbat,
    },
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
          "Get a quiz question for a given SPM subject. Returns the question, options, keyword, and a session_id for subsequent answer_loop calls.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "Subject name (e.g. sejarah)",
            },
          },
          required: ["subject"],
        },
      },
      {
        name: "answer_loop",
        description:
          "Submit an answer or continue the dialogue for an active session. First call provides the MCQ answer (A/B/C/D). Subsequent calls provide the student's dialogue response. Returns { completed, response, ... } — when completed is true, the session is finished and feedback is included.",
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
                "MCQ answer (A/B/C/D) on first call, or dialogue text on subsequent calls",
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

  const topics = await getParetoTopics(subject);
  if (topics.length === 0) {
    return asErrorResponse(
      `No topics found for subject "${subject}" in Neo4j`
    );
  }

  const selectedTopic = shuffle(topics)[0];
  const topicData = await getTopicWithQuestions(selectedTopic.name);

  const activeSubject: string = (
    selectedTopic.subject || subject
  ).toLowerCase();
  const subjectConfig: SubjectConfig =
    config.subjectConfigs[activeSubject] ||
    config.subjectConfigs["sejarah"] || {
      language: "Bahasa Malaysia",
      instructions: "",
    };

  const sid = sessionId();

  const mcq = await generateMCQ({
    topicName: selectedTopic.name,
    topicText: topicData.text,
    examQuestions: topicData.examQuestions,
    subjectInstructions: subjectConfig.instructions,
    sessionId: sid,
  });

  createSession(sid, activeSubject);

  const state: SessionState = {
    sessionId: sid,
    subject: activeSubject,
    subjectConfig,
    topic: selectedTopic,
    topicData,
    mcq,
    studentAnswer: "",
    correct: false,
    activeTeacher: "feynman",
    status: "awaiting-answer",
    messages: [],
    rounds: 0,
  };
  sessions.set(sid, state);
  saveSessionState(sid, state);

  return asToolResponse({
    session_id: sid,
    question: mcq.question,
    options: mcq.options,
    keyword: mcq.keyword,
    topic: selectedTopic.name,
  });
}

export async function handleAnswerLoop(args: Record<string, unknown>) {
  const sessionId = args?.session_id as string;
  const answer = args?.answer as string;

  if (!sessionId) return asErrorResponse("session_id is required");
  if (!answer) return asErrorResponse("answer is required");

  const state = sessions.get(sessionId);
  if (!state) {
    return asErrorResponse(
      `Session "${sessionId}" not found. It may have expired or already completed.`
    );
  }
  if (state.status === "complete") {
    const result = reconstructCompletedResponse(sessionId);
    if (result) return asToolResponse(result);
    return asErrorResponse(
      `Session "${sessionId}" is already complete.`
    );
  }
  if (state.status === "awaiting-answer") {
    const correct = answer.toUpperCase() === state.mcq.correctAnswer;
    state.studentAnswer = answer;
    state.correct = correct;
    state.activeTeacher = correct ? "feynman" : "strict";

    const ctx = buildDialogueContext(state);

    const systemPrompt =
      state.activeTeacher === "feynman"
        ? buildFeynmanPrompt(ctx)
        : buildStrictPrompt(ctx);

    const initialUserContent =
      state.activeTeacher === "feynman"
        ? `The student answered correctly. Engage them on the keyword "${state.mcq.keyword}".`
        : `The student answered "${answer}" (wrong). The correct answer is "${state.mcq.correctAnswer}". Engage them.`;

    state.messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: initialUserContent },
    ];

    const response = await callLLM(state.messages, {
      sessionId: state.sessionId,
    });
    state.messages.push({
      role: "assistant",
      content: response.content,
    });
    saveSessionState(state.sessionId, state);

    if (response.dialogueComplete) {
      return asToolResponse(await completeSessionAndGetResult(state));
    }

    state.status = "in-dialogue";
    state.rounds = 0;

    return asToolResponse({
      completed: false,
      response: response.content,
      teacher: state.activeTeacher,
    });
  }

  if (state.status === "in-dialogue") {
    state.rounds++;

    state.messages.push({ role: "user", content: answer });

    const response = await callLLM(state.messages, {
      sessionId: state.sessionId,
    });
    state.messages.push({
      role: "assistant",
      content: response.content,
    });
    saveSessionState(state.sessionId, state);

    if (
      response.dialogueComplete ||
      state.rounds >= (state.activeTeacher === "feynman" ? 1 : config.maxActiveRounds)
    ) {
      return asToolResponse(await completeSessionAndGetResult(state));
    }

    return asToolResponse({
      completed: false,
      response: response.content,
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

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

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
        const tag = sessionId ? sessionId.slice(0, 8) : "new";
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
