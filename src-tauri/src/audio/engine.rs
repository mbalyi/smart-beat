//! The native audio engine: one synthesizer per track (all sharing one
//! SoundFont), each with its own bus, mixed into a master bus with its own
//! chain, plus the audio track (a recording synced to the score).
//!
//! A track bus runs: synthesizer (or, for a drum track split into elements,
//! one synthesizer per kit piece with its own volume, pan, mute, solo and
//! meter) → the effect chain of the active sound → channel EQ → volume and
//! pan (from the mixer, or from automation) with click-free gain ramps.
//!
//! [`Engine::render`] is plain code with no I/O: the audio output calls it
//! from its callback, and tests and exports call it directly (offline).

use std::sync::Arc;

use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};

use super::kits::LoadedKit;
use super::kits::sampler::SfzSampler;
use serde::{Deserialize, Serialize};

use super::backing::Backing;
use super::chain::{Chain, ChainPlayer, EffectSlot, MAX_MASTER_EFFECTS};
use super::dsp::Effect;
use super::dsp::db_to_gain;
use super::dsp::eq::Eq;
use super::mixing::{Automation, TrackEq, mix_into, pan_gains};
use super::song::Song;

/// Frames rendered at a time; events are placed with this precision.
pub const BLOCK: usize = 64;
/// Synth voices per track.
pub const POLYPHONY: usize = 64;
/// Voices per drum element (a kit piece rarely rings more than a few at once).
const ELEMENT_POLYPHONY: usize = 16;
/// How long playback continues after the last bar (release tails).
const TAIL_SECONDS: f64 = 1.5;
const CLICK_SECONDS: f64 = 0.03;
/// Crossfade when automation switches a track to another sound.
const SOUND_FADE_MS: f32 = 30.0;
/// Sounds (effect chains) per track.
pub const MAX_SOUNDS: usize = 8;
/// Drum element groups per drum track.
pub const MAX_DRUM_ELEMENTS: usize = 24;
/// Focus/trim range in dB.
pub const MAX_TRIM_DB: f32 = 24.0;
const PERCUSSION_CHANNEL: u8 = 9;

/// Mixer state of one track bus (the same values as the score's mixer).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusMix {
    /// 0…1 (a gain multiplier on top of the volume written in the score).
    pub volume: f32,
    /// -1 (left) … 1 (right), applied on top of the score's pan.
    #[serde(default)]
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// Extra gain in dB (the focus switch boosts one track and cuts the rest).
    #[serde(default)]
    pub trim_db: f32,
}

impl Default for BusMix {
    fn default() -> Self {
        Self {
            volume: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
            trim_db: 0.0,
        }
    }
}

impl BusMix {
    fn clamped(self) -> Self {
        let finite = |v: f32, d: f32| if v.is_finite() { v } else { d };
        Self {
            volume: finite(self.volume, 1.0).clamp(0.0, 1.0),
            pan: finite(self.pan, 0.0).clamp(-1.0, 1.0),
            trim_db: finite(self.trim_db, 0.0).clamp(-MAX_TRIM_DB, MAX_TRIM_DB),
            ..self
        }
    }
}

/// What plays a track or a drum piece: the SoundFont synthesizer, or the
/// sampler of an imported SFZ kit (#40).
pub trait Instrument: Send {
    fn midi(&mut self, channel: i32, command: i32, data1: i32, data2: i32);
    fn render(&mut self, left: &mut [f32], right: &mut [f32]);
    fn reset(&mut self);
    fn note_off_all(&mut self, immediate: bool);
}

impl Instrument for Synthesizer {
    fn midi(&mut self, channel: i32, command: i32, data1: i32, data2: i32) {
        self.process_midi_message(channel, command, data1, data2);
    }
    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        Synthesizer::render(self, left, right);
    }
    fn reset(&mut self) {
        Synthesizer::reset(self);
    }
    fn note_off_all(&mut self, immediate: bool) {
        Synthesizer::note_off_all(self, immediate);
    }
}

impl Instrument for SfzSampler {
    fn midi(&mut self, _channel: i32, command: i32, data1: i32, data2: i32) {
        match command {
            0x90 => self.note_on(data1.clamp(0, 127) as u8, data2.clamp(0, 127) as u8),
            // All sound off / all notes off.
            0xb0 if data1 == 120 => SfzSampler::note_off_all(self, true),
            0xb0 if data1 == 123 => SfzSampler::note_off_all(self, false),
            _ => {}
        }
    }
    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        SfzSampler::render(self, left, right);
    }
    fn reset(&mut self) {
        SfzSampler::reset(self);
    }
    fn note_off_all(&mut self, immediate: bool) {
        SfzSampler::note_off_all(self, immediate);
    }
}

/// Creates synthesizers off the audio thread (the engine lock is not needed).
#[derive(Clone)]
pub struct SynthSource {
    sound_font: Arc<SoundFont>,
    sample_rate: f32,
    /// The drum kit the track plays (none: the SoundFont's own kit).
    kit: Option<Arc<LoadedKit>>,
}

impl SynthSource {
    /// The same source, playing `kit` (an imported drum kit, #40).
    pub fn with_kit(mut self, kit: Option<Arc<LoadedKit>>) -> Self {
        self.kit = kit;
        self
    }

    /// What plays a track or a drum piece.
    pub fn instrument(&self, polyphony: usize) -> Result<Box<dyn Instrument>, String> {
        Ok(match self.kit.as_deref() {
            Some(LoadedKit::Sfz(kit)) => {
                Box::new(SfzSampler::new(kit.clone(), self.sample_rate, polyphony))
            }
            Some(LoadedKit::SoundFont(font)) => {
                Box::new(Self::synth_from(font, self.sample_rate, polyphony)?)
            }
            None => Box::new(self.synth(polyphony)?),
        })
    }

    fn synth_from(
        font: &Arc<SoundFont>,
        rate: f32,
        polyphony: usize,
    ) -> Result<Synthesizer, String> {
        let mut settings = SynthesizerSettings::new(rate as i32);
        settings.block_size = BLOCK;
        settings.maximum_polyphony = polyphony;
        // Reverb and chorus are left to the effect chains.
        settings.enable_reverb_and_chorus = false;
        Synthesizer::new(font, &settings).map_err(|e| e.to_string())
    }

    fn synth(&self, polyphony: usize) -> Result<Synthesizer, String> {
        Self::synth_from(&self.sound_font, self.sample_rate, polyphony)
    }

    /// A drum kit split into element groups: `groups[i]` lists the MIDI keys
    /// of element `i`. Keys in no group play on an extra "other" element.
    pub fn drum_split(&self, groups: &[Vec<u8>]) -> Result<DrumSplit, String> {
        if groups.len() > MAX_DRUM_ELEMENTS {
            return Err(format!(
                "A drum kit has at most {MAX_DRUM_ELEMENTS} elements"
            ));
        }
        let other = groups.len() as u8;
        let mut route = [other; 128];
        for (i, keys) in groups.iter().enumerate() {
            for &key in keys {
                if let Some(slot) = route.get_mut(key as usize) {
                    *slot = i as u8;
                }
            }
        }
        let elements = (0..=groups.len())
            .map(|_| {
                Ok(DrumElement {
                    synth: self.instrument(ELEMENT_POLYPHONY)?,
                    mix: BusMix::default(),
                    left: vec![0.0; BLOCK],
                    right: vec![0.0; BLOCK],
                    gains: None,
                    peak: 0.0,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(DrumSplit {
            groups: groups.to_vec(),
            elements,
            route,
            stereo: true,
        })
    }
}

struct DrumElement {
    synth: Box<dyn Instrument>,
    mix: BusMix,
    left: Vec<f32>,
    right: Vec<f32>,
    gains: Option<(f32, f32)>,
    peak: f32,
}

/// A drum track played as one synthesizer per kit piece, so each piece has
/// its own fader, pan, mute, solo and meter.
pub struct DrumSplit {
    groups: Vec<Vec<u8>>,
    elements: Vec<DrumElement>,
    /// Element index of every MIDI key.
    route: [u8; 128],
    stereo: bool,
}

impl DrumSplit {
    pub fn groups(&self) -> &[Vec<u8>] {
        &self.groups
    }

    fn dispatch(&mut self, status: u8, data1: u8, data2: u8) {
        let channel = (status & 0x0f) as i32;
        let command = (status & 0xf0) as i32;
        if matches!(command, 0x80 | 0x90) {
            let element = self.route[(data1 & 0x7f) as usize] as usize;
            if let Some(e) = self.elements.get_mut(element) {
                e.synth.midi(channel, command, data1 as i32, data2 as i32);
            }
        } else {
            for e in &mut self.elements {
                e.synth.midi(channel, command, data1 as i32, data2 as i32);
            }
        }
    }

    /// Renders every element into `out` (which it overwrites).
    fn render(&mut self, out: (&mut [f32], &mut [f32])) {
        let n = out.0.len();
        out.0.fill(0.0);
        out.1.fill(0.0);
        let solo = self.elements.iter().any(|e| e.mix.solo);
        for e in &mut self.elements {
            let (l, r) = (&mut e.left[..n], &mut e.right[..n]);
            e.synth.render(l, r);
            if !self.stereo {
                for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                    let m = 0.5 * (*a + *b);
                    *a = m;
                    *b = m;
                }
            }
            let audible = !e.mix.mute && (!solo || e.mix.solo);
            let gain = if audible {
                e.mix.volume * db_to_gain(e.mix.trim_db)
            } else {
                0.0
            };
            let target = pan_gains(gain, if self.stereo { e.mix.pan } else { 0.0 });
            let peak = mix_into(
                (&e.left[..n], &e.right[..n]),
                (&mut *out.0, &mut *out.1),
                e.gains.unwrap_or(target),
                target,
            );
            e.gains = Some(target);
            e.peak = e.peak.max(peak);
        }
    }

    fn reset(&mut self) {
        for e in &mut self.elements {
            e.synth.reset();
            e.gains = None;
        }
    }

    fn note_off_all(&mut self) {
        for e in &mut self.elements {
            e.synth.note_off_all(false);
        }
    }
}

struct TrackBus {
    synth: Box<dyn Instrument>,
    /// The imported drum kit the track plays, if any (#40).
    kit: Option<Arc<LoadedKit>>,
    drums: Option<DrumSplit>,
    /// One chain per sound; `sounds[active]` plays.
    sounds: Vec<ChainPlayer>,
    active: usize,
    /// The sound being faded out after a switch, and how far the fade is.
    fading: Option<(usize, usize)>,
    /// (song seconds, sound) switches, sorted.
    switches: Vec<(f64, usize)>,
    eq: Option<Eq>,
    automation: Automation,
    mix: BusMix,
    left: Vec<f32>,
    right: Vec<f32>,
    scratch: [Vec<f32>; 2],
    /// Gains applied at the end of the last block (ramped from there; none
    /// after a load or seek, when the first block starts at its target).
    gains: Option<(f32, f32)>,
    /// Peak level since the meters were last read.
    peak: f32,
}

impl TrackBus {
    fn sound_at(&self, seconds: f64) -> usize {
        let i = self.switches.partition_point(|s| s.0 <= seconds);
        let sound = if i == 0 { 0 } else { self.switches[i - 1].1 };
        sound.min(self.sounds.len().saturating_sub(1))
    }

    fn reset(&mut self) {
        self.synth.reset();
        if let Some(drums) = &mut self.drums {
            drums.reset();
        }
        for sound in &mut self.sounds {
            sound.reset();
        }
        self.fading = None;
        self.gains = None;
        if let Some(eq) = &mut self.eq {
            eq.reset();
        }
    }

    /// Runs the active sound's chain (crossfading from the previous sound
    /// right after an automated switch).
    fn process_chain(&mut self, n: usize, fade_len: usize) {
        let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
        let Some((from, pos)) = self.fading else {
            self.sounds[self.active].process(l, r);
            return;
        };
        let [old_l, old_r] = &mut self.scratch;
        old_l[..n].copy_from_slice(l);
        old_r[..n].copy_from_slice(r);
        self.sounds[from].process(&mut old_l[..n], &mut old_r[..n]);
        self.sounds[self.active].process(l, r);
        for i in 0..n {
            let t = ((pos + i) as f32 / fade_len as f32).min(1.0);
            l[i] = l[i] * t + old_l[i] * (1.0 - t);
            r[i] = r[i] * t + old_r[i] * (1.0 - t);
        }
        self.fading = (pos + n < fade_len).then_some((from, pos + n));
    }
}

/// What the UI shows while playing.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    pub tracks: Vec<f32>,
    pub master: f32,
    /// Per track: the levels of its drum elements (empty unless split).
    pub drums: Vec<Vec<f32>>,
    /// The audio track.
    pub backing: f32,
    /// Gain reduction of compressors and limiters (#39).
    pub reduction: Reduction,
}

/// Gain reduction (dB, ≥ 0) of every pedalboard slot since the meters were
/// last read: per track (its playing sound's chain) and the master chain.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reduction {
    pub tracks: Vec<Vec<f32>>,
    pub master: Vec<f32>,
}

pub struct Engine {
    sample_rate: f32,
    sound_font: Arc<SoundFont>,
    song: Option<Arc<Song>>,
    tracks: Vec<TrackBus>,
    master: ChainPlayer,
    master_volume: f32,
    master_pan: f32,
    master_gains: (f32, f32),
    backing: Option<Backing>,
    /// Song time in seconds.
    position: f64,
    next_event: usize,
    next_click: usize,
    playing: bool,
    rate: f64,
    loop_range: Option<(f64, f64)>,
    metronome_volume: f32,
    click_phase: f64,
    click_left: f64,
    click_accent: bool,
    master_peak: f32,
    sound_fade: usize,
    /// Plays single notes the user picks (drum kit preview), on the master bus.
    preview: Option<Synthesizer>,
    preview_buf: [Vec<f32>; 2],
    master_buf: [Vec<f32>; 2],
}

impl Engine {
    pub fn new(sound_font: Arc<SoundFont>, sample_rate: f32) -> Self {
        Self {
            sample_rate,
            sound_font,
            song: None,
            tracks: Vec::new(),
            master: ChainPlayer::new(Chain::empty(), sample_rate, BLOCK),
            master_volume: 1.0,
            master_pan: 0.0,
            master_gains: (1.0, 1.0),
            backing: None,
            position: 0.0,
            next_event: 0,
            next_click: 0,
            playing: false,
            rate: 1.0,
            loop_range: None,
            metronome_volume: 0.0,
            click_phase: 0.0,
            click_left: 0.0,
            click_accent: false,
            master_peak: 0.0,
            sound_fade: ((SOUND_FADE_MS * 0.001 * sample_rate) as usize).max(1),
            preview: None,
            preview_buf: [vec![0.0; BLOCK], vec![0.0; BLOCK]],
            master_buf: [vec![0.0; BLOCK], vec![0.0; BLOCK]],
        }
    }

    /// Plays one note now (e.g. a drum from the kit picker), whether or not
    /// the song plays. Allocates the preview synthesizer the first time.
    pub fn preview(&mut self, channel: u8, key: u8, velocity: u8) -> Result<(), String> {
        if self.preview.is_none() {
            self.preview = Some(self.synth_source().synth(POLYPHONY)?);
        }
        let synth = self.preview.as_mut().expect("just created");
        let channel = (channel & 0x0f) as i32;
        synth.note_off_all_channel(channel, false);
        synth.process_midi_message(channel, 0x90, key.min(127) as i32, velocity.min(127) as i32);
        Ok(())
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn synth_source(&self) -> SynthSource {
        SynthSource {
            sound_font: self.sound_font.clone(),
            sample_rate: self.sample_rate,
            kit: None,
        }
    }

    /// The source of a track's instruments: with the drum kit it plays.
    pub fn synth_source_for(&self, track: usize) -> SynthSource {
        self.synth_source()
            .with_kit(self.tracks.get(track).and_then(|t| t.kit.clone()))
    }

    /// The drum groups of a track's drum mixer, if it has one.
    pub fn drum_groups(&self, track: usize) -> Option<Vec<Vec<u8>>> {
        self.tracks
            .get(track)?
            .drums
            .as_ref()
            .map(|d| d.groups.clone())
    }

    /// Switches a track to another drum kit (#40), with its instrument (and
    /// drum mixer) built for that kit off the audio thread. Returns what it
    /// replaced, to be dropped outside the lock.
    pub fn set_track_kit(
        &mut self,
        track: usize,
        kit: Option<Arc<LoadedKit>>,
        instrument: Box<dyn Instrument>,
        split: Option<DrumSplit>,
    ) -> Option<(Box<dyn Instrument>, Option<DrumSplit>)> {
        let song = self.song.clone();
        let next_event = self.next_event;
        let bus = self.tracks.get_mut(track)?;
        bus.kit = kit;
        let mut old_synth = std::mem::replace(&mut bus.synth, instrument);
        old_synth.note_off_all(true);
        // A new drum mixer for the kit replaces the old one (none: keep it for now).
        let old_split = split.and_then(|s| bus.drums.replace(s));
        // Program and controller changes so far go to the new instruments.
        if let Some(song) = song {
            for event in &song.events[..next_event.min(song.events.len())] {
                if event.track as usize == track && !event.is_note() {
                    let (ch, cmd) = ((event.status & 0x0f) as i32, (event.status & 0xf0) as i32);
                    bus.synth
                        .midi(ch, cmd, event.data1 as i32, event.data2 as i32);
                    if let Some(drums) = &mut bus.drums {
                        drums.dispatch(event.status, event.data1, event.data2);
                    }
                }
            }
        }
        Some((old_synth, old_split))
    }

    pub fn song(&self) -> Option<&Arc<Song>> {
        self.song.as_ref()
    }

    /// Loads a song with one bus per track. Allocates.
    pub fn load(&mut self, song: Arc<Song>) -> Result<(), String> {
        let source = self.synth_source();
        let mut tracks = Vec::with_capacity(song.track_channels.len());
        for _ in &song.track_channels {
            tracks.push(TrackBus {
                synth: source.instrument(POLYPHONY)?,
                kit: None,
                drums: None,
                sounds: vec![ChainPlayer::new(Chain::empty(), self.sample_rate, BLOCK)],
                active: 0,
                fading: None,
                switches: Vec::new(),
                eq: None,
                automation: Automation::default(),
                mix: BusMix::default(),
                left: vec![0.0; BLOCK],
                right: vec![0.0; BLOCK],
                scratch: [vec![0.0; BLOCK], vec![0.0; BLOCK]],
                gains: None,
                peak: 0.0,
            });
        }
        self.tracks = tracks;
        self.song = Some(song);
        self.playing = false;
        self.seek(0.0);
        Ok(())
    }

    pub fn duration(&self) -> f64 {
        self.song.as_ref().map_or(0.0, |s| s.duration)
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn play(&mut self) {
        if self.song.is_some() {
            self.playing = true;
        }
    }

    pub fn pause(&mut self) {
        self.playing = false;
        for track in &mut self.tracks {
            track.synth.note_off_all(false);
            if let Some(drums) = &mut track.drums {
                drums.note_off_all();
            }
        }
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = if rate.is_finite() {
            rate.clamp(0.1, 4.0)
        } else {
            1.0
        };
    }

    pub fn set_loop(&mut self, range: Option<(f64, f64)>) {
        self.loop_range = range.filter(|(a, b)| a.is_finite() && b.is_finite() && b > a);
    }

    pub fn set_metronome_volume(&mut self, volume: f32) {
        self.metronome_volume = volume.clamp(0.0, 3.0);
    }

    pub fn set_master_volume(&mut self, volume: f32) {
        self.master_volume = volume.clamp(0.0, 1.0);
    }

    pub fn set_master_pan(&mut self, pan: f32) {
        self.master_pan = if pan.is_finite() {
            pan.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }

    pub fn set_mix(&mut self, track: usize, mix: BusMix) {
        if let Some(bus) = self.tracks.get_mut(track) {
            bus.mix = mix.clamped();
        }
    }

    /// Crossfades a track's first sound to a new chain; returns the old one to
    /// drop elsewhere.
    pub fn set_track_chain(&mut self, track: usize, chain: Chain) -> Option<Chain> {
        self.set_sound_chain(track, 0, chain)
    }

    /// Crossfades sound `sound` of a track to a new chain (adding sounds up to
    /// `sound` if needed).
    pub fn set_sound_chain(&mut self, track: usize, sound: usize, chain: Chain) -> Option<Chain> {
        if sound >= MAX_SOUNDS {
            return Some(chain);
        }
        let rate = self.sample_rate;
        let bus = self.tracks.get_mut(track)?;
        while bus.sounds.len() <= sound {
            bus.sounds
                .push(ChainPlayer::new(Chain::empty(), rate, BLOCK));
        }
        bus.sounds[sound].replace(chain)
    }

    /// Applies new parameters to a running chain without rebuilding it (see
    /// [`Chain::update`]); false if it must be rebuilt.
    pub fn update_sound_chain(
        &mut self,
        track: Option<usize>,
        sound: usize,
        slots: &[EffectSlot],
        limit: usize,
    ) -> bool {
        match track {
            None => self.master.update(slots, limit),
            Some(t) => self
                .tracks
                .get_mut(t)
                .and_then(|bus| bus.sounds.get_mut(sound))
                .is_some_and(|player| player.update(slots, limit)),
        }
    }

    /// Keeps the first `count` sounds of a track (at least one).
    pub fn set_sound_count(&mut self, track: usize, count: usize) -> Vec<ChainPlayer> {
        let Some(bus) = self.tracks.get_mut(track) else {
            return Vec::new();
        };
        let count = count.clamp(1, MAX_SOUNDS);
        let removed = if bus.sounds.len() > count {
            bus.sounds.split_off(count)
        } else {
            Vec::new()
        };
        if bus.active >= count {
            bus.active = 0;
        }
        bus.fading = bus.fading.filter(|(from, _)| *from < count);
        removed
    }

    /// Sound switches of a track: (song seconds, sound index).
    pub fn set_sound_switches(&mut self, track: usize, mut switches: Vec<(f64, usize)>) {
        let position = self.position;
        if let Some(bus) = self.tracks.get_mut(track) {
            switches.retain(|s| s.0.is_finite());
            switches.sort_by(|a, b| a.0.total_cmp(&b.0));
            bus.switches = switches;
            if !self.playing {
                bus.active = bus.sound_at(position);
                bus.fading = None;
            }
        }
    }

    pub fn set_automation(&mut self, track: usize, automation: Automation) {
        if let Some(bus) = self.tracks.get_mut(track) {
            bus.automation = automation;
        }
    }

    /// The channel EQ of a track (flat removes it).
    pub fn set_track_eq(&mut self, track: usize, eq: &TrackEq) {
        let rate = self.sample_rate;
        if let Some(bus) = self.tracks.get_mut(track) {
            if eq.is_flat() {
                bus.eq = None;
            } else if !bus.eq.as_mut().is_some_and(|e| e.set_bands(&eq.bands())) {
                bus.eq = Some(Eq::new(&eq.bands(), rate));
            }
        }
    }

    /// Splits a drum track into elements (or joins it back with `None`). The
    /// new synthesizers get the controllers and programs of the song so far.
    pub fn set_drum_split(&mut self, track: usize, split: Option<DrumSplit>) -> Option<DrumSplit> {
        let song = self.song.clone();
        let next_event = self.next_event;
        let bus = self.tracks.get_mut(track)?;
        let old = std::mem::replace(&mut bus.drums, split);
        if let (Some(drums), Some(song)) = (&mut bus.drums, song) {
            for event in &song.events[..next_event.min(song.events.len())] {
                if event.track as usize == track && !event.is_note() {
                    drums.dispatch(event.status, event.data1, event.data2);
                }
            }
        }
        if old.is_some() || bus.drums.is_some() {
            bus.synth.note_off_all(true);
        }
        old
    }

    pub fn has_drum_split(&self, track: usize, groups: &[Vec<u8>]) -> bool {
        self.tracks
            .get(track)
            .and_then(|b| b.drums.as_ref())
            .is_some_and(|d| d.groups == groups)
    }

    /// Volume, pan, mute and solo of each element (the last one is "other").
    pub fn set_drum_mix(&mut self, track: usize, mixes: &[BusMix], stereo: bool) {
        if let Some(drums) = self.tracks.get_mut(track).and_then(|b| b.drums.as_mut()) {
            drums.stereo = stereo;
            for (element, mix) in drums.elements.iter_mut().zip(mixes) {
                element.mix = mix.clamped();
            }
        }
    }

    pub fn set_master_chain(&mut self, chain: Chain) -> Option<Chain> {
        self.master.replace(chain)
    }

    pub fn set_backing(&mut self, backing: Option<Backing>) -> Option<Backing> {
        let mut backing = backing;
        if let Some(b) = &mut backing {
            b.reset();
        }
        std::mem::replace(&mut self.backing, backing)
    }

    pub fn backing_mut(&mut self) -> Option<&mut Backing> {
        self.backing.as_mut()
    }

    /// Jumps to `seconds`: stops sounding notes and restores every channel's
    /// controllers, program and pitch bend as they are at that point.
    pub fn seek(&mut self, seconds: f64) {
        let Some(song) = self.song.clone() else {
            return;
        };
        let seconds = if seconds.is_finite() {
            seconds.clamp(0.0, song.duration)
        } else {
            0.0
        };
        for track in &mut self.tracks {
            track.reset();
            track.active = track.sound_at(seconds);
        }
        self.master.reset();
        if let Some(backing) = &mut self.backing {
            backing.reset();
        }
        let index = song.events.partition_point(|e| e.time < seconds);
        for event in &song.events[..index] {
            if !event.is_note() {
                self.dispatch(event.track as usize, event.status, event.data1, event.data2);
            }
        }
        self.next_event = index;
        self.next_click = song.clicks.partition_point(|c| c.0 < seconds);
        self.position = seconds;
        self.click_left = 0.0;
    }

    fn dispatch(&mut self, track: usize, status: u8, data1: u8, data2: u8) {
        let Some(bus) = self.tracks.get_mut(track) else {
            return;
        };
        let is_note = matches!(status & 0xf0, 0x80 | 0x90);
        if let Some(drums) = &mut bus.drums
            && status & 0x0f == PERCUSSION_CHANNEL
        {
            drums.dispatch(status, data1, data2);
            if is_note {
                return;
            }
        }
        bus.synth.midi(
            (status & 0x0f) as i32,
            (status & 0xf0) as i32,
            data1 as i32,
            data2 as i32,
        );
    }

    fn any_solo(&self) -> bool {
        self.tracks.iter().any(|t| t.mix.solo)
            || self.backing.as_ref().is_some_and(Backing::is_solo)
    }

    /// Renders `left.len()` frames (any length) into the buffers.
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        let mut done = 0;
        while done < left.len() {
            let n = (left.len() - done).min(BLOCK);
            self.render_block(&mut left[done..done + n], &mut right[done..done + n]);
            done += n;
        }
    }

    fn render_block(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let step = n as f64 / self.sample_rate as f64 * self.rate;
        let block_start = self.position;
        if self.playing
            && let Some(song) = self.song.clone()
        {
            let block_end = self.position + step;
            while let Some(event) = song.events.get(self.next_event) {
                if event.time >= block_end {
                    break;
                }
                self.dispatch(event.track as usize, event.status, event.data1, event.data2);
                self.next_event += 1;
            }
            if let Some(&(time, accent)) = song.clicks.get(self.next_click)
                && time < block_end
            {
                self.next_click += 1;
                self.click_left = CLICK_SECONDS;
                self.click_phase = 0.0;
                self.click_accent = accent;
            }
        }

        out_l.fill(0.0);
        out_r.fill(0.0);
        let solo = self.any_solo();
        let fade_len = self.sound_fade;
        for bus in &mut self.tracks {
            if self.playing {
                let wanted = bus.sound_at(block_start);
                if wanted != bus.active {
                    bus.sounds[wanted].reset();
                    bus.fading = Some((bus.active, 0));
                    bus.active = wanted;
                }
            }
            match &mut bus.drums {
                Some(drums) => drums.render((&mut bus.left[..n], &mut bus.right[..n])),
                None => bus.synth.render(&mut bus.left[..n], &mut bus.right[..n]),
            }
            bus.process_chain(n, fade_len);
            if let Some(eq) = &mut bus.eq {
                eq.process(&mut bus.left[..n], &mut bus.right[..n]);
            }
            let auto = &bus.automation;
            let volume = auto.volume.value_at(block_start).unwrap_or(bus.mix.volume);
            let pan = auto.pan.value_at(block_start).unwrap_or(bus.mix.pan);
            let muted = auto
                .mute
                .step_at(block_start)
                .map_or(bus.mix.mute, |m| m >= 0.5);
            let audible = !muted && (!solo || bus.mix.solo);
            let gain = if audible {
                volume.clamp(0.0, 1.0) * db_to_gain(bus.mix.trim_db)
            } else {
                0.0
            };
            let target = pan_gains(gain, pan);
            let peak = mix_into(
                (&bus.left[..n], &bus.right[..n]),
                (&mut *out_l, &mut *out_r),
                bus.gains.unwrap_or(target),
                target,
            );
            bus.gains = Some(target);
            bus.peak = bus.peak.max(peak);
        }

        if let Some(backing) = &mut self.backing {
            let audible = !solo || backing.is_solo();
            backing.render(
                block_start,
                self.rate,
                self.playing,
                audible,
                (&mut *out_l, &mut *out_r),
            );
        }

        if let Some(preview) = self.preview.as_mut() {
            let [pl, pr] = &mut self.preview_buf;
            preview.render(&mut pl[..n], &mut pr[..n]);
            for i in 0..n {
                out_l[i] += pl[i];
                out_r[i] += pr[i];
            }
        }

        if self.click_left > 0.0 && self.metronome_volume > 0.0 {
            let freq = if self.click_accent { 1_760.0 } else { 1_320.0 };
            let dt = 1.0 / self.sample_rate as f64;
            for i in 0..n {
                if self.click_left <= 0.0 {
                    break;
                }
                let envelope = (self.click_left / CLICK_SECONDS) as f32;
                let s = (self.click_phase * std::f64::consts::TAU).sin() as f32
                    * 0.3
                    * envelope
                    * self.metronome_volume;
                out_l[i] += s;
                out_r[i] += s;
                self.click_phase += freq * dt;
                self.click_left -= dt;
            }
        }

        self.master.process(out_l, out_r);
        let target = pan_gains(self.master_volume, self.master_pan);
        let [ml, mr] = &mut self.master_buf;
        ml[..n].copy_from_slice(out_l);
        mr[..n].copy_from_slice(out_r);
        out_l.fill(0.0);
        out_r.fill(0.0);
        mix_into(
            (&ml[..n], &mr[..n]),
            (&mut *out_l, &mut *out_r),
            self.master_gains,
            target,
        );
        self.master_gains = target;
        let mut peak = self.master_peak;
        for (a, b) in out_l.iter_mut().zip(out_r.iter_mut()) {
            *a = a.clamp(-1.0, 1.0);
            *b = b.clamp(-1.0, 1.0);
            peak = peak.max(a.abs()).max(b.abs());
        }
        self.master_peak = peak;

        if self.playing {
            self.position += step;
            if let Some((start, end)) = self.loop_range
                && self.position >= end
            {
                self.seek(start);
            } else if self.position >= self.duration() + TAIL_SECONDS {
                self.playing = false;
                self.position = self.duration();
            }
        }
    }

    /// Peak levels since the last call (then resets them).
    pub fn take_meters(&mut self) -> Meters {
        let tracks = self
            .tracks
            .iter_mut()
            .map(|t| std::mem::take(&mut t.peak))
            .collect();
        let drums = self
            .tracks
            .iter_mut()
            .map(|t| {
                t.drums.as_mut().map_or_else(Vec::new, |d| {
                    d.elements
                        .iter_mut()
                        .map(|e| std::mem::take(&mut e.peak))
                        .collect()
                })
            })
            .collect();
        let reduction = Reduction {
            tracks: self
                .tracks
                .iter_mut()
                .map(|t| {
                    let active = t.active.min(t.sounds.len().saturating_sub(1));
                    t.sounds
                        .get_mut(active)
                        .map_or_else(Vec::new, |s| s.take_reduction().to_vec())
                })
                .collect(),
            master: self.master.take_reduction()[..MAX_MASTER_EFFECTS].to_vec(),
        };
        Meters {
            tracks,
            master: std::mem::take(&mut self.master_peak),
            drums,
            reduction,
            backing: self
                .backing
                .as_mut()
                .map_or(0.0, |b| std::mem::take(&mut b.peak)),
        }
    }

    pub fn chain_problems(
        &self,
        track: Option<usize>,
        sound: usize,
    ) -> Vec<super::chain::BlockProblem> {
        match track {
            Some(i) => self
                .tracks
                .get(i)
                .and_then(|t| t.sounds.get(sound))
                .map(|s| s.current().problems.clone())
                .unwrap_or_default(),
            None => self.master.current().problems.clone(),
        }
    }
}
