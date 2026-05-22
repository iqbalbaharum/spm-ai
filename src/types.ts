export interface MCQ {
  question: string;
  options: [string, string, string, string];
  correctAnswer: "A" | "B" | "C" | "D";
  explanation: string;
  keyword: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  dialogueComplete?: boolean;
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
  sessionId?: string;
}

export interface DialogueContext {
  mcq: MCQ;
  studentAnswer: string;
  correct: boolean;
  topic: string;
  topicText: string;
  examQuestions: string[];
  subjectInstructions: string;
  sessionId?: string;
}

export interface PassiveFeedback {
  strict: string;
  feynman: string;
  recap: string;
  kbat: string;
}

export interface QuestionRecord {
  seq: number;
  topic: string;
  mcq: MCQ;
  studentAnswer: string | null;
  correct: boolean | null;
  activeTeacher: "strict" | "feynman" | null;
  dialogue: ChatMessage[];
  feedback: PassiveFeedback;
}

export interface SessionRecord {
  id: string;
  userId: string;
  subject: string;
  startedAt: string;
  completedAt: string | null;
  questions: QuestionRecord[];
  summary: { total: number; answered: number; correct: number };
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
}

export interface TopicWithQuestions {
  name: string;
  text: string;
  examQuestions: string[];
}
