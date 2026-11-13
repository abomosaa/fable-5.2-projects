class_name AudioSchedule
## Pure geometry/timing for sound events (no nodes): propagation delays, image-source early reflections of
## the muzzle blast off the firing-bay surfaces, and slap-back echoes from the berms. Everything is derived
## from RangeLayout, so the sound of a shot changes continuously with where the shooter stands.

const C := 343.0                    # m/s
const REF_DIST_REFLECTION := 1.0    # m: level reference for early reflections (see docs/APPROXIMATIONS.md)
const REF_DIST_ECHO := 2.0          # m: the P38 source recording was made 2 m behind the shooter

static func propagation_delay(distance: float) -> float:
	return maxf(distance, 0.0) / C

## Reflecting rectangle: point `p`, unit normal `n` (pointing into the space), in-plane axes `u`, `v` with
## half extents `hu`, `hv`, pressure reflection factor `r`, low-pass corner `lp` (Hz) and a name.
static func _rect(name: String, p: Vector3, n: Vector3, u: Vector3, hu: float, v: Vector3, hv: float, r: float, lp: float) -> Dictionary:
	return {"name": name, "p": p, "n": n.normalized(), "u": u.normalized(), "hu": hu, "v": v.normalized(), "hv": hv, "r": r, "lp": lp}

static func bay_surfaces() -> Array[Dictionary]:
	var L := RangeLayout
	var out: Array[Dictionary] = []
	var xc := (L.BAY_X_MIN + L.BAY_X_MAX) * 0.5
	var hx := (L.BAY_X_MAX - L.BAY_X_MIN) * 0.5
	# concrete slab (hard, bright)
	var zc := (L.BAY_Z_BACK + L.BAY_Z_FRONT) * 0.5
	out.append(_rect("slab", Vector3(xc, 0, zc), Vector3.UP, Vector3.RIGHT, hx + 0.3, Vector3.BACK, (L.BAY_Z_BACK - L.BAY_Z_FRONT) * 0.5, 0.92, 9000.0))
	# open concrete/gravel pad
	out.append(_rect("pad", Vector3((L.PAD_X_MIN + L.PAD_X_MAX) * 0.5, 0, (L.PAD_Z_BACK + L.PAD_Z_FRONT) * 0.5), Vector3.UP,
		Vector3.RIGHT, (L.PAD_X_MAX - L.PAD_X_MIN) * 0.5, Vector3.BACK, (L.PAD_Z_BACK - L.PAD_Z_FRONT) * 0.5, 0.70, 5000.0))
	# corrugated steel roof: mono-pitch, rising towards the front
	var zr := (L.BAY_Z_BACK + L.BAY_ROOF_Z_FRONT) * 0.5
	var slope := (L.BAY_ROOF_H_FRONT - L.BAY_ROOF_H_BACK) / (L.BAY_Z_BACK - L.BAY_ROOF_Z_FRONT)
	var n_roof := Vector3(0, -1, -slope).normalized()          # faces down into the bay
	var v_roof := Vector3(0, -slope, 1).normalized()
	out.append(_rect("roof", Vector3(xc, (L.BAY_ROOF_H_BACK + L.BAY_ROOF_H_FRONT) * 0.5, zr), n_roof, Vector3.RIGHT, hx + 0.35,
		v_roof, (L.BAY_Z_BACK - L.BAY_ROOF_Z_FRONT) * 0.5 / v_roof.z, 0.88, 12000.0))
	# back wall (timber/OSB cladding)
	out.append(_rect("back_wall", Vector3(xc, L.BAY_ROOF_H_BACK * 0.5, L.BAY_Z_BACK), Vector3.FORWARD, Vector3.RIGHT, hx, Vector3.UP, L.BAY_ROOF_H_BACK * 0.5, 0.74, 6000.0))
	# left block wall
	out.append(_rect("block_wall", Vector3(L.BAY_X_MIN, 1.35, zc), Vector3.RIGHT, Vector3.BACK, (L.BAY_Z_BACK - L.BAY_Z_FRONT) * 0.5, Vector3.UP, 1.35, 0.90, 8000.0))
	# plywood lane dividers (both faces)
	var dz := (L.DIVIDER_Z[0] + L.DIVIDER_Z[1]) * 0.5
	var dy := (L.DIVIDER_H[0] + L.DIVIDER_H[1]) * 0.5
	for x in L.DIVIDER_X:
		for s in [-1.0, 1.0]:
			out.append(_rect("divider", Vector3(x, dy, dz), Vector3(s, 0, 0), Vector3.BACK, (L.DIVIDER_Z[1] - L.DIVIDER_Z[0]) * 0.5,
				Vector3.UP, (L.DIVIDER_H[1] - L.DIVIDER_H[0]) * 0.5, 0.66, 5000.0))
	return out

static func _mirror(pt: Vector3, s: Dictionary) -> Vector3:
	var n: Vector3 = s["n"]
	return pt - 2.0 * n * n.dot(pt - s["p"])

## point where segment a->b crosses the rectangle, or null
static func _cross(a: Vector3, b: Vector3, s: Dictionary) -> Variant:
	var n: Vector3 = s["n"]
	var da := n.dot(a - s["p"])
	var db := n.dot(b - s["p"])
	if da * db >= 0.0:
		return null
	var hit := a.lerp(b, da / (da - db))
	var rel: Vector3 = hit - s["p"]
	if absf(rel.dot(s["u"])) > s["hu"] or absf(rel.dot(s["v"])) > s["hv"]:
		return null
	return hit

static func _in_front(pt: Vector3, s: Dictionary) -> bool:
	return (s["n"] as Vector3).dot(pt - s["p"]) > 0.005

## Early reflections of a source at `src` heard at `ear`. `fwd` = bore direction (mild blast directivity).
## Returns taps sorted by delay: {delay, gain, lp, dir (unit, from ear towards the image source), order, path, surf}.
## `delay` is relative to the direct sound; gain is linear pressure relative to the direct sample level.
static func early_reflections(src: Vector3, ear: Vector3, fwd: Vector3, max_order := 2, max_delay := 0.085) -> Array[Dictionary]:
	var surfs := bay_surfaces()
	var direct := maxf(src.distance_to(ear), 0.2)
	var taps: Array[Dictionary] = []
	var front: Array[int] = []
	for i in surfs.size():
		if _in_front(src, surfs[i]):
			front.append(i)
	for i in front:
		var s := surfs[i]
		if not _in_front(ear, s):
			continue
		var img := _mirror(src, s)
		var hit: Variant = _cross(img, ear, s)
		if hit == null:
			continue
		var path := img.distance_to(ear)
		_add_tap(taps, path, direct, s["r"], s["lp"], img, ear, src, hit, fwd, 1, s["name"], max_delay)
	if max_order >= 2:
		for i in front:
			var a := surfs[i]
			var img1 := _mirror(src, a)
			for j in surfs.size():
				if j == i:
					continue
				var b := surfs[j]
				if not _in_front(ear, b):
					continue
				var img2 := _mirror(img1, b)
				var h2: Variant = _cross(img2, ear, b)
				if h2 == null:
					continue
				var h1: Variant = _cross(img1, h2, a)
				if h1 == null:
					continue
				var path2 := img2.distance_to(ear)
				_add_tap(taps, path2, direct, float(a["r"]) * float(b["r"]), minf(a["lp"], b["lp"]), img2, ear, src, h1, fwd, 2,
					str(a["name"]) + "+" + str(b["name"]), max_delay)
	taps.sort_custom(func(x, y): return x["delay"] < y["delay"])
	return taps

static func _add_tap(taps: Array[Dictionary], path: float, direct: float, r: float, lp: float, img: Vector3, ear: Vector3,
		src: Vector3, first_hit: Vector3, fwd: Vector3, order: int, name: String, max_delay: float) -> void:
	var delay := (path - direct) / C
	if delay < 0.0002 or delay > max_delay:
		return
	# muzzle blast is stronger forward than rearward: weight by the emission direction towards the first bounce
	var emit := (first_hit - src).normalized()
	var directivity := 0.72 + 0.28 * emit.dot(fwd.normalized())
	var gain := r * (REF_DIST_REFLECTION / maxf(path, REF_DIST_REFLECTION)) * directivity
	taps.append({"delay": delay, "gain": gain, "lp": lp, "dir": (img - ear).normalized(), "order": order, "path": path, "surf": name})

## Diffuse slap-back echoes from the earth berms (and the bay block wall seen from outside).
## Returns {delay (after the direct sound), gain, lp, pos (apparent position of the echo), name}.
static func berm_echoes(src: Vector3, ear: Vector3) -> Array[Dictionary]:
	var L := RangeLayout
	var out: Array[Dictionary] = []
	var direct := maxf(src.distance_to(ear), 0.2)
	var pts := [
		["backstop", Vector3(clampf(ear.x, -8.0, 11.0), L.BERM_HEIGHT * 0.45, (L.BERM_TOE_Z + L.BERM_CREST_Z) * 0.5), 0.34, 1900.0],
		["left_berm", Vector3(L.SIDE_BERM_X_LEFT + 1.0, 1.6, minf(ear.z - 6.0, -4.0)), 0.30, 2400.0],
		["right_berm", Vector3(L.SIDE_BERM_X_RIGHT - 1.0, 1.6, minf(ear.z - 6.0, -4.0)), 0.30, 2400.0],
	]
	for p in pts:
		var pos: Vector3 = p[1]
		var path := src.distance_to(pos) + pos.distance_to(ear)
		var gain := float(p[2]) * REF_DIST_ECHO / maxf(path, REF_DIST_ECHO)
		out.append({"name": p[0], "delay": (path - direct) / C, "gain": gain, "lp": p[3], "pos": pos, "path": path})
	return out

## 0..1: how much of the covered bay's acoustics the listener is inside (1 under the roof, fading with
## distance from the bay volume; the shed still answers a shot fired just outside it).
static func bay_enclosure(ear: Vector3) -> float:
	var L := RangeLayout
	var dx := maxf(maxf(L.BAY_X_MIN - ear.x, ear.x - (L.BAY_X_MAX + 0.3)), 0.0)
	var dz := maxf(maxf(L.BAY_ROOF_Z_FRONT - ear.z, ear.z - L.BAY_Z_BACK), 0.0)
	var d := Vector2(dx, dz).length()
	var f := clampf(1.0 - d / 6.0, 0.0, 1.0)
	return f * f

## How much open sky is above/around the listener (complement of the enclosure, used for the open-air tail).
static func open_air(ear: Vector3) -> float:
	return 1.0 - 0.35 * bay_enclosure(ear)
