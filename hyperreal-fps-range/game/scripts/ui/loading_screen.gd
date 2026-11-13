extends Control
## Plain loading screen: title, progress, current step, the two standing notes.

var style
var _bar_fill: ColorRect
var _bar_track: ColorRect
var _step: Label
var _pct: Label
var _progress := 0.0

func setup(p_style) -> void:
	style = p_style
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	var bg := ColorRect.new()
	bg.color = style.c("loading_bg")
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(center)
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var col: VBoxContainer = style.vbox(0)
	col.custom_minimum_size.x = 520
	center.add_child(col)
	col.add_child(style.caps("Pistol range simulation", "Caps"))
	col.add_child(style.spacer(0, 6))
	col.add_child(style.label("Range Day", "Title"))
	col.add_child(style.spacer(0, 34))
	_bar_track = ColorRect.new()
	_bar_track.color = Color(style.c("text"), 0.16)
	_bar_track.custom_minimum_size = Vector2(520, 2)
	_bar_track.mouse_filter = Control.MOUSE_FILTER_IGNORE
	col.add_child(_bar_track)
	_bar_fill = ColorRect.new()
	_bar_fill.color = style.c("light")
	_bar_fill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_bar_track.add_child(_bar_fill)
	_bar_fill.anchor_bottom = 1.0
	_bar_fill.anchor_right = 0.0
	col.add_child(style.spacer(0, 14))
	var row: HBoxContainer = style.hbox(12)
	col.add_child(row)
	_step = style.label("", "SmallDim")
	_step.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_step.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_step.clip_text = true
	row.add_child(_step)
	_pct = style.label("0 %", "SmallValue")
	_pct.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	row.add_child(_pct)

	var notes: VBoxContainer = style.vbox(6)
	notes.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(notes)
	notes.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	notes.grow_vertical = Control.GROW_DIRECTION_BEGIN
	notes.offset_bottom = -56
	notes.offset_left = 40
	notes.offset_right = -40
	for line in ["Entertainment simulation — not firearms instruction.",
			"Audio starts at a conservative level. Raise it gradually in Settings › Audio; never to an uncomfortable level."]:
		var l: Label = style.wrap_label(line, "SmallDim")
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		notes.add_child(l)

func set_progress(progress: float, text: String) -> void:
	_progress = clampf(progress, 0.0, 1.0)
	_bar_fill.anchor_right = _progress
	_bar_fill.offset_right = 0.0
	_step.text = text
	_pct.text = "%d %%" % int(round(_progress * 100.0))
