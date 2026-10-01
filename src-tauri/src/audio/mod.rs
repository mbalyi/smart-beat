//! Native audio engine (ADR 0002): plays the score's MIDI with per-track
//! synthesizers and effect chains, and the user's sound library.
//!
//! The UI keeps alphaTab for notation and timing; when the native engine is
//! switched on, alphaTab follows this engine's clock (external media mode).

pub mod backing;
pub mod chain;
pub mod dsp;
pub mod engine;
pub mod library;
pub mod mixing;
pub mod output;
pub mod sf3;
pub mod song;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use rustysynth::SoundFont;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CommandError, ErrorKind};
use backing::{Backing, BackingParams, DecodedAudio, PEAKS_PER_SECOND, SyncMap};
use chain::{BlockProblem, Chain, EffectSlot, MAX_MASTER_EFFECTS, MAX_TRACK_EFFECTS};
use engine::{BLOCK, BusMix, DrumSplit, Engine, MAX_DRUM_ELEMENTS, MAX_SOUNDS, Meters};
use library::{AssetKind, Library, LibraryItem};
use mixing::{Automation, AutomationData, TrackEq};
use output::Output;
use song::{Song, SongData};

/// Largest SoundFont accepted from the UI.
const MAX_SOUNDFONT_BYTES: usize = 64 * 1024 * 1024;

fn audio_error(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorKind::Audio, message)
}

/// Converts and parses a SoundFont (SF2 or SF3).
pub fn parse_sound_font(bytes: &[u8]) -> Result<SoundFont, String> {
    let sf2 = sf3::to_sf2(bytes).map_err(|e| e.to_string())?;
    SoundFont::new(&mut std::io::Cursor::new(&sf2[..]))
        .map_err(|e| format!("The SoundFont cannot be read: {e}"))
}

/// One element of a drum kit split for the drum mixer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumElementData {
    /// The MIDI keys this element plays.
    pub keys: Vec<u8>,
    pub mix: BusMix,
}

/// The drum mixer of a drum track. Keys in no element play on `other`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumMixData {
    pub stereo: bool,
    pub elements: Vec<DrumElementData>,
    #[serde(default)]
    pub other: BusMix,
}

impl DrumMixData {
    fn groups(&self) -> Vec<Vec<u8>> {
        self.elements.iter().map(|e| e.keys.clone()).collect()
    }

    fn mixes(&self) -> Vec<BusMix> {
        self.elements
            .iter()
            .map(|e| e.mix)
            .chain(std::iter::once(self.other))
            .collect()
    }
}

/// A sync point: a song position (ticks, the start of a bar) and the time in
/// the recording that matches it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPointData {
    pub tick: u32,
    pub ms: f64,
}

/// Where the audio track comes from.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BackingSource {
    /// A file on disk.
    File { path: PathBuf },
    /// Embedded in a saved song file.
    #[serde(rename_all = "camelCase")]
    Embedded { score_path: PathBuf, name: String },
}

/// What the UI learns about a loaded recording.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackingInfo {
    pub name: String,
    pub duration_ms: f64,
    pub sample_rate: u32,
    pub channels: usize,
    /// Loudest sample per 1/`peaks_per_second` s (0…1), for the waveform.
    pub peaks: Vec<f32>,
    pub peaks_per_second: u32,
}

struct LoadedBacking {
    name: String,
    /// The encoded file, kept to embed it in the song file on save.
    bytes: Arc<Vec<u8>>,
    audio: Arc<DecodedAudio>,
    params: BackingParams,
    sync: Vec<SyncPointData>,
}

#[derive(Default)]
struct Inner {
    sound_fonts: HashMap<String, Arc<SoundFont>>,
    engine: Option<Arc<Mutex<Engine>>>,
    output: Option<Output>,
    sound_font_id: Option<String>,
    song: Option<Arc<Song>>,
    mixes: Vec<BusMix>,
    master_pan: f32,
    /// Effect chains of each sound of a track (sound 0 first).
    track_sounds: HashMap<usize, Vec<Vec<EffectSlot>>>,
    master_chain: Vec<EffectSlot>,
    /// Sound switches of a track: (tick, sound).
    switches: HashMap<usize, Vec<(u32, usize)>>,
    automation: HashMap<usize, AutomationData>,
    eqs: HashMap<usize, TrackEq>,
    drums: HashMap<usize, DrumMixData>,
    backing: Option<LoadedBacking>,
}

impl Inner {
    fn seconds_at(&self, tick: u32) -> f64 {
        self.song.as_ref().map_or(0.0, |s| s.seconds_at(tick))
    }

    fn sync_map(&self, sync: &[SyncPointData]) -> SyncMap {
        SyncMap::new(
            sync.iter()
                .map(|p| (self.seconds_at(p.tick), p.ms / 1000.0))
                .collect(),
        )
    }

    fn switches_in_seconds(&self, track: usize) -> Vec<(f64, usize)> {
        self.switches
            .get(&track)
            .map(|s| {
                s.iter()
                    .map(|&(tick, sound)| (self.seconds_at(tick), sound))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The bytes of the loaded recording, if `name` is the one loaded.
    pub fn backing_bytes(&self) -> Option<(String, Arc<Vec<u8>>)> {
        self.backing
            .as_ref()
            .map(|b| (b.name.clone(), b.bytes.clone()))
    }
}

pub struct AudioState {
    inner: Mutex<Inner>,
    pub library: Arc<Library>,
}

impl AudioState {
    pub fn new(library_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            library: Arc::new(Library::new(library_dir)),
        }
    }

    /// The loaded recording's file name and encoded bytes (for embedding).
    pub fn backing_bytes(&self) -> Option<(String, Arc<Vec<u8>>)> {
        self.inner.lock().unwrap().backing_bytes()
    }
}

/// What `audio_start` and `audio_state` report.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub running: bool,
    pub sample_rate: u32,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub playing: bool,
    pub latency_ms: f64,
    /// Buffers dropped since the last report.
    pub dropouts: u32,
    /// Peak time spent in the audio callback since the last report (% of the buffer).
    pub load_percent: f64,
    pub meters: Meters,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Transport {
    Play,
    Pause,
    Seek {
        ms: f64,
    },
    Rate {
        value: f64,
    },
    /// Loops between two ticks of the song; both null stops looping.
    #[serde(rename_all = "camelCase")]
    Loop {
        start_tick: Option<u32>,
        end_tick: Option<u32>,
    },
    Metronome {
        volume: f32,
    },
    MasterVolume {
        value: f32,
    },
    MasterPan {
        value: f32,
    },
    /// Plays one note now (a drum picked in the kit), e.g. channel 9, key 38.
    Preview {
        channel: u8,
        key: u8,
        velocity: u8,
    },
}

fn with_engine<T>(inner: &Inner, f: impl FnOnce(&mut Engine) -> T) -> Result<T, CommandError> {
    let engine = inner
        .engine
        .as_ref()
        .ok_or_else(|| audio_error("The audio engine is not running"))?;
    let mut engine = engine.lock().unwrap();
    Ok(f(&mut engine))
}

fn build_chain(state: &AudioState, rate: u32, slots: &[EffectSlot], limit: usize) -> Chain {
    Chain::build(
        slots,
        limit,
        rate as f32,
        BLOCK,
        &state.library.assets(rate),
    )
}

/// Everything an engine needs besides the song, built without its lock.
struct Prepared {
    master: Chain,
    sounds: Vec<(usize, Vec<Chain>)>,
    drums: Vec<(usize, Option<DrumSplit>)>,
    backing: Option<Backing>,
}

fn prepare(
    state: &AudioState,
    inner: &Inner,
    rate: u32,
    synths: &engine::SynthSource,
    current: Option<&Engine>,
) -> Prepared {
    let master = build_chain(state, rate, &inner.master_chain, MAX_MASTER_EFFECTS);
    let sounds = inner
        .track_sounds
        .iter()
        .map(|(&track, sounds)| {
            let chains = sounds
                .iter()
                .map(|slots| build_chain(state, rate, slots, MAX_TRACK_EFFECTS))
                .collect();
            (track, chains)
        })
        .collect();
    let drums = inner
        .drums
        .iter()
        .filter(|(track, d)| !current.is_some_and(|e| e.has_drum_split(**track, &d.groups())))
        .map(|(&track, d)| {
            let split = synths
                .drum_split(&d.groups())
                .map_err(|e| eprintln!("drum split: {e}"))
                .ok();
            (track, split)
        })
        .collect();
    let backing = inner.backing.as_ref().map(|b| {
        let mut backing = Backing::new(b.audio.clone(), rate as f32, BLOCK);
        backing.set(b.params.clone(), inner.sync_map(&b.sync));
        backing
    });
    Prepared {
        master,
        sounds,
        drums,
        backing,
    }
}

/// Installs the prepared parts and the mixer state; returns what to drop.
fn install(
    engine: &mut Engine,
    inner: &Inner,
    prepared: Prepared,
) -> Vec<Box<dyn std::any::Any + Send>> {
    let mut old: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
    for (track, mix) in inner.mixes.iter().enumerate() {
        engine.set_mix(track, *mix);
    }
    engine.set_master_pan(inner.master_pan);
    if let Some(c) = engine.set_master_chain(prepared.master) {
        old.push(Box::new(c));
    }
    for (track, chains) in prepared.sounds {
        for p in engine.set_sound_count(track, chains.len()) {
            old.push(Box::new(p));
        }
        for (sound, chain) in chains.into_iter().enumerate() {
            if let Some(c) = engine.set_sound_chain(track, sound, chain) {
                old.push(Box::new(c));
            }
        }
    }
    let tracks: Vec<usize> = inner.track_sounds.keys().copied().collect();
    for track in tracks.iter().copied().chain(inner.switches.keys().copied()) {
        engine.set_sound_switches(track, inner.switches_in_seconds(track));
    }
    for (&track, data) in &inner.automation {
        engine.set_automation(track, Automation::from_ticks(data, |t| inner.seconds_at(t)));
    }
    for (&track, eq) in &inner.eqs {
        engine.set_track_eq(track, eq);
    }
    for (track, split) in prepared.drums {
        if let Some(s) = engine.set_drum_split(track, split) {
            old.push(Box::new(s));
        }
    }
    for (&track, d) in &inner.drums {
        engine.set_drum_mix(track, &d.mixes(), d.stereo);
    }
    if let Some(b) = engine.set_backing(prepared.backing) {
        old.push(Box::new(b));
    }
    old
}

/// Applies the whole stored configuration to the running engine.
fn configure_running(state: &AudioState, inner: &Inner) -> Result<(), CommandError> {
    let Some(engine) = &inner.engine else {
        return Ok(());
    };
    let (rate, synths) = {
        let e = engine.lock().unwrap();
        (e.sample_rate() as u32, e.synth_source())
    };
    // Called after a new engine or a new song: no drum split exists yet.
    let prepared = prepare(state, inner, rate, &synths, None);
    let old = install(&mut engine.lock().unwrap(), inner, prepared);
    drop(old);
    Ok(())
}

/// Receives a SoundFont as a raw body; the `x-sound-font-id` header names it.
#[tauri::command(async)]
pub fn audio_load_soundfont(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    let id = request
        .headers()
        .get("x-sound-font-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .ok_or_else(|| audio_error("The SoundFont has no id"))?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(audio_error("The SoundFont must be sent as raw bytes"));
    };
    if bytes.len() > MAX_SOUNDFONT_BYTES {
        return Err(audio_error("The SoundFont is too large"));
    }
    if state.inner.lock().unwrap().sound_fonts.contains_key(&id) {
        return Ok(());
    }
    let font = parse_sound_font(bytes).map_err(audio_error)?;
    state
        .inner
        .lock()
        .unwrap()
        .sound_fonts
        .insert(id, Arc::new(font));
    Ok(())
}

/// Opens the audio output with a loaded SoundFont (or switches the SoundFont).
#[tauri::command(async)]
pub fn audio_start(
    sound_font: String,
    state: State<'_, AudioState>,
) -> Result<EngineStatus, CommandError> {
    let mut inner = state.inner.lock().unwrap();
    let font = inner
        .sound_fonts
        .get(&sound_font)
        .cloned()
        .ok_or_else(|| audio_error("The SoundFont is not loaded"))?;
    if inner.output.is_none() || inner.sound_font_id.as_deref() != Some(&sound_font) {
        inner.output = None;
        let rate = output::default_sample_rate().map_err(audio_error)?;
        let mut engine = Engine::new(font, rate as f32);
        if let Some(song) = inner.song.clone() {
            engine.load(song).map_err(audio_error)?;
        }
        let engine = Arc::new(Mutex::new(engine));
        let output = Output::open(engine.clone()).map_err(audio_error)?;
        inner.engine = Some(engine);
        inner.output = Some(output);
        inner.sound_font_id = Some(sound_font);
        configure_running(&state, &inner)?;
    }
    status(&inner)
}

#[tauri::command(async)]
pub fn audio_stop(state: State<'_, AudioState>) {
    let mut inner = state.inner.lock().unwrap();
    inner.output = None;
    inner.engine = None;
    inner.sound_font_id = None;
}

fn status(inner: &Inner) -> Result<EngineStatus, CommandError> {
    let (Some(engine), Some(output)) = (&inner.engine, &inner.output) else {
        return Ok(EngineStatus::default());
    };
    let published = &output.published;
    let (duration, meters) = {
        let mut engine = engine.lock().unwrap();
        (engine.duration(), engine.take_meters())
    };
    Ok(EngineStatus {
        running: true,
        sample_rate: output.sample_rate,
        position_ms: f64::from_bits(published.position.load(Ordering::Relaxed)) * 1000.0,
        duration_ms: duration * 1000.0,
        playing: published.playing.load(Ordering::Relaxed),
        latency_ms: published.latency_us.load(Ordering::Relaxed) as f64 / 1000.0,
        dropouts: published.dropouts.swap(0, Ordering::Relaxed),
        load_percent: published.load_permille.swap(0, Ordering::Relaxed) as f64 / 10.0,
        meters,
    })
}

#[tauri::command(async)]
pub fn audio_load_song(song: SongData, state: State<'_, AudioState>) -> Result<(), CommandError> {
    let song = Arc::new(Song::from_data(&song).map_err(audio_error)?);
    let mut inner = state.inner.lock().unwrap();
    inner.song = Some(song.clone());
    // Chains, sounds, automation, EQ and drum mixes belong to a song: the UI
    // sends them again after loading one. The audio track stays.
    inner.track_sounds.clear();
    inner.master_chain.clear();
    inner.switches.clear();
    inner.automation.clear();
    inner.eqs.clear();
    inner.drums.clear();
    if inner.engine.is_some() {
        with_engine(&inner, |engine| engine.load(song))?.map_err(audio_error)?;
        configure_running(&state, &inner)?;
    }
    Ok(())
}

#[tauri::command]
pub fn audio_transport(
    command: Transport,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().unwrap();
    if let Transport::MasterPan { value } = command {
        inner.master_pan = if value.is_finite() {
            value.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        if inner.engine.is_none() {
            return Ok(());
        }
    }
    let inner = inner;
    with_engine(&inner, |engine| match command {
        Transport::Play => engine.play(),
        Transport::Pause => engine.pause(),
        Transport::Seek { ms } => engine.seek(ms / 1000.0),
        Transport::Rate { value } => engine.set_rate(value),
        Transport::Loop {
            start_tick,
            end_tick,
        } => {
            let range = start_tick
                .zip(end_tick)
                .zip(inner.song.as_ref())
                .map(|((a, b), song)| (song.seconds_at(a), song.seconds_at(b)));
            engine.set_loop(range)
        }
        Transport::Metronome { volume } => engine.set_metronome_volume(volume),
        Transport::MasterVolume { value } => engine.set_master_volume(value),
        Transport::MasterPan { value } => engine.set_master_pan(value),
        Transport::Preview {
            channel,
            key,
            velocity,
        } => {
            if let Err(e) = engine.preview(channel, key, velocity) {
                eprintln!("preview: {e}");
            }
        }
    })
}

#[tauri::command]
pub fn audio_set_mix(mixes: Vec<BusMix>, state: State<'_, AudioState>) -> Result<(), CommandError> {
    if mixes.len() > song::MAX_TRACKS {
        return Err(audio_error("Too many tracks"));
    }
    let mut inner = state.inner.lock().unwrap();
    inner.mixes = mixes;
    if let Some(engine) = &inner.engine {
        let mut engine = engine.lock().unwrap();
        for (track, mix) in inner.mixes.iter().enumerate() {
            engine.set_mix(track, *mix);
        }
    }
    Ok(())
}

fn check_track(track: usize) -> Result<(), CommandError> {
    if track >= song::MAX_TRACKS {
        return Err(audio_error("No such track"));
    }
    Ok(())
}

fn check_chain(slots: &[EffectSlot], limit: usize) -> Result<(), CommandError> {
    if slots.len() > limit {
        return Err(audio_error(format!(
            "A chain holds at most {limit} effects"
        )));
    }
    Ok(())
}

/// Sets the effect chain of a track's sound (or of the master bus,
/// `track: null`). A knob turn updates the running blocks; anything else
/// builds the chain again and crossfades. Returns the blocks that cannot run
/// (missing assets and so on).
#[tauri::command(async)]
pub fn audio_set_chain(
    track: Option<usize>,
    slots: Vec<EffectSlot>,
    sound: Option<usize>,
    state: State<'_, AudioState>,
) -> Result<Vec<BlockProblem>, CommandError> {
    let limit = if track.is_some() {
        MAX_TRACK_EFFECTS
    } else {
        MAX_MASTER_EFFECTS
    };
    check_chain(&slots, limit)?;
    let sound = sound.unwrap_or(0);
    if sound >= MAX_SOUNDS {
        return Err(audio_error(format!(
            "A track has at most {MAX_SOUNDS} sounds"
        )));
    }
    if let Some(t) = track {
        check_track(t)?;
    }
    let mut inner = state.inner.lock().unwrap();
    match track {
        Some(t) => {
            let sounds = inner.track_sounds.entry(t).or_default();
            if sounds.len() <= sound {
                sounds.resize(sound + 1, Vec::new());
            }
            sounds[sound] = slots.clone();
        }
        None => inner.master_chain = slots.clone(),
    }
    let Some(engine) = inner.engine.clone() else {
        // Not running: check the blocks at the usual rate so the UI can warn.
        return Ok(build_chain(&state, 48_000, &slots, limit).problems);
    };
    if engine
        .lock()
        .unwrap()
        .update_sound_chain(track, sound, &slots, limit)
    {
        return Ok(Vec::new());
    }
    let rate = engine.lock().unwrap().sample_rate() as u32;
    let chain = build_chain(&state, rate, &slots, limit);
    let problems = chain.problems.clone();
    let old = {
        let mut engine = engine.lock().unwrap();
        match track {
            Some(t) => engine.set_sound_chain(t, sound, chain),
            None => engine.set_master_chain(chain),
        }
    };
    drop(old);
    Ok(problems)
}

/// Replaces every sound of a track (sound 0 first) and the bars where the
/// track switches sound: `switches` are (tick, sound index) pairs.
#[tauri::command(async)]
pub fn audio_set_sounds(
    track: usize,
    sounds: Vec<Vec<EffectSlot>>,
    switches: Vec<(u32, usize)>,
    state: State<'_, AudioState>,
) -> Result<Vec<Vec<BlockProblem>>, CommandError> {
    check_track(track)?;
    if sounds.is_empty() || sounds.len() > MAX_SOUNDS {
        return Err(audio_error(format!("A track has 1 to {MAX_SOUNDS} sounds")));
    }
    for slots in &sounds {
        check_chain(slots, MAX_TRACK_EFFECTS)?;
    }
    if switches.iter().any(|s| s.1 >= sounds.len()) || switches.len() > 4_096 {
        return Err(audio_error("A sound switch refers to a missing sound"));
    }
    let mut inner = state.inner.lock().unwrap();
    inner.track_sounds.insert(track, sounds.clone());
    inner.switches.insert(track, switches);
    let Some(engine) = inner.engine.clone() else {
        return Ok(sounds
            .iter()
            .map(|s| build_chain(&state, 48_000, s, MAX_TRACK_EFFECTS).problems)
            .collect());
    };
    let rate = engine.lock().unwrap().sample_rate() as u32;
    let chains: Vec<Chain> = sounds
        .iter()
        .map(|s| build_chain(&state, rate, s, MAX_TRACK_EFFECTS))
        .collect();
    let problems = chains.iter().map(|c| c.problems.clone()).collect();
    let switches = inner.switches_in_seconds(track);
    let mut old: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
    {
        let mut engine = engine.lock().unwrap();
        for p in engine.set_sound_count(track, chains.len()) {
            old.push(Box::new(p));
        }
        for (sound, chain) in chains.into_iter().enumerate() {
            if let Some(c) = engine.set_sound_chain(track, sound, chain) {
                old.push(Box::new(c));
            }
        }
        engine.set_sound_switches(track, switches);
    }
    drop(old);
    Ok(problems)
}

/// Volume, pan and mute automation of a track (ticks).
#[tauri::command]
pub fn audio_set_automation(
    track: usize,
    automation: AutomationData,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    check_track(track)?;
    automation.validate().map_err(audio_error)?;
    let mut inner = state.inner.lock().unwrap();
    let seconds = Automation::from_ticks(&automation, |t| inner.seconds_at(t));
    inner.automation.insert(track, automation);
    if let Some(engine) = &inner.engine {
        engine.lock().unwrap().set_automation(track, seconds);
    }
    Ok(())
}

/// The channel EQ of a track.
#[tauri::command]
pub fn audio_set_track_eq(
    track: usize,
    eq: TrackEq,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    check_track(track)?;
    eq.validate().map_err(audio_error)?;
    let mut inner = state.inner.lock().unwrap();
    if let Some(engine) = &inner.engine {
        engine.lock().unwrap().set_track_eq(track, &eq);
    }
    inner.eqs.insert(track, eq);
    Ok(())
}

/// Splits a drum track into elements with their own mix (or joins it back
/// with `null`).
#[tauri::command(async)]
pub fn audio_set_drum_mix(
    track: usize,
    drums: Option<DrumMixData>,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    check_track(track)?;
    if drums
        .as_ref()
        .is_some_and(|d| d.elements.len() > MAX_DRUM_ELEMENTS)
    {
        return Err(audio_error(format!(
            "A drum kit has at most {MAX_DRUM_ELEMENTS} elements"
        )));
    }
    let mut inner = state.inner.lock().unwrap();
    match &drums {
        Some(d) => inner.drums.insert(track, d.clone()),
        None => inner.drums.remove(&track),
    };
    let Some(engine) = inner.engine.clone() else {
        return Ok(());
    };
    let (exists, synths) = {
        let e = engine.lock().unwrap();
        let groups = drums.as_ref().map(DrumMixData::groups);
        (
            groups.as_ref().is_some_and(|g| e.has_drum_split(track, g)),
            e.synth_source(),
        )
    };
    let split = match (&drums, exists) {
        (Some(d), false) => Some(synths.drum_split(&d.groups()).map_err(audio_error)?),
        _ => None,
    };
    let old = {
        let mut e = engine.lock().unwrap();
        let old = match (&drums, exists) {
            (None, _) => e.set_drum_split(track, None),
            (Some(_), false) => e.set_drum_split(track, split),
            (Some(_), true) => None,
        };
        if let Some(d) = &drums {
            e.set_drum_mix(track, &d.mixes(), d.stereo);
        }
        old
    };
    drop(old);
    Ok(())
}

fn read_backing_source(source: &BackingSource) -> Result<(String, Vec<u8>), CommandError> {
    match source {
        BackingSource::File { path } => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| audio_error("The audio file has no name"))?;
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .unwrap_or_default();
            if !backing::AUDIO_EXTENSIONS.contains(&ext.as_str()) {
                return Err(CommandError::new(
                    ErrorKind::UnsupportedType,
                    format!("“{name}” is not an mp3, wav, flac, ogg or aiff file."),
                ));
            }
            let size = std::fs::metadata(path)
                .map_err(|e| audio_error(format!("“{name}” cannot be opened: {e}")))?
                .len();
            if size as usize > backing::MAX_FILE_BYTES {
                return Err(CommandError::new(
                    ErrorKind::TooLarge,
                    format!("“{name}” is too large."),
                ));
            }
            let bytes = std::fs::read(path)
                .map_err(|e| audio_error(format!("“{name}” cannot be opened: {e}")))?;
            Ok((name, bytes))
        }
        BackingSource::Embedded { score_path, name } => {
            let bytes = crate::project::read_embedded_audio(score_path, name)?;
            Ok((name.clone(), bytes))
        }
    }
}

/// Opens a recording as the audio track (replacing any previous one).
#[tauri::command(async)]
pub fn audio_load_backing(
    source: BackingSource,
    state: State<'_, AudioState>,
) -> Result<BackingInfo, CommandError> {
    let (name, bytes) = read_backing_source(&source)?;
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let audio = Arc::new(backing::decode(bytes.clone(), ext.as_deref()).map_err(audio_error)?);
    let info = BackingInfo {
        name: name.clone(),
        duration_ms: audio.duration() * 1000.0,
        sample_rate: audio.rate,
        channels: audio.channels,
        peaks: audio.peaks(),
        peaks_per_second: PEAKS_PER_SECOND,
    };
    let mut inner = state.inner.lock().unwrap();
    let (params, sync) = inner
        .backing
        .take()
        .map(|b| (b.params, b.sync))
        .unwrap_or_default();
    inner.backing = Some(LoadedBacking {
        name,
        bytes: Arc::new(bytes),
        audio: audio.clone(),
        params: params.clone(),
        sync: sync.clone(),
    });
    if let Some(engine) = inner.engine.clone() {
        let rate = engine.lock().unwrap().sample_rate();
        let mut backing = Backing::new(audio, rate, BLOCK);
        backing.set(params, inner.sync_map(&sync));
        let old = engine.lock().unwrap().set_backing(Some(backing));
        drop(old);
    }
    Ok(info)
}

/// Settings and sync points of the audio track.
#[tauri::command]
pub fn audio_set_backing(
    params: BackingParams,
    sync: Vec<SyncPointData>,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    params.validate().map_err(audio_error)?;
    if sync.len() > 10_000 || sync.iter().any(|p| !p.ms.is_finite() || p.ms < 0.0) {
        return Err(audio_error("Invalid sync points"));
    }
    let mut inner = state.inner.lock().unwrap();
    let map = inner.sync_map(&sync);
    let Some(loaded) = inner.backing.as_mut() else {
        return Err(audio_error("No audio track is loaded"));
    };
    loaded.params = params.clone();
    loaded.sync = sync;
    if let Some(engine) = &inner.engine
        && let Some(backing) = engine.lock().unwrap().backing_mut()
    {
        backing.set(params, map);
    }
    Ok(())
}

/// Removes the audio track.
#[tauri::command]
pub fn audio_clear_backing(state: State<'_, AudioState>) {
    let mut inner = state.inner.lock().unwrap();
    inner.backing = None;
    if let Some(engine) = &inner.engine {
        let old = engine.lock().unwrap().set_backing(None);
        drop(old);
    }
}

#[tauri::command]
pub fn audio_state(state: State<'_, AudioState>) -> Result<EngineStatus, CommandError> {
    status(&state.inner.lock().unwrap())
}

#[tauri::command]
pub fn library_list(state: State<'_, AudioState>) -> Vec<LibraryItem> {
    state.library.list()
}

#[tauri::command(async)]
pub fn library_import(
    path: PathBuf,
    kind: AssetKind,
    state: State<'_, AudioState>,
) -> Result<LibraryItem, CommandError> {
    state.library.import(&path, kind).map_err(audio_error)
}

#[tauri::command]
pub fn library_update(
    id: String,
    name: String,
    tags: Vec<String>,
    state: State<'_, AudioState>,
) -> Result<LibraryItem, CommandError> {
    state.library.update(&id, name, tags).map_err(audio_error)
}

#[tauri::command]
pub fn library_remove(id: String, state: State<'_, AudioState>) -> Result<(), CommandError> {
    state.library.remove(&id).map_err(audio_error)
}

/// Largest offline render (frames): an hour at 48 kHz.
const MAX_RENDER_FRAMES: usize = 48_000 * 3_600;

/// Renders the loaded song with the current mix and effect chains, offline,
/// for the audio export. Returns interleaved stereo 32-bit floats (raw bytes).
#[tauri::command(async)]
pub fn audio_render(
    sample_rate: u32,
    state: State<'_, AudioState>,
) -> Result<tauri::ipc::Response, CommandError> {
    if !(8_000..=192_000).contains(&sample_rate) {
        return Err(audio_error("Unsupported sample rate"));
    }
    let inner = state.inner.lock().unwrap();
    let font = inner
        .sound_font_id
        .as_ref()
        .and_then(|id| inner.sound_fonts.get(id))
        .or_else(|| inner.sound_fonts.values().next())
        .cloned()
        .ok_or_else(|| audio_error("The instrument sounds are not loaded"))?;
    let song = inner
        .song
        .clone()
        .ok_or_else(|| audio_error("No song is loaded"))?;
    let mut engine = Engine::new(font, sample_rate as f32);
    engine.load(song).map_err(audio_error)?;
    let synths = engine.synth_source();
    let prepared = prepare(&state, &inner, sample_rate, &synths, None);
    drop(install(&mut engine, &inner, prepared));
    drop(inner);
    Ok(tauri::ipc::Response::new(render_offline(
        &mut engine,
        MAX_RENDER_FRAMES,
    )))
}

/// Plays `engine` from the start to the end of the song (with its release
/// tail) and returns interleaved stereo little-endian f32 bytes.
pub fn render_offline(engine: &mut Engine, max_frames: usize) -> Vec<u8> {
    engine.seek(0.0);
    engine.play();
    let mut out = Vec::new();
    let (mut l, mut r) = (vec![0.0f32; 4_096], vec![0.0f32; 4_096]);
    let mut frames = 0;
    while engine.is_playing() && frames < max_frames {
        engine.render(&mut l, &mut r);
        for (a, b) in l.iter().zip(&r) {
            out.extend_from_slice(&a.to_le_bytes());
            out.extend_from_slice(&b.to_le_bytes());
        }
        frames += l.len();
    }
    out
}
