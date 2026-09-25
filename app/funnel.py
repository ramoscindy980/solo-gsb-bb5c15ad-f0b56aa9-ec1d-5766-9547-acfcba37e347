"""Share answer path funnel: prefix tree (trie) over recorded choices.

Each answer session of one read-only share snapshot contributes the sequence
of choices the respondent actually made, every entry being the snapshot's
original ``(node_id, option_id)`` pair. The sequences are inserted into a
prefix tree keyed by depth — NOT collapsed by node, so choosing the same
option again while walking a cycle creates a separate edge at the deeper
level. Every prefix reports how many sessions reached it, how many stopped
there unfinished, how many finished there, and the reach ratio relative to
its parent prefix; clicking a prefix lists the run ids of its sessions.
"""
from __future__ import annotations

from typing import Any


def _choice_path(steps: list[dict] | None) -> list[tuple[Any, Any]]:
    """Ordered (node_id, option_id) pairs from one recorded session's steps.

    The run format stores one step per visited node; the chosen option lives
    on the step of the node the choice was made at (``option_id`` non-null).
    Only those steps are path entries — the start step and any trailing
    un-answered step carry no option and cannot be a funnel edge.
    """
    return [(s.get("node_id"), s.get("option_id"))
            for s in (steps or []) if s.get("node_id") and s.get("option_id")]


def build_funnel(content: dict[str, Any], sessions: list[dict]) -> dict[str, Any]:
    """Build the answer-path prefix tree for one share snapshot.

    ``content`` is the snapshot's frozen script (titles/option labels are
    read from it, so the funnel always shows the original text respondents
    actually saw — never the script's current labels). ``sessions`` are
    ``{"run_id", "steps", "finished", "created_at"}`` rows whose
    ``share_token`` matches that snapshot.

    Every trie node counts:
      reached            sessions whose path contains this prefix
      stopped_unfinished sessions whose path ENDS at this prefix and are not
                         finished (they dropped off here mid-answer)
      completed          sessions whose path ends at this prefix and are
                         finished (the funnel endpoint for them)
      ratio              reached / parent.reached, ``None`` for the root

    Child ordering is deterministic: snapshot option order of the choice's
    source node first, then busier prefixes (higher reach), then option id.
    """
    nodes_list = content.get("nodes") or []
    node_map = {n.get("id"): n for n in nodes_list}

    def node_title(node_id: Any) -> str:
        n = node_map.get(node_id)
        if n is not None:
            return n.get("title") or str(node_id)
        return str(node_id) if node_id is not None else "—"

    def option_info(node_id: Any, option_id: Any) -> tuple[str, Any, str]:
        """(option label, target node id, target title) from the frozen snapshot."""
        n = node_map.get(node_id)
        opt = next((o for o in (n or {}).get("options", []) or []
                    if o.get("id") == option_id), None)
        label = (opt or {}).get("label") or (str(option_id) if option_id is not None else "—")
        target_id = (opt or {}).get("target_id")
        target_title = node_title(target_id)
        return label, target_id, target_title

    # node id -> option id -> index in that node's snapshot option list.
    option_order: dict[Any, dict[Any, int]] = {}
    for n in nodes_list:
        option_order[n.get("id")] = {o.get("id"): i
                                     for i, o in enumerate(n.get("options", []) or [])}

    def new_trie() -> dict[str, Any]:
        return {"reached": 0, "stopped": 0, "completed": 0,
                "sessions": [], "children": {}}

    root = new_trie()
    total = completed = total_choices = 0

    # Newest sessions first in every prefix's session list.
    sessions = sorted(sessions, key=lambda r: r["run_id"], reverse=True)
    for row in sessions:
        path = _choice_path(row["steps"])
        is_finished = bool(row["finished"])
        total += 1
        if is_finished:
            completed += 1
        total_choices += len(path)

        cur = root
        cur["reached"] += 1
        cur["sessions"].append(row)
        for node_id, option_id in path:
            cur = cur["children"].setdefault((node_id, option_id), new_trie())
            cur["reached"] += 1
            cur["sessions"].append(row)
        # The terminal trie node is the last prefix reached: for a session
        # with zero choices that is the root itself. It is either a completed
        # answer or an unfinished drop-off exactly at that prefix.
        cur["completed" if is_finished else "stopped"] += 1

    def serialize(trie: dict[str, Any], *, depth: int, parent_reached: int,
                  prefix: list[tuple], node_id: Any = None,
                  option_id: Any = None) -> dict[str, Any]:
        def out_session(row: dict) -> dict[str, Any]:
            steps = row["steps"]
            return {"run_id": row["run_id"], "finished": bool(row["finished"]),
                    "created_at": row.get("created_at"),
                    "choice_count": len(_choice_path(steps))}

        result: dict[str, Any] = {
            "depth": depth,
            "reached": trie["reached"],
            "stopped_unfinished": trie["stopped"],
            "completed": trie["completed"],
            "ratio": (round(trie["reached"] / parent_reached, 4)
                      if parent_reached else None),
            "sessions": [out_session(r) for r in trie["sessions"]],
        }
        if depth > 0:
            label, target_id, target_title = option_info(node_id, option_id)
            # Same (node, option) appearing again deeper in one prefix marks a
            # repeated choice inside a loop — kept as its own level, not merged.
            repeated = any(p[0] == node_id and p[1] == option_id for p in prefix[:-1])
            result.update({
                "node_id": node_id,
                "node_title": node_title(node_id),
                "option_id": option_id,
                "option_label": label,
                "target_id": target_id,
                "target_title": target_title,
                "repeated_in_path": repeated,
            })

        def child_key(key: tuple) -> tuple:
            nid, oid = key
            order = option_order.get(nid, {}).get(oid)
            order = order if order is not None else 10**9
            child = trie["children"][key]
            return (order, -child["reached"], str(oid))

        children_out = []
        for key in sorted(trie["children"].keys(), key=child_key):
            children_out.append(serialize(
                trie["children"][key], depth=depth + 1,
                parent_reached=trie["reached"], prefix=prefix + [key],
                node_id=key[0], option_id=key[1]))
        result["children"] = children_out
        return result

    tree = serialize(root, depth=0, parent_reached=0, prefix=[])
    return {
        "session_count": total,
        "completed_count": completed,
        "unfinished_count": total - completed,
        "total_choices": total_choices,
        "tree": tree,
    }
