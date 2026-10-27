#!/usr/bin/env python3
"""仅供升级后初始暂停、尚无新业务数据的离线窗口逆迁移；默认只读检查。"""
import argparse
import json
from pathlib import Path
import sqlite3

BASE_TABLES = {"runtime", "users", "messages", "memory", "logs", "usage"}
EXTENSIONS = {
    1: ("account_users",),
    2: ("llm_calls",),
    3: ("memory_items", "memory_sources", "memory_ignored", "memory_deleted", "memory_progress", "memory_legacy_imports", "role_experiences"),
    4: ("daily_revisions", "daily_attempts", "daily_locks"),
    5: ("task_runs",),
    6: ("outbox",),
    7: ("program_stages",),
}
NAMES = {
    1: "account-ownership-and-settings-baseline",
    2: "统一模型调用与价格快照",
    3: "可追溯记忆与整理进度",
    4: "daily-state",
    5: "统一任务实例与历史",
    6: "durable-outbox",
    7: "工作流阶段",
}
ADDED_MESSAGE_COLUMNS = ("account_id", "source_id", "platform_id", "target_id", "ingested_at", "processed_seq")
LEGACY_MESSAGE_COLUMNS = ("id", "channel", "user_id", "body", "status", "draft", "receipt", "error", "created_at", "updated_at")
LEGACY_MEMORY_COLUMNS = ("user_id", "visibility", "summary", "updated_at")
NEW_INDEXES = ("messages_account_queue", "messages_account_user", "messages_platform_identity")
DERIVED_TABLES = {"memory_items", "memory_legacy_imports"}
BASE_COLUMNS = {"runtime": ("key", "value"), "users": ("id", "forgot", "epoch"),
                "logs": ("id", "at", "level", "event", "detail"), "usage": ("id", "at", "input_tokens", "output_tokens", "cache_read")}
KNOWN_INDEXES = {"messages_queue", "messages_user", *NEW_INDEXES, "llm_calls_started", "llm_calls_interaction",
                 "memory_items_scope", "daily_history", "task_runs_history", "outbox_account_status", "program_stages_time"}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def tables(connection):
    return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def columns(connection, table):
    return tuple(row[1] for row in connection.execute("PRAGMA table_info(" + quote(table) + ")"))


def integrity(connection):
    results = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    foreign = list(connection.execute("PRAGMA foreign_key_check"))
    if results != ["ok"] or foreign:
        raise ValueError("SQLite 完整性或外键检查失败，拒绝回退")
    return "ok"


def inspect_external(directory):
    reasons = []
    expected = {"forget-ledger.json": dict, "forget-history.json": dict, "forgotten-sources.json": dict, "memory-mutations.json": list}
    for name, kind in expected.items():
        file = directory / name
        if file.is_symlink():
            reasons.append("独立账本不能是符号链接：" + name)
            continue
        if not file.exists():
            continue
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            reasons.append("独立账本不可读取或损坏：" + name)
            continue
        if not isinstance(value, kind):
            reasons.append("独立账本格式不受支持：" + name)
        elif name == "forget-ledger.json":
            if any(not isinstance(flag, bool) or user.startswith("scope:") for user, flag in value.items()):
                reasons.append("存在旧程序无法理解的账号范围遗忘记录")
        elif value:
            reasons.append("存在旧程序无法执行的新遗忘或删除约束：" + name)
    settings_file = directory / "panel" / "settings.json"
    if settings_file.is_symlink():
        reasons.append("面板设置不能是符号链接")
    elif settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8"))
            domains = {"persona", "tasks", "memory", "program"}
            if not isinstance(settings, dict) or set(settings) - (domains | {"model", "revisions"}):
                reasons.append("面板设置包含未知结构或字段")
            else:
                revisions = settings.get("revisions", {})
                if settings.get("model") is not None and not isinstance(settings["model"], dict):
                    reasons.append("旧模型配置结构不受支持")
                if not isinstance(revisions, dict) or set(revisions) - (domains | {"model"}) or any(not isinstance(revision, int) or isinstance(revision, bool) or revision < 0 for revision in revisions.values()):
                    reasons.append("面板设置修订结构不受支持")
                elif any(settings.get(domain) not in (None, {}) or revisions.get(domain, 0) != 0 for domain in domains):
                    reasons.append("存在旧程序保存模型时无法保留的新页面配置")
        except (OSError, ValueError):
            reasons.append("面板设置不可读取或损坏")
    return reasons


def inspect(connection):
    integrity(connection)
    present = tables(connection)
    result = {"eligible": False, "integrity": "ok", "versions": [], "counts": {}, "derived": {}, "reasons": []}
    reasons = result["reasons"]
    required = BASE_TABLES | {"schema_migrations"}
    if not required <= present:
        reasons.append("缺少目标迁移或基础数据表，不属于受支持的升级窗口")
        return result
    migrations = list(connection.execute("SELECT version,name FROM schema_migrations ORDER BY version"))
    result["versions"] = [row[0] for row in migrations]
    if not any(row[0] == 1 for row in migrations):
        reasons.append("未检测到基础迁移版本 1")
    for version, name in migrations:
        if version not in NAMES:
            reasons.append("存在未来或未知迁移版本：" + str(version))
        elif name != NAMES[version]:
            reasons.append("迁移名称不匹配：" + str(version))
        elif not set(EXTENSIONS[version]) <= present:
            reasons.append("已登记迁移缺少扩展表：" + str(version))
    registered = {row[0] for row in migrations}
    for version, group in EXTENSIONS.items():
        if version not in registered and set(group) & present:
            reasons.append("扩展表缺少对应迁移登记：" + str(version))
    allowed = required | {table for group in EXTENSIONS.values() for table in group}
    if present - allowed:
        reasons.append("存在未识别的数据表，无法证明降级兼容")
    if connection.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").fetchone():
        reasons.append("存在未识别视图或触发器，无法证明降级兼容")
    indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")}
    if indexes - KNOWN_INDEXES:
        reasons.append("存在未识别索引，无法证明降级后结构保持")
    for table, expected in BASE_COLUMNS.items():
        if columns(connection, table) != expected:
            reasons.append("基础数据表结构不受支持：" + table)
    if columns(connection, "messages") != LEGACY_MESSAGE_COLUMNS + ADDED_MESSAGE_COLUMNS:
        reasons.append("消息结构不符合已验证的基础迁移")
    if columns(connection, "memory") != ("account_id",) + LEGACY_MEMORY_COLUMNS:
        reasons.append("摘要结构不符合已验证的基础迁移")
    if reasons:
        return result
    control = connection.execute("SELECT value FROM runtime WHERE key='control'").fetchone()
    if not control or control[0] != "paused":
        reasons.append("控制状态必须明确为 paused；先停止全部 app 和 CLI")
    unsafe = connection.execute("SELECT count(*) FROM messages WHERE status IN ('sending','unknown','generating')").fetchone()[0]
    if unsafe:
        reasons.append("存在发送、未知回执或生成中的消息，不能逆迁移")
    explicit = connection.execute("SELECT count(*) FROM messages WHERE account_id<>''").fetchone()[0]
    if explicit:
        reasons.append("存在明确工作账号归属的消息")
    new_messages = connection.execute("SELECT count(*) FROM messages WHERE source_id<>id OR platform_id<>'' OR target_id<>'' OR ingested_at<>0 OR processed_seq NOT IN (0,rowid)").fetchone()[0]
    if new_messages:
        reasons.append("存在升级后新增或改变来源进度的消息")
    if connection.execute("SELECT count(*) FROM memory WHERE account_id<>''").fetchone()[0]:
        reasons.append("存在明确工作账号归属的摘要")
    for table in sorted(present & (allowed - required)):
        count = connection.execute("SELECT count(*) FROM " + quote(table)).fetchone()[0]
        result["counts"][table] = count
        if count and table not in DERIVED_TABLES:
            reasons.append("扩展表存在不可丢弃的数据：" + table + "（" + str(count) + " 条）")
    if "memory_items" in present:
        invalid = connection.execute("""SELECT count(*) FROM memory_items i WHERE
          i.account_id<>'' OR i.kind<>'fact' OR i.revision<>1 OR i.source_status<>'incomplete'
          OR NOT EXISTS(SELECT 1 FROM memory m WHERE m.account_id='' AND m.user_id=i.user_id AND m.visibility=i.channel
            AND m.summary=i.text AND m.updated_at=i.created_at AND m.updated_at=i.updated_at)
          OR NOT EXISTS(SELECT 1 FROM memory_legacy_imports l WHERE l.account_id='' AND l.user_id=i.user_id AND l.channel=i.channel)""").fetchone()[0]
        duplicates = connection.execute("SELECT 1 FROM memory_items GROUP BY account_id,user_id,channel HAVING count(*)>1 LIMIT 1").fetchone()
        if invalid or duplicates:
            reasons.append("长期记忆包含人工修订或无法证明可再导入的内容")
        result["derived"]["memory_items"] = result["counts"]["memory_items"] - invalid
    if "memory_legacy_imports" in present:
        invalid = connection.execute("""SELECT count(*) FROM memory_legacy_imports l WHERE l.account_id<>'' OR NOT EXISTS(
          SELECT 1 FROM memory m WHERE m.account_id='' AND m.user_id=l.user_id AND m.visibility=l.channel)""").fetchone()[0]
        if invalid:
            reasons.append("记忆导入标记无法对应现存旧摘要")
        result["derived"]["memory_legacy_imports"] = result["counts"]["memory_legacy_imports"] - invalid
    result["eligible"] = not reasons
    return result


def reverse(connection):
    # 只删除 inspect 已证明为空或可从旧摘要重建的派生表。
    present = tables(connection)
    for version in sorted(EXTENSIONS, reverse=True):
        for table in reversed(EXTENSIONS[version]):
            if table in present:
                connection.execute("DROP TABLE " + quote(table))
    for index in NEW_INDEXES:
        connection.execute("DROP INDEX IF EXISTS " + quote(index))
    for column in reversed(ADDED_MESSAGE_COLUMNS):
        connection.execute("ALTER TABLE messages DROP COLUMN " + quote(column))
    connection.execute("""CREATE TABLE memory_rollback_v0(user_id TEXT NOT NULL,visibility TEXT NOT NULL,
      summary TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,visibility))""")
    connection.execute("INSERT INTO memory_rollback_v0(user_id,visibility,summary,updated_at) SELECT user_id,visibility,summary,updated_at FROM memory")
    connection.execute("DROP TABLE memory")
    connection.execute("ALTER TABLE memory_rollback_v0 RENAME TO memory")
    connection.execute("DROP TABLE schema_migrations")


def run(database, apply=False):
    path = Path(database).expanduser().absolute()
    if not path.is_file() or path.is_symlink():
        return {"ok": False, "eligible": False, "applied": False, "reasons": ["数据库必须是已有普通文件，不能使用符号链接"]}, 2
    connection = None
    try:
        connection = sqlite3.connect(path.as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True, timeout=5, isolation_level=None)
        if apply:
            connection.execute("BEGIN EXCLUSIVE")
        else:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
        report = inspect(connection)
        report["reasons"].extend(inspect_external(path.parent))
        report["eligible"] = not report["reasons"]
        report.update({"ok": report["eligible"], "mode": "apply" if apply else "check", "applied": False})
        if not report["eligible"]:
            connection.execute("ROLLBACK")
            return report, 2
        if apply:
            reverse(connection)
            report["integrityAfter"] = integrity(connection)
            if tables(connection) != BASE_TABLES or columns(connection, "memory") != LEGACY_MEMORY_COLUMNS or columns(connection, "messages") != LEGACY_MESSAGE_COLUMNS:
                raise ValueError("逆迁移后结构核对失败")
            connection.execute("COMMIT")
            report["applied"] = True
        else:
            connection.execute("ROLLBACK")
        return report, 0
    except (sqlite3.Error, ValueError, OSError, RuntimeError) as error:
        if connection is not None and connection.in_transaction:
            connection.execute("ROLLBACK")
        return {"ok": False, "eligible": False, "applied": False, "error": str(error), "reasons": ["逆迁移检查或执行失败，事务已回滚"]}, 1
    finally:
        if connection is not None:
            connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="已停止全部 app／CLI 的离线 SQLite 文件")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="只读检查（默认）")
    mode.add_argument("--apply", action="store_true", help="明确执行受限逆迁移；不会创建自动备份")
    args = parser.parse_args()
    report, code = run(args.db, args.apply)
    print(json.dumps(report, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
