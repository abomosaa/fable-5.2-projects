extends StaticBody3D
## Collider of an intact brittle object (bottle, clay pigeon, pot): forwards the bullet to the breakables manager.
var manager: Node

func on_bullet_hit(hit: Dictionary) -> Dictionary:
	if manager == null:
		return {}
	return manager.call("on_item_hit", int(get_meta("item", 0)), hit)
