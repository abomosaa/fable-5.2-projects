extends BaseButton
## On/off switch: state word + a small pill. Vector-drawn; colours from the UI palette.

var pal := {}
var on_text := "On"
var off_text := "Off"

func _init() -> void:
	toggle_mode = true
	focus_mode = Control.FOCUS_ALL
	custom_minimum_size = Vector2(108, 30)
	size_flags_horizontal = Control.SIZE_SHRINK_END
	size_flags_vertical = Control.SIZE_SHRINK_CENTER
	mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND

func _ready() -> void:
	for sig in [focus_entered, focus_exited, mouse_entered, mouse_exited]:
		sig.connect(queue_redraw)
	toggled.connect(func(_on: bool) -> void: queue_redraw())

func apply_palette(p: Dictionary) -> void:
	pal = p
	queue_redraw()

func _draw() -> void:
	if pal.is_empty():
		return
	var on := button_pressed
	var pw := 38.0
	var ph := 20.0
	var px := size.x - pw - 2.0
	var py := floorf((size.y - ph) * 0.5)
	var pill := Rect2(px, py, pw, ph)
	var sb := StyleBoxFlat.new()
	sb.set_corner_radius_all(int(ph * 0.5))
	sb.anti_aliasing = true
	if on:
		sb.bg_color = pal["light"]
	else:
		sb.bg_color = Color(pal["text"], 0.08)
		sb.border_color = pal["text_faint"]
		sb.set_border_width_all(1)
	draw_style_box(sb, pill)
	var kr := ph * 0.5 - 4.0
	var kx := px + pw - ph * 0.5 if on else px + ph * 0.5
	draw_circle(Vector2(kx, py + ph * 0.5), kr, pal["on_light"] if on else pal["text_dim"], true, -1.0, true)
	if has_focus():
		var fb := StyleBoxFlat.new()
		fb.draw_center = false
		fb.border_color = pal["accent"]
		fb.set_border_width_all(2)
		fb.set_corner_radius_all(int(ph * 0.5) + 3)
		fb.anti_aliasing = true
		draw_style_box(fb, pill.grow(3.0))
	var font := get_theme_font("font", "SmallValue")
	var fs := get_theme_font_size("font_size", "SmallValue")
	var txt := on_text if on else off_text
	var col: Color = pal["text"] if (on or is_hovered() or has_focus()) else pal["text_dim"]
	var tw := font.get_string_size(txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
	var ty := floorf((size.y - font.get_height(fs)) * 0.5 + font.get_ascent(fs))
	draw_string(font, Vector2(px - 12.0 - tw, ty), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, col)
