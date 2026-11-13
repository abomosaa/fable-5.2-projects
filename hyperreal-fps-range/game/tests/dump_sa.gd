extends SceneTree
func _init():
	for c in ["SteamAudioPlayer","SteamAudioListener","SteamAudioConfig","SteamAudioGeometry","SteamAudioDynamicGeometry","SteamAudioMaterial","SteamAudioStream","SteamAudioStreamPlayback","SteamAudioServer"]:
		if not ClassDB.class_exists(c):
			print("MISSING ", c); continue
		print("== ", c, " : ", ClassDB.get_parent_class(c))
		for p in ClassDB.class_get_property_list(c, true):
			if p.usage & PROPERTY_USAGE_EDITOR or p.usage & PROPERTY_USAGE_STORAGE:
				print("   prop ", p.name, " t=", p.type, " hint=", p.hint_string)
		for m in ClassDB.class_get_method_list(c, true):
			print("   fn ", m.name, "(", ", ".join(m.args.map(func(a): return a.name)), ")")
	quit()
