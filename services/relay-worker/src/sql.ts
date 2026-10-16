import type { Db, DbResult, DbStatement } from './store.js'

const encoder = new TextEncoder()

/** SQLite literal of a bound value. Text with a NUL goes as a blob cast to text, which a quoted literal cannot hold. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} as SQL`)
    return String(value)
  }
  if (typeof value !== 'string') throw new Error(`cannot write a ${typeof value} as SQL`)
  if (value.includes('\0')) {
    const hex = Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, '0')).join('')
    return `CAST(X'${hex}' AS TEXT)`
  }
  return `'${value.replaceAll("'", "''")}'`
}

class Recorded implements DbStatement {
  constructor(
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}
  bind(...values: unknown[]): DbStatement {
    return new Recorded(this.sql, values)
  }
  all<T>(): Promise<DbResult<T>> {
    return Promise.reject(new Error('a SQL file cannot be read'))
  }
  first<T>(): Promise<T | null> {
    return Promise.reject(new Error('a SQL file cannot be read'))
  }
  run(): Promise<DbResult> {
    return Promise.reject(new Error('a SQL file is written with toSql'))
  }
  /** The statement with its values in place of the `?` placeholders. */
  toSql(): string {
    const parts = this.sql.split('?')
    if (parts.length - 1 !== this.values.length) {
      throw new Error(`${this.values.length} values for ${parts.length - 1} placeholders: ${this.sql}`)
    }
    return parts.reduce((sql, part, i) => sql + sqlLiteral(this.values[i - 1]) + part) + ';'
  }
}

/**
 * A Db whose statements are written out as SQL text instead of run, for `wrangler d1 execute --file`. Only for
 * statements that read nothing first, such as `Store.importStatements`. No placeholder may sit inside a literal.
 */
export function sqlFileDb(): { db: Db; toSql: (statements: readonly DbStatement[]) => string } {
  const db: Db = {
    prepare: (sql) => new Recorded(sql),
    batch: () => Promise.reject(new Error('a SQL file is written with toSql')),
  }
  const toSql = (statements: readonly DbStatement[]) =>
    statements.map((s) => (s as Recorded).toSql() + '\n').join('')
  return { db, toSql }
}
