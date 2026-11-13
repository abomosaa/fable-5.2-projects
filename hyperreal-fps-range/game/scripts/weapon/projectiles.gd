class_name ProjectileManager
extends Node3D
## Simulates every bullet as a point mass (G1 drag + gravity) and tests each flown segment with a ray, so a fast
## bullet cannot tunnel through a thin target and nothing behind a wall can be hit. Visuals (marks, debris,
## sounds) are produced only from the hits found here. No tracers: a 9 mm FMJ is not visible in flight.

signal bullet_hit(hit: Dictionary)
signal bullet_finished(record: Dictionary)

const MASK := 0b101                # world + target layers
const MAX_SEG := 0.6               # m per ray segment
const MAX_TIME := 3.0              # s
const MIN_SPEED := 25.0            # m/s: below this a 9 mm bullet is simply stopped
const DEFAULT_PASS := {"paper": 1.0, "cardboard": 0.995, "plywood": 0.85, "sheet_metal": 0.93, "glass": 0.95}

var fx: Node                       # FXWorld (optional)
var bc := WeaponDef.BC_G1
var active: Array[Dictionary] = []
var history: Array[Dictionary] = []      # last finished shots (tests, evidence, HUD)
var history_limit := 64
var total_fired := 0

func fire(origin: Vector3, direction: Vector3, speed: float, shot_index: int, age := 0.0) -> void:
	total_fired += 1
	var b := {"pos": origin, "vel": direction.normalized() * speed, "t": 0.0, "origin": origin, "index": shot_index,
		"exclude": [] as Array[RID], "hits": [], "lead": age}
	active.append(b)

func clear() -> void:
	active.clear()
	history.clear()

func _physics_process(delta: float) -> void:
	if active.is_empty():
		return
	var space := get_world_3d().direct_space_state
	var i := 0
	while i < active.size():
		var b := active[i]
		var dt := delta + float(b["lead"])
		b["lead"] = 0.0
		if _advance(b, dt, space):
			i += 1
		else:
			_finish(b)
			active.remove_at(i)

## returns false when the bullet is done
func _advance(b: Dictionary, dt: float, space: PhysicsDirectSpaceState3D) -> bool:
	var remaining := dt
	while remaining > 1e-6:
		var speed: float = (b["vel"] as Vector3).length()
		if speed < MIN_SPEED:
			return false
		var h := minf(remaining, MAX_SEG / speed)
		var st := Ballistics.step(b["pos"], b["vel"], h, bc)
		var from: Vector3 = b["pos"]
		var to: Vector3 = st[0]
		var seg_from := from
		var guard := 0
		var stopped := false
		while guard < 8:
			guard += 1
			var q := PhysicsRayQueryParameters3D.create(seg_from, to, MASK)
			var ex: Array[RID] = []
			ex.assign(b["exclude"])
			q.exclude = ex
			q.hit_from_inside = false
			var r := space.intersect_ray(q)
			if r.is_empty():
				break
			var frac := from.distance_to(r["position"]) / maxf(from.distance_to(to), 1e-6)
			var res := _on_hit(b, r, b["t"] + h * frac, (to - from).normalized(), speed)
			if res["stop"]:
				stopped = true
				b["pos"] = r["position"]
				break
			# continue through: scrub speed, do not hit the same body again on this pass
			var scale: float = res["speed_scale"]
			st[1] = (st[1] as Vector3) * scale
			(b["exclude"] as Array).append(r["rid"])
			seg_from = r["position"]
		if stopped:
			return false
		(b["exclude"] as Array).clear()        # a body passed in an earlier segment is far behind now
		b["pos"] = to
		b["vel"] = st[1]
		b["t"] = float(b["t"]) + h
		remaining -= h
		if float(b["t"]) > MAX_TIME or not RangeLayout.PLAY_BOUNDS.grow(120.0).has_point(to):
			return false
	return true

static func surface_of(collider: Object) -> String:
	var n: Object = collider
	while n != null:
		if n.has_meta("surface"):
			return str(n.get_meta("surface"))
		n = n.get_parent() if n is Node else null
	return "dirt"

static func _handler_of(collider: Object) -> Object:
	var n: Object = collider
	while n != null:
		if n.has_method("on_bullet_hit"):
			return n
		n = n.get_parent() if n is Node else null
	return null

func _on_hit(b: Dictionary, r: Dictionary, tof: float, dir: Vector3, speed: float) -> Dictionary:
	var collider: Object = r["collider"]
	var surface := surface_of(collider)
	var hit := {"position": r["position"], "normal": r["normal"], "direction": dir, "speed": speed,
		"mass": WeaponDef.BULLET_MASS, "energy": Ballistics.kinetic_energy(WeaponDef.BULLET_MASS, speed),
		"collider": collider, "shape": r.get("shape", 0), "surface": surface, "tof": tof, "origin": b["origin"],
		"shot_index": b["index"]}
	var out := {"stop": true, "speed_scale": 1.0, "fx": true}
	var handler := _handler_of(collider)
	if handler != null:
		var res: Variant = handler.call("on_bullet_hit", hit)
		if res is Dictionary:
			out.merge(res, true)
	elif DEFAULT_PASS.has(surface):
		out["stop"] = false
		out["speed_scale"] = DEFAULT_PASS[surface]
	if out["fx"] and fx != null and is_instance_valid(fx):
		fx.call("spawn_world_impact", hit)
		if not out["stop"] and handler == null and surface in ["plywood", "sheet_metal"]:
			_exit_mark(hit, r)
	(b["hits"] as Array).append({"surface": surface, "position": r["position"], "tof": tof, "speed": speed, "stop": out["stop"],
		"collider": str(collider.name) if collider is Node else ""})
	bullet_hit.emit(hit)
	return out

## exit hole on the far face of a thin panel: probe backwards from just beyond it
func _exit_mark(hit: Dictionary, r: Dictionary) -> void:
	var space := get_world_3d().direct_space_state
	var p: Vector3 = hit["position"]
	var d: Vector3 = hit["direction"]
	var q := PhysicsRayQueryParameters3D.create(p + d * 0.25, p, MASK)
	var back := space.intersect_ray(q)
	if back.is_empty() or back["rid"] != r["rid"]:
		return
	var e := hit.duplicate()
	e["position"] = back["position"]
	e["normal"] = back["normal"]
	e["exit"] = true
	fx.call("spawn_world_impact", e)

func _finish(b: Dictionary) -> void:
	var rec := {"index": b["index"], "origin": b["origin"], "end": b["pos"], "t": b["t"], "hits": b["hits"]}
	history.append(rec)
	if history.size() > history_limit:
		history.pop_front()
	bullet_finished.emit(rec)
