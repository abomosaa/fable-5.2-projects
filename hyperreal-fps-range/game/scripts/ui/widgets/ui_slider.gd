extends HSlider
## Slider drawn as a hairline track with a round knob (vector, so it stays crisp at any UI scale).
## The theme blanks the built-in slider parts; this script draws instead.

var c_track := Color(1, 1, 1, 0.2)
var c_fill := Color(0.9, 0.9, 0.9)
var c_knob := Color(0.9, 0.9, 0.9)
var c_focus := Color(0.86, 0.72, 0.45)
var dragging := false

func _init() -> void:
	custom_minimum_size = Vector2(160, 26)
	focus_mode = Control.FOCUS_ALL
	scrollable = false          # the wheel scrolls the page, it must not change values under the pointer
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_SHRINK_CENTER

func _ready() -> void:
	focus_entered.connect(queue_redraw)
	focus_exited.connect(queue_redraw)
	mouse_entered.connect(queue_redraw)
	mouse_exited.connect(queue_redraw)
	drag_started.connect(func() -> void: dragging = true)
	drag_ended.connect(func(_changed: bool) -> void: dragging = false)

func apply_palette(pal: Dictionary) -> void:
	c_track = Color(pal["text"], 0.22)
	c_fill = pal["text_dim"]
	c_knob = pal["light"]
	c_focus = pal["accent"]
	queue_redraw()

func _draw() -> void:
	var r := 7.0
	var y := floorf(size.y * 0.5)
	var x := lerpf(r, size.x - r, ratio)
	var focused := has_focus()
	draw_rect(Rect2(r, y - 1.0, size.x - 2.0 * r, 2.0), c_track)
	draw_rect(Rect2(r, y - 1.0, x - r, 2.0), c_focus if focused else c_fill)
	draw_circle(Vector2(x, y), r, c_knob, true, -1.0, true)
	if focused:
		draw_arc(Vector2(x, y), r + 3.5, 0.0, TAU, 40, c_focus, 1.6, true)
