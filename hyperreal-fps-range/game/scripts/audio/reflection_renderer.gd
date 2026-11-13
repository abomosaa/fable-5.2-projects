class_name ReflectionRenderer
extends RefCounted
## Renders the discrete early reflections of a gunshot for one shooter position into a short stereo buffer,
## on a worker thread, ahead of the shot. Each reflection is a delayed, attenuated, material-filtered copy of
## the dry onset ("crack") of a real recording, placed by a spherical-head binaural model (interaural time and
## level difference, far-ear shadow filter) or by constant-power panning in stereo mode. Delays are baked at
## sample accuracy, which the engine's block-quantised voice start times cannot provide.

const SR := 48000
const HEAD_ITD_MAX := 0.00066          # s, at 90 degrees
const HEADROOM := 0.5                  # buffers are rendered at -6 dB; the player adds it back
const LP_CLASSES: PackedFloat32Array = [14000.0, 7000.0, 3500.0, 1800.0]

var _onsets: Array = []                # Array[Array[PackedFloat32Array]] : [variant][lp_class]
var _thread: Thread
var _mutex := Mutex.new()
var _sem := Semaphore.new()
var _quit := false
var _req := {}
var _cache := {}
var _lru: Array = []
var cache_limit := 48
var renders := 0
var last_render_ms := 0.0

func setup(onset_streams: Array) -> void:
	for st in onset_streams:
		var x := pcm_mono(st)
		if x.size() == 0:
			continue
		var cls := []
		for fc in LP_CLASSES:
			cls.append(_lowpass(x, fc))
		_onsets.append(cls)
	if _onsets.size() > 0:
		_thread = Thread.new()
		_thread.start(_loop)

func shutdown() -> void:
	if _thread == null:
		return
	_mutex.lock()
	_quit = true
	_mutex.unlock()
	_sem.post()
	_thread.wait_to_finish()
	_thread = null

static func pcm_mono(st: AudioStreamWAV) -> PackedFloat32Array:
	var out := PackedFloat32Array()
	if st == null or st.format != AudioStreamWAV.FORMAT_16_BITS:
		return out
	var d := st.data
	var ch := 2 if st.stereo else 1
	var n := d.size() / (2 * ch)
	out.resize(n)
	for i in n:
		var v := float(d.decode_s16(i * 2 * ch))
		if ch == 2:
			v = (v + float(d.decode_s16(i * 4 + 2))) * 0.5
		out[i] = v / 32768.0
	return out

static func _lowpass(x: PackedFloat32Array, fc: float) -> PackedFloat32Array:
	var y := PackedFloat32Array()
	y.resize(x.size())
	var a := 1.0 - exp(-TAU * fc / SR)
	var s := 0.0
	for i in x.size():
		s += a * (x[i] - s)
		y[i] = s
	return y

static func make_key(ear: Vector3, yaw: float, crouch: bool, binaural: bool) -> String:
	return "%d_%d_%d_%d_%d_%d" % [roundi(ear.x * 4.0), roundi(ear.y * 5.0), roundi(ear.z * 4.0), roundi(yaw / deg_to_rad(12.0)), int(crouch), int(binaural)]

## Ask for the reflection buffer of this configuration (cheap; latest request wins).
func request(key: String, src: Vector3, ear: Vector3, head_right: Vector3, head_fwd: Vector3, bore: Vector3, binaural: bool) -> void:
	if _thread == null:
		return
	_mutex.lock()
	var have := _cache.has(key)
	if not have:
		_req = {"key": key, "src": src, "ear": ear, "right": head_right, "fwd": head_fwd, "bore": bore, "binaural": binaural}
	_mutex.unlock()
	if not have:
		_sem.post()

## {stream, taps, peak} or null if not rendered yet.
func fetch(key: String) -> Variant:
	_mutex.lock()
	var v: Variant = _cache.get(key)
	_mutex.unlock()
	return v

func _loop() -> void:
	while true:
		_sem.wait()
		_mutex.lock()
		var q := _quit
		var r := _req
		_req = {}
		_mutex.unlock()
		if q:
			return
		if r.is_empty():
			continue
		var t0 := Time.get_ticks_usec()
		var res := render(r["src"], r["ear"], r["right"], r["fwd"], r["bore"], r["binaural"], renders % _onsets.size())
		_mutex.lock()
		_cache[r["key"]] = res
		_lru.append(r["key"])
		while _lru.size() > cache_limit:
			_cache.erase(_lru.pop_front())
		renders += 1
		last_render_ms = (Time.get_ticks_usec() - t0) / 1000.0
		_mutex.unlock()

func render(src: Vector3, ear: Vector3, right: Vector3, fwd: Vector3, bore: Vector3, binaural: bool, variant: int) -> Dictionary:
	var taps := AudioSchedule.early_reflections(src, ear, bore)
	var cls: Array = _onsets[variant]
	var n_on: int = (cls[0] as PackedFloat32Array).size()
	var max_d := 0.0
	for t in taps:
		max_d = maxf(max_d, t["delay"])
	var n := n_on + int(ceil((max_d + HEAD_ITD_MAX) * SR)) + 8
	var L := PackedFloat32Array()
	var R := PackedFloat32Array()
	L.resize(n)
	R.resize(n)
	for t in taps:
		var dir: Vector3 = t["dir"]
		var lat := clampf(dir.dot(right), -1.0, 1.0)        # +1 = fully to the right
		var front := dir.dot(fwd)
		var g: float = float(t["gain"]) * HEADROOM
		var d0 := int(round(float(t["delay"]) * SR))
		var ci := _lp_class(float(t["lp"]))
		if binaural:
			var a := absf(lat)
			var itd := int(round(HEAD_ITD_MAX * a * SR))
			var near_g := g * (1.0 + 0.18 * a)
			var far_g := g * (1.0 - 0.42 * a)
			# sounds from behind lose a little top end at both ears (pinna shadow)
			var back := 1 if front < -0.3 else 0
			var near_c := mini(ci + back, LP_CLASSES.size() - 1)
			var far_c := mini(ci + back + (1 if a > 0.35 else 0) + (1 if a > 0.75 else 0), LP_CLASSES.size() - 1)
			if lat >= 0.0:
				_mix(R, cls[near_c], d0, near_g)
				_mix(L, cls[far_c], d0 + itd, far_g)
			else:
				_mix(L, cls[near_c], d0, near_g)
				_mix(R, cls[far_c], d0 + itd, far_g)
		else:
			var p := (lat * 0.85 + 1.0) * PI * 0.25
			_mix(L, cls[ci], d0, g * cos(p) * 1.4142)
			_mix(R, cls[ci], d0, g * sin(p) * 1.4142)
	var peak := 0.0
	var data := PackedByteArray()
	data.resize(n * 4)
	for i in n:
		var l := L[i]
		var r := R[i]
		peak = maxf(peak, maxf(absf(l), absf(r)))
		data.encode_s16(i * 4, int(clampf(l, -1.0, 1.0) * 32767.0))
		data.encode_s16(i * 4 + 2, int(clampf(r, -1.0, 1.0) * 32767.0))
	var st := AudioStreamWAV.new()
	st.format = AudioStreamWAV.FORMAT_16_BITS
	st.mix_rate = SR
	st.stereo = true
	st.data = data
	return {"stream": st, "taps": taps.size(), "peak": peak, "first_delay": (taps[0]["delay"] if taps.size() > 0 else 0.0), "tap_list": taps}

static func _lp_class(fc: float) -> int:
	for i in LP_CLASSES.size():
		if fc >= LP_CLASSES[i] * 0.8:
			return i
	return LP_CLASSES.size() - 1

static func _mix(dst: PackedFloat32Array, src: PackedFloat32Array, offset: int, gain: float) -> void:
	var n := mini(src.size(), dst.size() - offset)
	for i in n:
		dst[offset + i] += src[i] * gain
