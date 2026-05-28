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
  buildActiveRecallPrompt,
  recapFeedback,
  extractProperNouns,
  generateRecapSummary,
  evaluateSubjectiveAnswer,
  analyzeKnowledgeGaps,
} from "./agents/teachers.js";
import { callActiveRecallWithRetry } from "./agents/active-recall.js";
import { getParetoTopics, getTopicWithQuestions, closeDb } from "./db/neo4j.js";
import {
  createSession,
  checkSession,
  saveQuestionLog,
  saveActiveRecallMessage,
  saveFeedback,
  completeSession,
  getUsedQuestions,
  getActiveRecall,
  getFeedbacks,
  getSessionDetail,
} from "./db/sqlite.js";
import { config } from "./config.js";
import type {
  ChatMessage,
  QuizQuestion,
  DialogueContext,
  SubjectConfig,
  TopicSummary,
  TopicWithQuestions,
} from "./types.js";
import { isMcq } from "./types.js";

const SERVER_NAME = "spm-ai-mcp";
const SERVER_VERSION = "0.1.0";
const PORT = parseInt(process.env.MCP_PORT || "3100", 10);

const MAX_ACTIVE_RECALL_ROUNDS = 3;

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
  status: "awaiting-answer" | "in-dialogue" | "complete";
  rounds: number;
  systemPrompt: string;
}

const sessions = new Map<string, SessionState>();

function buildDialogueContext(state: SessionState): DialogueContext {
  return {
    question: state.question,
    studentAnswer: state.studentAnswer,
    topic: state.topic.name,
    topicText: state.topicData.text,
    examQuestions: state.topicData.examQuestions,
    subjectInstructions: state.subjectConfig.instructions,
    sessionId: state.sessionId,
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
  const mode = q.options ? "mcq" : "subjective";

  const feedbacks = detail.feedbacks.map((f) => ({
    instructor: f.instructor as string,
    text: f.text as string,
  }));

  const summaryFeedback = feedbacks.find((f) => f.instructor === "summary");
  const response = summaryFeedback?.text || feedbacks[0]?.text || "(completed)";

  const summary = typeof detail.session.summary === "string"
    ? JSON.parse(detail.session.summary)
    : detail.session.summary;

  return {
    completed: true,
    response,
    mode,
    feedbacks,
    summary,
  };
}

export async function handleRegenerateSession(args: Record<string, unknown>) {
  const sessionId = args?.session_id as string;
  const userId = args?.user_id as string;

  if (!sessionId) return asErrorResponse("session_id is required");
  if (!userId) return asErrorResponse("user_id is required");

  if (!checkSession(sessionId, userId)) {
    return asErrorResponse("Session not found or does not belong to this user");
  }

  const detail = getSessionDetail(sessionId);
  if (!detail) return asErrorResponse("Session not found");

  // Case 1: Session completed → redisplay summary
  if (detail.session.completed_at) {
    const completed = reconstructCompletedResponse(sessionId);
    if (completed) return asToolResponse(completed);
    return asToolResponse({
      completed: true,
      response: "(completed)",
      feedbacks: detail.feedbacks,
      summary: detail.session.summary,
    });
  }

  // Case 2: Has active recall
  if (detail.activeRecall.length > 0) {
    const messages: ChatMessage[] = detail.activeRecall.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content as string,
    }));

    const lastMsg = detail.activeRecall[detail.activeRecall.length - 1];

    if (lastMsg.role === "assistant") {
      const rounds = detail.activeRecall.filter((m) => m.role === "assistant").length;
      return asToolResponse({
        status: "dialogue",
        session_id: sessionId,
        response: lastMsg.content,
        round: rounds,
      });
    }

    // Last message is user (eval failed) → regenerate
    const result = await callActiveRecallWithRetry(messages, { sessionId });
    saveActiveRecallMessage(sessionId, "assistant", result.message);

    const rounds = detail.activeRecall.filter((m) => m.role === "assistant").length + 1;
    return asToolResponse({
      status: "regenerated",
      session_id: sessionId,
      response: result.message,
      round: rounds,
    });
  }

  // Case 3: Has question but no dialogue → display question
  if (detail.questions.length > 0) {
    const q = detail.questions[0] as Record<string, unknown>;
    const options = q.options ? JSON.parse(q.options as string) : undefined;
    return asToolResponse({
      status: "question",
      session_id: sessionId,
      question: q.question as string,
      options,
      keyword: q.keyword as string,
      topic: q.topic as string,
      mode: options ? "mcq" : "subjective",
    });
  }

  return asErrorResponse("Session has no data to regenerate");
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
            user_id: {
              type: "string",
              description: "User identifier for tracking used questions (e.g. telegram chat ID)",
            },
          },
          required: ["subject"],
        },
      },
      {
        name: "answer_loop",
        description:
          "Submit an answer or continue the active recall for an active session. First call provides the MCQ answer (A/B/C/D) or essay text. Subsequent calls provide the student's dialogue response. Returns { completed, response, ... } — when completed is true, the session is finished and feedbacks are included.",
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
      {
        name: "regenerate_session",
        description:
          "Redisplay or regenerate a session's last interaction. Returns the question (if no answer submitted), last dialogue response, or completed summary. Regenerates (re-calls LLM) only when the last active recall message has no assistant response. Ownership check via user_id.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Session ID to regenerate",
            },
            user_id: {
              type: "string",
              description: "User identifier for ownership validation",
            },
          },
          required: ["session_id", "user_id"],
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

  const userId = (args?.user_id as string) || "cli";

  const subjectConfig: SubjectConfig =
    config.subjectConfigs[subject] ||
    config.subjectConfigs["sejarah"] || {
      language: "Bahasa Malaysia",
      instructions: "",
      mode: "mcq",
      feedbacks: [],
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

  const usedQuestions = getUsedQuestions(userId, selectedTopic.name);

  const question = await generateQuestion({
    topicName: selectedTopic.name,
    topicText: topicData.text,
    examQuestions: topicData.examQuestions,
    subjectInstructions: subjectConfig.instructions,
    mode: subjectConfig.mode,
    sessionId: sid,
    usedQuestions,
  });

  createSession(sid, subject, userId);

  const state: SessionState = {
    sessionId: sid,
    subject,
    subjectConfig,
    topic: selectedTopic,
    topicData,
    question,
    studentAnswer: "",
    status: "awaiting-answer",
    rounds: 0,
    systemPrompt: "",
  };
  sessions.set(sid, state);

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
    // Check if session exists in DB (completed/completed session replay)
    const existing = reconstructCompletedResponse(sessionIdArg);
    if (existing) return asToolResponse(existing);
    return asErrorResponse(
      `Session "${sessionIdArg}" not found.`
    );
  }
  if (state.status === "complete") {
    const result = reconstructCompletedResponse(sessionIdArg);
    if (result) return asToolResponse(result);
    return asErrorResponse(
      `Session "${sessionIdArg}" is already complete.`
    );
  }

  // --- First call: user submits answer ---
  if (state.status === "awaiting-answer") {
    state.studentAnswer = answer;
    const ctx = buildDialogueContext(state);

    // Build active recall system prompt
    state.systemPrompt = buildActiveRecallPrompt(ctx);
    saveActiveRecallMessage(state.sessionId, "system", state.systemPrompt);

    // Initial user message to kick off active recall
    const initialUserMsg = isMcq(state.question)
      ? `The student answered "${answer}". Begin the active recall session.`
      : `The student submitted their essay. Begin the active recall session.`;

    saveActiveRecallMessage(state.sessionId, "user", initialUserMsg);

    const messages: ChatMessage[] = [
      { role: "system", content: state.systemPrompt },
      { role: "user", content: initialUserMsg },
    ];

    const result = await callActiveRecallWithRetry(messages, {
      sessionId: state.sessionId,
    });

    saveActiveRecallMessage(state.sessionId, "assistant", result.message);

    state.status = "in-dialogue";
    state.rounds = 0;

    return asToolResponse({
      completed: result.complete,
      response: result.message,
      round: 0,
    });
  }

  // --- Subsequent calls: dialogue rounds ---
  if (state.status === "in-dialogue") {
    state.rounds++;

    saveActiveRecallMessage(state.sessionId, "user", answer);

    if (state.rounds >= MAX_ACTIVE_RECALL_ROUNDS) {
      return asToolResponse(await completeSessionAndGetResult(state));
    }

    // Build messages from saved active recall
    const recall = getActiveRecall(state.sessionId);
    const messages: ChatMessage[] = recall.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));

    const result = await callActiveRecallWithRetry(messages, {
      sessionId: state.sessionId,
    });

    saveActiveRecallMessage(state.sessionId, "assistant", result.message);

    if (result.complete) {
      return asToolResponse(await completeSessionAndGetResult(state));
    }

    return asToolResponse({
      completed: false,
      response: result.message,
      round: state.rounds,
    });
  }

  return asErrorResponse(`Unexpected session status: ${state.status}`);
}

async function completeSessionAndGetResult(
  state: SessionState
): Promise<Record<string, unknown>> {
  const ctx = buildDialogueContext(state);
  const subjectConfig = state.subjectConfig;

  // Determine correctness
  let correct = 0;
  if (isMcq(state.question) && state.question.correctAnswer?.toUpperCase() === state.studentAnswer?.toUpperCase()) {
    correct = 1;
  }

  // Unified feedback loop
  const recall = getActiveRecall(state.sessionId);
  const feedbacks: { instructor: string; text: string }[] = [];

  for (const fb of subjectConfig.feedbacks) {
    let text = "";
    try {
      if (fb === "summary") text = await generateRecapSummary(ctx, recall);
      else if (fb === "recap") text = await recapFeedback(ctx, recall);
      else if (fb === "propernouns") text = await extractProperNouns(ctx, recall);
      else if (fb === "gap_analysis") text = await analyzeKnowledgeGaps(ctx, recall);
    } catch {
      continue;
    }
    if (text) {
      saveFeedback(state.sessionId, fb, text);
      feedbacks.push({ instructor: fb, text });
    }
  }

  // Save question log
  saveQuestionLog(state.sessionId, {
    seq: 1,
    topic: state.topic.name,
    question: state.question,
    studentAnswer: state.studentAnswer,
  });

  completeSession(state.sessionId, { total: 1, answered: 1, correct });

  state.status = "complete";

  return {
    completed: true,
    response: feedbacks.find((f) => f.instructor === "summary")?.text || "(completed)",
    mode: subjectConfig.mode,
    feedbacks,
    summary: { total: 1, answered: 1, correct },
  };
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
          case "regenerate_session":
            return await handleRegenerateSession(args ?? {});
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
