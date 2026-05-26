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
  mode: QuizMode;
  sessionId?: string;
}

export interface EvalResult {
  feynmanEligible: boolean;
  score?: number;
  maxScore?: number;
  feedback: string;
}

export interface DialogueContext {
  question: QuizQuestion;
  studentAnswer: string;
  correct: boolean;
  evalResult?: EvalResult;
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
  propernouns: string;
}

export interface QuestionRecord {
  seq: number;
  topic: string;
  question: QuizQuestion;
  studentAnswer: string | null;
  correct: boolean | null;
  evalResult?: EvalResult | null;
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

export interface TeacherConfig {
  displayName: string;
  prompt: string;
}

export interface SubjectConfig {
  language: string;
  instructions: string;
  mode: QuizMode;
  teachers: Record<string, TeacherConfig>;
  passiveFeedback: string[];
  prompts: {
    generate: string;
  };
}

export interface TopicWithQuestions {
  name: string;
  text: string;
  examQuestions: string[];
}

export interface TeacherResponse {
  message: string;
}
