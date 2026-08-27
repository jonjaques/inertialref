# Getting started

From clone to flying, and the first things worth trying.

---

## Run it

```bash
pnpm install
pnpm dev          # → http://localhost:5173
```

One command starts both halves — Vite on 5173 and the Cloudflare Worker on 8787,
with `/api` and `/ws` proxied to it. `pnpm dev:client` is Vite alone, which is
also how you get the offline path deliberately: with no Worker, the client
correctly reports `no server`, and that is the normal case for a game whose
universe is derived rather than fetched.

From VS Code or Cursor, **Run and Debug → Launch Browser** does the same start
and attaches the debugger. Attach/Launch Node target the headless runner.
[Development](development.md#debugging) has the four configurations.

The client opens on Earth, three-quarter lit, with the ship — a CC-BY
USS Enterprise-D hull, or the debug cone while it loads — framed in the
foreground of a Solar System built from measurements rather than from a seed.

```mermaid
flowchart LR
    A["pnpm install"] --> B["pnpm dev<br/><i>vite + wrangler</i>"] --> C["localhost:5173"]
    C --> D["fly with WASD / arrows"]
    C --> E["drive it from the console<br/><code>ir.help()</code>"]
    C --> F["prove it works<br/><code>await ir.selfTest()</code>"]
    style F fill:#065f46,stroke:#064e3b,color:#fff
```

In a **production** build (`pnpm preview`, which builds and then serves the
result through the real Worker on 8787) no server is required after the first
load — a service worker caches the app and content comes from the seed. The
worker is deliberately not registered under `pnpm dev`, where it would sit in
front of Vite and turn every edit into a caching investigation. See
[persistence](../concepts/persistence.md#offline-first).

---

## Controls

| Key         | Action                             |
| ----------- | ---------------------------------- |
| `W` / `S`   | main drive fore / aft              |
| `A` / `D`   | translate left / right             |
| `R` / `F`   | translate up / down                |
| `↑ ↓ ← →`   | pitch / yaw                        |
| `Q` / `E`   | roll                               |
| `Z`         | flight assist (rotational damping) |
| `X`         | kill rotation                      |
| `Space`     | pause                              |
| `[` / `]`   | time warp down / up                |
| `F5` / `F9` | save / load                        |
| `G`         | open the navigate panel            |
| `P`         | open the perf panel                |
| `H`         | hide or restore both dock panes    |
| `Tab`       | move between on-screen controls    |

Flight is full 6-DoF with no artificial "space mode" — the same controls fly
between stars, into orbit, and down to a landing.

---

## The author's instruments

Press the bug in the IR menu at the bottom center, or `` ` ``, to reveal six
dockable panels: navigate, controls, telemetry, perf, graphics, and camera.
Open telemetry to see the architecture made visible. Four groups repay
attention on day one:

```mermaid
flowchart TB
    SIM["<b>SIMULATION</b><br/>seed · tick · time scale · <b>state hash</b>"]
    PLAY["<b>PLAYER</b><br/>frame · <b>chain</b> · canonical vs local coords<br/>local vs universe speed"]
    REND["<b>RENDER</b><br/>origin sector · <b>rebases</b> · LOD tier per body"]
    UNI["<b>UNIVERSE</b><br/>loaded systems · frames · worker queue"]

    SIM --> PLAY --> REND --> UNI
```

Three fields repay attention:

- **chain** — `universe › s:SOL › b:… › bf:… › sf:…`. Where the ship sits in the
  [frame hierarchy](../concepts/frames.md). It changes as you approach and land.
- **speed** — `0.0 m/s local · 51853.5 m/s universe` when landed. Both are true;
  they answer different questions.
- **state hash** — two tabs showing the same hash at the same tick are running
  identical universes.

---

## First things to try

### 1. Prove the architecture

```js
await ir.selfTest()
```

Runs twelve capability checks against the live build and prints measurements —
inch-scale precision at 8 kpc, zero drift over 500 origin rebases, a worker's
terrain matching the main thread's sample for sample.

### 2. Land on a planet

```js
await ir.scenario('surface')
```

Puts the ship on the ground. Watch the `chain` field gain two levels, `state`
become `landed`, and local speed drop to zero while universe speed stays at tens
of kilometers per second.

### 3. Watch a frame transition

```js
const target = ir.bodies().find((b) => b.kind === 'rocky')
ir.orbit(target.address, 100000) // inside the sphere of influence
ir.control({ translation: [0, 0, 1] }) // burn prograde
for (let i = 0; i < 30; i++) ir.step(20000)
ir.status().world.events.at(-1) // → { tick, kind: 'frame-change', detail: 'left sphere of influence' }
```

The ship is re-framed from the planet to the system, mid-flight, without moving.

### 4. Break determinism (you can't)

```js
const a = ir.status().world.stateHash
const save = ir.save()
ir.step(500)
ir.load(save)
ir.status().world.stateHash === a // → true
```

### 5. Run it with no browser at all

```bash
pnpm sim --self-test
```

The same core in Node — no DOM, no React, no WebGL — at ~110,000 ticks/s.

---

## Commands

```bash
pnpm dev          # vite on 5173 and wrangler on 8787, in one terminal
pnpm preview      # build, then serve it through the real Worker on 8787
pnpm test         # vitest, node environment only
pnpm typecheck    # five tsconfig projects
pnpm lint         # oxlint
pnpm graph        # dependency layering + cycle check
pnpm brand        # re-render the icons, the share card and the crawler files
pnpm build
pnpm check        # the gate — graph → brand → format → lint → typecheck → test → build

pnpm sim --self-test          # headless run + capability checks
pnpm sim --scenario surface --ticks 2526    # also: --seed, --system, --quiet
pnpm vitest run <substring>   # one test file
```

---

## One gotcha when driving a browser

Chrome throttles `requestAnimationFrame` in **backgrounded tabs**. A freshly
reloaded page that is not focused sits at tick 0 until it is. That is the
browser, not a bug in the clock — but it will cost you ten minutes the first
time if you do not know it.

---

## Where to go next

|                       |                                                              |
| --------------------- | ------------------------------------------------------------ |
| Understand the system | [Architecture](../architecture.md)                           |
| Drive it properly     | [The harness](harness.md)                                    |
| Change it safely      | [AGENTS.md](../../AGENTS.md), then [Extending](extending.md) |
| Agent handbook        | [docs/agents/](../agents/README.md)                          |
| Know what is missing  | [Roadmap](../roadmap.md)                                     |
