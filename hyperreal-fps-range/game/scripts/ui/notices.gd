extends Control
## Transient notices drawn above everything else in play: one-line toasts (bottom centre) and the short
## dip to black used while a target stand is moved.

const UIStyle := preload("res://scripts/ui/ui_style.gd")

var style
## Optional: returns Array[Rect2] (in this layer's units) that a toast should not cover - the HUD corner panels.
var obstacles := Callable()
const TOAST_LIFT := 120.0
var _toast_panel: PanelContainer
var _toast_label: Label
var _toast_t := 0.0
var _toast_total := 0.0

var _fade_rect: ColorRect
var _fade_label: Label
var _fade_tween: Tween

func setup(p_style) -> void:
	style = p_style
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	_toast_panel = style.panel("HudPanel")
	_toast_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_toast_panel)
	UIStyle.pin(_toast_panel, Vector2(0.5, 1), Vector2(0, -120))
	_toast_label = style.label("", "Body")
	_toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_toast_panel.add_child(_toast_label)
	_toast_panel.visible = false

	_fade_rect = ColorRect.new()
	_fade_rect.color = Color(0, 0, 0, 1)
	_fade_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_fade_rect)
	_fade_rect.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_fade_label = style.label("", "H2")
	_fade_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_fade_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_fade_label.add_theme_color_override("font_color", style.c("text_dim"))
	_fade_rect.add_child(_fade_label)
	_fade_label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_fade_rect.modulate.a = 0.0
	_fade_rect.visible = false
	set_process(false)

## One line, bottom centre. A new toast replaces the current one.
func toast(text: String, seconds := 2.5) -> void:
	_toast_label.text = text.replace("\n", " ")
	# sit at the bottom centre, but above any corner panel the line would otherwise cross (small windows, large HUD scale)
	var lift := TOAST_LIFT
	if obstacles.is_valid():
		var w := _toast_panel.get_combined_minimum_size().x
		var x0 := (size.x - w) * 0.5 - 16.0
		var x1 := (size.x + w) * 0.5 + 16.0
		for r: Rect2 in obstacles.call():
			if r.end.x > x0 and r.position.x < x1:
				lift = maxf(lift, size.y - r.position.y + 14.0)
	_toast_panel.set_meta("pin_offset", Vector2(0, -lift))
	UIStyle.repin(_toast_panel)
	_toast_total = maxf(seconds, 0.3)
	_toast_t = _toast_total
	_toast_panel.modulate.a = 0.0
	_toast_panel.visible = true
	set_process(true)

func clear_toast() -> void:
	_toast_t = 0.0
	_toast_panel.visible = false
	set_process(false)

func _process(delta: float) -> void:
	_toast_t -= delta
	if _toast_t <= 0.0:
		_toast_panel.visible = false
		set_process(false)
		return
	var fade_in := clampf((_toast_total - _toast_t) / 0.18, 0.0, 1.0)
	var fade_out := clampf(_toast_t / 0.6, 0.0, 1.0)
	_toast_panel.modulate.a = minf(fade_in, fade_out)

## Quick dip to black with a line of text; `seconds` is the time spent fully black.
func fade_notice(text: String, seconds := 0.6) -> void:
	var soft := Settings.getb("reduce_flashes")
	var t_in := 0.26 if soft else 0.14
	var t_out := 0.5 if soft else 0.3
	_fade_label.text = text
	_fade_rect.visible = true
	if _fade_tween != null and _fade_tween.is_valid():
		_fade_tween.kill()
	_fade_tween = create_tween()
	_fade_tween.tween_property(_fade_rect, "modulate:a", 1.0, t_in * (1.0 - _fade_rect.modulate.a))
	_fade_tween.tween_interval(maxf(seconds, 0.0))
	_fade_tween.tween_property(_fade_rect, "modulate:a", 0.0, t_out)
	_fade_tween.tween_callback(func() -> void: _fade_rect.visible = false)

func is_fading() -> bool:
	return _fade_rect.visible
