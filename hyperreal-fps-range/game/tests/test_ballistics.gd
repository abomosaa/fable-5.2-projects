extends RefCounted
## External ballistics: unit consistency, reference values, zeroing, recoil model sanity.

static func run() -> Array:
	var f: Array = []
	var v0 := WeaponDef.MUZZLE_VELOCITY
	var bc := WeaponDef.BC_G1
	# drag table is monotone through the transonic rise and continuous
	var prev := Ballistics.g1_cd(0.5)
	for i in range(51, 121):
		var cd := Ballistics.g1_cd(i * 0.01)
		if i > 60 and cd < prev - 1e-6:
			f.append("G1 Cd not monotone at Mach %.2f" % (i * 0.01))
		if absf(cd - prev) > 0.03:
			f.append("G1 Cd jumps at Mach %.2f" % (i * 0.01))
		prev = cd
	# vacuum check: with (almost) no drag the drop is g t^2 / 2
	var vac := Ballistics.solve_at(50.0, 300.0, 1e9, 0.0, 0.0)
	var t := 50.0 / 300.0
	if absf(float(vac["y"]) + 0.5 * Ballistics.GRAVITY * t * t) > 1e-4:
		f.append("vacuum drop wrong: %f" % vac["y"])
	# reference figures for 124 gr FMJ at 346 m/s (docs/REFERENCES.md solver table: 29 / 74 / 152 ms, ~315 m/s at 50 m)
	var elev := Ballistics.zero_elevation(WeaponDef.ZERO_RANGE, v0, bc, 0.0177)
	var d10 := Ballistics.solve_at(10.0, v0, bc, elev, -0.0177)
	var d25 := Ballistics.solve_at(25.0, v0, bc, elev, -0.0177)
	var d50 := Ballistics.solve_at(50.0, v0, bc, elev, -0.0177)
	if absf(float(d25["y"])) > 0.0002:
		f.append("25 m zero not met: %f m" % d25["y"])
	if absf(float(d10["t"]) - 0.029) > 0.002 or absf(float(d25["t"]) - 0.074) > 0.003 or absf(float(d50["t"]) - 0.152) > 0.005:
		f.append("time of flight off: %s %s %s" % [d10["t"], d25["t"], d50["t"]])
	if float(d50["v"]) < 300.0 or float(d50["v"]) > 330.0:
		f.append("remaining velocity at 50 m implausible: %f" % d50["v"])
	if float(d50["y"]) > -0.02 or float(d50["y"]) < -0.07:
		f.append("drop at 50 m with 25 m zero implausible: %f" % d50["y"])
	if float(d10["y"]) > 0.0 or float(d10["y"]) < -0.015:
		f.append("bullet should still be below the sight line at 10 m: %f" % d10["y"])
	# step-size independence
	var p := Vector3.ZERO
	var v := Vector3(0, 0, -v0)
	for i in 100:
		var r := Ballistics.step(p, v, 0.001, bc)
		p = r[0]
		v = r[1]
	var p2 := Vector3.ZERO
	var v2 := Vector3(0, 0, -v0)
	for i in 1000:
		var r2 := Ballistics.step(p2, v2, 0.0001, bc)
		p2 = r2[0]
		v2 = r2[1]
	if p.distance_to(p2) > 0.002:
		f.append("integration depends on step size: %f m apart after 0.1 s" % p.distance_to(p2))
	# energy: 124 gr at 346 m/s is ~480 J
	var e := Ballistics.kinetic_energy(WeaponDef.BULLET_MASS, v0)
	if e < 440.0 or e > 520.0:
		f.append("muzzle energy %f J" % e)
	# recoil: peak near the configured angle/time, returns to zero, and a fast string climbs
	var rng := RandomNumberGenerator.new()
	rng.seed = 7
	var rm := RecoilModel.new()
	rm.apply_shot(rng, 1.0)
	var peak := 0.0
	var peak_t := 0.0
	var min_after := 0.0
	var tt := 0.0
	while tt < 2.5:
		rm.step(1.0 / 240.0)
		tt += 1.0 / 240.0
		if rm.pitch.x > peak:
			peak = rm.pitch.x
			peak_t = tt
		if tt > peak_t:
			min_after = minf(min_after, rm.pitch.x)
	if absf(rad_to_deg(peak) - WeaponDef.RECOIL_PITCH_PEAK_DEG) > 1.1:
		f.append("recoil peak %f deg" % rad_to_deg(peak))
	if absf(peak_t - WeaponDef.RECOIL_PITCH_PEAK_TIME) > 0.02:
		f.append("recoil peak time %f s" % peak_t)
	if not rm.is_settled():
		f.append("recoil not settled after 2.5 s")
	if min_after < -peak * 0.4:
		f.append("recoil overshoots too far below the line (min %f)" % rad_to_deg(min_after))
	var a := RecoilModel.new()
	var b := RecoilModel.new()
	var top_fast := 0.0
	var top_slow := 0.0
	for shot in 4:
		a.apply_shot(rng, 1.0)
		for k in 20:               # 0.083 s splits: the next shot breaks while the muzzle is still high
			a.step(1.0 / 240.0)
			top_fast = maxf(top_fast, a.pitch.x)
		b.apply_shot(rng, 1.0)
		for k in 192:              # 0.8 s cadence
			b.step(1.0 / 240.0)
			top_slow = maxf(top_slow, b.pitch.x)
	if top_fast <= top_slow * 1.02:
		f.append("rapid fire should climb more than deliberate fire (%f vs %f)" % [top_fast, top_slow])
	if absf(rm.view_pitch) > 1e-4:
		f.append("view kick must return to zero")
	# shots are not identical: time to peak and the point the hold returns to differ from shot to shot
	var peaks := []
	var rests := []
	for shot in 12:
		var r3 := RecoilModel.new()
		r3.apply_shot(rng, 1.0)
		var pk := 0.0
		var pk_t := 0.0
		var t3 := 0.0
		var at200 := 0.0
		while t3 < 0.3:
			r3.step(1.0 / 480.0)
			t3 += 1.0 / 480.0
			if r3.pitch.x > pk:
				pk = r3.pitch.x
				pk_t = t3
			if absf(t3 - 0.2) < 0.0011:
				at200 = r3.pitch.x + r3.settle.x
		peaks.append(pk_t)
		rests.append(at200)
	if peaks.max() - peaks.min() < 0.006:
		f.append("recoil time course identical between shots (peak times %s)" % str(peaks))
	if rests.max() - rests.min() < deg_to_rad(0.08):
		f.append("the hold returns to the same point after every shot")
	return f
