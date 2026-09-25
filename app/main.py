"""FastAPI application: script CRUD, validation, sharing, runtime preview runs."""
import json
import secrets
import sqlite3
import string
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import get_db, init_db
from .funnel import build_funnel
from .graph import plan_route
from .graph import replay_run
from .graph import step as graph_step
from .graph import validate as validate_content
from .i18n import VALID_FIELDS
from .i18n import freeze_translations
from .i18n import get_field_source
from .i18n import hash_source
from .i18n import reconcile_translations
from .i18n import translation_view

app = FastAPI(title="分支访谈脚本编辑器", version="1.0.0")

STATIC_DIR = "static"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_utc(value: str, field_label: str) -> str:
    """Parse a client-supplied UTC timestamp and store it as canonical ISO text.

    Naive values are accepted as UTC (the UI only offers UTC inputs); aware
    values are converted to UTC. The returned string keeps an explicit
    ``+00:00`` offset so later comparisons are plain lexicographic string
    comparisons of identical-format values.
    """
    text = (value or "").strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"{field_label}时间格式不正确，请填写有效的 UTC 时间（YYYY-MM-DDTHH:MM）")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.isoformat(timespec="minutes")


def _fmt_utc(value: str | None) -> str | None:
    """'2026-09-25T08:30:00+00:00' -> '2026-09-25 08:30 UTC' for display."""
    if not value:
        return None
    return value.replace("T", " ")[:16] + " UTC"


# Current open state of a snapshot's gate for starting NEW answer sessions.
# Statuses: open | not_started (before the UTC start, which is inclusive) |
# closed (at/after the UTC deadline, which is exclusive) | full (cap reached).
def _share_open_status(open_started_at: str | None, open_deadline_at: str | None,
                       max_new_runs: int | None, run_count: int,
                       at: datetime | None = None) -> str:
    now = at or datetime.now(timezone.utc)

    def as_utc(value: str) -> datetime:
        # Stored values are canonical UTC ISO text; seconds are optional
        # (minutes precision), so compare on parsed datetimes rather than
        # relying on lexicographic string ordering.
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    if open_started_at and now < as_utc(open_started_at):
        return "not_started"
    if open_deadline_at and now >= as_utc(open_deadline_at):
        return "closed"
    if max_new_runs is not None and run_count >= max_new_runs:
        return "full"
    return "open"


def _closed_reason(status: str, open_started_at: str | None, open_deadline_at: str | None,
                   max_new_runs: int | None) -> str:
    """Respondent-facing message shown when starting a new session is rejected."""
    if status == "not_started":
        return f"本次访谈尚未开放，开始时间为 {_fmt_utc(open_started_at)}（UTC，含该时刻），请稍后再来。"
    if status == "closed":
        return f"本次访谈已截止，截止时间为 {_fmt_utc(open_deadline_at)}（UTC，不含该时刻），无法再开始新的作答。"
    if status == "full":
        return f"本次访谈名额已满（新建会话上限 {max_new_runs} 个），无法再开始新的作答。"
    return ""


def _share_rule_view(db, share_row) -> dict[str, Any]:
    """Open rules + current session count/status for editor and share page."""
    run_count = db.execute(
        "SELECT COUNT(*) AS c FROM runs WHERE mode = 'share' AND share_token = ?",
        (share_row["token"],),
    ).fetchone()["c"]
    status = _share_open_status(share_row["open_started_at"], share_row["open_deadline_at"],
                                share_row["max_new_runs"], run_count)
    return {
        "open_started_at": share_row["open_started_at"],
        "open_deadline_at": share_row["open_deadline_at"],
        "max_new_runs": share_row["max_new_runs"],
        "run_count": run_count,
        "open_status": status,
        "closed_reason": _closed_reason(status, share_row["open_started_at"],
                                        share_row["open_deadline_at"],
                                        share_row["max_new_runs"]),
    }


# ---- models ---------------------------------------------------------------

class OptionIn(BaseModel):
    id: str
    label: str = ""
    target_id: str | None = None


class NodeIn(BaseModel):
    id: str
    type: str = "question"          # question | info
    title: str = ""
    text: str = ""
    terminal: bool = False
    x: float = 0
    y: float = 0
    options: list[OptionIn] = Field(default_factory=list)


class ContentIn(BaseModel):
    start_node_id: str | None = None
    nodes: list[NodeIn] = Field(default_factory=list)


class ScriptIn(BaseModel):
    name: str = "未命名访谈脚本"
    content: ContentIn | None = None


class ScriptUpdate(BaseModel):
    name: str | None = None
    content: ContentIn | None = None


class ShareCreate(BaseModel):
    # Optional: when set, the snapshot freezes this language's reviewed
    # translations. Must match the script's configured target language.
    lang_code: str | None = None


class ShareRuleUpdate(BaseModel):
    # Answer-open rules for NEW sessions of one already-created snapshot.
    # Every field is a full-update: null (or omitted) clears that rule and
    # means "no restriction". Times are UTC ISO-8601 strings.
    open_started_at: str | None = None    # inclusive earliest start, null = no lower bound
    open_deadline_at: str | None = None   # exclusive deadline, null = no upper bound
    max_new_runs: int | None = None       # positive cap on created sessions, null = unlimited


class LanguageIn(BaseModel):
    lang_code: str = Field(min_length=1, max_length=20)
    lang_label: str = Field(min_length=1, max_length=80)


class TranslationIn(BaseModel):
    node_id: str = Field(min_length=1, max_length=100)
    field: str
    option_id: str | None = None
    translation: str = Field(default="", max_length=10000)


class RunStart(BaseModel):
    script_id: int | None = None
    share_token: str | None = None
    invite_code: str | None = None


class InviteGenerate(BaseModel):
    count: int = Field(default=1, ge=1, le=500)


class RunChoice(BaseModel):
    option_id: str


class ShareResume(BaseModel):
    resume_token: str


class RouteOptionRef(BaseModel):
    node_id: str
    option_id: str


class RoutePlanIn(BaseModel):
    content: ContentIn
    options: list[RouteOptionRef] = Field(default_factory=list)


class ImpactIn(BaseModel):
    content: ContentIn


# ---- lifecycle ------------------------------------------------------------

@app.on_event("startup")
def startup() -> None:
    init_db()


# ---- script CRUD ----------------------------------------------------------

@app.get("/api/scripts")
def list_scripts():
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, created_at, updated_at FROM scripts ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/scripts", status_code=201)
def create_script(payload: ScriptIn):
    content = payload.content.model_dump() if payload.content else {"start_node_id": None, "nodes": []}
    ts = now_iso()
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO scripts (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (payload.name, json.dumps(content, ensure_ascii=False), ts, ts),
        )
        sid = cur.lastrowid
    return {"id": sid, "name": payload.name, "content": content,
            "created_at": ts, "updated_at": ts}


def _fetch_script(script_id: int) -> dict[str, Any]:
    with get_db() as db:
        row = db.execute("SELECT * FROM scripts WHERE id = ?", (script_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "脚本不存在")
    return {"id": row["id"], "name": row["name"], "content": json.loads(row["content"]),
            "lang_code": row["lang_code"], "lang_label": row["lang_label"],
            "created_at": row["created_at"], "updated_at": row["updated_at"]}


@app.get("/api/scripts/{script_id}")
def get_script(script_id: int):
    return _fetch_script(script_id)


@app.put("/api/scripts/{script_id}")
def update_script(script_id: int, payload: ScriptUpdate):
    existing = _fetch_script(script_id)
    name = payload.name if payload.name is not None else existing["name"]
    content = payload.content.model_dump() if payload.content is not None else existing["content"]
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "UPDATE scripts SET name = ?, content = ?, updated_at = ? WHERE id = ?",
            (name, json.dumps(content, ensure_ascii=False), ts, script_id),
        )
        # Reconcile translations in the SAME transaction as the save:
        # rows of deleted nodes/options are removed, surviving rows whose
        # source changed flip to 待复核 (pending). A later edit restoring the
        # original text flips them back to reviewed automatically.
        reconcile_translations(db, script_id, content)
    return {"id": script_id, "name": name, "content": content,
            "lang_code": existing["lang_code"], "lang_label": existing["lang_label"],
            "updated_at": ts}


@app.delete("/api/scripts/{script_id}", status_code=204)
def delete_script(script_id: int):
    _fetch_script(script_id)
    with get_db() as db:
        db.execute("DELETE FROM scripts WHERE id = ?", (script_id,))
        db.execute("DELETE FROM translations WHERE script_id = ?", (script_id,))


# ---- validation -----------------------------------------------------------

@app.post("/api/scripts/{script_id}/validate")
def validate_saved_script(script_id: int):
    script = _fetch_script(script_id)
    result = validate_content(script["content"])
    return result


# ---- multilingual translations --------------------------------------------

@app.put("/api/scripts/{script_id}/language")
def set_script_language(script_id: int, payload: LanguageIn):
    """Set (or replace) the script's single target language.

    Changing the language CODE switches the target: previous translations
    belong to the old language and are removed so they can never be shown or
    frozen into a share under the wrong language. Renaming only the display
    label keeps the translations. Setting the same code just updates the label.
    """
    script = _fetch_script(script_id)
    code = payload.lang_code.strip()
    label = payload.lang_label.strip()
    if not code or not label:
        raise HTTPException(400, "语言代码与语言名称均不能为空")
    ts = now_iso()
    with get_db() as db:
        if script["lang_code"] and code != script["lang_code"]:
            db.execute(
                "DELETE FROM translations WHERE script_id = ? AND lang_code = ?",
                (script_id, script["lang_code"]),
            )
        db.execute(
            "UPDATE scripts SET lang_code = ?, lang_label = ?, updated_at = ? WHERE id = ?",
            (code, label, ts, script_id),
        )
    return {"id": script_id, "lang_code": code, "lang_label": label, "updated_at": ts}


@app.get("/api/scripts/{script_id}/translations")
def list_translations(script_id: int):
    """Editor view of every translatable field and its translation state.

    Returns the target language plus per-field rows (source text, translation,
    status missing/pending/reviewed) and summary counts. Status is derived
    from the current saved content, so it is correct right after a save.
    """
    script = _fetch_script(script_id)
    with get_db() as db:
        return translation_view(db, script_id, script["content"], script["lang_code"])


@app.put("/api/scripts/{script_id}/translations")
def upsert_translation(script_id: int, payload: TranslationIn):
    """Save one field translation and mark it reviewed against current source.

    The row is pinned to (node_id, field[, option_id]); if that node/option
    has since been deleted the request is rejected (404) rather than storing
    a dangling translation. An empty translation deletes the row (field
    becomes 缺失/missing again).
    """
    script = _fetch_script(script_id)
    code = script["lang_code"]
    if not code:
        raise HTTPException(400, "请先为脚本设置目标语言，再维护译文")
    if payload.field not in VALID_FIELDS:
        raise HTTPException(400, f"不支持的译文字段：{payload.field}")
    option_id = payload.option_id or None
    if payload.field == "option_label" and not option_id:
        raise HTTPException(400, "选项译文必须提供 option_id")
    if payload.field in ("title", "text") and option_id is not None:
        raise HTTPException(400, "节点标题/正文译文不接受 option_id")
    source = get_field_source(script["content"], payload.node_id, payload.field, option_id)
    if source is None:
        raise HTTPException(404, "对应节点或选项已删除，译文不会套用到新对象上")

    ts = now_iso()
    text = payload.translation
    with get_db() as db:
        if not text.strip():
            if option_id is not None:
                db.execute(
                    "DELETE FROM translations WHERE script_id = ? AND lang_code = ? "
                    "AND node_id = ? AND field = ? AND option_id = ?",
                    (script_id, code, payload.node_id, payload.field, option_id),
                )
            else:
                db.execute(
                    "DELETE FROM translations WHERE script_id = ? AND lang_code = ? "
                    "AND node_id = ? AND field = ? AND option_id IS NULL",
                    (script_id, code, payload.node_id, payload.field),
                )
        else:
            source_hash = hash_source(source)
            # Upsert through the matching partial unique index: delete the
            # previous row (if any) then insert, in this one transaction.
            if option_id is not None:
                db.execute(
                    "DELETE FROM translations WHERE script_id = ? AND lang_code = ? "
                    "AND node_id = ? AND field = ? AND option_id = ?",
                    (script_id, code, payload.node_id, payload.field, option_id),
                )
            else:
                db.execute(
                    "DELETE FROM translations WHERE script_id = ? AND lang_code = ? "
                    "AND node_id = ? AND field = ? AND option_id IS NULL",
                    (script_id, code, payload.node_id, payload.field),
                )
            db.execute(
                "INSERT INTO translations (script_id, lang_code, node_id, field, option_id, "
                "translation, source_hash, status, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewed', ?)",
                (script_id, code, payload.node_id, payload.field, option_id,
                 text, source_hash, ts),
            )
        return translation_view(db, script_id, script["content"], code)


# ---- branch coverage ------------------------------------------------------

@app.get("/api/scripts/{script_id}/coverage")
def script_coverage(script_id: int):
    """Aggregate how often each option of the *current* script was chosen.

    Saved runs from both sources are counted:
      * editor preview sessions (runs.mode = 'script', script_id matched)
      * answer sessions created via read-only share links whose snapshot
        belongs to this script (runs.mode = 'share', joined via shares)

    Every recorded choice is a (node_id, option_id) pair. Pairs whose node or
    option no longer exists in the current content are ignored, so editing the
    script never produces statistics for vanished options. Options without a
    connected target are not selectable in a run, so they are reported but
    excluded from the coverage rate / uncovered list.
    """
    script = _fetch_script(script_id)
    content = script["content"]
    with get_db() as db:
        rows = db.execute(
            "SELECT r.mode AS mode, r.finished AS finished, r.steps AS steps "
            "FROM runs r LEFT JOIN shares s ON r.share_token = s.token "
            "WHERE (r.mode = 'script' AND r.script_id = ?) "
            "   OR (r.mode = 'share' AND s.script_id = ?)",
            (script_id, script_id),
        ).fetchall()

    counts: dict[tuple[str, str], int] = {}
    preview_runs = share_runs = finished_runs = total_choices = 0
    for row in rows:
        if row["mode"] == "share":
            share_runs += 1
        else:
            preview_runs += 1
        finished_runs += 1 if row["finished"] else 0
        for step in json.loads(row["steps"]):
            node_id, option_id = step.get("node_id"), step.get("option_id")
            # option_id is recorded on the step of the node the choice was made at
            if node_id and option_id:
                counts[(node_id, option_id)] = counts.get((node_id, option_id), 0) + 1
                total_choices += 1

    node_map = {n.get("id"): n for n in content.get("nodes", [])}
    has_runs = bool(rows)
    selectable_total = covered_total = 0
    uncovered_options: list[dict] = []
    nodes_out: list[dict] = []
    for node in content.get("nodes", []):
        options_out = []
        for opt in node.get("options", []) or []:
            target = opt.get("target_id")
            selectable = bool(target and target in node_map)
            count = counts.get((node["id"], opt.get("id")), 0)
            covered = count > 0
            if selectable:
                selectable_total += 1
                if covered:
                    covered_total += 1
                elif has_runs:
                    uncovered_options.append({"node_id": node["id"], "option_id": opt.get("id")})
            options_out.append({
                "option_id": opt.get("id"),
                "label": opt.get("label", ""),
                "target_id": target,
                "selectable": selectable,
                "count": count,
                "covered": covered,
            })
        nodes_out.append({
            "node_id": node.get("id"),
            "title": node.get("title", ""),
            "type": node.get("type", "question"),
            "terminal": bool(node.get("terminal")),
            "options": options_out,
        })

    return {
        "script_id": script_id,
        "has_runs": has_runs,
        "run_count": len(rows),
        "preview_runs": preview_runs,
        "share_runs": share_runs,
        "finished_runs": finished_runs,
        "total_choices": total_choices,
        "nodes": nodes_out,
        "option_count": selectable_total,
        "covered_option_count": covered_total,
        "uncovered_options": uncovered_options,
        "coverage_rate": round(covered_total / selectable_total, 4) if selectable_total else 0.0,
    }


# ---- route planning -------------------------------------------------------

@app.post("/api/route-plan")
def plan_route_endpoint(payload: RoutePlanIn):
    """Shortest route through the checked options — pure read-only computation.

    The posted ``content`` is the caller's current canvas (saved or not).
    Nothing is written to the database, so planning never saves the script,
    never creates run records and never affects branch coverage statistics.
    """
    refs = list(dict.fromkeys((o.node_id, o.option_id) for o in payload.options))
    if not 1 <= len(refs) <= 6:
        raise HTTPException(400, "请勾选 1～6 个已连接目标的选项")
    content = payload.content.model_dump()
    node_map = {n["id"]: n for n in content.get("nodes", [])}
    for node_id, option_id in refs:
        node = node_map.get(node_id)
        opt = next((o for o in (node or {}).get("options", [])
                    if o.get("id") == option_id), None)
        if opt is None:
            raise HTTPException(400, "勾选的选项不存在，请刷新画布后重试")
        target = opt.get("target_id")
        if not target or target not in node_map:
            raise HTTPException(400, "勾选的选项未连接目标节点")
    waypoints = [{"node_id": n, "option_id": o} for n, o in refs]
    return plan_route(content, waypoints)


# ---- revision impact analysis ---------------------------------------------

@app.post("/api/scripts/{script_id}/impact")
def script_impact(script_id: int, payload: ImpactIn):
    """Replay every recorded answer session against the posted CURRENT canvas.

    Both kinds of saved sessions belonging to this script are checked, exactly
    like coverage aggregation:
      * editor preview sessions (runs.mode = 'script', script_id matched)
      * answer sessions created via read-only share links whose snapshot
        belongs to this script (runs.mode = 'share', joined via shares)

    The posted ``content`` is the caller's current canvas — saved or carrying
    unsaved edits. For each session the server replays from the canvas start
    node through the recorded choices, verifying each jump target, and reports
    only the first breakpoint (start changed, node/option vanished, jump
    redirected, premature end, or a finished answer whose end is no longer
    terminal). Unfinished answers are only checked over their answered part; a
    full match is reported as compatible. Read-only: nothing is written, no run
    record changes and coverage statistics are never touched.
    """
    _fetch_script(script_id)  # 404 when the script itself is gone
    content = payload.content.model_dump()
    with get_db() as db:
        rows = db.execute(
            "SELECT r.id AS id, r.mode AS mode, r.finished AS finished, "
            "r.steps AS steps, r.created_at AS created_at "
            "FROM runs r LEFT JOIN shares s ON r.share_token = s.token "
            "WHERE (r.mode = 'script' AND r.script_id = ?) "
            "   OR (r.mode = 'share' AND s.script_id = ?) "
            "ORDER BY r.id DESC",
            (script_id, script_id),
        ).fetchall()

    sessions = []
    affected = compatible = 0
    preview_runs = share_runs = finished_runs = 0
    reason_counts: dict[str, int] = {}
    for row in rows:
        if row["mode"] == "share":
            share_runs += 1
        else:
            preview_runs += 1
        finished = bool(row["finished"])
        finished_runs += 1 if finished else 0
        steps = json.loads(row["steps"])
        result = replay_run(content, steps, finished)
        if result["status"] == "affected":
            affected += 1
            reason = result["breakpoint"]["reason"]
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
        else:
            compatible += 1
        sessions.append({
            "run_id": row["id"],
            "mode": row["mode"],
            "finished": finished,
            "created_at": row["created_at"],
            "choice_count": result["choice_count"],
            "status": result["status"],
            "breakpoint": result["breakpoint"],
            "steps": steps,
        })

    return {
        "script_id": script_id,
        "has_runs": bool(rows),
        "total": len(rows),
        "compatible_count": compatible,
        "affected_count": affected,
        "preview_runs": preview_runs,
        "share_runs": share_runs,
        "finished_runs": finished_runs,
        "reason_counts": reason_counts,
        "sessions": sessions,
    }


# ---- import / export ------------------------------------------------------

@app.get("/api/scripts/{script_id}/export")
def export_script(script_id: int):
    script = _fetch_script(script_id)
    return {
        "format": "branch-interview-script",
        "version": 1,
        "name": script["name"],
        "content": script["content"],
        "exported_at": now_iso(),
    }


@app.post("/api/import")
def import_script(payload: dict[str, Any]):
    """Import a JSON document previously produced by /export (or a raw content object)."""
    if not isinstance(payload, dict):
        raise HTTPException(400, "JSON 顶层必须是对象")
    if "content" in payload:
        content, name = payload["content"], payload.get("name", "导入的访谈脚本")
    else:
        content, name = payload, payload.get("name", "导入的访谈脚本")
        # Raw content documents only carry start_node_id / nodes.
        if "start_node_id" not in content or "nodes" not in content:
            raise HTTPException(400, "缺少 content 或 start_node_id/nodes 字段")
    try:
        ContentIn.model_validate(content)
    except Exception as exc:
        raise HTTPException(400, f"脚本格式不正确: {exc}")
    ts = now_iso()
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO scripts (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (str(name), json.dumps(content, ensure_ascii=False), ts, ts),
        )
        sid = cur.lastrowid
    return {"id": sid, "name": name, "content": content, "created_at": ts}


# ---- read-only sharing ----------------------------------------------------

@app.post("/api/scripts/{script_id}/share")
def create_share(script_id: int, payload: ShareCreate | None = None):
    script = _fetch_script(script_id)
    lang_code = (payload.lang_code.strip() if payload and payload.lang_code else None)
    frozen: dict[str, Any] = {"nodes": {}}
    lang_label = None
    if lang_code:
        if not script["lang_code"]:
            raise HTTPException(400, "该脚本尚未设置目标语言，无法创建带译文的分享")
        if lang_code != script["lang_code"]:
            raise HTTPException(400, "选择的语言与脚本目标语言不一致")
        with get_db() as db:
            frozen = freeze_translations(db, script_id, script["content"], lang_code)
        lang_label = script["lang_label"]
    token = secrets.token_urlsafe(8)
    ts = now_iso()
    with get_db() as db:
        db.execute(
            "INSERT INTO shares (token, script_id, script_name, content, invite_only, "
            "lang_code, lang_label, translations, created_at) "
            "VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
            (token, script_id, script["name"],
             json.dumps(script["content"], ensure_ascii=False),
             lang_code, lang_label,
             json.dumps(frozen, ensure_ascii=False), ts),
        )
    return {"token": token, "url": f"/share.html?token={token}", "invite_only": False,
            "lang_code": lang_code, "lang_label": lang_label}


@app.get("/api/share/{token}")
def get_share(token: str):
    with get_db() as db:
        row = db.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
        if row is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        rules = _share_rule_view(db, row)
    return {"token": row["token"], "name": row["script_name"],
            "content": json.loads(row["content"]), "created_at": row["created_at"],
            "invite_only": bool(row["invite_only"]),
            "lang_code": row["lang_code"], "lang_label": row["lang_label"],
            # Frozen reviewed translations at snapshot time; mapping:
            # translations.nodes[node_id].title/.text/.options[option_id].
            "translations": json.loads(row["translations"] or "{}"),
            # Answer-open rules for NEW sessions + current state. Already
            # started sessions never see this gate; it only blocks creating a
            # new run (not_started before start / closed past deadline / full).
            "open_started_at": rules["open_started_at"],
            "open_deadline_at": rules["open_deadline_at"],
            "max_new_runs": rules["max_new_runs"],
            "run_count": rules["run_count"],
            "open_status": rules["open_status"],
            "closed_reason": rules["closed_reason"],
            "read_only": True}


@app.get("/api/scripts/{script_id}/shares")
def list_script_shares(script_id: int):
    """List every read-only snapshot already created for this script.

    Used by the editor's answer-path funnel view to pick which snapshot's
    sessions to inspect. Read-only: only snapshot metadata plus per-snapshot
    answer session counts are returned — never the answer content.
    """
    _fetch_script(script_id)  # 404 when the script itself is gone
    with get_db() as db:
        rows = db.execute(
            "SELECT token, script_name, created_at, invite_only, lang_code, lang_label, "
            "open_started_at, open_deadline_at, max_new_runs "
            "FROM shares WHERE script_id = ? ORDER BY created_at DESC, token DESC",
            (script_id,),
        ).fetchall()
        stats = {r["share_token"]: r for r in db.execute(
            "SELECT share_token, COUNT(*) AS run_count, "
            "SUM(CASE WHEN finished = 1 THEN 1 ELSE 0 END) AS finished_count "
            "FROM runs WHERE mode = 'share' AND share_token IN "
            "(SELECT token FROM shares WHERE script_id = ?) "
            "GROUP BY share_token",
            (script_id,),
        ).fetchall()}
        out = []
        for r in rows:
            run_count = stats[r["token"]]["run_count"] if r["token"] in stats else 0
            open_status = _share_open_status(r["open_started_at"], r["open_deadline_at"],
                                             r["max_new_runs"], run_count)
            out.append({
                "token": r["token"],
                "name": r["script_name"],
                "created_at": r["created_at"],
                "invite_only": bool(r["invite_only"]),
                "lang_code": r["lang_code"],
                "lang_label": r["lang_label"],
                "run_count": run_count,
                "finished_count": (stats[r["token"]]["finished_count"]
                                   if r["token"] in stats else 0),
                "open_started_at": r["open_started_at"],
                "open_deadline_at": r["open_deadline_at"],
                "max_new_runs": r["max_new_runs"],
                "open_status": open_status,
            })
    return out


@app.get("/api/share/{token}/rules")
def get_share_rules(token: str):
    """Editor view of a snapshot's answer-open rules and current open state."""
    with get_db() as db:
        share = db.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        return _share_rule_view(db, share)


@app.put("/api/share/{token}/rules")
def update_share_rules(token: str, payload: ShareRuleUpdate):
    """Set/clear the answer-open rules of an ALREADY-CREATED share snapshot.

    A full update of the three independent rules: each null field clears that
    restriction (unset = unlimited). Times are UTC; the start is inclusive and
    the deadline is exclusive, so a start >= deadline can never admit a new
    session and is rejected. The session cap must be a positive integer. The
    check is a plain validation — the count of already-created sessions is
    never an error (a lowered cap simply makes the snapshot 已满/full).
    """
    start_raw = (payload.open_started_at.strip() if payload.open_started_at else None)
    deadline_raw = (payload.open_deadline_at.strip() if payload.open_deadline_at else None)
    max_new_runs = payload.max_new_runs
    if max_new_runs is not None and max_new_runs < 1:
        raise HTTPException(400, "新建会话上限必须是正整数（≥ 1）；不限制请留空")
    started = _parse_utc(start_raw, "开始") if start_raw else None
    deadline = _parse_utc(deadline_raw, "截止") if deadline_raw else None
    if started and deadline:
        started_dt = datetime.fromisoformat(started)
        deadline_dt = datetime.fromisoformat(deadline)
        if started_dt >= deadline_dt:
            raise HTTPException(400, "开始时间必须早于截止时间（开始时刻含、截止时刻不含），请调整后再保存")
    with get_db() as db:
        share = db.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        db.execute(
            "UPDATE shares SET open_started_at = ?, open_deadline_at = ?, max_new_runs = ? "
            "WHERE token = ?",
            (started, deadline, max_new_runs, token),
        )
        share = db.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
        return _share_rule_view(db, share)


@app.get("/api/share/{token}/funnel")
def share_funnel(token: str):
    """Answer-path funnel for ONE read-only share snapshot.

    Only answer sessions of THIS snapshot are read
    (``runs.mode = 'share' AND share_token = token``) — editor previews and
    other snapshots never enter the tree. Each session's ordered
    (original node id, option id) choices form a prefix tree keyed by depth;
    repeated choices in a cycle stay separate at different depths. Every
    prefix reports reached / stopped-unfinished / completed session counts,
    the reach ratio relative to its parent, and the run ids behind it. Node
    and option labels come from the snapshot's frozen content (the original
    text respondents saw), so later script edits never relabel the funnel.
    The query is read-only.
    """
    with get_db() as db:
        share = db.execute(
            "SELECT content, script_name, created_at, invite_only, "
            "lang_code, lang_label FROM shares WHERE token = ?",
            (token,),
        ).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        run_rows = db.execute(
            "SELECT id, steps, finished, created_at FROM runs "
            "WHERE mode = 'share' AND share_token = ? ORDER BY id DESC",
            (token,),
        ).fetchall()

    sessions = [{
        "run_id": r["id"],
        "steps": json.loads(r["steps"]),
        "finished": bool(r["finished"]),
        "created_at": r["created_at"],
    } for r in run_rows]
    result = build_funnel(json.loads(share["content"]), sessions)
    return {
        "token": token,
        "name": share["script_name"],
        "created_at": share["created_at"],
        "invite_only": bool(share["invite_only"]),
        "lang_code": share["lang_code"],
        "lang_label": share["lang_label"],
        **result,
    }


# ---- invite codes for share snapshots -------------------------------------

# Human-transcribable alphabet: no 0/O or 1/I/L ambiguity.
_INVITE_ALPHABET = "".join(c for c in (string.ascii_uppercase + string.digits)
                           if c not in "O01IL")
INVITE_CODE_LEN = 8


def _new_invite_code() -> str:
    return "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(INVITE_CODE_LEN))


def _normalize_invite_code(code: str | None) -> str:
    """Respondents may paste grouped/lower-cased codes (e.g. "ab3d-9kQm")."""
    return "".join((code or "").split()).replace("-", "").upper()


def _invite_summary(db, share_token: str) -> dict[str, Any]:
    stats = db.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS used "
        "FROM invite_codes WHERE share_token = ?",
        (share_token,),
    ).fetchone()
    total, used = stats["total"], stats["used"] or 0
    rows = db.execute(
        "SELECT code, used, used_at FROM invite_codes "
        "WHERE share_token = ? ORDER BY code",
        (share_token,),
    ).fetchall()
    return {
        "invite_only": True,
        "total": total,
        "used_count": used,
        "unused_count": total - used,
        "codes": [{"code": r["code"], "used": bool(r["used"]), "used_at": r["used_at"]}
                  for r in rows],
    }


@app.get("/api/share/{token}/invites")
def list_invites(token: str):
    """Editor view of a snapshot's invite codes and used/unused counts."""
    with get_db() as db:
        share = db.execute(
            "SELECT invite_only FROM shares WHERE token = ?", (token,)
        ).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        summary = _invite_summary(db, token)
        summary["invite_only"] = bool(share["invite_only"])
        return summary


@app.post("/api/share/{token}/invites", status_code=201)
def generate_invites(token: str, payload: InviteGenerate):
    """Turn the snapshot invite-only and add *count* fresh random invite codes.

    The first generation flips ``shares.invite_only`` on; every code belongs to
    this snapshot only (its ``share_token`` is stored with the row). Generating
    more codes never touches existing ones or their used state.
    """
    ts = now_iso()
    with get_db() as db:
        share = db.execute(
            "SELECT 1 FROM shares WHERE token = ?", (token,)
        ).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        db.execute("UPDATE shares SET invite_only = 1 WHERE token = ?", (token,))
        created: list[str] = []
        for _ in range(payload.count):
            # Retry on the (astronomically unlikely) global code collision.
            for _attempt in range(5):
                code = _new_invite_code()
                try:
                    db.execute(
                        "INSERT INTO invite_codes (code, share_token, used, created_at) "
                        "VALUES (?, ?, 0, ?)",
                        (code, token, ts),
                    )
                    created.append(code)
                    break
                except sqlite3.IntegrityError:
                    continue
            else:  # pragma: no cover - collision budget exhausted
                raise HTTPException(500, "邀请码生成冲突，请重试")
        return {**_invite_summary(db, token), "created": created}


@app.post("/api/share/{token}/resume")
def resume_share(token: str, payload: ShareResume):
    """Resume a paused share answer session with a one-time resume token.

    The resume token is bound to one specific share snapshot and one run; it
    can only be consumed while opening that very share link (path token must
    match ``resume_tokens.share_token``). The token is single-use: its ``used``
    flag flips to 1 atomically with the lookup (a conditional UPDATE), so a
    repeated or concurrent reuse is rejected. Finished sessions cannot be
    resumed either; start a new answer instead.
    """
    resume_token = (payload.resume_token or "").strip()
    if not resume_token:
        raise HTTPException(400, "请输入续答令牌")
    with get_db() as db:
        share = db.execute("SELECT 1 FROM shares WHERE token = ?", (token,)).fetchone()
        if share is None:
            raise HTTPException(404, "分享链接不存在或已失效")
        rt = db.execute(
            "SELECT * FROM resume_tokens WHERE token = ?", (resume_token,)
        ).fetchone()
        if rt is None:
            raise HTTPException(404, "续答令牌不存在，请检查后重新输入")
        if rt["share_token"] != token:
            # A token may only ever touch the snapshot it was issued for.
            raise HTTPException(403, "续答令牌不属于当前分享链接，无法在此使用")
        if rt["used"]:
            raise HTTPException(400, "续答令牌已使用，一次性令牌无法再次恢复；请开始新的作答")
        row = db.execute("SELECT * FROM runs WHERE id = ?", (rt["run_id"],)).fetchone()
        if row is None:
            raise HTTPException(404, "原作答会话已不存在，无法恢复")
        if row["finished"]:
            raise HTTPException(400, "该访谈已结束，无法续答；请开始新的作答")
        # Atomic single-use claim: only succeeds while used is still 0.
        claimed = db.execute(
            "UPDATE resume_tokens SET used = 1 WHERE token = ? AND used = 0",
            (resume_token,),
        ).rowcount
        if not claimed:
            raise HTTPException(400, "续答令牌已使用，一次性令牌无法再次恢复；请开始新的作答")
        return _run_response(db, row)


# ---- runtime preview ------------------------------------------------------

def _run_content(db, row) -> dict[str, Any]:
    if row["mode"] == "share":
        share = db.execute("SELECT content FROM shares WHERE token = ?",
                           (row["share_token"],)).fetchone()
        if share is None:
            raise HTTPException(404, "分享不存在")
        return json.loads(share["content"])
    script = db.execute("SELECT content FROM scripts WHERE id = ?",
                        (row["script_id"],)).fetchone()
    if script is None:
        raise HTTPException(404, "脚本不存在")
    return json.loads(script["content"])


@app.post("/api/runs", status_code=201)
def start_run(payload: RunStart):
    if not payload.script_id and not payload.share_token:
        raise HTTPException(400, "需要 script_id 或 share_token")
    invite_code = _normalize_invite_code(payload.invite_code)
    with get_db() as db:
        # A single write transaction serializes verify-code -> consume-code ->
        # create-run: a repeated, cross-snapshot or concurrent invite code is
        # rejected and, on any failure, the rollback leaves no new run behind.
        try:
            db.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower():
                raise HTTPException(409, "服务繁忙，请稍后重试")
            raise

        mode = "share" if payload.share_token else "script"
        invite_required = False
        if mode == "share":
            share = db.execute(
                "SELECT content, invite_only, open_started_at, open_deadline_at, max_new_runs "
                "FROM shares WHERE token = ?",
                (payload.share_token,),
            ).fetchone()
            if share is None:
                raise HTTPException(404, "分享不存在")
            # Gate on the answer-open rules INSIDE this same write transaction:
            # the session count is read with the write lock held, so a
            # concurrent creation racing for the last slot cannot overshoot the
            # cap. A rejection raises before any run insert or invite-code
            # consumption, so neither a session nor an invite code is spent.
            run_count = db.execute(
                "SELECT COUNT(*) AS c FROM runs WHERE mode = 'share' AND share_token = ?",
                (payload.share_token,),
            ).fetchone()["c"]
            open_status = _share_open_status(share["open_started_at"], share["open_deadline_at"],
                                             share["max_new_runs"], run_count)
            if open_status != "open":
                # 403 mirrors the invite gate; the share page shows this reason
                # (未开放 / 已截止 / 已满) in place of the start controls.
                raise HTTPException(403, _closed_reason(open_status, share["open_started_at"],
                                                        share["open_deadline_at"],
                                                        share["max_new_runs"]))
            content = json.loads(share["content"])
            invite_required = bool(share["invite_only"])
            if invite_required:
                if not invite_code:
                    raise HTTPException(403, "此分享已开启邀请制，请输入邀请码后再开始新的作答")
                code_row = db.execute(
                    "SELECT * FROM invite_codes WHERE code = ?", (invite_code,)
                ).fetchone()
                if code_row is None or code_row["share_token"] != payload.share_token:
                    # Unknown code, or a valid code issued for another snapshot.
                    raise HTTPException(403, "邀请码无效或不属于当前分享快照")
                if code_row["used"]:
                    raise HTTPException(403, "邀请码已被使用，每个邀请码只能开始一次作答")
        else:
            # Editor preview always starts directly; invite codes never apply.
            row = db.execute("SELECT content FROM scripts WHERE id = ?",
                             (payload.script_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "脚本不存在")
            content = json.loads(row["content"])

        try:
            result = graph_step(content, "", None)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        node = result["node"]
        steps = [{"node_id": node["id"], "title": node.get("title", ""),
                  "question": node.get("text", ""), "option_id": None, "answer": None}]
        finished = bool(node.get("terminal")) or not node.get("options")
        cur = db.execute(
            "INSERT INTO runs (mode, script_id, share_token, current_node_id, steps, finished, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (mode, payload.script_id, payload.share_token, node["id"],
             json.dumps(steps, ensure_ascii=False), int(finished), now_iso()),
        )
        run_id = cur.lastrowid
        if invite_required:
            # Atomic single-use claim, re-checked inside the same transaction.
            claimed = db.execute(
                "UPDATE invite_codes SET used = 1, run_id = ?, used_at = ? "
                "WHERE code = ? AND share_token = ? AND used = 0",
                (run_id, now_iso(), invite_code, payload.share_token),
            ).rowcount
            if not claimed:
                # Concurrent use won the race: discard the run as well.
                raise HTTPException(409, "邀请码刚被并发使用，本次未创建会话，请更换邀请码重试")
    return {"run_id": run_id, "current_node": node, "steps": steps, "finished": finished}


def _load_run(db, run_id: int):
    row = db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "预览会话不存在")
    return row


def _run_response(db, row) -> dict[str, Any]:
    """Serialize a run row into the API shape (current node + path)."""
    content = _run_content(db, row)
    node = next((n for n in content["nodes"] if n["id"] == row["current_node_id"]), None)
    steps = json.loads(row["steps"])
    return {"run_id": row["id"], "current_node": node, "steps": steps,
            "finished": bool(row["finished"])}


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    with get_db() as db:
        row = _load_run(db, run_id)
        return _run_response(db, row)


@app.post("/api/runs/{run_id}/choice")
def choose(run_id: int, payload: RunChoice):
    with get_db() as db:
        row = _load_run(db, run_id)
        if row["finished"]:
            raise HTTPException(400, "访谈已结束，请重新开始")
        content = _run_content(db, row)
        try:
            result = graph_step(content, row["current_node_id"], payload.option_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        node = result["node"]
        steps = json.loads(row["steps"])
        current_node = next((n for n in content["nodes"] if n["id"] == row["current_node_id"]), None)
        if current_node is None:
            raise HTTPException(400, "当前节点已被编辑删除，请重新开始预览")
        opt = next((o for o in current_node.get("options", [])
                    if o["id"] == payload.option_id), None)
        steps[-1]["option_id"] = payload.option_id
        steps[-1]["answer"] = opt.get("label") if opt else payload.option_id
        steps.append({"node_id": node["id"], "title": node.get("title", ""),
                      "question": node.get("text", ""), "option_id": None, "answer": None})
        finished = bool(node.get("terminal")) or not node.get("options")
        db.execute("UPDATE runs SET current_node_id = ?, steps = ?, finished = ? WHERE id = ?",
                   (node["id"], json.dumps(steps, ensure_ascii=False), int(finished), run_id))
    return {"run_id": run_id, "current_node": node, "steps": steps, "finished": finished}


@app.post("/api/runs/{run_id}/undo")
def undo_last_choice(run_id: int):
    """Withdraw the most recent choice and return to the previous question.

    Works on unfinished sessions and on ones that have just ended (a finished
    session can step back from its end node and keep answering). The last
    answered entry in the recorded ``steps`` order is the choice to withdraw;
    when a cycle visits the same node several times, only its LAST occurrence
    is rolled back — earlier passes through the node stay in the path.

    The current node, the path and the finished flag are updated in ONE
    transaction, together with invalidating the session's not-yet-used resume
    tokens (an old token must never restore a path that no longer matches).
    A session with zero choices is rejected; undo never creates a new session
    and never gives back an already-consumed invite code.
    """
    with get_db() as db:
        row = _load_run(db, run_id)
        steps = json.loads(row["steps"])
        # The most recent choice is the LAST step carrying an option_id;
        # in a cycle the same node may appear repeatedly — only this last
        # occurrence is withdrawn.
        last_answered = None
        for i in range(len(steps) - 1, -1, -1):
            if steps[i].get("option_id"):
                last_answered = i
                break
        if last_answered is None:
            raise HTTPException(400, "还没有任何选择，无法撤回上一答")
        content = _run_content(db, row)
        # Drop everything after the withdrawn choice and clear that step's
        # answer: the session is back at the question it was asked on.
        steps = steps[:last_answered + 1]
        steps[-1]["option_id"] = None
        steps[-1]["answer"] = None
        back_node_id = steps[-1]["node_id"]
        node = next((n for n in content["nodes"] if n["id"] == back_node_id), None)
        if node is None:
            raise HTTPException(400, "要返回的题目已被删除，无法撤回")
        finished = bool(node.get("terminal")) or not node.get("options")
        db.execute("UPDATE runs SET current_node_id = ?, steps = ?, finished = ? WHERE id = ?",
                   (back_node_id, json.dumps(steps, ensure_ascii=False), int(finished), run_id))
        # Outstanding one-time resume tokens captured the pre-undo progress;
        # void them so they cannot restore a stale path (same as restart).
        db.execute("UPDATE resume_tokens SET used = 1 WHERE run_id = ? AND used = 0", (run_id,))
    return {"run_id": run_id, "current_node": node, "steps": steps, "finished": finished}


@app.post("/api/runs/{run_id}/restart")
def restart_run(run_id: int):
    with get_db() as db:
        row = _load_run(db, run_id)
        content = _run_content(db, row)
        try:
            result = graph_step(content, "", None)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        node = result["node"]
        steps = [{"node_id": node["id"], "title": node.get("title", ""),
                  "question": node.get("text", ""), "option_id": None, "answer": None}]
        finished = bool(node.get("terminal")) or not node.get("options")
        db.execute("UPDATE runs SET current_node_id = ?, steps = ?, finished = ? WHERE id = ?",
                   (node["id"], json.dumps(steps, ensure_ascii=False), int(finished), run_id))
        # Restart wipes the paused state: outstanding one-time tokens can no
        # longer restore a path that has been cleared.
        db.execute("UPDATE resume_tokens SET used = 1 WHERE run_id = ? AND used = 0", (run_id,))
    return {"run_id": run_id, "current_node": node, "steps": steps, "finished": finished}


@app.post("/api/runs/{run_id}/pause", status_code=201)
def pause_run(run_id: int):
    """Mint a one-time resume token at the current (unfinished) node.

    Only answer sessions started from a read-only share link can be paused:
    the token stores the share snapshot it belongs to and may only be consumed
    via that snapshot's resume endpoint. A session that has already reached its
    end cannot be paused (there is nothing left to answer). The interview is
    not blocked by pausing — the respondent may keep answering; the token just
    captures the session, which resumes at whatever state it is in when the
    token is used.
    """
    with get_db() as db:
        row = _load_run(db, run_id)
        if row["mode"] != "share" or not row["share_token"]:
            raise HTTPException(400, "只有只读分享链接中的作答会话可以暂停续答")
        if row["finished"]:
            raise HTTPException(400, "访谈已结束，无需续答；请重新开始一次作答")
        share = db.execute("SELECT token FROM shares WHERE token = ?",
                           (row["share_token"],)).fetchone()
        if share is None:
            raise HTTPException(404, "所属分享快照已不存在，无法生成续答令牌")
        token = secrets.token_urlsafe(16)
        db.execute(
            "INSERT INTO resume_tokens (token, run_id, share_token, used, created_at) "
            "VALUES (?, ?, ?, 0, ?)",
            (token, run_id, row["share_token"], now_iso()),
        )
        steps = json.loads(row["steps"])
    answered = sum(1 for s in steps if s.get("option_id"))
    return {"resume_token": token, "run_id": run_id,
            "share_token": row["share_token"], "answered": answered,
            "current_node_id": row["current_node_id"]}


# ---- static frontend ------------------------------------------------------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(f"{STATIC_DIR}/index.html")


@app.get("/share.html", include_in_schema=False)
def share_page():
    return FileResponse(f"{STATIC_DIR}/share.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
