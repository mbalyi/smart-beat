// A minimal D1 stand-in on top of Node's built-in SQLite, so the real SQL runs in the tests.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

class Statement {
  private values: unknown[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }
  async run(): Promise<{ success: true }> {
    this.db.prepare(this.sql).run(...(this.values as never[]));
    return { success: true };
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] };
  }
}

export function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_counters.sql"),
      "utf8",
    ),
  );
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
