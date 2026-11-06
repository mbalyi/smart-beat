//! The chain: drums, then bass, then vocals, then panned parts, then what is left. Every stage
//! works on what the one before left over, and takes its share out of the spectrogram
//! (`rest -= mask * rest`), so the stems always add up to the input.
//!
//! The song is cut into 10 s segments with 1 s of context on each side, processed in parallel,
//! and handed to the sink in order. Every mask looks at most 0.1 s ahead or behind, so the
//! seams are not audible and a 30 minute file needs the memory of a few segments, not of the
//! whole spectrogram.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use super::stft::{BINS, Spec, Stft};
use super::{StemKind, StemSink, bass, hpss, stereo};
use crate::audio::backing::DecodedAudio;

const SEGMENT_SECONDS: f64 = 10.0;
const GUARD_SECONDS: f64 = 1.0;

/// The window HPSS looks through. A long window resolves notes but sees a kick or snare body as
/// tonal; a short one sees every hit as a line across the spectrum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrumMode {
    /// 2048-sample frames only.
    Long,
    /// 512-sample frames only.
    Short,
    /// A long pass, then a short pass on what it left (Driedger et al., iterative HPSS).
    Both,
}

const SHORT_FRAME: usize = 512;

/// Which stages run and how hard they cut. The defaults are the app's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    pub drums: bool,
    pub bass: bool,
    pub vocals: bool,
    pub panned: bool,
    /// 1 is the plain Wiener mask; above 1 sends doubtful cells to the drums (see [`hpss`]).
    pub drum_margin: f32,
    /// Sharpness of the centre mask for vocals.
    pub centre_sharpness: f32,
    /// How the drums are found; see [`DrumMode`].
    pub drum_mode: DrumMode,
    /// Replace the soft drum mask by a binary one. Only the benchmark uses it, to show the
    /// "musical noise" that hard masks cause.
    pub binary_drum_mask: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            drums: true,
            bass: true,
            vocals: true,
            panned: true,
            drum_margin: 1.3,
            drum_mode: DrumMode::Long,
            centre_sharpness: 2.0,
            binary_drum_mask: false,
        }
    }
}

impl Options {
    /// Drums removed harder: a long pass then a short pass (see [`DrumMode`]). Takes the drums
    /// down about twice as far in dB as the default, and takes more of a bass, a vocal or a guitar
    /// attack with it, because the short window cannot tell a kick from a bass note.
    pub fn strong_drums(self) -> Self {
        Self {
            drum_mode: DrumMode::Both,
            drum_margin: 1.0,
            ..self
        }
    }

    /// The stages that run for a list of wanted stems (`Other` is always produced).
    pub fn for_kinds(kinds: &[StemKind]) -> Self {
        let has = |k| kinds.contains(&k);
        Self {
            drums: has(StemKind::Drums),
            bass: has(StemKind::Bass),
            vocals: has(StemKind::Vocals),
            panned: has(StemKind::Panned),
            ..Self::default()
        }
    }

    pub fn kinds(&self) -> Vec<StemKind> {
        let mut out = Vec::new();
        for (on, kind) in [
            (self.drums, StemKind::Drums),
            (self.bass, StemKind::Bass),
            (self.vocals, StemKind::Vocals),
            (self.panned, StemKind::Panned),
        ] {
            if on {
                out.push(kind);
            }
        }
        out.push(StemKind::Other);
        out
    }
}

/// What the job learned about the file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    /// Left and right are the same signal: the stereo stages (vocals, panned) were skipped.
    pub mono: bool,
    /// Stems that were asked for but could not be made.
    pub skipped: Vec<StemKind>,
    /// Share of the energy above 150 Hz that is hard-panned (0 to 1).
    pub panned_share: f32,
}

struct Segment {
    /// Range of the song this segment owns.
    start: usize,
    end: usize,
    /// Range that is processed (with context).
    from: usize,
    to: usize,
}

fn segments(len: usize, rate: u32) -> Vec<Segment> {
    let seg = (SEGMENT_SECONDS * rate as f64) as usize;
    let guard = (GUARD_SECONDS * rate as f64) as usize;
    (0..len.div_ceil(seg))
        .map(|i| {
            let (start, end) = (i * seg, ((i + 1) * seg).min(len));
            Segment {
                start,
                end,
                from: start.saturating_sub(guard),
                to: (end + guard).min(len),
            }
        })
        .collect()
}

/// Takes `mask * rest` out of `rest` (both channels) and returns it as a stem.
fn take(rest: &mut (Spec, Spec), mask: &[f32]) -> (Spec, Spec) {
    let frames = rest.0.frames();
    let (mut a, mut b) = (Spec::zeros(frames), Spec::zeros(frames));
    for (i, &m) in mask.iter().enumerate() {
        a.data[i] = rest.0.data[i] * m;
        b.data[i] = rest.1.data[i] * m;
        rest.0.data[i] -= a.data[i];
        rest.1.data[i] -= b.data[i];
    }
    (a, b)
}

/// Percussive pass with the short window on what is left in `rest`; the drums found are taken
/// out of `rest` and returned as long-window spectrograms.
fn short_pass(
    stft: &Stft,
    short: &Stft,
    rest: &mut (Spec, Spec),
    len: usize,
    margin: f32,
) -> (Spec, Spec) {
    let (tl, tr) = (stft.synthesise(&rest.0, len), stft.synthesise(&rest.1, len));
    let (mut sl, mut sr) = (short.analyse(&tl), short.analyse(&tr));
    let mag: Vec<f32> = sl
        .data
        .iter()
        .zip(&sr.data)
        .map(|(a, b)| 0.5 * (a.norm() + b.norm()))
        .collect();
    let mask = hpss::percussive_mask(&mag, sl.frames(), short.bins(), margin, 2.0);
    for (i, m) in mask.iter().enumerate() {
        sl.data[i] *= *m;
        sr.data[i] *= *m;
    }
    let (dl, dr) = (short.synthesise(&sl, len), short.synthesise(&sr, len));
    let (a, b) = (stft.analyse(&dl), stft.analyse(&dr));
    for i in 0..rest.0.data.len() {
        rest.0.data[i] -= a.data[i];
        rest.1.data[i] -= b.data[i];
    }
    (a, b)
}

type Stems = Vec<(StemKind, Vec<f32>, Vec<f32>)>;

/// One segment: the stems for `l` and `r` (time-domain, same length).
fn process(
    stft: &Stft,
    short: &Stft,
    l: &[f32],
    r: &[f32],
    rate: f32,
    opts: &Options,
    mono: bool,
) -> (Stems, f32) {
    let len = l.len();
    let mut rest = (stft.analyse(l), stft.analyse(r));
    let frames = rest.0.frames();
    let mut parts: Vec<(StemKind, Spec, Spec)> = Vec::new();
    let panned_share = stereo::panned_share(&rest.0, &rest.1, rate);

    // Hard-panned parts first: the pan cue alone separates them, and taking them out leaves the
    // drum, bass and vocal stages a cleaner centre.
    if opts.panned && !mono {
        let mask = stereo::panned_mask(&rest.0, &rest.1, 0.35, 0.75);
        let (a, b) = take(&mut rest, &mask);
        parts.push((StemKind::Panned, a, b));
    }
    if opts.drums {
        let (mut dl, mut dr) = (Spec::zeros(frames), Spec::zeros(frames));
        if opts.drum_mode != DrumMode::Short {
            let mag: Vec<f32> = rest
                .0
                .data
                .iter()
                .zip(&rest.1.data)
                .map(|(a, b)| 0.5 * (a.norm() + b.norm()))
                .collect();
            let mut mask = hpss::percussive_mask(&mag, frames, BINS, opts.drum_margin, 2.0);
            if opts.binary_drum_mask {
                mask = hpss::binarise(&mask);
            }
            let (a, b) = take(&mut rest, &mask);
            dl = a;
            dr = b;
        }
        if opts.drum_mode != DrumMode::Long {
            let (a, b) = short_pass(stft, short, &mut rest, len, opts.drum_margin);
            for (x, y) in dl.data.iter_mut().zip(&a.data) {
                *x += *y;
            }
            for (x, y) in dr.data.iter_mut().zip(&b.data) {
                *x += *y;
            }
        }
        parts.push((StemKind::Drums, dl, dr));
    }
    if opts.bass {
        let mid: Vec<f32> = {
            let (a, b) = (stft.synthesise(&rest.0, len), stft.synthesise(&rest.1, len));
            a.iter().zip(&b).map(|(x, y)| 0.5 * (x + y)).collect()
        };
        let mut pitches = bass::track(&mid, rate, frames);
        let mag: Vec<f32> = rest
            .0
            .data
            .iter()
            .zip(&rest.1.data)
            .map(|(a, b)| 0.5 * (a.norm() + b.norm()))
            .collect();
        bass::validate(&mut pitches, &mag, rate);
        bass::bridge_gaps(&mut pitches, 6);
        let mut mask = bass::comb_mask(&pitches, rate);
        // Bass sits in the centre. Where a guitar plays the same notes an octave up (common),
        // only the stereo image tells them apart.
        if !mono {
            let centred = stereo::coherence_mask(&rest.0, &rest.1, 1.0);
            for (m, c) in mask.iter_mut().zip(&centred) {
                *m *= c;
            }
        }
        let (a, b) = take(&mut rest, &mask);
        parts.push((StemKind::Bass, a, b));
    }
    if opts.vocals && !mono {
        let mask = stereo::centre_mask(&rest.0, &rest.1, rate, opts.centre_sharpness);
        let (a, b) = take(&mut rest, &mask);
        parts.push((StemKind::Vocals, a, b));
    }
    parts.push((StemKind::Other, rest.0, rest.1));

    let stems = parts
        .into_iter()
        .map(|(kind, a, b)| (kind, stft.synthesise(&a, len), stft.synthesise(&b, len)))
        .collect();
    (stems, panned_share)
}

/// Separates `audio` and hands every stem to `sink`, in song order.
///
/// `progress` receives 0 to 1. `cancel` is checked between segments; a cancelled job returns
/// [`super::STOPPED`] and the sink holds whatever was written before.
pub fn separate(
    audio: &DecodedAudio,
    opts: &Options,
    sink: &mut dyn StemSink,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<Report, String> {
    let rate = audio.rate as f32;
    let mono = stereo::is_mono(&audio.left, &audio.right);
    let segs = segments(audio.frames(), audio.rate);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 8);
    let stft = Stft::new();
    let short = Stft::with_frame(SHORT_FRAME);
    let (mut share_sum, mut share_n) = (0.0f32, 0usize);
    progress(0.0);
    for (batch_index, batch) in segs.chunks(threads).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(super::STOPPED.into());
        }
        let results: Vec<(Stems, f32)> = std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|s| {
                    let (stft, short, opts) = (&stft, &short, opts);
                    scope.spawn(move || {
                        process(
                            stft,
                            short,
                            &audio.left[s.from..s.to],
                            &audio.right[s.from..s.to],
                            rate,
                            opts,
                            mono,
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("a separation worker panicked"))
                .collect()
        });
        for (seg, (stems, share)) in batch.iter().zip(results) {
            let (a, b) = (seg.start - seg.from, seg.end - seg.from);
            for (kind, left, right) in &stems {
                sink.write(*kind, &left[a..b], &right[a..b])?;
            }
            share_sum += share;
            share_n += 1;
        }
        progress(((batch_index + 1) * threads).min(segs.len()) as f32 / segs.len() as f32);
    }
    let skipped = if mono {
        [
            (opts.vocals, StemKind::Vocals),
            (opts.panned, StemKind::Panned),
        ]
        .into_iter()
        .filter_map(|(on, kind)| on.then_some(kind))
        .collect()
    } else {
        Vec::new()
    };
    Ok(Report {
        mono,
        skipped,
        panned_share: if share_n == 0 {
            0.0
        } else {
            share_sum / share_n as f32
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::separation::MemorySink;
    use crate::separation::metrics::{reduction_db, sdr_db};
    use crate::separation::synth::{self, Stereo};

    fn audio(s: &Stereo) -> DecodedAudio {
        DecodedAudio {
            rate: synth::RATE,
            channels: 2,
            left: s.left.clone(),
            right: s.right.clone(),
        }
    }

    fn run(mix: &Stereo, opts: &Options) -> (MemorySink, Report) {
        let mut sink = MemorySink::default();
        let report = separate(
            &audio(mix),
            opts,
            &mut sink,
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .unwrap();
        (sink, report)
    }

    /// The mix without one stem, left channel.
    fn remaining(sink: &MemorySink, mix: &Stereo, kind: StemKind) -> Vec<f32> {
        let stem = &sink.stems[&kind].0;
        mix.left.iter().zip(stem).map(|(m, s)| m - s).collect()
    }

    #[test]
    fn the_stems_add_up_to_the_mix() {
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let n = band.mix.left.len();
        for ch in 0..2 {
            let mix = if ch == 0 {
                &band.mix.left
            } else {
                &band.mix.right
            };
            let pick = |s: &(Vec<f32>, Vec<f32>)| if ch == 0 { s.0.clone() } else { s.1.clone() };
            let mut sum = vec![0.0f32; n];
            for stem in sink.stems.values() {
                let samples = pick(stem);
                assert_eq!(samples.len(), n);
                for (a, b) in sum.iter_mut().zip(&samples) {
                    *a += b;
                }
            }
            assert!(sdr_db(mix, &sum) > 60.0, "stems must add up to the mix");
        }
    }

    #[test]
    fn muting_the_drums_takes_them_down_by_a_set_amount() {
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let rest = remaining(&sink, &band.mix, StemKind::Drums);
        let db = reduction_db(&band.drums.left, &band.mix.left, &rest);
        assert!(db > 4.0, "drums reduced by only {db:.1} dB");
        // And the music is still there.
        let kept = reduction_db(&band.guitars.left, &band.mix.left, &rest);
        assert!(kept < 2.5, "the guitar lost {kept:.1} dB with the drums");
    }

    #[test]
    fn muting_the_bass_takes_it_down_and_leaves_the_drums() {
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let rest = remaining(&sink, &band.mix, StemKind::Bass);
        let db = reduction_db(&band.bass.left, &band.mix.left, &rest);
        assert!(db > 5.0, "bass reduced by only {db:.1} dB");
        let drums = reduction_db(&band.drums.left, &band.mix.left, &rest);
        assert!(drums < 3.0, "the drums lost {drums:.1} dB with the bass");
    }

    #[test]
    fn muting_the_vocal_takes_it_down() {
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let rest = remaining(&sink, &band.mix, StemKind::Vocals);
        let db = reduction_db(&band.vocals.left, &band.mix.left, &rest);
        assert!(db > 3.0, "vocal reduced by only {db:.1} dB");
    }

    #[test]
    fn muting_the_panned_guitars_takes_them_down() {
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let rest = remaining(&sink, &band.mix, StemKind::Panned);
        let db = reduction_db(&band.guitars.left, &band.mix.left, &rest);
        assert!(db > 7.0, "guitar reduced by only {db:.1} dB");
    }

    #[test]
    fn strong_drums_take_the_drums_down_about_twice_as_far() {
        let band = synth::band(12.0);
        let (gentle, _) = run(&band.mix, &Options::default());
        let (strong, _) = run(&band.mix, &Options::default().strong_drums());
        let db = |sink: &MemorySink| {
            let rest = remaining(sink, &band.mix, StemKind::Drums);
            reduction_db(&band.drums.left, &band.mix.left, &rest)
        };
        let (g, s) = (db(&gentle), db(&strong));
        assert!(s > g + 3.0, "strong {s:.1} dB vs gentle {g:.1} dB");
        assert!(s > 8.0, "strong drums reduced by only {s:.1} dB");
    }

    #[test]
    fn a_low_cut_for_the_bass_damages_the_kick_more_than_the_bass_mask() {
        // The old tool's way: remove the bass by cutting everything below 150 Hz. The kick
        // shares that range and goes with it. (On this clean low bass the cut also removes
        // the bass fundamental well; the spike doc reports both numbers.)
        let band = synth::band(12.0);
        let (sink, _) = run(&band.mix, &Options::default());
        let ours = remaining(&sink, &band.mix, StemKind::Bass);
        let ours_kick = reduction_db(&band.drums.left, &band.mix.left, &ours);
        let cut = low_cut(&band.mix.left, 150.0);
        let cut_kick = reduction_db(&band.drums.left, &band.mix.left, &cut);
        assert!(
            cut_kick > ours_kick + 2.0,
            "{cut_kick:.1} vs {ours_kick:.1}"
        );
    }

    /// A 4th-order Linkwitz-Riley style high-pass (two cascaded one-pole pairs is enough here).
    fn low_cut(x: &[f32], hz: f32) -> Vec<f32> {
        let a = (-TAU_F * hz / synth::RATE as f32).exp();
        let mut y = x.to_vec();
        for _ in 0..4 {
            let mut low = 0.0f32;
            for v in y.iter_mut() {
                low = (1.0 - a) * *v + a * low;
                *v -= low;
            }
        }
        y
    }
    const TAU_F: f32 = std::f32::consts::TAU;

    #[test]
    fn a_mono_file_skips_the_stereo_stages_and_says_so() {
        let band = synth::band(6.0);
        let mono = Stereo {
            left: band.mix.left.clone(),
            right: band.mix.left.clone(),
        };
        let (sink, report) = run(&mono, &Options::default());
        assert!(report.mono);
        assert_eq!(report.skipped, vec![StemKind::Vocals, StemKind::Panned]);
        assert!(!sink.stems.contains_key(&StemKind::Vocals));
        assert!(sink.stems.contains_key(&StemKind::Other));
    }

    #[test]
    fn a_stopped_job_returns_the_stopped_message() {
        let band = synth::band(12.0);
        let mut sink = MemorySink::default();
        let stop = AtomicBool::new(true);
        let err = separate(
            &audio(&band.mix),
            &Options::default(),
            &mut sink,
            &stop,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err, crate::separation::STOPPED);
        assert!(sink.stems.is_empty());
    }

    #[test]
    fn only_the_asked_stages_run() {
        let band = synth::band(6.0);
        let opts = Options::for_kinds(&[StemKind::Drums]);
        let (sink, _) = run(&band.mix, &opts);
        let kinds: Vec<_> = sink.stems.keys().copied().collect();
        assert_eq!(kinds, vec![StemKind::Drums, StemKind::Other]);
    }

    #[test]
    fn soft_masks_flicker_less_than_binary_ones() {
        let band = synth::band(6.0);
        let stft = Stft::new();
        let (l, r) = (stft.analyse(&band.mix.left), stft.analyse(&band.mix.right));
        let mag: Vec<f32> = l
            .data
            .iter()
            .zip(&r.data)
            .map(|(a, b)| 0.5 * (a.norm() + b.norm()))
            .collect();
        let soft = hpss::percussive_mask(&mag, l.frames(), BINS, 1.0, 2.0);
        let hard = hpss::binarise(&soft);
        let bins = crate::separation::stft::BINS;
        assert!(
            crate::separation::metrics::mask_flicker(&soft, bins)
                < crate::separation::metrics::mask_flicker(&hard, bins)
        );
    }
}
