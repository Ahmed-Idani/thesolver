import asyncio
import time

import httpx

from helpers import log

LOGIN_URL = "/auth/login"
RETRY_503 = (0.1, 0.2, 0.4)  # backoff in seconds, a 503 never costs a window


class Session:
    """Owns the token. Every API call goes through request()."""

    def __init__(self, client: httpx.AsyncClient, email: str, password: str):
        self.client = client
        self.email = email
        self.password = password
        self.token = ""
        self.logged_at = 0.0
        self._lock = asyncio.Lock()

    async def login(self) -> None:
        for delay in (*RETRY_503, None):
            res = await self.client.post(
                LOGIN_URL, json={"email": self.email, "password": self.password}
            )
            if res.status_code != 503 or delay is None:
                break
            await asyncio.sleep(delay)
        res.raise_for_status()
        self.token = res.json()["accessToken"]
        self.logged_at = time.monotonic()
        log("[auth] logged in")

    async def relogin(self, stale_token: str) -> None:
        # a new login kills the old token, so only one task may log in,
        # and only if nobody replaced the stale token while we waited for the lock
        async with self._lock:
            if self.token != stale_token:
                return
            log("[auth] 401, logging in again")
            await self.login()

    async def request(self, method: str, path: str, **kw) -> httpx.Response:
        relogged = False
        tries_503 = 0
        while True:
            token = self.token  # remember which token this attempt used
            res = await self.client.request(
                method, path, headers={"Authorization": f"Bearer {token}"}, **kw
            )
            if res.status_code == 401 and not relogged:
                relogged = True
                await self.relogin(token)
                continue
            if res.status_code == 503 and tries_503 < len(RETRY_503):
                await asyncio.sleep(RETRY_503[tries_503])
                tries_503 += 1
                continue
            return res

    async def get_json(self, path: str):
        res = await self.request("GET", path)
        res.raise_for_status()
        return res.json()
