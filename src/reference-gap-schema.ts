import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './migrations.js';

/** 两项能力共用版本 13；不为旧角色经历加列，保留旧版十值 INSERT。 */
export const REFERENCE_GAP_SCHEMA=`
 CREATE TABLE IF NOT EXISTS role_experience_meta(
  experience_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,origin TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,declared_at INTEGER,url TEXT,
  verify_status TEXT NOT NULL,verify_reason TEXT,hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS role_experience_meta_scope ON role_experience_meta(account_id,verify_status,hidden,occurred_at);
 CREATE TABLE IF NOT EXISTS manual_imports(
  id TEXT PRIMARY KEY,account_id TEXT NOT NULL,url TEXT NOT NULL,platform_id TEXT NOT NULL,
  status TEXT NOT NULL,reason TEXT,message_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS manual_imports_pending ON manual_imports(account_id,status,created_at,id);
 CREATE INDEX IF NOT EXISTS manual_imports_platform ON manual_imports(account_id,platform_id,status);
`;
export function ensureReferenceGapMigration(db:DatabaseSync):void {
 applyMigration(db,13,'经历附加信息与补录请求',REFERENCE_GAP_SCHEMA);
}
