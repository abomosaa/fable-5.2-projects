class_name WeaponSim
extends RefCounted
## Authoritative state machine of the pistol. Pure logic: no nodes, no engine time.
## Everything visible or audible (hands, parts, flash, sound, projectile, casing) is derived from this
## object's state and from the time-stamped events returned by advance().
##
## Design rules enforced here (and tested in tests/test_weapon_sim.gd):
##  * a shot needs: live round chambered, slide in battery, safety off, hands on the gun, a fresh trigger press
##  * ammunition is conserved: rounds only move magazine -> chamber -> fired/ejected
##  * every action resolves to a valid state, including when interrupted or when input is lost

enum Slide { CLOSED, CYCLING, LOCKED, RELEASING }
enum Act { NONE, RELOAD, INSPECT, SAFETY, HAMMER_COCK }

# ---- persistent state ----
var time := 0.0
var magazines: Array[int] = []      # rounds in every magazine of the session
var mag_in_gun := -1                # index into magazines, -1 = no magazine inserted
var chamber_live := false
var hammer_cocked := false
var safety_on := false
var slide_state: int = Slide.CLOSED
var shots_fired := 0

# ---- trigger ----
var trigger_held := false           # player input
var _needs_reset := false           # disconnector: trigger must be released before the next shot
var _press_pending := false         # a press arrived while the gun could not yet act on it (still cycling)
var _da_start := -1.0               # start time of a double-action stroke in progress
var _fire_at := -1.0                # scheduled ignition time
var _fire_is_da := false
var _dry_at := -1.0                 # scheduled dry hammer fall
var _trigger_deg := 0.0
var _hammer_fall_from := 0.0
var _hammer_fall_t0 := -1.0

# ---- slide cycle ----
var _cycle_t0 := -1.0
var _cycle_will_lock := false
var _cycle_ejected := false
var _cycle_fed := false
var _release_t0 := -1.0

# ---- current hand action ----
var action: int = Act.NONE
var action_clip := ""
var action_t0 := 0.0
var _action_fired := {}             # events of the running clip already handled
var _reload_committed := false
var _reload_removed_mag := -1
var _safety_from := 0.0
var _safety_to := 0.0
var clips: Dictionary = WeaponDef.DEFAULT_CLIPS.duplicate(true)

var _events: Array[Dictionary] = []

func _init() -> void:
	reset()

## Fresh session: full magazines, one inserted, round chambered, hammer down (double-action first shot), safety off.
func reset() -> void:
	time = 0.0
	magazines.clear()
	for i in WeaponDef.MAGAZINES:
		magazines.append(WeaponDef.MAG_CAPACITY)
	mag_in_gun = 0
	chamber_live = true
	hammer_cocked = false
	safety_on = false
	slide_state = Slide.CLOSED
	shots_fired = 0
	trigger_held = false
	_needs_reset = false
	_press_pending = false
	_da_start = -1.0
	_fire_at = -1.0
	_dry_at = -1.0
	_trigger_deg = 0.0
	_hammer_fall_t0 = -1.0
	_cycle_t0 = -1.0
	_release_t0 = -1.0
	action = Act.NONE
	action_clip = ""
	_action_fired.clear()
	_reload_committed = false
	_reload_removed_mag = -1
	_events.clear()

func set_clips(c: Dictionary) -> void:
	for k in c:
		clips[k] = c[k]

# ------------------------------------------------------------------ queries
func total_rounds() -> int:
	var n := 1 if chamber_live else 0
	for m in magazines:
		n += m
	return n

func rounds_in_gun_mag() -> int:
	return magazines[mag_in_gun] if mag_in_gun >= 0 else 0

func spare_loaded_magazines() -> int:
	var n := 0
	for i in magazines.size():
		if i != mag_in_gun and magazines[i] > 0:
			n += 1
	return n

func in_battery() -> bool:
	return slide_state == Slide.CLOSED

func hands_busy() -> bool:
	return action != Act.NONE

func action_time() -> float:
	return time - action_t0 if action != Act.NONE else 0.0

func can_fire_now() -> bool:
	return chamber_live and in_battery() and not safety_on and not _hands_block_fire()

func _hands_block_fire() -> bool:
	return action == Act.RELOAD or action == Act.SAFETY or action == Act.HAMMER_COCK

func can_reload() -> bool:
	if action == Act.RELOAD or action == Act.SAFETY or action == Act.HAMMER_COCK:
		return false
	if slide_state == Slide.CYCLING or slide_state == Slide.RELEASING or _fire_at >= 0.0 or _da_start >= 0.0:
		return false
	return _best_spare() >= 0

## fullest spare magazine holding more rounds than the one in the gun, or -1
func _best_spare() -> int:
	var best := -1
	var best_n := rounds_in_gun_mag()
	for i in magazines.size():
		if i != mag_in_gun and magazines[i] > best_n:
			best = i
			best_n = magazines[i]
	return best

# ------------------------------------------------------------------ continuous part state
func slide_pos() -> float:
	match slide_state:
		Slide.LOCKED:
			return WeaponDef.SLIDE_LOCK_POS
		Slide.CYCLING:
			return _cycle_curve(time - _cycle_t0, _cycle_will_lock)
		Slide.RELEASING:
			var v := clampf((time - _release_t0) / WeaponDef.SLIDE_RELEASE_TIME, 0.0, 1.0)
			return WeaponDef.SLIDE_LOCK_POS * (1.0 - pow(v, 1.8))
	return 0.0

static func _cycle_curve(tau: float, will_lock: bool) -> float:
	var s := WeaponDef.SLIDE_STROKE
	if tau <= 0.0:
		return 0.0
	if tau < WeaponDef.SLIDE_REAR_TIME:
		var u := tau / WeaponDef.SLIDE_REAR_TIME
		return s * (1.0 - (1.0 - u) * (1.0 - u))
	var t_f0 := WeaponDef.SLIDE_REAR_TIME + WeaponDef.SLIDE_DWELL
	if tau < t_f0:
		return s
	var v := clampf((tau - t_f0) / (WeaponDef.CYCLE_TIME - t_f0), 0.0, 1.0)
	var p := s * (1.0 - pow(v, 1.8))
	return maxf(p, WeaponDef.SLIDE_LOCK_POS) if will_lock else p

func barrel_pos() -> float:
	return minf(slide_pos(), WeaponDef.BARREL_TRAVEL)

func hammer_deg() -> float:
	# falling hammer (sear released)
	if _hammer_fall_t0 >= 0.0:
		var f := clampf((time - _hammer_fall_t0) / WeaponDef.LOCK_TIME, 0.0, 1.0)
		if f < 1.0:
			return _hammer_fall_from * (1.0 - f * f)
	# double-action stroke raises the hammer with the trigger
	if _da_start >= 0.0:
		var u := clampf((time - _da_start) / WeaponDef.DA_PULL_TIME, 0.0, 1.0)
		return WeaponDef.HAMMER_DA_PEAK_DEG * u
	# hammer drop while the safety lever swings to SAFE
	if action == Act.SAFETY and _action_fired.has("decocked"):
		var f2 := clampf((time - float(_action_fired["decock_t"])) / 0.02, 0.0, 1.0)
		return WeaponDef.HAMMER_COCKED_DEG * (1.0 - f2)
	if action == Act.HAMMER_COCK:
		var ev: Dictionary = clips["hammer_cock"]["events"]
		var u2 := clampf(inverse_lerp(float(ev["hammer_start"]), float(ev["hammer_end"]), action_time()), 0.0, 1.0)
		return WeaponDef.HAMMER_COCKED_DEG * u2 if not hammer_cocked else WeaponDef.HAMMER_COCKED_DEG
	if slide_state == Slide.CYCLING:
		# the recoiling slide rides over the hammer and re-cocks it within the first ~12 mm
		return WeaponDef.HAMMER_COCKED_DEG * clampf(maxf(slide_pos(), 0.0) / 0.012, 0.0, 1.0) if (time - _cycle_t0) < WeaponDef.SLIDE_REAR_TIME else WeaponDef.HAMMER_COCKED_DEG
	return WeaponDef.HAMMER_COCKED_DEG if hammer_cocked else 0.0

func trigger_deg() -> float:
	return _trigger_deg

func safety_deg() -> float:
	if action == Act.SAFETY:
		var ev: Dictionary = clips[action_clip]["events"]
		var u := clampf(inverse_lerp(float(ev["lever_start"]), float(ev["lever_end"]), action_time()), 0.0, 1.0)
		return lerpf(_safety_from, _safety_to, u)
	return WeaponDef.SAFETY_SAFE_DEG if safety_on else 0.0

func slide_stop_up() -> float:
	return 1.0 if slide_state == Slide.LOCKED or (slide_state == Slide.CYCLING and _cycle_will_lock and (time - _cycle_t0) > WeaponDef.SLIDE_REAR_TIME) else 0.0

func mag_release_in() -> float:
	if action == Act.RELOAD:
		var ev: Dictionary = clips[action_clip]["events"]
		var t := action_time()
		var a := float(ev["mag_release_press"])
		return clampf((t - a) / 0.04, 0.0, 1.0) * clampf((float(ev["mag_clear"]) + 0.1 - t) / 0.08, 0.0, 1.0)
	return 0.0

## the magazine whose contents should be drawn on the `mag` bone right now (-1: none visible)
func visible_mag() -> int:
	if action == Act.RELOAD and _reload_committed:
		if not _action_fired.has("mag_swap"):
			return _reload_removed_mag
		return _action_fired["mag_swap"]
	return mag_in_gun

func visible_mag_rounds() -> int:
	var i := visible_mag()
	return magazines[i] if i >= 0 else 0

# ------------------------------------------------------------------ input
func set_trigger(held: bool) -> void:
	if held == trigger_held:
		return
	trigger_held = held
	if held:
		_on_trigger_press()
	else:
		_press_pending = false
		if _da_start >= 0.0:           # double-action stroke abandoned before the break: hammer rides back down
			_da_start = -1.0
			_emit("da_abort")

func _on_trigger_press() -> void:
	_emit("trigger_press")
	if action == Act.INSPECT:
		_end_action("inspect_end")
	if action == Act.RELOAD and not _reload_committed:
		_cancel_reload()
	if _hands_block_fire():
		return
	if slide_state == Slide.CYCLING or slide_state == Slide.RELEASING:
		_press_pending = true         # acted upon the moment the slide is back in battery
		return
	_try_break()

func _try_break() -> void:
	_press_pending = false
	if _needs_reset or _fire_at >= 0.0 or _da_start >= 0.0 or _dry_at >= 0.0:
		return
	if safety_on or slide_state == Slide.LOCKED:
		_needs_reset = true
		_emit("dead_trigger")         # trigger is disconnected: it moves, nothing happens
		return
	if hammer_cocked:
		# single action: sear releases at once
		hammer_cocked = false
		_needs_reset = true
		_hammer_fall_from = WeaponDef.HAMMER_COCKED_DEG
		_hammer_fall_t0 = time
		_emit("hammer_fall", {"da": false})
		if chamber_live:
			_fire_at = time + WeaponDef.LOCK_TIME
			_fire_is_da = false
		else:
			_dry_at = time + WeaponDef.LOCK_TIME
	else:
		_da_start = time
		_emit("da_pull_start")

func request_reload() -> bool:
	if action == Act.RELOAD:
		return false                  # repeated presses while reloading are ignored (only the trigger cancels, before the catch is pressed)
	if not can_reload():
		if action == Act.NONE and _best_spare() < 0 and _idle_mechanism():
			# nothing to gain from a magazine change; only worth telling the player when the gun is actually short
			if spare_loaded_magazines() == 0 and rounds_in_gun_mag() < WeaponDef.MAG_CAPACITY:
				_emit("no_spare_magazine")
		return false
	if action == Act.INSPECT:
		_end_action("inspect_end")
	_start_action(Act.RELOAD, "reload_empty" if slide_state == Slide.LOCKED else "reload")
	_reload_committed = false
	_reload_removed_mag = -1
	_emit("reload_start", {"empty": slide_state == Slide.LOCKED})
	return true

func request_inspect() -> bool:
	if action == Act.INSPECT:
		_end_action("inspect_end")
		return false
	if action != Act.NONE or not _idle_mechanism():
		return false
	_start_action(Act.INSPECT, "inspect")
	_emit("inspect_start")
	return true

func request_safety_toggle() -> bool:
	if action == Act.INSPECT:
		_end_action("inspect_end")
	if action != Act.NONE or not _idle_mechanism():
		return false
	_safety_from = WeaponDef.SAFETY_SAFE_DEG if safety_on else 0.0
	_safety_to = 0.0 if safety_on else WeaponDef.SAFETY_SAFE_DEG
	_start_action(Act.SAFETY, "safety_off" if safety_on else "safety_on")
	return true

func request_cock_hammer() -> bool:
	if action == Act.INSPECT:
		_end_action("inspect_end")
	if action != Act.NONE or not _idle_mechanism() or hammer_cocked or safety_on or slide_state != Slide.CLOSED:
		return false
	_start_action(Act.HAMMER_COCK, "hammer_cock")
	return true

## Focus loss / pause / menu: drop inputs without side effects. Never fires, never loses rounds.
func release_inputs() -> void:
	set_trigger(false)
	_press_pending = false

func _idle_mechanism() -> bool:
	return slide_state != Slide.CYCLING and slide_state != Slide.RELEASING and _fire_at < 0.0 and _da_start < 0.0 and _dry_at < 0.0

# ------------------------------------------------------------------ time
## Advance by dt seconds; returns the events that happened, each {name, t, ...} with t in sim time.
func advance(dt: float) -> Array[Dictionary]:
	var t_end := time + maxf(dt, 0.0)
	# process internal deadlines in chronological order so sub-frame ordering is exact
	var guard := 0
	while guard < 64:
		guard += 1
		var nt := _next_deadline()
		if nt < 0.0 or nt > t_end:
			break
		time = maxf(time, nt)
		_run_deadlines()
	time = t_end
	_update_trigger(dt)
	var out := _events
	_events = []
	return out

func _next_deadline() -> float:
	var best := -1.0
	var cands: Array[float] = []
	if _fire_at >= 0.0: cands.append(_fire_at)
	if _dry_at >= 0.0: cands.append(_dry_at)
	if _da_start >= 0.0: cands.append(_da_start + WeaponDef.DA_PULL_TIME)
	if slide_state == Slide.CYCLING:
		if not _cycle_ejected: cands.append(_cycle_t0 + WeaponDef.EJECT_TIME)
		if _cycle_will_lock:
			cands.append(_cycle_t0 + WeaponDef.SLIDE_REAR_TIME + WeaponDef.SLIDE_DWELL + 0.006)
		else:
			if not _cycle_fed: cands.append(_cycle_t0 + WeaponDef.FEED_TIME)
			cands.append(_cycle_t0 + WeaponDef.CYCLE_TIME)
	if slide_state == Slide.RELEASING:
		if not _cycle_fed: cands.append(_release_t0 + WeaponDef.SLIDE_RELEASE_TIME * 0.55)
		cands.append(_release_t0 + WeaponDef.SLIDE_RELEASE_TIME)
	if action != Act.NONE:
		var clip: Dictionary = clips[action_clip]
		for k in clip["events"]:
			if not _action_fired.has(k):
				cands.append(action_t0 + float(clip["events"][k]))
		cands.append(action_t0 + float(clip["duration"]))
		if action == Act.SAFETY and _safety_to < 0.0 and not _action_fired.has("decock_t"):
			cands.append(action_t0 + lerpf(float(clip["events"]["lever_start"]), float(clip["events"]["lever_end"]), 0.7))
	for c in cands:
		if best < 0.0 or c < best:
			best = c
	return best

func _run_deadlines() -> void:
	var eps := 1e-9
	if _da_start >= 0.0 and time >= _da_start + WeaponDef.DA_PULL_TIME - eps:
		# double-action break: hammer released from its DA arc
		_da_start = -1.0
		_needs_reset = true
		_hammer_fall_from = WeaponDef.HAMMER_DA_PEAK_DEG
		_hammer_fall_t0 = time
		_emit("hammer_fall", {"da": true})
		if chamber_live and in_battery() and not safety_on:
			_fire_at = time + WeaponDef.LOCK_TIME
			_fire_is_da = true
		else:
			_dry_at = time + WeaponDef.LOCK_TIME
	if _dry_at >= 0.0 and time >= _dry_at - eps:
		_dry_at = -1.0
		_hammer_fall_t0 = -1.0
		_emit("dry_fire")
	if _fire_at >= 0.0 and time >= _fire_at - eps:
		_fire()
	if slide_state == Slide.CYCLING:
		var tau := time - _cycle_t0
		if not _cycle_ejected and tau >= WeaponDef.EJECT_TIME - eps:
			_cycle_ejected = true
			_emit("eject", {"live": false})
		if _cycle_will_lock:
			if tau >= WeaponDef.SLIDE_REAR_TIME + WeaponDef.SLIDE_DWELL + 0.006 - eps:
				slide_state = Slide.LOCKED
				_emit("slide_lock_open")
		else:
			if not _cycle_fed and tau >= WeaponDef.FEED_TIME - eps:
				_cycle_fed = true
				_feed()
			if tau >= WeaponDef.CYCLE_TIME - eps:
				slide_state = Slide.CLOSED
				_emit("slide_in_battery")
				if _press_pending and trigger_held:
					_try_break()
	elif slide_state == Slide.RELEASING:
		var tr := time - _release_t0
		if not _cycle_fed and tr >= WeaponDef.SLIDE_RELEASE_TIME * 0.55 - eps:
			_cycle_fed = true
			_feed()
		if tr >= WeaponDef.SLIDE_RELEASE_TIME - eps:
			slide_state = Slide.CLOSED
			_emit("slide_in_battery")
	if action != Act.NONE:
		_run_action()

func _fire() -> void:
	_fire_at = -1.0
	_hammer_fall_t0 = -1.0
	if not (chamber_live and in_battery() and not safety_on):
		_emit("dry_fire")
		return
	chamber_live = false
	shots_fired += 1
	hammer_cocked = true                      # re-cocked by the slide
	slide_state = Slide.CYCLING
	_cycle_t0 = time
	_cycle_ejected = false
	_cycle_fed = false
	# the slide stop is lifted by the follower of an empty magazine (no magazine: no lock)
	_cycle_will_lock = mag_in_gun >= 0 and magazines[mag_in_gun] == 0
	_emit("shot", {"da": _fire_is_da, "index": shots_fired, "last_round": _cycle_will_lock})

func _feed() -> void:
	if mag_in_gun >= 0 and magazines[mag_in_gun] > 0 and not chamber_live:
		magazines[mag_in_gun] -= 1
		chamber_live = true
		_emit("feed", {"left": magazines[mag_in_gun]})

func _update_trigger(dt: float) -> void:
	var target := WeaponDef.TRIGGER_SA_REST_DEG if hammer_cocked else 0.0
	if _da_start >= 0.0:
		var u := clampf((time - _da_start) / WeaponDef.DA_PULL_TIME, 0.0, 1.0)
		_trigger_deg = lerpf(0.0, WeaponDef.TRIGGER_BREAK_DEG, u)
		return
	if trigger_held and not _hands_block_fire():
		target = WeaponDef.TRIGGER_OVERTRAVEL_DEG
	var rate := 30.0 / WeaponDef.TRIGGER_RETURN_TIME      # deg/s
	var before := _trigger_deg
	_trigger_deg = move_toward(_trigger_deg, target, rate * dt * (3.0 if target < _trigger_deg else 1.0))
	if not trigger_held and _needs_reset and _trigger_deg >= WeaponDef.TRIGGER_RESET_DEG - 0.001:
		_needs_reset = false
		_emit("trigger_reset", {"audible": before < WeaponDef.TRIGGER_RESET_DEG - 0.001})

# ------------------------------------------------------------------ hand actions
func _start_action(a: int, clip: String) -> void:
	action = a
	action_clip = clip
	action_t0 = time
	_action_fired.clear()

func _end_action(ev_name := "") -> void:
	action = Act.NONE
	action_clip = ""
	_action_fired.clear()
	_reload_committed = false
	if ev_name != "":
		_emit(ev_name)

func _cancel_reload() -> void:
	_end_action("reload_cancel")

func _hit(name: String) -> bool:
	if _action_fired.has(name):
		return false
	var ev: Dictionary = clips[action_clip]["events"]
	if not ev.has(name) or time < action_t0 + float(ev[name]) - 1e-9:
		return false
	_action_fired[name] = true
	return true

func _run_action() -> void:
	var clip: Dictionary = clips[action_clip]
	match action:
		Act.RELOAD:
			if _hit("left_hand_leaves"):
				_emit("support_hand_off")
			if _hit("mag_release_press"):
				_reload_committed = true
				_reload_removed_mag = mag_in_gun
				_emit("mag_release")
			if _hit("mag_out_start"):
				_emit("mag_sliding_out")
			if _hit("mag_clear"):
				mag_in_gun = -1
				_emit("mag_out", {"rounds": magazines[_reload_removed_mag] if _reload_removed_mag >= 0 else 0})
			if not _action_fired.has("mag_swap") and clip["events"].has("mag_swap") and time >= action_t0 + float(clip["events"]["mag_swap"]) - 1e-9:
				var pick := _best_spare()
				if pick < 0:
					pick = _reload_removed_mag
				_action_fired["mag_swap"] = pick
				_emit("mag_swap", {"rounds": magazines[pick] if pick >= 0 else 0})
			if _hit("mag_in_start"):
				_emit("mag_sliding_in")
			if _hit("mag_seated"):
				mag_in_gun = int(_action_fired.get("mag_swap", _reload_removed_mag))
				_emit("mag_in", {"rounds": rounds_in_gun_mag()})
			if _hit("slide_stop_press"):
				# an empty magazine's follower holds the stop up: the slide cannot be released
				if slide_state == Slide.LOCKED and rounds_in_gun_mag() > 0:
					slide_state = Slide.RELEASING
					_release_t0 = time
					_cycle_fed = false
					_emit("slide_release")
				else:
					_emit("slide_stop_blocked")
			if _hit("regrip_done"):
				_emit("regrip")
		Act.SAFETY:
			if _hit("lever_start"):
				_emit("safety_lever_move", {"to_safe": _safety_to < 0.0})
			# on the way to SAFE the lever first blocks the firing pin, then trips the hammer in the last third
			if _safety_to < 0.0 and not _action_fired.has("decock_t"):
				var ev: Dictionary = clip["events"]
				var t_dec := lerpf(float(ev["lever_start"]), float(ev["lever_end"]), 0.7)
				if time >= action_t0 + t_dec - 1e-9:
					_action_fired["decock_t"] = time
					if hammer_cocked:
						hammer_cocked = false
						_action_fired["decocked"] = true
						_emit("decock")
			if _hit("lever_end"):
				safety_on = _safety_to < 0.0
				_emit("safety_on" if safety_on else "safety_off")
		Act.HAMMER_COCK:
			if _hit("hammer_start"):
				_emit("hammer_cock_start")
			if _hit("hammer_end"):
				hammer_cocked = true
				_emit("hammer_cocked")
		Act.INSPECT:
			for k in clip["events"]:
				if _hit(k):
					_emit("inspect_" + k)
	if action != Act.NONE and time >= action_t0 + float(clip["duration"]) - 1e-9:
		var was := action
		_end_action()
		match was:
			Act.RELOAD: _emit("reload_done")
			Act.INSPECT: _emit("inspect_end")
			_: _emit("action_done")
		if trigger_held and _press_pending:
			_try_break()

func _emit(name: String, data := {}) -> void:
	var e := {"name": name, "t": time}
	e.merge(data)
	_events.append(e)

## Compact state for the HUD / tests.
func snapshot() -> Dictionary:
	return {"chamber": chamber_live, "mag": rounds_in_gun_mag(), "mag_in": mag_in_gun >= 0, "hammer_cocked": hammer_cocked,
		"safety": safety_on, "slide": slide_state, "action": action, "spares": spare_loaded_magazines(), "total": total_rounds(),
		"shots": shots_fired, "slide_locked": slide_state == Slide.LOCKED, "magazines": magazines.duplicate()}
