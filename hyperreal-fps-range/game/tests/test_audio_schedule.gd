extends RefCounted
## Audio event scheduling: propagation delays, early-reflection geometry, context difference bay vs open pad.

static func run() -> Array:
	var f: Array = []
	if absf(AudioSchedule.propagation_delay(34.3) - 0.1) > 1e-9:
		f.append("propagation delay")
	var bay_src := Vector3(-1.6, 1.50, -0.15)
	var bay_ear := Vector3(-1.6, 1.66, 0.50)
	var pad_src := Vector3(6.4, 1.50, -0.15)
	var pad_ear := Vector3(6.4, 1.66, 0.50)
	var bay := AudioSchedule.early_reflections(bay_src, bay_ear, Vector3.FORWARD)
	var pad := AudioSchedule.early_reflections(pad_src, pad_ear, Vector3.FORWARD)
	# the slab reflection is a textbook case: image source mirrored in y = 0
	var direct := bay_src.distance_to(bay_ear)
	var img := Vector3(bay_src.x, -bay_src.y, bay_src.z)
	var want := (img.distance_to(bay_ear) - direct) / 343.0
	var found := false
	var roof_found := false
	for t in bay:
		if t["surf"] == "slab" and t["order"] == 1:
			found = true
			if absf(float(t["delay"]) - want) > 1e-6:
				f.append("slab reflection delay %f != %f" % [t["delay"], want])
			if (t["dir"] as Vector3).y >= 0.0:
				f.append("slab reflection must arrive from below")
		if t["surf"] == "roof" and t["order"] == 1:
			roof_found = true
			if (t["dir"] as Vector3).y <= 0.0:
				f.append("roof reflection must arrive from above")
			if float(t["delay"]) < 0.003 or float(t["delay"]) > 0.010:
				f.append("roof reflection delay implausible: %f" % t["delay"])
	if not found:
		f.append("no slab reflection in the bay")
	if not roof_found:
		f.append("no roof reflection in the bay")
	for i in range(1, bay.size()):
		if float(bay[i]["delay"]) < float(bay[i - 1]["delay"]):
			f.append("taps not sorted by delay")
			break
	for t in bay + pad:
		if float(t["gain"]) <= 0.0 or float(t["gain"]) >= 1.0:
			f.append("tap gain out of range: %s" % str(t["gain"]))
		if float(t["delay"]) <= 0.0:
			f.append("tap with non-positive delay")
	# the two listening contexts must differ for geometric reasons: many more / stronger early reflections under the roof
	var e_bay := 0.0
	var e_pad := 0.0
	for t in bay:
		e_bay += float(t["gain"]) * float(t["gain"])
	for t in pad:
		e_pad += float(t["gain"]) * float(t["gain"])
	if bay.size() < pad.size() + 5:
		f.append("bay should have clearly more reflections than the pad (%d vs %d)" % [bay.size(), pad.size()])
	if e_bay < e_pad * 3.0:
		f.append("bay reflection energy should exceed the pad's (%f vs %f)" % [e_bay, e_pad])
	for t in pad:
		if t["surf"] == "roof" and t["order"] == 1:
			f.append("there is no roof over the pad")
	if AudioSchedule.bay_enclosure(bay_ear) < 0.99 or AudioSchedule.bay_enclosure(pad_ear) > 0.2:
		f.append("enclosure factors: bay %f pad %f" % [AudioSchedule.bay_enclosure(bay_ear), AudioSchedule.bay_enclosure(pad_ear)])
	# continuity while walking from the bay to the pad (no step = no global reverb switch)
	var prev := AudioSchedule.bay_enclosure(Vector3(-1.6, 1.66, 0.5))
	var x := -1.6
	while x < 8.0:
		x += 0.1
		var e := AudioSchedule.bay_enclosure(Vector3(x, 1.66, 0.5))
		if absf(e - prev) > 0.06:
			f.append("enclosure jumps at x=%.1f (%f -> %f)" % [x, prev, e])
		prev = e
	# berm echoes: delay = extra path / c, backstop later than the side berms from the firing line
	var echoes := AudioSchedule.berm_echoes(bay_src, bay_ear)
	var back := -1.0
	for e2 in echoes:
		var path := bay_src.distance_to(e2["pos"]) + (e2["pos"] as Vector3).distance_to(bay_ear)
		if absf(float(e2["delay"]) - (path - direct) / 343.0) > 1e-6:
			f.append("echo delay inconsistent for " + str(e2["name"]))
		if e2["name"] == "backstop":
			back = e2["delay"]
	if back < 0.28 or back > 0.36:
		f.append("backstop echo should return after ~0.33 s from the firing line, got %f" % back)
	var near := AudioSchedule.berm_echoes(Vector3(0, 1.5, -25.2), Vector3(0, 1.66, -24.5))
	for e3 in near:
		if e3["name"] == "backstop" and float(e3["delay"]) >= back:
			f.append("backstop echo must return sooner when standing downrange")
	# renderer: delays are baked sample-accurately and the far ear is later/quieter (binaural), deterministic output
	var rr := ReflectionRenderer.new()
	var imp := PackedFloat32Array()
	imp.resize(64)
	imp[0] = 1.0
	var cls := []
	for fc in ReflectionRenderer.LP_CLASSES:
		cls.append(imp)           # unfiltered impulses: positions in the buffer are exact
	rr._onsets = [cls]
	var res := rr.render(bay_src, bay_ear, Vector3.RIGHT, Vector3.FORWARD, Vector3.FORWARD, true, 0)
	var st: AudioStreamWAV = res["stream"]
	var first: Dictionary = res["tap_list"][0]
	var want_idx := int(round(float(first["delay"]) * 48000.0))
	var d := st.data
	var first_idx := -1
	for i in d.size() / 4:
		if d.decode_s16(i * 4) != 0 or d.decode_s16(i * 4 + 2) != 0:
			first_idx = i
			break
	if first_idx != want_idx:
		f.append("first reflection lands at sample %d, expected %d" % [first_idx, want_idx])
	if int(res["taps"]) != bay.size():
		f.append("renderer tap count %d != schedule %d" % [res["taps"], bay.size()])
	if float(res["peak"]) > 0.99:
		f.append("reflection buffer clips (peak %f)" % res["peak"])
	# shooter in lane 3 with the muzzle held towards the right-hand divider: the nearest wall is on the right,
	# so the first reflection reaches the right ear first and the right channel carries more energy
	var one := rr.render(Vector3(-0.95, 1.5, 0.1), Vector3(-1.6, 1.66, 0.1), Vector3.RIGHT, Vector3.FORWARD, Vector3.FORWARD, true, 0)
	var dd: PackedByteArray = (one["stream"] as AudioStreamWAV).data
	var l_first := -1
	var r_first := -1
	var l_sum := 0.0
	var r_sum := 0.0
	for i in dd.size() / 4:
		var l := dd.decode_s16(i * 4)
		var r := dd.decode_s16(i * 4 + 2)
		if l != 0 and l_first < 0: l_first = i
		if r != 0 and r_first < 0: r_first = i
		l_sum += absf(l)
		r_sum += absf(r)
	if int(one["taps"]) > 0 and not (r_first <= l_first and r_sum > l_sum):
		f.append("binaural cue wrong for a right-side reflection (first L %d R %d, sum L %f R %f)" % [l_first, r_first, l_sum, r_sum])
	return f

## Runtime scheduling through the real AudioDirector: world sounds start after the propagation delay, never early,
## mechanism sounds can be lead-in aligned, and the voice pool stays bounded under a burst.
static func run_async(tree: SceneTree) -> Array:
	var f: Array = []
	var ad: Node = tree.root.get_node_or_null("AudioDirector")
	if ad == null:
		return ["AudioDirector autoload missing"]
	if not ad.has_group("impact_steel"):
		return ["sound group impact_steel not loaded (assets missing?)"]
	ad.log_events = true
	ad.event_log.clear()
	var ear: Vector3 = ad.listener_position()
	var cases := [8.0, 34.3, 68.6]
	var t0: float = ad.now()
	for dist in cases:
		ad.play_world("impact_steel", ear + Vector3(0, 0, -dist))
	var started := {}
	var guard := 0
	while started.size() < cases.size() and guard < 2000:
		guard += 1
		await tree.process_frame
		for e in ad.event_log:
			if e["type"] == "world" and not started.has(snappedf(e["dist"], 0.1)):
				started[snappedf(e["dist"], 0.1)] = float(e["t"]) - t0
	for dist in cases:
		var k := snappedf(dist, 0.1)
		if not started.has(k):
			f.append("world sound at %.1f m never started" % dist)
			continue
		var want: float = dist / 343.0
		var got: float = started[k]
		if got < want - 1e-4:
			f.append("sound from %.1f m started %.1f ms before it could arrive" % [dist, (want - got) * 1000.0])
		if got > want + 0.06:
			f.append("sound from %.1f m started %.1f ms late" % [dist, (got - want) * 1000.0])
	# mechanism sound aligned so that its loudest part lands at a given moment
	ad.event_log.clear()
	var t1: float = ad.now()
	ad.play_mech("mech_mag_in", 0.0, 0.0, 0.0, [0], 0.40)
	var e0: Dictionary = ad._groups["mech_mag_in"][0]
	var lead: float = float(e0["peak_ms"]) * 0.001
	var mech_t := -1.0
	guard = 0
	while mech_t < 0.0 and guard < 2000:
		guard += 1
		await tree.process_frame
		for e in ad.event_log:
			if e["type"] == "mech":
				mech_t = float(e["t"]) - t1
	if mech_t < 0.0:
		f.append("aligned mechanism sound never started")
	elif absf((mech_t + lead) - 0.40) > 0.05:
		f.append("aligned mechanism sound: loud part at %.3f s instead of 0.400 s" % (mech_t + lead))
	# burst: 200 requests must neither grow the pool nor leave a backlog
	for i in 200:
		ad.play_world("casing_concrete_hit", ear + Vector3(1.0 + 0.01 * i, -1.6, 0.3))
	for i in 30:
		await tree.process_frame
	var st: Dictionary = ad.get_stats()
	if int(st["pending"]) != 0:
		f.append("pending world sounds not drained: %d" % st["pending"])
	if int(st["world_voices"]) > 32:
		f.append("voice pool exceeded: %d" % st["world_voices"])
	ad.stop_all()
	ad.log_events = false
	ad.event_log.clear()
	return f
