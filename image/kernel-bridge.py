#!/usr/bin/env python3
"""Jupyter kernel bridge for the claude-bioflow adapter.

Runs as a child of the Node adapter. Takes commands on stdin (one JSON object
per line) and emits events on stdout (one JSON object per line).

Commands (stdin):
  {"op":"execute","cell_id":"<id>","code":"<src>","kernelspec":"python3|ir"}
  {"op":"interrupt"}
  {"op":"restart"}
  {"op":"shutdown"}
  {"op":"status"}

Events (stdout):
  {"op":"iopub","cell_id":"<id|null>","msg_type":"stream|execute_result|display_data|error|status","content":{...}}
  {"op":"execute_reply","cell_id":"<id>","status":"ok|error","execution_count":<n>}
  {"op":"restarted"}
  {"op":"interrupted"}
  {"op":"status","state":"starting|idle|busy|dead"}
  {"op":"error","error":"<msg>"}
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import traceback
from typing import Any, Dict, Optional

from jupyter_client.manager import KernelManager


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


class Bridge:
    def __init__(self) -> None:
        self.km: Optional[KernelManager] = None
        self.kc = None
        self.kernelspec = "python3"
        # Map: parent msg_id -> cell_id (for tagging iopub messages).
        self.pending: Dict[str, str] = {}
        self._iopub_thread: Optional[threading.Thread] = None

    def ensure(self, kernelspec: str) -> None:
        if self.km and self.km.is_alive() and kernelspec == self.kernelspec:
            return
        if self.km:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception:
                pass
        self.kernelspec = kernelspec or "python3"
        emit({"op": "status", "state": "starting"})
        self.km = KernelManager(kernel_name=self.kernelspec)
        self.km.start_kernel()
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        emit({"op": "status", "state": "idle"})
        self._start_iopub_reader()

    def _start_iopub_reader(self) -> None:
        # Stop any previous reader implicitly by rebinding — threads are daemon.
        thread = threading.Thread(target=self._iopub_loop, daemon=True)
        thread.start()
        self._iopub_thread = thread

    def _iopub_loop(self) -> None:
        kc = self.kc
        while kc is self.kc and kc is not None:
            try:
                msg = kc.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                continue
            except Exception as e:
                emit({"op": "error", "error": f"iopub read failed: {e}"})
                return
            parent = (msg.get("parent_header") or {}).get("msg_id")
            cell_id = self.pending.get(parent)
            msg_type = msg.get("msg_type")
            content = msg.get("content") or {}
            emit({
                "op": "iopub",
                "cell_id": cell_id,
                "msg_type": msg_type,
                "content": content,
                "parent_msg_id": parent,
            })
            if msg_type == "status":
                state = content.get("execution_state")
                if state == "idle" and parent in self.pending:
                    # Execution for this cell has reached the idle boundary.
                    # Leave the mapping; we rely on execute_reply on shell to clear it.
                    pass

    def execute(self, cell_id: str, code: str, kernelspec: str) -> None:
        self.ensure(kernelspec or "python3")
        assert self.kc is not None
        msg_id = self.kc.execute(code, store_history=True)
        self.pending[msg_id] = cell_id

        def wait_reply() -> None:
            try:
                reply = self.kc.get_shell_msg(timeout=None) if self.kc else None
            except Exception as e:
                emit({"op": "execute_reply", "cell_id": cell_id,
                      "status": "error", "error": str(e)})
                return
            if reply is None:
                return
            content = reply.get("content") or {}
            reply_parent = (reply.get("parent_header") or {}).get("msg_id")
            emit({
                "op": "execute_reply",
                "cell_id": self.pending.pop(reply_parent, cell_id),
                "status": content.get("status", "ok"),
                "execution_count": content.get("execution_count"),
                "error": content.get("ename"),
            })

        threading.Thread(target=wait_reply, daemon=True).start()

    def interrupt(self) -> None:
        if self.km:
            self.km.interrupt_kernel()
        emit({"op": "interrupted"})

    def restart(self) -> None:
        if self.km:
            self.km.restart_kernel()
            self.kc = self.km.client()
            self.kc.start_channels()
            self.kc.wait_for_ready(timeout=60)
            self._start_iopub_reader()
            emit({"op": "restarted"})
        else:
            emit({"op": "restarted"})

    def shutdown(self) -> None:
        if self.km:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception:
                pass
        emit({"op": "status", "state": "dead"})

    def status(self) -> None:
        alive = bool(self.km and self.km.is_alive())
        emit({"op": "status", "state": "idle" if alive else "dead"})


def main() -> None:
    bridge = Bridge()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"op": "error", "error": f"bad json: {e}"})
            continue
        op = cmd.get("op")
        try:
            if op == "execute":
                bridge.execute(
                    cmd.get("cell_id", ""),
                    cmd.get("code", ""),
                    cmd.get("kernelspec", "python3"),
                )
            elif op == "interrupt":
                bridge.interrupt()
            elif op == "restart":
                bridge.restart()
            elif op == "shutdown":
                bridge.shutdown()
                return
            elif op == "status":
                bridge.status()
            else:
                emit({"op": "error", "error": f"unknown op: {op}"})
        except Exception as e:
            emit({"op": "error", "error": str(e),
                  "trace": traceback.format_exc()})


if __name__ == "__main__":
    main()
