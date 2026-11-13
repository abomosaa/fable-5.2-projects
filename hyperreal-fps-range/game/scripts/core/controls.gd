extends Node
## Input actions: defaults, runtime remapping, persistence (user://controls.cfg).
## Actions are created in code so that a fresh install and a remapped one go through the same path.

signal bindings_changed

const SAVE_PATH := "user://controls.cfg"

## action -> [label, default events]; an event is ["key", physical_keycode] or ["mouse", button_index]
const ACTIONS := {
	"move_forward": ["Move forward", [["key", KEY_W]]],
	"move_back": ["Move back", [["key", KEY_S]]],
	"move_left": ["Move left", [["key", KEY_A]]],
	"move_right": ["Move right", [["key", KEY_D]]],
	"jog": ["Jog (hold)", [["key", KEY_SHIFT]]],
	"crouch": ["Crouch", [["key", KEY_C], ["key", KEY_CTRL]]],
	"fire": ["Trigger", [["mouse", MOUSE_BUTTON_LEFT]]],
	"aim": ["Aim down sights", [["mouse", MOUSE_BUTTON_RIGHT]]],
	"steady": ["Steady aim / hold breath", [["key", KEY_ALT]]],
	"reload": ["Reload", [["key", KEY_R]]],
	"inspect": ["Inspect pistol", [["key", KEY_F]]],
	"safety": ["Safety / decock lever", [["key", KEY_V]]],
	"cock_hammer": ["Cock hammer", [["key", KEY_G]]],
	"target_nearer": ["Paper target nearer", [["key", KEY_BRACKETLEFT]]],
	"target_farther": ["Paper target farther", [["key", KEY_BRACKETRIGHT]]],
	"reset_targets": ["Reset targets", [["key", KEY_BACKSPACE]]],
	"restart_session": ["Restart session", [["key", KEY_F5]]],
	"inspect_group": ["Inspect shot group", [["key", KEY_T]]],
	"toggle_overlay": ["Toggle controls / practice overlay", [["key", KEY_F1]]],
	"pause": ["Pause / menu", [["key", KEY_ESCAPE]]],
}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	reset_to_defaults(false)
	_load()

static func _make_event(e: Array) -> InputEvent:
	if e[0] == "key":
		var k := InputEventKey.new()
		k.physical_keycode = e[1]
		return k
	var m := InputEventMouseButton.new()
	m.button_index = e[1]
	return m

func reset_to_defaults(emit := true) -> void:
	for action in ACTIONS:
		if not InputMap.has_action(action):
			InputMap.add_action(action, 0.2)
		InputMap.action_erase_events(action)
		for e in ACTIONS[action][1]:
			InputMap.action_add_event(action, _make_event(e))
	if emit:
		save()
		bindings_changed.emit()

func label(action: String) -> String:
	return ACTIONS[action][0]

func list_actions() -> Array:
	return ACTIONS.keys()

## Replace all bindings of an action with one event (key or mouse button).
func rebind(action: String, event: InputEvent) -> void:
	if not ACTIONS.has(action):
		return
	var ev: InputEvent
	if event is InputEventKey:
		var k := InputEventKey.new()
		k.physical_keycode = event.physical_keycode if event.physical_keycode != 0 else event.keycode
		ev = k
	elif event is InputEventMouseButton:
		var m := InputEventMouseButton.new()
		m.button_index = event.button_index
		ev = m
	else:
		return
	InputMap.action_erase_events(action)
	InputMap.action_add_event(action, ev)
	save()
	bindings_changed.emit()

## Human readable binding, e.g. "W", "LMB", "C / Ctrl".
func binding_text(action: String) -> String:
	var parts: PackedStringArray = []
	for ev in InputMap.action_get_events(action):
		if ev is InputEventKey:
			var code: int = ev.physical_keycode if ev.physical_keycode != 0 else ev.keycode
			parts.append(OS.get_keycode_string(code))
		elif ev is InputEventMouseButton:
			match ev.button_index:
				MOUSE_BUTTON_LEFT: parts.append("LMB")
				MOUSE_BUTTON_RIGHT: parts.append("RMB")
				MOUSE_BUTTON_MIDDLE: parts.append("MMB")
				_: parts.append("Mouse %d" % ev.button_index)
	return " / ".join(parts)

func save() -> void:
	var cfg := ConfigFile.new()
	for action in ACTIONS:
		var arr := []
		for ev in InputMap.action_get_events(action):
			if ev is InputEventKey:
				arr.append(["key", ev.physical_keycode if ev.physical_keycode != 0 else ev.keycode])
			elif ev is InputEventMouseButton:
				arr.append(["mouse", ev.button_index])
		cfg.set_value("bindings", action, arr)
	cfg.save(SAVE_PATH)

func _load() -> void:
	var cfg := ConfigFile.new()
	if cfg.load(SAVE_PATH) != OK:
		return
	for action in ACTIONS:
		var arr: Variant = cfg.get_value("bindings", action, null)
		if arr is Array and arr.size() > 0:
			InputMap.action_erase_events(action)
			for e in arr:
				if e is Array and e.size() == 2:
					InputMap.action_add_event(action, _make_event(e))
