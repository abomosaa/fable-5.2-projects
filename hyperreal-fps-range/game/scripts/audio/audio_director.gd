extends Node
## Audio runtime (autoload `AudioDirector`).
##
##  * bus graph, master level, dynamic-range modes, limiter (headroom is protected, nothing relies on clipping)
##  * the player's gunshot: dry onset + natural recorded tail + geometric early reflections (ReflectionRenderer)
##    + late bay reverberation + berm slap-back echoes, all weighted by where the shooter stands (AudioSchedule)
##  * world one-shots with propagation delay, distance attenuation, occlusion, HRTF (Steam Audio) or stereo panning
##  * weapon mechanics, footsteps, cloth, ambience, distant neighbouring range
##
## Sound files and their measured levels come from res://assets/audio/manifest.json (see docs/manifest/audio_assets.json
## for sources and licences). Nothing here is synthesised.

const MANIFEST := "res://assets/audio/manifest.json"
const C := 343.0

## Per-group mixing: trim_db = level of the sample at `ref` metres; `max` = audible range in metres.
const WORLD_CFG := {
	# trim = peak level (dBFS before the master fader) of a full-intensity event heard at `ref` metres, after every
	# file has been brought to a common loudness (-22 LUFS, peak permitting). Calibrated with loopback captures (docs/VERIFICATION.md).
	"_default": {"trim": -18.0, "ref": 4.0, "max": 120.0},
	"impact_steel": {"trim": -5.0, "ref": 8.0, "max": 300.0, "rolloff": 0.75},
	"impact_steel_small": {"trim": -3.0, "ref": 8.0, "max": 300.0, "rolloff": 0.75},
	"impact_dirt": {"trim": -10.0, "ref": 6.0, "max": 150.0},
	"impact_paper": {"trim": -24.0, "ref": 4.0, "max": 60.0},
	"impact_cardboard": {"trim": -23.0, "ref": 4.0, "max": 60.0},
	"impact_wood": {"trim": -15.0, "ref": 5.0, "max": 150.0},
	"impact_concrete": {"trim": -13.0, "ref": 5.0, "max": 150.0},
	"impact_sheet_metal": {"trim": -9.0, "ref": 5.0, "max": 200.0},
	"impact_can": {"trim": -12.0, "ref": 5.0, "max": 150.0},
	"break_glass_bottle": {"trim": -2.0, "ref": 5.0, "max": 200.0},
	"break_ceramic": {"trim": -3.0, "ref": 5.0, "max": 200.0},
	"debris_glass": {"trim": -20.0, "ref": 3.0, "max": 60.0},
	"debris_ceramic": {"trim": -20.0, "ref": 3.0, "max": 60.0},
	"chain_rattle": {"trim": -21.0, "ref": 4.0, "max": 80.0},
	"metal_creak": {"trim": -28.0, "ref": 3.0, "max": 40.0},
	"casing_concrete_hit": {"trim": -9.0, "ref": 1.2, "max": 30.0},
	"casing_concrete_seq": {"trim": -9.0, "ref": 1.2, "max": 30.0},
	"casing_wood_hit": {"trim": -11.0, "ref": 1.2, "max": 30.0},
	"casing_wood_seq": {"trim": -11.0, "ref": 1.2, "max": 30.0},
	"casing_dirt_hit": {"trim": -21.0, "ref": 1.2, "max": 20.0},
	"casing_dirt_seq": {"trim": -21.0, "ref": 1.2, "max": 20.0},
}
## Levels of the gunshot layers relative to full scale (the Shot bus adds the overall trim).
const SHOT_BUS_DB := -3.0
const SHOT_TAIL_DB := 0.0
const SHOT_REFLECTION_DB := 6.0          # undoes ReflectionRenderer.HEADROOM
const SHOT_BAY_LATE_DB := -4.0
const SHOT_CLOSE_DB := -10.0             # close-microphone layer (real 9 mm pistol, 1 m) for the shooter's own position
const SHOT_ECHO_DB := 0.0
const MECH_BUS_DB := -17.0
const WORLD_BUS_DB := 0.0
const AMB_BUS_DB := -7.0                # the bed sits well under the shot's own tail (review round 1)
const AMB_DUCK_DB := -9.0               # brief dip of the bed after the player's shot, recovering over ~1.5 s
const SA_OFFSET_DB := 60.0
const SA_HRTF_MAKEUP_DB := 8.0           # measured: the binaural path is 8 dB below the engine's stereo path for a frontal source
const STEREO_MAKEUP_DB := 4.5            # measured: matches the stereo fallback to the binaural path for a frontal source
const STEP_DB := -30.0
const CLOTH_DB := -36.0

var _groups := {}                 # group -> Array[{stream, peak, lufs, dur}]
var _last_pick := {}
var _warned := {}
var _rng := RandomNumberGenerator.new()

var _listener: Node3D
var _shot_pools := {}             # layer -> Array[AudioStreamPlayer]
var _shot_idx := {}
var _mech_pool: Array[AudioStreamPlayer] = []
var _mech_i := 0
var _world_pool: Array = []       # AudioStreamPlayer3D or SteamAudioPlayer
var _world_i := 0
var _world_follow := {}           # player -> Node3D
var _pending: Array[Dictionary] = []      # time-ordered deferred plays
var _amb: Array[AudioStreamPlayer] = []
var _steam_ok := false
var _steam_cfg: Node
var _steam_listener: Node
var _binaural := true
var _renderer := ReflectionRenderer.new()
var _silence: AudioStreamWAV
var _amb_duck := 0.0
var _refl_key := ""
var _shooter := {"src": Vector3.ZERO, "ear": Vector3(0, 1.66, 0), "bore": Vector3.FORWARD, "valid": false, "crouch": false}
var _now := 0.0
var _distant_timer := 25.0
var _started := false
var log_events := false                    # tests/capture: record what was scheduled
var event_log: Array[Dictionary] = []

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_rng.randomize()
	_silence = AudioStreamWAV.new()
	_silence.format = AudioStreamWAV.FORMAT_16_BITS
	_silence.mix_rate = 48000
	var z := PackedByteArray()
	z.resize(256)
	_silence.data = z
	_setup_buses()
	_load_manifest()
	_steam_ok = ClassDB.class_exists("SteamAudioPlayer") and ClassDB.class_exists("SteamAudioConfig")
	if _steam_ok:
		_steam_cfg = ClassDB.instantiate("SteamAudioConfig")
		_steam_cfg.set("global_log_level", 3)
		add_child(_steam_cfg)
	_binaural = Settings.gets("spatial_mode") == "hrtf"
	for layer in ["onset", "tail", "refl", "late", "close"]:
		var arr: Array[AudioStreamPlayer] = []
		for i in 10:
			var p := AudioStreamPlayer.new()
			p.bus = "Shot"
			add_child(p)
			arr.append(p)
		_shot_pools[layer] = arr
		_shot_idx[layer] = 0
	for i in 12:
		var m := AudioStreamPlayer.new()
		m.bus = "Mech"
		add_child(m)
		_mech_pool.append(m)
	_build_world_pool()
	var onsets := []
	for e in _groups.get("shot_p38_onset", []):
		onsets.append(e["stream"])
	_renderer.setup(onsets.slice(0, 6))
	_build_stereo_tails()
	_build_echo_streams()
	Settings.changed.connect(_on_setting)
	_apply_levels()

func _exit_tree() -> void:
	_renderer.shutdown()

# ------------------------------------------------------------------ buses
func _setup_buses() -> void:
	for b in ["Shot", "Mech", "World", "Amb", "WorldSA"]:
		if AudioServer.get_bus_index(b) < 0:
			AudioServer.add_bus()
			var i := AudioServer.bus_count - 1
			AudioServer.set_bus_name(i, b)
			AudioServer.set_bus_send(i, "World" if b == "WorldSA" else "Master")
	# Measured with loopback captures (docs/VERIFICATION.md): a SteamAudioPlayer's gain is linear only for
	# volume_db >= 0, so those players run at +60 dB into a bus that takes the 60 dB off again.
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("WorldSA"), -SA_OFFSET_DB + SA_HRTF_MAKEUP_DB)
	# the field recordings carry wind rumble below ~70 Hz that measured 15-20 dB above the real shot's own level in
	# those bands (review round 2 octave analysis): roll it off
	var amb_i := AudioServer.get_bus_index("Amb")
	while AudioServer.get_bus_effect_count(amb_i) > 0:
		AudioServer.remove_bus_effect(amb_i, 0)
	var hp := AudioEffectHighPassFilter.new()
	hp.cutoff_hz = 90.0
	hp.db = AudioEffectFilter.FILTER_12DB
	AudioServer.add_bus_effect(amb_i, hp)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Shot"), SHOT_BUS_DB)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Mech"), MECH_BUS_DB)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("World"), WORLD_BUS_DB)
	# master chain: [0] compressor (dynamic-range modes), [1] brick-wall limiter that keeps peaks below -1 dBFS
	while AudioServer.get_bus_effect_count(0) > 0:
		AudioServer.remove_bus_effect(0, 0)
	var comp := AudioEffectCompressor.new()
	AudioServer.add_bus_effect(0, comp)
	var lim := AudioEffectHardLimiter.new()
	lim.ceiling_db = -1.0
	lim.pre_gain_db = 0.0
	lim.release = 0.08
	AudioServer.add_bus_effect(0, lim)

func _apply_levels() -> void:
	var v := Settings.getf("master_volume")
	var comp: AudioEffectCompressor = AudioServer.get_bus_effect(0, 0)
	var makeup := 0.0
	match Settings.gets("dynamic_range"):
		"headphones":
			comp.threshold = -20.0; comp.ratio = 3.0; comp.attack_us = 800.0; comp.release_ms = 180.0; comp.gain = 5.0
			AudioServer.set_bus_effect_enabled(0, 0, true)
			makeup = -1.0
		"night":
			comp.threshold = -32.0; comp.ratio = 7.0; comp.attack_us = 500.0; comp.release_ms = 220.0; comp.gain = 12.0
			AudioServer.set_bus_effect_enabled(0, 0, true)
			makeup = -3.0
		_:
			AudioServer.set_bus_effect_enabled(0, 0, false)
	# perceptual taper; 0.6 (default) = about -9 dB
	AudioServer.set_bus_volume_db(0, (linear_to_db(maxf(v * v, 1e-5)) + makeup) if v > 0.001 else -80.0)
	AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Amb"), AMB_BUS_DB + linear_to_db(maxf(Settings.getf("ambience_volume"), 1e-4)))

func _on_setting(key: String) -> void:
	if key in ["master_volume", "dynamic_range", "ambience_volume"]:
		_apply_levels()
	elif key == "spatial_mode":
		_binaural = Settings.gets("spatial_mode") == "hrtf"
		_build_world_pool()
		_refl_key = ""

# ------------------------------------------------------------------ assets
func _load_manifest() -> void:
	if not FileAccess.file_exists(MANIFEST):
		push_warning("AudioDirector: %s missing - the simulation will be silent" % MANIFEST)
		return
	var js: Variant = JSON.parse_string(FileAccess.get_file_as_string(MANIFEST))
	if not (js is Dictionary) or not js.has("groups"):
		push_warning("AudioDirector: bad manifest")
		return
	for g in js["groups"]:
		var arr := []
		for f in js["groups"][g].get("files", []):
			var path := "res://assets/audio/" + str(f["file"])
			if not ResourceLoader.exists(path):
				continue
			var st: AudioStream = load(path)
			if st == null:
				continue
			var e := {"stream": st, "peak": float(f.get("peak_dbfs", -1.0)), "lufs": float(f.get("lufs", -20.0)),
				"dur": float(f.get("duration_s", st.get_length())), "file": str(f["file"]),
				"peak_ms": float(f["peak_ms"]) if f.get("peak_ms") != null else float(f["onset_ms"]) if f.get("onset_ms") != null else 2.0}
			arr.append(e)
			# files named <sub>_NN inside a broader group (casing_concrete_hit_03 in casing_concrete) also form the group <sub>
			var base := str(f["file"]).get_file().get_basename()
			var cut := base.rfind("_")
			if cut > 0 and base.substr(cut + 1).is_valid_int() and base.substr(0, cut) != g:
				var sub := base.substr(0, cut)
				if not _groups.has(sub):
					_groups[sub] = []
				(_groups[sub] as Array).append(e.duplicate())
		if arr.size() > 0:
			_groups[g] = arr

## The shipped "tail" files have the first 45 ms cross-faded out in both channels, which leaves the dry onset
## (played as a mono mid signal) without the recording's stereo image. Rebuild each tail as  full - onset(mid):
## onset + tail then reproduces the original stereo take exactly, in the open and under the roof alike.
func _build_stereo_tails() -> void:
	var full: Array = _groups.get("shot_p38_full", [])
	var ons: Array = _groups.get("shot_p38_onset", [])
	var tails: Array = _groups.get("shot_p38_tail", [])
	for i in mini(full.size(), mini(ons.size(), tails.size())):
		var f: AudioStreamWAV = full[i]["stream"]
		var o: AudioStreamWAV = ons[i]["stream"]
		if f == null or o == null or f.format != AudioStreamWAV.FORMAT_16_BITS or not f.stereo or o.stereo or o.format != AudioStreamWAV.FORMAT_16_BITS:
			continue
		var fd := f.data.duplicate()
		var od := o.data
		var n := mini(od.size() / 2, fd.size() / 4)
		for k in n:
			var m := od.decode_s16(k * 2)
			fd.encode_s16(k * 4, clampi(fd.decode_s16(k * 4) - m, -32768, 32767))
			fd.encode_s16(k * 4 + 2, clampi(fd.decode_s16(k * 4 + 2) - m, -32768, 32767))
		var st := AudioStreamWAV.new()
		st.format = AudioStreamWAV.FORMAT_16_BITS
		st.mix_rate = f.mix_rate
		st.stereo = true
		st.data = fd
		tails[i] = tails[i].duplicate()
		tails[i]["stream"] = st
	if tails.size() > 0:
		_groups["shot_p38_tail"] = tails

## Berm slap-back uses distant-perspective recordings, but only their first 0.9 s: the 3 s files end in the
## recording site's wind floor, which lingered audibly (measurably: +4-5 dB over the bed for 2.5 s) after pad shots.
func _build_echo_streams() -> void:
	var out := []
	for e in _groups.get("shot_distant_100m", []):
		var st := e["stream"] as AudioStreamWAV
		if st == null or st.format != AudioStreamWAV.FORMAT_16_BITS:
			continue
		var ch := 2 if st.stereo else 1
		var n := mini(int(0.9 * st.mix_rate), st.data.size() / (2 * ch))
		var fade := int(0.45 * st.mix_rate)
		var d := st.data.slice(0, n * 2 * ch)
		for k in range(n - fade, n):
			var g := 0.5 * (1.0 + cos(PI * float(k - (n - fade)) / fade))
			for c in ch:
				var o := (k * ch + c) * 2
				d.encode_s16(o, int(d.decode_s16(o) * g))
		var w := AudioStreamWAV.new()
		w.format = AudioStreamWAV.FORMAT_16_BITS
		w.mix_rate = st.mix_rate
		w.stereo = st.stereo
		w.data = d
		var ne: Dictionary = e.duplicate()
		ne["stream"] = w
		ne["dur"] = 0.9
		out.append(ne)
	if out.size() > 0:
		_groups["shot_echo"] = out

func has_group(group: String) -> bool:
	return _groups.has(group)

func group_size(group: String) -> int:
	return _groups[group].size() if _groups.has(group) else 0

func loaded_summary() -> Dictionary:
	var d := {}
	for g in _groups:
		d[g] = _groups[g].size()
	return d

## random variant, never the same twice in a row when there is a choice
func _pick(group: String, only: Array = []) -> Dictionary:
	if not _groups.has(group):
		if not _warned.has(group):
			_warned[group] = true
			push_warning("AudioDirector: sound group '%s' is not available" % group)
		return {}
	var arr: Array = _groups[group]
	var choices: Array = []
	for k in only:
		if int(k) < arr.size():
			choices.append(int(k))
	if choices.is_empty():
		choices = range(arr.size())
	var i: int = choices[_rng.randi() % choices.size()]
	if choices.size() > 1 and i == int(_last_pick.get(group, -1)):
		i = choices[(choices.find(i) + 1 + _rng.randi() % (choices.size() - 1)) % choices.size()]
	_last_pick[group] = i
	var e: Dictionary = arr[i]
	e["index"] = i
	return e

# ------------------------------------------------------------------ listener / shooter
func set_listener(node: Node3D) -> void:
	_listener = node
	if _steam_ok and node != null:
		if _steam_listener != null and is_instance_valid(_steam_listener):
			_steam_listener.queue_free()
		_steam_listener = ClassDB.instantiate("SteamAudioListener")
		node.add_child(_steam_listener)

func listener_position() -> Vector3:
	return _listener.global_position if _listener != null and is_instance_valid(_listener) else Vector3(0, 1.66, 0)

## Called every frame by the weapon: where the muzzle and the shooter's head are. Keeps the reflection buffer warm.
func update_shooter(muzzle: Vector3, bore: Vector3, crouched := false) -> void:
	if _listener == null or not is_instance_valid(_listener):
		return
	var ear := _listener.global_position
	var b := _listener.global_transform.basis
	_shooter = {"src": muzzle, "ear": ear, "bore": bore, "valid": true, "crouch": crouched}
	var yaw := atan2(-b.z.x, -b.z.z)
	var key := ReflectionRenderer.make_key(ear, yaw, crouched, _binaural)
	if key != _refl_key:
		_refl_key = key
		_renderer.request(key, muzzle, ear, b.x, -b.z, bore, _binaural)

func start_ambience() -> void:
	if _started:
		return
	_started = true
	for g in ["amb_field_day", "amb_wind_trees"]:
		if not _groups.has(g):
			continue
		var p := AudioStreamPlayer.new()
		p.bus = "Amb"
		var st: AudioStream = _groups[g][0]["stream"]
		if st is AudioStreamOggVorbis:
			st.loop = true
		elif st is AudioStreamWAV:
			st.loop_mode = AudioStreamWAV.LOOP_FORWARD
			st.loop_end = int(st.get_length() * st.mix_rate)
		p.stream = st
		p.volume_db = -60.0
		add_child(p)
		p.play(_rng.randf() * maxf(st.get_length() - 1.0, 0.0))
		create_tween().tween_property(p, "volume_db", 0.0 if g == "amb_field_day" else -4.0, 3.0)
		_amb.append(p)

# ------------------------------------------------------------------ gunshot
func _shot_play(layer: String, stream: AudioStream, vol_db: float, pitch: float) -> void:
	if stream == null:
		return
	var arr: Array = _shot_pools[layer]
	var i: int = _shot_idx[layer]
	_shot_idx[layer] = (i + 1) % arr.size()
	var p: AudioStreamPlayer = arr[i]
	p.stream = stream
	p.volume_db = vol_db
	p.pitch_scale = pitch
	p.play()

## The player's own shot. Returns a description of what was scheduled (used by tests and evidence logs).
func play_shot(muzzle: Vector3, bore: Vector3) -> Dictionary:
	var ear := listener_position()
	var info := {"t": _now, "layers": [], "enclosure": AudioSchedule.bay_enclosure(ear)}
	var on := _pick("shot_p38_onset")
	if on.is_empty():
		return info
	var idx: int = on["index"]
	var lvl := _rng.randf_range(-0.6, 0.6)
	var pitch := _rng.randf_range(0.994, 1.006)
	var encl: float = info["enclosure"]
	# 1. dry onset (same recording as the tail, so together they reconstruct the original take)
	_shot_play("onset", on["stream"], lvl, pitch)
	info["layers"].append("onset")
	# 1b. a quiet close-microphone layer: at the shooter's position the blast is brighter than 2 m behind
	var close: Array = _groups.get("shot_close", [])
	if close.size() > 0:
		var ci := _rng.randi() % mini(close.size(), 6)       # the first six are one pistol at one microphone position
		_shot_play("close", close[ci]["stream"], lvl + SHOT_CLOSE_DB + (-1.0 - float(close[ci]["peak"])), pitch)
		info["layers"].append("close")
	# 2. natural recorded outdoor tail, a little lower under the roof
	var tails: Array = _groups.get("shot_p38_tail", [])
	if idx < tails.size():
		_shot_play("tail", tails[idx]["stream"], lvl + SHOT_TAIL_DB + linear_to_db(AudioSchedule.open_air(ear)), pitch)
		info["layers"].append("tail")
	# 3. geometric early reflections for this position (rendered ahead of time on a worker thread)
	var b := _listener.global_transform.basis if _listener != null and is_instance_valid(_listener) else Basis()
	var key := ReflectionRenderer.make_key(ear, atan2(-b.z.x, -b.z.z), bool(_shooter.get("crouch", false)), _binaural)
	var refl: Variant = _renderer.fetch(key)
	if refl == null and _refl_key != "":
		refl = _renderer.fetch(_refl_key)
	if refl != null and int(refl["taps"]) > 0:
		_shot_play("refl", refl["stream"], lvl + SHOT_REFLECTION_DB, 1.0)
		info["layers"].append("refl")
		info["refl_taps"] = refl["taps"]
		info["refl_first_delay"] = refl["first_delay"]
	else:
		_renderer.request(key, muzzle, ear, b.x, -b.z, bore, _binaural)
	# 4. late reverberation of the shed, in proportion to how enclosed the shooter is
	if encl > 0.02:
		var late := _pick("shot_bay_late")
		if not late.is_empty():
			_shot_play("late", late["stream"], lvl + SHOT_BAY_LATE_DB + linear_to_db(encl), 1.0)
			info["layers"].append("late")
	# 5. slap-back from the berms, arriving after their real path delay from where each berm is
	var echoes := AudioSchedule.berm_echoes(muzzle, ear)
	info["echoes"] = echoes
	for e in echoes:
		var grp := "shot_echo" if _groups.has("shot_echo") else "shot_distant_100m"
		_queue({"at": _now + float(e["delay"]), "group": grp, "pos": e["pos"], "vol": SHOT_ECHO_DB + linear_to_db(float(e["gain"])),
			"pitch": 1.0, "raw_level": true, "bus": "Shot", "lp": float(e["lp"])})
	_amb_duck = 1.0
	if log_events:
		event_log.append({"type": "shot", "t": _now, "info": info})
	return info

# ------------------------------------------------------------------ mechanics / foley (at the shooter)
## `only`: restrict to these variant indices. `peak_in`: seconds from now at which the loudest part of the sound
## (e.g. the seat click of a magazine insert) must fall; the sample is started early by its own lead-in.
func play_mech(group: String, vol_db := 0.0, delay := 0.0, pitch_jitter := 0.02, only: Array = [], peak_in := -1.0) -> void:
	var e := _pick(group, only)
	if e.is_empty():
		return
	if peak_in >= 0.0:
		delay = maxf(peak_in - float(e["peak_ms"]) * 0.001, 0.0)
	if delay > 0.0:
		_queue({"at": _now + delay, "mech": group, "vol": vol_db, "pj": pitch_jitter, "entry": e})
		return
	_start_mech(e, group, vol_db, pitch_jitter)

func _start_mech(e: Dictionary, group: String, vol_db: float, pitch_jitter: float) -> void:
	var p := _mech_pool[_mech_i]
	_mech_i = (_mech_i + 1) % _mech_pool.size()
	p.stream = e["stream"]
	# files are mastered close to full scale: bring them to a common -6 dBFS peak, but let takes that are
	# naturally more than 8 dB quieter than full scale stay quieter
	p.volume_db = vol_db + (-6.0 - maxf(float(e["peak"]), -9.0))
	p.pitch_scale = 1.0 + _rng.randf_range(-pitch_jitter, pitch_jitter)
	p.play()
	if log_events:
		event_log.append({"type": "mech", "t": _now, "group": group})

func play_step(surface: String, intensity := 1.0) -> void:
	var g := "step_" + surface
	if not _groups.has(g):
		g = "step_dirt" if _groups.has("step_dirt") else "step_concrete"
	play_mech(g, STEP_DB - MECH_BUS_DB + linear_to_db(clampf(intensity, 0.05, 1.5)), 0.0, 0.04)

func play_cloth(intensity := 1.0) -> void:
	play_mech("cloth_move", CLOTH_DB - MECH_BUS_DB + linear_to_db(clampf(intensity, 0.05, 1.5)), 0.0, 0.05)

# ------------------------------------------------------------------ world one-shots
func play_world(group: String, position: Vector3, opts := {}) -> void:
	if not _groups.has(group):
		_pick(group)   # one warning
		return
	var dist := position.distance_to(listener_position())
	var d := {"at": _now + dist / C + float(opts.get("delay", 0.0)), "group": group, "pos": position,
		"vol": float(opts.get("volume_db", 0.0)) + linear_to_db(clampf(float(opts.get("intensity", 1.0)), 0.02, 2.0)),
		"pitch": float(opts.get("pitch", 1.0)), "follow": opts.get("follow"), "bus": "World", "emit_t": _now, "dist": dist}
	_queue(d)

func _queue(d: Dictionary) -> void:
	if log_events:
		event_log.append({"type": "queued", "t": _now, "at": d["at"], "group": d.get("group", d.get("mech", "")), "dist": d.get("dist", 0.0)})
	var i := _pending.size()
	while i > 0 and float(_pending[i - 1]["at"]) > float(d["at"]):
		i -= 1
	_pending.insert(i, d)

func _build_world_pool() -> void:
	for p in _world_pool:
		if is_instance_valid(p):
			p.queue_free()
	_world_pool.clear()
	_world_follow.clear()
	var use_steam := _steam_ok and _binaural
	for i in 32:
		var p: AudioStreamPlayer3D
		if use_steam:
			# A SteamAudioPlayer only spatialises the stream it owns when it enters the tree; other sounds are
			# then sent through that playback with play_stream(). Re-assigning `stream` later bypasses the HRTF.
			p = ClassDB.instantiate("SteamAudioPlayer")
			p.stream = _silence
			p.set("distance_attenuation", false)     # its 1/d law has a fixed 1 m reference: distance is handled here
			p.set("air_absorption", true)
			p.panning_strength = 0.0
			p.bus = "WorldSA"
			p.max_db = 80.0
		else:
			p = AudioStreamPlayer3D.new()
			p.panning_strength = 1.0
			p.attenuation_filter_db = 0.0
			p.bus = "World"
			p.max_db = 6.0
		p.attenuation_model = AudioStreamPlayer3D.ATTENUATION_DISABLED
		p.max_distance = 0.0
		p.set_meta("steam", use_steam)
		p.set_meta("busy_until", 0.0)
		add_child(p)
		_world_pool.append(p)

func _start_world(d: Dictionary) -> void:
	var e := _pick(str(d["group"]))
	if e.is_empty():
		return
	var cfg: Dictionary = WORLD_CFG.get(str(d["group"]), WORLD_CFG["_default"])
	var pos: Vector3 = d["pos"]
	var follow: Variant = d.get("follow")
	if follow != null and is_instance_valid(follow) and follow is Node3D:
		pos = (follow as Node3D).global_position
	var ear := listener_position()
	var dist := pos.distance_to(ear)
	if dist > float(cfg["max"]) and not d.get("raw_level", false):
		return
	# pick the voice that has been idle longest; never cut a voice that is still clearly audible
	var p: AudioStreamPlayer3D = null
	for k in _world_pool.size():
		var c: AudioStreamPlayer3D = _world_pool[(_world_i + k) % _world_pool.size()]
		if float(c.get_meta("busy_until", 0.0)) <= _now:
			p = c
			_world_i = (_world_i + k + 1) % _world_pool.size()
			break
	if p == null:
		p = _world_pool[_world_i]
		_world_i = (_world_i + 1) % _world_pool.size()
	var vol := float(d["vol"])
	if not d.get("raw_level", false):
		# inverse-distance law from the group's reference distance (level contains the path loss already for echo layers)
		var ref := float(cfg["ref"])
		# `rolloff` < 1 (ringing steel only) is a deliberate departure from 1/d so distant plates stay audible at the
		# compressed playback level (docs/APPROXIMATIONS.md)
		vol += float(cfg["trim"]) - 20.0 * float(cfg.get("rolloff", 1.0)) * log(maxf(dist, ref) / ref) / log(10.0)
		# bring every file to a common loudness (-22 LUFS) as far as its peak allows (never above -0.5 dBFS)
		vol += clampf(-22.0 - float(e["lufs"]), -6.0, minf(12.0, -0.5 - float(e["peak"])))
	# echo layers are placed on the reflecting surface itself: no occlusion test for them
	var occ := 0.0 if d.get("raw_level", false) else _occlusion(ear, pos)
	vol -= 11.0 * occ
	# all positional voices leave through the World bus: fold the trim of the logical bus into the voice level
	match str(d.get("bus", "World")):
		"Shot": vol += SHOT_BUS_DB - WORLD_BUS_DB
		"Amb": vol += AMB_BUS_DB + linear_to_db(maxf(Settings.getf("ambience_volume"), 1e-4)) - WORLD_BUS_DB
	p.global_position = pos
	p.pitch_scale = clampf(float(d["pitch"]), 0.5, 2.0)
	p.set_meta("busy_until", _now + float(e["dur"]) / p.pitch_scale + 0.05)
	if p.get_meta("steam", false):
		p.volume_db = clampf(vol + SA_OFFSET_DB, 0.0, 80.0)
		p.call("play_stream", e["stream"], 0.0, 0.0, p.pitch_scale)
	else:
		p.stream = e["stream"]
		p.volume_db = vol + STEREO_MAKEUP_DB
		p.play()
	if follow != null and is_instance_valid(follow):
		_world_follow[p] = follow
	else:
		_world_follow.erase(p)
	if log_events:
		event_log.append({"type": "world", "t": _now, "group": d["group"], "dist": dist, "emit_t": d.get("emit_t", _now), "occ": occ, "vol_db": vol, "file": e["file"], "peak": e["peak"]})

## 0 = clear line of sight, 1 = fully blocked by static geometry (3 rays: centre and two offsets)
func _occlusion(ear: Vector3, pos: Vector3) -> float:
	if _listener == null or not is_instance_valid(_listener) or not _listener.is_inside_tree():
		return 0.0
	var space := _listener.get_world_3d().direct_space_state
	if space == null:
		return 0.0
	var blocked := 0
	var dir := (pos - ear)
	if dir.length() < 0.6:
		return 0.0
	var side := dir.normalized().cross(Vector3.UP).normalized() * 0.25
	for off: Vector3 in [Vector3.ZERO, side, -side]:
		var q := PhysicsRayQueryParameters3D.create(ear + off, pos + off + (ear - pos).normalized() * 0.15, 1)
		var r := space.intersect_ray(q)
		if not r.is_empty():
			blocked += 1
	return blocked / 3.0

# ------------------------------------------------------------------ frame
func _process(delta: float) -> void:
	if get_tree().paused:
		return
	_now += delta
	if _amb_duck > 0.0:
		_amb_duck = maxf(_amb_duck - delta / 1.5, 0.0)
		AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Amb"), AMB_BUS_DB + linear_to_db(maxf(Settings.getf("ambience_volume"), 1e-4))
			+ AMB_DUCK_DB * smoothstep(0.0, 1.0, _amb_duck))
	while _pending.size() > 0 and float(_pending[0]["at"]) <= _now:
		var d: Dictionary = _pending.pop_front()
		if d.has("mech"):
			_start_mech(d["entry"], str(d["mech"]), float(d["vol"]), float(d.get("pj", 0.02)))
		else:
			_start_world(d)
	for p in _world_follow.keys():
		var f: Variant = _world_follow[p]
		if not is_instance_valid(p) or float(p.get_meta("busy_until", 0.0)) <= _now or f == null or not is_instance_valid(f):
			_world_follow.erase(p)
		else:
			p.global_position = (f as Node3D).global_position
	if _started and Settings.getb("distant_range") and _groups.has("shot_distant_100m"):
		_distant_timer -= delta
		if _distant_timer <= 0.0:
			_distant_timer = _rng.randf_range(22.0, 75.0)
			_distant_string()

## a few shots from a neighbouring range, far behind-left: the same family of gun heard at a distance
func _distant_string() -> void:
	var n := _rng.randi_range(1, 4)
	var t := 0.0
	var base := Vector3(-260.0, 2.0, 190.0)
	for i in n:
		_queue({"at": _now + t, "group": "shot_distant_100m", "pos": base + Vector3(_rng.randf_range(-6, 6), 0, _rng.randf_range(-6, 6)),
			"vol": -21.0 + _rng.randf_range(-1.5, 1.5), "pitch": _rng.randf_range(0.985, 1.015), "raw_level": true, "bus": "Amb", "lp": 2500.0})
		t += _rng.randf_range(0.45, 1.6)

func now() -> float:
	return _now

func pending_count() -> int:
	return _pending.size()

func stop_all() -> void:
	_pending.clear()
	for layer in _shot_pools:
		for p in _shot_pools[layer]:
			p.stop()
	for p in _world_pool:
		p.stop()
	for p in _mech_pool:
		p.stop()

func get_stats() -> Dictionary:
	var playing := 0
	for p in _world_pool:
		if float(p.get_meta("busy_until", 0.0)) > _now:
			playing += 1
	return {"world_voices": playing, "pending": _pending.size(), "groups": _groups.size(), "refl_renders": _renderer.renders,
		"refl_ms": _renderer.last_render_ms, "binaural": _binaural, "steam": _steam_ok}
