//! The monitor track: the live input (a guitar through an audio interface, or
//! a microphone) played through its own effect chain, EQ and fader, whether
//! the song plays or not. It is never part of an export.
//!
//! The input and the output run on their own clocks, often on two devices.
//! The input callback writes into a [`Ring`]; the engine reads it block by
//! block through a [`Reader`], which converts the input's rate to the
//! output's and adjusts that ratio a little so the ring stays nearly empty:
//! low latency, and no clicks when the two clocks drift apart.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use super::chain::{Chain, ChainPlayer, EffectSlot, MAX_TRACK_EFFECTS};
use super::dsp::Effect;
use super::dsp::eq::Eq;
use super::mixing::{TrackEq, mix_into, pan_gains};

/// Samples the ring holds (a power of two): about a third of a second at 48 kHz.
pub const RING_CAPACITY: usize = 16_384;
/// Input samples kept in the ring at its emptiest, to start with.
const START_MARGIN: usize = 64;
/// How much the margin grows after the ring ran empty.
const MARGIN_STEP: usize = 64;
const MAX_MARGIN: usize = 4_096;
/// Seconds over which the ring's lowest fill is measured.
const WINDOW_SECONDS: f64 = 0.25;
/// Largest speed-up or slow-down that keeps the ring near its margin.
const MAX_CORRECTION: f64 = 0.002;
/// Within this many samples of the margin, the reader does not correct (and
/// passes samples through untouched when the rates are equal).
const DEADBAND: f64 = 8.0;
/// More extra samples than this (after a stall) are skipped at once.
const JUMP_SAMPLES: usize = 1_024;

/// A lock-free ring of samples between one writer (the input callback) and
/// one reader (the engine). Samples are stored as `f32` bits in atomics, so
/// no `unsafe` is needed; the counters only grow (wrapping).
pub struct Ring {
    samples: Box<[AtomicU32]>,
    mask: usize,
    written: AtomicUsize,
    read: AtomicUsize,
    /// Samples the writer could not store (the ring was full).
    pub dropped: AtomicUsize,
}

impl Ring {
    /// A ring of `capacity` samples, rounded up to a power of two.
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(2).next_power_of_two();
        Self {
            samples: (0..capacity).map(|_| AtomicU32::new(0)).collect(),
            mask: capacity - 1,
            written: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
        }
    }

    pub fn capacity(&self) -> usize {
        self.mask + 1
    }

    /// Writer side: stores as many samples as fit; returns how many.
    pub fn push(&self, samples: &[f32]) -> usize {
        let written = self.written.load(Ordering::Relaxed);
        let read = self.read.load(Ordering::Acquire);
        let free = self.capacity() - written.wrapping_sub(read);
        let n = samples.len().min(free);
        for (i, s) in samples[..n].iter().enumerate() {
            self.samples[written.wrapping_add(i) & self.mask].store(s.to_bits(), Ordering::Relaxed);
        }
        self.written
            .store(written.wrapping_add(n), Ordering::Release);
        if n < samples.len() {
            self.dropped.fetch_add(samples.len() - n, Ordering::Relaxed);
        }
        n
    }

    /// Reader side: samples waiting to be read.
    pub fn available(&self) -> usize {
        let written = self.written.load(Ordering::Acquire);
        written.wrapping_sub(self.read.load(Ordering::Relaxed))
    }

    /// Reader side: the sample `offset` places after the next one to read
    /// (only valid below [`Ring::available`]).
    fn peek(&self, offset: usize) -> f32 {
        let read = self.read.load(Ordering::Relaxed);
        f32::from_bits(self.samples[read.wrapping_add(offset) & self.mask].load(Ordering::Relaxed))
    }

    /// Reader side: forgets the next `n` samples (at most what is there).
    pub fn skip(&self, n: usize) {
        let n = n.min(self.available());
        let read = self.read.load(Ordering::Relaxed);
        self.read.store(read.wrapping_add(n), Ordering::Release);
    }

    /// Reader side: takes up to `out.len()` samples; returns how many.
    pub fn pop(&self, out: &mut [f32]) -> usize {
        let n = out.len().min(self.available());
        for (i, s) in out[..n].iter_mut().enumerate() {
            *s = self.peek(i);
        }
        self.skip(n);
        n
    }
}

/// Reads the ring at the output's rate (see the module docs).
pub struct Reader {
    ring: Arc<Ring>,
    /// Input samples per output sample at the nominal rates.
    ratio: f64,
    /// The drift correction (around 1) the ratio is multiplied with.
    correction: f64,
    /// Where the next output sits between `history[1]` and `history[2]`.
    frac: f64,
    /// The last four input samples, oldest first.
    history: [f32; 4],
    /// The ring has enough in it to start (again).
    primed: bool,
    /// Input samples to keep in the ring at its emptiest.
    margin: usize,
    /// The ring's lowest fill (after a block) in this window.
    window_min: usize,
    window_left: usize,
    window_len: usize,
    /// Times the ring ran empty.
    pub underruns: u32,
    /// Loudest input sample since the meters were last read.
    pub peak: f32,
}

impl Reader {
    pub fn new(ring: Arc<Ring>, input_rate: f32, output_rate: f32) -> Self {
        let window_len = ((WINDOW_SECONDS * f64::from(output_rate)) as usize).max(1);
        Self {
            ring,
            ratio: f64::from(input_rate.max(1.0)) / f64::from(output_rate.max(1.0)),
            correction: 1.0,
            frac: 0.0,
            history: [0.0; 4],
            primed: false,
            margin: START_MARGIN,
            window_min: usize::MAX,
            window_left: window_len,
            window_len,
            underruns: 0,
            peak: 0.0,
        }
    }

    /// Input samples kept in the ring at its emptiest.
    pub fn margin(&self) -> usize {
        self.margin
    }

    /// Samples waiting in the ring (part of the latency).
    pub fn queued(&self) -> usize {
        self.ring.available()
    }

    fn step(&self) -> f64 {
        self.ratio * self.correction
    }

    /// The next input sample, or None when the ring is empty.
    fn next_input(&mut self) -> Option<f32> {
        let mut sample = [0.0];
        (self.ring.pop(&mut sample) == 1).then(|| {
            self.peak = self.peak.max(sample[0].abs());
            sample[0]
        })
    }

    /// Fills `out` with the input at the output's rate. Returns false when
    /// nothing came in (`out` is silent then).
    pub fn read(&mut self, out: &mut [f32]) -> bool {
        if !self.primed {
            let needed = self.margin + (out.len() as f64 * self.step()).ceil() as usize + 4;
            let available = self.ring.available();
            if available < needed {
                out.fill(0.0);
                return false;
            }
            // What came in before the engine listened is old by now: start
            // with the newest input, and a margin more for the rest of the
            // output's buffer.
            self.ring
                .skip(available.saturating_sub(needed + self.margin));
            self.primed = true;
            self.frac = 0.0;
            self.history = [0.0; 4];
            // Fill the interpolator so the first output is the first sample.
            for _ in 0..3 {
                let s = self.next_input().unwrap_or(0.0);
                self.history = [self.history[1], self.history[2], self.history[3], s];
            }
        }
        let step = self.step();
        for i in 0..out.len() {
            let [xm1, x0, x1, x2] = self.history;
            out[i] = hermite(self.frac as f32, xm1, x0, x1, x2);
            self.frac += step;
            while self.frac >= 1.0 {
                self.frac -= 1.0;
                let Some(s) = self.next_input() else {
                    // Ran empty: silence until there is enough again, with a
                    // bigger margin.
                    out[i + 1..].fill(0.0);
                    self.primed = false;
                    self.underruns = self.underruns.saturating_add(1);
                    self.margin = (self.margin + MARGIN_STEP).min(MAX_MARGIN);
                    self.window_min = usize::MAX;
                    self.window_left = self.window_len;
                    self.correction = 1.0;
                    return true;
                };
                let [_, a, b, c] = self.history;
                self.history = [a, b, c, s];
            }
        }
        self.window_min = self.window_min.min(self.ring.available());
        self.window_left = self.window_left.saturating_sub(out.len());
        if self.window_left == 0 {
            self.adjust();
        }
        true
    }

    /// Once per window: skips a backlog, or nudges the speed so the ring's
    /// lowest fill settles at the margin.
    fn adjust(&mut self) {
        let lowest = self.window_min;
        self.window_min = usize::MAX;
        self.window_left = self.window_len;
        if lowest == usize::MAX {
            return;
        }
        if lowest > self.margin + JUMP_SAMPLES {
            self.ring.skip(lowest - self.margin);
            self.correction = 1.0;
            return;
        }
        let error = lowest as f64 - self.margin as f64;
        self.correction = if error.abs() <= DEADBAND {
            1.0
        } else {
            // Drains (or refills) the difference over about two windows.
            let per_window = self.window_len as f64 * self.ratio;
            1.0 + (error / (2.0 * per_window)).clamp(-MAX_CORRECTION, MAX_CORRECTION)
        };
    }
}

/// Four-point cubic Hermite interpolation between `x0` (t = 0) and `x1` (t = 1).
fn hermite(t: f32, xm1: f32, x0: f32, x1: f32, x2: f32) -> f32 {
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * t + c2) * t + c1) * t + x0
}

/// How the monitor track plays. Mirrored by `MonitorParams` in `src/lib/tauri.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MonitorParams {
    /// Listening to the input (off: the input is closed).
    pub enabled: bool,
    pub volume: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub eq: TrackEq,
}

impl Default for MonitorParams {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 0.8,
            pan: 0.0,
            mute: false,
            solo: false,
            eq: TrackEq::default(),
        }
    }
}

impl MonitorParams {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.volume.is_finite() && (0.0..=1.0).contains(&self.volume)) {
            return Err("monitor volume must be between 0 and 1".into());
        }
        if !(self.pan.is_finite() && (-1.0..=1.0).contains(&self.pan)) {
            return Err("monitor pan must be between -1 and 1".into());
        }
        self.eq.validate()
    }
}

/// The monitor track's bus in the engine: input → effect chain → channel EQ
/// → volume and pan.
pub struct Monitor {
    reader: Option<Reader>,
    chain: ChainPlayer,
    eq: Option<Eq>,
    params: MonitorParams,
    sample_rate: f32,
    left: Vec<f32>,
    right: Vec<f32>,
    gains: Option<(f32, f32)>,
    /// Peak level after the fader since the meters were last read.
    pub peak: f32,
}

impl Monitor {
    pub fn new(chain: Chain, sample_rate: f32, max_block: usize) -> Self {
        Self {
            reader: None,
            chain: ChainPlayer::new(chain, sample_rate, max_block),
            eq: None,
            params: MonitorParams::default(),
            sample_rate,
            left: vec![0.0; max_block],
            right: vec![0.0; max_block],
            gains: None,
            peak: 0.0,
        }
    }

    pub fn params(&self) -> &MonitorParams {
        &self.params
    }

    pub fn set_params(&mut self, params: &MonitorParams) {
        let changed = self.params.eq != params.eq;
        let eq = if changed {
            Self::prepare_eq(params, self.sample_rate)
        } else {
            None
        };
        self.set_prepared_params(params.clone(), eq, changed);
    }

    pub fn prepare_eq(params: &MonitorParams, rate: f32) -> Option<Eq> {
        (!params.eq.is_flat()).then(|| Eq::new(&params.eq.bands(), rate))
    }

    /// Installs prepared settings; the caller drops retired allocations outside the engine lock.
    pub fn set_prepared_params(
        &mut self,
        params: MonitorParams,
        eq: Option<Eq>,
        eq_changed: bool,
    ) -> (Option<Eq>, MonitorParams) {
        let mut eq = eq;
        if let (Some(prepared), Some(current)) = (&mut eq, &self.eq) {
            prepared.copy_state(current);
        }
        let old_eq = if eq_changed {
            std::mem::replace(&mut self.eq, eq)
        } else {
            eq
        };
        let params = MonitorParams {
            volume: if params.volume.is_finite() {
                params.volume.clamp(0.0, 1.0)
            } else {
                0.0
            },
            pan: if params.pan.is_finite() {
                params.pan.clamp(-1.0, 1.0)
            } else {
                0.0
            },
            ..params
        };
        (old_eq, std::mem::replace(&mut self.params, params))
    }

    /// Connects the input (None: no input); returns the old reader.
    pub fn set_reader(&mut self, reader: Option<Reader>) -> Option<Reader> {
        self.gains = Some((0.0, 0.0));
        std::mem::replace(&mut self.reader, reader)
    }

    pub fn reader(&self) -> Option<&Reader> {
        self.reader.as_ref()
    }

    /// Crossfades to a new chain; returns the old one to drop elsewhere.
    pub fn set_chain(&mut self, chain: Chain) -> Option<Chain> {
        self.chain.replace(chain)
    }

    /// See [`ChainPlayer::update`].
    pub fn update_chain(&mut self, slots: &[EffectSlot]) -> bool {
        self.chain.update(slots, MAX_TRACK_EFFECTS)
    }

    pub fn chain(&self) -> &Chain {
        self.chain.current()
    }

    pub fn is_solo(&self) -> bool {
        self.params.enabled && self.params.solo
    }

    pub fn bypass(&mut self) {
        self.chain.bypass();
    }

    pub fn take_reduction(&mut self) -> [f32; MAX_TRACK_EFFECTS] {
        self.chain.take_reduction()
    }

    /// The loudest input sample since the last call.
    pub fn take_input_peak(&mut self) -> f32 {
        self.reader
            .as_mut()
            .map_or(0.0, |r| std::mem::take(&mut r.peak))
    }

    /// Adds the monitored input into `out`. `audible` is false while another
    /// bus is soloed.
    pub fn render(&mut self, audible: bool, out: (&mut [f32], &mut [f32])) {
        let n = out.0.len().min(self.left.len());
        let Some(reader) = self.reader.as_mut().filter(|_| self.params.enabled) else {
            self.gains = None;
            return;
        };
        let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
        reader.read(l);
        r.copy_from_slice(l);
        self.chain.process(l, r);
        if let Some(eq) = &mut self.eq {
            eq.process(l, r);
        }
        let gain = if audible && !self.params.mute {
            self.params.volume
        } else {
            0.0
        };
        let target = pan_gains(gain, self.params.pan);
        let peak = mix_into(
            (&self.left[..n], &self.right[..n]),
            (&mut out.0[..n], &mut out.1[..n]),
            self.gains.unwrap_or((0.0, 0.0)),
            target,
        );
        self.gains = Some(target);
        self.peak = self.peak.max(peak);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate).sin() * 0.5)
            .collect()
    }

    /// Zero crossings upwards per second.
    fn frequency(signal: &[f32], rate: f32) -> f32 {
        let crossings = signal
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count();
        crossings as f32 / (signal.len() as f32 / rate)
    }

    #[test]
    fn the_ring_keeps_order_wraps_and_refuses_overflow() {
        let ring = Ring::new(8);
        assert_eq!(ring.capacity(), 8);
        assert_eq!(ring.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]), 6);
        let mut out = [0.0; 4];
        assert_eq!(ring.pop(&mut out), 4);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        // Wraps around the end.
        assert_eq!(ring.push(&[7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0]), 6);
        assert_eq!(ring.dropped.load(Ordering::Relaxed), 1);
        assert_eq!(ring.available(), 8);
        let mut all = [0.0; 10];
        assert_eq!(ring.pop(&mut all), 8);
        assert_eq!(&all[..8], &[5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]);
        assert_eq!(ring.available(), 0);
    }

    #[test]
    fn the_ring_works_across_threads() {
        let ring = Arc::new(Ring::new(1_024));
        let writer = {
            let ring = ring.clone();
            std::thread::spawn(move || {
                let mut next = 0u32;
                while next < 100_000 {
                    let chunk: Vec<f32> =
                        (next..(next + 64).min(100_000)).map(|v| v as f32).collect();
                    let n = ring.push(&chunk);
                    next += n as u32;
                    if n == 0 {
                        std::thread::yield_now();
                    }
                }
            })
        };
        let mut expected = 0u32;
        let mut buf = [0.0f32; 100];
        while expected < 100_000 {
            let n = ring.pop(&mut buf);
            for v in &buf[..n] {
                assert_eq!(*v, expected as f32);
                expected += 1;
            }
            if n == 0 {
                std::thread::yield_now();
            }
        }
        writer.join().unwrap();
    }

    #[test]
    fn equal_rates_pass_the_samples_through_untouched() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        // Every value once (7919 and 4001 are prime), never exactly 0; whole callbacks.
        let input: Vec<f32> = (0..3_968)
            .map(|i| ((i * 7919) % 4001) as f32 / 4001.0 - 0.4999)
            .collect();
        let mut reader = Reader::new(ring.clone(), 48_000.0, 48_000.0);
        let mut heard = Vec::new();
        let mut block = [0.0f32; 64];
        // The input arrives in 128-sample callbacks, the output reads 64 at a time.
        for chunk in input.chunks(128) {
            ring.push(chunk);
            for _ in 0..2 {
                if reader.read(&mut block) {
                    heard.extend_from_slice(&block);
                }
            }
        }
        let start = heard.iter().position(|s| *s != 0.0).unwrap();
        let first = input.iter().position(|s| *s == heard[start]).unwrap();
        let n = heard.len() - start;
        assert!(n > 3_000, "heard only {n} samples");
        assert_eq!(&heard[start..], &input[first..first + n]);
        assert_eq!(reader.underruns, 0);
    }

    #[test]
    fn converts_44k1_to_48k_and_keeps_the_pitch() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        let input = sine(440.0, 44_100.0, 44_100);
        let mut reader = Reader::new(ring.clone(), 44_100.0, 48_000.0);
        let mut heard = Vec::new();
        let mut block = [0.0f32; 64];
        let mut produced = 0usize;
        let mut fed = 0usize;
        // The input clock runs at 44.1 kHz, the output at 48 kHz.
        while fed < input.len() {
            let due = ((produced + 64) as f64 * 44_100.0 / 48_000.0) as usize + 128;
            while fed < due.min(input.len()) {
                let end = (fed + 128).min(input.len());
                ring.push(&input[fed..end]);
                fed = end;
            }
            if reader.read(&mut block) {
                heard.extend_from_slice(&block);
            }
            produced += 64;
        }
        let steady = &heard[4_800..heard.len() - 4_800];
        let f = frequency(steady, 48_000.0);
        assert!((f - 440.0).abs() < 3.0, "heard {f} Hz");
        assert_eq!(reader.underruns, 0);
    }

    /// Runs `seconds` of a producer whose clock is `drift` faster (or slower)
    /// than the output's; returns the ring fill after every block.
    fn run_with_drift(drift: f64, seconds: f64) -> (Vec<usize>, u32) {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        let mut reader = Reader::new(ring.clone(), 48_000.0, 48_000.0);
        let mut block = [0.0f32; 64];
        let chunk = vec![0.25f32; 128];
        let mut produced = 0.0f64;
        let mut fills = Vec::new();
        let blocks = (seconds * 48_000.0 / 64.0) as usize;
        for b in 0..blocks {
            // The input callback delivers 128 samples whenever its clock has them.
            let due = (b + 1) as f64 * 64.0 * (1.0 + drift) + 256.0;
            while produced + 128.0 <= due {
                ring.push(&chunk);
                produced += 128.0;
            }
            reader.read(&mut block);
            fills.push(ring.available());
        }
        (fills, reader.underruns)
    }

    #[test]
    fn drift_correction_keeps_the_ring_nearly_empty() {
        for drift in [0.001, -0.001, 0.0005] {
            let (fills, underruns) = run_with_drift(drift, 60.0);
            let late = &fills[fills.len() / 2..];
            let most = *late.iter().max().unwrap();
            assert!(most < 600, "drift {drift}: the ring grew to {most}");
            assert!(underruns <= 3, "drift {drift}: {underruns} underruns");
        }
    }

    #[test]
    fn a_backlog_after_a_stall_is_skipped() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        let mut reader = Reader::new(ring.clone(), 48_000.0, 48_000.0);
        // The output stalled while the input kept coming.
        ring.push(&vec![0.1; 9_000]);
        let mut block = [0.0f32; 64];
        for _ in 0..400 {
            ring.push(&[0.1; 64]);
            reader.read(&mut block);
        }
        assert!(
            ring.available() < 600,
            "{} samples queued",
            ring.available()
        );
    }

    #[test]
    fn starts_with_the_newest_input_not_a_backlog() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        // The input was open a while before the engine read it.
        let input: Vec<f32> = (0..5_000).map(|i| i as f32).collect();
        ring.push(&input);
        let mut reader = Reader::new(ring.clone(), 48_000.0, 48_000.0);
        let mut block = [0.0f32; 64];
        assert!(reader.read(&mut block));
        // The first sample heard is about a block and two margins old.
        assert!(block[0] > 5_000.0 - 250.0, "started at sample {}", block[0]);
        assert!(ring.available() <= 2 * START_MARGIN + 1);
    }

    #[test]
    fn an_empty_ring_gives_silence_not_old_samples() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        let mut reader = Reader::new(ring.clone(), 48_000.0, 48_000.0);
        ring.push(&[0.7; 300]);
        let mut block = [0.0f32; 64];
        let mut outputs = Vec::new();
        for _ in 0..10 {
            reader.read(&mut block);
            outputs.extend_from_slice(&block);
        }
        // Everything was played once, then silence.
        let loud = outputs.iter().filter(|s| (**s - 0.7).abs() < 1e-6).count();
        assert!(loud <= 300);
        assert!(outputs[outputs.len() - 128..].iter().all(|s| *s == 0.0));
        assert!(reader.underruns >= 1);
        assert!(reader.margin() > START_MARGIN);
    }

    #[test]
    fn the_monitor_mixes_with_volume_pan_and_mute() {
        let ring = Arc::new(Ring::new(RING_CAPACITY));
        ring.push(&vec![0.5; 4_096]);
        let mut monitor = Monitor::new(Chain::empty(), 48_000.0, 64);
        monitor.set_reader(Some(Reader::new(ring.clone(), 48_000.0, 48_000.0)));
        monitor.set_params(&MonitorParams {
            volume: 1.0,
            pan: 1.0,
            ..MonitorParams::default()
        });
        let (mut l, mut r) = ([0.0f32; 64], [0.0f32; 64]);
        monitor.render(true, (&mut l, &mut r));
        l.fill(0.0);
        r.fill(0.0);
        monitor.render(true, (&mut l, &mut r));
        assert!(l.iter().all(|s| s.abs() < 1e-6), "panned right");
        assert!(
            r[10..]
                .iter()
                .all(|s| (*s - 0.5 * std::f32::consts::SQRT_2).abs() < 1e-4)
        );
        assert!(monitor.take_input_peak() > 0.49);
        monitor.set_params(&MonitorParams {
            mute: true,
            ..MonitorParams::default()
        });
        for _ in 0..2 {
            l.fill(0.0);
            r.fill(0.0);
            monitor.render(true, (&mut l, &mut r));
        }
        assert!(l.iter().chain(&r).all(|s| *s == 0.0));
    }

    #[test]
    fn connecting_and_reconnecting_ramps_from_silence() {
        let mut monitor = Monitor::new(Chain::empty(), 48_000.0, 64);
        monitor.set_params(&MonitorParams {
            volume: 1.0,
            ..MonitorParams::default()
        });
        for _ in 0..2 {
            let ring = Arc::new(Ring::new(RING_CAPACITY));
            ring.push(&[0.5; 512]);
            monitor.set_reader(Some(Reader::new(ring, 48_000.0, 48_000.0)));
            let (mut l, mut r) = ([0.0; 64], [0.0; 64]);
            monitor.render(true, (&mut l, &mut r));
            assert!(l[0].abs() < 0.02, "input must fade in from silence");
            assert!(l[63] > 0.45, "input reaches its target level");
            assert!(l.windows(2).all(|w| (w[1] - w[0]).abs() < 0.02));
            assert_eq!(l, r);
        }
    }

    #[test]
    fn prepared_eq_and_fader_changes_preserve_the_filter_tail() {
        let mut monitor = Monitor::new(Chain::empty(), 48_000.0, 64);
        let mut params = MonitorParams {
            eq: TrackEq {
                low_db: 6.0,
                ..TrackEq::default()
            },
            ..MonitorParams::default()
        };
        monitor.set_params(&params);
        let mut reference = Eq::new(&params.eq.bands(), 48_000.0);
        let (mut l, mut r) = ([0.5; 64], [0.5; 64]);
        reference.process(&mut l, &mut r);
        let (mut l, mut r) = ([0.5; 64], [0.5; 64]);
        monitor.eq.as_mut().unwrap().process(&mut l, &mut r);
        params.eq.low_db = 9.0;
        reference.set_bands(&params.eq.bands());
        let prepared = Monitor::prepare_eq(&params, 48_000.0);
        drop(monitor.set_prepared_params(params.clone(), prepared, true));
        for _ in 0..2 {
            let (mut expected_l, mut expected_r) = ([0.0; 64], [0.0; 64]);
            reference.process(&mut expected_l, &mut expected_r);
            let (mut l, mut r) = ([0.0; 64], [0.0; 64]);
            monitor.eq.as_mut().unwrap().process(&mut l, &mut r);
            assert!(l.iter().any(|s| s.abs() > 1e-6));
            assert_eq!(l, expected_l);
            assert_eq!(r, expected_r);
            params.volume = 0.4;
            drop(monitor.set_prepared_params(params.clone(), None, false));
        }
        let retired = monitor.set_prepared_params(MonitorParams::default(), None, true);
        assert!(retired.0.is_some());
        assert!(monitor.eq.is_none());
    }

    #[test]
    fn validates_its_settings() {
        assert!(MonitorParams::default().validate().is_ok());
        let loud = MonitorParams {
            volume: 1.5,
            ..MonitorParams::default()
        };
        assert!(loud.validate().is_err());
        let wide = MonitorParams {
            pan: f32::NAN,
            ..MonitorParams::default()
        };
        assert!(wide.validate().is_err());
    }
}
