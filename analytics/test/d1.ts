// A minimal D1 stand-in on top of Node's built-in SQLite, so the real SQL runs in the tests.
import { readdirSync, readFileSync } from "node:fs";
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

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** The migration files, in the order wrangler applies them. */
export const migrationFiles = (): string[] =>
  readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .sort();

export const migrationSql = (file: string): string => readFileSync(join(migrations, file), "utf8");

/** A database with every migration applied, or only the given ones (to test an upgrade). */
export function fakeD1(only: string[] = migrationFiles()) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of only) sqlite.exec(migrationSql(file));
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
