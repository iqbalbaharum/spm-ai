export type QuizMode = "mcq" | "subjective";

export interface MCQ {
  question: string;
  options: [string, string, string, string];
  correctAnswer: "A" | "B" | "C" | "D";
  explanation: string;
  keyword: string;
}

export interface SubjectiveQuestion {
  question: string;
  markingScheme: string;
  keyword: string;
}

export type QuizQuestion = MCQ | SubjectiveQuestion;

export function isMcq(q: QuizQuestion): q is MCQ {
  return "options" in q;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  sessionId?: string;
}

export interface GeneratorInput {
  topicName: string;
  topicText: string;
  examQuestions: string[];
  subjectInstructions: string;
  mode: QuizMode;
  sessionId?: string;
  usedQuestions?: string[];
}

export interface ActiveRecallMessage {
  id?: number;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt?: string;
}

export interface FeedbackRecord {
  id?: number;
  sessionId: string;
  instructor: string;
  text: string;
  createdAt?: string;
}

export interface DialogueContext {
  question: QuizQuestion;
  studentAnswer: string;
  topic: string;
  topicText: string;
  examQuestions: string[];
  subjectInstructions: string;
  sessionId?: string;
  usedQuestions?: string[];
}

export interface QuestionRecord {
  seq: number;
  topic: string;
  question: QuizQuestion;
  studentAnswer: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  subject: string;
  startedAt: string;
  completedAt: string | null;
  questions: QuestionRecord[];
}

export interface TopicSummary {
  name: string;
  subject: string;
  form: string;
  chapter: string;
  questionCount: number;
}

export interface SubjectConfig {
  language: string;
  instructions: string;
  mode: QuizMode;
  feedbacks: string[];
  prompts: {
    generate: string;
  };
}

export interface TopicWithQuestions {
  name: string;
  text: string;
  examQuestions: string[];
}

export interface ActiveRecallResponse {
  message: string;
  complete: boolean;
}
