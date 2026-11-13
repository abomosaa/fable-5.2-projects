extends Control
## Pause menu: a quiet column on the left. Arrow keys / Enter / Esc and the mouse both work.

const UIStyle := preload("res://scripts/ui/ui_style.gd")

signal item_chosen(id: String)

const ITEMS := [
	["resume", "Resume"],
	["restart", "Restart session"],
	["reset_targets", "Reset targets"],
	["groups", "Shot groups"],
	["settings", "Settings"],
	["controls", "Controls"],
	["quit", "Quit"],
]

var style
var _buttons := {}
var _panel: PanelContainer

func setup(p_style) -> void:
	style = p_style
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_panel = style.panel("SidePanel")
	add_child(_panel)
	_panel.set_anchors_preset(Control.PRESET_LEFT_WIDE)
	_panel.offset_right = 440
	var m: MarginContainer = style.margin(44, 72, 44, 44)
	_panel.add_child(m)
	var col: VBoxContainer = style.vbox(0)
	m.add_child(col)
	col.add_child(style.caps("Paused", "Caps"))
	col.add_child(style.spacer(0, 6))
	col.add_child(style.label("Range Day", "Title"))
	col.add_child(style.spacer(0, 30))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 22))
	var list: Array = []
	for it in ITEMS:
		var b: Button = style.button(it[1], "MenuItem")
		b.alignment = HORIZONTAL_ALIGNMENT_LEFT
		b.pressed.connect(_choose.bind(it[0]))
		b.mouse_entered.connect(b.grab_focus)
		col.add_child(b)
		if it[0] == "resume" or it[0] == "reset_targets" or it[0] == "controls":
			col.add_child(style.spacer(0, 14))
		_buttons[it[0]] = b
		list.append(b)
	UIStyle.trap_column(list, true)
	col.add_child(style.spacer(0, 0, true))
	col.add_child(style.hline())
	col.add_child(style.spacer(0, 14))
	col.add_child(style.label("↑ ↓  select    Enter  confirm    Esc  resume", "SmallFaint"))

func _choose(id: String) -> void:
	item_chosen.emit(id)

## Focus the entry the player came back from (or Resume).
func open(from := "") -> void:
	var id := "resume"
	match from:
		"settings": id = "settings"
		"controls": id = "controls"
		"inspector": id = "groups"
	(_buttons[id] as Button).grab_focus()

func focus_item(id: String) -> void:
	if _buttons.has(id):
		(_buttons[id] as Button).grab_focus()
