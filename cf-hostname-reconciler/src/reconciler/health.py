"""Minimal /healthz endpoint backed by http.server."""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log = logging.getLogger(__name__)


@dataclass
class HealthState:
    last_success_ts: float | None = None
    last_run_ts: float | None = None
    last_error: str | None = None
    added: int = 0
    deleted: int = 0
    errors: int = 0
    latch_tripped: bool = False
    latch_reason: str = ""
    zones: list[str] = field(default_factory=list)
    desired_count: int = 0
    actual_count: int = 0
    dry_run: bool = False

    def __post_init__(self) -> None:
        self._lock = threading.Lock()

    def snapshot(self) -> dict:
        with self._lock:
            data = {k: v for k, v in asdict(self).items()}
        data["healthy"] = self.last_success_ts is not None
        return data

    def update(self, **kwargs) -> None:
        with self._lock:
            for key, value in kwargs.items():
                setattr(self, key, value)

    def bump(self, **kwargs: int) -> None:
        with self._lock:
            for key, value in kwargs.items():
                setattr(self, key, getattr(self, key) + value)


class _Handler(BaseHTTPRequestHandler):
    state: HealthState

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path.rstrip("/") not in ("/healthz", ""):
            self.send_error(404)
            return
        payload = json.dumps(self.state.snapshot(), default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass  # keep the access log out of stdout


def start_health_server(state: HealthState, port: int) -> ThreadingHTTPServer:
    handler = type("Handler", (_Handler,), {"state": state})
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    threading.Thread(target=server.serve_forever, name="healthz", daemon=True).start()
    log.info("health server listening", extra={"port": port})
    return server
