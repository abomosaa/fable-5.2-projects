# Simulation: formulation, idealisations and limits

This document says what the simulation computes, how, and where it stops being
trustworthy. It is a design-exploration tool. **It is not certified
engineering analysis, structural FEA, or a manufacturing-safety check.**

## Scope

- **Planar rigid bodies.** Every moving rigid group has three coordinates
  (x, y of its centre of mass, rotation θ about Z). Parts are stacked in Z
  layers, which matters for interference and for drawing, not for dynamics:
  there is no out-of-plane motion, tilt, or bending moment about X/Y.
- **Internal units**: mm, kg, s, rad; forces in mN, torques in mN·mm, energy
  in µJ, power in µW (a consistent system — no hidden factors). Display units
  are converted in one place (`core/units.ts`).

## Two modes — kinematic relationships vs. force simulation

| | Kinematic mode | Dynamic mode |
|---|---|---|
| What moves the mechanism | motors are *prescribed joint coordinates* | forces: gravity, springs, loads, contact, friction, motors with torque limits |
| What is solved | positions: C(q, t) = 0 by Newton iteration each step; velocities from J·v = −∂C/∂t | equations of motion with constraints, fixed step |
| Masses, gravity, springs, floor, friction | ignored | used |
| Cam contact | assumed closed (follower always on the cam) | one-sided: the follower can lift off |
| Forces, torques, power, energies | **unavailable** (shown as such) | from constraint multipliers / force laws |

Gear meshes, rack-and-pinion and belts are *kinematic couplings in both modes*:
ideal rolling of pitch circles / an inextensible non-slipping belt on pitch
circles. There is no tooth-by-tooth contact, backlash dynamics, mesh stiffness,
belt stretch, slip or pre-tension. The drawn involute teeth and belt cleats
are positioned from the same constraint, so what you see is consistent with
what is solved, and the interference checker confirms correctly meshed teeth
do not overlap. Their reported "tooth force" / "belt pull" is the multiplier
of that ideal constraint (the tangential force at the pitch point), not a
contact stress.

## Dynamic solver

Fixed timestep h (default 1 ms). Per step:

1. **Forces** at the current state: gravity, linear spring-dampers
   F = k(L − L₀) + c·L̇, external loads. `v* = v + h·M⁻¹·f` (the very first
   step uses h/2 — velocities live at half steps, leap-frog style).
2. **Joints (bilateral constraints)** are imposed exactly: with Jacobian J and
   S = J·M⁻¹·Jᵀ, the multipliers μ solve `S·μ = −C/h − J·v*` by dense Cholesky
   (rows scaled to unit diagonal). Linearly dependent rows (redundant
   constraints, singular configurations) are detected by their pivot and get a
   zero multiplier instead of blowing up; they are reported.
3. **Bounded / one-sided rows** — floor contact normals (λ ≥ 0) with Coulomb
   friction (|λ_t| ≤ μ·λ_n), cam contact (λ ≥ 0), joint limits (λ ≥ 0),
   torque-limited motors (|τ| ≤ τ_max), Coulomb joint friction, viscous joint
   damping and DC-motor curves (rows with compliance) — form a small boxed
   complementarity problem on the exact Schur complement of step 2, solved by
   projected Gauss–Seidel with warm starting (≤ 300 iterations, tolerance
   1e-10). Joint constraints stay exact regardless of how well this converges.
4. **Positions** `q⁺ = q + h·v⁺`, then **projection back onto the joints**
   along M⁻¹Jᵀ (SHAKE; Ryckaert, Ciccotti & Berendsen 1977) to a tolerance of
   1e-7 mm / 1e-9 rad, with the correction fed back into the velocity. This
   makes the scheme second-order accurate and free of secular energy drift
   for conservative systems (measured: see VERIFICATION.md).
5. Remaining contact penetration is removed by a position-only correction
   (it adds no velocity, so resting contact does not bounce).

A run does not start at all from a design with an error-level diagnostic: open
joints, a roller buried in its cam, gears at the wrong centre distance or with
different modules, a pinion behind its rack, a joint whose part or anchor is
missing, a part that cannot be built as specified, a DC motor without stall
torque. Play is refused with the diagnosis — such a model would otherwise run
with a constraint dropped, which is exactly the kind of silent "fix" this tool
avoids.

A step whose projection does not converge is **not committed**. The state
stays at the last valid configuration, the run ends, and a diagnostic names
the joints that could not be closed (with a Grashof analysis when the failing
loop is a four-bar). Non-finite or absurd velocities end the run as
"diverged". Nothing is teleported and no constraint is silently dropped.

### What "the projection" does and does not hide

The per-step drift that the projection removes is recorded and can be plotted
(*Solver → Joint drift before projection*): typically 1e-4–1e-2 mm for
linkages at 1 ms (1.7e-4 mm for the four-bar showcase). After projection the joint error is ≤ 1e-7 mm; both numbers
are shown live in the status bar, Diagnostics and Performance panels.

## Idealisations you should know about

- **Joints are ideal**: no clearance, compliance or bearing friction unless
  you add Coulomb/viscous terms to a joint. Clearances affect *geometry* (and
  therefore exports and interference), not the dynamics.
- **Rigid joints merge parts** into one body; the internal force of a rigid
  attachment is not computed (shown as unavailable).
- **Contact** exists between moving parts and the floor (a horizontal plane)
  and between a cam and a roller. It is inelastic (no bounce) with a single
  friction coefficient (static = kinetic). Floor contact points are the round
  ends of links/wheels and the convex-hull corners of polygonal parts.
- **Part-to-part collisions are detected, not resolved.** Parts pass through
  each other; the interference checker reports the pair, the time, the
  overlap area and location (true profiles, with holes, for parts whose Z
  ranges overlap). Pins of pivot joints are drawn and listed in the BOM but
  are not collision bodies.
- **Cam contact** constrains the roller centre to stay outside the cam's pitch
  curve (the cam surface is exactly the inner offset of that curve by the
  roller radius, so this is the true roller–cam contact as long as the profile
  is not undercut; undercut is detected and reported). The roller is a
  frictionless circle fixed to the follower.
- **Motors**: *servo* holds the commanded speed up to the torque limit (with
  no limit it is a kinematic driver whose reported torque is the constraint
  torque — it will produce whatever torque the motion needs, including
  unrealistically large values near dead-centres); *DC* follows a linear
  torque–speed line τ = τ_stall·(1 − ω/ω₀). Two consequences of that line are
  worth knowing: the torque is **clipped at ±τ_stall**, so a DC motor driven
  backwards never resists with more than its stall torque (a real one produces
  more), and around its operating point the line acts like a viscous damper of
  τ_stall/ω₀ on the joint. A DC motor needs a finite stall torque; without one
  it is flagged as an error and left inactive. No electrical model, no rotor
  inertia, no gearbox losses.
- **Design-time assembly solving** moves parts as little as possible (mass-weighted)
  to close all joints, first with motorised joints held at their current
  angle; only if that is impossible are they released. Parts that no joint
  holds yet can be shifted or turned slightly by this (for example a free rack
  being brought into mesh with a pinion): mount them first if their exact pose
  matters.
- **Typed and keyed poses** (X / Y / Rotation fields, `Q` / `E`, arrow keys) mean
  "this part goes there" and are met exactly whenever the mechanism can follow
  (`applyPoseEdit` in `core/assembly/solve.ts`): the part, with whatever is
  rigidly fixed to it, is taken to the requested pose in small steps and the
  other parts follow through their joints, so a linkage stays on its current
  closure. Motors are held first and released only if needed; turning the
  driven side of a motor joint sets that motor's start angle and leaves the
  part carrying the motor where it is. A rotation that cannot be made about the
  part's own origin is made about its pivot. A jointed group that is not
  connected to ground at all moves as one rigid body. If the mechanism cannot
  follow, nothing is forced: either the edit is refused with a message and
  nothing changes (no undo step), or — when only another closure of the loop
  fits — the mechanism is re-posed, the message says where the part ended up,
  and it is one undo step. A result is only accepted if every joint is still
  closed once the temporary hold on the part is released.
- **Slides** fix the orientation of the sliding part relative to its guide (the
  angle stored when the joint was made), so turning a guide turns its slider.
- **Sketched parts** are cut exactly as dimensioned; no hole clearance is added
  to sketched circles (library parts add it automatically).
- **Springs** act along the line between their two anchors and work in both
  tension and compression; coils do not collide or buckle.
- **Reaction forces in over-constrained assemblies are not unique**; the
  diagnostics flag redundant constraints.

## Where each plotted number comes from

Every channel carries a provenance label in the plot legend and in the CSV:

| Label | Meaning |
|---|---|
| solver state | read directly from positions/velocities of the solver at each sample (positions, joint angles, velocities, gaps) |
| constraint multiplier | Lagrange multiplier of a joint/contact/motor row: impulse over one step ÷ step (reaction forces, motor torque, tooth force, contact force) |
| finite difference | central difference of the sampled solver velocity on the fixed sample grid, one-sided at the ends, no smoothing (accelerations) |
| derived | algebraic combination of the above (power = torque × speed, spring force, energies, pressure angle) |
| unavailable | not computed in the current mode/model — plotted as nothing, with the reason; never filled with a plausible number |

Sign conventions: a joint's coordinate is the motion of part B relative to
part A, zero at the design pose, counter-clockwise / along the slide axis
positive. *Motor torque* is the torque the motor applies to part B about +Z:
it has the sign of the commanded speed while the motor drives the load and the
opposite sign while the load drives the motor (power = torque × speed is then
negative). *Reaction X/Y* is the force the joint applies to part B. *Tooth
force* and *belt pull* are multipliers of a constraint written from gear/pulley
A to B, so their sign depends on that order and on the direction of power
flow; the two meshes of a compound train therefore usually show opposite
signs. Use the magnitude for loading.

Notes: velocities in dynamic mode are mid-step values (the integrator's own);
accelerations at impacts are large but finite because contact is impulsive;
floor normal force is averaged over each sample interval for the same reason.
Sampling is uniform (default 250 Hz); if a run exceeds the sample budget every
second sample is dropped so the grid stays uniform.

## Accuracy and stability limits

- Explicit forces need `ω·h < 2` for stability and `< 0.5` for accuracy
  (ω = √(k/m_eff) for springs). The app warns before the run when a spring is
  too stiff for the timestep and stops with "diverged" if it happens anyway.
- Fast cams need small steps: the contact is linearised once per step (the
  cam showcase uses 0.25 ms; follower tracking error 2e-3 mm at 120 rpm).
- Friction uses a box approximation per contact solved iteratively; stick/slip
  transitions are resolved to the step.
- Solver cost grows roughly with the cube of the number of joint equations
  (dense factorisation). ~110 equations (the 6-legged walker) cost ≈ 0.3 ms
  per step on the development machine; mechanisms several times larger will
  run slower than real time.
- Near singular configurations (links in line) forces become very large and
  ill-conditioned; the app flags them and joint forces there are unreliable.

## Manufacturing outputs

Exports are generated from the same geometry the simulation uses, checked for
closed-manifold topology and for features thinner than the stated minimum.
They carry no claim about strength, wear, tolerances achieved by your process,
or fitness for any load. Printed gears, press fits, and anything that carries
load or moves near people need human engineering judgement and testing.
