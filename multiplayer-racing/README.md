# Apex Drift

A 3D online multiplayer racing game for desktop browsers, with publicly
discoverable rooms and an **authoritative WebSocket server**.

- Real networked multiplayer: the server simulates every car at a fixed 60 Hz;
  browsers only send steering/throttle inputs and draw what the server says.
- Public room browser, quick join, private rooms, invite links and codes,
  spectators, ready-up lobby, host settings, chat, synchronised race start.
- Two complete tracks that look and drive differently: **Harbor Circuit**
  (wide, grippy asphalt, grass run-off) and **Glacier Pass** (narrow, icy
  switchbacks between snow banks).
- Server-controlled practice bots (easy / medium / hard), so one person can
  play and evaluate everything alone.
- Client-side prediction with server reconciliation, interpolated remote cars,
  delta-compressed snapshots, reconnect with a rotating credential.
- No assets to license: models, textures and sound are generated in code.

```
npm install
npm run dev          # then open http://localhost:5173
```

---

## Contents

1. [Play locally](#play-locally)
2. [Controls](#controls)
3. [How a race works](#how-a-race-works)
4. [Public rooms](#public-rooms)
5. [Architecture](#architecture)
6. [Networking model](#networking-model)
7. [Security and operations](#security-and-operations)
8. [Configuration](#configuration)
9. [Deployment](#deployment)
10. [Testing](#testing)
11. [Network simulation](#network-simulation)
12. [Assumptions and limitations](#assumptions-and-limitations)

---

## Play locally

Requires Node.js 22.12 or newer.

| Goal | Command | Open |
| --- | --- | --- |
| Develop (hot reload) | `npm run dev` | http://localhost:5173 |
| Play the production build | `npm run play` | http://localhost:8080 |

`npm run dev` is the one command that starts the complete system: the game
server on port 8080 (restarting on change) and the Vite dev server on port
5173, which proxies `/ws` and `/config.json` to the game server.

`npm run play` builds the client and server (`npm run build`) and starts the
single production process (`npm start`), which serves the client, the
WebSocket endpoint and the health endpoints from one port.

Ports can be changed: `PORT=9000 CLIENT_PORT=5180 npm run dev`.

### Playing alone

Click **Quick race** (or **Create room**), then **Start race**. The room is
filled with practice bots; their number and difficulty are room settings.

### Opening multiple clients

Every browser tab is an independent player with its own connection and
identity (the reconnect credential lives in per-tab `sessionStorage`).

1. Tab A: **Create room** (leave "Public room" ticked).
2. Tab B (or another browser / machine): **Browse rooms**, find the room and
   press **Join** - or paste the invite link / type the room code.
3. Tab B presses **Ready up**; tab A (the host) presses **Start race**.

To play across machines on a LAN, bind to all interfaces:
`HOST=0.0.0.0 npm run play`, then open `http://<your-ip>:8080` on the others.

Keyboard focus follows the active tab, so to "drive" two tabs at once for a
quick test you can let a bot driver steer one of them from the dev console:
`__apex.autopilot(true)` (it only produces ordinary inputs; see
[Testing](#testing)).

---

## Controls

| Action | Keyboard | Gamepad (standard mapping) |
| --- | --- | --- |
| Accelerate | `W` / `Up` | Right trigger |
| Brake, then reverse | `S` / `Down` | Left trigger |
| Steer | `A` `D` / `Left` `Right` | Left stick or D-pad |
| Handbrake (start a drift) | `Space` | A |
| Reset to last checkpoint | `R` | Y |
| Change camera | `C` | X |
| Menu | `Esc` | Start |
| Spectating: switch car | steer keys | - |

Everything is remappable under **Settings -> Controls** (two keys per action,
gamepad buttons, stick dead zone). Settings also has volume sliders and mute,
camera choice (chase, far chase, hood, top-down), graphics quality, speed
unit, name tags and **Reduced motion** (no camera shake, speed zoom, flashes
or fast particles; it defaults to your OS preference).

Accessibility: indicators never rely on colour alone. Cars carry numbers on
the roof, name tag, leaderboard and minimap (bots are squares, humans discs,
your car an arrow); warnings have icons and text; timing deltas show sign and
arrow; start lights show a count as well as red/green; the paint palette is
colour-blind safe (Okabe-Ito).

---

## How a race works

- **Grid and start.** Cars line up on a fixed two-column grid in a shuffled
  order. A countdown holds every car; all are released on the same server
  tick.
- **Checkpoints.** Each track has ordered gates across the road (10 on Harbor,
  12 on Glacier); gate 0 is the start/finish line. A gate only counts when it
  is the next one due *and* is crossed in the driving direction. Skipping a
  gate shows "Missed checkpoint - go back" and the lap cannot complete until
  you do. Crossing the line backwards and forwards does nothing.
- **Laps and timing.** Laps are timed line to line with sub-tick precision;
  total race time runs from the green light. The HUD shows current, last and
  best lap, a split delta against your best lap at every checkpoint, and the
  time gap to the cars ahead and behind (measured at the last checkpoint both
  passed).
- **Finish.** Finishing order is the order of crossing the line (by exact
  crossing time, even within one tick). Once the first car finishes, everyone
  else has 60 s. The race ends early when every human has finished; cars still
  running are classified by distance behind the finishers.
- **Penalties.** Staying fully off the road for 2.5 s cuts engine power to 40%
  for 2 s (and the grass itself is slow). **Reset to track** puts you back at
  your last checkpoint at a standstill and holds you for 1.5 s.
- **Driving.** A single-track vehicle model with saturating tyres: grip is
  shared between cornering, traction and braking; the handbrake breaks rear
  traction to start a drift and counter-steering catches it; ice has roughly
  half the grip of asphalt, so braking distances double and the car slides and
  spins its wheels. Barriers are solid: glancing hits scrub speed and turn the
  car along the wall.

---

## Public rooms

A room is public by default. Public rooms appear in the **room browser of
every client connected to the deployment**: the list is kept by the server and
pushed live to subscribed browsers (it is not local state). Each card shows
name, host, track, laps, drivers/seats, bots, spectators, state (open lobby /
racing / results / full), region (if `REGION` is configured) and your measured
latency to the server hosting it. The browser has search, track and state
filters, "hide full rooms" and a manual refresh.

- **Quick race** joins the fullest open public lobby, or creates a public room
  with bots if there is none.
- **Invite link / code.** Every room has a 5-character code and a link
  (`/?room=CODE`). Private rooms are joinable only that way.
- **Joining a race in progress** puts you in the room as a viewer; you get a
  seat on the grid of the next race.
- **Spectators** watch live with the same HUD and can switch between cars.
- **Host** powers are administrative only (settings, start, cancel, kick). If
  the host leaves or disconnects, the longest-standing connected member
  becomes host immediately.

---

## Architecture

```
shared/            Platform-independent code used by both sides (no DOM, no Node)
  constants.ts       Tick rate, limits, palette
  sim/               DETERMINISTIC SIMULATION AND RACE RULES
    track.ts           Track geometry, gates, grid, spatial index
    tracks/            Track definitions (harbor, glacier)
    vehicle.ts         Vehicle dynamics (stepCar) and wall collisions
    collision.ts       Car-to-car collisions
    race.ts            Countdown, checkpoints, laps, penalties, ranking, results
    bot.ts             Racing line, speed profile, bot driver
  protocol/          SHARED, VERSIONED PROTOCOL
    schema.ts          Runtime validator with static type inference
    messages.ts        JSON control messages (both directions), PROTOCOL_VERSION
    binary.ts          Binary input and snapshot codecs, delta encoding
    sanitize.ts        Sanitisation of user-controlled text
  net/netsim.ts      Latency / jitter / loss / duplication / reordering model

server/src/        AUTHORITATIVE SERVER
  main.ts            Process entry, signals
  app.ts             Wiring and the fixed-timestep loop
  config.ts          CONFIGURATION (environment variables, validated)
  transport/         SERVER TRANSPORT: HTTP endpoints, WebSocket handshake,
                     origin checks, heartbeats, the Connection abstraction
  lobby/             Room directory, admission, routing, rate limits (manager.ts);
                     membership, lobby rules and race lifecycle (room.ts)
  game/              Race session (inputs -> simulation -> snapshots), input queue
  security/          Token buckets, origin policy
  persistence/       PERSISTENCE: lap records store (memory or JSON file)

client/src/        BROWSER CLIENT
  net/               Connection, lobby client, prediction, interpolation
                     (DOM-free: the tests run this code headlessly)
  game/              CLIENT PRESENTATION: three.js renderer, track, cars, effects
  ui/                Menus, lobby, HUD, results, settings
  audio/ input/ storage/

tests/             Unit, netcode and real-socket integration tests (Vitest)
e2e/               Two-browser end-to-end tests (Playwright)
```

Boundaries are enforced by ESLint (`eslint.config.js`): `shared/` may not use
DOM, Node, the wall clock or `Math.random`; the client may not import server
code and vice versa; the client may not use `innerHTML`.

The simulation is a pure function of state and inputs. The server runs it for
every car; the client runs the *same* `stepCar` to predict its own car. Rooms
and the lobby are transport-agnostic (`Connection` + `Transport`), which is how
the tests drive them without sockets.

---

## Networking model

### Authority

The server owns room membership, the race lifecycle, the simulation, bots,
checkpoints, lap validation, penalties, timing and results. A client can only
send (a) lobby requests, validated against the room's state, and (b) input
commands. There is no message through which a client can state a position,
velocity, lap count or time: object schemas are strict (unknown fields are
rejected) and the only binary frame the server accepts is the input frame. The
host's browser is never authoritative.

### Protocol

One protocol, defined once in `shared/protocol`, versioned by
`PROTOCOL_VERSION`. The handshake (`hello` -> `welcome`) refuses mismatched
versions with a clear "reload to update" message. Both sides validate
everything they receive at runtime.

- **Control messages** are JSON, described by schemas from which the
  TypeScript types are inferred (`messages.ts`).
- **Realtime messages** are binary (`binary.ts`):

  | Frame | Direction | Contents |
  | --- | --- | --- |
  | `INPUT` | client -> server | race id, newest snapshot tick acknowledged, client timestamp (diagnostic only), first sequence number, up to 8 inputs of 4 bytes (steer, throttle, brake, flags) |
  | `SNAPSHOT` | server -> client | race id, tick, baseline tick, last input sequence simulated for the recipient, its input queue depth, race phase, green-light tick, per-car field groups |

### Simulation and inputs

- Fixed timestep: 60 simulation ticks per second, two physics sub-steps per
  tick. The loop catches up after hiccups by at most 8 ticks and then drops
  the backlog, so a stall slows the race instead of fast-forwarding it.
- Every input has a client-chosen **sequence number**. The server keeps a
  small per-player queue and consumes **exactly one input per tick**. Sending
  inputs faster gains nothing (extra ones queue, an overflowing queue is
  trimmed); duplicated, reordered and stale sequence numbers are ignored.
  When the queue runs dry the last input is held for 200 ms and then the car
  coasts, so jitter is hidden but a vanished client cannot hold the throttle.
- Each input message repeats the most recent unacknowledged inputs, so a lost
  or late message costs nothing.

### Prediction and reconciliation (your own car)

The client applies each input immediately with the shared `stepCar` and keeps
it until the server acknowledges it. Each snapshot carries the last sequence
number simulated; the client resets its car to the authoritative state and
replays the unacknowledged inputs. The remaining difference (quantisation, or
contact with a car that moved unexpectedly) is blended out over a few frames
instead of snapping; only real teleports (reset to track) snap. Contacts with
other cars are predicted against their dead-reckoned positions using the same
collision response as the server.

The client's tick rate is nudged by up to 5% to keep the server's queue about
two inputs deep. The start lights are shown on each driver's own (predicted)
timeline, so a high-ping driver sees green slightly earlier and their first
input reaches the server exactly as the race starts: ping does not cost you
the launch.

### Interpolation (everyone else)

Remote cars are drawn slightly in the past, between two snapshots (cubic
Hermite using the snapshot velocities). The delay adapts to measured jitter
(about 65 ms on a clean link, capped at 500 ms). If data stops, a car is
extrapolated for at most 200 ms, then held and marked stale; the backlog of a
stalled connection does not disturb the timeline.

### Snapshots and deltas

Snapshots are sent 30 times a second. Each is identified by its tick; clients
acknowledge the newest tick they decoded. The next snapshot is encoded as a
**delta against that acknowledged baseline**: per car, only the field groups
(pose, motion, controls, progress, timing) whose quantised values changed.
Because a delta is only ever made against a snapshot the client confirmed
having, losing, duplicating or reordering snapshots can never corrupt state.
A full snapshot is sent when there is no usable baseline (first snapshot,
reconnect, client asked), and those are rationed to 7.5 per second for a
client that is not acknowledging. Measured bandwidth with a full grid of 8
cars is about 6 kB/s down and 2 kB/s up per driver (0.3 kB/s up for a
spectator).

### Reconnecting

On joining a room the client receives a 192-bit random credential. If the
connection drops, the seat (and the car, which brakes to a stop) is held for
`RECONNECT_GRACE_S` (30 s). The client reconnects automatically with backoff
and presents the credential; the server restores the seat, sends the full room
and race state, and **rotates the credential**. Reloading the page resumes the
same way. After the grace period the seat and its car are removed.

---

## Security and operations

| Concern | Measure |
| --- | --- |
| Schema | Every JSON message is parsed by a strict schema; unknown types and unknown fields are rejected. Binary frames are length- and range-checked. |
| Size | WebSocket frames over 2 kB are refused by the transport (close code 1009). Strings have per-field limits. |
| Text | Names, room names and chat are NFKC-normalised, stripped of control, invisible, bidirectional and markup characters, collapsed and truncated - on both sides. The client only ever uses `textContent`. |
| Frequency | Token buckets per connection (messages, inputs, chat, renames, settings, pings, list requests) and per address (connections, room creation, joins). Sustained floods and repeated malformed messages disconnect the client; latency bursts do not. |
| Inputs | One input per tick is simulated; sequence numbers far in the future are rejected; inputs for another race are ignored. |
| Movement | Positions come only from the simulation. As defence in depth the race rules never credit a checkpoint for a displacement larger than a car could travel in a tick. |
| Origins | WebSocket handshakes are accepted from `PUBLIC_URL`, `ALLOWED_ORIGINS`, and same-origin pages. In production a missing `Origin` is refused. Everything else gets HTTP 403. |
| Capacity | Limits on total connections, connections per address, rooms and rooms per address. |
| Expiry | Sockets that never say hello (10 s) or go silent (30 s), disconnected seats (30 s), kick bans (2 min), idle lobbies (15 min), empty rooms (at once), rate-limit state (2 min idle), results screens (40 s). |
| HTTP | Only `GET`/`HEAD`; CSP, `nosniff`, frame denial and referrer policy on every response; static files cannot escape the build directory. |
| Faults | An exception in one race closes that room only. On `SIGTERM`/`SIGINT` clients are told, sockets are closed, records are flushed. |

Clocks: the server never interprets a client timestamp. Race time is counted
in server ticks.

---

## Configuration

All configuration is environment variables, validated at startup (an invalid
value stops the server with a clear message). See `.env.example` for the full
list. The important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables the strict defaults below |
| `HOST` | `127.0.0.1` (dev), `0.0.0.0` (production) | Interface to bind |
| `PORT` | `8080` | HTTP and WebSocket port |
| `PUBLIC_URL` | - | Public site URL; its origin may connect |
| `WS_PUBLIC_URL` | same origin, `/ws` | WebSocket URL given to browsers via `/config.json` |
| `ALLOWED_ORIGINS` | - | Extra allowed origins, comma separated |
| `ALLOW_MISSING_ORIGIN` | `true` (dev), `false` (production) | Allow non-browser clients |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Host` |
| `REGION` | - | Label shown on room cards |
| `DATA_DIR` | `./data` | Where lap records are stored |
| `RECONNECT_GRACE_S` | `30` | How long a dropped seat is held |
| `MAX_ROOMS`, `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP` | `100`, `500`, `16` | Capacity |

The browser resolves the WebSocket URL in this order: `?ws=` query parameter,
the server's `/config.json`, the build-time `VITE_WS_URL`, then same origin.

---

## Deployment

```
npm ci
npm run build                     # dist/client (static) + dist/server/main.js
NODE_ENV=production PUBLIC_URL=https://race.example.com npm start
```

One process serves the client, `/ws` and the probes. A `Dockerfile` is
included (`docker build -t apex-drift . && docker run -p 8080:8080 -e PUBLIC_URL=... apex-drift`).

**Health and readiness**

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | Liveness: `200 {"status":"ok"}` while the process responds |
| `GET /readyz` | Readiness: `200` when accepting players, `503` while starting or draining |
| `GET /api/status` | Version, protocol, uptime, connection/room counts |

**Behind TLS / a reverse proxy.** Terminate TLS at the proxy and forward both
HTTP and WebSocket upgrades to the game server. Set `PUBLIC_URL` to the public
https URL and `TRUST_PROXY=true` so rate limits see real client addresses.

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 75s;
}
```

Caddy: `race.example.com { reverse_proxy 127.0.0.1:8080 }`.

**Client on a CDN, server elsewhere.** Build the client with
`VITE_WS_URL=wss://game.example.com/ws npm run build:client`, host
`dist/client` anywhere, and start the server with
`ALLOWED_ORIGINS=https://www.example.com`.

**Scaling.** Rooms live in the memory of one process. Run one process per
region or shard and route by room; a restart ends the rooms on that process
(clients are told and return to the menu when it is back).

---

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, netcode and integration tests (about 215 tests, ~20 s) |
| `npm run test:unit` | Everything that needs no sockets |
| `npm run test:integration` | A real server on an ephemeral port with headless socket clients |
| `npm run test:e2e` | Builds, then two isolated Chromium contexts against the production server |
| `npm run typecheck` | `tsc` for shared, server, client and tests |
| `npm run lint` | ESLint, including the architecture boundary rules |
| `npm run check` | typecheck + lint + test + build |

Nothing needs an external service. The browser tests need Playwright's
Chromium (`npx playwright install chromium` once).

What is covered:

- `tests/sim` - vehicle dynamics (acceleration, braking, reverse, steering,
  grip per surface, drifting, drag, barriers), determinism, track geometry,
  checkpoint order, shortcut / reverse-line / teleport rejection, lap timing,
  penalties, resets, finish ordering, standings, and bots completing races.
- `tests/protocol` - every message accepted/rejected as intended, forged
  fields, bounds, sanitisation, binary codecs, delta round-trips, fuzzing.
- `tests/server` - handshake and version mismatch, public directory, joining,
  readiness, host departure, spectators, kicks, reconnect grace and expiry,
  cleanup of abandoned rooms and state, race lifecycle, rate limits, floods,
  oversized and malformed messages, stale and excessive inputs,
  client-reported results, origin policy, configuration, persistence.
- `tests/net` - prediction/reconciliation and interpolation with the **real
  server logic and real client netcode** joined by a deterministic virtual
  network: clean, laggy, jittery, lossy and messy (loss + duplication +
  reordering) links, stalled connections, a stalled server, a frozen client,
  bandwidth bounds, reconnecting mid-race.
- `tests/integration` - three independent socket clients create a public room,
  discover it, join, ready, start, race, drop, reconnect and finish; plus
  origin checks, frame limits, connection limits, shutdown and HTTP endpoints.
- `e2e` - two isolated browser contexts: one creates a public room, the other
  finds it in the room browser and joins, both enter the same synchronised
  race with distinct identities and see each other move; plus invite links,
  private rooms, reconnect and reload-resume, host hand-over, kick and error
  dialogs.

Debug hook (read-only state plus a few testing aids), available in the
browser console as `__apex`:

```js
__apex.state()                 // connection, room, race and car state
__apex.dropConnection()        // simulate a network drop (auto-reconnects)
__apex.setNetConditions('latency=120,jitter=40,loss=5')
__apex.autopilot(true)         // let a practice-bot driver produce your inputs
```

`npm run tracks -- out/` writes a geometry report and SVG preview per track,
useful when adding one.

---

## Network simulation

To see the netcode work under bad conditions without leaving your desk:

- **In the game:** Settings -> Network. Sliders for added latency (each way),
  jitter, packet loss, duplication and reordering, and a live statistics
  read-out (round trip, snapshot loss, pending inputs, server queue depth,
  interpolation delay, correction sizes, bytes in/out).
- **By URL:** `http://localhost:5173/?netsim=latency=120,jitter=40,loss=5,dup=2,reorder=3`
  (percentages for the last three).
- **In tests:** `tests/helpers/virtualNet.ts` runs server and clients on a
  virtual clock with per-link impairments; `tests/net/netcode.test.ts` shows
  how to script scenarios such as a three-second stall.

The simulator sits between the client and its socket and applies to that tab
only. Loss, duplication and reordering affect the realtime frames (inputs and
snapshots), which the protocol is designed to survive; control messages are
only delayed, as a real WebSocket never loses or reorders them.

The HUD shows connection health at all times: `Connected`, `Unstable
connection` (late or missing snapshots, high ping) or `Connection stalled` /
`Reconnecting`, with an audible cue when it degrades.

---

## Assumptions and limitations

- **Flat tracks.** Physics is 2D on the ground plane; the world is drawn in 3D.
- **Desktop first.** Keyboard and gamepad; no touch controls.
- **WebSocket transport.** It is reliable and ordered, but the realtime
  protocol does not depend on that (it is tested against loss, duplication
  and reordering), so it could move to WebTransport datagrams unchanged.
- **Cross-engine determinism** is not assumed for trigonometry: the server is
  authoritative and clients reconcile, so tiny floating-point differences
  between browsers are corrected invisibly.
- **In-memory rooms.** Only lap records persist. Records are best laps set by
  human players, from server timing.
- **Identity** is per connection; there are no accounts. Names are sanitised
  and made unique within a room; there is no profanity filter. Kicking bans
  the address from that room for two minutes.
- **Lap 1** is timed from the first crossing of the start line (a rolling
  start from the grid), like every other lap.
- **Finished cars** are driven round by an autopilot as non-colliding ghosts.
- **Latency on room cards** is your measured round trip to the server that
  hosts the rooms.
- **Bots** drive through the same inputs and physics as players and are
  simulated only on the server.
