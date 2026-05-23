import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../agents/generator.js", () => ({
  generateMCQ: vi.fn(),
}));

vi.mock("../agents/teachers.js", () => ({
  buildFeynmanPrompt: vi.fn(),
  buildStrictPrompt: vi.fn(),
  passiveFeedback: vi.fn(),
  passiveSummaries: vi.fn(),
}));

vi.mock("../agents/llm.js", () => ({
  callLLM: vi.fn(),
}));

vi.mock("../db/neo4j.js", () => ({
  getParetoTopics: vi.fn(),
  getTopicWithQuestions: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/sqlite.js", () => ({
  createSession: vi.fn(),
  saveQuestionLog: vi.fn(),
  completeSession: vi.fn(),
  saveSessionState: vi.fn(),
  getSessionDetail: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    subjectConfigs: {
      sejarah: { language: "Bahasa Malaysia", instructions: "Test instructions" },
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
  sessions,
} from "../mcp-server.js";

import { generateMCQ } from "../agents/generator.js";
import { buildFeynmanPrompt, buildStrictPrompt, passiveFeedback, passiveSummaries } from "../agents/teachers.js";
import { callLLM } from "../agents/llm.js";
import { getParetoTopics, getTopicWithQuestions } from "../db/neo4j.js";
import { createSession, saveQuestionLog, completeSession, getSessionDetail } from "../db/sqlite.js";

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
  options: ["1955", "1957", "1963", "1965"] as [string, string, string, string],
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

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("get_question");
      expect(result.tools[1].name).toBe("answer_loop");

      expect(result.tools[0].inputSchema.required).toContain("subject");
      expect(result.tools[1].inputSchema.required).toContain("session_id");
      expect(result.tools[1].inputSchema.required).toContain("answer");
    });
  });

  describe("handleGetQuestion", () => {
    it("should return a question for a valid subject", async () => {
      (getParetoTopics as Mock).mockResolvedValue([mockTopicSummary]);
      (getTopicWithQuestions as Mock).mockResolvedValue(mockTopicWithQuestions);
      (generateMCQ as Mock).mockResolvedValue(mockMCQ);

      const result = await handleGetQuestion({ subject: "sejarah" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.session_id).toBeDefined();
      expect(data.session_id).toMatch(/^\d{4}-\d{2}-\d{2}-mcp-/);
      expect(data.question).toBe(mockMCQ.question);
      expect(data.options).toEqual(mockMCQ.options);
      expect(data.keyword).toBe(mockMCQ.keyword);
      expect(data.topic).toBe(mockTopicSummary.name);

      expect(sessions.size).toBe(1);
      expect(sessions.get(data.session_id)!.subject).toBe("sejarah");
      expect(sessions.get(data.session_id)!.status).toBe("awaiting-answer");

      expect(createSession).toHaveBeenCalledOnce();
      expect(generateMCQ).toHaveBeenCalledOnce();
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
        subjectConfig: { language: "Bahasa Malaysia", instructions: "" },
        topic: mockTopicSummary,
        topicData: mockTopicWithQuestions,
        mcq: mockMCQ,
        studentAnswer: "",
        correct: false,
        activeTeacher: "feynman",
        status: "awaiting-answer",
        messages: [],
        rounds: 0,
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
        subjectConfig: { language: "Bahasa Malaysia", instructions: "" },
        topic: mockTopicSummary,
        topicData: mockTopicWithQuestions,
        mcq: mockMCQ,
        studentAnswer: "A",
        correct: false,
        activeTeacher: "strict",
        status: "complete",
        messages: [],
        rounds: 0,
      });
      (getSessionDetail as Mock).mockReturnValue({
        session: { summary: '{"total":1,"answered":1,"correct":1}' },
        questions: [{
          dialogue: JSON.stringify([
            { role: "system", content: "prompt" },
            { role: "user", content: "initial" },
            { role: "assistant", content: "Final response from tutor." },
          ]),
          active_teacher: "feynman",
          feedback_strict: "strict summary",
          feedback_feynman: "feynman summary",
          feedback_recap: "recap feedback",
          feedback_kbat: "kbat feedback",
        }],
      });

      const result = await handleAnswerLoop({ session_id: "completed-session", answer: "A" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.response).toBe("Final response from tutor.");
      expect(data.teacher).toBe("feynman");
      expect(data.feedback).toBeDefined();
      expect(data.summary).toBeDefined();
    });

    it("should start Feynman dialogue on correct answer", async () => {
      (buildFeynmanPrompt as Mock).mockReturnValue("feynman system prompt");
      (callLLM as Mock).mockResolvedValue({
        content: "Great! Tell me about Kemerdekaan.",
        dialogueComplete: false,
      });

      const result = await handleAnswerLoop({ session_id: testSessionId, answer: "B" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(false);
      expect(data.response).toBe("Great! Tell me about Kemerdekaan.");
      expect(data.teacher).toBe("feynman");

      expect(buildFeynmanPrompt).toHaveBeenCalledOnce();
      expect(buildStrictPrompt).not.toHaveBeenCalled();

      const state = sessions.get(testSessionId)!;
      expect(state.status).toBe("in-dialogue");
      expect(state.correct).toBe(true);
      expect(state.studentAnswer).toBe("B");
    });

    it("should start Strict dialogue on wrong answer", async () => {
      (buildStrictPrompt as Mock).mockReturnValue("strict system prompt");
      (callLLM as Mock).mockResolvedValue({
        content: "The correct answer is B.",
        dialogueComplete: false,
      });

      const result = await handleAnswerLoop({ session_id: testSessionId, answer: "A" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(false);
      expect(data.response).toBe("The correct answer is B.");
      expect(data.teacher).toBe("strict");

      expect(buildStrictPrompt).toHaveBeenCalledOnce();
      expect(buildFeynmanPrompt).not.toHaveBeenCalled();

      const state = sessions.get(testSessionId)!;
      expect(state.status).toBe("in-dialogue");
      expect(state.correct).toBe(false);
    });

    it("should complete session immediately when LLM signals dialogueComplete on first call", async () => {
      (buildFeynmanPrompt as Mock).mockReturnValue("feynman system prompt");
      (callLLM as Mock).mockResolvedValue({
        content: "All done!",
        dialogueComplete: true,
      });
      (passiveFeedback as Mock).mockResolvedValue("feedback content");
      (passiveSummaries as Mock).mockResolvedValue({
        strict: "strict summary",
        feynman: "feynman summary",
      });

      const result = await handleAnswerLoop({ session_id: testSessionId, answer: "B" });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
      expect(data.feedback).toBeDefined();
      expect(data.feedback.strict).toBe("strict summary");
      expect(data.feedback.feynman).toBe("feynman summary");
      expect(data.summary).toBeDefined();

      expect(saveQuestionLog).toHaveBeenCalledOnce();
      expect(completeSession).toHaveBeenCalledOnce();

      const state = sessions.get(testSessionId)!;
      expect(state.status).toBe("complete");
    });

    it("should continue dialogue on subsequent calls", async () => {
      // Use wrong answer so Strict teacher is activated (still allows 3 rounds)
      (buildStrictPrompt as Mock).mockReturnValue("strict system prompt");
      (callLLM as Mock).mockResolvedValueOnce({
        content: "The correct answer is B.",
        dialogueComplete: false,
      });

      await handleAnswerLoop({ session_id: testSessionId, answer: "A" });

      (callLLM as Mock).mockResolvedValueOnce({
        content: "That's interesting!",
        dialogueComplete: false,
      });

      const result = await handleAnswerLoop({
        session_id: testSessionId,
        answer: "The independence was in 1957.",
      });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(false);
      expect(data.response).toBe("That's interesting!");

      const state = sessions.get(testSessionId)!;
      expect(state.rounds).toBe(1);
      expect(state.messages).toHaveLength(5);
    });

    it("should complete session when dialogueComplete is true on subsequent call", async () => {
      (buildFeynmanPrompt as Mock).mockReturnValue("feynman system prompt");
      (callLLM as Mock).mockResolvedValueOnce({
        content: "Tell me more!",
        dialogueComplete: false,
      });
      await handleAnswerLoop({ session_id: testSessionId, answer: "B" });

      (callLLM as Mock).mockResolvedValueOnce({
        content: "Great session!",
        dialogueComplete: true,
      });
      (passiveFeedback as Mock).mockResolvedValue("feedback");
      (passiveSummaries as Mock).mockResolvedValue({ strict: "s", feynman: "f" });

      const result = await handleAnswerLoop({
        session_id: testSessionId,
        answer: "I understand now.",
      });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
    });

    it("should auto-complete when max rounds reached", async () => {
      (buildFeynmanPrompt as Mock).mockReturnValue("feynman system prompt");
      (callLLM as Mock).mockResolvedValueOnce({
        content: "Tell me more!",
        dialogueComplete: false,
      });
      await handleAnswerLoop({ session_id: testSessionId, answer: "B" });

      const state = sessions.get(testSessionId)!;
      state.rounds = 2;

      (callLLM as Mock).mockResolvedValueOnce({
        content: "Last round!",
        dialogueComplete: false,
      });
      (passiveFeedback as Mock).mockResolvedValue("feedback");
      (passiveSummaries as Mock).mockResolvedValue({ strict: "s", feynman: "f" });

      const result = await handleAnswerLoop({
        session_id: testSessionId,
        answer: "I understand.",
      });
      const { isError, data } = parseToolResponse(result);

      expect(isError).toBeFalsy();
      expect(data.completed).toBe(true);
    });
  });
});
