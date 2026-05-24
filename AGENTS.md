# spm-ai — SPM AI Tutor

## Overview
AI-powered CLI tutor for SPM (Malaysian high school) exam preparation. Generates MCQs from Neo4j topic graph, runs Feynman/Strict dialogue via LLM, persists sessions to SQLite.

## Tech Stack
- **Runtime:** Node.js 22+, ESM (`"type": "module"`)
- **Language:** TypeScript (ES2022), strict mode
- **Build:** `tsc` → `dist/`, dev via `tsx`
- **Key deps:** `@modelcontextprotocol/sdk`, `openai`, `neo4j-driver`, `better-sqlite3`, `vitest`

## Project Structure
```
src/
  mcp-server.ts         — MCP server (StreamableHTTP, transport-per-session)
  main.ts               — CLI entry (commander)
  config.ts             — env-based config
  types.ts              — shared TypeScript interfaces
  agents/
    coordinator.ts      — quiz orchestrator (CLI flow)
    generator.ts        — MCQ generation + keyword validation
    llm.ts              — OpenRouter LLM client + JSONL logging
    teachers.ts         — Feynman/Strict dialogue + passive feedback
  db/
    neo4j.ts            — topic graph queries (getParetoTopics, etc.)
    sqlite.ts           — session persistence (sessions + question_logs tables)
  __tests__/
    mcp-server.test.ts  — 14 tests for MCP tool handlers
prompts/                — LLM system prompt templates (*.txt)
.stage/llm/             — LLM request/response JSONL logs
```

## MCP Server (`src/mcp-server.ts`)
- **Protocol:** StreamableHTTP (`@modelcontextprotocol/sdk` v1.29.0)
- **Endpoint:** `POST /mcp`
- **Transport:** One `StreamableHTTPServerTransport` per MCP session (keyed by `Mcp-Session-Id` header)
- **Options:** `sessionIdGenerator`, `enableJsonResponse: true`
- **Tools:**
  - `get_question` — generates MCQ from Neo4j topic, returns session_id
  - `answer_loop` — evaluate answer, run Feynman/Strict dialogue, return feedback
- **Request logging:** Enabled via `MCP_LOG_REQUESTS=on` in `.env`
- **Multi-transport pattern:** New `Server` instance per transport via `createServer()` factory

## Session Lifecycle
1. `get_question` → MCQ generated, SQLite session created, `session_state` persisted
2. `answer_loop` (first call) → answer evaluated, teacher activated, LLM called
3. `answer_loop` (subsequent) → dialogue continues, `session_state` saved after each mutation
4. Completion → passive feedback generated, `question_logs` saved, summary written
- Replay: completed session IDs return final response from DB instead of error

## Teacher Behaviour
- **Feynman** (correct answer): 1 dialogue round, explain keyword in own words
- **Strict** (wrong answer): 3 dialogue rounds (`maxActiveRounds` in config)
- Dialogue end: LLM signals `DIALOGUE_COMPLETE: true` OR max rounds reached

## Database (`sessions.db`)
```sql
sessions (id, user_id, subject, started_at, completed_at, summary, session_state)
question_logs (id, session_id, seq, topic, mcq, student_answer, correct, ...feedback columns)
```

## Environment Variables (`.env`)
```
OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_BASE_URL
NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
LOG_LLM (off|truncated|full)
MCP_LOG_REQUESTS (on|off)
MCP_PORT (default 3100)
```

## Testing
```bash
npm test          # vitest run
npm run test:watch
```
- Tests mock all external deps (Neo4j, SQLite, LLM, Config)
- 14 tests covering listTools, get_question, answer_loop paths
- No real databases or API calls

## Commands
```bash
npm run mcp       # start MCP server (tsx src/mcp-server.ts)
npm run dev       # start CLI (tsx src/main.ts)
npm run build     # tsc compile
npm start         # run compiled CLI
```
