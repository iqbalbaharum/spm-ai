# spm-ai

AI-powered CLI tutor for SPM exam preparation. Generates adaptive quizzes from a Neo4j knowledge graph, conducts multi-turn AI dialogues, generates feedback in multiple pedagogical styles, and persists session history in SQLite.

## Quick start

```bash
npm install
cp .env.example .env   # then edit with your API keys
npm run dev -- quiz     # start a quiz
```

## Features

- **Pareto topic selection** — focuses on the top 20% most-examined topics
- **AI-generated MCQs** — with 3-tier keyword validation (LLM → retry → heuristic)
- **Adaptive active tutoring** — Feynman technique on correct answers, strict correction on wrong answers (up to 3 dialogue rounds each)
- **4-style passive feedback** — Strict, Feynman, Recap (summary), KBAT (higher-order thinking question) — every question, every time
- **Session persistence** — full history in SQLite, reviewable via CLI

## Architecture

```
CLI (main.ts)
  └─ coordinator.ts          ← orchestrates the quiz flow
       ├─ neo4j.ts           ← knowledge graph (topics + exam questions)
       ├─ generator.ts       ← MCQ generation via LLM
       ├─ teachers.ts        ← active dialogue + passive feedback
       ├─ llm.ts             ← OpenRouter client + JSONL logging
       └─ sqlite.ts          ← session persistence (better-sqlite3)
```

## Setup

### Prerequisites

- **Node.js** 22+
- **Neo4j** instance (local or remote) populated with `:Topic` and `:Question` nodes connected by `[:LINKS_TO]`
- **OpenRouter** API key (or any OpenAI-compatible endpoint)

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `OPENROUTER_MODEL` | No | `openai/gpt-4o-mini` | Model identifier |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | API base URL |
| `NEO4J_URI` | No | `bolt://localhost:7687` | Neo4j Bolt URI |
| `NEO4J_USER` | No | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | Yes | — | Neo4j password |
| `LOG_LLM` | No | `none` | LLM logging: `off`, `truncated`, `full` |

### Subject configuration

Edit `config/subjects.json` to add or modify subjects. Each entry sets the language and system instructions injected into every prompt.

```json
{
  "sejarah": {
    "language": "Bahasa Malaysia",
    "instructions": "All responses MUST be in formal SPM-level Malay..."
  }
}
```

## Usage

```bash
# Start a quiz (default 5 questions, subject auto-detected from Pareto topics)
npm run dev -- quiz

# Quiz with specific count and subject
npm run dev -- quiz 3 --subject sejarah

# View past sessions
npm run dev -- history

# View a specific session
npm run dev -- session 2026-05-21-cli-6pm1
```

## How it works (per question)

1. **Topic selection** — the top 20% of topics by exam-question count (Pareto principle) are candidates; `n` are randomly chosen.

2. **MCQ generation** — the LLM creates a 4-option multiple-choice question with a verified keyword that actually appears in the topic text. If the keyword is invalid, a dedicated LLM retry fires; if that still fails, a rule-based heuristic (stop-word filtering + longest-word) produces the fallback.

3. **Active dialogue** — the LLM persona adapts to the student's answer:
   - **Correct** → Feynman tutor: "Explain [keyword] in your own words"
   - **Wrong** → Strict tutor: states the correct answer, tests understanding
   The conversation runs for up to `maxActiveRounds` (default 3) or until the LLM signals `DIALOGUE_COMPLETE`.

4. **Passive feedback** — all four styles are generated for every question:
   - **Strict** — factual "this is the right answer"
   - **Feynman** — simple re-explanation
   - **Recap** — 2–3 sentence topic summary
   - **KBAT** — a single higher-order thinking question

5. **Persistence** — every question, answer, dialogue, and feedback is saved to SQLite (`.stage/spmai/sessions.db`).

## Configuration

These values live in `src/config.ts`:

| Key | Default | Description |
|---|---|---|
| `paretoPercent` | 0.2 | Fraction of top topics to select |
| `maxActiveRounds` | 3 | Max dialogue turns per question |
| `defaultQuizCount` | 5 | Default number of questions |
| `examContextLimit` | 5 | Max exam questions to include as context |

## Database schemas

### Neo4j (knowledge graph)

```
(:Topic {name, subject, text, form, chapter})
(:Question {text})
(:Question)-[:LINKS_TO]->(:Topic)
```

### SQLite (sessions)

**`sessions`** — `id`, `user_id`, `subject`, `started_at`, `completed_at`, `summary`

**`question_logs`** — `id`, `session_id`, `seq`, `topic`, `mcq` (JSON), `student_answer`, `correct`, `active_teacher`, `dialogue` (JSON), `feedback_strict`, `feedback_feynman`, `feedback_recap`, `feedback_kbat`, `created_at`

## Project structure

```
spm-ai/
├── config/
│   └── subjects.json         # Per-subject language/instructions
├── prompts/
│   ├── generate_quiz.txt     # MCQ generation system prompt
│   ├── teacher_feynman_active.txt
│   ├── teacher_strict_active.txt
│   ├── teacher_recap_passive.txt
│   └── teacher_kbat_passive.txt
├── src/
│   ├── main.ts               # CLI entry point (commander)
│   ├── config.ts             # Env + config loader
│   ├── types.ts              # TypeScript type definitions
│   ├── agents/
│   │   ├── coordinator.ts    # Quiz orchestrator
│   │   ├── generator.ts      # MCQ generation + keyword extraction
│   │   ├── teachers.ts       # Active dialogue + passive feedback
│   │   └── llm.ts            # OpenRouter client + JSONL logger
│   └── db/
│       ├── neo4j.ts          # Neo4j data access
│       └── sqlite.ts         # SQLite session persistence
├── .env.example
├── package.json
└── tsconfig.json
```

## Tech stack

- **Runtime** — Node.js 22+, TypeScript (ES2022/ESNext modules)
- **LLM** — OpenRouter (OpenAI-compatible SDK)
- **Knowledge graph** — Neo4j (bolt driver)
- **Persistence** — SQLite (better-sqlite3, synchronous)
- **CLI** — commander, chalk, readline

## License

MIT
