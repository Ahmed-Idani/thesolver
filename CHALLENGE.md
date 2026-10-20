# Double Trouble hackathon: the challenge

Source: https://hackathon.ats-digital.com/rules/team.html
Spec v1.5, last updated 2026-10-14. Hackathon in October 2026, team mode, teams of 2. Maintainer: ATS Digital Dev.
The spec "is subject to change until the official start of the hackathon", so recheck the page before the session.

## Overview

Build scripts that discover questions, answer them, and protect each other, through one throttled API.

- Steps: **Discover** (list the nuggets of the current round), **Solve** (work out the answer yourself), **Claim** (send the answer).
- "Thousands of nuggets are waiting to be claimed." To claim a nugget you must answer its question correctly.
- Actions are time-throttled: one action per window, 3000 ms by default.
- You can attack other players to worsen their throttle, and defend yourself and your teammates from attackers.

## Objectives

As a team, collect as many nuggets as possible. The script must:

- auto-discover and correctly answer the available nuggets,
- defend and protect teammates,
- attack contestants.

## Rounds

- 3 equal rounds. New nuggets are revealed at the start of each round.
- Nuggets outside the current round cannot be claimed.
- Each round has 3 distinct nugget types: type 1 is worth 1x, type 2 is worth 2x, type 3 is worth 3x. The types are revealed when the round starts.

## Warm-up

About 30 minutes of practice before the official start. Warm-up scores do not carry over: the leaderboard resets to zero once the official hackathon starts.

## Technical environment and fair play

- Pure-code challenge: rely on your own logic and the provided documentation only.
- Allowed: official DevDocs (`devdocs.ats-digital.com`).
- Strictly prohibited: Google, AI assistants, mobile phones.

## Throttle rules

Throttle-sensitive endpoints: discover, claim, attack, defend, burst. Not throttle-sensitive: login, `/me`, `/teams`, `/users`.

| Situation | Throttle (ms per action) |
|---|---|
| Default | 3000 |
| Per attacker | +1000 |
| Maximum | 8000 (a player at 8000 cannot be attacked any further) |
| Per successful defense (by you or a teammate) | -1000 |
| Burst | reset to 3000 |

- Penalty: calling a throttle-sensitive endpoint while still throttled costs 1 nugget.
- HTTP 429: throttled. The `Retry-After` header gives the seconds to wait.
- HTTP 503: the throttle could not be checked. No penalty, just retry.
- Throttle-sensitive endpoints require the header `Authorization: Bearer <token>`.

## API reference

All paths start with `/api`.

| Method | Path | Throttle-sensitive | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | No | Body `{ "email", "password" }`. Returns `accessToken` (expires in 1 hour) and `refreshToken`. |
| GET | `/api/auth/me` | No | The current user. |
| GET | `/api/teams` | No | All teams, members and `totalScore`. Refreshed every second. |
| GET | `/api/users` | No | All players, including `attacking` and `attackedBy`. Refreshed every second. |
| GET | `/api/nuggets/discover` | Yes | Nuggets of the current round. Optional `?nuggetType={type}`. |
| GET | `/api/nuggets/:id/claim?answer={answer}` | Yes | Claim a nugget. |
| GET | `/api/users/:id/attack` | Yes | Attack a player. |
| GET | `/api/users/:id/defend` | Yes | Defend yourself against attacker `:id`. |
| GET | `/api/users/:id/defend?teammateId={id}` | Yes | Defend a teammate against attacker `:id`. |
| GET | `/api/users/burst` | Yes | Burst mode. |

### Login

- 200: `accessToken` (expires in 1 hour), `refreshToken`.
- 400: `{ "message": "Invalid credentials" }`.
- 404: `{ "message": "User not found" }`.

### Current user: `GET /api/auth/me`

- 200 fields: `_id`, `email`, `firstname`, `lastname`, `attackedBy`, `attacking`, `isAdmin`, `refreshToken`, `totalThrottleMs` (example 3000), `score`.
- 401: `{ "message": "Unauthorized" }` for a wrong or expired token.

### Teams and players

- `/api/teams`: array of teams with `_id`, `name` (example "Delta Team"), `members`, `totalScore`. Each member has `_id`, `email`, `firstname`, `lastname`, `score`.
- `/api/users`: array of every player with `_id`, `email`, `firstname`, `lastname`, `attackedBy`, `attacking`, `isAdmin`, `score`. It shows who is attacking whom.

### Nugget discovery: `GET /api/nuggets/discover`

- With `?nuggetType={type}` it returns only that type from the current round. An unknown type returns 400.
- 200: array of nuggets with `_id`, `content` (example `What is "hello" spelled backwards?`), `nuggetType` (example `reverseWord`), `claimed` (example false), `coefficient` (example 1).
- It is up to the participants to figure out the answers.

### Nugget claim: `GET /api/nuggets/:id/claim?answer={answer}`

- Owned nuggets cannot be re-claimed ("whoever owns it").
- 200: `{ "success": true, "message": "Nugget claimed successfully", "nugget": {...} }`.
- Errors have `success: false`:
  - 400 `Wrong answer`
  - 400 `Nugget already claimed`
  - 404 `Nugget not found`

### Attack: `GET /api/users/:id/attack`

- A successful attack adds 1000 ms to the target's throttle.
- Each user can be attacked only once. You cannot attack yourself, your teammates, or a user already at 8000 ms.
- 200: `Attack successful! ⚔️ Target's throttle increased.` (with `success: true`)
- Errors (`success: false`):
  - 400 `You cannot attack yourself. ⚔️⚔️`
  - 400 `You have already attacked this user. ⚔️⚔️`
  - 400 `You cannot attack your Teammate. ⚔️⚔️`
  - 400 `This victim is currently reaching their throttle limit. ⚔️⚔️`
  - 404 `The Victim is not found. ⚔️⚔️`

### Defend: `GET /api/users/:id/defend`

`:id` is the attacker.

Self-defend lowers your own throttle by 1000 ms. You cannot defend from yourself or from a non-existent attack.
- 200: `Defense successful! 🛡️ Nice recovery 👌`
- 400: `You cannot defend from yourself. 🛡️`
- 400: `You have not been attacked by {attacker}. 🛡️`
- 404: `Attacker not found. 🛡️`

Teammate-defend (`?teammateId={id}`) lowers your teammate's throttle by 1000 ms. You cannot defend non-teammates, or a teammate who is not under attack.
- 200: `Defense successful! 🛡️ You protected your teammate {teammate}`
- 400: `{attacker} is not attacking your teammate {teammate}. 🛡️`
- 404: `Teammate not found. 🛡️`

### Burst: `GET /api/users/burst`

- Costs 3 nuggets and needs at least 3. Revokes all attacks against you and resets your throttle to 3000 ms.
- 200: `Burst mode activated! 🔥 All attacks revoked, throttle reset to 3000ms.`
- 400: `Not enough nuggets, 3 are needed for burst mode. 🔥`

## Tips from the rules page

1. Install your preferred language and dependencies before the session starts.
2. Install Postman or a similar API client if you prefer.
3. Get familiar with consuming HTTP REST APIs.
4. Improve your problem-solving and regex skills.

## Local mock server (`mock/server.js`, Express)

A local mock of the hackathon API for testing a client without touching the real server. It follows the rules page above: same endpoints, same response shapes, same error messages and status codes, same throttle rules (3000 ms window, +1000 per attack up to 8000, -1000 per defense, burst costs 3 nuggets, an early call returns 429 with `Retry-After` and costs 1 nugget, 503 costs nothing).

### Run it

```bash
npm install express
node mock/server.js --list                         # list all scenarios
node mock/server.js --scenario=attack-steady       # run one (default: normal)
node mock/server.js --scenario=normal --port=4000  # use another port
```

- Default base URL: `http://localhost:3000/api` (change the port with `--port`).
- One account exists. Its email and password are the constants at the top of `server.js`, or set them with `--email` and `--password`.
- The flag must be spelled exactly `--scenario=...`. A misspelled flag is silently ignored and you get `normal`.
- If requests return an HTML page saying "Cannot POST ...", another program is using the port. Check with `ss -ltnp | grep 3000`, or start the mock on a free port. The fixed version (`server.fixed.js`) exits with an error if the port is taken, the older version printed its start banner anyway.
- Ctrl+C prints a summary.

### Behaviour

- Network latency of 50 ms is added to every request by default (`--latency`, `--jitter`).
- One session at a time: logging in again invalidates the previous access token (401).
- `GET /api/users` and `GET /api/teams` are snapshots refreshed once per second. `GET /api/auth/me` is live.
- There are 8 players: you (the first id), your teammate (the second id), and 6 bots in two other teams. Ids look like `67f59019a2c13d5d77f68d01` to `...d08`.
- 3 nugget types per round worth 1x, 2x and 3x, 2 nuggets of each type, answers computed by the server. Types are `reverseWord`, `wordCount` and `sumNumbers`. Only `reverseWord` is a name from the rules page, the other two names and the exact wording of the question text are invented. The `wordCount` rule in the mock is the sum of the letter positions of the word (a=1 to z=26), which is also invented.
- Claiming a nugget from an old round returns 400 with a message that is invented.
- Rounds last 120 s by default (3 rounds), 20 s in the `rounds` scenario (`--round-seconds`).
- There is no refresh endpoint. `refreshToken` is returned by login but does nothing.

### Scenarios

| Scenario | What it does |
|---|---|
| `normal` | Rules as written, nobody attacks you. |
| `attack-steady` | One random bot attacks you every 5 s until you reach 8000 ms. |
| `attack-trickle` | One bot attacks you every 15 s. |
| `attack-gang` | All bots attack you at once, every 15 s. |
| `attack-relentless` | You start attacked by 2 bots, and a bot attacks again 1 s after you defend. |
| `attack-mate` | Bots attack your teammate, so you must defend with `?teammateId=`. |
| `attack-restart` | Like `attack-steady`, and every attack restarts your throttle window. |
| `attack-maxed` | You start at the 8000 ms maximum with 5 attackers. |
| `attack-revenge` | A bot you attack attacks you back 1 s later. |
| `flaky` | 25% of `/api` requests answer 503 (no penalty). |
| `token-expiry` | The access token expires after 60 s, then 401 until you log in again. |
| `slow` | Bad network: 500 ms latency with +/-300 ms jitter. |
| `rounds` | Short rounds (20 s), old-round nuggets cannot be claimed. |
| `chaos` | `attack-restart` + `flaky` + `slow` + `token-expiry` together. |

### Options

`--port` (3000), `--latency` (50), `--jitter` (0), `--base-ms` (3000, lower it such as `--base-ms=600` to make tests faster; the step is one third of it and the maximum is base plus five steps), `--nuggets` (starting nugget count, 5), `--attack-every` (5 s), `--gang-every` (15 s), `--flaky-rate` (0.25), `--token-ttl` (60 s in token-expiry and chaos), `--round-seconds` (120), `--attack-restarts-window`, `--email`, `--password`, `--quiet`.

### Helper routes (mock only, no token needed)

- `GET /__stats`: the scenario, request counts, `earlyCalls429` (how many throttled calls came too early), `injected503`, `unauthorized401`, and the current state of your player.
- `GET /__reset`: restarts the state (score, throttle, attacks, rounds) without restarting the server.

## Not specified on the page

- The API host or base URL (the rules site is hackathon.ats-digital.com).
- How `refreshToken` is used. No refresh endpoint is documented.
- Whether an attack on you restarts your throttle window, and whether an early call (429) restarts or extends the wait.
- Whether a wrong answer uses up a throttle window.
- The names and solving rules of the nugget types. Only the example `reverseWord` appears, and the page does not state that `coefficient` is the 1x/2x/3x multiplier.
- Round length, official start time, total session length.
- Whether logging in again invalidates an older token.
- Whether an attacker can attack the same player again after that player defended.
- Prizes, team formation rules, penalties beyond the 1-nugget throttle penalty and the 3-nugget burst cost, fair-play rules beyond section "Technical environment".
