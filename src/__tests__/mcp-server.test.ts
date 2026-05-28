import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../agents/generator.js", () => ({
  generateQuestion: vi.fn(),
}));

vi.mock("../agents/teachers.js", () => ({
  buildActiveRecallPrompt: vi.fn(),
  recapFeedback: vi.fn(),
  extractProperNouns: vi.fn(),
  generateRecapSummary: vi.fn(),
  evaluateSubjectiveAnswer: vi.fn(),
  analyzeKnowledgeGaps: vi.fn(),
}));

vi.mock("../agents/llm.js", () => ({
  callLLMStructured: vi.fn(),
}));

vi.mock("../db/neo4j.js", () => ({
  getParetoTopics: vi.fn(),
  getTopicWithQuestions: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/sqlite.js", () => ({
  createSession: vi.fn(),
  checkSession: vi.fn(),
  saveQuestionLog: vi.fn(),
  saveActiveRecallMessage: vi.fn(),
  saveFeedback: vi.fn(),
  completeSession: vi.fn(),
  getUsedQuestions: vi.fn(),
  getActiveRecall: vi.fn(),
  getFeedbacks: vi.fn(),
  getSessionDetail: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    subjectConfigs: {
      sejarah: {
        language: "Bahasa Malaysia",
        instructions: "Test instructions",
        mode: "mcq",
        feedbacks: ["summary", "recap", "propernouns", "gap_analysis"],
        prompts: { generate: "generate_quiz.txt" },
      },
    },
    paretoPercent: 0.2,
    maxActiveRounds: 3,
    examContextLimit: 5,
  },
}));

import {
  handleListTools,
  handleGetQuestion,
  handleAnswerLoop,
  handleRegenerateSession,
  sessions,
} from "../mcp-server.js";

import { generateQuestion } from "../agents/generator.js";
import { buildActiveRecallPrompt, recapFeedback, extractProperNouns, generateRecapSummary, analyzeKnowledgeGaps } from "../agents/teachers.js";
import { callLLMStructured } from "../agents/llm.js";
import { getParetoTopics, getTopicWithQuestions } from "../db/neo4j.js";
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
} from "../db/sqlite.js";

const mockTopicSummary = {
  name: "Kemerdekaan Tanah Melayu",
  subject: "Sejarah",
  form: "5",
  chapter: "3",
  questionCount: 10,
};

const mockTopicWithQuestions = {
  name: "Kemerdekaan Tanah Melayu",
  text: "Tanah Melayu achieved independence on 31 August 1957.",
  examQuestions: ["Describe the process of independence."],
};

const mockMCQ = {
  question: "Bilakah Tanah Melayu mencapai kemerdekaan?",
  options: ["A. 1955", "B. 1957", "C. 1963", "D. 1965"] as [string, string, string, string],
  correctAnswer: "B" as const,
  explanation: "Tanah Melayu achieved independence on 31 August 1957.",
  keyword: "Kemerdekaan",
};

function parseToolResponse(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

describe("MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessions.clear();
  });

  describe("handleListTools", () => {
    it("should return both tools with correct names", async () => {
      const result = await handleListTools();

      expect(result.tools).toHaveLength(3);
      expect(result.tools[0].name).toBe("get_question");
      expect(result.tools[1].name).toBe("answer_loop");
      expect(result.tools[2].name).toBe("regenerate_session");

      expect(result.tools[0].inputSchema.required).toContain("subject");
      expect(result.tools[1].inputSchema.required).toContain("session_id");
      expect(result.tools[1].inputSchema.required).toContain("answer");
      expect(result.tools[2].inputSchema.required).toContain("session_id");
      expect(result.tools[2].inputSchema.required).toContain("user_id");
    });
  });

  describe("handleGetQuestion", () => {
    it("should return a question for a valid subject", async () => {
      (getParetoTopics as Mock).mockResolvedValue([mockTopicSummary]);
      (getTopicWithQuestions as Mock).mockResolvedValue(mockTopicWithQuestions);
      (getUsedQuestions as Mock).mockReturnValue([]);
      (generateQuestion as Mock).mockResolvedValue(mockMCQ);

      const result = await handleGetQuestion({ subject: "sejarah" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.session_id).toBeDefined();
      expect(data.session_id).toMatch(/^\d{4}-\d{2}-\d{2}-mcp-/);
      expect(data.question).toBe(mockMCQ.question);
      expect(data.options).toEqual(mockMCQ.options);
      expect(data.keyword).toBe(mockMCQ.keyword);
      expect(data.topic).toBe(mockTopicSummary.name);
      expect(data.mode).toBe("mcq");

      expect(sessions.size).toBe(1);
      expect(sessions.get(data.session_id)!.subject).toBe("sejarah");
      expect(sessions.get(data.session_id)!.status).toBe("awaiting-answer");

      expect(createSession).toHaveBeenCalledOnce();
      expect(generateQuestion).toHaveBeenCalledOnce();
      expect(getUsedQuestions).toHaveBeenCalledOnce();
    });

    it("should error when subject is empty", async () => {
      const result = await handleGetQuestion({ subject: "" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBe(true);
      expect(data.error).toContain("subject is required");
    });

    it("should error when no topics found in Neo4j", async () => {
      (getParetoTopics as Mock).mockResolvedValue([]);

      const result = await handleGetQuestion({ subject: "unknown" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBe(true);
      expect(data.error).toContain("No topics found");
    });
  });

  describe("handleAnswerLoop", () => {
    const testSessionId = "2026-05-22-mcp-test";

    beforeEach(() => {
      sessions.set(testSessionId, {
        sessionId: testSessionId,
        subject: "sejarah",
        subjectConfig: {
          language: "Bahasa Malaysia",
          instructions: "",
          mode: "mcq",
          feedbacks: ["summary", "recap", "propernouns", "gap_analysis"],
          prompts: { generate: "generate_quiz.txt" },
        },
        topic: mockTopicSummary,
        topicData: mockTopicWithQuestions,
        question: mockMCQ,
        studentAnswer: "",
        status: "awaiting-answer",
        rounds: 0,
        systemPrompt: "",
      });
    });

    it("should error when session_id is missing", async () => {
      const result = await handleAnswerLoop({ answer: "A" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBe(true);
      expect(data.error).toContain("session_id");
    });

    it("should error when answer is missing", async () => {
      const result = await handleAnswerLoop({ session_id: testSessionId });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBe(true);
      expect(data.error).toContain("answer");
    });

    it("should error on unknown session", async () => {
      const result = await handleAnswerLoop({ session_id: "nonexistent", answer: "A" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBe(true);
      expect(data.error).toContain("not found");
    });

    it("should return final response for already completed session", async () => {
      sessions.set("completed-session", {
        sessionId: "completed-session",
        subject: "sejarah",
        subjectConfig: {
          language: "Bahasa Malaysia",
          instructions: "",
          mode: "mcq",
          feedbacks: ["summary", "recap", "propernouns", "gap_analysis"],
          prompts: { generate: "generate_quiz.txt" },
        },
        topic: mockTopicSummary,
        topicData: mockTopicWithQuestions,
        question: mockMCQ,
        studentAnswer: "A",
        status: "complete",
        rounds: 0,
        systemPrompt: "",
      });
      (getSessionDetail as Mock).mockReturnValue({
        session: { summary: '{"total":1}' },
        questions: [{
          question: mockMCQ.question,
          options: JSON.stringify(mockMCQ.options),
          correct_answer: mockMCQ.correctAnswer,
        }],
        activeRecall: [
          { role: "system", content: "prompt" },
          { role: "user", content: "initial" },
          { role: "assistant", content: "Final response" },
        ],
        feedbacks: [
          { instructor: "recap", text: "recap feedback" },
          { instructor: "propernouns", text: "• Tunku Abdul Rahman — Ketua Menteri pertama" },
        ],
      });

      const result = await handleAnswerLoop({ session_id: "completed-session", answer: "A" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.response).toBe("recap feedback");
      expect(data.feedbacks).toBeDefined();
      expect(data.summary).toBeDefined();
    });

    it("should start active recall on first answer", async () => {
      (buildActiveRecallPrompt as Mock).mockReturnValue("active recall system prompt");
      (callLLMStructured as Mock).mockResolvedValue({
        message: "Tell me about Kemerdekaan.",
        complete: false,
      });

      const result = await handleAnswerLoop({ session_id: testSessionId, answer: "B" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(false);
      expect(data.response).toBe("Tell me about Kemerdekaan.");
      expect(data.round).toBe(0);

      expect(buildActiveRecallPrompt).toHaveBeenCalledOnce();
      expect(saveActiveRecallMessage).toHaveBeenCalledTimes(3); // system, user, assistant

      const state = sessions.get(testSessionId)!;
      expect(state.status).toBe("in-dialogue");
      expect(state.studentAnswer).toBe("B");
    });

    it("should complete session after max active recall rounds", async () => {
      (buildActiveRecallPrompt as Mock).mockReturnValue("active recall system prompt");
      (callLLMStructured as Mock).mockResolvedValueOnce({
        message: "First question?",
        complete: false,
      });

      const first = await handleAnswerLoop({ session_id: testSessionId, answer: "B" });
      const { data: firstData } = parseToolResponse(first);
      expect(firstData.completed).toBe(false);
      expect(firstData.response).toBe("First question?");

      // Set state to in-dialogue with 2 rounds already done
      const state = sessions.get(testSessionId)!;
      state.status = "in-dialogue";
      state.rounds = 2;

      (getActiveRecall as Mock).mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Begin" },
        { role: "assistant", content: "First question?" },
        { role: "user", content: "Malayan Union" },
        { role: "assistant", content: "Good" },
        { role: "user", content: "Saya faham." },
      ]);
      (recapFeedback as Mock).mockResolvedValue("recap content");
      (extractProperNouns as Mock).mockResolvedValue(
        "• Tunku Abdul Rahman — Ketua Menteri pertama"
      );
      (generateRecapSummary as Mock).mockResolvedValue(
        'The key concept is "Kemerdekaan". Tanah Melayu achieved independence on 31 August 1957.'
      );
      (analyzeKnowledgeGaps as Mock).mockResolvedValue("");

      const second = await handleAnswerLoop({
        session_id: testSessionId,
        answer: "Saya faham.",
      });
      const { isError, data } = parseToolResponse(second);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.feedbacks).toBeDefined();
      expect(data.summary).toBeDefined();
      expect(data.mode).toBe("mcq");
      expect(data.response).toContain("─── Feedback Summary ───");
      expect(data.response).toContain("[Recap]");
      expect(data.response).toContain("[Kata Nama Khas]");

      expect(saveActiveRecallMessage).toHaveBeenCalled();
      expect(saveFeedback).toHaveBeenCalledTimes(3);
      expect(saveQuestionLog).toHaveBeenCalledOnce();
      expect(completeSession).toHaveBeenCalledOnce();

      expect(sessions.get(testSessionId)!.status).toBe("complete");
    });

    it("should complete when LLM signals complete before max rounds", async () => {
      (buildActiveRecallPrompt as Mock).mockReturnValue("active recall system prompt");
      (callLLMStructured as Mock).mockResolvedValueOnce({
        message: "First question?",
        complete: false,
      });

      const first = await handleAnswerLoop({ session_id: testSessionId, answer: "B" });
      const { data: firstData } = parseToolResponse(first);
      expect(firstData.completed).toBe(false);

      // Second round — LLM signals complete
      (getActiveRecall as Mock).mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Begin" },
        { role: "assistant", content: "First question?" },
        { role: "user", content: "Saya faham." },
      ]);
      (callLLMStructured as Mock).mockResolvedValueOnce({
        message: "Great, you understand!",
        complete: true,
      });
      (recapFeedback as Mock).mockResolvedValue("recap content");
      (extractProperNouns as Mock).mockResolvedValue("");
      (generateRecapSummary as Mock).mockResolvedValue("summary");
      (analyzeKnowledgeGaps as Mock).mockResolvedValue("");

      const second = await handleAnswerLoop({
        session_id: testSessionId,
        answer: "Saya faham.",
      });
      const { isError, data } = parseToolResponse(second);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.response).toContain("─── Feedback Summary ───");
      expect(data.response).not.toContain("[Kata Nama Khas]");
    });
  });

  describe("handleRegenerateSession", () => {
    it("should error when session_id is missing", async () => {
      const result = await handleRegenerateSession({ user_id: "user1" });
      const { isError, data } = parseToolResponse(result);
      expect(isError).toBe(true);
      expect(data.error).toContain("session_id");
    });

    it("should error when user_id is missing", async () => {
      const result = await handleRegenerateSession({ session_id: "s1" });
      const { isError, data } = parseToolResponse(result);
      expect(isError).toBe(true);
      expect(data.error).toContain("user_id");
    });

    it("should error on ownership mismatch", async () => {
      (checkSession as Mock).mockReturnValue(false);
      const result = await handleRegenerateSession({ session_id: "s1", user_id: "user1" });
      const { isError, data } = parseToolResponse(result);
      expect(isError).toBe(true);
      expect(data.error).toContain("not found");
    });

    it("should return completed session data", async () => {
      (checkSession as Mock).mockReturnValue(true);
      (getSessionDetail as Mock).mockReturnValue({
        session: { completed_at: "2026-01-01", summary: '{"total":1}' },
        questions: [{ question: "Q?", options: '["A","B","C","D"]', correct_answer: "A" }],
        activeRecall: [],
        feedbacks: [{ instructor: "summary", text: "Great job" }],
      });

      const result = await handleRegenerateSession({ session_id: "s1", user_id: "user1" });
      const { isError, data } = parseToolResponse(result);
      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.response).toBe("Great job");
    });

    it("should return question when session has no dialogue", async () => {
      (checkSession as Mock).mockReturnValue(true);
      (getSessionDetail as Mock).mockReturnValue({
        session: { completed_at: null },
        questions: [{ question: "Q1?", options: '["A. X","B. Y","C. Z","D. W"]', keyword: "key", topic: "T" }],
        activeRecall: [],
        feedbacks: [],
      });

      const result = await handleRegenerateSession({ session_id: "s1", user_id: "user1" });
      const { isError, data } = parseToolResponse(result);
      expect(isError).toBeFalsy();
      expect(data.status).toBe("question");
      expect(data.question).toBe("Q1?");
      expect(data.options).toHaveLength(4);
    });
  });
});
