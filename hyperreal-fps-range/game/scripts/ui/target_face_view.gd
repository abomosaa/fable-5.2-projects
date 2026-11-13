extends Control
## Draws one paper-target face at true proportions with a millimetre scale bar and, optionally,
## numbered outlined markers at the recorded hit positions (mm, x right / y up from the centre).
## `zoom_group` shows only the part of the face around the group, still at true proportions.

const BULLET_DIAMETER_MM := 9.0
const SCALE_STEPS: Array[float] = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0]
const BAR_SPACE := 44.0

var pal := {}
var texture: Texture2D
var face_size_mm := Vector2(500, 500)
var points := PackedVector2Array()
var center := Vector2.ZERO
var max_radius_mm := 0.0
var es_a := Vector2.ZERO
var es_b := Vector2.ZERO
var show_markers := true
var zoom_group := false
var message := ""

func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	clip_contents = true
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	custom_minimum_size = Vector2(240, 240)

func set_data(p_texture: Texture2D, p_face_mm: Vector2, stats: Dictionary) -> void:
	texture = p_texture
	face_size_mm = p_face_mm
	points = stats.get("points", PackedVector2Array())
	center = stats.get("center", Vector2.ZERO)
	max_radius_mm = float(stats.get("max_radius_mm", 0.0))
	es_a = stats.get("es_a", Vector2.ZERO)
	es_b = stats.get("es_b", Vector2.ZERO)
	queue_redraw()

## Part of the face that is shown, in face millimetres (x right, y up; position = lower-left corner).
static func view_rect_mm(face_mm: Vector2, zoom: bool, group_center: Vector2, group_radius: float, pane: Vector2) -> Rect2:
	var whole := Rect2(-face_mm * 0.5, face_mm)
	if not zoom or pane.x <= 0.0 or pane.y <= 0.0:
		return whole
	var half := maxf(group_radius * 1.45 + 18.0, 40.0)
	var h := Vector2(half * maxf(1.0, pane.x / pane.y), half * maxf(1.0, pane.y / pane.x))
	h = h.min(face_mm * 0.5)
	var c := group_center.clamp(-face_mm * 0.5 + h, face_mm * 0.5 - h)
	return Rect2(c - h, h * 2.0)

## Largest "nice" length (mm) that is at most `max_px` wide at `px_per_mm`.
static func nice_bar_mm(px_per_mm: float, max_px: float) -> float:
	var best := SCALE_STEPS[0]
	for s in SCALE_STEPS:
		if s * px_per_mm <= max_px:
			best = s
	return best

func _draw() -> void:
	if pal.is_empty():
		return
	var font := get_theme_font("font", "SmallValue")
	var fsz := get_theme_font_size("font_size", "SmallValue")
	var pane := Vector2(size.x, size.y - BAR_SPACE)
	if message != "" or face_size_mm.x <= 0.0 or face_size_mm.y <= 0.0 or pane.x <= 8.0 or pane.y <= 8.0:
		var txt := message if message != "" else "No target face"
		var tw := font.get_string_size(txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz + 2).x
		draw_string(font, Vector2((size.x - tw) * 0.5, size.y * 0.5), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz + 2, pal["text_dim"])
		return
	var view := view_rect_mm(face_size_mm, zoom_group and points.size() > 0, center, max_radius_mm, pane)
	var k := minf(pane.x / view.size.x, pane.y / view.size.y)          # pixels per millimetre
	var fr := Rect2(((pane - view.size * k) * 0.5).floor(), view.size * k)
	# face millimetres -> pane pixels (y flips: up on the target is up on screen)
	var to_px := func(p: Vector2) -> Vector2:
		return fr.position + Vector2((p.x - view.position.x) * k, (view.end.y - p.y) * k)

	if texture != null:
		var ts := Vector2(texture.get_size())
		var src := Rect2(
			(view.position.x + face_size_mm.x * 0.5) / face_size_mm.x * ts.x,
			(face_size_mm.y * 0.5 - view.end.y) / face_size_mm.y * ts.y,
			view.size.x / face_size_mm.x * ts.x,
			view.size.y / face_size_mm.y * ts.y)
		draw_texture_rect_region(texture, fr, src)
	else:
		draw_rect(fr, Color(0.86, 0.84, 0.79))
	draw_rect(fr.grow(0.5), pal["line"], false, 1.0)

	if show_markers and points.size() > 0:
		var accent: Color = pal["accent"]
		var dark := Color(0, 0, 0, 0.85)
		var r := maxf(BULLET_DIAMETER_MM * 0.5 * k + 3.0, 6.0)
		var c: Vector2 = to_px.call(center)
		if points.size() >= 2:
			var a: Vector2 = to_px.call(es_a)
			var b: Vector2 = to_px.call(es_b)
			draw_line(a, b, dark, 3.0, true)
			draw_line(a, b, accent, 1.2, true)
		for i in points.size():
			var p: Vector2 = to_px.call(points[i])
			if not fr.grow(r).has_point(p):
				continue
			draw_arc(p, r, 0.0, TAU, 40, dark, 3.6, true)
			draw_arc(p, r, 0.0, TAU, 40, accent, 1.6, true)
		# numbers sit outside each marker, pushed away from the group centre so they spread out
		var asc := font.get_ascent(fsz)
		for i in points.size():
			var p: Vector2 = to_px.call(points[i])
			if not fr.grow(r).has_point(p):
				continue
			var dir := (p - c).normalized() if p.distance_to(c) > 1.0 else Vector2(0.7071, -0.7071)
			var num := str(i + 1)
			var tsz := font.get_string_size(num, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz)
			var mid := p + dir * (r + 5.0 + maxf(tsz.x, asc) * 0.5)
			var np := Vector2(mid.x - tsz.x * 0.5, mid.y + asc * 0.36)
			draw_string_outline(font, np, num, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz, 5, dark)
			draw_string(font, np, num, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz, Color(1, 1, 1))
		# group centre
		if fr.has_point(c):
			for w: Array in [[4.0, dark], [1.6, Color(1, 1, 1)]]:
				draw_line(c + Vector2(-9, 0), c + Vector2(9, 0), w[1], w[0], true)
				draw_line(c + Vector2(0, -9), c + Vector2(0, 9), w[1], w[0], true)

	# scale bar
	var bar_mm := nice_bar_mm(k, maxf(fr.size.x * 0.3, 40.0))
	var bw := bar_mm * k
	var by := fr.end.y + 20.0
	var bx := fr.position.x
	var col: Color = pal["text"]
	draw_line(Vector2(bx, by), Vector2(bx + bw, by), col, 1.5)
	draw_line(Vector2(bx + 0.75, by - 5.0), Vector2(bx + 0.75, by + 5.0), col, 1.5)
	draw_line(Vector2(bx + bw - 0.75, by - 5.0), Vector2(bx + bw - 0.75, by + 5.0), col, 1.5)
	var half := bx + bw * 0.5
	draw_line(Vector2(half, by - 3.0), Vector2(half, by + 3.0), col, 1.0)
	draw_string(font, Vector2(bx + bw + 12.0, by + 5.0), "%d mm" % int(bar_mm), HORIZONTAL_ALIGNMENT_LEFT, -1, fsz, col)
	var dims := "face %d × %d mm" % [int(round(face_size_mm.x)), int(round(face_size_mm.y))]
	if zoom_group and points.size() > 0:
		dims = "showing %d × %d mm of the %s" % [int(round(view.size.x)), int(round(view.size.y)), dims]
	var dw := font.get_string_size(dims, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz).x
	if fr.end.x - dw > bx + bw + 90.0:
		draw_string(font, Vector2(fr.end.x - dw, by + 5.0), dims, HORIZONTAL_ALIGNMENT_LEFT, -1, fsz, pal["text_dim"])
