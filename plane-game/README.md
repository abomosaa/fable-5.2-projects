# SKYWARD — a physically based flight simulator for the browser

Fly four very different aircraft over an 80 km procedural island with mountains, farmland,
forests, towns, sea, weather, day and night, and five airports with lit runways, PAPI and ILS.
Take off, navigate, fly aerobatics, go supersonic, shoot an ILS approach at night or put the
trainer down on a 760 m mountain strip — every touchdown is measured and graded.

## Start

```
npm start
```

Then open the printed address (http://localhost:8080; if that port is busy the next free one is
used and printed) in a recent desktop browser (Chrome, Edge or Firefox with WebGL 2). There is
nothing to install or build: the server is a tiny zero-dependency Node script (Node 18+) and
three.js is vendored. `PORT=9000 npm start` forces a port.

## Aircraft

| | Type | Character |
|---|---|---|
| **Kestrel 180** | high-wing piston trainer, fixed-pitch prop | docile, mushy stall, 48 kt on final |
| **Vortex 330** | unlimited aerobatic taildragger, constant-speed prop | 400°/s roll, ±10 g, torque and P-factor you can feel |
| **F-21 Peregrine** | afterburning fly-by-wire fighter | g-command law with alpha limiter, Mach 2 at altitude |
| **Meridian 320** | twin-jet airliner | 63 t of inertia, slow spool-up, ground spoilers and thrust reversers |

## Controls

| Key | Action |
|---|---|
| `W` `S` / `↑` `↓` | pitch (S / ↓ pulls) |
| `A` `D` / `←` `→` | roll |
| `Q` `E` | rudder / nose-wheel steering |
| `R` `F` or `PgUp` `PgDn` | throttle · `9` full · `0` idle |
| `.` `,` | pitch trim |
| `V` / `Shift+V` (or `]` `[`) | flaps down / up |
| `G` | landing gear |
| `Space` / `B` | wheel brakes / parking brake |
| `X` / `T` | speed brakes / thrust reversers |
| `I` | engine start / stop |
| `Z` / `U` | autopilot (heading + altitude, arrows adjust) / autothrottle (R F adjust) |
| `N` `M` `L` `O` | nav target · map range · landing lights · smoke |
| `C`, `1`–`5` | cameras: chase, cockpit, orbit, fly-by, tower · mouse drag looks, wheel zooms |
| `Y` | mouse yoke (pointer lock) |
| `H` `J` `P` `Esc` `/` | HUD · analog panel ↔ head-up symbols · pause · menu · help |

Gamepads work through the Gamepad API (left stick pitch/roll, right stick rudder/throttle,
triggers throttle, A brakes, B gear, X/Y flaps).

## What is simulated

**Flight dynamics** — a 6-DOF rigid body integrated at 300 Hz. Every wing, stabiliser and fin
is cut into spanwise strips; each strip computes its own local airflow (aircraft motion,
rotation, propeller slipstream and swirl, wing downwash with transport delay, gusts) and its
own lift, drag and pitching moment from a full ±180° section model with dynamic flow
separation. Roll damping, adverse yaw, dihedral effect, stalls, wing drop, spins and control
authority in the propwash all emerge from that instead of being scripted.

- International Standard Atmosphere (density, pressure, temperature, speed of sound),
  indicated / calibrated / true airspeed and Mach number
- compressibility: lift-slope change with Mach, wave drag, supersonic centre-of-pressure shift
- ground effect, flaps, spoilers, speed brakes, landing-gear drag
- piston engine with torque curve, friction, altitude lapse and fuel burn, driving a propeller
  whose thrust and torque come from blade-element/momentum theory (fixed pitch or
  constant-speed governor), including windmilling, torque reaction, P-factor, gyroscopic
  precession and spiralling slipstream
- turbofans with spool dynamics, thrust lapse with altitude and Mach, afterburner, reversers
- oleo struts with tyre "brush" friction: static friction, cornering stiffness, friction circle,
  brakes, nose/tail-wheel steering; tail strikes, prop strikes, belly landings, hard landings
- mechanical flight controls with hinge-moment limits, or fly-by-wire (load-factor command,
  angle-of-attack and bank protection, auto-trim) for the jets; autopilot and autothrottle
- wind with boundary-layer profile, Dryden-like turbulence, ridge lift on windward slopes
- structural limits: over-g and flutter beyond Vne break the airframe

`node test/trainer.mjs` (and `aerobat`, `fighter`, `airliner`) run the flight model headless
and print stall speeds, climb rates, top speeds, roll rates and stability modes.

**World** — chunked level-of-detail terrain meshed in web workers from one height function that
the physics shares; forests, fields, beaches and snow; an analytic atmosphere with aerial
perspective; sun, moon, stars; drifting cumulus with ground shadows, overcast decks, fog, rain;
airports with markings, taxiways, buildings, windsocks, approach lights, PAPI and ILS guidance;
a city and a dozen villages that light up at night.

**Sound** is synthesised live with the Web Audio API (engine harmonics, turbine whine,
afterburner, airflow, tyres, gear, warnings, radio-altitude call-outs).

## Tips

- Release the parking brake (`B`) before adding power.
- Rotate a few knots above the top of the amber stall band on the speed tape, and ease the stick
  back gently — haul on it and the tail will hit the runway.
- On approach, two red and two white PAPI lights mean you are on the 3° glide path. With an ILS
  runway selected (`N`) the magenta diamonds show localiser and glide-slope deviation.
- Three assists are on by default for keyboard pilots — auto-rudder, auto-trim and bank hold.
  Turn them off in Settings for the unfiltered aircraft: you will then need your feet on
  take-off in the Vortex and a little aileron against its engine torque.
