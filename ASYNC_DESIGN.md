# Async client design: Double Trouble

Everything you need to rewrite the client yourself. It covers the design, function signatures, the tricky logic as pseudocode, pitfalls found by testing, and the test plan.

Contents:
1. What the server really does
2. asyncio vs threads
3. Architecture and data flow
4. Pattern choice
5. Files, functions and signatures
6. Throttle correctness
7. Tokens, errors, shutdown, hot reload
8. Action priority (choose_action)
9. Pitfalls found while testing
10. Bugs in the current code
11. Testing against the mock
12. Build order
13. Checklist for the real session

---

## 1. What the server really does

Read from `mock/server.js` (`throttled()` around line 378). The real server probably behaves the same, but check during warm-up.

- The server stamps `lastActionAt` when the request **arrives**. It refuses with 429 if `lastActionAt + throttleMs > now`.
- It checks against the throttle **at the moment of the new call**, not the value from the previous call. An attack that lands while you wait makes your window longer.
- A 429 costs 1 nugget and does **not** restart the window.
- 503 and 401 come back **before** the throttle check, so they never use up a window. Retrying them right away is safe.
- A wrong answer, or a defend or attack that gets a 400, **does** use up a window, because the throttle check passes first. Never send a claim you are unsure about.
- In `attack-restart`, an attack on you sets your `lastActionAt = now`. You only find out through `/me`.
- `/me` is live. `/users` and `/teams` are snapshots that refresh once per second.
- One session only: logging in again kills the previous token.
- There is no refresh endpoint. When the token expires, log in again.

---

## 2. asyncio vs threads

Use **asyncio**. The program spends almost all its time waiting on the network or a timer, and asyncio handles that on one thread. Task switches only happen at an `await`, so code without an `await` in it runs without interruption and shared state mostly needs no locks.

Threads would add real races (two threads both logging in and killing each other's token, two threads both firing a throttled call) and would not run anything faster, because nothing here is CPU-bound.

---

## 3. Architecture and data flow

### 3.1 The pieces

There are 2 tasks (they run in a loop forever) and 3 objects (they only do something when a task calls them).

| Piece | Kind | What it holds | Its job |
|---|---|---|---|
| `watcher` | task | nothing | Every 0.5 s: reads `/me`, `/users`, `/teams` and writes them into State |
| `actor` | task | nothing | Waits for the slot, picks one action, fires it, records the result |
| `ThrottleGate` | object | `last_done`, `blocked_until`, a lock | Knows **when** the next throttled call is allowed; the only door to throttled endpoints |
| `Session` | object | `token`, a lock | Adds the token to every request, logs in again on 401, retries 503 |
| `State` | object | everything the game tells us | Shared memory. The watcher and gate write it, `choose_action` reads it |

### 3.2 How a request travels (layers)

Each layer only talks to the layer right below it.

```
   watcher task                         actor task
   (free endpoints)                     (throttled endpoints)
        |                                    |
        |                                    v
        |                             +--------------+
        |                             | ThrottleGate |  waits until allowed,
        |                             +--------------+  stamps last_done
        |                                    |
        v                                    v
   +-----------------------------------------------+
   |                   Session                     |  adds token, 401 -> login,
   +-----------------------------------------------+  503 -> retry
                          |
                          v
                 httpx.AsyncClient  ------>  server
```

The watcher **never** goes through the gate (its endpoints are free). The actor **always** does.

### 3.3 Who writes and who reads State

```
            WRITES                                READS
  watcher ---- me (via gate.see_me) ---->  +--------+
  watcher ---- users, teams ------------>  |        |
  gate    ---- me (inside wait_ready) -->  | State  | ----> choose_action  (decides)
  actor   ---- nuggets, answers, bad --->  |        | ----> gate.next_allowed (throttle_ms)
           (via apply_result, solve_all)   +--------+
```

| Field | Written by | Read by |
|---|---|---|
| `throttle_ms`, `attackers`, `score` | `apply_me` (called from watcher and from `wait_ready`) | `next_allowed`, `choose_action` |
| `users`, `team_ids` | `apply_world` (watcher) | `choose_action` (defend teammate, attack) |
| `nuggets`, `answers`, `bad` | `apply_result`, `solve_all` (actor) | `choose_action` (claim) |

### 3.4 One actor cycle, step by step

Example: throttle 3000 ms, the last call's response arrived at t = 10.00 s.

```
t=10.00  last call's response arrives  -> gate.last_done = 10.00
         next_allowed = 10.00 + 3.00 + 0.02 = 13.02

         wait_ready():
t=10.05    read /me   -> throttle 3000, not allowed yet, sleep 0.5
t=10.60    read /me   -> sleep 0.5
  ...      (if an attack arrives here, throttle becomes 4000
            and next_allowed moves to 14.02 by itself)
t=12.70    read /me   -> 0.32 s left, sleep 0.32
t=13.07    read /me   -> allowed, return

t=13.07  choose_action(state)   -> e.g. Action("claim", ...)   (no await, instant)
t=13.07  gate.call(action)      -> request goes out
t=13.12  response arrives       -> last_done = 13.12, the next cycle starts
         apply_result(...)      -> remove the claimed nugget from State
```

### 3.5 Both tasks at the same time

asyncio switches tasks only at an `await`. While the actor sleeps or waits for a response, the watcher runs, and the other way round.

```
time ->     0.0      0.5      1.0      1.5      2.0      2.5      3.0
watcher:    [poll]   [poll]   [poll]   [poll]   [poll]   [poll]   [poll]
actor:      [call]..wait_ready: /me, sleep, /me, sleep, ...........[call]
                     ^ each /me read updates State and can move next_allowed
```

Why this split:
- **The throttle lives in a gate object, not in a task.** It is the only code allowed to call throttled endpoints, so nothing can skip it by accident. As a passive object, it cannot drift out of sync with a separate loop.
- **Token handling doesn't get its own task.** The Session logs in again when it gets a 401. Only one login can run at a time, so tasks never kill each other's token.
- **State has no lock.** `apply_me` and `apply_world` have no `await` inside, so asyncio runs each one to the end without interruption.
- **The gate still keeps a lock.** It is cheap, and it guarantees there is never more than one throttled call in flight, even if you add tasks later.

---

## 4. Pattern choice

| Pattern | Good | Bad here |
|---|---|---|
| Producer/consumer with `asyncio.Queue` | Simple separation | A queued item goes stale while it waits up to 8 s (claim an already-taken nugget, defend from an attacker who already left). Each stale item costs a window or a 400. |
| Priority queue scheduler | Defend beats claim | Same staleness problem, plus you need to remove duplicates and expired items. |
| State machine | Clear for a discover -> claim cycle | Defend, attack and round changes cut into every state, so the number of transitions grows fast. |
| **Single actor that decides when the slot opens** (chosen) | Fresh decision every time | Nothing worth naming |

**Rule:** the window is the scarce resource, so you choose how to spend it at the last possible moment, using a `/me` read from a few ms earlier. The priority order is just the order of the `if` checks in `choose_action`.

---

## 5. Files, functions and signatures

```
main.py      watcher, actor, main, print_stats
session.py   Session (auth + HTTP)
gate.py      ThrottleGate (the throttle clock)
planner.py   State, Action, solve_all, choose_action, apply_result   (pure sync, no I/O)
helpers.py   log, reload_solvers (returns bool)
solvers.py   REGISTRY + @solver functions
```

### session.py

```python
class Session:
    def __init__(self, client: httpx.AsyncClient, email: str, password: str)
        # fields: client, email, password, token="", logged_at=0.0, _lock=asyncio.Lock()

    async def login(self) -> None
        # POST /auth/login {"email", "password"}; retry a few times on 503;
        # raise_for_status; store token and logged_at = time.monotonic()

    async def relogin(self, stale_token: str) -> None
        # async with self._lock:
        #     if self.token != stale_token: return   # another task already did it
        #     await self.login()

    async def request(self, method: str, path: str, **kw) -> httpx.Response
        # loop:
        #   token = self.token                 # remember WHICH token you used
        #   res = await client.request(..., headers={"Authorization": f"Bearer {token}"})
        #   401 and not yet relogged -> await relogin(token); continue
        #   503 and tries left       -> await asyncio.sleep(0.1 / 0.2 / 0.4); continue
        #   return res

    async def get_json(self, path: str)
        # request("GET", path); raise_for_status(); return res.json()
```

### gate.py

```python
MARGIN_S = 0.02    # small safety on top of the response-time anchor
RECHECK_S = 0.5    # longest sleep between two /me reads while waiting

class ThrottleGate:
    def __init__(self, session: Session, state: State)
        # last_done = time.monotonic()   <- NOT 0, see section 6
        # blocked_until = 0.0
        # _lock = asyncio.Lock()

    def next_allowed(self) -> float
        # max(last_done + state.throttle_ms / 1000 + MARGIN_S, blocked_until)

    def see_me(self, me: dict, at: float) -> None
        # if state.apply_me(me) is True (a new attacker appeared):
        #     last_done = max(last_done, at)   # assume the attack restarted the window

    async def wait_ready(self) -> None
        # loop:
        #   me = await session.get_json("/auth/me"); see_me(me, time.monotonic())
        #   delay = next_allowed() - time.monotonic()
        #   if delay <= 0: return
        #   await asyncio.sleep(min(delay, RECHECK_S))

    async def call(self, path: str, params: dict | None = None) -> httpx.Response
        # async with self._lock:
        #   if next_allowed() > now: log and sleep the difference (safety net)
        #   try: res = await session.request("GET", path, params=params)
        #   except httpx.RequestError: last_done = now; raise   # server may have counted it
        #   if res.status_code == 429:
        #       blocked_until = now + int(res.headers["retry-after"]); log LOUDLY
        #   else:
        #       last_done = time.monotonic()    # time the RESPONSE arrived
        #   return res
```

### planner.py

```python
@dataclass
class State:
    my_id: str; team_ids: set          # me + teammates (from /teams)
    attackers: set; attacking: set     # from /me
    throttle_ms: int = 3000; score: int = 0
    users: list                        # from /users
    nuggets: dict                      # id -> unclaimed nugget (from last discover)
    answers: dict                      # id -> answer string (precomputed)
    bad: set                           # wrong answers, skip until solvers reload
    no_attack: set                     # targets the server refused
    discovered_at: float = -1e9; need_discover: bool = True

    def apply_me(self, me: dict) -> bool        # updates fields, True if a NEW attacker id appeared
    def apply_world(self, users, teams) -> None # users, and team_ids = team containing my_id

@dataclass(frozen=True)
class Action:
    kind: str; path: str; params: dict | None = None; target: str = ""; why: str = ""

def ids(items) -> set[str]                       # accepts ["id", ...] or [{"_id": ...}, ...]
def solve_all(state: State) -> None              # fill answers; try/except AROUND EACH solver call
def ready_nuggets(state: State) -> list[str]     # in nuggets, has answer, not bad
def best_nugget(state: State) -> str | None      # highest coefficient among ready
def best_target(state: State) -> str | None      # enemy, not attacked by me, not refused, highest score
def choose_action(state: State, now: float) -> Action | None
def apply_result(state: State, action: Action, res, now: float) -> None
```

`apply_result` handles each action kind:
- **discover 200:** `nuggets = {id: n for n in body if not n["claimed"]}`, drop answers for ids that are gone, set `discovered_at`, set `need_discover = False`, call `solve_all`.
- **claim 200, "already claimed", or 404:** remove the nugget and its answer.
- **claim "Wrong answer":** add the id to `bad`.
- **claim, any other 400:** probably an old-round nugget. Clear `nuggets` and `answers` and set `need_discover = True`.
- **attack that fails:** add the target to `no_attack`.
- **defend and burst:** nothing to do. The next `/me` shows the effect.

### main.py

```python
async def watcher(session, state, gate) -> None
    # loop every 0.5 s:
    #   me, users, teams = await asyncio.gather(get /auth/me, /users, /teams, return_exceptions=True)
    #   if me is a dict: gate.see_me(me, time.monotonic())
    #   if users and teams are lists: state.apply_world(users, teams)
    #   log any exceptions, never raise

async def actor(state, gate) -> None
    # loop:
    #   try:
    #     if reload_solvers(): state.answers.clear(); state.bad.clear(); solve_all(state)
    #     await gate.wait_ready()
    #     action = choose_action(state, time.monotonic())
    #     if action is None: await asyncio.sleep(0.2); continue
    #     res = await gate.call(action.path, action.params)
    #     log(action, res.status_code, res.text[:80])
    #     apply_result(state, action, res, time.monotonic())
    #   except Exception as e: log(e); await asyncio.sleep(0.5)

async def main() -> None
    # async with httpx.AsyncClient(base_url=BASE_URL, http2=True, timeout=10) as client:
    #   session = Session(...); await session.login()
    #   state = State(); gate = ThrottleGate(session, state)
    #   gate.see_me(await session.get_json("/auth/me"), time.monotonic())
    #   async with asyncio.timeout(RUN_FOR):          # RUN_FOR=None runs forever
    #     async with asyncio.TaskGroup() as tg:
    #       tg.create_task(watcher(...)); tg.create_task(actor(...))

# if __name__ == "__main__":
#   try: asyncio.run(main())
#   except (KeyboardInterrupt, TimeoutError): pass
#   finally: print_stats()     # mock only: GET <root>/__stats with plain httpx.get
```

`RUN_FOR` comes from an env var (`float(os.getenv("RUN_FOR", "0")) or None`), so you can run a scenario for 70 s and get the stats printed at the end.

---

## 6. Throttle correctness

1. **Anchor on response arrival.** Set `last_done = time.monotonic()` **after** the response arrives. The server stamped the call when it arrived, which is always before your client gets the response. If you send the next call at `last_done + throttle`, it reaches the server at least `throttle` after the stamp, whatever the jitter. This costs about one round trip per action (about 50 ms, under 2%). Anchoring on **send** time is wrong: with jitter the next request can arrive early.
2. **Re-read /me after every sleep, and never sleep longer than 0.5 s.** The server checks against the throttle **at call time**. Waiting in one long sleep based on a stale throttle is a bug (see section 9).
3. **Start with `last_done = now`, not 0.** You don't know when the last call happened (a previous run may have called a second ago), so the first call waits one full window.
4. **Attacks (covers attack-restart).** If `attackedBy` gains a new id, move `last_done` to the time that `/me` response arrived. That time is after the real attack, so it is safe. Costs: at most one window per attack, and it can be switched off if warm-up shows attacks don't restart the window.
5. **429 should never happen; treat it as a bug alarm.** Set `blocked_until = now + Retry-After` (it is rounded up to whole seconds, so it is safe) and never retry right away. Don't move `last_done`.
6. **503:** retry inside `Session.request` with a 0.1/0.2/0.4 s backoff. The throttle was never checked, so `last_done` stays as it was. **On the real server, check during warm-up that a retry after a 503 never gives a 429.**
7. **Network error or timeout on a throttled call:** assume the server received it and set `last_done = now`.
8. **Never poll throttled endpoints.** Only the gate can reach them, and the actor fires only when `choose_action` returns something useful. Discover is rate-limited (`DISCOVER_EVERY_S = 10`) because a useless discover pushes the next defend back by a whole window.
9. **What can still go wrong:** an attack that lands in the ~1 round trip between the final `/me` read and your call's arrival still gives a 429. No client can see it in time, so this can't be fixed. It is roughly 50 ms out of every 3000 to 8000 ms, so about 1% per attack, and in my tests it never happened.

---

## 7. Tokens, errors, shutdown, hot reload

- **Token expiry:** handled when a 401 comes back, through `relogin(stale_token)` under a lock. The "is it still the stale token" check is essential. When the watcher's three parallel calls all get a 401, only the first one logs in and the other two simply retry. Without it, each login kills the token the previous one just got, and you get a 401 storm. Optionally, log in early after about 55 minutes, inside `wait_ready`, where no throttled call is in flight.
- **Errors must not kill tasks:** wrap one loop iteration in `try/except Exception`, log it, sleep 0.5 s and continue. `CancelledError` is a `BaseException`, so `except Exception` does not swallow it and shutdown still works. Never use a bare `except:`.
- **Clean shutdown:** `asyncio.run` + `async with AsyncClient` + `async with TaskGroup`. Ctrl+C cancels main, the TaskGroup cancels both tasks, and the client closes by itself.
- **Hot reload:** `reload_solvers()` checks the mtime of solvers.py and returns `True` when it reloaded. Call it at the top of each actor loop. On True, clear `answers` and `bad` and run `solve_all` again.
  - Solve at **discover** time, never when the slot opens, so a solver that crashes or runs slowly never wastes a window.
  - Always use `solvers.REGISTRY` through the module (`import solvers`), never `from solvers import REGISTRY`, or reloads won't take effect.
  - A solver that raises is caught per nugget. If a reload fails because of a syntax error, the old solvers stay.
- **Never call `time.sleep` in async code.** It freezes every task. Use `await asyncio.sleep`.

---

## 8. Action priority (choose_action)

The order of the `if` checks is the priority:

1. **Burst** if `attackers >= 3`, `score >= 3` and `len(ready_nuggets) >= 3`. A burst is only worth 3 nuggets if a faster throttle has claims to speed up.
2. **Defend yourself** from the first attacker in `state.attackers`. This comes from the fresh `/me`, so it never sends a defend that would get a 400.
3. **Defend your teammate:** for a user in `team_ids` (not me), the first id in their `attackedBy`, with params `{"teammateId": user_id}`. The data comes from `/users`, which can be up to 1 s old, so a rare 400 is possible.
4. **Claim** `best_nugget`, the ready one with the highest coefficient.
5. **Discover** if `need_discover`, or if `now - discovered_at > DISCOVER_EVERY_S`.
6. **Attack** `best_target`.
7. Otherwise **None**. The actor sleeps 0.2 s without using the slot.

Why defending is worth it: one slot now saves 1000 ms on every action after it, so it pays back after a few actions.

Tuning constants: `BURST_AT=3`, `BURST_MIN_SCORE=3`, `BURST_MIN_READY=3`, `DISCOVER_EVERY_S=10`, `ATTACK=True`, `WATCH_EVERY_S=0.5`, `RECHECK_S=0.5`, `MARGIN_S=0.02`.

---

## 9. Pitfalls found while testing

I tested a reference version of this exact design against all 12 mock scenarios (70 s each, in parallel). `earlyCalls429` was **0 in every scenario**, including flaky (129 injected 503s), token-expiry, attack-restart and chaos (111 503s and 10 401s). Testing also showed these mistakes:

1. **Sleeping once on a stale throttle.** The first version of `wait_ready` did `sleep(next_allowed - now)` with the cached throttle and only then read `/me`. After a burst (8000 -> 3000) it slept the full 8 s, and after each defend it slept 1 s too long. Fix: read `/me` first and sleep at most `RECHECK_S` (0.5 s) between reads (the version in section 5). I found this fix in testing but did not re-run the tests after it.
2. **Bursting with nothing to claim.** In attack-gang, all bots attack every 15 s and the client burst 4 times (12 nuggets) for only 3 claims. Fix: the `BURST_MIN_READY` rule in section 8.
3. **The mock's .env hides two scenarios.** `mock/.env` sets `TOKEN_TTL_MIN=60` and `ROUND_SECONDS=120`, and .env values win over scenario defaults. So `token-expiry` never expires and `rounds` uses 120 s rounds. Pass the flags explicitly: `--token-ttl-min=0.25` and `--round-seconds=20` (or comment those two lines out in `mock/.env`).
4. **Watcher calls fail too** (503 on `/teams` in flaky). Use `gather(..., return_exceptions=True)` so one failed endpoint doesn't throw away the other two results.

---

## 10. Bugs in the current code

- `solvers.py`: `sum(re.findall(...))` sums strings and raises a TypeError. Use `sum(map(int, re.findall(r"-?\d+", content)))`. Always send the answer as `str(answer)`.
- `solvers.py`: `reverseWord` and `wordCount` are missing. In the mock, the question is `What is "banana" spelled backwards?`, so take the word with `re.search(r'"([^"]+)"', content).group(1)`. The mock's `wordCount` (an invented rule) is the sum of letter positions, a=1 to z=26: `What is the wordcount of "banana"?`.
- `main.py`: `solvers` is never imported. `for nugget in to_solve[nugget]` is incomplete. The inner `for i in range(3)` reuses the loop counter `i`.
- `apis.py`: `"expiresInMins"` in the login body is a leftover from another API. `refreshToken()` has no endpoint to call.
- `helpers.py`: `sleep_ms` uses blocking `time.sleep`. `reload_solvers` should return a bool.

---

## 11. Testing against the mock

The mock's account is `ahmed@gmail.com` / `ahmedpass` (also in `mock/.env`). Set your project `.env`: `BASE_URL=http://localhost:3000/api`, `email=...`, `password=...`.

```bash
node mock/server.js --scenario=normal --quiet
RUN_FOR=70 .venv/bin/python main.py        # prints /__stats at the end
curl -s localhost:3000/__stats             # or check by hand
curl -s localhost:3000/__reset             # reset state without restarting
```

| Scenario | Flags | What it checks |
|---|---|---|
| normal | | Baseline, about T + round trip between calls |
| flaky | | 503 retry, watcher survives |
| attack-steady | | Waits get longer as the throttle rises, defends |
| attack-restart | | `see_me` moves `last_done` |
| attack-gang | | Burst rule doesn't waste nuggets |
| attack-mate | | `defend_mate` with `teammateId` |
| attack-relentless, attack-revenge | | Re-attacks detected after a defend or attack |
| token-expiry | `--token-ttl-min=0.25` | One login per expiry, no 401 storm |
| rounds | `--round-seconds=20` | Old-round 400 leads to a fresh discover |
| slow | | Jitter of +/-300 ms, the response anchor holds |
| chaos | `--token-ttl-min=0.25` | Everything at once |

Success: `earlyCalls429 == 0`. `--base-ms=600` makes tests faster (step 200, max 1600).

To run all scenarios at once: start each mock on its own port (`--port=3201`, `3202`, ...) and run one client per port with `BASE_URL=http://localhost:PORT/api RUN_FOR=70`.

---

## 12. Build order (test after each step)

1. `Session` with login, `request`, `get_json`. Test: normal and flaky with an actor that only reads `/me`.
2. `ThrottleGate` + an actor that only discovers. Test: normal, `earlyCalls429 = 0`, calls about 3.05 s apart.
3. `State.apply_me`, `see_me`, watcher. Test: attack-steady, attack-restart.
4. `solve_all`, `choose_action` (defend + claim), `apply_result`. Test: attack-gang, attack-mate.
5. `relogin` under the lock. Test: token-expiry with the flag.
6. The round handling in `apply_result`. Test: rounds with the flag.
7. Attack, burst rule, hot reload (edit solvers.py while it runs). Test: chaos.

---

## 13. Checklist for the real session

- Recheck the rules page (the spec may change before the start).
- During warm-up: does a retry after a 503 ever get a 429? Does an attack restart the window? Does a wrong answer use up a window? What does an old-round claim return?
- Real nugget types are revealed when each round starts. Write a solver, save solvers.py, and it hot-reloads (no restart, so your throttle clock is kept).
- Don't run two clients on the same account: the second login kills the first one's token.
- The teammate runs their own client. Defending each other works, but agree on who defends whom so you don't both spend a window defending the same attack.
