import asyncio
import time

import httpx

from helpers import log
from planner import State
from session import Session

MARGIN_S = 0.02  # small safety on top of the response-time anchor
RECHECK_S = 0.5  # longest sleep between two /me reads while waiting


class ThrottleGate:
    """The only door to throttled endpoints. Knows when the next call is allowed."""

    def __init__(self, session: Session, state: State):
        self.session = session
        self.state = state
        # we don't know when the last call happened (maybe a previous run), assume now
        self.last_done = time.monotonic()
        self.blocked_until = 0.0
        self._lock = asyncio.Lock()

    def next_allowed(self) -> float:
        window = self.state.throttle_ms / 1000
        return max(self.last_done + window + MARGIN_S, self.blocked_until)

    def see_me(self, me: dict, at: float) -> None:
        # called with every fresh /me, by the watcher and by wait_ready
        if self.state.apply_me(me):
            # a new attacker: assume the attack restarted our window (safe either way)
            self.last_done = max(self.last_done, at)
            log(f"[gate] new attacker, throttle={self.state.throttle_ms}")

    async def wait_ready(self) -> None:
        # re-read /me after every short sleep: a defend or burst shortens the window,
        # an attack makes it longer, and the last read must be just before firing
        while True:
            me = await self.session.get_json("/auth/me")
            self.see_me(me, time.monotonic())
            delay = self.next_allowed() - time.monotonic()
            if delay <= 0:
                return
            await asyncio.sleep(min(delay, RECHECK_S))

    async def call(self, path: str, params: dict | None = None) -> httpx.Response:
        async with self._lock:
            delay = self.next_allowed() - time.monotonic()
            if delay > 0:  # safety net, wait_ready should make this impossible
                log(f"[gate] call came {delay * 1000:.0f} ms early, waiting")
                await asyncio.sleep(delay)
            try:
                res = await self.session.request("GET", path, params=params)
            except httpx.RequestError:
                self.last_done = time.monotonic()  # the server may have counted it
                raise
            now = time.monotonic()
            if res.status_code == 429:
                wait = int(res.headers.get("retry-after", "1"))
                self.blocked_until = now + wait
                log(f"[gate] !!! 429 on {path}, blocked for {wait}s")
            else:
                # the server stamped the call before this response arrived
                self.last_done = now
            return res
