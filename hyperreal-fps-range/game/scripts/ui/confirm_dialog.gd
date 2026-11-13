extends Control
## Small modal question: title, one paragraph, Cancel + (optional) confirm button. Esc cancels.

const UIStyle := preload("res://scripts/ui/ui_style.gd")

var style
var _title: Label
var _text: Label
var _ok: Button
var _cancel: Button
var _on_ok := Callable()
var _prev_focus: Control

func setup(p_style) -> void:
	style = p_style
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	visible = false
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.55)
	dim.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(dim)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var center := CenterContainer.new()
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(center)
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var panel: PanelContainer = style.panel("Dialog")
	center.add_child(panel)
	var m: MarginContainer = style.margin(32, 28, 32, 26)
	panel.add_child(m)
	var col: VBoxContainer = style.vbox(12)
	m.add_child(col)
	_title = style.label("", "H2")
	col.add_child(_title)
	_text = style.wrap_label("", "BodyDim")
	_text.custom_minimum_size.x = 460
	col.add_child(_text)
	col.add_child(style.spacer(0, 8))
	var row: HBoxContainer = style.hbox(12)
	row.alignment = BoxContainer.ALIGNMENT_END
	col.add_child(row)
	_cancel = style.button("Cancel")
	_cancel.custom_minimum_size.x = 120
	_cancel.pressed.connect(cancel)
	row.add_child(_cancel)
	_ok = style.button("OK")
	_ok.custom_minimum_size.x = 120
	_ok.pressed.connect(_accept)
	row.add_child(_ok)

## `ok_text` == "" shows only the cancel button (an explanation rather than a question).
func ask(title: String, text: String, ok_text: String, on_ok: Callable, cancel_text := "Cancel") -> void:
	_title.text = title
	_text.text = text
	_on_ok = on_ok
	_ok.visible = ok_text != ""
	_ok.text = ok_text
	_cancel.text = cancel_text
	if not visible:
		_prev_focus = get_viewport().gui_get_focus_owner()
	visible = true
	UIStyle.trap_row([_cancel, _ok] if _ok.visible else [_cancel])
	_cancel.grab_focus()

func is_open() -> bool:
	return visible

func _accept() -> void:
	var cb := _on_ok
	_close()
	if cb.is_valid():
		cb.call()

func cancel() -> void:
	_close()

## Close without restoring focus (the screen below is going away).
func dismiss() -> void:
	_prev_focus = null
	visible = false
	_on_ok = Callable()

func _close() -> void:
	visible = false
	_on_ok = Callable()
	if _prev_focus != null and is_instance_valid(_prev_focus) and _prev_focus.is_visible_in_tree():
		_prev_focus.grab_focus()
	_prev_focus = null
