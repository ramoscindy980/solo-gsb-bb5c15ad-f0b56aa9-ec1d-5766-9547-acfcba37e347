"""SQLite connection helpers and schema initialization."""
import os
import sqlite3

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "editor.db"))


def get_db() -> sqlite3.Connection:
    # timeout lets a write transaction wait briefly for a competing lock
    # instead of failing immediately with "database is locked".
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS scripts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '{"start_node_id": null, "nodes": []}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS shares (
                token      TEXT PRIMARY KEY,
                script_id  INTEGER,
                script_name TEXT NOT NULL,
                content    TEXT NOT NULL,
                invite_only INTEGER NOT NULL DEFAULT 0,   -- 1 = new answers need an invite code
                -- Answer-open rules for NEW sessions (all UTC, ISO-8601).
                -- NULL means "no restriction": no earliest start, no deadline,
                -- no session cap respectively. The rules gate only the
                -- creation of new answer sessions; already started sessions keep
                -- answering, and editor preview runs never see the gate.
                open_started_at  TEXT,                    -- inclusive earliest start
                open_deadline_at TEXT,                    -- exclusive deadline
                max_new_runs     INTEGER,                 -- positive cap on created sessions
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                mode            TEXT NOT NULL,            -- 'script' | 'share'
                script_id       INTEGER,
                share_token     TEXT,
                current_node_id TEXT,
                steps           TEXT NOT NULL DEFAULT '[]',
                finished        INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT NOT NULL
            );

            -- One-time pause/resume tokens for read-only share answer sessions.
            -- Each row is bound to exactly one share snapshot (share_token) and
            -- one run; used=1 flips on the single successful resume.
            CREATE TABLE IF NOT EXISTS resume_tokens (
                token       TEXT PRIMARY KEY,
                run_id      INTEGER NOT NULL,
                share_token TEXT NOT NULL,
                used        INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_resume_tokens_run ON resume_tokens(run_id);

            -- Invite codes gating new answer sessions of one share snapshot.
            -- A code belongs to exactly one share (share_token); used=1 flips
            -- atomically in the SAME write transaction that inserts the run,
            -- so verification + consumption + session creation either all
            -- happen or none do.
            CREATE TABLE IF NOT EXISTS invite_codes (
                code        TEXT PRIMARY KEY,
                share_token TEXT NOT NULL,
                used        INTEGER NOT NULL DEFAULT 0,
                run_id      INTEGER,
                created_at  TEXT NOT NULL,
                used_at     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_invite_codes_share
                ON invite_codes(share_token);

            -- Multilingual translations for ONE target language per script.
            -- Every row is bound to a concrete node/option by its ids (never
            -- by position): when a node/option is deleted the matching rows
            -- are removed when the script is saved, so an old translation can
            -- never attach to a newly created object even if an id recurs.
            -- source_hash pins the original text the translation was written
            -- against; status derives from it: 'reviewed' while the current
            -- source hashes equal, 'pending' (待复核) once the source changes.
            CREATE TABLE IF NOT EXISTS translations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                script_id   INTEGER NOT NULL,
                lang_code   TEXT NOT NULL,
                node_id     TEXT NOT NULL,
                field       TEXT NOT NULL,   -- 'title' | 'text' | 'option_label'
                option_id   TEXT,            -- non-null only for option_label
                translation TEXT NOT NULL DEFAULT '',
                source_hash TEXT NOT NULL DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'reviewed',
                updated_at  TEXT NOT NULL
            );
            -- SQLite treats NULLs as distinct in a plain UNIQUE index, so the
            -- node fields and the option fields need separate partial indexes.
            CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_node
                ON translations (script_id, lang_code, node_id, field)
                WHERE option_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_option
                ON translations (script_id, lang_code, node_id, field, option_id)
                WHERE option_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_translations_script
                ON translations (script_id);
            """
        )
        # Backfill old databases created before these features existed.
        backfills = [
            ("shares", "invite_only",
             "ALTER TABLE shares ADD COLUMN invite_only INTEGER NOT NULL DEFAULT 0"),
            ("scripts", "lang_code", "ALTER TABLE scripts ADD COLUMN lang_code TEXT"),
            ("scripts", "lang_label", "ALTER TABLE scripts ADD COLUMN lang_label TEXT"),
            ("shares", "lang_code", "ALTER TABLE shares ADD COLUMN lang_code TEXT"),
            ("shares", "lang_label", "ALTER TABLE shares ADD COLUMN lang_label TEXT"),
            ("shares", "translations",
             "ALTER TABLE shares ADD COLUMN translations TEXT NOT NULL DEFAULT '{}'"),
            ("shares", "open_started_at",
             "ALTER TABLE shares ADD COLUMN open_started_at TEXT"),
            ("shares", "open_deadline_at",
             "ALTER TABLE shares ADD COLUMN open_deadline_at TEXT"),
            ("shares", "max_new_runs",
             "ALTER TABLE shares ADD COLUMN max_new_runs INTEGER"),
        ]
        for table, column, ddl in backfills:
            cols = {r["name"] for r in db.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in cols:
                db.execute(ddl)
