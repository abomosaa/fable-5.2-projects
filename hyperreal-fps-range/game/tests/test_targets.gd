extends RefCounted
## Targets module: scoring rings, exact hit mapping, paper/backer edges, steel momentum transfer, reset, breakable
## piece bookkeeping. `run()` is pure math; `run_async()` builds the real Targets scene on a stub ground and fires
## real projectiles (ProjectileManager) at it on the real physics engine.

const PaperTarget := preload("res://scripts/targets/paper_target.gd")
const Breakables := preload("res://scripts/targets/breakables.gd")
const BULLET_MASS := 0.008035

# ------------------------------------------------------------------------------------------------ pure math
static func run() -> Array:
	var f: Array = []
	for kind in ["b8", "issf"]:
		var face: Dictionary = PaperTarget.FACES[kind]
		var rings: Array = face["rings"]
		for i in rings.size():
			var value := int(rings[i][0])
			var radius := float(rings[i][1])
			var below := int(rings[i + 1][0]) if i + 1 < rings.size() else 0
			# the hole is 9 mm wide: its centre may be 4.5 mm outside the line and still touch it
			var inside := int(PaperTarget.score_at(kind, Vector2(radius + 4.5 - 0.5, 0.0))["score"])
			var outside := int(PaperTarget.score_at(kind, Vector2(0.0, -(radius + 4.5 + 0.5)))["score"])
			if inside != value:
				f.append("%s ring %d: centre 0.5 mm inside the touch limit scored %d" % [kind, value, inside])
			if outside != below:
				f.append("%s ring %d: centre 0.5 mm beyond the touch limit scored %d, expected %d" % [kind, value, outside, below])
			# without the bullet-radius rule this point (centre 4 mm outside the line) would drop a ring
			var touching := int(PaperTarget.score_at(kind, Vector2(radius + 4.0, 0.0).rotated(0.7))["score"])
			if touching != value:
				f.append("%s ring %d: a hole touching the line from outside must score %d (got %d)" % [kind, value, value, touching])
		var xr := float(face["x_radius"])
		if not bool(PaperTarget.score_at(kind, Vector2(xr + 4.0, 0))["x"]) or bool(PaperTarget.score_at(kind, Vector2(xr + 5.0, 0))["x"]):
			f.append("%s inner ten boundary wrong" % kind)
		var centre := PaperTarget.score_at(kind, Vector2.ZERO)
		if int(centre["score"]) != 10 or not bool(centre["x"]):
			f.append("%s centre hit must be a 10 X" % kind)
	# real ring dimensions (mm)
	var b8: Array = PaperTarget.FACES["b8"]["rings"]
	if absf(float(b8[0][1]) * 2.0 - 3.36 * 25.4) > 0.01 or absf(float(b8[1][1]) * 2.0 - 5.54 * 25.4) > 0.01 or absf(float(b8[5][1]) * 2.0 - 19.68 * 25.4) > 0.01:
		f.append("B-8 ring diameters differ from 3.36 / 5.54 / 19.68 in")
	var issf: Array = PaperTarget.FACES["issf"]["rings"]
	if float(issf[0][1]) != 25.0 or float(issf[9][1]) != 250.0:
		f.append("ISSF 25 m precision ring radii differ from 25 .. 250 mm")
	# muzzle flash visibility: none with "reduce flashes" (the weapon passes 4.0), faint in sun, rising toward dusk
	var FX: GDScript = load("res://scripts/fx/fx_world.gd")
	var v_sun: float = FX.call("flash_visibility", 1.0)
	var v_bay: float = FX.call("flash_visibility", 0.35)
	var v_dusk: float = FX.call("flash_visibility", 0.05)
	if float(FX.call("flash_visibility", 4.0)) != 0.0:
		f.append("flash must be suppressed completely for ambient_luminance >= 3 (reduce flashes)")
	if not (v_sun > 0.0 and v_sun < 0.15 and v_bay > v_sun and v_bay < 0.3 and v_dusk > 0.95):
		f.append("flash visibility sun/bay/dusk = %.2f / %.2f / %.2f is not 'faint / faint / clear'" % [v_sun, v_bay, v_dusk])
	for key in Breakables.TYPES:
		var ks := float(Breakables.TYPES[key]["speed_scale"])
		if ks < 0.9 or ks > 0.98:
			f.append("%s: bullet keeps %.3f of its speed (expected 0.90-0.98)" % [key, ks])
	return f

# ------------------------------------------------------------------------------------------------ on the engine
static func _frames(tree: SceneTree, n: int) -> void:
	for i in n:
		await tree.physics_frame

static func _fly(tree: SceneTree, pm: Node) -> void:
	var guard := 0
	while not (pm.get("active") as Array).is_empty() and guard < 600:
		guard += 1
		await tree.physics_frame

static func _ground(parent: Node) -> void:
	var b := StaticBody3D.new()
	b.set_meta("surface", "dirt")
	b.collision_layer = 1
	b.collision_mask = 0
	var cs := CollisionShape3D.new()
	var sh := BoxShape3D.new()
	sh.size = Vector3(300, 1, 300)
	cs.shape = sh
	cs.position = Vector3(0, -0.5, -50)
	b.add_child(cs)
	parent.add_child(b)

static func run_async(tree: SceneTree) -> Array:
	var f: Array = []
	var root := Node3D.new()
	tree.root.add_child(root)
	_ground(root)
	var targets: Node3D = load("res://scenes/targets/targets.tscn").instantiate()
	root.add_child(targets)
	var pm := ProjectileManager.new()
	root.add_child(pm)
	var hits: Array = []
	pm.bullet_hit.connect(func(h: Dictionary) -> void: hits.append(h))
	var events: Array = []
	targets.connect("target_hit", func(info: Dictionary) -> void: events.append(info))
	await _frames(tree, 4)
	if not targets.is_in_group("targets"):
		f.append("Targets root is not in group 'targets'")
	for m in ["reset_all", "step_paper_distance", "get_paper_targets", "get_selected_paper_target", "get_stats"]:
		if not targets.has_method(m):
			f.append("Targets lacks %s()" % m)
	for s in ["target_hit", "layout_changed", "request_fade"]:
		if not targets.has_signal(s):
			f.append("Targets lacks signal %s" % s)
	var papers: Array = targets.call("get_paper_targets")
	var shot := 9000

	# --- 1. faces stand exactly at their distance; world <-> mm round trip
	for p in papers:
		var c: Vector3 = p.call("mm_to_world", Vector2.ZERO)
		if absf(-c.z - float(p.get("distance_m"))) > 1e-5:
			f.append("%s: face plane at z=%f but distance_m=%f" % [p.get("label"), c.z, p.get("distance_m")])
		for mm in [Vector2(0, 0), Vector2(123.4, -200.2), Vector2(-266.0, 304.0), Vector2(0.25, 0.75)]:
			var back: Vector2 = p.call("world_to_mm", p.call("mm_to_world", mm))
			if back.distance_to(mm) > 0.01:
				f.append("%s: mm -> world -> mm moved %s to %s" % [p.get("label"), mm, back])
	# movable stand: every distance, hit recorded where the bullet really crossed the face
	var sel: Node3D = targets.call("get_selected_paper_target")
	for d in [7.0, 10.0, 15.0, 25.0]:
		targets.call("set_selected_distance", d)
		await _frames(tree, 2)
		if absf(float(sel.get("distance_m")) - d) > 1e-6 or absf(sel.global_position.z + d) > 1e-6:
			f.append("movable stand not at %.0f m" % d)
		var aim: Vector3 = sel.call("mm_to_world", Vector2(37.0, -21.0))
		hits.clear()
		var n0: int = (sel.call("get_hits") as Array).size()
		shot += 1
		pm.fire(aim + Vector3(0, 0, 0.6), Vector3.FORWARD, 335.0, shot)
		await _fly(tree, pm)
		var recs: Array = sel.call("get_hits")
		if recs.size() != n0 + 1:
			f.append("movable stand at %.0f m: expected one new hit, got %d" % [d, recs.size() - n0])
			continue
		var rec: Dictionary = recs[recs.size() - 1]
		var paper_hit: Dictionary = {}
		for h in hits:
			if str(h["surface"]) == "paper":
				paper_hit = h
		if paper_hit.is_empty():
			f.append("no 'paper' surface hit reported at %.0f m" % d)
			continue
		var hp: Vector3 = paper_hit["position"]
		if absf(hp.z + d) > 1e-4:
			f.append("paper hit at z=%f, face should be at %f" % [hp.z, -d])
		var world_again: Vector3 = sel.call("mm_to_world", rec["pos_mm"])
		if world_again.distance_to(hp) > 0.0005:
			f.append("recorded pos_mm maps back %.3f mm away from the real hit point" % (world_again.distance_to(hp) * 1000.0))
		if (rec["pos_mm"] as Vector2).distance_to(Vector2(37.0, -21.0)) > 0.5:
			f.append("hit aimed at (37,-21) mm recorded at %s" % rec["pos_mm"])
		if int(rec["score"]) != int(PaperTarget.score_at(str(sel.get("face_kind")), rec["pos_mm"])["score"]):
			f.append("stored score differs from score_at()")
	targets.call("set_selected_distance", 10.0)
	await _frames(tree, 2)

	# --- 2. the hole is painted at the hit position; untouched paper stays untouched
	var canvas: RefCounted = sel.get("_paper_canvas")
	var size_mm: Vector2 = sel.get("face_size_mm")
	var px := Vector2i(((Vector2(size_mm.x * 0.5 + 37.0, size_mm.y * 0.5 + 21.0)) * 4.0).round())
	if float(canvas.call("value_at", px)) > 0.2:
		f.append("no hole in the face field at the hit pixel (value %.2f)" % canvas.call("value_at", px))
	if float(canvas.call("value_at", px + Vector2i(120, 0))) < 0.999:
		f.append("face field damaged 30 mm away from the only hit")
	if sel.call("get_face_texture") == null:
		f.append("get_face_texture() returned null")

	# --- 3. paper edge: 5 mm inside hits the paper, 5 mm outside only the cardboard, beyond the backer nothing
	var p0: Node3D = papers[0]
	var half: Vector2 = (p0.get("face_size_mm") as Vector2) * 0.5
	var cases := [[half.x - 5.0, 1, 1], [half.x + 5.0, 0, 1], [-(half.x + 5.0), 0, 1], [305.0 + 5.0, 0, 0]]
	for c in cases:
		var before_p: int = (p0.call("get_hits") as Array).size()
		var before_c: int = int(p0.call("get_stats")["card_hits"])
		shot += 1
		pm.fire((p0.call("mm_to_world", Vector2(c[0], 250.0)) as Vector3) + Vector3(0, 0, 0.5), Vector3.FORWARD, 335.0, shot)
		await _fly(tree, pm)
		var dp: int = (p0.call("get_hits") as Array).size() - before_p
		var dc: int = int(p0.call("get_stats")["card_hits"]) - before_c
		if dp != c[1] or dc != c[2]:
			f.append("shot at x=%.1f mm (paper edge %.1f, backer edge 305): paper +%d (want %d), cardboard +%d (want %d)" % [c[0], half.x, dp, c[1], dc, c[2]])
	# vertical edge too
	shot += 1
	var nb: int = (p0.call("get_hits") as Array).size()
	pm.fire((p0.call("mm_to_world", Vector2(0.0, half.y + 5.0)) as Vector3) + Vector3(0, 0, 0.5), Vector3.FORWARD, 335.0, shot)
	await _fly(tree, pm)
	if (p0.call("get_hits") as Array).size() != nb:
		f.append("a shot 5 mm above the paper's top edge was counted as a paper hit")
	# the bullet goes on through paper + cardboard at ~0.99 and ends in the ground/berm, not in the target
	var last: Dictionary = pm.history[pm.history.size() - 1]
	for h in last["hits"]:
		if str(h["surface"]) in ["paper", "cardboard"] and bool(h["stop"]):
			f.append("bullet stopped in %s" % h["surface"])
	var kinds := {}
	for e in events:
		kinds[str(e.get("kind"))] = true
		if str(e.get("kind")) == "paper" and (not e.has("target") or not e.has("pos_mm") or not e.has("score") or not e.has("distance_m")):
			f.append("paper target_hit info lacks target/pos_mm/score/distance_m")
	if not kinds.has("paper"):
		f.append("no target_hit signal with kind 'paper'")

	# --- 4. steel: plate velocity right after the hit = bullet momentum / plate mass
	var gongs: Array = targets.get("gongs")
	for gi in [0, 2]:
		var g: Node3D = gongs[gi]
		var plate: RigidBody3D = g.get("plate")
		var v_b := 335.0
		shot += 1
		hits.clear()
		pm.fire(plate.global_position + Vector3(0, 0, 0.5), Vector3.FORWARD, v_b, shot)
		var seen := false
		var v_after := Vector3.ZERO
		for k in 20:
			await tree.physics_frame
			if int(plate.get("hits")) > 0 and not seen:
				seen = true
				v_after = plate.linear_velocity
				break
		if not seen:
			f.append("%s: bullet did not reach the plate" % g.get("label"))
			continue
		var speed_at_plate := v_b
		for h in hits:
			if h["collider"] == plate:
				speed_at_plate = float(h["speed"])
		var expect := BULLET_MASS * speed_at_plate / plate.mass
		if absf(-v_after.z - expect) > expect * 0.10:
			f.append("%s: plate speed after hit %.3f m/s, expected m v / M = %.3f (+-10 %%)" % [g.get("label"), -v_after.z, expect])
		var j: Vector3 = plate.get("last_impulse")
		if absf(j.length() - BULLET_MASS * speed_at_plate) > 0.01 * BULLET_MASS * speed_at_plate:
			f.append("%s: impulse %.3f N s differs from bullet momentum %.3f" % [g.get("label"), j.length(), BULLET_MASS * speed_at_plate])
		var rec2: Dictionary = pm.history[pm.history.size() - 1] if (pm.get("active") as Array).is_empty() else {}
		await _fly(tree, pm)
		rec2 = pm.history[pm.history.size() - 1]
		var lasth: Dictionary = (rec2["hits"] as Array)[(rec2["hits"] as Array).size() - 1]
		if str(lasth["surface"]) != "steel" or not bool(lasth["stop"]):
			f.append("%s: the bullet must stop on the plate" % g.get("label"))
		var face: RefCounted = plate.get("face")
		if int(face.get("marks")) != 1:
			f.append("%s: expected one splash mark, have %d" % [g.get("label"), face.get("marks")])
		var fc: RefCounted = face.get("canvas")
		var t: Image = (fc.get("_tiles") as Dictionary).get(0)
		if t == null or t.get_pixel(192, 192).r > 0.45:
			f.append("%s: paint not stripped at the centre of the splash field" % g.get("label"))
		elif t.get_pixel(192 + 150, 192).r < 0.999 and t.get_pixel(192, 192 - 170).r < 0.999 and t.get_pixel(192 - 160, 192 + 60).r < 0.999:
			f.append("%s: the splash covers the plate far from the hit" % g.get("label"))
	# three hits on one spot: the area stays bare steel (lowest field band); spray from later hits must not turn it
	# into a growing bright blob
	var face0: RefCounted = (gongs[0].get("plate") as Node).get("face")
	for k in 3:
		face0.call("mark", Vector3(0.012 * k, 0.004 * k, 0.0048))
	var tile0: Image = ((face0.get("canvas") as RefCounted).get("_tiles") as Dictionary).get(0)
	var n_bare := 0
	var n_lead := 0
	for yy in range(0, 384, 2):
		for xx in range(0, 384, 2):
			var v := tile0.get_pixel(xx, yy).r
			if v < 0.45:
				n_bare += 1
				if v > 0.305:
					n_lead += 1
	var px_mm := 384.0 / (2.0 * float(face0.get("radius")) * 1000.0)
	var bare_cm2 := n_bare * 4.0 / (px_mm * px_mm) / 100.0
	if bare_cm2 < 4.0 or bare_cm2 > 30.0:
		f.append("four overlapping 9 mm hits stripped %.1f cm2 of paint (expected one merged patch of 5-25 cm2)" % bare_cm2)
	if n_lead > n_bare * 0.35:
		f.append("overlapping hits turned %d %% of the bare patch into bright lead" % int(100.0 * n_lead / maxf(n_bare, 1.0)))
	# off-centre hit must twist the plate (angular velocity about the vertical axis)
	var g1: Node3D = gongs[1]
	var plate1: RigidBody3D = g1.get("plate")
	shot += 1
	pm.fire(plate1.global_position + Vector3(0.09, 0, 0.5), Vector3.FORWARD, 335.0, shot)
	for k in 12:
		await tree.physics_frame
		if int(plate1.get("hits")) > 0:
			break
	if absf(plate1.angular_velocity.y) < 0.5:
		f.append("off-centre hit produced no twist (omega_y = %.3f rad/s)" % plate1.angular_velocity.y)
	await _frames(tree, 90)
	for g in gongs:
		var pl: RigidBody3D = g.get("plate")
		var rest: Transform3D = pl.call("rest_transform")
		if not pl.global_position.is_finite() or pl.global_position.distance_to(rest.origin) > 0.6:
			f.append("%s: plate left its suspension (%s)" % [g.get("label"), pl.global_position])

	# --- 5. breakables: piece counts conserved and bounded; bullet continues
	var br: Node3D = targets.get("breakables")
	for key in Breakables.TYPES:
		var n: int = br.call("piece_count", key)
		if n < 8 or n > 25:
			f.append("%s has %d pre-fractured pieces (want 8-25)" % [key, n])
	var total_pieces := 0
	var item_n: int = br.call("item_count")
	for i in item_n:
		var it: RefCounted = br.call("get_item", i)
		var body: Node3D = it.get("body")
		var type := str(it.get("type"))
		total_pieces += int(br.call("piece_count", type))
		shot += 1
		# aim at the middle of the object (clays stand on edge: their model origin is on the rim axis)
		var aim2 := body.global_position + (Vector3(0, 0.06, 0) if type != "clay" else Vector3(0, 0, 0.0))
		pm.fire(aim2 + Vector3(0, 0, 0.6), Vector3.FORWARD, 335.0, shot)
		await _fly(tree, pm)
		if not bool(it.get("broken")):
			f.append("%s #%d did not break" % [type, i])
		var rec3: Dictionary = pm.history[pm.history.size() - 1]
		var first: Dictionary = (rec3["hits"] as Array)[0]
		if bool(first["stop"]) or (rec3["hits"] as Array).size() < 2:
			f.append("%s #%d: bullet did not continue past the object" % [type, i])
		var st: Dictionary = br.call("get_stats")
		if int(st["fragments_live"]) > Breakables.LIVE_CAP or int(st["fragments_static"]) > Breakables.STATIC_CAP:
			f.append("fragment pools exceeded: %s" % str(st))
		if int(st["fragments_live"]) + int(st["fragments_free"]) != Breakables.LIVE_CAP:
			f.append("fragment bodies leaked: live %d + free %d != %d" % [st["fragments_live"], st["fragments_free"], Breakables.LIVE_CAP])
	var st2: Dictionary = br.call("get_stats")
	if int(st2["pieces_released"]) != total_pieces:
		f.append("pieces released %d != sum of piece counts %d" % [st2["pieces_released"], total_pieces])
	if int(st2["broken"]) != item_n:
		f.append("%d of %d brittle objects broken" % [st2["broken"], item_n])
	if int(st2["fragments_live"]) + int(st2["fragments_static"]) != mini(total_pieces, int(st2["fragments_live"]) + Breakables.STATIC_CAP) and \
			int(st2["fragments_live"]) + int(st2["fragments_static"]) != total_pieces:
		f.append("pieces on stage (%d live + %d settled) do not add up to %d released" % [st2["fragments_live"], st2["fragments_static"], total_pieces])
	# a can is knocked off, not broken; the bullet goes through
	var cans: Array = br.call("get_cans")
	var can: RigidBody3D = cans[0]
	shot += 1
	pm.fire(can.global_position + Vector3(0.01, 0.05, 0.6), Vector3.FORWARD, 335.0, shot)
	var can_v := Vector3.ZERO
	for k in 20:
		await tree.physics_frame
		if int(can.get("hits")) > 0:
			can_v = can.linear_velocity          # read before it slides off the plank and falls
			break
	await _fly(tree, pm)
	var dv := 0.03 * BULLET_MASS * 335.0 / can.mass
	if can_v.length() < dv * 0.5 or can_v.length() > dv * 2.0:
		f.append("can speed after hit %.2f m/s, expected about %.2f (3 %% of the bullet's momentum)" % [can_v.length(), dv])
	var can_rec: Dictionary = pm.history[pm.history.size() - 1]
	if bool(((can_rec["hits"] as Array)[0] as Dictionary)["stop"]):
		f.append("the bullet must pass through an empty tin can")
	# everything settles: no live fragment bodies after 9 s
	await _frames(tree, 9 * Engine.physics_ticks_per_second)
	var st3: Dictionary = br.call("get_stats")
	if int(st3["fragments_live"]) != 0:
		f.append("%d fragment bodies still simulated 9 s after the last break" % st3["fragments_live"])

	# --- 6. reset restores exact transforms and clears every mark
	targets.call("reset_all")
	await _frames(tree, 3)
	for p in papers:
		if (p.call("get_hits") as Array).size() != 0 or int(p.call("get_stats")["paper_tiles"]) != 0 or int(p.call("get_stats")["card_tiles"]) != 0:
			f.append("%s not clean after reset" % p.get("label"))
	if float(canvas.call("value_at", px)) < 0.999:
		f.append("hole still in the face field after reset")
	for g in gongs:
		var pl2: RigidBody3D = g.get("plate")
		var rest2: Transform3D = pl2.call("rest_transform")
		if pl2.global_position.distance_to(rest2.origin) > 0.0005 or pl2.global_transform.basis.x.distance_to(rest2.basis.x) > 0.002 \
				or pl2.global_transform.basis.z.distance_to(rest2.basis.z) > 0.002:
			f.append("%s: plate pose after reset differs from rest by %.2f mm" % [g.get("label"), pl2.global_position.distance_to(rest2.origin) * 1000.0])
		if pl2.linear_velocity.length() > 0.02:
			f.append("%s: plate still moving after reset" % g.get("label"))
		if int((pl2.get("face") as RefCounted).get("marks")) != 0:
			f.append("%s: splash marks survived reset" % g.get("label"))
	for c in cans:
		var rc: Transform3D = c.call("rest_transform")
		if (c as Node3D).global_position.distance_to(rc.origin) > 0.0005:
			f.append("can not back on the shelf after reset")
	var st4: Dictionary = br.call("get_stats")
	if int(st4["broken"]) != 0 or int(st4["fragments_live"]) != 0 or int(st4["fragments_static"]) != 0:
		f.append("breakables not restored by reset: %s" % str(st4))
	# hits still register after a reset
	shot += 1
	pm.fire((sel.call("mm_to_world", Vector2.ZERO) as Vector3) + Vector3(0, 0, 0.5), Vector3.FORWARD, 335.0, shot)
	await _fly(tree, pm)
	if (sel.call("get_hits") as Array).size() != 1:
		f.append("target does not record hits after reset")
	root.queue_free()
	await tree.process_frame
	return f
