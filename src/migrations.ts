import type { DatabaseSync } from 'node:sqlite';

/** 模块可按独立版本注册迁移；版本顺序不代表模块初始化顺序。 */
export function applyMigration(db:DatabaseSync, version:number, name:string, sql:string):boolean {
 if (!Number.isSafeInteger(version) || version < 1 || !name.trim()) throw new Error('迁移标识无效');
 db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
 db.exec('BEGIN IMMEDIATE');
 try {
  const previous=db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(version) as {name:string}|undefined;
  if(previous){if(previous.name!==name)throw new Error('迁移版本冲突：'+version);db.exec('COMMIT');return false;}
  db.exec(sql);
  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(version,name,Date.now());
  db.exec('COMMIT');return true;
 } catch(error){db.exec('ROLLBACK');throw error;}
}

export const FOUNDATION_MIGRATION = `
 ALTER TABLE messages ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
 ALTER TABLE messages ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
 UPDATE messages SET source_id=id;
 ALTER TABLE messages ADD COLUMN platform_id TEXT NOT NULL DEFAULT '';
 ALTER TABLE messages ADD COLUMN target_id TEXT NOT NULL DEFAULT '';
 ALTER TABLE messages ADD COLUMN ingested_at INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE messages ADD COLUMN processed_seq INTEGER NOT NULL DEFAULT 0;
 UPDATE messages SET processed_seq=rowid WHERE status IN ('confirmed','draft','skipped','failed');
 CREATE TABLE account_users(account_id TEXT NOT NULL,id TEXT NOT NULL,forgot INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,id));
 ALTER TABLE memory RENAME TO memory_legacy_v0;
 CREATE TABLE memory(account_id TEXT NOT NULL DEFAULT '',user_id TEXT NOT NULL,visibility TEXT NOT NULL,summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,user_id,visibility));
 INSERT INTO memory(account_id,user_id,visibility,summary,updated_at) SELECT '',user_id,visibility,summary,updated_at FROM memory_legacy_v0;
 DROP TABLE memory_legacy_v0;
 CREATE INDEX messages_account_queue ON messages(account_id,status,created_at);
 CREATE INDEX messages_account_user ON messages(account_id,user_id,channel,processed_seq);
 CREATE UNIQUE INDEX messages_platform_identity ON messages(account_id,channel,platform_id) WHERE platform_id<>'';
 `;
