extends Control
## Row of round pips: `filled` of `total` solid, the rest outlined (magazine rounds).

var total := 8
var filled := 0
var active := true            # false: magazine out - all pips faint outlines
var c_on := Color(0.93, 0.92, 0.9)
var c_off := Color(0.63, 0.62, 0.6)
const D := 8.0
const GAP := 4.0

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_update_min()

func _update_min() -> void:
	custom_minimum_size = Vector2(total * D + (total - 1) * GAP, D + 2.0)

func set_state(p_filled: int, p_total: int, p_active: bool) -> void:
	if p_filled == filled and p_total == total and p_active == active:
		return
	filled = p_filled
	total = maxi(p_total, 1)
	active = p_active
	_update_min()
	queue_redraw()

func _draw() -> void:
	var y := size.y * 0.5
	for i in total:
		var cx := D * 0.5 + i * (D + GAP)
		if active and i < filled:
			draw_circle(Vector2(cx, y), D * 0.5, c_on, true, -1.0, true)
		else:
			draw_arc(Vector2(cx, y), D * 0.5 - 0.75, 0.0, TAU, 20, Color(c_off, 1.0 if active else 0.5), 1.2, true)
