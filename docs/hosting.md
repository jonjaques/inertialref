# Hosting

How InertialRef gets from a `dist/` directory to a URL, and what has to exist
behind that URL before the persistent universe is possible.

> **H0, H1, H3, H7 and H8 are built and deployed; H2 is half done. Everything from
> H4 onward is still a plan.** The client is live at
> <https://inertialref.jonjaques.com> — a Cloudflare custom domain, and the only
> one it answers on. It is served by `apps/server`: one Worker, the
> static bundle, `/api/health`, and `/ws` reserved behind a deliberate 501. `packages/net` holds the authority port and the local
> implementation of it that every solo player runs. There is no Durable Object,
> no D1 and no socket yet, and the sections below still describe those in the
> future tense.
>
> [ADR-0008](adr/0008-multiplayer-partitions.md) is the decision it implements,
> [modes](design/modes.md) is what each tier owes the player, and
> [sustainability](design/sustainability.md#the-hosting-question) is who pays.

> **Legend** — ✅ done · 🟡 partial · ⬜ not started · ⛔ deliberately deferred

---

## The one idea

> **The server's job is small, and the architecture's job is to keep it small.**

Because the universe is a pure function of `(seed, catalog version, address)`,
a server never has to store, serve or simulate the galaxy. It holds exactly what
a client cannot derive — **other entities and persistent mutations** — which is
the same set a 744-byte save file holds. That is
[ADR-0007](adr/0007-persistence.md) and [ADR-0008](adr/0008-multiplayer-partitions.md)
agreeing with each other, and it is the reason a non-commercial project can
credibly promise a persistent universe at all.

Every hosting decision below is downstream of that. Where a choice would let the
server grow a responsibility the client could have discharged itself, the choice
is wrong even when it is convenient.

```mermaid
flowchart TB
    subgraph CLIENT["what the client derives — free, offline, forever"]
        DER["galaxy · systems · bodies · orbits<br/>terrain · frames · physics"]
    end
    subgraph SERVER["what a server must hold — the only thing that costs money"]
        ENT["entity states<br/><i>other players' ships</i>"]
        MUT["persistent mutations<br/><i>discovered · destroyed · placed · terrain</i>"]
    end
    DER -.->|"never crosses<br/>the wire"| SERVER

    style CLIENT fill:#065f46,stroke:#064e3b,color:#fff
    style SERVER fill:#5b21b6,stroke:#3b0764,color:#fff
```

---

## The topology

One Worker is the whole front door. It serves the client's static assets, it
answers `/api/*`, and it routes `/ws` to a Durable Object chosen by partition
key.

```mermaid
flowchart TB
    B["<b>browser</b><br/>apps/game · service worker · IndexedDB"]

    subgraph CF["Cloudflare"]
        W["<b>Worker</b> — apps/server<br/>static assets · /api/* · /ws routing"]
        A["static assets<br/><i>free, unlimited requests</i>"]
        DO1["<b>DO</b> partition s:SOL<br/>SQLite · hibernating sockets"]
        DO2["<b>DO</b> partition s:HIP71683"]
        DO3["<b>DO</b> partition c:12,-3,7"]
        D1["<b>D1</b><br/>accounts · discovery credit<br/>catalog revisions · sync"]
        R2["<b>R2</b><br/>inertialrefd-storage<br/><i>reference audio · material sets later</i>"]
    end

    B -->|"GET /"| W
    B -->|"GET /api/*"| W
    B -->|"WS /ws?partition=…"| W
    W --> A
    W --> D1
    W --> DO1
    W --> DO2
    W --> DO3
    DO1 -.->|"writes needing a global<br/>uniqueness guarantee"| D1
    W --> R2
    B -.->|"biome textures"| R2

    style W fill:#0369a1,stroke:#0c4a6e,color:#fff
    style DO1 fill:#5b21b6,stroke:#3b0764,color:#fff
```

**Why one Worker and not three services.** Same origin means no CORS preflight
on every API call, no second hostname for the WebSocket, and no `SameSite`
gymnastics around whatever token identifies a player. Static asset requests are
free and unlimited and do not invoke the Worker at all, so the shared origin
costs nothing. The alternative — an `api.` subdomain — was considered and is
noted under [things that will bite](#things-that-will-bite), because it would
have sidestepped one real problem for free.

---

## What each Cloudflare primitive is for

| Primitive              | Holds                                                                         | Why this one and not another                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workers**            | The client bundle, the API, WebSocket upgrade routing                         | Static asset requests are free and never reach the script. One deploy, one origin, one artifact.                                                                                                            |
| **Durable Objects**    | One authority per partition: connected players, live entity states, mutations | A DO is a single-threaded, addressable, consistent island with its own SQLite. That is precisely the shape of a star system under patched conics.                                                           |
| **DO SQLite**          | Per-partition durable state, co-located with the authority                    | Transactional with the code that owns it. No network round trip. 10 GB per object, which is four orders of magnitude more than a partition will ever need.                                                  |
| **D1**                 | Account-scoped and globally-unique data                                       | Cross-partition queries and global uniqueness — "who discovered this first" — need one writer for the whole galaxy, not one per system.                                                                     |
| **R2** ✅              | What the repository will not carry; biome material sets later                 | Zero egress fees. Today one bucket, `inertialrefd-storage`, holding the cutscene's reference audio ([H-8](#h-8--r2-holds-what-the-repository-will-not-carry)). Material sets are the planned second tenant. |
| **Workers KV**         | ⛔ nothing                                                                    | The catalog is 179 KB brotli and ships in the bundle ([spike 3](spikes.md#3--catalog-bundle-size)). There is no eventually-consistent read tier to fill.                                                    |
| **Queues / Workflows** | ⛔ nothing yet                                                                | No asynchronous fan-out exists. Revisit if catalog revision publishing becomes a batch job.                                                                                                                 |
| **Cloudflare Pages**   | ⛔ nothing                                                                    | Workers static assets is the same capability inside the Worker that already has to exist. Two deploy targets for one site is one too many.                                                                  |

### Numbers, with their source

Every figure below was read from Cloudflare's documentation on **2026-08-20**.
They move; re-check before relying on one.

| Limit                                  | Value                                         |
| -------------------------------------- | --------------------------------------------- |
| Static asset files per Worker version  | 20,000 (Free) / 100,000 (Paid); 25 MiB each   |
| Static asset requests                  | **Free and unlimited**; no storage cost       |
| Worker script size                     | 3 MB gzip (Free) / 10 MB gzip (Paid)          |
| Worker CPU per invocation              | 10 ms (Free) / minutes, configurable (Paid)   |
| Worker memory per isolate              | 128 MB                                        |
| DO storage per object                  | 10 GB                                         |
| DO storage per account                 | 5 GB (Free) / unlimited (Paid)                |
| DO **objects** (instances) per account | **Unlimited**, within an account or a class   |
| DO **classes** (types) per account     | 100 (Free) / 500 (Paid)                       |
| DO CPU per request                     | 30 s default, configurable to 5 min           |
| DO soft request ceiling                | ~1,000 requests/second **per object**         |
| DO outgoing connections per request    | 6                                             |
| WebSocket message received             | 32 MiB max                                    |
| `serializeAttachment` per connection   | 16,384 bytes                                  |
| D1 free tier                           | 5M rows read/day, 100k rows written/day, 5 GB |

**The class/object row is the one people misread, so read it twice.** A
Durable Object _class_ is a type — a blueprint, declared once in
`wrangler.jsonc`. A Durable Object _object_ is a live instance of that class,
addressed by name. **This entire plan defines exactly one class**,
`PartitionAuthority`, and instantiates it once per partition key. Five hundred
players in five hundred different star systems is 500 _objects_ of 1 _class_,
and Cloudflare states plainly that the number of objects is "unlimited (within
an account or of a given class)". The 500 ceiling would only bind if the design
grew 500 distinct _kinds_ of authority, which would be a bizarre thing to want.

The bundle is **736.0 KB gzip** measured 2026-08-25, so the 3 MB script limit is
irrelevant — the bundle is an _asset_, not part of the script.

---

## Decisions

### H-1 · One Worker serves the client and the API

✅ **Built.** `apps/server` owns `wrangler.jsonc` and the Worker entry point,
and points `assets.directory` at `apps/game/dist`. `run_worker_first` sends
`/api` and `/ws` to the script; everything else is served as a static asset
without invoking it.

This is what is deployed, minus the comments:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "inertialrefd",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-20",
  // A custom domain, not a route: it provisions the DNS record and the
  // certificate and points the hostname at this Worker. A route is a pattern
  // over an origin that already exists, and there is no origin here.
  "routes": [{ "pattern": "inertialref.jonjaques.com", "custom_domain": true }],
  "assets": {
    "directory": "../game/dist",
    "binding": "ASSETS",
    // The client is a set of documents; an unmatched path is 404.html
    // (the menu), not the home page wearing that URL.
    "not_found_handling": "404-page",
    "html_handling": "drop-trailing-slash",
    // `/api` is listed as well as `/api/*` because the glob does not match
    // the bare path. `/media/*` wakes the script so a miss 404s as text
    // rather than as a page of markup an `<audio>` element cannot decode.
    "run_worker_first": ["/api", "/api/*", "/ws", "/media/*"],
  },
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "observability": { "enabled": true },
}
```

`run_worker_first` needs Wrangler ≥ 4.20.0.

The Durable Object and D1 bindings are **not** in the deployed config; they
arrive with the milestone that uses them, so nothing is bound that nothing
reads. When the DO does land, `new_sqlite_classes` — not `new_classes` — is
what makes the object SQLite-backed rather than key-value backed; the key-value
backend is not available on the Free plan and has no reason to be used here.

`version_metadata` was not in the original sketch and earns its place: the
health record reports the deployment's version id, so "am I talking to the
build I just shipped" is a question the client answers instead of a log dive.

### H-2 · A Durable Object per partition key, with hibernating sockets

The DO name is the string `partitionForAddress` / `partitionForPosition` already
returns. This is the binding [ADR-0008](adr/0008-multiplayer-partitions.md)
anticipated, and it is a one-line mapping precisely because the seam was built
first:

```ts
const stub = env.PARTITION.getByName(partitionKey) // "s:SOL", "c:12,-3,7"
```

**Hibernation is not an optimization here, it is the cost model.** With
`ctx.acceptWebSocket()` instead of `ws.accept()`, Cloudflare keeps the client
sockets attached to its network while evicting the object from memory, and
**duration charges stop accruing**. That is the property
[sustainability](design/sustainability.md#the-hosting-question) already promised
in public, so it is a requirement rather than a tuning knob.

**Be precise about what it buys, though, because it is easy to overclaim.**
Cloudflare's documentation is explicit that "events such as alarms, incoming
requests, and scheduled callbacks prevent hibernation", and that an object is
evicted only after receiving no events "for a short period" — the threshold is
not published. A partition with players actively _flying_ in it is receiving
intent at 10–20 Hz and therefore **never hibernates**; it bills duration for
every wall-clock second they are there. What hibernation actually buys is:

| State                                   | Hibernating? | Duration cost |
| --------------------------------------- | ------------ | ------------- |
| Nobody in the partition                 | evicted      | none          |
| Connected but idle — alt-tabbed, docked | **yes**      | **none**      |
| Connected and flying, 20 Hz intent      | no           | full          |

**And duration is per object, not per player** — a partition with fifty people
in it bills the same wall-clock second as a partition with one. That single fact
is what makes [tall cheap and wide expensive](#tall-and-wide-500-concurrent-players-two-ways),
and it is why [H-6](#h-6--an-authority-streams-only-when-it-has-someone-to-replicate-to)
exists.

The first row is the one that carries the promise, and it is the common case:
most of the galaxy is empty at any moment. The second row is what makes a
half-attentive player free instead of expensive. The third is the real bill, and
it is priced in [cost model](#cost-model) rather than waved at.

Two consequences that shape the code:

- **No instance fields survive hibernation.** Per-connection state goes in
  `ws.serializeAttachment()` (16 KiB), everything else in `ctx.storage.sql`. A DO
  that keeps a `Map` of players in memory works perfectly in development and
  loses everyone the first time it sleeps.
- **Heartbeats must not wake it.** `ctx.setWebSocketAutoResponse(new
WebSocketRequestResponsePair("ping", "pong"))` answers keepalives in the
  runtime, and the docs are explicit that auto-responses accrue no wall-clock
  time and are not charged.

### H-3 · Two databases, and the rule for choosing

There is exactly one question, and it is not "which is faster":

> **Does this write need an ordering guarantee relative to one partition's
> simulation, or a uniqueness guarantee across the whole galaxy?**

| Data                                         | Where     | Because                                                                             |
| -------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Live entity states in a system               | DO SQLite | Ordered against that partition's tick; meaningless anywhere else                    |
| `placed` / `destroyed` / `terrain` mutations | DO SQLite | Scoped to an address inside one system; the authority that validates them owns them |
| Which players are connected                  | DO SQLite | Same                                                                                |
| **First-discovery claims**                   | **D1**    | "First in the galaxy" is a global uniqueness claim. One writer, one unique index.   |
| Accounts, tokens                             | D1        | Cross-partition by definition                                                       |
| Catalog revisions                            | D1        | Read by every client, written by nobody at runtime                                  |
| Almanac / bookmark sync                      | D1        | Per player, not per place                                                           |

Discovery credit is the interesting one because it is tempting to put it in the
DO that witnessed it. It cannot live there: two players in two different systems
can claim the same address if the catalog ever lets one system's contents be
referenced from another, and more importantly the _query_ — "show me everything
I discovered first" — spans every partition a player has ever visited. In D1 it
is `INSERT … ON CONFLICT DO NOTHING` against a unique index on the address, which
is a genuine atomic first-write-wins because D1 has a single primary.

If claim write rate ever outgrows D1's 50M rows/month, the escape hatch is a
sharded arbiter DO keyed by an address prefix, mirroring into D1 for reads. That
is a change of implementation behind the same API, which is why the API should be
`claimDiscovery(address)` and not `insertDiscoveryRow(...)`.

### H-4 · The vendor stays in `apps/`, and a new package holds the port

✅ **The port and the local implementation are built** (H3). `remote.ts` and
`channel.ts` are not, and deliberately: they have no caller until there is a
socket, and shipping an implementation of a transport nothing transports over is
how a seam becomes fiction. What exists is below; what is missing is marked.

`packages/*` may not import a Cloudflare SDK, and `pnpm graph` now genuinely
enforces it by rejecting **any** third-party runtime dependency below `apps/`.
Nothing on this page changes that. The pattern is the one
[`packages/workers`](../packages/workers/src/transport.ts) already uses for Web
Workers, and the analogy is exact:

| Web Workers (built ✅)                                                         | Networking (to build ⬜)                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `WorkerInbound` / `WorkerOutbound` in `protocol`                               | `ClientToServer` / `ServerToClient` in `protocol`      |
| `WorkerPort` — `post` / `subscribe` / `terminate`                              | `ChannelPort` — `post` / `subscribe` / `close`         |
| `WorkerPool` owns dispatch and cancellation                                    | `RemoteAuthority` owns the session and reconnect       |
| Browser passes a real `Worker`                                                 | Browser passes a real `WebSocket`                      |
| Node tests pass an in-process fake                                             | Node tests pass an in-process fake                     |
| `apps/game/src/engine/browserWorker.ts` is the only place `new Worker` appears | **one file** is the only place `new WebSocket` appears |

New package, mirroring the existing layout:

```
packages/net/          layer 5 — depends on shared, spatial, universe, simulation, protocol
  authority.ts       ✅ AuthorityPort, its messages, clientHello, partitionOfEntity
  local.ts           ✅ LocalAuthority — the single-player case, not a stub
  remote.ts          ⬜ RemoteAuthority over a ChannelPort
  channel.ts         ⬜ ChannelPort — the host boundary
```

Layer 5 is deliberate and slightly awkward: `net` cannot depend on
`persistence`, which is also layer 5, even though both encode entities. They do
not need to — the shared encoding is already in `protocol` (`encodeFrameState`,
`SaveEntity`), which sits at layer 4 under both. If you find yourself wanting
`net` to import `persistence`, the thing you actually want belongs in
`protocol`.

```ts
/* packages/net/src/authority.ts — sketch */
export interface AuthorityPort {
  /** Enter a partition. Resolves once the authority has accepted the client. */
  join(
    partition: PartitionKey,
    hello: ClientHello,
  ): Promise<Result<Joined, string>>
  leave(): void
  /** Control input and mutation proposals. Fire-and-forget; never awaited in the loop. */
  submit(intent: Intent): void
  /** Authoritative state for entities this client does not own. */
  subscribe(handler: (update: AuthorityUpdate) => void): () => void
}
```

`LocalAuthority` implements all four against the in-process `World` and is what
runs in [solo offline](design/modes.md#solo-offline) — **the normal case, not a
mock**. Offline-first is the requirement, so the local implementation is the one
that must never be allowed to rot.

The mechanism that keeps it from rotting turned out to be simpler than a
discipline: `openSession` takes an `AuthorityPort` and defaults to a
`LocalAuthority` over its own world. There is no flag and no branch anywhere, so
the local path is what every host — the browser client, the headless runner, the
capability checks, every test — exercises by default.

Two things about the built version that the sketch did not anticipate, both
worth keeping:

- **`join` returns a `Result`, and refusal is an answer rather than a failure.**
  `LocalAuthority` runs the same `incompatibility()` check a remote one will, so
  the two cannot drift into applying different rules to the same question. It
  additionally refuses a hello carrying a different seed, because the seed _is_
  the universe — a position replicated between two of them refers to a planet
  only one of them has.
- **`status().partition` is recomputed, never remembered.** A remembered one is
  correct until the first frame transition and quietly wrong afterwards. Flying
  from Sol to Alpha Centauri moves the reported authority from `s:SOL` to
  `s:HIP71683` with nothing driving it, which makes the
  [handoff question](#open-questions) something you can watch on the overlay a
  milestone before it has to be answered.

### H-5 · The wire protocol is versioned, and the handshake refuses a mismatch

[modes](design/modes.md) states it as a design constraint: _all clients in a
partition must run the same catalog version; it becomes a protocol handshake._
It is stronger than that. A client whose `GENERATION_VERSIONS` differ derives a
**different universe** — different planets, different terrain — so replicating a
position into it is meaningless.

The handshake therefore carries `seed`, `galaxy`, `GENERATION_VERSIONS` and a
`NET_PROTOCOL_VERSION`, and a mismatch is **refused with a reason**, not
best-effort accepted. This is the same rule the save loader already applies to a
newer schema ([ADR-0007](adr/0007-persistence.md)) and for the same reason:
silently proceeding loses data that looks like it was preserved.

Decoders go in `packages/protocol/src/net.ts`, built from the existing codec
combinators. The network is a trust boundary, so every inbound message is
decoded rather than cast — exactly as save files and worker messages already are.

🟡 **Half built.** `net.ts` holds `NET_PROTOCOL_VERSION`, the shared paths, the
`ServerHealth` record with its decoder, and `incompatibility()` — the rule that
compares two version manifests and returns a sentence or `null`. The healthcheck
already refuses on a mismatch, so the rule is exercised in production by every
client on every probe rather than waiting for a socket to be written against it.

One decision inside it is worth recording, because the tempting default is the
wrong one: **an algorithm present on one side and absent on the other is a
mismatch, not a default.** A generator the server runs and the client does not
is a universe the client cannot derive, and the reverse is the same statement.
Ignoring unknown keys would make the handshake pass in exactly the case it
exists to catch.

### H-7 · The front door is a public surface, not just a bundle

✅ **Built.** Everything a person or a machine meets before the WebGPU canvas
does: the share card, the install manifest, the crawler files, the analytics
gate, and the one asset the repository will not carry.

**One canonical hostname.** `inertialref.jonjaques.com` is what
`<link rel="canonical">` names, what the sitemap lists, and the only host
`src/analytics.ts` will load a tag on. Every Wrangler preview URL is the same
deployment under a different name — useful for checking a build, and wrong to
count as visits or to let a crawler index as a duplicate site. The Worker's own
`workers.dev` route is off (`workers_dev: false` in `wrangler.jsonc`), so there
is no second address that tracks the tip; a preview URL names one version.

**The static head is the card, and it is HTML on disk.** Every mode and
every documentation page is a document Astro emitted. A scraper does not
run JavaScript, so `astro/layouts/Base.astro` interpolating `src/site.ts`
is the only card the site has. Per-route Open Graph is free because it is
a file; the Worker does not run on a navigation. `pages/DocumentMeta.tsx`
rewrites `<title>` only for overlay `pushState`, which does not load a
new document.

`not_found_handling` is `404-page`. An unmatched path is `404.html` — the
menu, wearing that status — not the home page wearing that URL.
`html_handling` is `drop-trailing-slash`, pairing with Astro
`build.format: 'file'` so `/planetarium` maps to `planetarium.html`.

> **The seam that remains.** Overlay dialogs change the address bar
> without loading a document, so the tab title needs a client rewrite.
> That is `DocumentMeta`. A _scene_ with its own share image is more HTML
> on disk, not `HTMLRewriter` on `/*`.

**Installable, because offline was already true.** The service worker predates
this; what was missing was the manifest that lets a browser act on it. The game
is a pure function of a seed, so once the bundle and the 458 KB catalog are
cached there is nothing left to fetch — an installed copy is a real offline
application rather than a shortcut with a dinosaur behind it.

**The brand is generated.** `design/brand/brandmark.svg` is the mark, and
`pnpm brand` renders the favicon, the `.ico`, the apple-touch and PWA icons, the
maskable variant, the 1200×630 share card, the manifest, `robots.txt` and the
`<Logomark>` module from it. `pnpm brand:check` is in `pnpm check`. The sitemap
is every page Astro emitted (`@astrojs/sitemap`); brand does not write it.

The card's background is the one artifact with a second source:
`design/brand/og-plate.png`, a frame of the real renderer — Earth's limb at
sunrise, with the flare the flight camera actually produces — captured once and
committed. The build composites the type over it with `sharp` and never touches
a GPU, and the picture cannot drift because it is a file in the tree rather
than a screenshot taken at build time. That was the objection to screenshots,
and it is an objection about the build; the drawing it replaced was six bezier
continents on a cyan disk.

**Agents are welcome and are told so.** `robots.txt` allows everything and
points at `/llms.txt`, which is the short prose version of what this project is
— written on the premise that a reader arriving at a WebGPU canvas with no
JavaScript has otherwise been handed nothing. The `<noscript>` block is the same
courtesy for a person.

### H-8 · R2 holds what the repository will not carry

✅ **Built.** The cutscene is cut against a piece of music that is somebody
else's. Its use here is a fair-use claim this project is willing to make in a
deployment and not in a git history — which is permanent, mirrored by every fork
and indexed. So the track lives in `r2://inertialrefd-storage/dropbox/` and
reaches the browser two ways, both of which start from **one table** in
`apps/server/src/media.ts`:

1. **`pnpm media:pull`**, run by `pnpm build` with `--optional`, copies it into
   `apps/game/public/media/` (gitignored as a directory) so it ships in the
   bundle as an ordinary static asset. Free, never wakes the script, and `Range`
   is the asset server's problem.
2. **The `MEDIA` binding**, when the bundle does not have it — a build that ran
   without R2 credentials, which is what a fork gets.

They are not two sources. It is one object under one key, reached by two
transports, and the fallback is what makes a credential-less build a slower
first byte rather than a missing feature.

**`run_worker_first` covers `/media/*`, and that is the cost.** The path is no
longer free: the script runs, asks `env.ASSETS` first, and only reaches R2 on a
miss. Two things buy it back. The response is `immutable`, so it is about one
invocation per client rather than one per play. And a name that is _not_
served answers as HTML — the 404 document — so an `<audio>` element handed a
page of markup fails as though it could not decode the file.

**The miss is detected by content type**, because a 404 page is still HTML.
Nothing under `/media/` is ever HTML, so an HTML answer to a request for an
`.mp3` is unambiguous. Trusting the status and forwarding it would hand the
element markup.

**`env.ASSETS` does not serve ranges**, which is the second reason the binding
is here rather than only the fallback one. Measured against a deployed review
app: `Range: bytes=0-1023` on this file comes back **200 with all 2.7 MB**. A
browser copes — it buffers the whole track and seeks locally — but the cutscene
overlay drives `currentTime` against a reference clock, so on a slow connection
every seek waits for a download a 206 would have made unnecessary. So when a
range is asked for and the asset store ignores it, R2 answers instead. That is
the one case where the second transport is not a fallback but the better path.

**An allow-list, not a key prefix.** `inertialrefd-storage` is the site's general
storage, not a public directory. Mapping `/media/*` onto a prefix would make
everything under it world-readable and would turn `/media/../` into a bucket
read; `mediaFor` answers for exactly the names in the table.

> **Two things bit here and are worth reading before touching the handler.**
>
> **`R2Range` is published as a union of three exclusive shapes**, so the
> obvious implementation narrows with `'suffix' in range`. The object workerd
> actually hands over has all three keys present with two of them `undefined`,
> so that test is true for a range with no suffix and the arithmetic runs
> `size - undefined`. Everything came out `NaN`, the runtime quietly replaced
> `Content-Length` from the real body size, and the only visible symptom was
> `Content-Range: bytes NaN-NaN/2747091` on a response whose bytes were
> correct. **Narrow on the value.** `routes.test.ts` has the regression.
>
> **`stored.range` is populated whether or not the request carried a `Range`
> header** — an unranged get reports the whole object as its range — so keying
> the status off it answers every plain GET with `206 Partial Content`. Browsers
> mostly cope; caches are entitled not to.

Workers Builds needs R2 read on whatever token it runs `wrangler` with for the
_bundled_ copy to exist. If it does not have one, the deploy still succeeds, the
build log says so in one line, and the Worker serves the track from the bucket
instead — which is the whole point of having both.

---

## The seams that already exist

Worth stating plainly, because most of this plan is wiring rather than
invention:

| Seam                                                     | Status | Where                                           |
| -------------------------------------------------------- | ------ | ----------------------------------------------- |
| Partition keys as opaque strings                         | ✅     | `packages/universe/src/partition.ts`            |
| Authority follows the frame chain, not the address       | ✅     | `devtools/inspect.ts` via `systemOfFrameId`     |
| Storage behind a port, with a memory implementation      | ✅     | `packages/persistence/src/store.ts`             |
| Host capabilities behind a port, with an in-process fake | ✅     | `packages/workers/src/transport.ts`             |
| Versioned, validated, decoded-not-cast wire schemas      | ✅     | `packages/protocol`                             |
| Replication set == save set                              | ✅     | `SaveGame.entities` + `SaveGame.mutations`      |
| No vendor SDK below `apps/`, mechanically enforced       | ✅     | `scripts/check-graph.mjs`                       |
| Session assembled in exactly one place                   | ✅     | `packages/devtools/src/session.ts`              |
| A versioned handshake that refuses a mismatch            | ✅     | `packages/protocol/src/net.ts`                  |
| `AuthorityPort` + `LocalAuthority`                       | ✅     | `packages/net`                                  |
| A session built around a port, with no `if (online)`     | ✅     | `openSession({ authority })`                    |
| Input log for prediction and replay                      | ⬜     | [roadmap](roadmap.md#replay-and-reconciliation) |

**One of those was a lie by coincidence, and H0 fixed it.** `inspect.ts`
computed the authority key by scanning the frame chain for an `s:` prefix
_itself_ rather than calling `partitionForAddress`, and the two agreed only
because the frame-id grammar and the partition-key grammar happen to spell a
system the same way. That was one rename away from a bug in which the debug
overlay and the router disagree about which Durable Object owns a ship — with
the overlay being the tool you would reach for to diagnose it.

The frame grammar's owner now supplies the inverse (`systemOfFrameId` in
`packages/universe/src/frames.ts`), the overlay composes it with
`partitionForAddress`, and `partition.test.ts` asserts the two agree rather than
asserting a literal — because a literal passes for both the right answer and
the coincidence.

---

## What has to be built

```
apps/server/                    ✅ the only place Cloudflare appears
  wrangler.jsonc                ✅
  tsconfig.json                 ✅ the fourth typecheck project
  src/index.ts                  ✅ fetch handler: /api/health, /ws (501), assets
  src/routes.ts                 ✅ pure routing, so it is testable in plain Node
  worker-configuration.d.ts     ✅ generated by `wrangler types`, committed
  src/partition.ts              ⬜ class PartitionAuthority extends DurableObject
  src/api/                      ⬜ discovery, catalog, sync
  migrations/                   ⬜ D1 schema, one file per change

packages/protocol/src/net.ts    🟡 paths, NET_PROTOCOL_VERSION, ServerHealth,
                                   and the compatibility rule — no messages yet
apps/game/src/net/health.ts     ✅ the only place the client fetches /api
apps/game/public/sw.js          ✅ /api and /ws bypassed; see below
apps/game/src/net/socket.ts     ⬜ the only `new WebSocket` in the client

packages/net/                   ✅ layer 5, no vendor import
  authority.ts                  ✅ the port, its messages, clientHello
  local.ts                      ✅ LocalAuthority
  remote.ts · channel.ts        ⬜ H4, when there is something to transport
packages/devtools/src/session.ts ✅ accepts an AuthorityPort, defaults to local
packages/universe/src/partition.ts 🟡 gained `partitionForFrames`, now shared
                                   by the overlay and the authority
```

That last line is the only change H1 and H3 together forced below `apps/`, and
it is a deduplication rather than a feature: the overlay and the authority both
have to know which partition owns a ship, and two open-codings of the same
coincidence is precisely what H0 had just finished removing.

`apps/server` is an **app**, so it may depend on `wrangler`,
`@cloudflare/workers-types` and `cloudflare:workers`. `pnpm graph` reads
`packages/` only, which is correct and deliberate: the vendor is allowed at the
edge of the graph and nowhere else.

### Naming

`apps/server` over `apps/edge` or `apps/api`, because the repo names apps for
what they are — `game` is the browser client, `headless` is the Node runner —
and this one serves. It is also the name a self-hoster would expect, and
[sustainability](design/sustainability.md#the-hosting-question) commits to the
authority server being runnable by anyone.

The **deployed Worker** is `inertialrefd`, with the daemon suffix, so the
running service and the repository are never the same name in a sentence. The
directory keeps the plain name; only the deployment carries the `d`.

---

## Things that will bite

Ordered by how expensive they are to discover late.

### The service worker will cache your API responses forever ✅ fixed

`apps/game/public/sw.js` was cache-first for **every same-origin GET that is not
a navigation**. That policy is correct for content-hashed assets by
construction, and catastrophic for live state: the first `/api` response would
be pinned for the lifetime of the cache, and because the cache survives reloads
it presents as "the API is stuck" with a perfectly healthy server.

Fixed in the same change that added the first endpoint, as this page asked.
There are now three layers, because the failure is silent, durable and
indistinguishable from an outage: the service worker returns early, the Worker
sends `cache-control: no-store`, and the client's probe asks for
`cache: 'no-store'`.

Three other things came out of looking at that file properly, all of which would
have bitten later rather than sooner:

- **Cache-first is wrong for the unhashed files too.** `favicon.svg`, the web
  manifest, `robots.txt` and the share card have no hash in their names, so
  cache-first meant a change to any of them could never reach anyone who had
  loaded the game once. They are stale-while-revalidate now. Cache-first is
  kept for `/assets/*`, which is honest because Vite's content hashing is what
  makes it safe — and for `/media/*`, which is object storage
  ([H-8](#h-8--r2-holds-what-the-repository-will-not-carry)): a fixed
  reference track, where stale-while-revalidate would re-fetch 2.7 MB of audio
  in the background on every load of the site.
- **A fixed cache name has to be bumped by hand.** It is now
  `inertialref-${build}`, where the build id arrives on the registration URL —
  `sw.js` is copied verbatim out of `public/` and never compiled, so the URL is
  the only channel into it. Activation deletes previous `inertialref-` caches
  and leaves anything else on the origin alone.
- **Range requests must not be cached.** A 206 stored whole is served back as
  the complete resource. Nothing issues one today; the material sets will.

None of that was verifiable by reading. `apps/game/src/net/serviceWorker.test.ts`
loads the real file, installs its real handlers against stubbed globals and asks
it what it would do — including that it bypasses exactly the paths `net.ts`
declares, which is the one duplication that could not be removed.

> An `api.` subdomain would have avoided this for free, since the handler
> already returns early for cross-origin requests. It was not chosen because
> CORS preflights, a second deploy target and a second hostname for the socket
> are a permanent cost, and this is a three-line one. Recorded here so the
> trade-off is visible rather than implied.

### `Date.now()` is doubly forbidden

It is already banned in canonical code by
[ADR-0006](adr/0006-simulation-clock.md) — generation derives from seeds and
simulation depends on the integer tick, and wall clock enters at exactly one
call, `clock.advance`. **In a Worker it is also not what you think it is.** From
Cloudflare's [security model](https://developers.cloudflare.com/workers/reference/security-model/):
_"the time value returned is not the current time. `Date.now()` returns the time
of the last I/O. It does not advance during code execution."_ That is a Spectre
mitigation, not a bug — a Worker is deliberately denied the ability to time its
own execution. Two reads with no `await` between them return the same value.

So a server-side authority cannot drive a tick from wall clock even if the rules
allowed it. It advances the same way the client does — from a fixed cadence — and
the cadence source is `ctx.storage.setAlarm()`.

### One alarm per simulation tick is not viable

The simulation runs at 64 Hz. An alarm per tick is 64 billable requests per
second per partition and is nowhere near that punctual anyway. The shape that
works, and the one the roadmap already anticipates:

| Rate      | Who         | What                                                        |
| --------- | ----------- | ----------------------------------------------------------- |
| 64 Hz     | client      | Full simulation, locally, exactly as it runs today          |
| 10–20 Hz  | client → DO | Batched intent: control input, not per-frame position       |
| 5–10 Hz   | DO → client | Authoritative snapshots of entities the client does not own |
| on demand | DO alarm    | Persistence flush, presence timeout, partition teardown     |

This is why [replay recording](roadmap.md#replay-and-reconciliation) is listed as
a multiplayer prerequisite: the input log `(tick, entityId, controlInput)` **is**
the intent stream, and building it is multiplayer work brought forward cheaply
rather than deferred.

### Incoming WebSocket messages are billed, outgoing ones are not

Cloudflare counts HTTP requests, RPC sessions, WebSocket messages and alarm
invocations as requests. Two details change the design:

- **There is no charge for outgoing WebSocket messages.** Broadcasting state to
  every connected client is free of request cost. Fan-out is cheap.
- **Incoming messages are billed at a 20:1 ratio** — 100 inbound messages bill as
  5 requests.

So the cost driver is client→server message _rate_, and the mitigation is
batching intent at a fixed cadence rather than sending on input change. At 20 Hz
inbound with 10 players in a partition, that is 200 messages/s → 10 billable
requests/s → ~26M billable requests/month for one continuously-busy system, which
is about $4/month of request cost. Duration is the number to watch instead, and
hibernation is what keeps it near zero.

### A Durable Object is single-threaded, with a soft ceiling around 1,000 req/s

Per object. A partition is a star system, and a star system with a thousand
requests per second is a design problem long before it is an infrastructure one.
Worth knowing because it is the number that decides whether "partition by star
system" survives contact with a popular system — and
[ADR-0008](adr/0008-multiplayer-partitions.md) is explicit that
`PARTITION_ENTRY_RADIUS` and the entry rule are **guesses to be validated against
real latency and real player density**, not decisions.

### A Durable Object lives in one place, and never moves

Cloudflare creates an object in a data center near the **first** `get()` for that
name and states plainly that "Durable Objects do not currently change locations
after they are created". `locationHint` biases creation only, and is best-effort.

The consequence for a partition-per-star-system model is not obvious and is not
mentioned in [ADR-0008](adr/0008-multiplayer-partitions.md): **the first player
to enter Sol decides where Sol's authority lives, for everyone, forever.** A
player in Sydney joining a Sol object created in Frankfurt eats ~250 ms round
trip to the authority.

For what H4 builds, that is genuinely fine — ships do not collide, there is no
entity-to-entity physics, and a ghost 250 ms behind where it really is looks
exactly like a ghost. It stops being fine the moment anything is
[contested](design/combat.md), because then the same latency decides who shot
first.

Two things follow, and neither is work for today:

- The partition key may eventually need a **region component** (`s:SOL@apac`),
  which shards a busy system by locality and is a change to
  `partitionForAddress` — a package-level change, not an infrastructure one.
  Worth knowing before the key grammar hardens.
- It is another reason the relay-only posture in H4 is not merely a stopgap.
  A DO's pinned location is a poor foundation for authoritative combat
  arbitration, and the design has already decided the client knows everything
  anyway ([modes](design/modes.md)).

### Three tsconfig projects become four ✅ done

`pnpm typecheck` runs four projects now, one per real environment, and
[AGENTS.md](../AGENTS.md) explains why that is deliberate rather than
accidental. `apps/server` is the fourth.

One correction to the plan: `@cloudflare/workers-types` is not involved.
`wrangler types` emits the runtime types _and_ the `Env` interface into a single
`worker-configuration.d.ts` — 580 KB of it — so the project has `types: []` and
includes that file. It is committed, which means it is also in `.prettierignore`:
reformatting generated output produces a diff nobody wrote.

### Tests run in Node, on purpose, and DO tests cannot

`vitest.config.ts` registers no browser environment deliberately — that is the
check that the core stays free of DOM, React and WebGL. Durable Object tests need
`@cloudflare/vitest-pool-workers`, which runs inside workerd.

Do not change the existing project. Add a **second** Vitest project scoped to
`apps/server/**`, so `pnpm test` still proves the core is environment-free and
additionally proves the adapter works. `runInDurableObject` and
`runDurableObjectAlarm` let an alarm be triggered without waiting for one, which
is what makes hibernation and teardown testable at all. Note that the pool wants
`vitest@^4.1.0` and the repo pins `^4.0.5` — that is a bump, in its own commit.

### The dev loop is two servers, and that is the cheaper option

`@cloudflare/vite-plugin` runs the Worker inside Vite's dev server on real
workerd, which is genuinely nicer. It also takes over the client build — and the
current build is Vite 8 with the Oxc transform, `@rolldown/plugin-babel` running
the React Compiler preset, and Tailwind, which is tuned and load-bearing.

✅ **Wired, and now one command.** `vite dev` proxies `/api` and `/ws` to
`wrangler dev` on 8787, and `scripts/dev.mjs` starts both under `pnpm dev` with
prefixed output and a shared lifetime — one exits, both stop. That was the
actual cost of the split: not two processes, but a second terminal somebody
could forget, after which every `/api` call fails in a way indistinguishable
from a broken client. `pnpm dev:client` and `pnpm dev:server` are still the
halves, and `dev:client` exists partly because piping Vite's stdio costs its
interactive `r`/`o`/`q` keys.

Revisit the plugin once _that_ is annoying enough to be worth the build risk,
and revisit it as a _separate_ change so a build regression has one suspect.

**`pnpm preview` is the production emulation**, and it is what to reach for when
a bug is about how something is _served_ rather than what it does: it builds and
then runs `wrangler dev` alone, so the assets come out of the real static asset
store through the real `run_worker_first` and the real `404-page` handling, and
the service worker registers because it is a production build. Under `pnpm dev`
all of that is Vite's.

A property worth keeping rather than fixing: with the Worker **not** running,
the proxy fails and the client reports `no server`. The offline path is
therefore easy to exercise in development, which is the right way round for a
game whose normal case is solo offline — `pnpm dev:client` is now the way to get
it deliberately.

### Cross-origin isolation is a door that is currently open

`SharedArrayBuffer` is listed as unstarted in the
[roadmap](roadmap.md#performance-work) and needs COOP/COEP headers. A Worker can
set them, but `require-corp` breaks every cross-origin resource that does not
opt in — which would include R2-hosted material sets unless they carry
`Cross-Origin-Resource-Policy`. Nothing needs it yet; the note exists so the
requirement is discovered before the material sets are, not after.

---

## Milestones

Each one ends in something demonstrable. The point of the ordering is that
**every component is stood up and testable before any of them is load-bearing**,
which is the same discipline `partitionForPosition` already got: build the seam,
put it on the debug overlay, and look at it for a phase before trusting it.

| #         | Milestone                            | Ends when                                                                                                                                                                   |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H0** ✅ | Fix the coincidence                  | `inspect.ts` calls `partitionForAddress`; a renamed frame grammar breaks a test rather than production                                                                      |
| **H1** ✅ | The client is on a URL               | `apps/server` exists, serves `apps/game/dist`, SPA fallback works, service worker excludes `/api` and `/ws`, custom domain live, 12/12 capability checks pass in production |
| **H2** 🟡 | The API exists and is empty          | `/api/version` returns seed, galaxy and `GENERATION_VERSIONS`; D1 bound with one migration; `wrangler types` output committed; fourth tsconfig project green                |
| **H3** ✅ | The port exists, still offline       | `packages/net` with `AuthorityPort` + `LocalAuthority`; `openSession` takes one and defaults to local; **no behavioral change**, proven by an unchanged `stateHash`         |
| **H4**    | The socket exists, carrying presence | One DO per partition with hibernating sockets; two browser tabs in Sol see each other's ship; closing one drops presence within the timeout; state survives an eviction     |
| **H5**    | The first real mutation              | A `discovered` claim written through the API, atomic in D1, visible to the other tab, and present in a save round trip                                                      |

H4 is the milestone the request actually asks for: everything stood up, nothing
load-bearing.

**Where this actually stands.** H0 and H3 are done. H1 is done apart from the
custom domain — the client is live, unmatched paths are a 404 page, and the
service worker excludes both live paths. H2 is half done from the other end than
planned: `wrangler types` output is committed and the fourth tsconfig project is
green, but the endpoint that exists is `/api/health` rather than `/api/version`,
and there is no D1 yet. Health turned out to be the more useful of the two to
build first, because it is the one the client has a reason to call on a
schedule — and it carries `GENERATION_VERSIONS` anyway, so `/api/version` is now
a rename away rather than a build.

The client shows the result in the telemetry tab under **network**, in five
states: `checking`, `online`, `offline` (the browser says there is no network),
`no server` (the request did not complete) and `mismatch` (something answered,
but not with a health record this build can use). `mismatch` is the one that
earns its place — it is [H-5](#h-5--the-wire-protocol-is-versioned-and-the-handshake-refuses-a-mismatch)
arriving early, and it also catches a captive portal, which answers every
request with a cheerful 200 and is otherwise indistinguishable from a healthy
server.

H3 added an **authority** section above it, and they are deliberately separate
questions. You can be `online` and `alone`, which is the normal case and the one
[H-6](#h-6--an-authority-streams-only-when-it-has-someone-to-replicate-to)
exists to keep free. `partition` appears there _and_ on the player, which is not
redundancy: one is the overlay's own derivation from the frame chain and the
other is what the authority believes, and the whole reason `partitionForFrames`
exists is that those two once agreed only by coincidence.

### The smoke test that proves all four components at once

Worth designing before the code, because it is what makes the whole thing a
capability check rather than a demo:

1. Tab A and tab B both `ir.goTo('SOL')`. Both report `authority: s:SOL` on the
   telemetry overlay. **Proves** partition routing agrees with the debug field.
2. Tab B's ship appears in tab A and moves. **Proves** the socket, the DO, the
   protocol and the replication set.
3. Close tab B. Presence drops in tab A within the timeout. **Proves** the alarm.
4. Leave both idle for longer than the hibernation threshold, then move. State is
   intact. **Proves** nothing important was living in an instance field.
5. `pnpm sim --connect wss://…` joins as a third client from Node. **Proves** the
   protocol has no browser dependency — the same claim `apps/headless` makes for
   the simulation core, made again for the network.

(5) is the one worth building deliberately. Node 26 has a global `WebSocket`, so
the headless runner can be the second player, which means a multiplayer
regression is reproducible in CI without a browser.

---

## Environments, deployment and secrets

**Workers Builds** — Cloudflare's own repo-connected CI — is what deploys.
`main` is production; every other branch produces a **review app**, a preview
version at its own URL. That removes the API token from GitHub entirely, which
is why it won out over a deploy workflow in Actions.

| Concern         | Approach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production      | Push to `main` → `wrangler deploy`. One Worker, `inertialrefd`, on the `inertialref.jonjaques.com` custom domain and nowhere else — `workers_dev` is `false`, so there is no second address tracking the tip.                                                                                                                                                                                                                                                                                                                         |
| Review apps     | Any other branch → `wrangler versions upload`, which uploads a version and its assets without promoting it. `preview_urls` is `true`, so each version answers on its own generated `<version>-inertialrefd.<subdomain>.workers.dev` — its own URL, its own origin, naming one build rather than the latest. No `--preview-alias`: a readable alias outlives the reason it was minted.                                                                                                                                                 |
| The gate        | `pnpm check` stays in `.github/workflows/check.yml`. **Cloudflare cannot see a GitHub status check**, so branch protection on `main` is what actually prevents a red merge from deploying.                                                                                                                                                                                                                                                                                                                                            |
| Build command   | `pnpm build` — an optional R2 media pull, the documentation build, typecheck across five projects, then Astro into `apps/game/dist`, which is what `assets.directory` points at. `pnpm docs:build` stages page bodies in `apps/game/.doc-content/` (Astro's input) and the rail's manifest plus the search index in `apps/game/public/doc-content/` (runtime fetches). Both are gitignored; the deploy carries the documentation only because the build regenerates it. See [H-8](#h-8--r2-holds-what-the-repository-will-not-carry). |
| Node version    | `.node-version`, read by Cloudflare's build image _and_ by the Actions workflow, so the two cannot disagree about the runtime.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Build identity  | `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BRANCH` become `__BUILD_ID__`, so a review app's HUD names the branch it was built from.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Migrations      | D1 migrations run from the build command, before the deploy step, so the schema is never behind the code. Not needed until H2.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secrets         | `wrangler secret put`, never `vars`, and **not** Workers Builds' build variables — those exist only during the build. Nothing in `wrangler.jsonc` may be a credential; it is committed.                                                                                                                                                                                                                                                                                                                                               |
| Build variables | `VITE_GA_MEASUREMENT_ID`, set in Workers Builds. Not a secret — it ships in the bundle — but this repository is public, and an id committed in it is an id every fork measures into. A build run from a developer's machine reads the same name out of the gitignored `apps/game/.env.production`; a real environment variable wins over the file. `apps/game/.env.example` is the committed documentation.                                                                                                                           |
| Rollback        | `wrangler rollback`, or promote a previous version from the dashboard. DO SQLite migrations are not rolled back by it; write them additively.                                                                                                                                                                                                                                                                                                                                                                                         |
| Manual deploy   | `pnpm run deploy:worker` still works and is the escape hatch when CI is the thing that is broken.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Observability   | `observability.enabled` for Workers Logs. The client already has structured logging in `packages/shared` — use the same shape.                                                                                                                                                                                                                                                                                                                                                                                                        |

### Review apps stop at H4, and that is worth knowing now

Cloudflare's documentation states plainly that **preview URLs are not generated
for Workers that implement Durable Objects**. Every milestone up to and
including H3 is therefore reviewable at a URL; the moment `PartitionAuthority`
is declared in `wrangler.jsonc`, the review-app model this repository is being
set up for stops producing them — at exactly the milestone whose whole
demonstration is _two clients on a URL seeing each other_.

Three ways out, none of them free, none of them decided:

- **A dedicated staging Worker.** A second Wrangler environment with its own DO
  namespace, deployed from a long-lived branch. Costs a second deploy target,
  which [H-1](#h-1--one-worker-serves-the-client-and-the-api) argued against for
  the _client_ — but a staging environment is a different argument from a second
  origin per request.
- **Split the socket out.** Keeps preview URLs for the front door and loses the
  single-origin property that made [H-1](#h-1--one-worker-serves-the-client-and-the-api)
  worth choosing. Probably wrong.
- **Accept it**, and review H4 locally with `wrangler dev`, which runs real
  workerd and real Durable Objects.

Verify the constraint before designing around it — it is the kind of limitation
Cloudflare removes without announcing. Re-read it when H4 starts.

---

## Cost model

Restating [sustainability](design/sustainability.md#the-hosting-question) with the
2026-08-20 numbers attached.

| Mode                    | What runs                         | Monthly cost shape                                                                  |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| **Solo offline**        | Nothing. Assets only.             | **$0.** Static asset requests are free and unlimited.                               |
| **Solo online**         | Worker + D1                       | Workers Paid floor of $5. D1's free allowance (5M rows read/day) covers a long way. |
| **Persistent universe** | + one DO per _occupied_ partition | Scales with concurrency, not with galaxy size. An empty partition bills nothing.    |

The floor is the $5 Workers Paid plan and nothing else, and the free plan
(100,000 DO requests/day, 13,000 GB-s/day, SQLite-backed DOs included) is enough
to build and test all of H0–H5 without paying anything.

Two properties are worth protecting because they are what make the promise
credible:

- **No world state is stored or served.** Storage cost does not grow with the
  size of the galaxy or the number of places visited. It grows only with
  mutations, which are deliberate player acts.
- **Empty and idle are free.** Most of the galaxy is empty at any moment, and
  hibernation extends "free" to cover connected-but-not-flying. Neither covers
  connected-and-flying — see below.

Both are consequences of decisions already made, not of anything on this page.
The job here is to avoid spending them.

### What "busy" means, precisely

"Busy" was doing too much work in an earlier draft of this page. The billable
state has an exact definition and it is not "has players in it":

> A partition is **awake** for any wall-clock second in which it has received an
> event — a message, an alarm, a request — recently enough not to have been
> evicted. Duration bills per **awake object-second**, at 128 MB.

The consequence that changes every number below: **duration is charged per
object, not per player.** Cloudflare bills wall-clock time that is "shared
across all requests active on an Object at once". A partition with fifty players
in it costs exactly the same duration as a partition with one. Only _requests_
scale with players, and only inbound ones, at 20:1.

So the cost of a persistent universe is not driven by how many players are
online. It is driven by **how spread out they are.**

### Tall and wide: 500 concurrent players, two ways

Both scenarios below assume 500 players online continuously for a 30-day month —
which nobody ever is, so treat these as ceilings rather than forecasts — each
sending intent at 10 Hz. The only thing that differs is their distribution.

**Constants.** An always-awake partition costs
`2,592,000 s × 0.128 GB = 331,776 GB-s` per month, or **$4.15** at $12.50/M
GB-s. The Paid plan includes 400,000 GB-s, so the allowance covers roughly _one
and a fifth_ always-awake partitions.

#### Tall — all 500 in one system

| Component          | Working                                                      | Monthly  |
| ------------------ | ------------------------------------------------------------ | -------- |
| Awake objects      | 1                                                            |          |
| Duration           | 331,776 GB-s, inside the 400,000 allowance                   | **$0**   |
| Inbound requests   | 500 × 10 Hz = 5,000 msg/s ÷ 20 = 250 billable/s → 648M/month | ~$97     |
| Outbound broadcast | Not billed                                                   | $0       |
| **Total**          | **$0.19 per player per month**                               | **~$97** |

**This case is throughput-bound, not cost-bound.** 5,000 inbound messages/s is
five times the ~1,000 requests/second soft ceiling for a single object, and the
naive fan-out — every input echoed to every other player — is 2.5M outbound
messages/s, which is free to bill and impossible to execute. The levers are
aggregation (one snapshot per tick carrying every entity, not one message per
input) and interest management (replicate only what is near you). With both,
the honest expectation is **order 100–200 concurrent players in one partition**,
and that number wants measuring at H4, not modeling here.

#### Wide — 500 players in 500 different systems

| Component        | Working                                                        | Monthly     |
| ---------------- | -------------------------------------------------------------- | ----------- |
| Awake objects    | 500                                                            |             |
| Duration         | 500 × 331,776 = 165.9M GB-s, less the allowance, at $12.50/M   | **~$2,069** |
| Inbound requests | Identical total message rate — distribution does not change it | ~$97        |
| **Total**        | **$4.33 per player per month**                                 | **~$2,166** |

Same 500 players. **Twenty-two times the cost**, and every object is idling at
10 requests/second — 1% of what it could handle. Nothing is working hard; you
are simply paying rent on 500 mostly-empty rooms.

That is the real ceiling, and it is the one worth designing away.

### H-6 · An authority streams only when it has someone to replicate to

The wide case is expensive for a silly reason: **a solo player in an empty system
is paying for an authority that has nothing to tell them.** There is no second
client, so there is nothing to replicate — which is this page's
[one idea](#the-one-idea) applied to itself.

The rule that follows:

> A partition streams when it holds **two or more** players. With one, it tells
> the client so, the client falls back to `LocalAuthority`, and the object
> hibernates behind a 30-second heartbeat.

A solo occupant then costs about what an empty partition costs — roughly 550
GB-s and 4,300 billable requests per month, which rounds to zero — and the wide
scenario above collapses from $2,166 to inside the free allowance. Mutation
writes do not need the socket either; they are an HTTP `POST` to the API, which
is what makes the fallback complete rather than degraded.

Two things recommend this beyond the money. It needs no new infrastructure — the
heartbeat is the hibernation mechanism working as designed. And it means the
single-player path is exercised continuously in production by every player who
is alone, which is the surest way to keep `LocalAuthority` from rotting into a
stub. [Offline-first is the requirement](design/modes.md), so the local
implementation is the one that must always work.

### The realistic middle

Neither ceiling is a forecast. A plausible shape at 500 peak concurrent — 300
players alone in their own systems, 200 clustered into fifteen popular ones,
under H-6:

| Component                                | Monthly  |
| ---------------------------------------- | -------- |
| Duration — 15 awake objects              | ~$57     |
| Requests — only the 200 clustered stream | ~$39     |
| **Total, at sustained peak**             | **~$96** |

Real average concurrency is a fraction of peak, so the lived number is plausibly
$25–40/month for a 500-player peak. That is a donations-scale bill, and it stays
that way because of H-6 rather than by luck.

**What to instrument at H4**, since all six of these numbers are arithmetic
rather than measurement: awake object-seconds, inbound messages per player per
second, and the distribution of players across partitions. The third one is the
cost driver and it is the one nobody would think to log.

---

## Open questions

Named rather than answered, because guessing at them in a document is how a
guess becomes a citation.

| Question                                                                              | How it gets settled                                                                                               |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Is `PARTITION_ENTRY_RADIUS` (4e12 m) right?                                           | Measure at H4 with real latency and two real clients. ADR-0008 already calls it a guess.                          |
| What does handoff between partitions look like when a ship leaves Sol?                | The frame-transition machinery is the natural home; it already does the local equivalent.                         |
| Does a player need an account at all, or is a device-scoped token enough for the MVP? | H5. Discovery credit is the first thing that needs attributable identity.                                         |
| Where does the client's authoritative-vs-predicted split live?                        | Needs the input log first — [replay](roadmap.md#replay-and-reconciliation).                                       |
| Does the DO ever _simulate_, or only relay and persist?                               | **The load-bearing one.** H4 relays. Everything cheap about this plan depends on it staying that way — see below. |
| Does a busy system need a region-sharded partition key?                               | Only if contested gameplay arrives. Decide before the key grammar hardens.                                        |
| How many concurrent players actually fit in one partition?                            | Measure at H4. The arithmetic says 100–200 against a ~1,000 req/s ceiling, and arithmetic is not a measurement.   |
| What happens to a client whose `GENERATION_VERSIONS` are older than the partition's?  | Refused with a reason, per H-5 — but "what the player sees" is a UX question, not solved.                         |

### The one that decides whether any of this is cheap

Everything on this page is feasible at a hobby project's budget and a single
maintainer's time **because the server never simulates**. A relay that holds
entity states and arbitrates mutation writes is a well-understood, boring thing
that Cloudflare's primitives fit exactly. An authoritative simulation server with
client prediction, reconciliation, lag compensation and partition handoff of live
authority is a different project, with a different cost curve and a different
skill requirement.

The design has already decided in favor of the cheap one, and for a good reason
rather than a budgetary one: [modes](design/modes.md) observes that _the universe
is derivable, so a client knows everything anyway — there are no secrets to
protect. What must be authoritative is mutation writes._ That is a genuinely
coherent position, not a compromise, and it is what makes a Durable Object the
right tool instead of a load-bearing approximation of a game server.

**If that decision ever reverses, this document does not survive it.** Re-derive
the hosting plan from scratch at that point rather than extending this one.

---

## Related

- [ADR-0008](adr/0008-multiplayer-partitions.md) — the partition topology this implements
- [ADR-0007](adr/0007-persistence.md) — why the replication set and the save set are the same set
- [modes](design/modes.md) — what solo offline, solo online and the persistent universe each owe the player
- [sustainability](design/sustainability.md#the-hosting-question) — the promise this has to keep
- [roadmap](roadmap.md#multiplayer) — the engineering gap list, unchanged by this page
- [architecture](architecture.md) — the layering that keeps the vendor at the edge
