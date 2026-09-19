# The Python half of running a cell — what dewlab's assets/tutorial_tools.py
# (1498 lines) does for a whole tutorial page, trimmed to what one exec cell
# in dewnote actually needs. Not a copy: dewlab's file also renders DOM
# widgets (text_input, dropdown, button, image_input), seeds a SQL cell's
# database, and coaches a student through import errors specific to its own
# tutorials — none of which has a place here. What is kept is the real
# mechanism: a shared namespace across cells in one document, stdout/stderr
# captured per cell, a trailing expression rendered the way a notebook cell's
# value is, a matplotlib figure rendered as a PNG, and a traceback trimmed to
# the cell's own source rather than this module's plumbing.
#
# Written directly against what the worker (src/runtime/worker-source.ts)
# needs: run_cell(cell_id, emit, code), where `emit` is a JS callback taking
# (kind, css_class, text, markup) — kind is "stream", "append" or "clear",
# matching dewlab's own output-event protocol exactly, so the browser-side
# code that applies these to the DOM can be a direct port of dewlab's
# applyOutputEvent rather than a new design.

import html
import io
import linecache
import sys
import traceback
from typing import Any, Callable


def read_sql(db_name: str, query: str) -> Any:
    """Reads a SQL cell's own table as a pandas DataFrame — dewstack's own
    bridge between a Python cell and a SQL cell (DIALECTS.md §2,
    `python_tools.py`'s `read_sql`), ported onto dewnote's one shared
    exec-cell namespace instead of dewstack's per-name `py cell=`
    namespaces: every exec cell already has this, not just ones sharing
    some name with a SQL cell. Requires `dewnote_sql_tools` (and the
    `sqlite3` package it needs) already loaded — worker-source.ts's
    `runCell` checks a cell's own code for the literal substring
    "read_sql(" before running it and loads both first if it's there, a
    plain heuristic (not real static analysis, and missed by something
    indirect like `fn = read_sql; fn(...)`) documented as such rather
    than pretended to be exact."""
    import pandas as pd
    import dewnote_sql_tools

    return pd.read_sql_query(query, dewnote_sql_tools.get_connection(db_name))


# One namespace for the life of the interpreter — this is what makes a
# second cell see a first cell's variables, the way a notebook does.
# read_sql is pre-seeded the way dewstack's own py cell namespaces are,
# so a cell can call it without importing anything first.
_page_globals: dict[str, Any] = {"__name__": "__dewnote__", "read_sql": read_sql}

_figures_rendered: set[int] = set()


class _StreamWriter(io.TextIOBase):
    """Stands in for sys.stdout / sys.stderr while a cell runs, sending every
    write straight to the current cell's output rather than buffering it —
    a cell's own print() needs to appear as the cell runs, not all at once
    at the end."""

    def __init__(self, css_class: str, emit: Callable[[str, str, str, str], None]):
        self.css_class = css_class
        self.emit = emit

    def write(self, text: str) -> int:
        if text:
            self.emit("stream", self.css_class, text, "")
        return len(text)

    def flush(self) -> None:
        pass


def _is_user_frame(filename: str) -> bool:
    return filename.startswith("<cell ")


def _format_exception(exc: BaseException) -> str:
    """A traceback string with dewnote's own machinery (eval_code_async,
    this module) filtered out of every frame, in every exception in the
    __cause__/__context__ chain — so what a reader sees points only at
    their own code. A SyntaxError has no frames to filter; its own
    formatted message already carries the file, line and caret."""
    summary = traceback.TracebackException.from_exception(exc)
    chain = [summary]
    node = summary
    while node.__cause__ is not None or node.__context__ is not None:
        node = node.__cause__ or node.__context__
        chain.append(node)
    for item in chain:
        item.stack[:] = [f for f in item.stack if f.filename and _is_user_frame(f.filename)]
    return "".join(summary.format())


def _table_html(value: Any) -> str | None:
    try:
        import pandas as pd
    except ImportError:
        return None
    if isinstance(value, (pd.DataFrame, pd.Series)):
        return value.to_html(max_rows=20, notebook=True)
    return None


def _figure_png_html(figure: Any) -> str:
    buf = io.BytesIO()
    figure.savefig(buf, format="png", bbox_inches="tight")
    import base64

    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f'<div class="dn-figure"><img src="data:image/png;base64,{encoded}" alt=""></div>'


def _flush_figures(emit: Callable[[str, str, str, str], None]) -> None:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return
    for num in plt.get_fignums():
        if num in _figures_rendered:
            continue
        figure = plt.figure(num)
        emit("append", "", "", _figure_png_html(figure))
        _figures_rendered.add(num)
    plt.close("all")
    _figures_rendered.clear()


def _render_value(value: Any, emit: Callable[[str, str, str, str], None]) -> None:
    if value is None:
        return
    try:
        import matplotlib.figure

        if isinstance(value, matplotlib.figure.Figure):
            emit("append", "", "", _figure_png_html(value))
            return
        import matplotlib.artist

        if isinstance(value, matplotlib.artist.Artist) or (
            isinstance(value, list) and value and all(isinstance(v, matplotlib.artist.Artist) for v in value)
        ):
            return  # plt.plot(...)'s own return value — not worth showing
    except ImportError:
        pass
    table = _table_html(value)
    if table is not None:
        emit("append", "", "", table)
        return
    emit("append", "", "", f'<pre class="dn-repr">{html.escape(repr(value))}</pre>')


async def run_cell(cell_id: str, emit: Callable[[str, str, str, str], None], code: str) -> bool:
    """Runs `code` against the shared namespace, streaming output through
    `emit` as it happens. Returns True on success. `emit`'s three kinds
    match dewlab's own protocol: "clear" wipes the cell's output area,
    "stream" appends running text (print, stderr), "append" inserts one
    complete, self-contained HTML fragment (a table, a figure, an error)."""
    emit("clear", "", "", "")
    filename = f"<cell {cell_id}>"
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)

    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = _StreamWriter("dn-stdout", emit)
    sys.stderr = _StreamWriter("dn-error", emit)
    try:
        from pyodide.code import eval_code_async

        value = await eval_code_async(code, globals=_page_globals, filename=filename)
        _render_value(value, emit)
        _flush_figures(emit)
        return True
    except KeyboardInterrupt:
        emit("append", "", "", '<pre class="dn-error">Stopped.</pre>')
        return False
    except BaseException as exc:  # noqa: BLE001 - a cell's own exception, of any kind, is data here
        emit("append", "", "", f'<pre class="dn-error">{html.escape(_format_exception(exc))}</pre>')
        return False
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr


def reset_namespace() -> None:
    """Used by a document-wide restart, not by an ordinary cell run — the
    shared globals dict is exactly what makes cells act like a notebook,
    so nothing should clear it except a deliberate reset."""
    _page_globals.clear()
    _page_globals["__name__"] = "__dewnote__"
    _page_globals["read_sql"] = read_sql
    _figures_rendered.clear()
