from dataclasses import dataclass, field

import solvers
from helpers import log

BURST_AT = 3  # burst when this many players attack us
BURST_MIN_SCORE = 3
BURST_MIN_READY = 3  # only burst if a faster throttle has claims to speed up
DISCOVER_EVERY_S = 10.0  # re-discover at most this often when nothing is claimable
ATTACK = True


def ids(items) -> set[str]:
    # attackedBy/attacking may hold ids or user objects, accept both
    return {x["_id"] if isinstance(x, dict) else x for x in items or []}


@dataclass
class State:
    my_id: str = ""
    team_ids: set = field(default_factory=set)  # me and my teammates
    attackers: set = field(default_factory=set)
    attacking: set = field(default_factory=set)
    throttle_ms: int = 3000
    score: int = 0
    users: list = field(default_factory=list)
    nuggets: dict = field(default_factory=dict)  # id -> unclaimed nugget
    answers: dict = field(default_factory=dict)  # id -> answer string
    bad: set = field(default_factory=set)  # wrong answers, skipped until solvers reload
    no_attack: set = field(default_factory=set)  # targets the server refused
    discovered_at: float = -1e9
    need_discover: bool = True

    def apply_me(self, me: dict) -> bool:
        """Store a fresh /me. Returns True if a new attacker appeared."""
        attackers = ids(me.get("attackedBy"))
        fresh = bool(attackers - self.attackers)
        self.my_id = me["_id"]
        self.attackers = attackers
        self.attacking = ids(me.get("attacking"))
        self.throttle_ms = int(me["totalThrottleMs"])
        self.score = me.get("score", 0)
        return fresh

    def apply_world(self, users: list, teams: list) -> None:
        self.users = users
        for team in teams:
            members = {m["_id"] for m in team["members"]}
            if self.my_id in members:
                self.team_ids = members


@dataclass(frozen=True)
class Action:
    kind: str
    path: str
    params: dict | None = None
    target: str = ""
    why: str = ""


def solve_all(state: State) -> None:
    # runs at discover/reload time, never when the slot opens
    for nid, nugget in state.nuggets.items():
        if nid in state.answers or nid in state.bad:
            continue
        fn = solvers.REGISTRY.get(nugget["nuggetType"])
        if fn is None:
            continue
        try:
            answer = fn(nugget["content"])
        except Exception as e:
            log(f"[solver {nugget['nuggetType']}] crashed on {nugget['content']!r}: {e!r}")
            continue
        if answer is not None:
            state.answers[nid] = str(answer)


def ready_nuggets(state: State) -> list[str]:
    return [nid for nid in state.answers if nid in state.nuggets and nid not in state.bad]


def best_nugget(state: State) -> str | None:
    return max(ready_nuggets(state), key=lambda nid: state.nuggets[nid]["coefficient"], default=None)


def best_target(state: State) -> str | None:
    enemies = [
        u for u in state.users
        if u["_id"] not in state.team_ids
        and u["_id"] not in state.attacking
        and u["_id"] not in state.no_attack
    ]
    return max(enemies, key=lambda u: u.get("score", 0), default={}).get("_id")


def choose_action(state: State, now: float) -> Action | None:
    """Decide how to spend the slot that just opened. Order of the ifs = priority."""
    if (
        len(state.attackers) >= BURST_AT
        and state.score >= BURST_MIN_SCORE
        and len(ready_nuggets(state)) >= BURST_MIN_READY
    ):
        return Action("burst", "/users/burst", why=f"{len(state.attackers)} attackers")

    for attacker in sorted(state.attackers):
        return Action("defend", f"/users/{attacker}/defend", target=attacker)

    for user in state.users:
        if user["_id"] in state.team_ids and user["_id"] != state.my_id:
            for attacker in sorted(ids(user.get("attackedBy"))):
                return Action(
                    "defend_mate",
                    f"/users/{attacker}/defend",
                    {"teammateId": user["_id"]},
                    target=attacker,
                )

    nid = best_nugget(state)
    if nid:
        return Action("claim", f"/nuggets/{nid}/claim", {"answer": state.answers[nid]}, target=nid)

    if state.need_discover or now - state.discovered_at > DISCOVER_EVERY_S:
        return Action("discover", "/nuggets/discover")

    if ATTACK:
        target = best_target(state)
        if target:
            return Action("attack", f"/users/{target}/attack", target=target)

    return None


def apply_result(state: State, action: Action, res, now: float) -> None:
    try:
        body = res.json()
    except ValueError:
        body = {}
    msg = body.get("message", "") if isinstance(body, dict) else ""
    ok = res.status_code == 200

    match action.kind:
        case "discover":
            if ok:
                state.nuggets = {n["_id"]: n for n in body if not n.get("claimed")}
                state.answers = {k: v for k, v in state.answers.items() if k in state.nuggets}
                state.discovered_at = now
                state.need_discover = False
                solve_all(state)
        case "claim":
            nid = action.target
            if ok or "already claimed" in msg or res.status_code == 404:
                state.nuggets.pop(nid, None)
                state.answers.pop(nid, None)
            elif "Wrong answer" in msg:
                state.bad.add(nid)
            elif res.status_code == 400:  # probably an old-round nugget
                state.nuggets.clear()
                state.answers.clear()
                state.need_discover = True
        case "attack":
            if not ok:
                state.no_attack.add(action.target)
