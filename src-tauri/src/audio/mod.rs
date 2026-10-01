//! Native audio engine (ADR 0002): plays the score's MIDI with per-track
//! synthesizers and effect chains, and the user's sound library.
//!
//! The UI keeps alphaTab for notation and timing; when the native engine is
//! switched on, alphaTab follows this engine's clock (external media mode).

pub mod chain;
pub mod dsp;
pub mod engine;
pub mod library;
pub mod output;
pub mod sf3;
pub mod song;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use rustysynth::SoundFont;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CommandError, ErrorKind};
use chain::{BlockProblem, Chain, EffectSlot, MAX_MASTER_EFFECTS, MAX_TRACK_EFFECTS};
use engine::{BLOCK, BusMix, Engine, Meters};
use library::{AssetKind, Library, LibraryItem};
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

#[derive(Default)]
struct Inner {
    sound_fonts: HashMap<String, Arc<SoundFont>>,
    engine: Option<Arc<Mutex<Engine>>>,
    output: Option<Output>,
    sound_font_id: Option<String>,
    song: Option<Arc<Song>>,
    mixes: Vec<BusMix>,
    track_chains: HashMap<usize, Vec<EffectSlot>>,
    master_chain: Vec<EffectSlot>,
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
        apply_mix_and_chains(&state, &inner)?;
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

fn apply_mix_and_chains(state: &AudioState, inner: &Inner) -> Result<(), CommandError> {
    let Some(engine) = &inner.engine else {
        return Ok(());
    };
    let rate = engine.lock().unwrap().sample_rate() as u32;
    let master = build_chain(state, rate, &inner.master_chain, MAX_MASTER_EFFECTS);
    let tracks: Vec<(usize, Chain)> = inner
        .track_chains
        .iter()
        .map(|(&track, slots)| (track, build_chain(state, rate, slots, MAX_TRACK_EFFECTS)))
        .collect();
    let mut old = Vec::new();
    {
        let mut engine = engine.lock().unwrap();
        for (track, mix) in inner.mixes.iter().enumerate() {
            engine.set_mix(track, *mix);
        }
        old.extend(engine.set_master_chain(master));
        for (track, chain) in tracks {
            old.extend(engine.set_track_chain(track, chain));
        }
    }
    drop(old);
    Ok(())
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
    // Chains belong to a song: the UI sends them again after loading one.
    inner.track_chains.clear();
    inner.master_chain.clear();
    if inner.engine.is_some() {
        with_engine(&inner, |engine| engine.load(song))?.map_err(audio_error)?;
        apply_mix_and_chains(&state, &inner)?;
    }
    Ok(())
}

#[tauri::command]
pub fn audio_transport(
    command: Transport,
    state: State<'_, AudioState>,
) -> Result<(), CommandError> {
    let inner = state.inner.lock().unwrap();
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

/// Sets the effect chain of a track (or of the master bus, `track: null`).
/// Returns the blocks that cannot run (missing assets and so on).
#[tauri::command(async)]
pub fn audio_set_chain(
    track: Option<usize>,
    slots: Vec<EffectSlot>,
    state: State<'_, AudioState>,
) -> Result<Vec<BlockProblem>, CommandError> {
    let limit = if track.is_some() {
        MAX_TRACK_EFFECTS
    } else {
        MAX_MASTER_EFFECTS
    };
    if slots.len() > limit {
        return Err(audio_error(format!(
            "A chain holds at most {limit} effects"
        )));
    }
    if track.is_some_and(|t| t >= song::MAX_TRACKS) {
        return Err(audio_error("No such track"));
    }
    let mut inner = state.inner.lock().unwrap();
    match track {
        Some(t) => {
            inner.track_chains.insert(t, slots.clone());
        }
        None => inner.master_chain = slots.clone(),
    }
    let Some(engine) = inner.engine.clone() else {
        // Not running: check the blocks at the usual rate so the UI can warn.
        return Ok(build_chain(&state, 48_000, &slots, limit).problems);
    };
    let rate = engine.lock().unwrap().sample_rate() as u32;
    let chain = build_chain(&state, rate, &slots, limit);
    let problems = chain.problems.clone();
    let old = {
        let mut engine = engine.lock().unwrap();
        match track {
            Some(t) => engine.set_track_chain(t, chain),
            None => engine.set_master_chain(chain),
        }
    };
    drop(old);
    Ok(problems)
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
    for (track, mix) in inner.mixes.iter().enumerate() {
        engine.set_mix(track, *mix);
    }
    let master = build_chain(&state, sample_rate, &inner.master_chain, MAX_MASTER_EFFECTS);
    engine.set_master_chain(master);
    for (&track, slots) in &inner.track_chains {
        engine.set_track_chain(
            track,
            build_chain(&state, sample_rate, slots, MAX_TRACK_EFFECTS),
        );
    }
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
