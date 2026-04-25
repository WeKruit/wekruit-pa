import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export type SqliteStatement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}

export type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  pragma(sql: string): unknown
  exec(sql: string): void
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): void
}

export const Database = require("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => SqliteDatabase
