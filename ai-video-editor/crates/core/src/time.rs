//! Explicit time model.
//!
//! All times are stored as integer **ticks** ("flicks"): 1 tick = 1/705 600 000 s.
//! That base divides evenly by every common video frame rate (24, 25, 30, 50, 60,
//! 23.976, 29.97, 59.94, ...) and audio sample rate (44.1k, 48k, 96k, ...), so frame and
//! sample boundaries are exact integers and no floating point drift can accumulate.
//!
//! Three *distinct* time domains are modelled as distinct newtypes so they cannot be
//! mixed up accidentally:
//!
//! * [`TimelineTime`] – a position on the output timeline (what the viewer sees).
//! * [`ClipTime`]     – a position relative to a clip's start on the timeline
//!   (0 == the clip's first output frame). Measured in output time.
//! * [`SourceTime`]   – a position inside the source media file.
//!
//! Durations are plain [`Ticks`]; conversions between the domains only happen through
//! the explicit functions on `Clip` (see `model.rs`) and [`Speed`].

use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::{Add, AddAssign, Sub, SubAssign};

/// Signed tick count (duration or raw position).
pub type Ticks = i64;

/// Ticks per second ("flicks").
pub const TICKS_PER_SECOND: i64 = 705_600_000;
/// Ticks per millisecond.
pub const TICKS_PER_MS: i64 = TICKS_PER_SECOND / 1000;

macro_rules! time_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Ticks);

        impl $name {
            pub const ZERO: $name = $name(0);
            #[inline]
            pub fn ticks(self) -> Ticks {
                self.0
            }
            #[inline]
            pub fn from_ms(ms: i64) -> Self {
                $name(ms * TICKS_PER_MS)
            }
            #[inline]
            pub fn from_seconds_f64(s: f64) -> Self {
                $name((s * TICKS_PER_SECOND as f64).round() as i64)
            }
            #[inline]
            pub fn as_seconds_f64(self) -> f64 {
                self.0 as f64 / TICKS_PER_SECOND as f64
            }
            #[inline]
            pub fn as_ms(self) -> i64 {
                div_round(self.0, TICKS_PER_MS)
            }
        }
        impl Add<Ticks> for $name {
            type Output = $name;
            #[inline]
            fn add(self, rhs: Ticks) -> $name {
                $name(self.0 + rhs)
            }
        }
        impl Sub<Ticks> for $name {
            type Output = $name;
            #[inline]
            fn sub(self, rhs: Ticks) -> $name {
                $name(self.0 - rhs)
            }
        }
        impl Sub<$name> for $name {
            type Output = Ticks;
            #[inline]
            fn sub(self, rhs: $name) -> Ticks {
                self.0 - rhs.0
            }
        }
        impl AddAssign<Ticks> for $name {
            #[inline]
            fn add_assign(&mut self, rhs: Ticks) {
                self.0 += rhs;
            }
        }
        impl SubAssign<Ticks> for $name {
            #[inline]
            fn sub_assign(&mut self, rhs: Ticks) {
                self.0 -= rhs;
            }
        }
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({} = {:.4}s)", stringify!($name), self.0, self.as_seconds_f64())
            }
        }
    };
}

time_newtype!(
    /// Position on the output timeline.
    TimelineTime
);
time_newtype!(
    /// Position relative to the start of a clip, in output time.
    ClipTime
);
time_newtype!(
    /// Position inside a source media file.
    SourceTime
);

/// Rounded integer division (half away from zero) on i64 using i128 intermediates.
#[inline]
pub fn div_round(n: i64, d: i64) -> i64 {
    debug_assert!(d != 0);
    let (n, d) = (n as i128, d as i128);
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    let q = if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    };
    q as i64
}

/// `a * b / c` with i128 intermediates, rounded half away from zero.
#[inline]
pub fn mul_div_round(a: i64, b: i64, c: i64) -> i64 {
    debug_assert!(c != 0);
    let n = a as i128 * b as i128;
    let d = c as i128;
    let (n, d) = if d < 0 { (-n, -d) } else { (n, d) };
    let q = if n >= 0 {
        (n + d / 2) / d
    } else {
        -((-n + d / 2) / d)
    };
    q as i64
}

/// `floor(a * b / c)` with i128 intermediates.
#[inline]
pub fn mul_div_floor(a: i64, b: i64, c: i64) -> i64 {
    debug_assert!(c != 0);
    let n = a as i128 * b as i128;
    n.div_euclid(c as i128) as i64
}

/// `ceil(a * b / c)` with i128 intermediates.
#[inline]
pub fn mul_div_ceil(a: i64, b: i64, c: i64) -> i64 {
    debug_assert!(c > 0);
    let n = a as i128 * b as i128;
    let c = c as i128;
    (n.div_euclid(c) + if n.rem_euclid(c) != 0 { 1 } else { 0 }) as i64
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// A rational frame rate (`num / den` frames per second), e.g. 30000/1001.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct FrameRate {
    pub num: u32,
    pub den: u32,
}

impl FrameRate {
    pub const FPS_24: FrameRate = FrameRate { num: 24, den: 1 };
    pub const FPS_25: FrameRate = FrameRate { num: 25, den: 1 };
    pub const FPS_30: FrameRate = FrameRate { num: 30, den: 1 };
    pub const FPS_50: FrameRate = FrameRate { num: 50, den: 1 };
    pub const FPS_60: FrameRate = FrameRate { num: 60, den: 1 };
    pub const FPS_23_976: FrameRate = FrameRate {
        num: 24000,
        den: 1001,
    };
    pub const FPS_29_97: FrameRate = FrameRate {
        num: 30000,
        den: 1001,
    };
    pub const FPS_59_94: FrameRate = FrameRate {
        num: 60000,
        den: 1001,
    };

    /// Build a normalised (reduced) frame rate. Returns `None` for zero / out-of-range rates.
    pub fn new(num: u32, den: u32) -> Option<FrameRate> {
        if num == 0 || den == 0 {
            return None;
        }
        let g = gcd(num as u64, den as u64) as u32;
        let r = FrameRate {
            num: num / g,
            den: den / g,
        };
        let fps = r.as_f64();
        if !(1.0..=240.0).contains(&fps) {
            return None;
        }
        Some(r)
    }

    /// Parse ffprobe style strings such as `"30000/1001"`, `"25/1"` or `"29.97"`.
    pub fn parse(s: &str) -> Option<FrameRate> {
        let s = s.trim();
        if let Some((a, b)) = s.split_once('/') {
            let (n, d) = (a.trim().parse::<u64>().ok()?, b.trim().parse::<u64>().ok()?);
            if n == 0 || d == 0 {
                return None;
            }
            let g = gcd(n, d);
            return FrameRate::new(u32::try_from(n / g).ok()?, u32::try_from(d / g).ok()?);
        }
        let f = s.parse::<f64>().ok()?;
        FrameRate::from_f64(f)
    }

    /// Snap a floating point rate to the nearest well-known rational rate.
    pub fn from_f64(f: f64) -> Option<FrameRate> {
        if !f.is_finite() || f <= 0.0 {
            return None;
        }
        const KNOWN: [FrameRate; 8] = [
            FrameRate::FPS_23_976,
            FrameRate::FPS_24,
            FrameRate::FPS_25,
            FrameRate::FPS_29_97,
            FrameRate::FPS_30,
            FrameRate::FPS_50,
            FrameRate::FPS_59_94,
            FrameRate::FPS_60,
        ];
        for k in KNOWN {
            if (k.as_f64() - f).abs() < 0.005 {
                return Some(k);
            }
        }
        FrameRate::new((f * 1000.0).round() as u32, 1000)
    }

    #[inline]
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// Exact tick position of the start of frame `n`: `n * TPS * den / num`.
    /// For every supported rate the division is exact; for exotic rates we floor so the
    /// frame grid stays monotonic.
    #[inline]
    pub fn frame_to_ticks(self, frame: i64) -> Ticks {
        mul_div_floor(frame, TICKS_PER_SECOND * self.den as i64, self.num as i64)
    }

    /// Index of the frame that contains tick `t` (floor).
    #[inline]
    pub fn ticks_to_frame_floor(self, t: Ticks) -> i64 {
        let mut f = mul_div_floor(t, self.num as i64, TICKS_PER_SECOND * self.den as i64);
        // Guard against the flooring in `frame_to_ticks` for inexact rates. One step
        // is all a valid input ever needs; the bound keeps absurd (near-overflow)
        // inputs from spinning.
        let mut guard = 0;
        while guard < 4 && self.frame_to_ticks(f + 1) <= t {
            f += 1;
            guard += 1;
        }
        guard = 0;
        while guard < 4 && self.frame_to_ticks(f) > t {
            f -= 1;
            guard += 1;
        }
        f
    }

    /// Nearest frame index to tick `t` (ties round up).
    #[inline]
    pub fn ticks_to_frame_round(self, t: Ticks) -> i64 {
        let f = self.ticks_to_frame_floor(t);
        let lo = self.frame_to_ticks(f);
        let hi = self.frame_to_ticks(f + 1);
        if t - lo >= hi - t {
            f + 1
        } else {
            f
        }
    }

    /// Smallest frame index whose start is `>= t`.
    #[inline]
    pub fn ticks_to_frame_ceil(self, t: Ticks) -> i64 {
        let f = self.ticks_to_frame_floor(t);
        if self.frame_to_ticks(f) == t {
            f
        } else {
            f + 1
        }
    }

    /// Duration of one frame in ticks (exact for supported rates).
    #[inline]
    pub fn frame_ticks(self) -> Ticks {
        self.frame_to_ticks(1)
    }

    /// Snap a tick value to the nearest frame boundary.
    #[inline]
    pub fn snap(self, t: Ticks) -> Ticks {
        self.frame_to_ticks(self.ticks_to_frame_round(t))
    }

    #[inline]
    pub fn snap_floor(self, t: Ticks) -> Ticks {
        self.frame_to_ticks(self.ticks_to_frame_floor(t))
    }

    #[inline]
    pub fn snap_ceil(self, t: Ticks) -> Ticks {
        self.frame_to_ticks(self.ticks_to_frame_ceil(t))
    }

    #[inline]
    pub fn is_aligned(self, t: Ticks) -> bool {
        self.snap_floor(t) == t
    }

    /// Non-drop-frame timecode `HH:MM:SS:FF` for tick `t`.
    pub fn timecode(self, t: Ticks) -> String {
        let neg = t < 0;
        let frame = self.ticks_to_frame_floor(t.abs());
        let base = self.as_f64().round().max(1.0) as i64; // nominal fps (30 for 29.97)
        let ff = frame % base;
        let total_s = frame / base;
        let (h, m, s) = (total_s / 3600, (total_s / 60) % 60, total_s % 60);
        let digits = if base > 100 { 3 } else { 2 };
        format!(
            "{}{:02}:{:02}:{:02}:{:0width$}",
            if neg { "-" } else { "" },
            h,
            m,
            s,
            ff,
            width = digits
        )
    }
}

impl Default for FrameRate {
    fn default() -> Self {
        FrameRate::FPS_30
    }
}

/// Playback speed as an exact rational (`num / den`); 1/1 is realtime, 2/1 is double
/// speed (source is consumed twice as fast as output time advances).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct Speed {
    pub num: u32,
    pub den: u32,
}

impl Speed {
    pub const NORMAL: Speed = Speed { num: 1, den: 1 };
    pub const MIN: f64 = 0.1;
    pub const MAX: f64 = 16.0;

    pub fn new(num: u32, den: u32) -> Option<Speed> {
        if num == 0 || den == 0 {
            return None;
        }
        let g = gcd(num as u64, den as u64) as u32;
        let s = Speed {
            num: num / g,
            den: den / g,
        };
        let f = s.as_f64();
        if !(Self::MIN - 1e-9..=Self::MAX + 1e-9).contains(&f) {
            return None;
        }
        Some(s)
    }

    /// Build from a percentage-like float (1.0 == realtime), quantised to 1/1000.
    pub fn from_f64(f: f64) -> Option<Speed> {
        if !f.is_finite() {
            return None;
        }
        Speed::new(
            (f * 1000.0).round().clamp(0.0, u32::MAX as f64) as u32,
            1000,
        )
    }

    #[inline]
    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    #[inline]
    pub fn is_normal(self) -> bool {
        self.num == self.den
    }

    /// Source duration consumed while `output` ticks of timeline time elapse.
    #[inline]
    pub fn output_to_source(self, output: Ticks) -> Ticks {
        mul_div_round(output, self.num as i64, self.den as i64)
    }

    /// Output (timeline) duration needed to play `source` ticks of media.
    #[inline]
    pub fn source_to_output(self, source: Ticks) -> Ticks {
        mul_div_round(source, self.den as i64, self.num as i64)
    }
}

impl Default for Speed {
    fn default() -> Self {
        Speed::NORMAL
    }
}

/// Format ticks as decimal seconds with fixed 6 fractional digits (deterministic, no
/// float formatting involved). Used for FFmpeg arguments.
pub fn ticks_to_seconds_string(t: Ticks) -> String {
    let neg = t < 0;
    let micros = mul_div_round(t.abs(), 1_000_000, TICKS_PER_SECOND);
    format!(
        "{}{}.{:06}",
        if neg { "-" } else { "" },
        micros / 1_000_000,
        micros % 1_000_000
    )
}

/// Convert ticks to an exact sample count at `sample_rate` (rounded).
#[inline]
pub fn ticks_to_samples(t: Ticks, sample_rate: u32) -> i64 {
    mul_div_round(t, sample_rate as i64, TICKS_PER_SECOND)
}

#[inline]
pub fn ms_to_ticks(ms: i64) -> Ticks {
    ms * TICKS_PER_MS
}

#[inline]
pub fn seconds_to_ticks(s: f64) -> Ticks {
    (s * TICKS_PER_SECOND as f64).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_rates_are_exact() {
        for r in [
            FrameRate::FPS_24,
            FrameRate::FPS_25,
            FrameRate::FPS_30,
            FrameRate::FPS_50,
            FrameRate::FPS_60,
            FrameRate::FPS_23_976,
            FrameRate::FPS_29_97,
            FrameRate::FPS_59_94,
        ] {
            assert_eq!(
                (TICKS_PER_SECOND as i128 * r.den as i128) % r.num as i128,
                0,
                "{r:?}"
            );
            for f in [0i64, 1, 2, 29, 30, 1799, 107_892, 5_000_000] {
                let t = r.frame_to_ticks(f);
                assert_eq!(r.ticks_to_frame_floor(t), f);
                assert_eq!(r.ticks_to_frame_round(t), f);
                assert_eq!(r.ticks_to_frame_ceil(t), f);
                assert_eq!(r.ticks_to_frame_floor(t + 1), f);
                assert_eq!(r.ticks_to_frame_ceil(t + 1), f + 1);
                assert_eq!(r.ticks_to_frame_floor(t - 1), f - 1);
            }
        }
    }

    #[test]
    fn rounding_helpers() {
        assert_eq!(div_round(5, 2), 3);
        assert_eq!(div_round(-5, 2), -3);
        assert_eq!(div_round(4, 3), 1);
        assert_eq!(mul_div_floor(-1, 1, 2), -1);
        assert_eq!(mul_div_ceil(1, 1, 2), 1);
        assert_eq!(mul_div_round(i64::MAX / 4, 8, 4), i64::MAX / 4 * 2);
    }

    #[test]
    fn timecode_formatting() {
        let r = FrameRate::FPS_30;
        assert_eq!(r.timecode(0), "00:00:00:00");
        assert_eq!(r.timecode(r.frame_to_ticks(30 * 3661 + 12)), "01:01:01:12");
        assert_eq!(
            FrameRate::FPS_29_97.timecode(FrameRate::FPS_29_97.frame_to_ticks(31)),
            "00:00:01:01"
        );
    }

    #[test]
    fn seconds_string_is_exact() {
        assert_eq!(
            ticks_to_seconds_string(TICKS_PER_SECOND * 3 / 2),
            "1.500000"
        );
        assert_eq!(
            ticks_to_seconds_string(FrameRate::FPS_30.frame_to_ticks(1)),
            "0.033333"
        );
        assert_eq!(ticks_to_seconds_string(-TICKS_PER_SECOND), "-1.000000");
    }

    #[test]
    fn speed_round_trip() {
        let s = Speed::new(3, 2).unwrap();
        let out = FrameRate::FPS_30.frame_to_ticks(90);
        let src = s.output_to_source(out);
        assert_eq!(src, out / 2 * 3);
        assert_eq!(s.source_to_output(src), out);
        assert!(Speed::new(1, 100).is_none());
        assert_eq!(Speed::from_f64(0.5).unwrap(), Speed { num: 1, den: 2 });
    }
}
