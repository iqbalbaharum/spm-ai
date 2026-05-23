import "dotenv/config";
import subjectConfigsRaw from "../config/subjects.json" with { type: "json" };
import type { SubjectConfig } from "./types.js";

export const config = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openrouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),

  neo4jUri: process.env.NEO4J_URI || "bolt://localhost:7687",
  neo4jUser: process.env.NEO4J_USER || "neo4j",
  neo4jPassword: process.env.NEO4J_PASSWORD || "",

  paretoPercent: 0.2,
  maxActiveRounds: 3,
  defaultQuizCount: 5,
  examContextLimit: 5,

  subjectConfigs: subjectConfigsRaw as unknown as Record<string, SubjectConfig>,

  logLlm: (process.env.LOG_LLM || "off") as "off" | "truncated" | "full",

  mcpLogRequests: process.env.MCP_LOG_REQUESTS === "on",
};

function missing(key: string): void {
  if (!process.env[key]) console.warn(`  ⚠  ${key} not set in .env`);
}

missing("OPENROUTER_API_KEY");
if (!config.neo4jPassword) missing("NEO4J_PASSWORD");
