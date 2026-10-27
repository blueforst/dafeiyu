#!/usr/bin/env python3
"""离线准备六项提案数据供 0.1.16 读取；保留新结构和证据，不切镜像、不创建备份。"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
from urllib.parse import urlparse

NAMES = {1: "account-ownership-and-settings-baseline", 2: "统一模型调用与价格快照", 3: "可追溯记忆与整理进度", 4: "daily-state", 5: "统一任务实例与历史", 6: "durable-outbox", 7: "工作流阶段", 8: "posting-validation", 9: "回复分级与公平调度", 10: "运行健康告警与日报", 11: "人设回放快照与隔离批次", 12: "动态时间线索引"}
SCHEMA = {
 "runtime": "key value", "users": "id forgot epoch", "account_users": "account_id id forgot epoch",
 "messages": "id channel user_id body status draft receipt error created_at updated_at account_id source_id platform_id target_id ingested_at processed_seq",
 "memory": "account_id user_id visibility summary updated_at", "logs": "id at level event detail", "usage": "id at input_tokens output_tokens cache_read",
 "schema_migrations": "version name applied_at",
 "llm_calls": "id started_at finished_at purpose source account_id channel interaction_id provider model actual_model status stop_reason latency_ms input_tokens output_tokens cache_read cache_write cache_write_1h total_tokens reasoning_tokens usage_known cost_json pricing_status price_source",
 "memory_items": "id account_id user_id channel kind text revision source_status created_at updated_at", "memory_sources": "item_id message_id at", "memory_ignored": "account_id user_id channel message_id at", "memory_deleted": "account_id user_id channel text_hash at", "memory_progress": "account_id user_id channel revision cursor last_summary_at", "memory_legacy_imports": "account_id user_id channel", "role_experiences": "id account_id user_id channel kind text source_key source_message_id receipt created_at",
 "daily_revisions": "account_id local_date revision content source generated_at config_revision call_id interaction_id", "daily_attempts": "account_id local_date attempts last_attempt_at status error interaction_id call_id", "daily_locks": "account_id local_date owner expires_at",
 "task_runs": "id task_id account_id scheduled_at source status started_at finished_at error call_ids outbox_id receipt detail attempts host_request_id",
 "outbox": "id account_id channel kind source_id target_id event text status receipt created_at submitted_at updated_at",
 "program_stages": "id name status started_at ended_at round_id message_id call_id task_id channel account_id error",
 "triage_ignores": "account_id user_id channel until reason strikes_json", "triage_text_hits": "account_id hash user_id at message_id",
 "alerts": "id account_id key level summary started_at last_seen_at resolved_at", "daily_reports": "date account_id created_at body_json",
 "generation_snapshots": "message_id account_id user_id channel created_at body_json", "replay_runs": "id account_id created_at updated_at status settings_json persona_json baseline_mode estimate_json summary_json", "replay_items": "run_id message_id account_id user_id channel created_at source_revision source_hash baseline_json candidate_json label issues_json metrics_json status",
}
GROUPS = {1: {"runtime", "users", "messages", "memory", "logs", "usage", "account_users"}, 2: {"llm_calls"}, 3: {"memory_items", "memory_sources", "memory_ignored", "memory_deleted", "memory_progress", "memory_legacy_imports", "role_experiences"}, 4: {"daily_revisions", "daily_attempts", "daily_locks"}, 5: {"task_runs"}, 6: {"outbox"}, 7: {"program_stages"}, 8: set(), 9: {"triage_ignores", "triage_text_hits"}, 10: {"alerts", "daily_reports"}, 11: {"generation_snapshots", "replay_runs", "replay_items"}, 12: set()}
INDEXES = set("messages_queue messages_user messages_account_queue messages_account_user messages_platform_identity llm_calls_started llm_calls_interaction memory_items_scope daily_history task_runs_history outbox_account_status program_stages_time messages_account_triage messages_account_triage_history triage_text_window alerts_active alerts_history generation_snapshots_scope replay_runs_account replay_items_source messages_account_created messages_account_channel_updated outbox_account_created".split())
MESSAGE_STATUSES = set("queued generating draft approved sending unknown confirmed failed skipped filtered merged ignored".split())
OUTBOX_STATUSES = set("prepared submitting confirmed unknown rejected cancelled".split())
SETTINGS_DOMAINS = {"model", "modelLibrary", "persona", "tasks", "memory", "program", "promptHints", "triage", "health"}
TASK_IDS = set("main daily-state memory-summary morning-post evening-post backup health daily-report account-check".split())


def quote(value):
 return '"' + value.replace('"', '""') + '"'


def object_json(value, label):
 result = json.loads(value)
 if not isinstance(result, dict):
  raise ValueError(label + "必须是 JSON 对象")
 return result


def read_json(path, default):
 if path.is_symlink():
  raise ValueError("证据文件不能是符号链接：" + path.name)
 if not path.exists():
  return default
 if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
  raise ValueError("证据文件不是有界普通文件：" + path.name)
 return json.loads(path.read_text(encoding="utf-8"))


def fingerprint(path):
 if path.is_symlink():
  raise ValueError("证据文件不能是符号链接：" + path.name)
 return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def short_compatible(text):
 """保守充分条件，不声称实现 Twitter Unicode/emoji 精确计数。"""
 if not isinstance(text, str) or not text.strip() or text != unicodedata.normalize("NFC", text):
  return False
 if re.search(r"https?://|www\.|@[a-z0-9_]{1,15}|[\ufeff\ufffe\uffff\x00]", text, re.I):
  return False
 # 非 ASCII 全按 2 计入，ZWJ/组合序列只会被高估；不以此开放长帖。
 return sum(1 if ord(char) < 128 else 2 for char in text) <= 280


def model_readable(model):
 if not isinstance(model, dict) or set(model) - {"provider", "baseUrl", "api", "id", "reasoningLevel", "maxTokens", "timeoutMs", "custom"}:
  return False
 if not all(isinstance(model.get(key), str) and model[key] for key in ["provider", "baseUrl", "id"]):
  return False
 parsed = urlparse(model["baseUrl"])
 if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
  return False
 if model.get("api", "") not in {"", "openai-completions", "openai-responses", "anthropic-messages"} or (model["provider"] == "custom" and not model.get("api")):
  return False
 if model.get("reasoningLevel") not in {"off", "minimal", "low", "medium", "high", "xhigh", "max"}:
  return False
 for key, minimum, maximum in [("maxTokens", 64, 8192), ("timeoutMs", 1000, 180000)]:
  if type(model.get(key)) is not int or not minimum <= model[key] <= maximum:
   return False
 custom = model.get("custom")
 return custom is None or (isinstance(custom, dict) and set(custom) == {"contextWindow", "reasoning"} and type(custom["contextWindow"]) is int and custom["contextWindow"] > 0 and type(custom["reasoning"]) is bool)


def inspect_settings(path):
 settings = read_json(path, {})
 if not isinstance(settings, dict) or set(settings) - (SETTINGS_DOMAINS | {"revisions"}):
  raise ValueError("面板设置存在未知顶层结构")
 revisions = settings.get("revisions", {})
 if not isinstance(revisions, dict) or set(revisions) - SETTINGS_DOMAINS or any(type(value) is not int or value < 0 for value in revisions.values()):
  raise ValueError("面板修订结构不受支持")
 for domain in SETTINGS_DOMAINS:
  if settings.get(domain) is not None and not isinstance(settings[domain], dict):
   raise ValueError("面板分区结构无效：" + domain)
 model = settings.get("model")
 if model is not None and not model_readable(model):
  raise ValueError("旧版 model 物化配置不可读取")
 library = settings.get("modelLibrary")
 if library is not None:
  if library.get("version") != 1 or set(library) != {"version", "providers", "active"} or not isinstance(library["providers"], list) or not isinstance(library["active"], dict) or set(library["active"]) - {"default"}:
   raise ValueError("模型库版本或用途映射未知")
  active = library["active"].get("default")
  if active is not None:
   if not isinstance(active, dict) or set(active) != {"key", "modelId"}:
    raise ValueError("使用中模型引用无效")
   providers = [p for p in library["providers"] if isinstance(p, dict) and p.get("key") == active["key"]]
   if len(providers) != 1 or not isinstance(providers[0].get("models"), list):
    raise ValueError("使用中服务商不能唯一解析")
   provider = providers[0]
   models = [m for m in provider["models"] if isinstance(m, dict) and m.get("id") == active["modelId"]]
   if len(models) != 1:
    raise ValueError("使用中模型不能唯一解析")
   selected = models[0]
   expected = {"provider": provider.get("provider"), "baseUrl": provider.get("baseUrl"), "id": selected["id"], **(selected.get("params") or {"reasoningLevel": "off", "maxTokens": 4096, "timeoutMs": 60000})}
   if provider.get("api"):
    expected["api"] = provider["api"]
   if selected.get("custom") is not None:
    expected["custom"] = selected["custom"]
   if not model or {**model, "api": model.get("api", "")} != {**expected, "api": expected.get("api", "")}:
    raise ValueError("模型库使用中配置与旧 model 物化结果不一致")
  elif model is not None:
   raise ValueError("存在 model 配置但模型库没有使用中引用")
 plans = (settings.get("tasks") or {}).get("plans", {})
 if not isinstance(plans, dict) or set(plans) - TASK_IDS:
  raise ValueError("任务设置含未知任务")
 return {"present": path.exists(), "modelMaterialized": model is not None, "modelLibraryPreserved": library is not None}


def integrity(connection):
 if [row[0] for row in connection.execute("PRAGMA integrity_check")] != ["ok"] or list(connection.execute("PRAGMA foreign_key_check")):
  raise ValueError("SQLite 完整性或外键检查失败")


def inspect(connection, profile, settings_path, stopped):
 integrity(connection)
 reasons = [] if stopped else ["需明确 --confirm-stopped，确认 app、browser、CLI 及全部库访问者已停止"]
 report = {"target": "0.1.16", "eligible": False, "applied": False, "integrity": "ok", "versions": [], "reasons": reasons, "resumeAllowed": False, "plan": {"approvedToDraft": 0, "reviewToDraft": 0, "preparedToCancelled": 0}, "preserve": ["全部表与迁移", "冻结正文与 validation_json", "浏览器两类日志", "面板设置与 Key", "遗忘与删除账本"]}
 schema_reason_count = len(reasons)
 present = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
 if "schema_migrations" not in present:
  reasons.append("缺少迁移登记，不能证明是 0.1.16 及后续提案的数据")
  return report, []
 migrations = dict(connection.execute("SELECT version,name FROM schema_migrations"))
 report["versions"] = sorted(migrations)
 if not set(range(1, 8)) <= set(migrations) or any(NAMES.get(version) != name for version, name in migrations.items()):
  reasons.append("基础迁移不全、迁移名称不符或存在未来迁移")
 expected_tables = {"schema_migrations"}.union(*(GROUPS.get(version, set()) for version in migrations))
 if present != expected_tables or present - SCHEMA.keys():
  reasons.append("数据表与已验证迁移不匹配")
 if connection.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").fetchone():
  reasons.append("存在未知视图或触发器")
 indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")}
 if indexes - INDEXES:
  reasons.append("存在未知索引")
 for table in present & SCHEMA.keys():
  expected = SCHEMA[table].split() + (["tier", "tier_reason", "merged_into"] if table == "messages" and 9 in migrations else []) + (["validation_json"] if table == "outbox" and 8 in migrations else [])
  if [row[1] for row in connection.execute("PRAGMA table_info(" + quote(table) + ")")] != expected:
   reasons.append("表列不属于已验证结构：" + table)
 if len(reasons) > schema_reason_count:
  return report, []
 try:
  report["settings"] = inspect_settings(settings_path)
 except (ValueError, OSError, TypeError, KeyError) as error:
  reasons.append(str(error))
 control = connection.execute("SELECT value FROM runtime WHERE key='control'").fetchone()
 if not control or control[0] != "paused":
  reasons.append("runtime.control 必须明确为 paused，不能从接管或 running 直接准备回退")
 for table, clause in [("messages", "status IN ('sending','generating')"), ("outbox", "status='submitting'"), ("llm_calls", "status='started'"), ("task_runs", "status='running'"), ("program_stages", "status='running'"), ("replay_runs", "status IN ('queued','running','aborting')"), ("replay_items", "status IN ('queued','running')")]:
  if table in present and connection.execute("SELECT 1 FROM " + quote(table) + " WHERE " + clause + " LIMIT 1").fetchone():
   reasons.append("存在尚未收束的操作：" + table)
 if "triage_ignores" in present and connection.execute("SELECT 1 FROM triage_ignores WHERE until>? LIMIT 1", (int(time.time() * 1000),)).fetchone():
  reasons.append("存在旧版不能执行的有效骚扰冷却约束")
 for table, allowed in [("llm_calls", {"started", "completed", "failed", "aborted", "interrupted"}), ("task_runs", {"running", "completed", "failed", "interrupted", "unknown", "missed", "skipped", "cancelled"}), ("program_stages", {"running", "completed", "failed", "cancelled", "aborted", "interrupted"}), ("replay_runs", {"queued", "running", "completed", "failed", "aborted", "interrupted"}), ("replay_items", {"queued", "running", "completed", "failed", "aborted", "interrupted"})]:
  if table in present and any(row[0] not in allowed for row in connection.execute("SELECT DISTINCT status FROM " + quote(table))):
   reasons.append("存在未知操作状态：" + table)
 actions = []
 for row in connection.execute("SELECT id,channel,status,draft FROM messages"):
  ident, channel, status, raw = row
  if status not in MESSAGE_STATUSES or channel not in {"public", "private"}:
   reasons.append("消息包含未知状态或渠道")
   continue
  try:
   draft = object_json(raw, "草稿") if raw is not None else {}
  except (ValueError, TypeError):
   reasons.append("消息草稿结构损坏")
   continue
  if status == "unknown" and channel == "public" and not short_compatible(draft.get("text")):
   reasons.append("存在未对账的公开长帖或不能证明兼容短帖的 unknown 消息")
  if status == "approved" or (status == "queued" and draft.get("review") is True):
   if draft.get("action") != "reply" or not isinstance(draft.get("text"), str) or not draft["text"].strip():
    reasons.append("待复核草稿缺少可保留的正文")
   else:
    actions.append(("message", ident))
    report["plan"]["approvedToDraft" if status == "approved" else "reviewToDraft"] += 1
 outboxes = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM outbox")}
 for row in outboxes.values():
  if row["status"] not in OUTBOX_STATUSES or row["kind"] not in {"reply", "dm", "post"} or row["channel"] != ("private" if row["kind"] == "dm" else "public"):
   reasons.append("出站包含未知状态、类型或渠道")
   continue
  compatible = short_compatible(row["text"]) if row["channel"] == "public" else isinstance(row["text"], str) and len(row["text"].encode("utf-16-le")) // 2 <= 4000
  if row["status"] == "unknown" and not compatible:
   reasons.append("存在旧浏览器不能安全回查的 unknown 长帖或私信")
  if row["status"] == "prepared" and not compatible:
   actions.append(("outbox", row["id"]))
   report["plan"]["preparedToCancelled"] += 1
 for task in connection.execute("SELECT outbox_id FROM task_runs WHERE status='unknown'"):
  row = outboxes.get(task["outbox_id"])
  if not row or row["status"] not in {"unknown", "confirmed", "rejected"} or row["channel"] == "public" and not short_compatible(row["text"]):
   reasons.append("存在未对账、长帖或状态不匹配的 unknown 任务")
 try:
  journal = read_json(profile / "transport-journal.json", {})
  preflight = read_json(profile / "posting-preflight-v1.json", {"version": 1, "entries": {}})
  if not isinstance(journal, dict) or not isinstance(preflight, dict) or set(preflight) != {"version", "entries"} or preflight["version"] != 1 or not isinstance(preflight["entries"], dict):
   raise ValueError("浏览器日志结构或版本无效")
  for ident, entry in journal.items():
   receipt = entry.get("receipt", entry) if isinstance(entry, dict) else {}
   if not isinstance(receipt, dict) or receipt.get("status") not in {"confirmed", "unknown", "rejected"}:
    raise ValueError("旧提交日志包含不兼容回执")
   row = outboxes.get(ident)
   if receipt["status"] == "unknown" and (not row or row["status"] != "unknown" or not short_compatible(row["text"]) and row["channel"] == "public"):
    raise ValueError("浏览器仍有未对账或无法用旧版回查的提交意图")
   if row and entry.get("kind") and (row["kind"] != entry["kind"] or row["account_id"].lower() != entry.get("handle") or row["target_id"] != entry.get("targetId") or hashlib.sha256(row["text"].encode()).hexdigest() != entry.get("textHash")):
    raise ValueError("提交日志与冻结出站的账号、目标或正文不一致")
  for ident, entry in preflight["entries"].items():
   row = outboxes.get(ident)
   if not isinstance(entry, dict) or not isinstance(entry.get("receipt"), dict) or entry["receipt"].get("status") != "not_submitted" or not isinstance(entry["receipt"].get("validation"), dict) or not row or row["status"] != "cancelled" or ident in journal:
    raise ValueError("新预检日志尚未与 cancelled 出站完成对账")
   receipt = object_json(row["receipt"], "出站回执")
   if receipt != entry["receipt"] or row["kind"] != entry.get("kind") or row["account_id"].lower() != entry.get("handle") or row["target_id"] != entry.get("targetId") or hashlib.sha256(row["text"].encode()).hexdigest() != entry.get("textHash"):
    raise ValueError("预检终态与冻结出站的账号、目标、正文或回执不一致")
  report["browserEvidence"] = {"journalEntries": len(journal), "preflightEntries": len(preflight["entries"])}
 except (ValueError, TypeError, OSError, KeyError) as error:
  reasons.append(str(error))
 report["reasons"] = list(dict.fromkeys(reasons))
 report["eligible"] = not report["reasons"]
 return report, actions


def prepare(connection, actions):
 now = int(time.time() * 1000)
 for kind, ident in actions:
  if kind == "message":
   connection.execute("UPDATE messages SET status='draft',updated_at=MAX(updated_at+1,?) WHERE id=? AND status IN ('queued','approved')", (now, ident))
  else:
   connection.execute("UPDATE outbox SET status='cancelled',updated_at=MAX(updated_at+1,?) WHERE id=? AND status='prepared'", (now, ident))


def run(database, profile, apply=False, stopped=False):
 path, browser = Path(database).expanduser().absolute(), Path(profile).expanduser().absolute()
 connection, locks = None, []
 try:
  if path.is_symlink() or not path.is_file() or browser.is_symlink() or not browser.is_dir():
   raise ValueError("数据库和浏览器证据目录必须为既有普通路径，不能是符号链接")
  for name in ["workflow-profile.lock", "manual-profile.lock"]:
   lock = browser / name
   if lock.is_symlink():
    raise ValueError("浏览器锁不能是符号链接")
   if lock.exists():
    if not lock.is_file():
     raise ValueError("浏览器锁不是普通文件")
    fd = os.open(lock, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    locks.append(fd)
    try:
     fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
     raise ValueError("浏览器或人工会话仍持有 profile 锁")
  if any((browser / "camoufox" / name).exists() or (browser / "camoufox" / name).is_symlink() for name in ["lock", ".parentlock", "parent.lock"]):
   raise ValueError("仍存在 Firefox profile 锁，需管理员确认已停止后处理，工具不会移除")
  settings = path.parent / "panel" / "settings.json"
  files = [settings, browser / "transport-journal.json", browser / "posting-preflight-v1.json"] + [path.parent / name for name in ["forget-ledger.json", "forget-history.json", "forgotten-sources.json", "memory-mutations.json"]]
  if settings.parent.is_symlink():
   raise ValueError("面板目录不能是符号链接")
  before = {str(file): fingerprint(file) for file in files}
  for name, kind in [("forget-ledger.json", dict), ("forget-history.json", dict), ("forgotten-sources.json", dict), ("memory-mutations.json", list)]:
   value = read_json(path.parent / name, {} if kind is dict else [])
   if not isinstance(value, kind):
    raise ValueError("独立遗忘或删除账本结构无效：" + name)
   if name == "forget-ledger.json" and any(type(flag) is not bool for flag in value.values()):
    raise ValueError("独立遗忘开关结构无效")
   if name == "forget-history.json" and any(type(at) is not int or at < 0 for at in value.values()):
    raise ValueError("独立遗忘历史结构无效")
   if name == "forgotten-sources.json" and any(flag is not True for flag in value.values()):
    raise ValueError("独立遗忘来源结构无效")
  connection = sqlite3.connect(path.as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True, timeout=5, isolation_level=None)
  connection.row_factory = sqlite3.Row
  if not apply:
   connection.execute("PRAGMA query_only=ON")
  connection.execute("BEGIN EXCLUSIVE" if apply else "BEGIN")
  report, actions = inspect(connection, browser, settings, stopped)
  report.update({"mode": "apply" if apply else "check", "ok": report["eligible"], "offlineConfirmed": stopped})
  if not report["eligible"]:
   connection.execute("ROLLBACK")
   return report, 2
  if apply:
   prepare(connection, actions)
   integrity(connection)
   if any(fingerprint(Path(name)) != digest for name, digest in before.items()):
    raise ValueError("外部设置、账本或浏览器日志在准备期间变化，拒绝提交")
   connection.execute("COMMIT")
   report.update({"applied": True, "integrityAfter": "ok"})
  else:
   connection.execute("ROLLBACK")
  return report, 0
 except (sqlite3.Error, ValueError, OSError, TypeError, RuntimeError) as error:
  if connection is not None and connection.in_transaction:
   connection.execute("ROLLBACK")
  return {"ok": False, "eligible": False, "applied": False, "target": "0.1.16", "reasons": [str(error)], "error": "离线回退准备失败，数据库事务未提交"}, 1
 finally:
  if connection is not None:
   connection.close()
  for fd in locks:
   os.close(fd)


def main():
 parser = argparse.ArgumentParser(description=__doc__)
 parser.add_argument("--db", required=True, help="独立演练或明确停机后的 SQLite 文件")
 parser.add_argument("--browser-profile", required=True, help="对应浏览器 profile 根目录，包含两类发送日志；绝不修改")
 parser.add_argument("--confirm-stopped", action="store_true", help="明确确认 app、browser、CLI 和全部库访问者已停止；锁检查不能代替此确认")
 mode = parser.add_mutually_exclusive_group()
 mode.add_argument("--check", action="store_true", help="只读检查（默认）")
 mode.add_argument("--apply", action="store_true", help="只做兼容状态转换，不切镜像、不恢复运行、不创建备份")
 args = parser.parse_args()
 report, code = run(args.db, args.browser_profile, args.apply, args.confirm_stopped)
 print(json.dumps(report, ensure_ascii=False))
 return code


if __name__ == "__main__":
 raise SystemExit(main())
