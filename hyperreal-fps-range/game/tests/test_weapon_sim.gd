extends RefCounted
## Deterministic tests of the pistol state machine: transitions, ammunition conservation, interrupted actions.

static var _f: Array = []

static func _ok(cond: bool, msg: String) -> void:
	if not cond:
		_f.append(msg)

static func _names(evs: Array) -> Array:
	return evs.map(func(e): return e["name"])

## advance in small frames, collecting event names
static func _run_for(s: WeaponSim, secs: float, dt := 1.0 / 120.0) -> Array:
	var out: Array = []
	var t := 0.0
	while t < secs - 1e-9:
		out.append_array(s.advance(dt))
		t += dt
	return out

static func _tap(s: WeaponSim, hold := 0.03) -> Array:
	s.set_trigger(true)
	var evs := _run_for(s, hold)
	s.set_trigger(false)
	return evs

static func run() -> Array:
	_f = []
	_initial_state()
	_da_then_sa()
	_held_trigger_fires_once()
	_da_abort()
	_run_empty_and_lock()
	_reload_empty_cycle()
	_reload_tactical_keeps_chamber()
	_reload_cancel_and_spam()
	_no_fire_while_reloading()
	_safety_and_decock()
	_hammer_cock()
	_event_order_and_timing()
	_frame_rate_independence()
	_conservation_fuzz()
	_focus_loss()
	_all_ammo_gone()
	return _f

static func _initial_state() -> void:
	var s := WeaponSim.new()
	_ok(s.chamber_live and s.rounds_in_gun_mag() == 8 and not s.hammer_cocked and not s.safety_on, "initial: 8+1, hammer down, safety off")
	_ok(s.total_rounds() == WeaponDef.MAGAZINES * 8 + 1, "initial total rounds")
	_ok(s.trigger_deg() == 0.0 and s.hammer_deg() == 0.0 and s.slide_pos() == 0.0, "initial part positions")

static func _da_then_sa() -> void:
	var s := WeaponSim.new()
	s.set_trigger(true)
	var e1 := s.advance(0.05)
	_ok(not _names(e1).has("shot"), "DA: no shot after 50 ms of the long stroke")
	_ok(s.hammer_deg() > 5.0, "DA: hammer rises with the trigger")
	var e2 := _run_for(s, 0.2)
	_ok(_names(e2).has("shot"), "DA: shot after the full stroke")
	for e in e2:
		if e["name"] == "shot":
			_ok(e["da"] == true, "first shot flagged double-action")
			_ok(absf(float(e["t"]) - (WeaponDef.DA_PULL_TIME + WeaponDef.LOCK_TIME)) < 1e-6, "DA shot time = stroke + lock time, got %f" % e["t"])
	s.set_trigger(false)
	_run_for(s, 0.1)
	_ok(s.hammer_cocked and s.in_battery() and s.chamber_live and s.rounds_in_gun_mag() == 7, "after first shot: cocked, in battery, 7 in mag")
	_ok(absf(s.trigger_deg() - WeaponDef.TRIGGER_SA_REST_DEG) < 0.01, "trigger rests at SA position when cocked")
	s.set_trigger(true)
	var e3 := s.advance(0.02)
	_ok(_names(e3).has("shot"), "SA: shot within 20 ms of the press")
	for e in e3:
		if e["name"] == "shot":
			_ok(e["da"] == false, "second shot is single-action")

static func _held_trigger_fires_once() -> void:
	var s := WeaponSim.new()
	s.set_trigger(true)
	var evs := _run_for(s, 2.0)
	_ok(_names(evs).count("shot") == 1, "held trigger: exactly one shot (got %d)" % _names(evs).count("shot"))
	s.set_trigger(false)
	_run_for(s, 0.1)
	s.set_trigger(true)
	_ok(_names(_run_for(s, 0.1)).count("shot") == 1, "released and pressed again: one more shot")

static func _da_abort() -> void:
	var s := WeaponSim.new()
	s.set_trigger(true)
	s.advance(0.06)
	s.set_trigger(false)
	var evs := _run_for(s, 0.3)
	_ok(not _names(evs).has("shot") and s.total_rounds() == WeaponDef.MAGAZINES * 8 + 1, "DA stroke released early: no shot, no round lost")
	_ok(s.hammer_deg() == 0.0 and not s.hammer_cocked, "DA abort: hammer back down")

static func _fire_n(s: WeaponSim, n: int) -> int:
	var shots := 0
	for i in n:
		var evs := _tap(s, 0.2)
		evs.append_array(_run_for(s, 0.15))
		shots += _names(evs).count("shot")
	return shots

static func _run_empty_and_lock() -> void:
	var s := WeaponSim.new()
	var shots := _fire_n(s, 9)
	_ok(shots == 9, "8+1 gives 9 shots (got %d)" % shots)
	_ok(s.slide_state == WeaponSim.Slide.LOCKED and not s.chamber_live and s.rounds_in_gun_mag() == 0, "slide locks open on the empty magazine")
	_ok(absf(s.slide_pos() - WeaponDef.SLIDE_LOCK_POS) < 1e-6 and s.slide_stop_up() == 1.0, "locked slide position / slide stop up")
	var evs := _tap(s, 0.1)
	evs.append_array(_run_for(s, 0.2))
	_ok(not _names(evs).has("shot") and not _names(evs).has("dry_fire") and _names(evs).has("dead_trigger"), "slide locked: dead trigger, no hammer fall")
	_ok(s.hammer_cocked, "hammer stays cocked at slide lock")

static func _reload_empty_cycle() -> void:
	var s := WeaponSim.new()
	_fire_n(s, 9)
	var before := s.total_rounds()
	_ok(s.request_reload(), "reload accepted at slide lock")
	_ok(s.action_clip == "reload_empty", "empty reload clip chosen")
	var evs := _run_for(s, 4.5)
	var n := _names(evs)
	for name in ["mag_release", "mag_out", "mag_swap", "mag_in", "slide_release", "feed", "slide_in_battery", "reload_done"]:
		_ok(n.has(name), "empty reload emits " + name)
	_ok(n.find("mag_out") < n.find("mag_swap") and n.find("mag_swap") < n.find("mag_in") and n.find("mag_in") < n.find("slide_release")
		and n.find("slide_release") < n.find("feed"), "empty reload event order")
	_ok(s.total_rounds() == before, "reload conserves ammunition (%d -> %d)" % [before, s.total_rounds()])
	_ok(s.chamber_live and s.rounds_in_gun_mag() == 7 and s.in_battery() and s.hammer_cocked, "after empty reload: chambered, 7 in mag, cocked")
	_ok(_fire_n(s, 1) == 1, "fires after reload")

static func _reload_tactical_keeps_chamber() -> void:
	var s := WeaponSim.new()
	_fire_n(s, 3)
	var before := s.total_rounds()
	_ok(s.request_reload() and s.action_clip == "reload", "tactical reload clip")
	_run_for(s, 4.0)
	_ok(s.chamber_live and s.rounds_in_gun_mag() == 8 and s.total_rounds() == before, "tactical reload: 8+1, partial magazine kept")
	var partial := 0
	for m in s.magazines:
		if m == 5:
			partial += 1
	_ok(partial == 1, "the partly used magazine (5 rounds) is retained")
	_ok(not s.request_reload(), "no reload when no spare holds more than the magazine in the gun")

static func _reload_cancel_and_spam() -> void:
	var s := WeaponSim.new()
	_fire_n(s, 2)
	var before := s.total_rounds()
	s.request_reload()
	s.advance(0.2)
	_ok(not s.request_reload() and s.action == WeaponSim.Act.RELOAD, "a second reload press while reloading is ignored")
	for i in 40:                  # hammering the key must not restart, cancel or duplicate anything
		s.advance(0.1)
		s.request_reload()
	_ok(s.action == WeaponSim.Act.NONE and s.total_rounds() == before and s.rounds_in_gun_mag() == 8 and s.chamber_live, "reload spam: one clean reload, ammo conserved")
	# trigger press before commit cancels the reload and (SA) fires
	var s2 := WeaponSim.new()
	_fire_n(s2, 2)
	s2.request_reload()
	s2.advance(0.2)
	var evs := _tap(s2, 0.05)
	_ok(_names(evs).has("reload_cancel") and _names(evs).has("shot"), "trigger before commit: reload cancelled, gun fires")

static func _no_fire_while_reloading() -> void:
	var s := WeaponSim.new()
	_fire_n(s, 2)
	s.request_reload()
	s.advance(0.7)                # magazine catch pressed: committed
	var shots_before := s.shots_fired
	var evs: Array = []
	for i in 20:
		s.set_trigger(true)
		evs.append_array(s.advance(0.05))
		s.set_trigger(false)
		evs.append_array(s.advance(0.05))
	_ok(s.shots_fired == shots_before, "no shot while the magazine is being changed")
	_run_for(s, 3.0)
	s.set_trigger(true)
	evs = _run_for(s, 0.1)
	_ok(_names(evs).has("shot"), "fires again once the reload is complete")

static func _safety_and_decock() -> void:
	var s := WeaponSim.new()
	_fire_n(s, 1)
	_ok(s.hammer_cocked, "cocked before applying safety")
	_ok(s.request_safety_toggle(), "safety toggle accepted")
	var evs := _run_for(s, 0.6)
	_ok(_names(evs).has("decock") and _names(evs).has("safety_on") and s.safety_on and not s.hammer_cocked, "safety on decocks the hammer")
	_ok(_names(evs).find("decock") < _names(evs).find("safety_on"), "hammer drops before the lever reaches SAFE")
	_ok(absf(s.safety_deg() - WeaponDef.SAFETY_SAFE_DEG) < 1e-6, "lever at SAFE angle")
	var shots := s.shots_fired
	evs = _tap(s, 0.3)
	evs.append_array(_run_for(s, 0.3))
	_ok(s.shots_fired == shots and _names(evs).has("dead_trigger") and s.chamber_live, "safety on: trigger dead, round stays chambered")
	s.request_safety_toggle()
	_run_for(s, 0.6)
	_ok(not s.safety_on and not s.hammer_cocked, "safety off: hammer still down")
	s.set_trigger(true)
	evs = _run_for(s, 0.3)
	var da := false
	for e in evs:
		if e["name"] == "shot":
			da = e["da"]
	_ok(da, "first shot after decocking is double-action")

static func _hammer_cock() -> void:
	var s := WeaponSim.new()
	_ok(s.request_cock_hammer(), "cocking accepted with hammer down")
	var evs := _run_for(s, 0.6)
	_ok(s.hammer_cocked and _names(evs).has("hammer_cocked"), "hammer cocked by thumb")
	_ok(not s.request_cock_hammer(), "cannot cock an already cocked hammer")
	s.set_trigger(true)
	evs = s.advance(0.02)
	var sa := false
	for e in evs:
		if e["name"] == "shot":
			sa = not e["da"]
	_ok(sa, "thumb-cocked first shot is single-action")

static func _event_order_and_timing() -> void:
	var s := WeaponSim.new()
	s.request_cock_hammer()
	_run_for(s, 0.6)
	var t0 := s.time
	s.set_trigger(true)
	var evs := _run_for(s, 0.2, 1.0 / 240.0)
	var at := {}
	for e in evs:
		if not at.has(e["name"]):
			at[e["name"]] = float(e["t"]) - t0
	_ok(absf(at.get("hammer_fall", -1.0)) < 1e-6, "hammer falls at the press")
	_ok(absf(at.get("shot", -1.0) - WeaponDef.LOCK_TIME) < 1e-6, "ignition at lock time")
	_ok(absf(at.get("eject", -1.0) - (WeaponDef.LOCK_TIME + WeaponDef.EJECT_TIME)) < 1e-6, "ejection time")
	_ok(absf(at.get("feed", -1.0) - (WeaponDef.LOCK_TIME + WeaponDef.FEED_TIME)) < 1e-6, "feed time")
	_ok(absf(at.get("slide_in_battery", -1.0) - (WeaponDef.LOCK_TIME + WeaponDef.CYCLE_TIME)) < 1e-6, "in-battery time")
	# slide curve sanity
	var peak := 0.0
	for i in 60:
		peak = maxf(peak, WeaponSim._cycle_curve(i * 0.001, false))
	_ok(absf(peak - WeaponDef.SLIDE_STROKE) < 1e-4, "slide reaches full stroke")
	_ok(WeaponSim._cycle_curve(WeaponDef.CYCLE_TIME, false) < 1e-6, "slide returns to battery")
	_ok(absf(WeaponSim._cycle_curve(WeaponDef.CYCLE_TIME, true) - WeaponDef.SLIDE_LOCK_POS) < 1e-6, "locking cycle ends at the stop")

static func _frame_rate_independence() -> void:
	var results := []
	for dt: float in [1.0 / 30.0, 1.0 / 60.0, 1.0 / 144.0, 1.0 / 1000.0]:
		var s := WeaponSim.new()
		var times := []
		var t := 0.0
		var next_press := 0.0
		while t < 3.0:
			# press at exact multiples of 0.3 s, release 0.1 s later, independent of the frame size
			var te: float = t + dt
			if next_press <= te:
				s.advance(next_press - s.time)
				s.set_trigger(true)
				for e in s.advance(0.1):
					if e["name"] == "shot":
						times.append(snappedf(e["t"], 1e-6))
				s.set_trigger(false)
				next_press += 0.3
			for e in s.advance(maxf(te - s.time, 0.0)):
				if e["name"] == "shot":
					times.append(snappedf(e["t"], 1e-6))
			t = te
		results.append(times)
	for i in range(1, results.size()):
		_ok(results[i] == results[0], "shot times identical at different frame rates (%s vs %s)" % [str(results[i]).left(60), str(results[0]).left(60)])

static func _conservation_fuzz() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 20261111
	for trial in 40:
		var s := WeaponSim.new()
		var start := s.total_rounds()
		for step in 600:
			match rng.randi() % 9:
				0, 1, 2: s.set_trigger(true)
				3, 4: s.set_trigger(false)
				5: s.request_reload()
				6: s.request_safety_toggle()
				7: s.request_cock_hammer()
				8: s.request_inspect()
			s.advance(rng.randf_range(0.001, 0.25))
			if s.total_rounds() + s.shots_fired != start:
				_ok(false, "fuzz: rounds + shots != start at trial %d step %d (%d + %d != %d)" % [trial, step, s.total_rounds(), s.shots_fired, start])
				return
			for m in s.magazines:
				if m < 0 or m > WeaponDef.MAG_CAPACITY:
					_ok(false, "fuzz: magazine count out of range")
					return
			if s.slide_state == WeaponSim.Slide.LOCKED and s.chamber_live:
				_ok(false, "fuzz: slide locked open with a chambered round")
				return
			if s.safety_on and s.hammer_cocked and s.action == WeaponSim.Act.NONE:
				_ok(false, "fuzz: safety on with the hammer cocked")
				return
		s.set_trigger(false)
		_run_for(s, 6.0)
		_ok(s.action == WeaponSim.Act.NONE, "fuzz: settles to no action")
		_ok(s.mag_in_gun >= 0, "fuzz: a magazine is in the gun at rest")

static func _focus_loss() -> void:
	var s := WeaponSim.new()
	s.set_trigger(true)
	s.advance(0.05)               # mid double-action stroke
	s.release_inputs()
	var evs := _run_for(s, 1.0)
	_ok(not _names(evs).has("shot"), "focus loss mid-stroke: no phantom shot")
	_ok(s.total_rounds() == WeaponDef.MAGAZINES * 8 + 1, "focus loss: no round lost")

static func _all_ammo_gone() -> void:
	var s := WeaponSim.new()
	var guard := 0
	while s.total_rounds() > 0 and guard < 200:
		guard += 1
		if s.slide_state == WeaponSim.Slide.LOCKED or (not s.chamber_live):
			if not s.request_reload():
				break
			_run_for(s, 4.5)
		else:
			_fire_n(s, 1)
	_ok(s.total_rounds() == 0 and s.shots_fired == WeaponDef.MAGAZINES * 8 + 1, "every round can be fired, none invented (%d left, %d shots)" % [s.total_rounds(), s.shots_fired])
	_ok(not s.request_reload(), "no reload possible with every magazine empty")
	var evs := _tap(s, 0.2)
	_ok(not _names(evs).has("shot"), "empty gun does not fire")
