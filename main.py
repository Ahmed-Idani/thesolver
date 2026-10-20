import asyncio
import os
import time

import httpx
from dotenv import load_dotenv

from gate import ThrottleGate
from helpers import log, reload_solvers
from planner import State, apply_result, choose_action, solve_all
from session import Session

load_dotenv()

BASE_URL = os.getenv("BASE_URL")
WATCH_EVERY_S = 0.5
IDLE_S = 0.2
RUN_FOR = float(os.getenv("RUN_FOR", "0")) or None  # seconds, for mock tests


async def watcher(session: Session, state: State, gate: ThrottleGate) -> None:
    while True:
        me, users, teams = await asyncio.gather(
            session.get_json("/auth/me"),
            session.get_json("/users"),
            session.get_json("/teams"),
            return_exceptions=True,
        )
        if isinstance(me, dict):
            gate.see_me(me, time.monotonic())
        if isinstance(users, list) and isinstance(teams, list):
            state.apply_world(users, teams)
        for r in (me, users, teams):
            if isinstance(r, Exception):
                log(f"[watcher] {type(r).__name__}: {r}")
        await asyncio.sleep(WATCH_EVERY_S)


async def actor(state: State, gate: ThrottleGate) -> None:
    while True:
        try:
            if reload_solvers():
                state.answers.clear()
                state.bad.clear()
                solve_all(state)
            await gate.wait_ready()
            action = choose_action(state, time.monotonic())
            if action is None:
                await asyncio.sleep(IDLE_S)
                continue
            res = await gate.call(action.path, action.params)
            log(
                f"[actor] {action.kind} {action.target} {action.why} -> "
                f"{res.status_code} {res.text[:80]} | throttle={state.throttle_ms} score={state.score}"
            )
            apply_result(state, action, res, time.monotonic())
        except Exception as e:
            log(f"[actor] {type(e).__name__}: {e}")
            await asyncio.sleep(0.5)


async def main() -> None:
    async with httpx.AsyncClient(base_url=BASE_URL, http2=True, timeout=10) as client:
        session = Session(client, os.getenv("email"), os.getenv("password"))
        await session.login()
        state = State()
        gate = ThrottleGate(session, state)
        gate.see_me(await session.get_json("/auth/me"), time.monotonic())
        async with asyncio.timeout(RUN_FOR):
            async with asyncio.TaskGroup() as tg:
                tg.create_task(watcher(session, state, gate))
                tg.create_task(actor(state, gate))


def print_stats() -> None:
    # mock only
    try:
        stats = httpx.get(BASE_URL.removesuffix("/api") + "/__stats").json()
        stats.pop("me", None)
        log(f"stats: {stats}")
    except Exception:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, TimeoutError):
        log("stopped")
    finally:
        print_stats()
