// Local mock of the hackathon API (hackathon.ats-digital.com/rules/team.html).
// One file, one dependency:
//
//   npm install express
//   node server.js --list                      show all scenarios
//   node server.js --scenario=attack-gang      run one scenario (default: normal)
//
// Endpoints, response shapes and error messages follow the rules page:
//   POST /api/auth/login                       { email, password } -> { accessToken, refreshToken }
//   GET  /api/auth/me                          score, attackedBy, attacking, totalThrottleMs, ...
//   GET  /api/teams, GET /api/users            refreshed once per second (can be 1 s stale)
//   GET  /api/nuggets/discover[?nuggetType=]   throttle-sensitive
//   GET  /api/nuggets/:id/claim?answer=        throttle-sensitive
//   GET  /api/users/:id/attack                 throttle-sensitive
//   GET  /api/users/:id/defend[?teammateId=]   throttle-sensitive
//   GET  /api/users/burst                      throttle-sensitive
//
// Rules implemented:
//   - Window starts at 3000 ms. An attack on you adds 1000 ms, max 8000 ms. A successful
//     defense removes 1000 ms. Burst costs 3 nuggets, resets to 3000 ms, revokes all attacks.
//   - Calling a throttle-sensitive endpoint inside the window: 429 with Retry-After and a
//     penalty of 1 nugget. 503 means "throttle could not be checked", no penalty.
//   - One session per user: logging in again invalidates the previous tokens (401).
//   - Only one account exists. Set it with --email and --password (defaults below).
//
// Options (all optional):
//   --port=3000                  port to listen on
//   --latency=50                 network latency in ms added to every request (half before
//                                handling, half before the response). Default 50.
//   --jitter=0                   random +/- ms on top of the latency
//   --base-ms=3000               base throttle window (step is base/3, max is base + 5 steps).
//                                Lower it to make your own tests run faster.
//   --nuggets=5                  starting nugget count (so penalties are visible)
//   --attack-every=5             seconds between bot attacks (15 for attack-trickle)
//   --gang-every=15              seconds between gang attacks (attack-gang)
//   --flaky-rate=0.25            share of /api requests answered with 503 (flaky, chaos)
//   --token-ttl=60               access token lifetime in seconds (token-expiry, chaos)
//   --round-seconds=120          length of one round (rounds scenario defaults to 20)
//   --attack-restarts-window     an attack on you restarts your throttle window
//   --quiet                      do not log every request
//
// Utility routes: GET /__stats, GET /__reset.
// GUESSES (the page does not say): the nugget type names other than reverseWord, the wording
// of nugget content, the wordcount rule (here: sum of letter positions, a=1 ... z=26), the
// message for claiming an old-round nugget, and what a refresh token does (nothing here).

const express = require("express");
const crypto = require("crypto");

// ---------------------------------------------------------------- CLI

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

// attack modes:
//   none        nobody attacks you
//   steady      one random bot attacks you every --attack-every seconds
//   trickle     same, but only every 15 s by default
//   gang        all bots attack you at once every --gang-every seconds
//   relentless  you start attacked by 2 bots, and each bot attacks again 1 s after you defend
//   mate        bots attack your teammate, defend them with ?teammateId=<teammate _id>
//   maxed       you start at the 8000 ms maximum (5 bots already attacking you)
//   revenge     when you attack a bot, it attacks you back 1 s later
// "restart: true" additionally restarts your throttle window whenever you are attacked.
const SCENARIOS = {
  normal: { about: "Rules as written, nobody attacks you.", f: { attack: "none" } },
  "attack-steady": { about: "One bot attacks you every 5 s until you reach 8000 ms.", f: { attack: "steady" } },
  "attack-trickle": { about: "One bot attacks you every 15 s.", f: { attack: "trickle" } },
  "attack-gang": { about: "All bots attack you at the same moment, every 15 s (back to 8000 ms at once).", f: { attack: "gang" } },
  "attack-relentless": { about: "Starts attacked by 2 bots, and a bot attacks again 1 s after you defend.", f: { attack: "relentless" } },
  "attack-mate": { about: "Bots attack your teammate, you must defend with ?teammateId=<teammate _id>.", f: { attack: "mate" } },
  "attack-restart": { about: "Steady attacks, and every attack restarts your throttle window.", f: { attack: "steady", restart: true } },
  "attack-maxed": { about: "You start at the 8000 ms maximum with 5 attackers. Defend or burst out.", f: { attack: "maxed" } },
  "attack-revenge": { about: "A bot you attack attacks you back 1 s later.", f: { attack: "revenge" } },
  flaky: { about: "A share of /api requests answer 503 (no penalty), default 25%.", f: { attack: "none", flaky: true } },
  "token-expiry": { about: "Access token expires after --token-ttl seconds, then 401 until you log in again.", f: { attack: "none", tokenExpiry: true } },
  slow: { about: "Bad network: 500 ms latency with +/-300 ms jitter.", f: { attack: "none", slowNet: true } },
  rounds: { about: "Short rounds (20 s): new nuggets each round, old ones can no longer be claimed.", f: { attack: "none", shortRounds: true } },
  chaos: { about: "Steady attacks that restart your window, flaky 503s, bad network and token expiry.", f: { attack: "steady", restart: true, flaky: true, slowNet: true, tokenExpiry: true } },
};

if (args.list) {
  console.log("Scenarios:\n");
  for (const [name, s] of Object.entries(SCENARIOS)) console.log(`  ${name.padEnd(18)} ${s.about}`);
  process.exit(0);
}

const scenarioName = String(args.scenario || "normal");
if (!SCENARIOS[scenarioName]) {
  console.error(`Unknown scenario "${scenarioName}". Run with --list to see the options.`);
  process.exit(1);
}
const f = SCENARIOS[scenarioName].f;
const MODE = f.attack;

const num = (v, d) => (v === undefined || v === true ? d : Number(v));

const PORT = num(args.port, 3000);
const EMAIL = String(args.email || "ahmed@gmail.com"); // the only account that exists
const PASSWORD = String(args.password || "ahmedpass"); // change with --email / --password
const LATENCY = num(args.latency, f.slowNet ? 500 : 50);
const JITTER = num(args.jitter, f.slowNet ? 300 : 0);
const BASE_MS = num(args["base-ms"], 3000);
const STEP_MS = Math.round(BASE_MS / 3);
const MAX_MS = BASE_MS + 5 * STEP_MS; // 8000 ms with the default base
const START_SCORE = num(args.nuggets, 5);
const ATTACK_EVERY_S = num(args["attack-every"], MODE === "trickle" ? 15 : 5);
const GANG_EVERY_S = num(args["gang-every"], 15);
const FLAKY_RATE = num(args["flaky-rate"], 0.25);
const TOKEN_TTL_S = f.tokenExpiry ? num(args["token-ttl"], 60) : 3600;
const ROUND_S = num(args["round-seconds"], f.shortRounds ? 20 : 120);
const RESTART_WINDOW = Boolean(args["attack-restarts-window"]) || Boolean(f.restart);
const REATTACK = MODE === "relentless"; // may a bot attack again after being defended?

// ---------------------------------------------------------------- state

const ID = (n) => "67f59019a2c13d5d77f68d0" + n; // 24 hex characters, like a Mongo _id
const ME_ID = ID(1);
const MATE_ID = ID(2);
const TEAMS = {
  t1: { _id: "67f59019a2c13d5d77f68e01", name: "Delta Team" },
  t2: { _id: "67f59019a2c13d5d77f68e02", name: "Alpha Team" },
  t3: { _id: "67f59019a2c13d5d77f68e03", name: "Beta Team" },
};
const fullname = (u) => `${u.firstname} ${u.lastname}`;

function freshState() {
  const mk = (n, firstname, lastname, email, teamId, bot = false) => ({
    id: ID(n), email, firstname, lastname, teamId, bot,
    throttleMs: BASE_MS,
    lastActionAt: 0,
    attacking: new Set(), // users this user has attacked
    attackedBy: new Set(), // users currently attacking this user
    attackedEver: new Set(),
    score: 0,
  });
  const list = [
    mk(1, "Ahmed", "Mock", EMAIL, "t1"),
    mk(2, "Mate", "Mock", "mate@mock.test", "t1"),
    mk(3, "Bot", "Three", "bot3@mock.test", "t2", true), mk(4, "Bot", "Four", "bot4@mock.test", "t2", true), mk(5, "Bot", "Five", "bot5@mock.test", "t2", true),
    mk(6, "Bot", "Six", "bot6@mock.test", "t3", true), mk(7, "Bot", "Seven", "bot7@mock.test", "t3", true), mk(8, "Bot", "Eight", "bot8@mock.test", "t3", true),
  ];
  list[0].score = START_SCORE;
  return {
    users: new Map(list.map((u) => [u.id, u])),
    owned: new Set(),
    session: null, // { token, refreshToken, expiresAt }, only one session at a time
    startedAt: Date.now(),
    stats: { requests: 0, earlyCalls429: 0, injected503: 0, unauthorized401: 0 },
  };
}

let S;
const me = () => S.users.get(ME_ID);

// GET /api/auth/me is live
const meView = (u) => ({
  _id: u.id, email: u.email, firstname: u.firstname, lastname: u.lastname,
  attackedBy: [...u.attackedBy], attacking: [...u.attacking], isAdmin: false,
  refreshToken: S.session ? S.session.refreshToken : null,
  totalThrottleMs: u.throttleMs, score: u.score,
});

// GET /api/users and /api/teams are snapshots refreshed once per second
let SNAP = { users: [], teams: [] };
function refreshSnapshot() {
  const teams = {};
  SNAP.users = [...S.users.values()].map((u) => {
    teams[u.teamId] ??= { _id: TEAMS[u.teamId]._id, name: TEAMS[u.teamId].name, members: [], totalScore: 0 };
    teams[u.teamId].members.push({ _id: u.id, email: u.email, firstname: u.firstname, lastname: u.lastname, score: u.score });
    teams[u.teamId].totalScore += u.score;
    return {
      _id: u.id, email: u.email, firstname: u.firstname, lastname: u.lastname,
      attackedBy: [...u.attackedBy], attacking: [...u.attacking], isAdmin: false, score: u.score,
    };
  });
  SNAP.teams = Object.values(teams);
}

const say = (msg) => { if (!args.quiet) console.log("        >> " + msg); };

// ---------------------------------------------------------------- bots

// A bot attacks `victim`. Returns false if the attack is not possible.
function botAttack(victim, bot) {
  if (!bot || victim.throttleMs >= MAX_MS || victim.attackedBy.has(bot.id)) return false;
  victim.attackedBy.add(bot.id);
  victim.attackedEver.add(bot.id);
  bot.attacking.add(victim.id);
  victim.throttleMs += STEP_MS;
  if (RESTART_WINDOW && victim.id === ME_ID) victim.lastActionAt = Date.now();
  say(`${fullname(bot)} (${bot.id}) attacked ${victim.firstname}, throttle is now ${victim.throttleMs} ms`);
  return true;
}

const freeBots = (victim) =>
  [...S.users.values()].filter((u) => u.bot && !victim.attackedBy.has(u.id) && (REATTACK || !victim.attackedEver.has(u.id)));

function applyInitialAttacks() {
  const bots = [...S.users.values()].filter((u) => u.bot);
  if (MODE === "maxed") bots.slice(0, 5).forEach((b) => botAttack(me(), b));
  if (MODE === "relentless") bots.slice(0, 2).forEach((b) => botAttack(me(), b));
}

function reset() {
  S = freshState();
  applyInitialAttacks();
  refreshSnapshot();
}
reset();

setInterval(refreshSnapshot, 1000);

setInterval(() => {
  if (!["steady", "trickle", "mate"].includes(MODE)) return;
  const victim = MODE === "mate" ? S.users.get(MATE_ID) : me();
  const free = freeBots(victim);
  if (free.length) botAttack(victim, free[Math.floor(Math.random() * free.length)]);
}, ATTACK_EVERY_S * 1000);

setInterval(() => {
  if (MODE !== "gang") return;
  for (const bot of freeBots(me())) if (!botAttack(me(), bot)) break;
}, GANG_EVERY_S * 1000);

// ---------------------------------------------------------------- nuggets

// nuggetType names: only "reverseWord" is shown on the rules page, the others are guesses.
// The page says the three types of a round are worth 1x, 2x and 3x (the "coefficient").
const WORDS = ["banana", "hackathon", "throttle", "nugget", "gateway", "database", "kubernetes", "protocol", "latency", "resilient", "optimizer", "sandbox"];
const letterSum = (w) => [...w].reduce((s, c) => s + (c.charCodeAt(0) - 96), 0);

const TYPES = [
  {
    name: "reverseWord", coefficient: 1,
    make: (seed) => { const w = WORDS[seed % WORDS.length]; return { content: `What is "${w}" spelled backwards?`, answer: [...w].reverse().join("") }; },
  },
  {
    name: "wordCount", coefficient: 2,
    make: (seed) => { const w = WORDS[(seed + 5) % WORDS.length]; return { content: `What is the wordcount of "${w}"?`, answer: String(letterSum(w)) }; },
  },
  {
    name: "sumNumbers", coefficient: 3,
    make: (seed) => { const a = 10 + ((seed * 17) % 80), b = 10 + ((seed * 11 + 7) % 80); return { content: `What is ${a} + ${b}?`, answer: String(a + b) }; },
  },
];

const NUGGET_PREFIX = "67f5a000a2c13d5d77f6"; // 20 chars + round, type, index digits + "0" = 24 chars

function nuggetsForRound(round) {
  const out = [];
  TYPES.forEach((t, ti) =>
    [0, 1].forEach((k) => {
      const { content, answer } = t.make(round * 10 + ti * 3 + k);
      out.push({ _id: `${NUGGET_PREFIX}${round}${ti}${k}0`, content, nuggetType: t.name, coefficient: t.coefficient, round, answer });
    })
  );
  return out;
}

const currentRound = () => Math.min(2, Math.floor((Date.now() - S.startedAt) / (ROUND_S * 1000)));

function findNugget(id) {
  const m = new RegExp(`^${NUGGET_PREFIX}(\\d)(\\d)(\\d)0$`).exec(id);
  if (!m || Number(m[1]) > 2) return null;
  return nuggetsForRound(Number(m[1])).find((n) => n._id === id) || null;
}

const nuggetView = ({ answer, round, ...n }) => ({ ...n, claimed: S.owned.has(n._id) });

// ---------------------------------------------------------------- helpers

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const ok = (res, message, extra = {}) => res.json({ success: true, message, ...extra });

// ---------------------------------------------------------------- middleware

const app = express();
app.use(express.json());

// log and stats
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/__")) return;
    S.stats.requests++;
    if (res.statusCode === 429) S.stats.earlyCalls429++;
    if (res.statusCode === 503) S.stats.injected503++;
    if (res.statusCode === 401) S.stats.unauthorized401++;
    if (!args.quiet) {
      const sec = ((Date.now() - S.startedAt) / 1000).toFixed(1).padStart(6);
      const ra = res.getHeader("Retry-After") ? ` retry-after=${res.getHeader("Retry-After")}` : "";
      console.log(`[${sec}s] ${req.method} ${req.originalUrl} -> ${res.statusCode}${ra} (${Date.now() - t0}ms)  throttle=${me().throttleMs} score=${me().score}`);
    }
  });
  next();
});

// network latency: half before the server handles the request, half before the client gets the answer
app.use((req, res, next) => {
  if (req.path.startsWith("/__")) return next();
  const total = Math.max(0, LATENCY + (JITTER ? (Math.random() * 2 - 1) * JITTER : 0));
  const half = total / 2;
  const end = res.end.bind(res);
  res.end = (...a) => {
    setTimeout(() => end(...a), half);
    return res;
  };
  setTimeout(next, half);
});

// flaky scenario: 503 means "throttle could not be checked", no penalty
app.use("/api", (req, res, next) => {
  if (f.flaky && req.path !== "/auth/login" && Math.random() < FLAKY_RATE) {
    return res.status(503).json({ message: "Service unavailable" });
  }
  next();
});

// bearer auth, one session per user: only the token of the latest login works
app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login") return next();
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!S.session || token !== S.session.token || Date.now() > S.session.expiresAt) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

// throttle check for throttle-sensitive endpoints
function throttled(req, res, next) {
  const m = me();
  const now = Date.now();
  const wait = m.lastActionAt + m.throttleMs - now;
  if (wait > 0) {
    m.score = Math.max(0, m.score - 1); // penalty: 1 nugget
    res.set("Retry-After", String(Math.ceil(wait / 1000)));
    return res.status(429).json({ success: false, message: "Too many requests, you are throttled", retryAfterMs: wait });
  }
  m.lastActionAt = now;
  next();
}

// ---------------------------------------------------------------- routes

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Invalid credentials" });
  if (email !== EMAIL) return res.status(404).json({ message: "User not found" });
  if (password !== PASSWORD) return res.status(400).json({ message: "Invalid credentials" });
  // a new login replaces the old session, the previous tokens stop working
  S.session = {
    token: "acc-" + crypto.randomUUID(),
    refreshToken: "ref-" + crypto.randomUUID(),
    expiresAt: Date.now() + TOKEN_TTL_S * 1000,
  };
  res.json({ accessToken: S.session.token, refreshToken: S.session.refreshToken });
});

// not throttle-sensitive
app.get("/api/auth/me", (req, res) => res.json(meView(me())));
app.get("/api/users", (req, res) => res.json(SNAP.users));
app.get("/api/teams", (req, res) => res.json(SNAP.teams));

// throttle-sensitive
app.get("/api/nuggets/discover", throttled, (req, res) => {
  const type = req.query.nuggetType;
  if (type !== undefined && !TYPES.some((t) => t.name === type)) {
    return res.status(400).json({ success: false, message: "Unknown nugget type" });
  }
  res.json(nuggetsForRound(currentRound()).filter((n) => !type || n.nuggetType === type).map(nuggetView));
});

app.get("/api/nuggets/:id/claim", throttled, (req, res) => {
  const n = findNugget(req.params.id);
  if (!n) return fail(res, 404, "Nugget not found");
  if (n.round !== currentRound()) return fail(res, 400, "Nugget is not in the current round");
  if (S.owned.has(n._id)) return fail(res, 400, "Nugget already claimed");
  if (String(req.query.answer) !== n.answer) return fail(res, 400, "Wrong answer");
  S.owned.add(n._id);
  me().score += n.coefficient;
  ok(res, "Nugget claimed successfully", { nugget: nuggetView(n) });
});

app.get("/api/users/burst", throttled, (req, res) => {
  const m = me();
  if (m.score < 3) return fail(res, 400, "Not enough nuggets, 3 are needed for burst mode. 🔥");
  m.score -= 3;
  m.throttleMs = BASE_MS;
  for (const id of m.attackedBy) S.users.get(id)?.attacking.delete(m.id);
  m.attackedBy.clear(); // all attacks are revoked
  m.attackedEver.clear();
  m.lastActionAt = Date.now();
  ok(res, `Burst mode activated! 🔥 All attacks revoked, throttle reset to ${BASE_MS}ms.`);
});

app.get("/api/users/:id/attack", throttled, (req, res) => {
  const m = me();
  const victim = S.users.get(req.params.id);
  if (!victim) return fail(res, 404, "The Victim is not found. ⚔️⚔️");
  if (victim.id === m.id) return fail(res, 400, "You cannot attack yourself. ⚔️⚔️");
  if (m.attacking.has(victim.id)) return fail(res, 400, "You have already attacked this user. ⚔️⚔️");
  if (victim.teamId === m.teamId) return fail(res, 400, "You cannot attack your Teammate. ⚔️⚔️");
  if (victim.throttleMs >= MAX_MS) return fail(res, 400, "This victim is currently reaching their throttle limit. ⚔️⚔️");
  victim.throttleMs += STEP_MS;
  victim.attackedBy.add(m.id);
  m.attacking.add(victim.id);
  if (MODE === "revenge" && victim.bot) setTimeout(() => botAttack(me(), victim), 1000);
  ok(res, "Attack successful! ⚔️ Target's throttle increased.");
});

// :id is the ATTACKER. Without teammateId you defend yourself, with it you defend a teammate.
app.get("/api/users/:id/defend", throttled, (req, res) => {
  const m = me();
  const teammateId = req.query.teammateId;
  if (teammateId === undefined) {
    if (req.params.id === m.id) return fail(res, 400, "You cannot defend from yourself. 🛡️");
    const attacker = S.users.get(req.params.id);
    if (!attacker) return fail(res, 404, "Attacker not found. 🛡️");
    if (!m.attackedBy.has(attacker.id)) return fail(res, 400, `You have not been attacked by ${fullname(attacker)}. 🛡️`);
    m.attackedBy.delete(attacker.id);
    attacker.attacking.delete(m.id);
    m.throttleMs = Math.max(BASE_MS, m.throttleMs - STEP_MS);
    if (MODE === "relentless" && attacker.bot) setTimeout(() => botAttack(m, attacker), 1000);
    return ok(res, "Defense successful! 🛡️ Nice recovery 👌");
  }
  const mate = S.users.get(String(teammateId));
  if (!mate || mate.id === m.id || mate.teamId !== m.teamId) return fail(res, 404, "Teammate not found. 🛡️");
  const attacker = S.users.get(req.params.id);
  if (!attacker) return fail(res, 404, "Attacker not found. 🛡️");
  if (!mate.attackedBy.has(attacker.id)) return fail(res, 400, `${fullname(attacker)} is not attacking your teammate ${fullname(mate)}. 🛡️`);
  mate.attackedBy.delete(attacker.id);
  attacker.attacking.delete(mate.id);
  mate.throttleMs = Math.max(BASE_MS, mate.throttleMs - STEP_MS);
  ok(res, `Defense successful! 🛡️ You protected your teammate ${fullname(mate)}`);
});

// utilities
app.get("/__stats", (req, res) => res.json({ scenario: scenarioName, ...S.stats, me: meView(me()) }));
app.get("/__reset", (req, res) => {
  reset();
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ message: "Not found" }));

// ---------------------------------------------------------------- start

const server = app.listen(PORT, (err) => {
  if (err) {
    console.error(`Cannot listen on port ${PORT} (${err.code || err.message}). Another program is already using it. Stop it, or run with --port=4000`);
    process.exit(1);
  }
  console.log(`Mock hackathon API on http://localhost:${PORT}`);
  console.log(`Scenario: ${scenarioName} (${SCENARIOS[scenarioName].about})`);
  console.log(`Throttle window ${BASE_MS} ms (max ${MAX_MS} ms), network latency ${LATENCY} ms${JITTER ? ` +/-${JITTER}` : ""}`);
  console.log(`Round length ${ROUND_S}s, token lifetime ${TOKEN_TTL_S}s, starting nuggets ${START_SCORE}`);
  console.log(`You are ${EMAIL} (${ME_ID}), your teammate is ${MATE_ID}. One session at a time.`);
  console.log("Ctrl+C prints a summary.\n");
});

process.on("SIGINT", () => {
  console.log("\n--- summary ---");
  console.log(JSON.stringify({ scenario: scenarioName, ...S.stats, me: meView(me()) }, null, 2));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
