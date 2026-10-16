import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Db, DbResult, DbStatement } from '../src/store.js'

/** D1 stand-in on node:sqlite, in memory, with the migrations of the relay (every `.sql` in `migrations`) applied. */
export function sqliteDb(migrations: URL): { db: Db; count: (sql: string) => number; exec: (sql: string) => void } {
  const sqlite = new DatabaseSync(':memory:')
  for (const name of readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'))
  }

  class Statement implements DbStatement {
    constructor(
      readonly sql: string,
      readonly values: SQLInputValue[] = [],
    ) {}
    bind(...values: unknown[]): DbStatement {
      return new Statement(this.sql, values as SQLInputValue[])
    }
    async all<T>(): Promise<DbResult<T>> {
      return { results: sqlite.prepare(this.sql).all(...this.values) as T[], meta: {} }
    }
    async first<T>(): Promise<T | null> {
      return (sqlite.prepare(this.sql).get(...this.values) as T | undefined) ?? null
    }
    async run(): Promise<DbResult> {
      return this.runSync()
    }
    runSync(): DbResult {
      return { meta: { rows_written: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }
    }
  }

  const db: Db = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => (s as Statement).runSync())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  const count = (sql: string) => Number((sqlite.prepare(sql).get() as { n: number }).n)
  return { db, count, exec: (sql) => sqlite.exec(sql) }
}
