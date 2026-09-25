"""Multilingual translation support for interview scripts.

A script keeps translations for ONE target language (``scripts.lang_code`` /
``scripts.lang_label``). Every translation row is bound to a concrete
node/option by its ids — never by its position on the canvas:

  * ``title`` / ``text`` rows reference ``node_id`` (``option_id IS NULL``);
  * ``option_label`` rows reference both ``node_id`` and ``option_id``.

Each row stores ``source_hash`` (a hash of the original text the translation
was written against) and a derived ``status``:

  * ``reviewed`` — the row's source still matches the current script content;
  * ``pending``  — 待复核: the original field changed after the translation
                   was saved; respondents fall back to the original text until
                   the editor re-checks and re-saves the translation.

When a node or an option is deleted and the script is saved,
:func:`reconcile_translations` removes its rows in the same transaction, so an
old translation can never attach to a newly created node/option even when an
id value happens to be reused later.
"""
from __future__ import annotations

import hashlib
from typing import Any

NODE_FIELDS = ("title", "text")
OPTION_FIELD = "option_label"
VALID_FIELDS = (*NODE_FIELDS, OPTION_FIELD)


def _hash_source(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def hash_source(text: str) -> str:
    """Public alias used when saving a freshly reviewed translation."""
    return _hash_source(text)


def source_hashes(content: dict[str, Any]) -> dict[tuple, str]:
    """Map every translatable field key of *content* to its source hash.

    Key shape: ``(node_id, field)`` for title/text,
    ``(node_id, field, option_id)`` for option labels.
    """
    hashes: dict[tuple, str] = {}
    for node in content.get("nodes", []) or []:
        node_id = node.get("id")
        hashes[(node_id, "title")] = _hash_source(node.get("title", ""))
        hashes[(node_id, "text")] = _hash_source(node.get("text", ""))
        for opt in node.get("options", []) or []:
            hashes[(node_id, OPTION_FIELD, opt.get("id"))] = _hash_source(opt.get("label", ""))
    return hashes


def reconcile_translations(db, script_id: int, content: dict[str, Any]) -> None:
    """Reconcile stored translations of *script_id* against saved *content*.

    Runs inside the caller's write transaction (script save). Two things
    happen, both idempotent:

    1. Rows whose node/option no longer exists are DELETED — translations of
       deleted objects never linger to be claimed by a future object with a
       coincidentally equal id.
    2. Surviving rows flip to ``pending`` when their ``source_hash`` no longer
       matches the current original text, and back to ``reviewed`` when the
       source returns to the text they were last reviewed against.
    """
    hashes = source_hashes(content)

    rows = db.execute(
        "SELECT id, node_id, field, option_id, source_hash FROM translations "
        "WHERE script_id = ?",
        (script_id,),
    ).fetchall()
    for row in rows:
        if row["option_id"] is not None:
            key = (row["node_id"], row["field"], row["option_id"])
        else:
            key = (row["node_id"], row["field"])
        if key not in hashes:
            db.execute("DELETE FROM translations WHERE id = ?", (row["id"],))
            continue
        status = "reviewed" if row["source_hash"] == hashes[key] else "pending"
        db.execute("UPDATE translations SET status = ? WHERE id = ?", (status, row["id"]))


def get_field_source(content: dict[str, Any], node_id: str, field: str,
                     option_id: str | None) -> str | None:
    """Current original text of one translatable field, or None if absent."""
    node = next((n for n in content.get("nodes", []) or [] if n.get("id") == node_id), None)
    if node is None:
        return None
    if field in NODE_FIELDS and option_id is None:
        return node.get(field, "") or ""
    if field == OPTION_FIELD and option_id is not None:
        opt = next((o for o in node.get("options", []) or []
                    if o.get("id") == option_id), None)
        return None if opt is None else (opt.get("label", "") or "")
    return None


def translation_view(db, script_id: int, content: dict[str, Any],
                     lang_code: str | None) -> dict[str, Any]:
    """Full editor view: every field of the script with its translation state.

    Per-field status:
      * ``missing``  — no (non-empty) translation saved;
      * ``pending``  — translation exists but the original changed since review;
      * ``reviewed`` — translation matches the current original.
    Summary counts drive the editor badges ("缺失 N · 待复核 M").
    """
    rows = db.execute(
        "SELECT node_id, field, option_id, translation, source_hash, status "
        "FROM translations WHERE script_id = ?",
        (script_id,),
    ).fetchall() if lang_code else []
    stored: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        key = (r["node_id"], r["field"], r["option_id"]) if r["option_id"] is not None \
            else (r["node_id"], r["field"])
        stored[key] = dict(r)

    hashes = source_hashes(content)
    fields: list[dict[str, Any]] = []
    counts = {"total": 0, "reviewed": 0, "pending": 0, "missing": 0}

    for node in content.get("nodes", []) or []:
        node_id = node.get("id")
        for field in NODE_FIELDS:
            source = node.get(field, "") or ""
            key = (node_id, field)
            row = stored.get(key)
            # Re-derive from live content rather than trusting the saved flag,
            # so an unsaved-but-reconciled canvas is reported consistently.
            if row and row["translation"]:
                status = "reviewed" if row["source_hash"] == hashes[key] else "pending"
            else:
                status = "missing"
            counts["total"] += 1
            counts[status] += 1
            fields.append({
                "node_id": node_id,
                "node_title": node.get("title", "") or "",
                "field": field,
                "option_id": None,
                "source": source,
                "translation": (row["translation"] if row else "") or "",
                "status": status,
            })
        for opt in node.get("options", []) or []:
            option_id = opt.get("id")
            key = (node_id, OPTION_FIELD, option_id)
            row = stored.get(key)
            if row and row["translation"]:
                status = "reviewed" if row["source_hash"] == hashes[key] else "pending"
            else:
                status = "missing"
            counts["total"] += 1
            counts[status] += 1
            fields.append({
                "node_id": node_id,
                "node_title": node.get("title", "") or "",
                "field": OPTION_FIELD,
                "option_id": option_id,
                "source": opt.get("label", "") or "",
                "translation": (row["translation"] if row else "") or "",
                "status": status,
            })

    return {"lang_code": lang_code, "fields": fields, "counts": counts}


def freeze_translations(db, script_id: int, content: dict[str, Any],
                        lang_code: str) -> dict[str, Any]:
    """Build the translation payload frozen into a read-only share snapshot.

    Only fields currently ``reviewed`` (a non-empty translation whose source
    hash matches the content being snapshotted) are included — missing and
    待复核 fields are simply absent, and the answer page falls back to the
    original text for them. Keys are node/option ids, so jumps and recorded
    answers keep using the original script untouched.
    """
    hashes = source_hashes(content)
    rows = db.execute(
        "SELECT node_id, field, option_id, translation, source_hash "
        "FROM translations WHERE script_id = ? AND lang_code = ?",
        (script_id, lang_code),
    ).fetchall()
    nodes_out: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = (r["node_id"], r["field"], r["option_id"]) if r["option_id"] is not None \
            else (r["node_id"], r["field"])
        if key not in hashes or not r["translation"]:
            continue
        if r["source_hash"] != hashes[key]:
            continue  # pending review: respondent sees the original instead
        node_bucket = nodes_out.setdefault(r["node_id"], {"options": {}})
        if r["field"] == OPTION_FIELD:
            node_bucket["options"][r["option_id"]] = r["translation"]
        else:
            node_bucket[r["field"]] = r["translation"]
    return {"nodes": nodes_out}
