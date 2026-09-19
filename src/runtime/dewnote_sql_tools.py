# The Python half of a dewstack-style SQL cell (` ```sql cell=name `,
# DIALECTS.md §2) — a trimmed adaptation of dewstack's sql_tools.py. Kept:
# one in-memory sqlite3 connection per cell name, shared by every cell on
# the page using that name, run_sql's own contract — a script (not one
# statement), comments stripped, run as a script, the last statement's
# result rendered as an HTML table if it has one, an affected-row count
# otherwise — and get_connection, the public door dewnote_tools.py's own
# read_sql uses to reach a SQL cell's connection from an exec cell.
# Dropped: the five sql-check functions (sql-check is dewstack's own
# quiz-grading convention, hardcoded to one tutorial there; dewnote has
# no equivalent concept yet).
#
# Written directly against what the worker (src/runtime/worker-source.ts)
# needs: run_sql(db_name, script) -> str, a complete HTML fragment, the
# same "Python returns HTML, JS assigns it" wire format dewstack itself
# uses — no message envelope to design.

import html
import sqlite3
from typing import Any

_connections: dict[str, sqlite3.Connection] = {}


def _connection(db_name: str) -> sqlite3.Connection:
    if db_name not in _connections:
        _connections[db_name] = sqlite3.connect(":memory:")
    return _connections[db_name]


def get_connection(db_name: str) -> sqlite3.Connection:
    """The public door onto a SQL cell's own connection — dewnote_tools.py's
    read_sql is the only caller today, matching dewstack's own
    get_connection/read_sql pair. Creates the connection (empty) if
    nothing has run against this name yet, the same as any other call
    that touches `db_name` — read_sql before any SQL cell has run gets an
    empty database, not an error."""
    return _connection(db_name)


def reset(db_name: str) -> None:
    """Used by a cell's own Reset control — closes and discards the
    connection, so a CREATE TABLE can be run again from scratch."""
    conn = _connections.pop(db_name, None)
    if conn is not None:
        conn.close()


def _strip_comments(script: str) -> str:
    lines = []
    for line in script.splitlines():
        index = line.find("--")
        lines.append(line if index == -1 else line[:index])
    return "\n".join(lines)


def _table_html(columns: list[str], rows: list[tuple[Any, ...]], max_rows: int = 50) -> str:
    shown = rows[:max_rows]
    head = "".join(f"<th>{html.escape(str(c))}</th>" for c in columns)
    body = "".join(
        "<tr>" + "".join(f"<td>{'' if v is None else html.escape(str(v))}</td>" for v in row) + "</tr>"
        for row in shown
    )
    note = '<p class="dn-sql-note">Showing the first 50 rows.</p>' if len(rows) > max_rows else ""
    return f'<div class="dn-sql-result"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>{note}'


def run_sql_cell(conn: sqlite3.Connection, script: str) -> Any:
    """dewlab's own `sql exec` cell (`_run_sql_cell` there,
    DIALECTS.md §1) — the one, page-wide `db` connection every `sql
    exec` cell shares, not the per-name `_connections` dict the rest of
    this module manages for dewstack's own `sql cell=name` fences.

    Splits `script` on a bare `;`, runs every statement but the last for
    effect, and returns the last statement's own result — a pandas
    DataFrame if it had rows to show, or `None` after printing a plain
    "N rows affected" line for a CREATE/INSERT/UPDATE/DELETE, since there
    is no value worth returning for those. Every statement commits at
    the end.

    Deliberately returns rather than renders: `dewnote_tools.py`'s own
    `run_cell` already renders a cell's trailing value (a DataFrame
    through the same `_render_value` path a `python exec` cell's own
    trailing DataFrame takes), so this needs no rendering of its own —
    unlike dewlab's version, which renders itself because dewlab's own
    per-cell `sink` has no equivalent "render my own trailing value"
    step to reuse.
    """
    import pandas as pd

    statements = [s.strip() for s in _strip_comments(script).split(";") if s.strip()]
    if not statements:
        return None
    for statement in statements[:-1]:
        conn.execute(statement)
    cursor = conn.execute(statements[-1])
    frame = None
    if cursor.description:
        columns = [d[0] for d in cursor.description]
        frame = pd.DataFrame(cursor.fetchall(), columns=columns)
    else:
        noun = "row" if cursor.rowcount == 1 else "rows"
        print(f"{cursor.rowcount if cursor.rowcount >= 0 else 0} {noun} affected.")
    conn.commit()
    return frame


def run_sql(db_name: str, script: str) -> str:
    """Runs `script` as a sequence of `;`-separated statements against
    `db_name`'s own connection (created on first use), all but the last
    for effect, the last one's result rendered: a table if it has rows to
    show, an affected-row count otherwise. A naive split on `;` — a
    semicolon inside a string literal would break it, a limitation
    inherited from dewstack's own run_sql rather than fixed here."""
    conn = _connection(db_name)
    statements = [s.strip() for s in _strip_comments(script).split(";")]
    statements = [s for s in statements if s]
    if not statements:
        return '<p class="dn-sql-note">Nothing to run.</p>'
    try:
        cursor = None
        for statement in statements:
            cursor = conn.execute(statement)
        conn.commit()
        assert cursor is not None
        if cursor.description:
            columns = [d[0] for d in cursor.description]
            return _table_html(columns, cursor.fetchall())
        return f'<p class="dn-sql-note">{cursor.rowcount if cursor.rowcount >= 0 else 0} row(s) affected.</p>'
    except sqlite3.Error as exc:
        return f'<pre class="dn-error">{html.escape(str(exc))}</pre>'
