import neo4j, { Integer } from "neo4j-driver";
import { config } from "../config.js";
import type { TopicSummary, TopicWithQuestions } from "../types.js";

const driver = neo4j.driver(
  config.neo4jUri,
  neo4j.auth.basic(config.neo4jUser, config.neo4jPassword)
);

export async function getParetoTopics(
  subject?: string
): Promise<TopicSummary[]> {
  const session = driver.session();
  try {
    const whereClause = subject ? "WHERE toLower(t.subject) = toLower($subject)" : "";
    const params: Record<string, unknown> = {};
    if (subject) params.subject = subject;

    const result = await session.run(
      `
      MATCH (q:Question)-[:LINKS_TO]->(t:Topic)
      ${whereClause}
      RETURN t.name AS name, t.subject AS subject,
             coalesce(t.form, '') AS form, coalesce(t.chapter, '') AS chapter,
             count(q) AS questionCount
      ORDER BY questionCount DESC
      `,
      params
    );

    const all: TopicSummary[] = result.records.map((r) => ({
      name: r.get("name"),
      subject: r.get("subject"),
      form: r.get("form"),
      chapter: r.get("chapter"),
      questionCount: (r.get("questionCount") as Integer).toNumber(),
    }));

    const totalResult = await session.run(
      `MATCH (t:Topic) ${whereClause} RETURN count(t) AS cnt`,
      params
    );
    const totalTopics = (totalResult.records[0]?.get("cnt") as Integer).toNumber();
    const paretoCount = Math.ceil(totalTopics * config.paretoPercent);

    return all.slice(0, paretoCount);
  } finally {
    await session.close();
  }
}

export async function getTopicWithQuestions(
  topicName: string
): Promise<TopicWithQuestions> {
  const session = driver.session();
  try {
    const topicResult = await session.run(
      `MATCH (t:Topic {name: $name}) RETURN t.text AS text`,
      { name: topicName }
    );

    const text = topicResult.records[0]?.get("text") || "";

    const qResult = await session.run(
      `
      MATCH (q:Question)-[:LINKS_TO]->(t:Topic {name: $name})
      RETURN q.text AS qtext
      LIMIT $limit
      `,
      { name: topicName, limit: neo4j.int(config.examContextLimit) }
    );

    const examQuestions = qResult.records.map((r) => r.get("qtext") as string);

    return { name: topicName, text, examQuestions };
  } finally {
    await session.close();
  }
}

export async function getTotalTopicCount(): Promise<number> {
  const session = driver.session();
  try {
    const result = await session.run("MATCH (t:Topic) RETURN count(t) AS cnt");
    return (result.records[0]?.get("cnt") as Integer).toNumber();
  } finally {
    await session.close();
  }
}

export async function closeDb(): Promise<void> {
  await driver.close();
}
