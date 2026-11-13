extends Control
## Key bindings: every action with its current binding; Enter / click starts a capture, Esc cancels it.
## Conflicts are reported with a swap offer. The pause action always keeps a keyboard key.

const UIStyle := preload("res://scripts/ui/ui_style.gd")
const UIMath := preload("res://scripts/ui/ui_math.gd")

signal back_requested

const MAX_SIZE := Vector2(1160, 800)
const PAUSE_ACTION := "pause"

var style
var ui: Node
var _panel: PanelContainer
var _actions: Array = []
var _buttons := {}                   # action -> Button
var _reset_btn: Button
var _back_btn: Button

var _capturing := ""
var _capture_layer: Control
var _capture_action: Label
var _capture_msg: Label

func setup(p_style, p_ui: Node) -> void:
	style = p_style
	ui = p_ui
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel = style.panel()
	add_child(_panel)
	var m: MarginContainer = style.margin(40, 30, 40, 26)
	_panel.add_child(m)
	var col: VBoxContainer = style.vbox(0)
	m.add_child(col)

	var head: HBoxContainer = style.hbox(16)
	col.add_child(head)
	head.add_child(style.label("Controls", "H1"))
	head.add_child(style.spacer(0, 0, true))
	var hint: Label = style.label("Enter or click  rebind    Esc  back", "SmallFaint")
	hint.size_flags_vertical = Control.SIZE_SHRINK_END
	head.add_child(hint)
	col.add_child(style.spacer(0, 14))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 12))

	var sc := ScrollContainer.new()
	sc.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	sc.follow_focus = true
	sc.size_flags_vertical = Control.SIZE_EXPAND_FILL
	col.add_child(sc)
	var pad: MarginContainer = style.margin(0, 0, 18, 0)
	pad.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	sc.add_child(pad)
	var cols: HBoxContainer = style.hbox(40)
	pad.add_child(cols)

	_actions = Controls.list_actions()
	var half := int(ceil(_actions.size() / 2.0))
	for ci in 2:
		var list: VBoxContainer = style.vbox(2)
		list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cols.add_child(list)
		if ci == 0:
			cols.add_child(style.vline())
		for i in range(ci * half, mini((ci + 1) * half, _actions.size())):
			var action: String = _actions[i]
			var rp: PanelContainer = style.panel("Row")
			var row: HBoxContainer = style.hbox(16)
			rp.add_child(row)
			var name_l: Label = style.label(Controls.label(action), "Body")
			name_l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			name_l.clip_text = true
			name_l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
			row.add_child(name_l)
			var b: Button = style.button("", "Key")
			b.custom_minimum_size = Vector2(168, 34)
			b.pressed.connect(_begin_capture.bind(action))
			b.focus_entered.connect(func() -> void: rp.theme_type_variation = "RowFocus")
			b.focus_exited.connect(func() -> void: rp.theme_type_variation = "Row")
			row.add_child(b)
			list.add_child(rp)
			_buttons[action] = b

	col.add_child(style.spacer(0, 12))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 16))
	var foot: HBoxContainer = style.hbox(12)
	col.add_child(foot)
	_reset_btn = style.button("Reset bindings")
	_reset_btn.pressed.connect(_ask_reset)
	foot.add_child(_reset_btn)
	var note: Label = style.label("Esc always cancels and goes back; it cannot be assigned to another action.", "SmallFaint")
	note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	note.clip_text = true
	note.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	foot.add_child(note)
	_back_btn = style.button("Back")
	_back_btn.custom_minimum_size.x = 120
	_back_btn.pressed.connect(func() -> void: back_requested.emit())
	foot.add_child(_back_btn)

	_build_capture_layer()
	_link(half)
	_refresh()
	Controls.bindings_changed.connect(_refresh)

func _build_capture_layer() -> void:
	_capture_layer = Control.new()
	_capture_layer.mouse_filter = Control.MOUSE_FILTER_STOP
	_capture_layer.visible = false
	add_child(_capture_layer)
	_capture_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.6)
	dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_capture_layer.add_child(dim)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_capture_layer.add_child(center)
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var panel: PanelContainer = style.panel("Dialog")
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	center.add_child(panel)
	var m: MarginContainer = style.margin(40, 30, 40, 30)
	panel.add_child(m)
	var col: VBoxContainer = style.vbox(8)
	col.custom_minimum_size.x = 440
	m.add_child(col)
	col.add_child(style.caps("Rebind", "Caps"))
	_capture_action = style.label("", "H2")
	col.add_child(_capture_action)
	col.add_child(style.spacer(0, 8))
	col.add_child(style.label("Press a key or mouse button… (Esc to cancel)", "Body"))
	_capture_msg = style.wrap_label("", "Warn")
	_capture_msg.custom_minimum_size.x = 440
	_capture_msg.visible = false
	col.add_child(_capture_msg)

func layout(space: Vector2) -> void:
	UIStyle.fit_center(_panel, space, MAX_SIZE, Vector2(40, 30))

func open() -> void:
	_end_capture(false)
	if not _actions.is_empty():
		(_buttons[_actions[0]] as Button).grab_focus()

func is_capturing() -> bool:
	return _capturing != ""

## Esc / back while this screen is up. Returns true if it was consumed here.
func handle_back() -> bool:
	if _capturing != "":
		_end_capture(true)
		return true
	return false

func _refresh() -> void:
	for action: String in _buttons:
		(_buttons[action] as Button).text = UIMath.pretty_binding(Controls.binding_text(action))

func _link(half: int) -> void:
	var n := _actions.size()
	for i in n:
		var b: Button = _buttons[_actions[i]]
		var col := 0 if i < half else 1
		var first := col * half
		var last := mini(first + half, n) - 1
		UIStyle.set_neighbor(b, SIDE_TOP, _buttons[_actions[i - 1]] if i > first else b)
		UIStyle.set_neighbor(b, SIDE_BOTTOM, _buttons[_actions[i + 1]] if i < last else (_reset_btn if col == 0 else _back_btn))
		var other := i + half if col == 0 else i - half
		UIStyle.set_neighbor(b, SIDE_LEFT, _buttons[_actions[other]] if col == 1 else b)
		UIStyle.set_neighbor(b, SIDE_RIGHT, _buttons[_actions[mini(other, n - 1)]] if col == 0 and n > half else b)
	if n > 0:
		UIStyle.set_neighbor(_reset_btn, SIDE_TOP, _buttons[_actions[mini(half, n) - 1]])
		UIStyle.set_neighbor(_back_btn, SIDE_TOP, _buttons[_actions[n - 1]])
	UIStyle.set_neighbor(_reset_btn, SIDE_BOTTOM, _reset_btn)
	UIStyle.set_neighbor(_back_btn, SIDE_BOTTOM, _back_btn)
	UIStyle.set_neighbor(_reset_btn, SIDE_LEFT, _reset_btn)
	UIStyle.set_neighbor(_reset_btn, SIDE_RIGHT, _back_btn)
	UIStyle.set_neighbor(_back_btn, SIDE_LEFT, _reset_btn)
	UIStyle.set_neighbor(_back_btn, SIDE_RIGHT, _back_btn)

# ------------------------------------------------------------------------------------------------
# Capture
# ------------------------------------------------------------------------------------------------

func _begin_capture(action: String) -> void:
	_capturing = action
	_capture_action.text = Controls.label(action)
	_capture_msg.visible = false
	_capture_layer.visible = true

func _end_capture(refocus := true) -> void:
	var action := _capturing
	_capturing = ""
	if _capture_layer != null:
		_capture_layer.visible = false
	if refocus and action != "" and _buttons.has(action) and is_visible_in_tree():
		(_buttons[action] as Button).grab_focus()

func _capture_note(text: String) -> void:
	_capture_msg.text = text
	_capture_msg.visible = true

func _input(event: InputEvent) -> void:
	if _capturing == "" or not is_visible_in_tree():
		return
	if event is InputEventKey:
		get_viewport().set_input_as_handled()
		var k := event as InputEventKey
		if not k.pressed or k.echo:
			return
		var code: int = k.physical_keycode if k.physical_keycode != 0 else k.keycode
		if code == KEY_ESCAPE:
			_end_capture(true)
			return
		if code == KEY_NONE:
			return
		_try_bind(_capturing, k)
	elif event is InputEventMouseButton:
		get_viewport().set_input_as_handled()
		var mb := event as InputEventMouseButton
		if not mb.pressed:
			return
		if mb.button_index >= MOUSE_BUTTON_WHEEL_UP and mb.button_index <= MOUSE_BUTTON_WHEEL_RIGHT:
			_capture_note("The mouse wheel cannot be bound.")
			return
		if _capturing == PAUSE_ACTION:
			_capture_note("“%s” must stay on a keyboard key so the menu can always be reached." % Controls.label(PAUSE_ACTION))
			return
		_try_bind(_capturing, mb)

func _bindings() -> Dictionary:
	var d := {}
	for action: String in _actions:
		var sigs: Array = []
		for ev in InputMap.action_get_events(action):
			sigs.append(UIMath.event_sig(ev))
		d[action] = sigs
	return d

func _try_bind(action: String, event: InputEvent) -> void:
	var sig := UIMath.event_sig(event)
	var conflict := UIMath.find_conflict(_bindings(), action, sig)
	if conflict == "":
		_end_capture(true)
		Controls.rebind(action, event)
		return
	var key_name := UIMath.event_text(event)
	var old: Array = InputMap.action_get_events(action)
	var old_ev: InputEvent = old[0] if not old.is_empty() else null
	_end_capture(true)
	var pause_needs_key := conflict == PAUSE_ACTION and not (old_ev is InputEventKey)
	var old_is_esc := old_ev is InputEventKey and UIMath.event_sig(old_ev) == "key:%d" % KEY_ESCAPE
	if old_ev == null or pause_needs_key or old_is_esc:
		var why := "“%s” must always keep a keyboard key." % Controls.label(conflict)
		if old_is_esc and not pause_needs_key:
			why = "Esc cannot be handed to another action, so the two cannot be swapped."
		ui.confirm("%s is already in use" % key_name,
			"%s is bound to “%s”. %s Rebind “%s” first or choose another key." % [
				key_name, Controls.label(conflict), why, Controls.label(conflict)],
			"", Callable(), "Close")
		return
	var old_name := UIMath.event_text(old_ev)
	ui.confirm("%s is already in use" % key_name,
		"%s is bound to “%s”. Swap the two? “%s” will use %s and “%s” will use %s instead." % [
			key_name, Controls.label(conflict), Controls.label(action), key_name, Controls.label(conflict), old_name],
		"Swap", _swap.bind(action, event, conflict, old_ev))

func _swap(action: String, event: InputEvent, other: String, old_ev: InputEvent) -> void:
	Controls.rebind(action, event)
	Controls.rebind(other, old_ev)

func _ask_reset() -> void:
	ui.confirm("Reset bindings?", "All actions return to their default keys and mouse buttons.",
		"Reset", func() -> void: Controls.reset_to_defaults())
