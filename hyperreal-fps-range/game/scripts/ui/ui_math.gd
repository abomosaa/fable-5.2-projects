extends RefCounted
## Pure helpers for the UI (no scene access, no autoloads): shot-group statistics, unit formatting,
## settings <-> widget mapping, binding helpers and WCAG contrast. Covered by tests/test_ui_math.gd.
##
## Units: every length that comes from a paper target is millimetres on the target face
## (x to the right, y up, origin at the target centre). Distances to targets are metres.

# ------------------------------------------------------------------------------------------------
# Shot-group statistics
# ------------------------------------------------------------------------------------------------

## Statistics of a list of hit dictionaries (`pos_mm: Vector2`, `score: int`), as returned by a paper
## target's get_hits(). Entries without a Vector2 `pos_mm` are ignored.
static func group_stats(hits: Array) -> Dictionary:
	var pts := PackedVector2Array()
	var total := 0
	for h in hits:
		if h is Dictionary and h.get("pos_mm") is Vector2:
			pts.append(h["pos_mm"])
			total += int(h.get("score", 0))
	var st := points_stats(pts)
	st["total_score"] = total
	st["points"] = pts
	return st

## count, center (mean point, mm), mean_radius_mm (mean distance of the shots from the group centre),
## extreme_spread_mm (largest centre-to-centre distance between any two shots) and the two points
## that define it (es_a, es_b), max_radius_mm (farthest shot from the group centre).
static func points_stats(pts: PackedVector2Array) -> Dictionary:
	var n := pts.size()
	var st := {
		"count": n, "center": Vector2.ZERO, "mean_radius_mm": 0.0, "max_radius_mm": 0.0,
		"extreme_spread_mm": 0.0, "es_a": Vector2.ZERO, "es_b": Vector2.ZERO, "total_score": 0,
	}
	if n == 0:
		return st
	var c := Vector2.ZERO
	for p in pts:
		c += p
	c /= float(n)
	var sum_r := 0.0
	var max_r := 0.0
	for p in pts:
		var r := p.distance_to(c)
		sum_r += r
		max_r = maxf(max_r, r)
	st["center"] = c
	st["mean_radius_mm"] = sum_r / float(n)
	st["max_radius_mm"] = max_r
	st["es_a"] = pts[0]
	st["es_b"] = pts[0]
	if n >= 2:
		# The farthest pair always lies on the convex hull; reduce large groups first.
		var cand := pts
		if n > 48:
			var hull := Geometry2D.convex_hull(pts)
			if hull.size() >= 2:
				cand = hull
		var es := extreme_pair(cand)
		st["extreme_spread_mm"] = es[0]
		st["es_a"] = es[1]
		st["es_b"] = es[2]
	return st

## Brute-force farthest pair: [distance, a, b].
static func extreme_pair(pts: PackedVector2Array) -> Array:
	var best := -1.0
	var a := Vector2.ZERO
	var b := Vector2.ZERO
	var n := pts.size()
	for i in n:
		var pi := pts[i]
		for j in range(i + 1, n):
			var d := pi.distance_squared_to(pts[j])
			if d > best:
				best = d
				a = pi
				b = pts[j]
	if best < 0.0:
		if n == 1:
			return [0.0, pts[0], pts[0]]
		return [0.0, Vector2.ZERO, Vector2.ZERO]
	return [sqrt(best), a, b]

## Angle subtended by a size on the target (mm) at a distance (m), in milliradians.
## 1 mm at 1 m is 1 mrad (small-angle; exact to better than 0.01 % for group-sized angles).
static func mm_to_mrad(size_mm: float, distance_m: float) -> float:
	if distance_m <= 0.0:
		return 0.0
	return size_mm / distance_m

## Milliradians -> minutes of angle (1 mrad = 3.43775 MOA).
static func mrad_to_moa(mrad: float) -> float:
	return mrad * 3.4377467707849396

# ------------------------------------------------------------------------------------------------
# Formatting
# ------------------------------------------------------------------------------------------------

## "0.0 mm" below 10 mm, whole millimetres above. Always millimetres (group statistics).
static func fmt_mm(v: float) -> String:
	var a := absf(v)
	if a < 9.95:
		return "%.1f mm" % a
	return "%d mm" % int(round(a))

## Millimetres below 100 mm, centimetres with one decimal above (last-shot read-out).
static func fmt_len(v_mm: float) -> String:
	var a := absf(v_mm)
	if a < 99.5:
		return "%d mm" % int(round(a))
	return "%.1f cm" % (a / 10.0)

## "15 m", "7.5 m".
static func fmt_distance(m: float) -> String:
	if absf(m - round(m)) < 0.05:
		return "%d m" % int(round(m))
	return "%.1f m" % m

## Offset of a point from the target centre in words: "34 mm right, 12 mm down", "centred".
## `use_cm` switches to fmt_len (mm/cm) instead of fmt_mm.
static func fmt_offset(offset_mm: Vector2, use_cm := false) -> String:
	var parts: PackedStringArray = []
	if absf(offset_mm.x) >= 0.5:
		var sx := fmt_len(offset_mm.x) if use_cm else fmt_mm(offset_mm.x)
		parts.append(sx + (" right" if offset_mm.x > 0.0 else " left"))
	if absf(offset_mm.y) >= 0.5:
		var sy := fmt_len(offset_mm.y) if use_cm else fmt_mm(offset_mm.y)
		parts.append(sy + (" up" if offset_mm.y > 0.0 else " down"))
	if parts.is_empty():
		return "centred"
	return ", ".join(parts)

## One calm line for the last hit. `info` is the Targets `target_hit` dictionary
## (`kind`, `distance_m`, optional `score`, `pos_mm`); `label` is the target's label if known.
static func hit_text(info: Dictionary, label := "") -> String:
	var kind := str(info.get("kind", "target"))
	var parts: PackedStringArray = []
	var has_pos: bool = info.get("pos_mm") is Vector2
	if kind == "paper" or has_pos:
		parts.append(label if label != "" else "Paper")
	else:
		parts.append(kind.capitalize() if label == "" else label)
	if info.has("distance_m"):
		parts.append(fmt_distance(float(info["distance_m"])))
	if has_pos:
		if info.has("score"):
			var sc := int(info["score"])
			parts.append("ring %d" % sc if sc > 0 else "off the rings")
		parts.append(fmt_offset(info["pos_mm"], true))
	return "  ·  ".join(parts)

## Friendlier key names for the overlay and the controls screen ("Escape" -> "Esc", "BracketLeft" -> "[").
const KEY_ALIASES := {
	"Escape": "Esc", "BracketLeft": "[", "BracketRight": "]", "Semicolon": ";", "Apostrophe": "'",
	"Comma": ",", "Period": ".", "Minus": "-", "Equal": "=", "QuoteLeft": "`", "BackSlash": "\\",
	"PageUp": "PgUp", "PageDown": "PgDn", "Delete": "Del", "Insert": "Ins", "CapsLock": "Caps",
}

static func pretty_binding(text: String) -> String:
	if text.strip_edges() == "":
		return "Unbound"
	var parts := text.split(" / ")
	for i in parts.size():
		var p := parts[i].strip_edges()
		parts[i] = KEY_ALIASES.get(p, p)
	return " / ".join(parts)

# ------------------------------------------------------------------------------------------------
# Bindings
# ------------------------------------------------------------------------------------------------

## Stable identity of a key / mouse-button event: "key:82", "mouse:1"; "" for anything else.
static func event_sig(ev: InputEvent) -> String:
	if ev is InputEventKey:
		var code: int = ev.physical_keycode if ev.physical_keycode != 0 else ev.keycode
		return "key:%d" % code
	if ev is InputEventMouseButton:
		return "mouse:%d" % ev.button_index
	return ""

## Display name of one key / mouse-button event, in the same vocabulary as Controls.binding_text().
static func event_text(ev: InputEvent) -> String:
	if ev is InputEventKey:
		var code: int = ev.physical_keycode if ev.physical_keycode != 0 else ev.keycode
		return pretty_binding(OS.get_keycode_string(code))
	if ev is InputEventMouseButton:
		match ev.button_index:
			MOUSE_BUTTON_LEFT: return "LMB"
			MOUSE_BUTTON_RIGHT: return "RMB"
			MOUSE_BUTTON_MIDDLE: return "MMB"
		return "Mouse %d" % ev.button_index
	return ""

## First action in `bindings` (action -> Array of signatures) other than `action` that already uses `sig`.
static func find_conflict(bindings: Dictionary, action: String, sig: String) -> String:
	if sig == "":
		return ""
	for other in bindings:
		if other == action:
			continue
		if (bindings[other] as Array).has(sig):
			return other
	return ""

# ------------------------------------------------------------------------------------------------
# Settings <-> widgets
# ------------------------------------------------------------------------------------------------

## How numeric settings are shown: display = value * scale, moved in `step` display units.
## `fmt` receives the display value. Keys not listed here are not shown as plain sliders.
const SLIDERS := {
	"fov": {"scale": 1.0, "step": 1.0, "fmt": "%d°"},
	"ads_fov_scale": {"scale": 100.0, "step": 1.0, "fmt": "%d %%"},
	"mouse_sensitivity": {"scale": 1.0, "step": 0.01, "fmt": "%.2f °/count"},
	"ads_sensitivity_scale": {"scale": 100.0, "step": 5.0, "fmt": "%d %%"},
	"camera_motion": {"scale": 100.0, "step": 5.0, "fmt": "%d %%"},
	"weapon_sway": {"scale": 100.0, "step": 5.0, "fmt": "%d %%"},
	"master_volume": {"scale": 100.0, "step": 1.0, "fmt": "%d %%"},
	"ambience_volume": {"scale": 100.0, "step": 1.0, "fmt": "%d %%"},
	"render_scale": {"scale": 100.0, "step": 5.0, "fmt": "%d %%"},
	"hud_scale": {"scale": 100.0, "step": 5.0, "fmt": "%d %%"},
}

## Setting value -> slider (display) value, snapped to the slider step.
static func to_slider(key: String, value: float) -> float:
	var s: Dictionary = SLIDERS[key]
	return snappedf(value * float(s["scale"]), float(s["step"]))

## Slider (display) value -> setting value, clamped to [lo, hi] (the Settings range).
static func from_slider(key: String, slider_value: float, lo: float, hi: float) -> float:
	var s: Dictionary = SLIDERS[key]
	var disp := snappedf(slider_value, float(s["step"]))
	# snap in setting units too so that 0.07 * 100 / 100 does not drift
	var v := snappedf(disp / float(s["scale"]), float(s["step"]) / float(s["scale"]))
	return clampf(v, lo, hi)

static func format_setting(key: String, value: float) -> String:
	var s: Dictionary = SLIDERS[key]
	var disp := to_slider(key, value)
	var f: String = s["fmt"]
	if f.contains("%d"):
		return f % int(round(disp))
	return f % disp

## Frame-rate cap choices; 0 = no cap.
const FPS_STEPS: Array[int] = [0, 30, 40, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240, 300, 360]

static func fps_to_index(fps: int) -> int:
	if fps <= 0:
		return 0
	var best := 1
	var best_d := 1 << 30
	for i in range(1, FPS_STEPS.size()):
		var d := absi(FPS_STEPS[i] - fps)
		if d < best_d:
			best_d = d
			best = i
	return best

static func index_to_fps(index: int) -> int:
	return FPS_STEPS[clampi(index, 0, FPS_STEPS.size() - 1)]

static func format_fps(fps: int) -> String:
	return "Unlimited" if fps <= 0 else "%d fps" % fps

# ------------------------------------------------------------------------------------------------
# Scale
# ------------------------------------------------------------------------------------------------

## HUD scale for a window: proportional to height (reference 1080) but never below 0.85 so that text
## stays readable at 720p, times the user's HUD scale, and limited so that at least 1024 x 540 layout
## units remain (room for both corner panels side by side).
static func hud_scale_for(window: Vector2, user_scale: float) -> float:
	if window.x <= 0.0 or window.y <= 0.0:
		return 1.0
	var s := maxf(window.y / 1080.0, 0.85) * user_scale
	s = minf(s, minf(window.x / 1024.0, window.y / 540.0))
	return maxf(s, 0.25)

## Menus follow the HUD scale but always keep at least 1280 x 720 layout units.
static func menu_scale_for(window: Vector2, user_scale: float) -> float:
	var s := hud_scale_for(window, user_scale)
	s = minf(s, minf(window.x / 1280.0, window.y / 720.0))
	return maxf(s, 0.25)

# ------------------------------------------------------------------------------------------------
# Contrast (WCAG 2.x)
# ------------------------------------------------------------------------------------------------

static func _lin(c: float) -> float:
	return c / 12.92 if c <= 0.04045 else pow((c + 0.055) / 1.055, 2.4)

static func relative_luminance(c: Color) -> float:
	return 0.2126 * _lin(c.r) + 0.7152 * _lin(c.g) + 0.0722 * _lin(c.b)

## Alpha-composite `fg` over an opaque `bg` (in display space, as the canvas blends).
static func composite(fg: Color, bg: Color) -> Color:
	return Color(lerpf(bg.r, fg.r, fg.a), lerpf(bg.g, fg.g, fg.a), lerpf(bg.b, fg.b, fg.a), 1.0)

static func contrast_ratio(a: Color, b: Color) -> float:
	var la := relative_luminance(a)
	var lb := relative_luminance(b)
	return (maxf(la, lb) + 0.05) / (minf(la, lb) + 0.05)

## Contrast of `text` drawn on a translucent `panel` that sits over the opaque `scene` colour.
static func text_contrast(text: Color, panel: Color, scene: Color) -> float:
	var bg := composite(panel, scene)
	return contrast_ratio(composite(text, bg), bg)
