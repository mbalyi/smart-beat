//! Imported drum kits (#40) end to end: a tiny synthetic SFZ kit (three short
//! generated WAVs, never a real third-party kit) is imported into the kit
//! library, loaded lazily, played by a drum track through the drum mixer and
//! removed again.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use smart_beat_lib::audio::engine::{BLOCK, BusMix, Engine, POLYPHONY};
use smart_beat_lib::audio::kits::{ImportOptions, KitFormat, KitLibrary, LicenceKind, LoadedKit};
use smart_beat_lib::audio::parse_sound_font;
use smart_beat_lib::audio::song::{Song, SongData};

const RATE: f32 = 48_000.0;

fn sonivox() -> Arc<rustysynth::SoundFont> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3");
    let bytes = std::fs::read(path).expect("run `pnpm install` first");
    Arc::new(parse_sound_font(&bytes).expect("SF3 converts"))
}

/// A mono 16-bit WAV of `seconds` of `f(t)`.
fn wav(path: &Path, seconds: f32, f: impl Fn(f32) -> f32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 44_100,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    let frames = (seconds * 44_100.0) as usize;
    for i in 0..frames {
        let t = i as f32 / 44_100.0;
        writer
            .write_sample((f(t).clamp(-1.0, 1.0) * 30_000.0) as i16)
            .unwrap();
    }
    writer.finalize().unwrap();
}

/// A kick, a snare (two velocity layers) and choked hi-hats, CC-BY licensed.
fn synthetic_kit(dir: &Path) -> PathBuf {
    let decay = |t: f32| (-t * 18.0).exp();
    wav(&dir.join("Samples/kick.wav"), 0.4, |t| {
        decay(t) * (std::f32::consts::TAU * 55.0 * t).sin()
    });
    let mut seed = 1u32;
    let mut noise = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 9) as f32 / (1u32 << 23) as f32 * 2.0 - 1.0
    };
    let noise_values: Vec<f32> = (0..44_100).map(|_| noise()).collect();
    let n = |t: f32| noise_values[((t * 44_100.0) as usize).min(44_099)];
    wav(&dir.join("Samples/snare soft.wav"), 0.3, |t| {
        0.4 * decay(t) * n(t)
    });
    wav(&dir.join("Samples/snare hard.wav"), 0.3, |t| {
        0.9 * decay(t) * n(t)
    });
    wav(&dir.join("Samples/hat.wav"), 0.2, |t| {
        0.5 * decay(t * 3.0) * n(t)
    });
    std::fs::write(
        dir.join("LICENSE.txt"),
        "Synthetic test kit\nCreated by the Smart Beat tests\nCreative Commons Attribution 4.0",
    )
    .unwrap();
    let sfz = dir.join("Test Kit.sfz");
    std::fs::write(
        &sfz,
        "<control> default_path=Samples/\n\
         <group> pitch_keytrack=0 amp_veltrack=50\n\
         <region> sample=kick.wav key=36\n\
         <region> sample=snare soft.wav key=38 hivel=80\n\
         <region> sample=snare hard.wav key=38 lovel=81\n\
         <group> group=1 off_by=2\n\
         <region> sample=hat.wav key=46\n\
         <group> group=2\n\
         <region> sample=hat.wav key=42 volume=-6 cutoff=3000\n",
    )
    .unwrap();
    sfz
}

/// Two bars of drums (channel 9): kick, snare and closed hi-hat.
fn drum_song() -> Arc<Song> {
    let q = 960;
    let mut events = Vec::new();
    for beat in 0..8u32 {
        let t = beat * q;
        for key in [if beat % 2 == 0 { 36 } else { 38 }, 42] {
            events.push([t, 0x99, key, 110]);
            events.push([t + 100, 0x89, key, 0]);
        }
    }
    Arc::new(
        Song::from_data(&SongData {
            division: q,
            events,
            tempos: vec![(0, 120.0)],
            metronome: Vec::new(),
            tracks: vec![vec![9]],
            end_tick: 8 * q,
        })
        .unwrap(),
    )
}

fn render(engine: &mut Engine, seconds: f32) -> Vec<f32> {
    let frames = (seconds * RATE) as usize;
    let (mut l, mut r) = (vec![0.0; frames], vec![0.0; frames]);
    engine.render(&mut l, &mut r);
    assert!(l.iter().chain(&r).all(|s| s.is_finite()));
    l
}

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

#[test]
fn imports_an_sfz_kit_with_its_licence_and_plays_it_through_the_drum_mixer() {
    let source = tempfile::tempdir().unwrap();
    let sfz = synthetic_kit(source.path());
    let data = tempfile::tempdir().unwrap();
    let kits = KitLibrary::new(data.path().join("kits"));

    let info = kits.import(&sfz, &ImportOptions::default()).unwrap();
    assert_eq!(info.name, "Test Kit");
    assert_eq!(info.format, KitFormat::Sfz);
    assert_eq!(info.licence.kind, LicenceKind::CcBy);
    assert_eq!(
        info.licence.attribution.as_deref(),
        Some("Created by the Smart Beat tests")
    );
    let pieces: Vec<_> = info.pieces.iter().map(|p| p.element.as_str()).collect();
    assert_eq!(pieces, ["snare", "hihat", "kick"]);
    assert!(info.missing.contains(&"ride".to_string()));
    assert!(info.warnings.iter().any(|w| w.contains("cutoff")));
    // The samples were copied: the kit works without the original folder.
    drop(source);
    assert!(
        data.path()
            .join("kits")
            .join(&info.id)
            .join("samples/Samples/snare soft.wav")
            .exists()
    );

    // Startup reads only the index; the kit is decoded on first use.
    let kits = KitLibrary::new(data.path().join("kits"));
    assert_eq!(kits.list(), vec![info.clone()]);
    let kit = kits.load(&info.id).unwrap();
    assert!(matches!(*kit, LoadedKit::Sfz(_)));
    assert!(Arc::ptr_eq(&kit, &kits.load(&info.id).unwrap()), "cached");

    // A drum track plays the kit, split into drum mixer pieces.
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(drum_song()).unwrap();
    let source = engine.synth_source().with_kit(Some(kit.clone()));
    let groups = vec![vec![38u8], vec![42, 46], vec![36]];
    let split = source.drum_split(&groups).unwrap();
    let instrument = source.instrument(POLYPHONY).unwrap();
    engine.set_drum_split(0, Some(engine.synth_source().drum_split(&groups).unwrap()));
    assert!(
        engine
            .set_track_kit(0, Some(kit.clone()), instrument, Some(split))
            .is_some()
    );
    let solo = BusMix {
        solo: true,
        ..BusMix::default()
    };
    engine.set_drum_mix(
        0,
        &[
            solo,
            BusMix::default(),
            BusMix::default(),
            BusMix::default(),
        ],
        true,
    );
    engine.play();
    let snare_only = render(&mut engine, 1.0);
    let meters = engine.take_meters();
    assert!(rms(&snare_only) > 0.005, "the kit's snare sounds");
    assert!(meters.drums[0][0] > 0.0, "the snare's meter moves");
    assert_eq!(meters.drums[0][2], 0.0, "the kick piece is not soloed");

    engine.set_drum_mix(0, &[BusMix::default(); 4], true);
    engine.seek(0.0);
    engine.play();
    let all = render(&mut engine, 1.0);
    assert!(rms(&all) > rms(&snare_only));

    kits.remove(&info.id).unwrap();
    assert!(kits.list().is_empty());
    assert!(!data.path().join("kits").join(&info.id).exists());
    assert!(kits.load(&info.id).is_err());
}

#[test]
fn refuses_non_commercial_kits_and_asks_about_unknown_licences() {
    let source = tempfile::tempdir().unwrap();
    let sfz = synthetic_kit(source.path());
    let kits = KitLibrary::new(tempfile::tempdir().unwrap().path().join("kits"));

    std::fs::write(
        source.path().join("LICENSE.txt"),
        "Creative Commons Attribution-NonCommercial 4.0 (CC BY-NC 4.0)",
    )
    .unwrap();
    let error = kits.import(&sfz, &ImportOptions::default()).unwrap_err();
    assert!(error.contains("non-commercial"), "{error}");
    // Picking another licence does not get round it.
    let picked = ImportOptions {
        licence: Some("cc0".into()),
        ..Default::default()
    };
    assert!(kits.import(&sfz, &picked).is_err());

    std::fs::remove_file(source.path().join("LICENSE.txt")).unwrap();
    assert!(
        kits.import(&sfz, &ImportOptions::default())
            .unwrap_err()
            .contains("confirm")
    );
    let confirmed = ImportOptions {
        accept_unknown: true,
        name: Some("My kit".into()),
        ..Default::default()
    };
    let info = kits.import(&sfz, &confirmed).unwrap();
    assert_eq!(
        (info.name.as_str(), info.licence.kind),
        ("My kit", LicenceKind::Unknown)
    );
    // Two kits with the same name get their own folders.
    let again = kits.import(&sfz, &confirmed).unwrap();
    assert_ne!(info.id, again.id);
}

#[test]
fn imports_a_soundfont_kit_and_reports_broken_ones() {
    let dir = tempfile::tempdir().unwrap();
    let font = dir.path().join("Sonivox Drums.sf3");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3"),
        &font,
    )
    .unwrap();
    std::fs::write(dir.path().join("README.md"), "Released under CC0 1.0").unwrap();
    let kits = KitLibrary::new(dir.path().join("kits"));
    let info = kits.import(&font, &ImportOptions::default()).unwrap();
    assert_eq!(
        (info.format, info.licence.kind),
        (KitFormat::Sf3, LicenceKind::Cc0)
    );
    assert!(
        info.pieces.len() >= 10,
        "a General MIDI kit has most pieces"
    );
    assert!(matches!(
        *kits.load(&info.id).unwrap(),
        LoadedKit::SoundFont(_)
    ));

    let broken = dir.path().join("broken.sf2");
    std::fs::write(&broken, b"RIFF....not a soundfont").unwrap();
    assert!(kits.import(&broken, &ImportOptions::default()).is_err());
    let missing = dir.path().join("missing-sample.sfz");
    std::fs::write(&missing, "<region> sample=nowhere.wav key=36").unwrap();
    let error = kits
        .import(&missing, &ImportOptions::default())
        .unwrap_err();
    assert!(error.contains("missing"), "{error}");
    assert!(
        kits.import(&dir.path().join("x.wav"), &ImportOptions::default())
            .is_err()
    );
    assert_eq!(kits.list().len(), 1, "failed imports leave nothing behind");
    let entries = std::fs::read_dir(dir.path().join("kits")).unwrap().count();
    assert_eq!(entries, 2, "the index and the one kit folder");
}

#[test]
fn renders_fast_enough_for_real_time() {
    let source = tempfile::tempdir().unwrap();
    let sfz = synthetic_kit(source.path());
    let kits = KitLibrary::new(source.path().join("kits"));
    let info = kits.import(&sfz, &ImportOptions::default()).unwrap();
    let kit = kits.load(&info.id).unwrap();
    let mut engine = Engine::new(sonivox(), RATE);
    engine.load(drum_song()).unwrap();
    let instrument = engine
        .synth_source()
        .with_kit(Some(kit.clone()))
        .instrument(POLYPHONY)
        .unwrap();
    engine.set_track_kit(0, Some(kit), instrument, None);
    engine.play();
    let start = std::time::Instant::now();
    let blocks = (4.0 * RATE) as usize / BLOCK;
    let (mut l, mut r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
    for _ in 0..blocks {
        engine.render(&mut l, &mut r);
    }
    assert!(
        start.elapsed().as_secs_f32() < 2.0,
        "{:?} for 4 s of audio",
        start.elapsed()
    );
}
