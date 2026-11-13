# FPV Sim

A physically based FPV quadcopter simulator that runs in the browser. It exists for one
purpose: to let you build real stick skills without breaking a real quad. Nothing in the
flight behaviour is scripted or "tuned for fun" - the quad is a rigid body driven by four
simulated motors and propellers, a battery, the air around it and a Betaflight-style flight
controller, and everything it does falls out of that.

## Run it

Requires Node.js 20.19+ (or 22.12+) and a browser with WebGL 2 (any current Chrome, Edge, Firefox or Safari).

```bash
npm install
npm run dev        # development server on http://localhost:5173
# or
npm start          # production build + local server, opens the browser
```

Other commands:

| command | what it does |
| --- | --- |
| `npm test` | physics test suite (61 tests, a few seconds) |
| `npm run bench` | prints the performance figures the model produces for each airframe |
| `npm run dynamics` | prints behaviour in telling manoeuvres (flip, prop wash, turtle, endurance) |
| `npm run build` | type-check and build to `dist/` (static files, host anywhere) |

## Controls

**Use a real transmitter if you have one.** Put an EdgeTX / OpenTX radio in "USB Joystick
(HID)" mode, plug it in, move a stick so the browser notices it, then open
*Menu → Controller*. Channels 1-4 are assumed to be AETR; if yours differ, press *Detect* next
to a channel and move that stick. The same panel assigns the arm switch, calibrates stick range
and shows the raw axes. Settings are stored per device.

A gamepad works too (Mode 2: left stick throttle/yaw, right stick pitch/roll, A = arm,
B = reset, X = flight mode, Y = camera). Because a gamepad's throttle stick springs back to the
middle, the middle is 0 % throttle by default; you can change that in the Controller panel.

Keyboard, good enough for a first look:

| key | action |
| --- | --- |
| `Space` | arm / disarm |
| `W` / `S` | throttle up / down (stays where you leave it; `Shift` = faster) |
| `X` | throttle to zero |
| `A` / `D` | yaw |
| arrow keys | pitch and roll |
| `R` | reset to the start location |
| `M` | flight mode: Angle → Horizon → Acro |
| `C` | camera: FPV → line of sight → chase |
| `T` | turtle mode (flip over after a crash) |
| `[` / `]` | slow motion / faster |
| `H`, `Tab` | toggle OSD / physics telemetry |
| `Esc`, `P` | menu / pause |

Arming is refused, as on a real flight controller, when the throttle is not at zero or the quad
is not roughly level (use turtle mode, or reset).

## What you can practise

- **Angle, Horizon and Acro** modes. Acro (rate mode) is the real thing; Angle is there so the
  first hour is not just crashing.
- **Three views**: FPV camera with adjustable uptilt, field of view and lens distortion; line of
  sight from where the pilot stands; chase camera.
- **Four airframes**: a 600 g 5" freestyle quad on 6S, the same quad carrying an action camera,
  a 5" racer, and a gentle 190 g 3" on 4S.
- **A flying field** with a nine-gate race circuit and lap timer, a football pitch with goals, a
  derelict three-storey concrete frame, a container yard with a tunnel, an open barn, silos, a
  mast and trees. Six start locations.
- **Weather**: wind speed and direction, turbulence, temperature and field elevation.
- **Training aids**: slow motion, throttle limit, crash damage on/off, stick monitor, live
  physics telemetry.
- **Betaflight "Actual" rates** with the usual three numbers per axis - copy them from your quad.

## The physics

All of it is in `src/sim/` (about 2,800 lines, no dependencies, runs in Node for testing).
State is integrated at **4 kHz**, the same rate as the simulated PID loop.

### Rigid body

Six degrees of freedom, Newton-Euler in the body frame:

```
m dv/dt = R(q) F_body + F_contact + m g
I dω/dt = τ − ω × (I ω + h_rotors)
```

Mass, centre of gravity and the inertia tensor are computed from a component list (motors,
props, arms, plates, stack, camera, battery...) with the parallel-axis theorem, so adding an
action camera really does move the CG and change how the quad rotates. `h_rotors` is the
angular momentum of the four spinning rotors, which gives gyroscopic coupling. Attitude is a
quaternion advanced with the exact exponential map.

### Propellers

Blade-element / momentum theory for a rotor in arbitrary flow:

```
C_T = (σ a / 6) [ θ (1 + 3/2 μ²) − 3/2 λ ]                thrust, blade element
T   = 2 ρ A v_i sqrt(V_p² + (V_c + v_i)²)                  thrust, momentum (Glauert)
C_Q = C_T (κ λ_i + λ_c) + σ c_d / 8 (1 + 4.6 μ²)           shaft torque
```

with inflow ratio `λ = (V_c + v_i)/(ΩR)` and advance ratio `μ = V_p/(ΩR)`, computed from the
velocity of each rotor hub through the air (so rotation of the airframe changes each rotor's
inflow - that is where most rate damping comes from). The induced velocity `v_i` is a dynamic
state. From these equations, without special cases, you get:

- thrust that falls off with airspeed along the thrust axis and vanishes near pitch speed;
  props that unload and windmill in a dive
- translational lift: the quad balloons when you level out at speed
- rotor drag proportional to speed (H-force) and a pitch-up tendency in forward flight
- ground effect (image-rotor model including neighbouring rotors) within a couple of prop diameters
- **prop wash**: descending into your own wake at roughly 0.4-1.6 × the hover induced velocity
  puts the rotors in the vortex ring state, where momentum theory breaks down. The empirical
  induced-velocity fit of Leishman is used there, with unsteady thrust loss; the flight
  controller has to fight it and you see and hear the wobble
- blade stall, reversed rotation (turtle mode), and plate drag on stopped or idling props in a fall

### Motors, ESCs and battery

Each motor is a brushless DC machine, the steady-state equivalent of the phasor model
`V = E + (R + jX) I` for an ESC with fixed commutation timing:

```
I = (duty · V_bus − K_e Ω) / Z        Z = R + X² / R,  X = L_eff Ω
τ = K_t I − τ_loss(Ω)                 P_bus = K_e Ω I + Z I²   (= duty · V_bus · I)
```

The reactive part of the phase current makes no torque but still heats the windings, which is
why a loaded motor reaches only about two thirds of KV × V and is about 65 % efficient there.
Electrical power in always equals shaft work plus heat (this is tested). Iron, bearing and ESC
switching losses are included; drive current is limited; braking is active - a motor commanded
below its speed is slowed by its own back-EMF, burning the energy in the windings and returning
only `duty · V · I` to the pack. Rotor inertia sets the spin-up time, and **yaw comes from the
real torque reaction** between stator and rotor.

The battery is a LiPo discharge curve behind an ohmic resistance and one RC polarisation
branch. All four ESCs draw from the same bus, whose voltage is solved implicitly every step, so
a punch-out sags the pack, the sag costs you top-end rpm, and the pack gets weaker as it
empties.

### Air

Airframe drag is quadratic and anisotropic (different areas from the front, side and top), applied
at a centre of pressure above the CG. Air density follows temperature and field elevation. Wind
follows the logarithmic boundary-layer profile and carries Dryden turbulence (MIL-F-8785C
low-altitude intensities and length scales).

### Flight controller

A compact re-implementation of what shapes the feel of Betaflight: RC smoothing, "Actual"
rates, gyro noise and low-pass filters, PID with feed-forward, I-term relax, D on measurement
and TPA, the Quad-X air-mode mixer, motor idle, angle/horizon levelling, arming checks and
crash-flip. **Gains use Betaflight's numeric scaling, and Betaflight's default gains fly this
model well** - which is itself a check that the simulated airframe responds like a real one.

### Contact

The airframe is seven spheres against a heightfield and analytic boxes, cylinders and spheres.
Contact is a stiff spring and damper with Coulomb friction. Each contact's damper is sized for
the effective mass it actually sees (so landing on one arm and sitting flat on the pad are both
handled correctly, for every airframe size) and landings are nearly dead, like a carbon frame on
turf; friction can stop a slide but never reverse it. A spinning prop that touches something
from the side or from above is braked hard (which yaws the quad) and, above 3.5 m/s closing
speed, chipped: that corner then makes less thrust for the rest of the flight. Hitting something
solid at more than 9 m/s (32 km/h) breaks the quad. Foliage is soft. Damage can be switched off.

### How it compares with reality

`npm run bench` output for the 5" freestyle preset (2207 1750KV, 5.1x3.6x3, 6S 1300 mAh, 603 g):

| | simulated | typical real-world figure |
| --- | --- | --- |
| static thrust per motor at 24 V, 100 % | 1639 g at 28,000 rpm, 40 A, 963 W | 1.55-1.7 kg, 27-29k rpm, 38-42 A |
| same at 50 % | 630 g, 8.3 A | ~600 g, 8-10 A |
| loaded rpm / (KV × V) | 0.67 | 0.65-0.70 |
| hover | 17 % throttle, 4.9 A, 123 W | 15-20 %, 5-7 A |
| punch-out | 7.9 g peak, pack sags 25.0 → 20.1 V | 6S packs sag to 3.3-3.6 V/cell |
| level top speed | 149 km/h | 140-165 km/h |
| roll rate step, 90 % | 26 ms, 0.4 % overshoot | 20-40 ms on a tuned quad |
| hard cruising (118 km/h) | 35 A, low-voltage warning after 2.3 min | 2-3 min packs when flown hard |

The right-hand column is the approximate range usually quoted for this class of hardware
(manufacturer thrust-stand tables, Betaflight blackbox logs). They are reference values from
general knowledge of such data, not measurements made for this project. The propeller and motor
constants were calibrated against the first three rows; the remaining rows are predictions of
the model.

The test suite (`tests/physics.test.ts`) checks the model against analytic results where they
exist - momentum theory at hover, Glauert's forward-flight solution, free-fall and terminal
velocity, conservation of angular momentum (airframe alone, and airframe plus spinning rotors)
and of energy in torque-free tumbling, the electrical power balance of the motor, ISA density,
Dryden gust statistics, coulomb counting, sliding distance under friction - and against expected
behaviour elsewhere: stick directions, rate tracking, self-levelling, prop wash, resting and
landing without gaining energy, collisions, lap timing, turtle mode, a five-minute random-input
soak.

The physics core was also given an independent code review once the simulator was flying. It
confirmed the rigid-body equations, rotor and motor formulas, the bus-voltage solver, the flight
controller signs and scalings and the collision geometry, and found four real defects, all since
fixed and covered by tests: contact damping that was unstable for the lightest airframe, impacts
that went undetected when a part was already touching the ground, a step in induced velocity
between climb and descent, and a motor energy balance that returned too much current to the pack
on a throttle chop.

## Decisions and assumptions

You asked for no questions, so these are the choices I made:

- **Browser app (TypeScript, three.js, Vite).** Nothing to install beyond Node, works on any OS,
  and the Gamepad API reads USB radios directly. The physics is plain TypeScript with no
  dependencies and is fast (about 0.6 µs per 4 kHz step, 400× real time).
- **Betaflight-style firmware.** It is what the vast majority of FPV quads run, so rates, modes,
  arming behaviour and OSD look like what you will have on the real quad.
- **Default aircraft is a 5" 6S freestyle quad** - the most common first "real" FPV quad. It is
  honest about how powerful that is: hover is at 17 % throttle. Use *Rates & throttle → Throttle
  limit* or the 3" airframe to start gently.
- **Default mode is Angle** and the default view is FPV, with a suggested learning path in
  *Menu → Help*.
- **All assets are procedural** (terrain, textures, trees, the drone model, sound). The repo
  contains no binary files and the app works offline.
- **Static, baked sun shadows** (plus baked ambient occlusion) for the scenery, and a projected
  contact shadow for the quad. This keeps the frame rate high, which matters more for flying
  than dynamic shadows do.
- **Line-of-sight view narrows as the quad flies away.** A monitor cannot match the eye's
  acuity; without this the quad is a single pixel at 80 m, which is not what you see outdoors.
- **Units**: metric throughout; speed on the OSD in km/h.

## Known limitations

Being accurate also means being clear about what is not modelled:

- Rotor aerodynamics use one representative blade section per rotor (no radial integration, no
  Reynolds or Mach dependence) and there is no interference between rotors or between rotors
  and the frame. The vortex-ring model is statistical: it reproduces the thrust loss and the
  wobble, not the actual wake. Flying back through turbulent air you left behind a moment ago is
  not modelled.
- No wind shadow or rotor/turbulence behind obstacles; no wall or ceiling effect, only ground effect.
- The attitude estimate used by Angle/Horizon mode is ideal (no accelerometer drift); the gyro
  has noise but no bias, and frame resonances are not modelled.
- Motor and battery temperatures are not modelled, so nothing overheats and a cold pack
  performs like a warm one.
- Damage is simplified to "props chipped" and "broken". Real crashes are more creative.
- There is no radio-link or video-link model: no latency, break-up or failsafe.
- Collision shapes are spheres on the airframe and primitives in the world; foliage is a soft
  ball, not branches.
- Touch screens are not supported.

## Project layout

```
src/sim/          physics core (no rendering dependencies)
  math.ts         vectors, quaternions, frames and conventions
  params.ts       airframe definitions, mass properties
  rotor.ts        propeller aerodynamics and motor model
  battery.ts      LiPo model
  environment.ts  atmosphere, wind, turbulence
  drone.ts        rigid body, electrical bus, contacts
  fc.ts           flight controller
  world.ts        collision world
  simulation.ts   fixed-step loop, crash logic, lap timing
src/world/map.ts  the flying site: one description for physics and rendering
src/render/       three.js scene, procedural textures, drone model, lens pass
src/input/        gamepad / radio / keyboard
src/audio/        motor sound synthesis
src/ui/           OSD, menu, settings
tests/            physics test suite
tools/            bench and diagnostics; headless-browser checks used during development
```

`tools/shot.mjs` and `tools/padtest.mjs` drive the built app in headless Chrome (screenshots; an
emulated radio through the Gamepad API). They need a local Chrome and `npm run preview` running,
and are not needed to use the simulator.
