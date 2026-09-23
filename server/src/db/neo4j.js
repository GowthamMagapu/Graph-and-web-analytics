import neo4j from 'neo4j-driver';
import { config } from '../config.js';

export const driver = neo4j.driver(
  config.neo4j.url,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
  { disableLosslessIntegers: true },
);

// JS numbers are sent to Neo4j as floats; wrap values that must be integers (LIMIT, seq, ts).
export const int = (n) => neo4j.int(Math.trunc(n));

/** Run a read query and return plain objects. */
export async function read(cypher, params = {}) {
  const { records } = await driver.executeQuery(cypher, params, { routing: neo4j.routing.READ });
  return records.map((r) => r.toObject());
}

/** Run several write statements in one transaction. */
export async function writeTx(statements) {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.executeWrite(async (tx) => {
      for (const [cypher, params] of statements) await tx.run(cypher, params);
    });
  } finally {
    await session.close();
  }
}
