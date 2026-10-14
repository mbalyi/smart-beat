//! Record to tab, drums: finds drum hits in a take with band-wise spectral flux and a few
//! rules, with no model and no network. Three bands carry the hits: low (kick and toms), mid
//! (snare) and high (hi-hat and cymbals). Each band's rise in energy is peak-picked; a hit is
//! then named by its band, how the high band decays (closed hat, open hat, crash) and the
//! pitch of its low body (kick or tom). Notes come out with the General MIDI drum number as
//! the pitch, which Smart Beat's drum tracks use as is.
//!
//! Kick, snare and hi-hat (closed and open) are the supported hits. Toms and crash cymbals are
//! found by coarser rules and are marked experimental in the dialog.

use super::{RecordedNote, Transcriber, resample};
use crate::error::{CommandError, ErrorKind};
use realfft::RealFftPlanner;
use std::f32::consts::PI;

const RATE: u32 = 22_050;
const WINDOW: usize = 1024;
const HOP: usize = 128;
/// Where inside a window a hit that raises the flux is placed, in samples from its start.
const HIT_OFFSET: usize = 900;
/// The length written for a hit; drum notes are not sustained.
const HIT_SECONDS: f64 = 0.12;
/// A rise of the log energy smaller than this is never a hit, whatever its surroundings.
const MIN_FLUX: f32 = 0.5;
const STOPPED: &str = "Transcription stopped.";

/// General MIDI drum numbers written by this module.
pub const KICK: u8 = 36;
pub const SNARE: u8 = 38;
pub const HAT_CLOSED: u8 = 42;
pub const HAT_OPEN: u8 = 46;
pub const TOM_LOW: u8 = 41;
pub const TOM_MID: u8 = 47;
pub const TOM_HIGH: u8 = 48;
pub const CRASH: u8 = 49;

/// Settings of the detector. `Default` is tuned on the test set in `docs/record-to-tab-drums.md`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DrumOptions {
    /// A hit's flux must exceed this many times the local mean flux of its band.
    pub sensitivity: f32,
    /// ... and this share of the band's loud hits (95th percentile of its flux peaks).
    pub floor: f32,
    /// Two hits of one band closer than this are one hit (milliseconds).
    pub refractory_ms: f64,
    /// Peaks of different bands within this time are one hit (milliseconds).
    pub coincide_ms: f64,
    /// Power per bin of the high band against the mid band at or above which a hit is a hat or
    /// a cymbal alone (a snare, kick or tom has far less up there).
    pub bright_ratio: f32,
    /// ... and at or above which a hat sounds with a snare, a kick or a tom.
    pub hat_ratio: f32,
    /// Low band against mid band (per bin) at or above which a low tone is a kick.
    pub kick_ratio: f32,
    /// ... and at or above which a toned hit is a tom (below it, it is the snare's ring).
    pub tom_ratio: f32,
    /// A snare sounds with a kick when the mid band is this many times what the kick's own
    /// mid band is in this take.
    pub snare_with_kick: f32,
    /// The high band dying away slower than this (per second, natural log of the energy) is an
    /// open hat. A closed hat falls faster.
    pub open_decay: f64,
    /// ... and slower than this, over at least 200 ms, a crash.
    pub crash_decay: f64,
    /// Toms are found at all.
    pub toms: bool,
    /// Crash cymbals are found at all.
    pub crash: bool,
}
impl Default for DrumOptions {
    fn default() -> Self {
        Self {
            sensitivity: 3.0,
            floor: 0.15,
            refractory_ms: 45.0,
            coincide_ms: 35.0,
            bright_ratio: 0.5,
            hat_ratio: 0.015,
            kick_ratio: 20.0,
            tom_ratio: 0.6,
            snare_with_kick: 2.5,
            open_decay: 12.0,
            crash_decay: 7.5,
            toms: true,
            crash: true,
        }
    }
}

#[derive(Default)]
pub struct DrumOnsets {
    pub options: DrumOptions,
}

/// Band energies of one frame (linear power).
#[derive(Clone, Copy, Default)]
struct Frame {
    low: f32,
    mid: f32,
    high: f32,
}

/// Bin ranges of the three bands at `RATE` and `WINDOW`.
fn bands() -> [(usize, usize); 3] {
    let bin = |hz: f32| (hz * WINDOW as f32 / RATE as f32).round() as usize;
    [
        (bin(30.0), bin(160.0)),
        (bin(160.0), bin(4_000.0)),
        (bin(6_000.0), bin(10_500.0)),
    ]
}

fn frames(
    samples: &[f32],
    progress: &mut dyn FnMut(f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<Frame>, CommandError> {
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(WINDOW);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let window: Vec<f32> = (0..WINDOW)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / WINDOW as f32).cos())
        .collect();
    let [low, mid, high] = bands();
    let count = samples.len().saturating_sub(WINDOW) / HOP + 1;
    let mut out = Vec::with_capacity(count);
    for t in 0..count {
        if t % 512 == 0 {
            if cancelled() {
                return Err(CommandError::new(ErrorKind::Audio, STOPPED));
            }
            progress(0.8 * t as f32 / count as f32);
        }
        let from = t * HOP;
        for (i, slot) in input.iter_mut().enumerate() {
            *slot = samples.get(from + i).copied().unwrap_or(0.0) * window[i];
        }
        fft.process_with_scratch(&mut input, &mut spectrum, &mut scratch)
            .expect("fft sizes match");
        let sum =
            |(a, b): (usize, usize)| -> f32 { spectrum[a..b].iter().map(|c| c.norm_sqr()).sum() };
        out.push(Frame {
            low: sum(low),
            mid: sum(mid),
            high: sum(high),
        });
    }
    Ok(out)
}

/// The positive change of the log energy: a hit raises it, a decay does not.
fn flux(values: impl Iterator<Item = f32>) -> Vec<f32> {
    let log: Vec<f32> = values.map(|v| (1.0 + 1_000.0 * v).ln()).collect();
    let mut out = vec![0.0; log.len()];
    for t in 1..log.len() {
        // Against the larger of the two frames before, so a slow swell is not a hit.
        let before = log[t - 1].max(if t > 1 { log[t - 2] } else { 0.0 });
        out[t] = (log[t] - before).max(0.0);
    }
    out
}

/// A peak of one band's flux.
#[derive(Debug, Clone, Copy)]
struct Peak {
    frame: usize,
    strength: f32,
}

fn percentile(values: &[f32], share: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted[((sorted.len() - 1) as f32 * share) as usize]
}

fn pick(flux: &[f32], options: &DrumOptions) -> Vec<Peak> {
    let rate = f64::from(RATE) / HOP as f64;
    let reach = 4usize; // a peak is the largest within +-4 frames (23 ms)
    let around = (0.4 * rate) as usize;
    let refractory = (options.refractory_ms / 1000.0 * rate) as usize;
    let mut raw = Vec::new();
    // A running sum gives the local mean in constant time.
    let mut prefix = vec![0.0f64; flux.len() + 1];
    for (i, &v) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + f64::from(v);
    }
    for t in 1..flux.len() {
        let v = flux[t];
        if v <= 0.0 {
            continue;
        }
        let lo = t.saturating_sub(reach);
        let hi = (t + reach + 1).min(flux.len());
        // The first of equal maxima wins.
        if flux[lo..hi].iter().any(|&w| w > v) || flux[lo..t].iter().any(|&w| w >= v) {
            continue;
        }
        let (a, b) = (t.saturating_sub(around), (t + around).min(flux.len()));
        let mean = ((prefix[b] - prefix[a]) / (b - a) as f64) as f32;
        if v >= MIN_FLUX && v > options.sensitivity * mean {
            raw.push(Peak {
                frame: t,
                strength: v,
            });
        }
    }
    let loud = percentile(&raw.iter().map(|p| p.strength).collect::<Vec<_>>(), 0.95);
    let mut peaks: Vec<Peak> = Vec::new();
    for peak in raw {
        if peak.strength < options.floor * loud {
            continue;
        }
        match peaks.last_mut() {
            Some(last) if peak.frame - last.frame < refractory => {
                if peak.strength > last.strength {
                    *last = peak;
                }
            }
            _ => peaks.push(peak),
        }
    }
    peaks
}

/// Mean of `values` over `[from, to)`, or 0 outside the signal.
fn mean(values: &[f32], from: usize, to: usize) -> f32 {
    let to = to.min(values.len());
    if from >= to {
        return 0.0;
    }
    values[from..to].iter().sum::<f32>() / (to - from) as f32
}

/// How far above the band's average power the body's peak must stand.
const TONAL: f32 = 6.0;

/// The strongest frequency (Hz) between 40 and 450 Hz in the 100 ms after the hit.
fn body_pitch(samples: &[f32], start: usize) -> Option<f32> {
    const LEN: usize = 2048;
    let from = start + RATE as usize / 100; // skip the click
    if from + LEN > samples.len() {
        return None;
    }
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(LEN);
    let mut input = fft.make_input_vec();
    for (i, slot) in input.iter_mut().enumerate() {
        let w = 0.5 - 0.5 * (2.0 * PI * i as f32 / LEN as f32).cos();
        *slot = samples[from + i] * w;
    }
    let mut spectrum = fft.make_output_vec();
    fft.process(&mut input, &mut spectrum).ok()?;
    let bin = |hz: f32| (hz * LEN as f32 / RATE as f32) as usize;
    let (a, b) = (bin(40.0), bin(450.0));
    let best = (a..b).max_by(|&x, &y| spectrum[x].norm_sqr().total_cmp(&spectrum[y].norm_sqr()))?;
    // A drum body is a clear tone; noise (a snare, a cymbal) has no peak that stands out.
    let average = (a..b).map(|i| spectrum[i].norm_sqr()).sum::<f32>() / (b - a) as f32;
    (spectrum[best].norm_sqr() > TONAL * average).then_some(best as f32 * RATE as f32 / LEN as f32)
}

impl DrumOnsets {
    /// The hits of a take at `RATE`: `(seconds, drum number, strength)`.
    fn hits(
        &self,
        samples: &[f32],
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<(f64, u8, f32)>, CommandError> {
        let opt = &self.options;
        let spectrum = frames(samples, progress, cancelled)?;
        let high_energy: Vec<f32> = spectrum.iter().map(|f| f.high).collect();
        let low_flux = flux(spectrum.iter().map(|f| f.low));
        let mid_flux = flux(spectrum.iter().map(|f| f.mid));
        let high_flux = flux(spectrum.iter().map(|f| f.high));
        let (lows, mids, highs) = (
            pick(&low_flux, opt),
            pick(&mid_flux, opt),
            pick(&high_flux, opt),
        );
        let rate = f64::from(RATE) / HOP as f64;
        let frames_of = |ms: f64| (ms / 1000.0 * rate) as usize;
        let coincide = frames_of(opt.coincide_ms).max(1);
        let time_of = |frame: usize| (frame * HOP + HIT_OFFSET) as f64 / f64::from(RATE);
        // Peak power of a band in the 40 ms after a frame, per bin: drums are told apart by the
        // shape of their spectrum, not by how loud they are.
        let [(l0, l1), (m0, m1), (h0, h1)] = bands();
        let density = |pick: fn(&Frame) -> f32, bins: usize, frame: usize| {
            let end = (frame + 7).min(spectrum.len());
            spectrum[frame.min(end)..end]
                .iter()
                .map(pick)
                .fold(0.0f32, f32::max)
                / bins as f32
        };
        let (low_bins, mid_bins, high_bins) = (l1 - l0, m1 - m0, h1 - h0);
        let low_at = |frame| density(|f| f.low, low_bins, frame);
        let mid_at = |frame| density(|f| f.mid, mid_bins, frame);
        let high_at = |frame| density(|f| f.high, high_bins, frame);

        let mut hits = Vec::new();
        // One event per hit: peaks of the three bands that fall together.
        struct Event {
            frame: usize,
            low: bool,
            mid: bool,
            high: bool,
        }
        let mut all: Vec<(usize, u8)> = lows
            .iter()
            .map(|p| (p.frame, 0))
            .chain(mids.iter().map(|p| (p.frame, 1)))
            .chain(highs.iter().map(|p| (p.frame, 2)))
            .collect();
        all.sort_unstable();
        let mut events: Vec<Event> = Vec::new();
        let mut last = usize::MAX;
        for (frame, band) in all {
            let fresh = last == usize::MAX || frame - last > coincide;
            if fresh {
                events.push(Event {
                    frame,
                    low: false,
                    mid: false,
                    high: false,
                });
            }
            last = frame;
            let event = events.last_mut().expect("an event was pushed");
            match band {
                0 => event.low = true,
                1 => event.mid = true,
                _ => event.high = true,
            }
        }
        // The mid band a kick has by itself in this take (a low quartile of kick events), to
        // spot a snare played with a kick.
        struct Body {
            number: u8,
            power: f32,
        }
        let bodies: Vec<Option<Body>> = events
            .iter()
            .map(|e| {
                let (low, mid, high) = (low_at(e.frame), mid_at(e.frame), high_at(e.frame));
                let (to_mid, bright) = (low / mid.max(1e-12), high / mid.max(1e-12));
                if bright >= opt.bright_ratio || !(e.low || e.mid) {
                    return None;
                }
                let pitch = body_pitch(samples, e.frame * HOP);
                match pitch {
                    Some(hz) if hz < 110.0 && to_mid >= opt.kick_ratio => Some(Body {
                        number: KICK,
                        power: low,
                    }),
                    Some(hz) if hz >= 110.0 && to_mid >= opt.tom_ratio => {
                        if !opt.toms {
                            None
                        } else if hz < 150.0 {
                            Some(Body {
                                number: TOM_LOW,
                                power: low,
                            })
                        } else if hz < 210.0 {
                            Some(Body {
                                number: TOM_MID,
                                power: low,
                            })
                        } else {
                            Some(Body {
                                number: TOM_HIGH,
                                power: low,
                            })
                        }
                    }
                    // A pad or a table: no clear tone, but the low band leads by far.
                    None if to_mid >= 2.0 * opt.kick_ratio => Some(Body {
                        number: KICK,
                        power: low,
                    }),
                    _ if e.mid && to_mid < opt.tom_ratio => Some(Body {
                        number: SNARE,
                        power: mid,
                    }),
                    _ => None,
                }
            })
            .collect();
        let kick_mid: Vec<f32> = events
            .iter()
            .zip(&bodies)
            .filter(|(_, b)| b.as_ref().is_some_and(|b| b.number == KICK))
            .map(|(e, _)| mid_at(e.frame) / low_at(e.frame).max(1e-12))
            .collect();
        let kick_base = percentile(&kick_mid, 0.25);

        for (index, (event, body)) in events.iter().zip(&bodies).enumerate() {
            let at = time_of(event.frame);
            let (low, mid, high) = (
                low_at(event.frame),
                mid_at(event.frame),
                high_at(event.frame),
            );
            let bright = high / mid.max(1e-12);
            let mut body_found = false;
            if let Some(body) = body {
                body_found = true;
                hits.push((at, body.number, body.power));
                // A snare with a kick: the mid band is well above the kick's own.
                if body.number == KICK
                    && event.mid
                    && mid / low.max(1e-12) > opt.snare_with_kick * kick_base
                {
                    hits.push((at, SNARE, mid));
                }
            }
            let hat_floor = if body_found {
                opt.hat_ratio
            } else {
                opt.bright_ratio
            };
            if event.high && bright >= hat_floor {
                // How fast the high band dies away decides closed, open or crash. It is
                // measured up to the next hit that reaches the high band (at most 400 ms), as
                // that hit brings the level up again.
                let reference = mean(&high_energy, event.frame + 1, event.frame + 4).max(1e-12);
                let next = events[index + 1..]
                    .iter()
                    .find(|e| e.high)
                    .map_or(usize::MAX, |e| e.frame);
                let window =
                    frames_of(400.0).min(next.saturating_sub(event.frame).saturating_sub(2));
                let number = if window < frames_of(50.0) {
                    HAT_CLOSED
                } else {
                    let from = event.frame + window;
                    let level = mean(&high_energy, from - 1, from + 1) / reference;
                    // Decay per second, from the level left after `window`.
                    let seconds = window as f64 / rate;
                    let decay = -(f64::from(level.max(1e-6)).ln()) / seconds;
                    if opt.crash && seconds >= 0.2 && decay < opt.crash_decay {
                        CRASH
                    } else if decay < opt.open_decay {
                        HAT_OPEN
                    } else {
                        HAT_CLOSED
                    }
                };
                hits.push((at, number, high));
            }
        }
        hits.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        Ok(hits)
    }
}

/// 1 to 127 from a hit's loudness (band power) against the loud hits of its drum: 6 dB less
/// is about 30 steps less.
fn velocities(hits: &[(f64, u8, f32)]) -> Vec<u8> {
    let loud = |number: u8| {
        percentile(
            &hits
                .iter()
                .filter(|h| h.1 == number)
                .map(|h| h.2)
                .collect::<Vec<_>>(),
            0.9,
        )
        .max(1e-12)
    };
    hits.iter()
        .map(|&(_, number, power)| {
            let ratio = (power / loud(number)).max(1e-6);
            // Power to decibels: 10 log10.
            let db = 10.0 * ratio.log10();
            (112.0 + 5.0 * db).clamp(20.0, 127.0) as u8
        })
        .collect()
}

impl Transcriber for DrumOnsets {
    fn transcribe(
        &self,
        samples: &[f32],
        sample_rate: u32,
        progress: &mut dyn FnMut(f32),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<RecordedNote>, CommandError> {
        let audio = resample(samples, sample_rate, RATE);
        // Near silence there is nothing to find: a fan and a quiet room have no hits.
        let peak = audio.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        if peak < 0.003 {
            progress(1.0);
            return Ok(Vec::new());
        }
        let hits = self.hits(&audio, progress, cancelled)?;
        let velocity = velocities(&hits);
        Ok(hits
            .into_iter()
            .zip(velocity)
            .map(|((start, pitch, _), velocity)| RecordedNote {
                start,
                end: start + HIT_SECONDS,
                pitch,
                velocity,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Noise(u32);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        }
    }

    fn add(out: &mut [f32], at: f64, sound: &[f32]) {
        let start = (at * f64::from(RATE)) as usize;
        for (i, s) in sound.iter().enumerate() {
            if let Some(slot) = out.get_mut(start + i) {
                *slot += s;
            }
        }
    }
    fn secs(n: f64) -> usize {
        (n * f64::from(RATE)) as usize
    }
    /// A thump: a falling sine at `hz`, plus a short click.
    fn kick(hz: f32, decay: f32) -> Vec<f32> {
        let mut noise = Noise(7);
        (0..secs(0.6))
            .map(|n| {
                let t = n as f32 / RATE as f32;
                let pitch = hz * (1.0 + 0.6 * (-t * 60.0).exp());
                (2.0 * PI * pitch * t).sin() * (-t * decay).exp() * 0.8
                    + noise.next() * (-t * 400.0).exp() * 0.1
            })
            .collect()
    }
    fn snare() -> Vec<f32> {
        // Band-passed noise (a snare's wires have little below 300 Hz or above 5 kHz), over a
        // 190 Hz ring.
        let mut noise = Noise(11);
        let (mut a, mut b, mut c) = (0.0f32, 0.0f32, 0.0f32);
        (0..secs(0.25))
            .map(|n| {
                let t = n as f32 / RATE as f32;
                let tone = (2.0 * PI * 190.0 * t).sin() * (-t * 30.0).exp() * 0.3;
                a += 0.35 * (noise.next() - a);
                b += 0.35 * (a - b);
                c += 0.08 * (b - c);
                tone + (b - c) * 6.0 * (-t * 22.0).exp()
            })
            .collect()
    }
    /// Hi-hat: noise with the lows taken out, ringing for `decay`.
    fn hat(decay: f32, seconds: f64) -> Vec<f32> {
        let mut noise = Noise(23);
        let mut last = [0.0f32; 2];
        (0..secs(seconds))
            .map(|n| {
                let t = n as f32 / RATE as f32;
                let white = noise.next();
                let high = white - 2.0 * last[0] + last[1];
                last = [white, last[0]];
                high * (-t * decay).exp() * 0.5
            })
            .collect()
    }

    fn find(audio: &[f32]) -> Vec<RecordedNote> {
        DrumOnsets::default()
            .transcribe(audio, RATE, &mut |_| {}, &|| false)
            .unwrap()
    }
    fn of(notes: &[RecordedNote], pitch: u8) -> Vec<f64> {
        notes
            .iter()
            .filter(|n| n.pitch == pitch)
            .map(|n| n.start)
            .collect()
    }
    fn near(found: &[f64], expected: &[f64]) -> bool {
        found.len() == expected.len()
            && found
                .iter()
                .zip(expected)
                .all(|(a, b)| (a - b).abs() < 0.03)
    }

    #[test]
    fn silence_and_a_hum_have_no_hits() {
        assert!(find(&vec![0.0; secs(2.0)]).is_empty());
        let hum: Vec<f32> = (0..secs(3.0))
            .map(|n| (2.0 * PI * 50.0 * n as f32 / RATE as f32).sin() * 0.2)
            .collect();
        assert!(find(&hum).is_empty());
    }

    #[test]
    fn kick_snare_and_hat_are_told_apart() {
        let mut audio = vec![0.0f32; secs(4.5)];
        let times = [0.5, 1.5, 2.5, 3.5];
        for &t in &times {
            add(&mut audio, t, &kick(55.0, 14.0));
            add(&mut audio, t + 0.5, &snare());
        }
        for i in 0..8 {
            add(&mut audio, 0.25 + 0.5 * f64::from(i), &hat(60.0, 0.3));
        }
        let notes = find(&audio);
        assert!(near(&of(&notes, KICK), &times), "{:?}", of(&notes, KICK));
        let snares: Vec<f64> = times.iter().map(|t| t + 0.5).collect();
        assert!(near(&of(&notes, SNARE), &snares), "{:?}", of(&notes, SNARE));
        let hats: Vec<f64> = (0..8).map(|i| 0.25 + 0.5 * f64::from(i)).collect();
        assert!(
            near(&of(&notes, HAT_CLOSED), &hats),
            "{:?}",
            of(&notes, HAT_CLOSED)
        );
        assert!(of(&notes, HAT_OPEN).is_empty() && of(&notes, CRASH).is_empty());
    }

    #[test]
    fn an_open_hat_rings_longer_than_a_closed_one() {
        let mut audio = vec![0.0f32; secs(3.0)];
        add(&mut audio, 0.5, &hat(60.0, 0.3));
        add(&mut audio, 1.5, &hat(7.0, 0.9));
        let notes = find(&audio);
        assert!(near(&of(&notes, HAT_CLOSED), &[0.5]), "{notes:?}");
        assert!(near(&of(&notes, HAT_OPEN), &[1.5]), "{notes:?}");
    }

    #[test]
    fn a_long_bright_ring_is_a_crash() {
        let mut audio = vec![0.0f32; secs(3.0)];
        add(&mut audio, 0.5, &hat(2.5, 2.0));
        let notes = find(&audio);
        assert!(near(&of(&notes, CRASH), &[0.5]), "{notes:?}");
    }

    #[test]
    fn a_higher_thump_is_a_tom_and_toms_can_be_turned_off() {
        let mut audio = vec![0.0f32; secs(2.0)];
        add(&mut audio, 0.5, &kick(130.0, 10.0));
        add(&mut audio, 1.2, &kick(55.0, 14.0));
        let notes = find(&audio);
        assert!(near(&of(&notes, TOM_LOW), &[0.5]), "{notes:?}");
        assert!(near(&of(&notes, KICK), &[1.2]), "{notes:?}");
        let no_toms = DrumOnsets {
            options: DrumOptions {
                toms: false,
                ..DrumOptions::default()
            },
        };
        let notes = no_toms
            .transcribe(&audio, RATE, &mut |_| {}, &|| false)
            .unwrap();
        assert!(of(&notes, TOM_LOW).is_empty());
        // The thump that is not a kick is dropped, not written as one.
        assert_eq!(of(&notes, KICK).len(), 1);
    }

    #[test]
    fn velocity_follows_the_loudness_of_a_hit() {
        let mut audio = vec![0.0f32; secs(3.0)];
        for (i, gain) in [1.0f32, 0.35, 1.0, 0.35].iter().enumerate() {
            let hit: Vec<f32> = snare().iter().map(|s| s * gain).collect();
            add(&mut audio, 0.4 + 0.6 * i as f64, &hit);
        }
        let notes = find(&audio);
        let v: Vec<u8> = notes
            .iter()
            .filter(|n| n.pitch == SNARE)
            .map(|n| n.velocity)
            .collect();
        assert_eq!(v.len(), 4, "{notes:?}");
        assert!(v[0] > v[1] && v[2] > v[3], "{v:?}");
        assert!(v.iter().all(|&x| (1..=127).contains(&x)));
    }

    #[test]
    fn a_stop_request_ends_the_run() {
        let audio = vec![0.1f32; secs(5.0)];
        let error = DrumOnsets::default()
            .transcribe(&audio, RATE, &mut |_| {}, &|| true)
            .unwrap_err();
        assert_eq!(error.message, STOPPED);
    }

    #[test]
    fn another_sample_rate_gives_the_same_times() {
        let mut audio = vec![0.0f32; secs(2.0)];
        add(&mut audio, 0.5, &snare());
        let at48 = resample(&audio, RATE, 48_000);
        let notes = DrumOnsets::default()
            .transcribe(&at48, 48_000, &mut |_| {}, &|| false)
            .unwrap();
        assert!(near(&of(&notes, SNARE), &[0.5]), "{notes:?}");
    }
}
