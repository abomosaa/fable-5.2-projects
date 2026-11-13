extends RefCounted
## UI maths: shot-group statistics, unit formatting, settings <-> widget round trips, binding helpers,
## scale rules and palette contrast. Pure functions only (no scene tree, no autoload instances).

const UIMath := preload("res://scripts/ui/ui_math.gd")
const UIStyle := preload("res://scripts/ui/ui_style.gd")
const FaceView := preload("res://scripts/ui/target_face_view.gd")
const SettingsScript := preload("res://scripts/core/settings.gd")

static func _near(a: float, b: float, eps := 1e-4) -> bool:
	return absf(a - b) <= eps

static func _hits(points: Array, scores := []) -> Array:
	var out: Array = []
	for i in points.size():
		out.append({"pos_mm": points[i], "score": scores[i] if i < scores.size() else 0})
	return out

static func run() -> Array:
	var f: Array = []
	_test_group_stats(f)
	_test_formatting(f)
	_test_settings_round_trip(f)
	_test_bindings(f)
	_test_scale(f)
	_test_contrast(f)
	_test_face_view(f)
	return f

# ------------------------------------------------------------------------------------------------
static func _test_group_stats(f: Array) -> void:
	# empty
	var st := UIMath.group_stats([])
	if st["count"] != 0 or st["extreme_spread_mm"] != 0.0 or st["mean_radius_mm"] != 0.0 or st["total_score"] != 0:
		f.append("empty group: expected zeros, got %s" % [st])

	# one shot: no spread, centre = the shot
	st = UIMath.group_stats(_hits([Vector2(12, -7)], [9]))
	if st["count"] != 1 or not _near(st["extreme_spread_mm"], 0.0) or not _near(st["mean_radius_mm"], 0.0) \
			or not (st["center"] as Vector2).is_equal_approx(Vector2(12, -7)) or st["total_score"] != 9:
		f.append("single shot: %s" % [st])

	# two shots 30 mm apart: ES 30, MR 15, centre midway
	st = UIMath.group_stats(_hits([Vector2(-10, 5), Vector2(20, 5)], [10, 8]))
	if not _near(st["extreme_spread_mm"], 30.0) or not _near(st["mean_radius_mm"], 15.0) \
			or not (st["center"] as Vector2).is_equal_approx(Vector2(5, 5)) or st["total_score"] != 18:
		f.append("two shots: %s" % [st])

	# 3-4-5 triangle (30, 40, 50 mm): ES = hypotenuse 50; centre = (10, 13.333);
	# radii 16.6667, 24.0370, 28.4800 -> MR 23.0612
	st = UIMath.group_stats(_hits([Vector2(0, 0), Vector2(30, 0), Vector2(0, 40)], [10, 9, 8]))
	if not _near(st["extreme_spread_mm"], 50.0):
		f.append("triangle ES: expected 50, got %f" % st["extreme_spread_mm"])
	if not (st["center"] as Vector2).is_equal_approx(Vector2(10.0, 40.0 / 3.0)):
		f.append("triangle centre: %s" % [st["center"]])
	var mr := (sqrt(100.0 + 1600.0 / 9.0) + sqrt(400.0 + 1600.0 / 9.0) + sqrt(100.0 + 6400.0 / 9.0)) / 3.0
	if not _near(st["mean_radius_mm"], mr) or not _near(st["mean_radius_mm"], 23.0612, 1e-3):
		f.append("triangle MR: expected %f, got %f" % [mr, st["mean_radius_mm"]])
	if not _near(st["max_radius_mm"], sqrt(100.0 + 6400.0 / 9.0)):
		f.append("triangle max radius: %f" % st["max_radius_mm"])
	var pair := [st["es_a"], st["es_b"]]
	if not (pair.has(Vector2(30, 0)) and pair.has(Vector2(0, 40))):
		f.append("triangle ES pair: %s" % [pair])
	if st["total_score"] != 27:
		f.append("triangle score: %d" % st["total_score"])

	# square with a centre shot: ES = diagonal, MR = 4/5 of the half-diagonal, centre at the origin
	var sq := [Vector2(10, 10), Vector2(-10, 10), Vector2(-10, -10), Vector2(10, -10), Vector2(0, 0)]
	st = UIMath.group_stats(_hits(sq))
	if not _near(st["extreme_spread_mm"], 20.0 * sqrt(2.0)) or not _near(st["mean_radius_mm"], 0.8 * 10.0 * sqrt(2.0)) \
			or not (st["center"] as Vector2).is_equal_approx(Vector2.ZERO):
		f.append("square: %s" % [st])

	# translation moves only the centre; scaling by 2 doubles the lengths (unit consistency)
	var moved: Array = []
	var scaled: Array = []
	for p: Vector2 in sq:
		moved.append(p + Vector2(37.5, -120.25))
		scaled.append(p * 2.0)
	var st_m := UIMath.group_stats(_hits(moved))
	var st_s := UIMath.group_stats(_hits(scaled))
	if not _near(st_m["extreme_spread_mm"], st["extreme_spread_mm"], 1e-3) or not _near(st_m["mean_radius_mm"], st["mean_radius_mm"], 1e-3) \
			or not (st_m["center"] as Vector2).is_equal_approx(Vector2(37.5, -120.25)):
		f.append("translation invariance: %s" % [st_m])
	if not _near(st_s["extreme_spread_mm"], 2.0 * st["extreme_spread_mm"], 1e-3) or not _near(st_s["mean_radius_mm"], 2.0 * st["mean_radius_mm"], 1e-3):
		f.append("scaling: %s" % [st_s])

	# entries without a position are ignored, a missing score counts as 0
	st = UIMath.group_stats([{"pos_mm": Vector2(1, 1), "score": 7}, {"score": 10}, {"pos_mm": Vector2(4, 5)}, "junk"])
	if st["count"] != 2 or st["total_score"] != 7 or not _near(st["extreme_spread_mm"], 5.0):
		f.append("malformed hits: %s" % [st])

	# large groups go through the convex-hull path: must equal brute force
	var rng := RandomNumberGenerator.new()
	rng.seed = 20240611
	for trial in 6:
		var pts := PackedVector2Array()
		for i in 60 + trial * 90:
			pts.append(Vector2(rng.randfn(0.0, 45.0), rng.randfn(0.0, 30.0)))
		var brute: Array = UIMath.extreme_pair(pts)
		var fast: Dictionary = UIMath.points_stats(pts)
		if not _near(fast["extreme_spread_mm"], brute[0], 1e-3):
			f.append("hull ES (n=%d): %f vs brute %f" % [pts.size(), fast["extreme_spread_mm"], brute[0]])
		if not _near((fast["es_a"] as Vector2).distance_to(fast["es_b"]), brute[0], 1e-3):
			f.append("hull ES pair does not span the spread (n=%d)" % pts.size())
	# all shots through one hole, and all on one line
	var same := PackedVector2Array()
	var line := PackedVector2Array()
	for i in 80:
		same.append(Vector2(3, 4))
		line.append(Vector2(i, 2.0 * i))
	if not _near(UIMath.points_stats(same)["extreme_spread_mm"], 0.0):
		f.append("coincident shots: ES should be 0")
	if not _near(UIMath.points_stats(line)["extreme_spread_mm"], 79.0 * sqrt(5.0), 1e-3):
		f.append("collinear shots: ES %f" % UIMath.points_stats(line)["extreme_spread_mm"])

	# angular size: 1 mm at 1 m = 1 mrad; 29.089 mm at 100 m = 1 MOA
	if not _near(UIMath.mm_to_mrad(50.0, 25.0), 2.0) or UIMath.mm_to_mrad(50.0, 0.0) != 0.0:
		f.append("mm_to_mrad")
	if not _near(UIMath.mrad_to_moa(UIMath.mm_to_mrad(29.0888, 100.0)), 1.0, 1e-4):
		f.append("mrad_to_moa: %f" % UIMath.mrad_to_moa(UIMath.mm_to_mrad(29.0888, 100.0)))

# ------------------------------------------------------------------------------------------------
static func _expect(f: Array, got: String, want: String, what: String) -> void:
	if got != want:
		f.append("%s: expected \"%s\", got \"%s\"" % [what, want, got])

static func _test_formatting(f: Array) -> void:
	_expect(f, UIMath.fmt_mm(7.44), "7.4 mm", "fmt_mm small")
	_expect(f, UIMath.fmt_mm(9.96), "10 mm", "fmt_mm rounding boundary")
	_expect(f, UIMath.fmt_mm(86.4), "86 mm", "fmt_mm")
	_expect(f, UIMath.fmt_mm(-123.6), "124 mm", "fmt_mm negative")
	_expect(f, UIMath.fmt_len(34.4), "34 mm", "fmt_len mm")
	_expect(f, UIMath.fmt_len(99.6), "10.0 cm", "fmt_len boundary")
	_expect(f, UIMath.fmt_len(123.0), "12.3 cm", "fmt_len cm")
	_expect(f, UIMath.fmt_distance(15.0), "15 m", "fmt_distance")
	_expect(f, UIMath.fmt_distance(7.5), "7.5 m", "fmt_distance fraction")
	_expect(f, UIMath.fmt_offset(Vector2(34, -12)), "34 mm right, 12 mm down", "fmt_offset")
	_expect(f, UIMath.fmt_offset(Vector2(-3.2, 0.2)), "3.2 mm left", "fmt_offset one axis")
	_expect(f, UIMath.fmt_offset(Vector2(0.1, -0.3)), "centred", "fmt_offset centred")
	_expect(f, UIMath.fmt_offset(Vector2(-150, 210), true), "15.0 cm left, 21.0 cm up", "fmt_offset cm")
	_expect(f, UIMath.hit_text({"kind": "steel", "distance_m": 15.0}), "Steel  ·  15 m", "steel hit")
	_expect(f, UIMath.hit_text({"kind": "paper", "distance_m": 10.0, "score": 9, "pos_mm": Vector2(34, -12)}, "Lane 2"),
		"Lane 2  ·  10 m  ·  ring 9  ·  34 mm right, 12 mm down", "paper hit")
	_expect(f, UIMath.hit_text({"kind": "paper", "distance_m": 25.0, "score": 0, "pos_mm": Vector2(-260, 10)}),
		"Paper  ·  25 m  ·  off the rings  ·  26.0 cm left, 10 mm up", "paper miss of the rings")
	_expect(f, UIMath.hit_text({"kind": "bottle"}), "Bottle", "hit without distance")
	_expect(f, UIMath.pretty_binding("Escape"), "Esc", "pretty Escape")
	_expect(f, UIMath.pretty_binding("C / Ctrl"), "C / Ctrl", "pretty pair")
	_expect(f, UIMath.pretty_binding("BracketLeft / BracketRight"), "[ / ]", "pretty brackets")
	_expect(f, UIMath.pretty_binding(""), "Unbound", "pretty empty")

# ------------------------------------------------------------------------------------------------
static func _test_settings_round_trip(f: Array) -> void:
	var defaults: Dictionary = SettingsScript.DEFAULTS
	for key: String in UIMath.SLIDERS:
		if not defaults.has(key):
			f.append("slider for unknown setting '%s'" % key)
			continue
		var d: Array = defaults[key]
		if d.size() != 3:
			f.append("slider setting '%s' has no numeric range" % key)
			continue
		var lo := float(d[1])
		var hi := float(d[2])
		var spec: Dictionary = UIMath.SLIDERS[key]
		var scale := float(spec["scale"])
		var step := float(spec["step"])
		# the default and both ends must be representable exactly
		for v: float in [float(d[0]), lo, hi]:
			var back := UIMath.from_slider(key, UIMath.to_slider(key, v), lo, hi)
			if not _near(back, v, 1e-6):
				f.append("%s: %f does not survive the slider round trip (%f)" % [key, v, back])
		# every slider position maps to a value in range and back to the same position
		var n := int(round((hi - lo) * scale / step))
		for i in n + 1:
			var pos := lo * scale + i * step
			var v := UIMath.from_slider(key, pos, lo, hi)
			if v < lo - 1e-6 or v > hi + 1e-6:
				f.append("%s: slider %f gives out-of-range %f" % [key, pos, v])
				break
			if not _near(UIMath.to_slider(key, v), pos, 1e-6):
				f.append("%s: slider %f -> %f -> %f" % [key, pos, v, UIMath.to_slider(key, v)])
				break
			if UIMath.format_setting(key, v) == "":
				f.append("%s: empty label at %f" % [key, v])
				break
		# out-of-range input is clamped
		if not _near(UIMath.from_slider(key, hi * scale + 10.0 * step, lo, hi), hi, 1e-6):
			f.append("%s: no clamp above the range" % key)
	# every numeric float setting has a slider description (so no setting is silently missing from the menu)
	for key: String in defaults:
		var d: Array = defaults[key]
		if d.size() == 3 and d[0] is float and not UIMath.SLIDERS.has(key):
			f.append("numeric setting '%s' has no slider description" % key)
	_expect(f, UIMath.format_setting("fov", 74.0), "74°", "fov label")
	_expect(f, UIMath.format_setting("master_volume", 0.6), "60 %", "volume label")
	_expect(f, UIMath.format_setting("mouse_sensitivity", 0.22), "0.22 °/count", "sensitivity label")
	_expect(f, UIMath.format_setting("hud_scale", 1.75), "175 %", "hud scale label")

	# frame-rate cap: index <-> fps
	for i in UIMath.FPS_STEPS.size():
		if UIMath.fps_to_index(UIMath.index_to_fps(i)) != i:
			f.append("fps step %d does not round-trip" % i)
	if UIMath.index_to_fps(0) != 0 or UIMath.fps_to_index(0) != 0 or UIMath.fps_to_index(-5) != 0:
		f.append("fps: 0 must mean unlimited")
	if UIMath.index_to_fps(UIMath.fps_to_index(143)) != 144 or UIMath.index_to_fps(UIMath.fps_to_index(1000)) != 360 \
			or UIMath.index_to_fps(UIMath.fps_to_index(1)) != 30:
		f.append("fps: nearest step")
	if UIMath.index_to_fps(99) != 360 or UIMath.index_to_fps(-3) != 0:
		f.append("fps: index clamp")
	var cap: Array = defaults["max_fps"]
	if UIMath.FPS_STEPS[UIMath.FPS_STEPS.size() - 1] > int(cap[2]):
		f.append("fps steps exceed the Settings range")
	_expect(f, UIMath.format_fps(0), "Unlimited", "fps label 0")
	_expect(f, UIMath.format_fps(144), "144 fps", "fps label")

# ------------------------------------------------------------------------------------------------
static func _test_bindings(f: Array) -> void:
	var k := InputEventKey.new()
	k.physical_keycode = KEY_R
	var k2 := InputEventKey.new()
	k2.keycode = KEY_R
	var m := InputEventMouseButton.new()
	m.button_index = MOUSE_BUTTON_RIGHT
	if UIMath.event_sig(k) != "key:%d" % KEY_R or UIMath.event_sig(k2) != UIMath.event_sig(k):
		f.append("event_sig key")
	if UIMath.event_sig(m) != "mouse:2" or UIMath.event_sig(InputEventMouseMotion.new()) != "":
		f.append("event_sig mouse")
	var b := {"reload": [UIMath.event_sig(k)], "aim": [UIMath.event_sig(m)], "crouch": ["key:67", "key:4194326"]}
	if UIMath.find_conflict(b, "inspect", UIMath.event_sig(k)) != "reload":
		f.append("find_conflict: key already used")
	if UIMath.find_conflict(b, "reload", UIMath.event_sig(k)) != "":
		f.append("find_conflict: own binding is not a conflict")
	if UIMath.find_conflict(b, "fire", "mouse:2") != "aim" or UIMath.find_conflict(b, "fire", "key:4194326") != "crouch":
		f.append("find_conflict: mouse / secondary binding")
	if UIMath.find_conflict(b, "fire", "mouse:1") != "" or UIMath.find_conflict(b, "fire", "") != "":
		f.append("find_conflict: free input")
	_expect(f, UIMath.event_text(m), "RMB", "event_text mouse")

# ------------------------------------------------------------------------------------------------
static func _test_scale(f: Array) -> void:
	if not _near(UIMath.hud_scale_for(Vector2(1920, 1080), 1.0), 1.0) or not _near(UIMath.menu_scale_for(Vector2(1920, 1080), 1.0), 1.0):
		f.append("scale at 1080p should be 1")
	if not _near(UIMath.hud_scale_for(Vector2(2560, 1440), 1.0), 1440.0 / 1080.0):
		f.append("scale at 1440p follows the height")
	if not _near(UIMath.hud_scale_for(Vector2(1280, 720), 1.0), 0.85):
		f.append("scale at 720p is floored at 0.85 for legibility")
	if not _near(UIMath.hud_scale_for(Vector2(1920, 1080), 1.75), 1.75):
		f.append("user HUD scale applies")
	# menus always keep 1280 x 720 layout units; the HUD keeps 1024 x 540
	for win: Vector2 in [Vector2(1280, 720), Vector2(1920, 1080), Vector2(2560, 1440), Vector2(3840, 2160), Vector2(1280, 1024), Vector2(3440, 1440), Vector2(1366, 768), Vector2(1024, 768), Vector2(800, 600)]:
		for user: float in [0.75, 1.0, 1.75]:
			var ms := UIMath.menu_scale_for(win, user)
			var hs := UIMath.hud_scale_for(win, user)
			if win.x / ms < 1280.0 - 0.01 or win.y / ms < 720.0 - 0.01:
				f.append("menu space too small at %s x%.2f" % [win, user])
			if win.x / hs < 1024.0 - 0.01 or win.y / hs < 540.0 - 0.01:
				f.append("hud space too small at %s x%.2f" % [win, user])
			if ms > hs + 1e-6:
				f.append("menu scale exceeds hud scale at %s" % [win])
	# smallest text (13 units) stays at least 11 px tall at 720p and default scale
	if UIStyle.CAPS * UIMath.hud_scale_for(Vector2(1280, 720), 1.0) < 11.0:
		f.append("caption text below 11 px at 720p")
	if UIStyle.SMALL * UIMath.menu_scale_for(Vector2(1280, 720), 1.0) < 12.0:
		f.append("small text below 12 px at 720p")

# ------------------------------------------------------------------------------------------------
static func _test_contrast(f: Array) -> void:
	if not _near(UIMath.contrast_ratio(Color.WHITE, Color.BLACK), 21.0, 1e-3):
		f.append("contrast white/black should be 21")
	if not _near(UIMath.contrast_ratio(Color(0.5, 0.5, 0.5), Color(0.5, 0.5, 0.5)), 1.0):
		f.append("contrast of equal colours should be 1")
	# WCAG AA (4.5:1) for every text colour on every panel, with the worst backgrounds behind translucent panels
	for hc in [false, true]:
		var pal: Dictionary = UIStyle.palette(hc)
		var need := 7.0 if hc else 4.5
		for panel: String in ["hud_panel", "menu_panel", "dialog_panel"]:
			for text: String in ["text", "text_dim", "text_faint", "warn", "alert", "accent"]:
				for scene: Color in [Color.WHITE, Color.BLACK, Color(0.45, 0.62, 0.9)]:
					var r := UIMath.text_contrast(pal[text], pal[panel], scene)
					if r < need:
						f.append("contrast %s on %s over %s (%s): %.2f < %.1f" % [text, panel, scene, "hc" if hc else "normal", r, need])
		# selected segment / switch: dark text on the light fill
		if UIMath.contrast_ratio(pal["on_light"], pal["light"]) < need:
			f.append("contrast on_light/light (%s)" % ("hc" if hc else "normal"))
		if UIMath.text_contrast(pal["text_dim"], pal["loading_bg"], Color.BLACK) < need:
			f.append("contrast on the loading screen (%s)" % ("hc" if hc else "normal"))

# ------------------------------------------------------------------------------------------------
static func _test_face_view(f: Array) -> void:
	var face := Vector2(450, 600)
	var whole := FaceView.view_rect_mm(face, false, Vector2(10, 10), 30.0, Vector2(800, 600))
	if not whole.is_equal_approx(Rect2(-225, -300, 450, 600)):
		f.append("whole-face view: %s" % [whole])
	var z := FaceView.view_rect_mm(face, true, Vector2(14, -32), 50.0, Vector2(900, 600))
	if not Rect2(-225, -300, 450, 600).grow(0.01).encloses(z):
		f.append("zoomed view leaves the face: %s" % [z])
	if not _near(z.size.x / z.size.y, 1.5, 1e-3):
		f.append("zoomed view does not keep the pane proportions: %s" % [z])
	if not z.grow(-9.0).has_point(Vector2(14, -32) + Vector2(50, 0)) or not z.grow(-9.0).has_point(Vector2(14, -32) - Vector2(0, 50)):
		f.append("zoomed view cuts the group: %s" % [z])
	# a group in the corner: the view is pushed back inside the face
	z = FaceView.view_rect_mm(face, true, Vector2(215, 290), 20.0, Vector2(600, 600))
	if z.end.x > 225.01 or z.end.y > 300.01:
		f.append("corner group view leaves the face: %s" % [z])
	if not _near(FaceView.nice_bar_mm(2.0, 120.0), 50.0) or not _near(FaceView.nice_bar_mm(0.5, 100.0), 200.0) or not _near(FaceView.nice_bar_mm(12.0, 100.0), 5.0):
		f.append("scale bar steps")
