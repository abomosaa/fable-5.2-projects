extends Node
## Persistent user settings (user://settings.cfg). Every consumer reads through get_value()
## and listens to `changed(key)`; the menu writes through set_value().

signal changed(key: String)

const SAVE_PATH := "user://settings.cfg"

## key -> [default, min, max] (min/max only for numbers)
const DEFAULTS := {
	# --- view / input
	"fov": [62.0, 50.0, 95.0],                  # vertical field of view, degrees (62 vertical = 93 horizontal at 16:9)
	"ads_fov_scale": [0.76, 0.5, 1.0],           # FOV multiplier while aiming
	"mouse_sensitivity": [0.22, 0.02, 1.0],      # degrees per mouse count
	"ads_sensitivity_scale": [0.7, 0.2, 1.0],
	"invert_y": [false],
	"aim_toggle": [false],                       # false = hold to aim
	"crouch_toggle": [true],
	"camera_motion": [1.0, 0.0, 1.5],            # scales head bob, landing dip and recoil camera kick
	"weapon_sway": [1.0, 0.0, 1.5],
	"motion_blur": [false],                      # this build renders no motion blur; kept so the choice is explicit
	# --- audio
	"master_volume": [0.6, 0.0, 1.0],            # conservative start level
	"ambience_volume": [0.8, 0.0, 1.0],
	"dynamic_range": ["full"],                   # "full" | "headphones" (compressed) | "night" (heavily compressed)
	"spatial_mode": ["hrtf"],                    # "hrtf" (binaural) | "stereo"
	"distant_range": [true],                     # occasional distant shots from a neighbouring range
	# --- graphics
	"quality": ["high"],                         # low | medium | high | ultra
	"render_scale": [1.0, 0.5, 1.0],
	"vsync": [true],
	"max_fps": [0, 0, 360],
	"fullscreen": [false],
	# --- practice / accessibility
	"controls_overlay": [true],
	"practice_overlay": [false],                 # rounds / magazine / last hit read-out
	"aim_dot": [false],                          # optional centre dot (accessibility)
	"high_contrast_hud": [false],
	"hud_scale": [1.0, 0.75, 1.75],
	"reduce_flashes": [false],                   # dims muzzle flash and exposure pumping
	"hit_feedback": [false],
	"perf_readout": [false],                     # small fps / frame-time read-out                     # optional subtle text feedback on steel/paper hits
}

var _values := {}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for k in DEFAULTS:
		_values[k] = DEFAULTS[k][0]
	_load()

func get_value(key: String) -> Variant:
	return _values.get(key, DEFAULTS[key][0] if DEFAULTS.has(key) else null)

func getf(key: String) -> float:
	return float(get_value(key))

func getb(key: String) -> bool:
	return bool(get_value(key))

func gets(key: String) -> String:
	return str(get_value(key))

func set_value(key: String, value: Variant, persist := true) -> void:
	if not DEFAULTS.has(key):
		push_warning("Unknown setting: " + key)
		return
	var d: Array = DEFAULTS[key]
	if d.size() == 3 and (value is float or value is int):
		value = clampf(float(value), float(d[1]), float(d[2]))
		if d[0] is int:
			value = int(value)
	if typeof(value) != typeof(d[0]):
		if d[0] is float and value is int:
			value = float(value)
		elif d[0] is bool:
			value = bool(value)
		else:
			return
	if _values.get(key) == value:
		return
	_values[key] = value
	if persist:
		save()
	changed.emit(key)

func reset_all() -> void:
	for k in DEFAULTS:
		set_value(k, DEFAULTS[k][0], false)
	save()

func range_of(key: String) -> Array:
	var d: Array = DEFAULTS[key]
	return [d[1], d[2]] if d.size() == 3 else []

func save() -> void:
	var cfg := ConfigFile.new()
	for k in _values:
		cfg.set_value("settings", k, _values[k])
	cfg.save(SAVE_PATH)

func _load() -> void:
	var cfg := ConfigFile.new()
	if cfg.load(SAVE_PATH) != OK:
		return
	for k in DEFAULTS:
		if cfg.has_section_key("settings", k):
			var v: Variant = cfg.get_value("settings", k)
			if typeof(v) == typeof(DEFAULTS[k][0]) or (DEFAULTS[k][0] is float and v is int):
				set_value(k, v, false)
