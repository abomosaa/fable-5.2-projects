extends RefCounted
## Visual language of the UI: palette, type scale, theme factory and small widget constructors.
## One instance per UI root. Sizes are layout units (pixels at 1080p and HUD scale 100 %).
##
## Typeface: Inter (SIL OFL 1.1), see assets/ui/fonts/Inter-LICENSE.txt and docs/manifest/ui_assets.json.

const FONT_PATH := "res://assets/ui/fonts/InterVariable.ttf"

# type scale
const TITLE := 44
const H1 := 28
const H2 := 20
const BODY := 17
const SMALL := 15
const CAPS := 13

const HAIR_GROUP := "fpsr_ui_hairline"

## Colours. `hc` = high-contrast variant (Settings.high_contrast_hud).
static func palette(hc: bool) -> Dictionary:
	if hc:
		return {
			"hud_panel": Color(0.0, 0.0, 0.0, 0.96),
			"menu_panel": Color(0.0, 0.0, 0.0, 1.0),
			"dialog_panel": Color(0.0, 0.0, 0.0, 1.0),
			"backdrop": Color(0.0, 0.0, 0.0, 0.82),
			"text": Color(1.0, 1.0, 1.0),
			"text_dim": Color(0.92, 0.92, 0.92),
			"text_faint": Color(0.84, 0.84, 0.84),
			"line": Color(1.0, 1.0, 1.0, 0.62),
			"fill": Color(1.0, 1.0, 1.0, 0.14),
			"fill_hover": Color(1.0, 1.0, 1.0, 0.24),
			"accent": Color(1.0, 0.84, 0.36),
			"warn": Color(1.0, 0.78, 0.4),
			"alert": Color(1.0, 0.62, 0.5),
			"on_light": Color(0.0, 0.0, 0.0),
			"light": Color(1.0, 1.0, 1.0),
			"loading_bg": Color(0.0, 0.0, 0.0),
		}
	return {
		"hud_panel": Color(0.035, 0.04, 0.045, 0.84),
		"menu_panel": Color(0.05, 0.054, 0.06, 0.95),
		"dialog_panel": Color(0.085, 0.09, 0.098, 1.0),
		"backdrop": Color(0.015, 0.017, 0.02, 0.62),
		"text": Color(0.93, 0.92, 0.9),
		"text_dim": Color(0.74, 0.73, 0.7),
		"text_faint": Color(0.63, 0.62, 0.6),
		"line": Color(1.0, 1.0, 1.0, 0.15),
		"fill": Color(1.0, 1.0, 1.0, 0.06),
		"fill_hover": Color(1.0, 1.0, 1.0, 0.11),
		"accent": Color(0.86, 0.72, 0.45),      # muted brass
		"warn": Color(0.91, 0.69, 0.4),
		"alert": Color(0.9, 0.56, 0.45),
		"on_light": Color(0.07, 0.075, 0.08),
		"light": Color(0.9, 0.89, 0.86),
		"loading_bg": Color(0.035, 0.037, 0.04),
	}

var high_contrast := false
var pal: Dictionary = palette(false)
var font_hud: Font
var font_menu: Font
var theme_hud: Theme
var theme_menu: Theme
var _faces := {}
var _ts: TextServer

func _init(hc := false) -> void:
	high_contrast = hc
	pal = palette(hc)
	_ts = TextServerManager.get_primary_interface()
	var base := _load_font()
	if base is FontFile:
		# Two copies: each scaled layer rasterises glyphs at its own scale (set_oversampling) so text stays crisp.
		font_hud = base.duplicate()
		font_menu = base.duplicate()
	else:
		font_hud = base
		font_menu = base
	theme_hud = make_theme(font_hud)
	theme_menu = make_theme(font_menu)

func _load_font() -> Font:
	var f: FontFile = null
	if ResourceLoader.exists(FONT_PATH):
		f = load(FONT_PATH) as FontFile
	if f == null and FileAccess.file_exists(FONT_PATH):
		f = FontFile.new()
		if f.load_dynamic_font(FONT_PATH) != OK:
			f = null
	if f == null:
		push_warning("UI font missing (%s); using the engine fallback font." % FONT_PATH)
		return ThemeDB.fallback_font
	return f

## Rasterisation scale of the two font copies (= the scale of the layer that uses them).
func set_oversampling(hud: float, menu: float) -> void:
	if font_hud is FontFile and not is_equal_approx((font_hud as FontFile).oversampling, hud):
		(font_hud as FontFile).oversampling = hud
	if font_menu is FontFile and not is_equal_approx((font_menu as FontFile).oversampling, menu):
		(font_menu as FontFile).oversampling = menu

func c(name: String) -> Color:
	return pal[name]

## A weight / tracking / tabular-figures face of one of the base fonts (cached).
func face(base: Font, weight := 400, tracking := 0, tabular := false) -> Font:
	var key := "%d/%d/%d/%s" % [base.get_instance_id(), weight, tracking, tabular]
	if _faces.has(key):
		return _faces[key]
	var v := FontVariation.new()
	v.base_font = base
	v.variation_opentype = {_ts.name_to_tag("wght"): weight}
	if tracking != 0:
		v.spacing_glyph = tracking
	if tabular:
		v.opentype_features = {_ts.name_to_tag("tnum"): 1}
	_faces[key] = v
	return v

static func flat(bg: Color, border := Color(0, 0, 0, 0), bw := 0, radius := 0, mx := 0.0, my := 0.0) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.draw_center = bg.a > 0.0
	s.border_color = border
	s.set_border_width_all(bw)
	s.set_corner_radius_all(radius)
	s.content_margin_left = mx
	s.content_margin_right = mx
	s.content_margin_top = my
	s.content_margin_bottom = my
	s.anti_aliasing = radius > 0
	return s

static func empty(mx := 0.0, my := 0.0) -> StyleBoxEmpty:
	var s := StyleBoxEmpty.new()
	s.content_margin_left = mx
	s.content_margin_right = mx
	s.content_margin_top = my
	s.content_margin_bottom = my
	return s

func _label_type(t: Theme, type_name: String, base: Font, size: int, color: Color, weight := 400, tracking := 0, tabular := false) -> void:
	t.set_type_variation(type_name, "Label")
	t.set_font("font", type_name, face(base, weight, tracking, tabular))
	t.set_font_size("font_size", type_name, size)
	t.set_color("font_color", type_name, color)

func _button_colors(t: Theme, type_name: String, normal: Color, hover: Color, pressed: Color, disabled: Color) -> void:
	t.set_color("font_color", type_name, normal)
	t.set_color("font_hover_color", type_name, hover)
	t.set_color("font_focus_color", type_name, hover)
	t.set_color("font_pressed_color", type_name, pressed)
	t.set_color("font_hover_pressed_color", type_name, pressed)
	t.set_color("font_disabled_color", type_name, disabled)

func make_theme(base: Font) -> Theme:
	var t := Theme.new()
	var text: Color = pal["text"]
	var dim: Color = pal["text_dim"]
	var faint: Color = pal["text_faint"]
	var line: Color = pal["line"]
	var accent: Color = pal["accent"]
	var fill: Color = pal["fill"]
	var fill_hover: Color = pal["fill_hover"]
	var none := Color(0, 0, 0, 0)
	var disabled := Color(faint, 0.55)

	t.default_font = face(base, 400)
	t.default_font_size = BODY

	# ---- labels
	t.set_color("font_color", "Label", text)
	t.set_constant("line_spacing", "Label", 3)
	_label_type(t, "Title", base, TITLE, text, 300, 0)
	_label_type(t, "H1", base, H1, text, 400)
	_label_type(t, "H2", base, H2, text, 500)
	_label_type(t, "Body", base, BODY, text, 400)
	_label_type(t, "BodyDim", base, BODY, dim, 400)
	_label_type(t, "Value", base, BODY, text, 500, 0, true)
	_label_type(t, "Small", base, SMALL, text, 400)
	_label_type(t, "SmallDim", base, SMALL, dim, 400)
	_label_type(t, "SmallFaint", base, SMALL, faint, 400)
	_label_type(t, "SmallValue", base, SMALL, text, 500, 0, true)
	_label_type(t, "Caps", base, CAPS, faint, 600, 1)
	_label_type(t, "CapsDim", base, CAPS, dim, 600, 1)
	_label_type(t, "Warn", base, SMALL, pal["warn"], 500)

	# ---- buttons (default: quiet outlined)
	var bfont := face(base, 500)
	t.set_font("font", "Button", bfont)
	t.set_font_size("font_size", "Button", SMALL)
	_button_colors(t, "Button", dim, text, text, disabled)
	t.set_stylebox("normal", "Button", flat(fill, line, 1, 2, 18, 9))
	t.set_stylebox("hover", "Button", flat(fill_hover, line, 1, 2, 18, 9))
	t.set_stylebox("pressed", "Button", flat(Color(text, 0.2), line, 1, 2, 18, 9))
	t.set_stylebox("disabled", "Button", flat(none, Color(line, line.a * 0.5), 1, 2, 18, 9))
	var bfocus := flat(Color(accent, 0.1), accent, 1, 2, 18, 9)
	t.set_stylebox("focus", "Button", bfocus)
	t.set_constant("h_separation", "Button", 8)

	# main-menu item: text only, a thin brass bar marks the focused entry
	t.set_type_variation("MenuItem", "Button")
	t.set_font("font", "MenuItem", face(base, 400))
	t.set_font_size("font_size", "MenuItem", 23)
	_button_colors(t, "MenuItem", dim, text, text, disabled)
	for st in ["normal", "disabled", "pressed", "hover"]:
		t.set_stylebox(st, "MenuItem", empty(20, 9))
	var mfocus := flat(fill_hover, accent, 0, 0, 20, 9)
	mfocus.border_width_left = 2
	t.set_stylebox("focus", "MenuItem", mfocus)

	# tab: underline when selected
	t.set_type_variation("Tab", "Button")
	t.set_font("font", "Tab", face(base, 500))
	t.set_font_size("font_size", "Tab", BODY)
	_button_colors(t, "Tab", faint, text, text, disabled)
	var tab_n := flat(none, none, 0, 0, 16, 11)
	tab_n.draw_center = false
	tab_n.border_width_bottom = 2
	var tab_p: StyleBoxFlat = tab_n.duplicate()
	tab_p.border_color = accent
	var tab_h: StyleBoxFlat = tab_n.duplicate()
	tab_h.bg_color = fill
	tab_h.draw_center = true
	t.set_stylebox("normal", "Tab", tab_n)
	t.set_stylebox("hover", "Tab", tab_h)
	t.set_stylebox("pressed", "Tab", tab_p)
	t.set_stylebox("hover_pressed", "Tab", tab_p)
	t.set_stylebox("disabled", "Tab", tab_n)
	var tab_f := flat(fill_hover, none, 0, 0, 16, 11)
	t.set_stylebox("focus", "Tab", tab_f)

	# segmented choice
	t.set_type_variation("Seg", "Button")
	t.set_font("font", "Seg", face(base, 500))
	t.set_font_size("font_size", "Seg", SMALL)
	t.set_color("font_color", "Seg", dim)
	t.set_color("font_hover_color", "Seg", text)
	t.set_color("font_focus_color", "Seg", text)
	t.set_color("font_pressed_color", "Seg", pal["on_light"])
	t.set_color("font_hover_pressed_color", "Seg", pal["on_light"])
	t.set_color("font_disabled_color", "Seg", disabled)
	t.set_stylebox("normal", "Seg", flat(fill, line, 1, 0, 12, 8))
	t.set_stylebox("hover", "Seg", flat(fill_hover, line, 1, 0, 12, 8))
	t.set_stylebox("pressed", "Seg", flat(pal["light"], pal["light"], 1, 0, 12, 8))
	t.set_stylebox("hover_pressed", "Seg", flat(pal["light"], pal["light"], 1, 0, 12, 8))
	t.set_stylebox("disabled", "Seg", flat(none, line, 1, 0, 12, 8))
	var seg_f := flat(none, accent, 2, 0, 12, 8)
	seg_f.draw_center = false
	seg_f.set_expand_margin_all(2)
	t.set_stylebox("focus", "Seg", seg_f)

	# key cap in the controls list
	t.set_type_variation("Key", "Button")
	t.set_font("font", "Key", face(base, 500, 0, true))
	t.set_font_size("font_size", "Key", SMALL)
	_button_colors(t, "Key", text, text, text, disabled)
	t.set_stylebox("normal", "Key", flat(fill, line, 1, 2, 12, 6))
	t.set_stylebox("hover", "Key", flat(fill_hover, line, 1, 2, 12, 6))
	t.set_stylebox("pressed", "Key", flat(Color(text, 0.2), line, 1, 2, 12, 6))
	t.set_stylebox("disabled", "Key", flat(none, line, 1, 2, 12, 6))
	t.set_stylebox("focus", "Key", flat(Color(accent, 0.12), accent, 1, 2, 12, 6))

	# ---- panels
	t.set_stylebox("panel", "PanelContainer", flat(pal["menu_panel"], line, 1, 3, 0, 0))
	t.set_type_variation("Dialog", "PanelContainer")
	t.set_stylebox("panel", "Dialog", flat(pal["dialog_panel"], Color(line, minf(line.a * 1.6, 1.0)), 1, 3, 0, 0))
	t.set_type_variation("HudPanel", "PanelContainer")
	t.set_stylebox("panel", "HudPanel", flat(pal["hud_panel"], line if high_contrast else none, 1 if high_contrast else 0, 3, 16, 12))
	t.set_type_variation("SidePanel", "PanelContainer")
	var side := flat(pal["menu_panel"], line, 0, 0, 0, 0)
	side.border_width_right = 1
	t.set_stylebox("panel", "SidePanel", side)
	t.set_type_variation("NotePanel", "PanelContainer")
	var note := flat(Color(pal["warn"], 0.07), pal["warn"], 0, 0, 16, 12)
	note.border_width_left = 2
	t.set_stylebox("panel", "NotePanel", note)
	t.set_type_variation("RowFocus", "PanelContainer")
	t.set_stylebox("panel", "RowFocus", flat(fill, none, 0, 2, 12, 7))
	t.set_type_variation("Row", "PanelContainer")
	t.set_stylebox("panel", "Row", empty(12, 7))

	# ---- scrolling
	var sc_track := flat(Color(text, 0.05), none, 0, 2)
	sc_track.content_margin_left = 3
	sc_track.content_margin_right = 3
	t.set_stylebox("scroll", "VScrollBar", sc_track)
	t.set_stylebox("scroll_focus", "VScrollBar", sc_track)
	t.set_stylebox("grabber", "VScrollBar", flat(Color(text, 0.28), none, 0, 2))
	t.set_stylebox("grabber_highlight", "VScrollBar", flat(Color(text, 0.45), none, 0, 2))
	t.set_stylebox("grabber_pressed", "VScrollBar", flat(Color(text, 0.6), none, 0, 2))
	for ic in ["increment", "increment_highlight", "increment_pressed", "decrement", "decrement_highlight", "decrement_pressed"]:
		t.set_icon(ic, "VScrollBar", _blank_icon())
	t.set_stylebox("panel", "ScrollContainer", StyleBoxEmpty.new())
	t.set_stylebox("focus", "ScrollContainer", StyleBoxEmpty.new())

	# ---- slider (drawn by ui_slider.gd; the built-in parts are blanked)
	for sb in ["slider", "grabber_area", "grabber_area_highlight"]:
		t.set_stylebox(sb, "HSlider", empty(0, 11))
	for ic in ["grabber", "grabber_highlight", "grabber_disabled", "tick"]:
		t.set_icon(ic, "HSlider", _blank_icon())

	t.set_constant("separation", "HBoxContainer", 12)
	t.set_constant("separation", "VBoxContainer", 8)
	t.set_constant("h_separation", "GridContainer", 16)
	t.set_constant("v_separation", "GridContainer", 4)
	return t

var _blank: ImageTexture
func _blank_icon() -> ImageTexture:
	if _blank == null:
		var img := Image.create(1, 1, false, Image.FORMAT_RGBA8)
		img.fill(Color(0, 0, 0, 0))
		_blank = ImageTexture.create_from_image(img)
	return _blank

# ------------------------------------------------------------------------------------------------
# Small constructors
# ------------------------------------------------------------------------------------------------

func label(text: String, type_name := "Body") -> Label:
	var l := Label.new()
	l.text = text
	l.theme_type_variation = type_name
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

func caps(text: String, type_name := "Caps") -> Label:
	var l := label(text, type_name)
	l.uppercase = true
	return l

func wrap_label(text: String, type_name := "SmallDim") -> Label:
	var l := label(text, type_name)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	return l

func button(text: String, type_name := "") -> Button:
	var b := Button.new()
	b.text = text
	if type_name != "":
		b.theme_type_variation = type_name
	b.focus_mode = Control.FOCUS_ALL
	return b

## One-unit divider that stays at least one device pixel thick at any layer scale (see ui_root).
func hline() -> ColorRect:
	var r := ColorRect.new()
	r.color = pal["line"]
	r.custom_minimum_size = Vector2(0, 1)
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.add_to_group(HAIR_GROUP)
	r.set_meta("hair_axis", 1)
	return r

func vline() -> ColorRect:
	var r := ColorRect.new()
	r.color = pal["line"]
	r.custom_minimum_size = Vector2(1, 0)
	r.mouse_filter = Control.MOUSE_FILTER_IGNORE
	r.add_to_group(HAIR_GROUP)
	r.set_meta("hair_axis", 0)
	return r

func panel(type_name := "") -> PanelContainer:
	var p := PanelContainer.new()
	if type_name != "":
		p.theme_type_variation = type_name
	return p

func margin(l: float, t: float, r: float, b: float) -> MarginContainer:
	var m := MarginContainer.new()
	m.add_theme_constant_override("margin_left", int(l))
	m.add_theme_constant_override("margin_top", int(t))
	m.add_theme_constant_override("margin_right", int(r))
	m.add_theme_constant_override("margin_bottom", int(b))
	return m

func vbox(sep := 8) -> VBoxContainer:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", sep)
	return v

func hbox(sep := 12) -> HBoxContainer:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", sep)
	return h

func spacer(w := 0.0, h := 0.0, expand := false) -> Control:
	var s := Control.new()
	s.custom_minimum_size = Vector2(w, h)
	s.mouse_filter = Control.MOUSE_FILTER_IGNORE
	if expand:
		s.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		s.size_flags_vertical = Control.SIZE_EXPAND_FILL
	return s

# ------------------------------------------------------------------------------------------------
# Layout / focus helpers
# ------------------------------------------------------------------------------------------------

## Centre `panel` in its parent at up to `max_size`, keeping `min_margin` free on every side of `space`.
static func fit_center(panel: Control, space: Vector2, max_size: Vector2, min_margin: Vector2) -> void:
	var w := floorf(minf(max_size.x, space.x - 2.0 * min_margin.x))
	var h := floorf(minf(max_size.y, space.y - 2.0 * min_margin.y))
	panel.anchor_left = 0.5
	panel.anchor_right = 0.5
	panel.anchor_top = 0.5
	panel.anchor_bottom = 0.5
	panel.offset_left = -floorf(w * 0.5)
	panel.offset_right = panel.offset_left + w
	panel.offset_top = -floorf(h * 0.5)
	panel.offset_bottom = panel.offset_top + h

static func set_neighbor(c: Control, side: Side, target: Control) -> void:
	c.set_focus_neighbor(side, NodePath(".") if target == c else c.get_path_to(target))

## Keyboard focus stays inside `controls` (a horizontal row): left/right step and stop at the ends,
## up/down do nothing, Tab cycles.
static func trap_row(controls: Array) -> void:
	var n := controls.size()
	for i in n:
		var c: Control = controls[i]
		set_neighbor(c, SIDE_LEFT, controls[maxi(i - 1, 0)])
		set_neighbor(c, SIDE_RIGHT, controls[mini(i + 1, n - 1)])
		set_neighbor(c, SIDE_TOP, c)
		set_neighbor(c, SIDE_BOTTOM, c)
		c.focus_next = c.get_path_to(controls[(i + 1) % n]) if n > 1 else NodePath(".")
		c.focus_previous = c.get_path_to(controls[(i + n - 1) % n]) if n > 1 else NodePath(".")

## Vertical list with wrap-around; left/right do nothing.
static func trap_column(controls: Array, wrap := true) -> void:
	var n := controls.size()
	for i in n:
		var c: Control = controls[i]
		var up := (i + n - 1) % n if wrap else maxi(i - 1, 0)
		var down := (i + 1) % n if wrap else mini(i + 1, n - 1)
		set_neighbor(c, SIDE_TOP, controls[up])
		set_neighbor(c, SIDE_BOTTOM, controls[down])
		set_neighbor(c, SIDE_LEFT, c)
		set_neighbor(c, SIDE_RIGHT, c)
		c.focus_next = c.get_path_to(controls[(i + 1) % n]) if n > 1 else NodePath(".")
		c.focus_previous = c.get_path_to(controls[(i + n - 1) % n]) if n > 1 else NodePath(".")

## Pin a self-sizing control to a point of its parent (`anchor` in 0..1) plus `offset`; it hugs its
## minimum size and grows away from the nearest edges (both ways when centred on an axis).
static func pin(c: Control, anchor: Vector2, offset: Vector2) -> void:
	c.anchor_left = anchor.x
	c.anchor_right = anchor.x
	c.anchor_top = anchor.y
	c.anchor_bottom = anchor.y
	c.grow_horizontal = _grow_for(anchor.x)
	c.grow_vertical = _grow_for(anchor.y)
	c.set_meta("pin_offset", offset)
	repin(c)

## Collapse a pinned control back onto its pin so it re-hugs its (possibly smaller) minimum size.
static func repin(c: Control) -> void:
	var o: Vector2 = c.get_meta("pin_offset", Vector2.ZERO)
	c.offset_left = o.x
	c.offset_right = o.x
	c.offset_top = o.y
	c.offset_bottom = o.y

static func _grow_for(a: float) -> Control.GrowDirection:
	if a < 0.25:
		return Control.GROW_DIRECTION_END
	if a > 0.75:
		return Control.GROW_DIRECTION_BEGIN
	return Control.GROW_DIRECTION_BOTH
