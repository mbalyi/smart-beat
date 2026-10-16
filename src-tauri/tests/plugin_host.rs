//! Real helper + original CLAP fixture. Runs in CI without installed plugins.
//!
//! Unix only: the fixture is a `.clap` cdylib built by `rustc`, and Windows
//! plugin hosting is not shipped yet (#80 leaves it for later). The wire
//! protocol, the handover rings and the chain integration have their own
//! platform-independent tests.
#![cfg(unix)]

use smart_beat_lib::audio::chain::{Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS, NoAssets};
use smart_beat_lib::audio::plugin::{
    PluginFormat, PluginInstance, PluginPool, PluginSpec, PluginTarget, PluginWorker,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

thread_local! {
    static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) };
    static MAX_ALLOCATION: Cell<Option<usize>> = const { Cell::new(None) };
}
struct CountingAllocator;
fn count_allocation(bytes: usize) {
    let _ = MAX_ALLOCATION.try_with(|n| {
        if let Some(max) = n.get() {
            n.set(Some(max.max(bytes)));
        }
    });
    let _ = ALLOCATIONS.try_with(|n| {
        if let Some(count) = n.get() {
            n.set(Some(count + 1));
        }
    });
}
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count_allocation(size);
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
}
fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        // Reference the ABI dependency so Cargo builds its rlib for this target.
        assert!(size_of::<clap_sys::plugin::clap_plugin>() > 0);
        let deps = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let abi = std::fs::read_dir(&deps)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("libclap_sys-")
                    && p.extension().is_some_and(|e| e == "rlib")
            })
            .max_by_key(|p| p.metadata().unwrap().modified().unwrap())
            .expect("clap-sys rlib is built by Cargo");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Synthetic.clap");
        let output = Command::new("rustc")
            .args([
                "--crate-type",
                "cdylib",
                "--edition=2024",
                "-C",
                "panic=abort",
            ])
            .arg("--extern")
            .arg(format!("clap_sys={}", abi.display()))
            .arg("-L")
            .arg(format!("dependency={}", deps.display()))
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tiny_plugin.rs"))
            .arg("-o")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Fixture { _dir: dir, path }
    })
}
fn spec(gain: f32, mode: u8) -> PluginSpec {
    let mut state = gain.to_le_bytes().to_vec();
    state.push(mode);
    PluginSpec {
        format: PluginFormat::Clap,
        path: fixture().path.to_string_lossy().into_owned(),
        state,
    }
}
fn pool() -> PluginPool {
    let pool =
        PluginPool::default().with_helper(PathBuf::from(env!("CARGO_BIN_EXE_vst3-host-helper")));
    pool.set_enabled(true);
    pool
}
fn address(track: usize, sound: usize, index: usize) -> PluginInstance {
    PluginInstance {
        track: Some(PluginTarget::Track(track)),
        sound,
        index,
    }
}
fn processed(worker: &PluginWorker, input: f32) -> f32 {
    let mut left = [input; 64];
    let mut right = [-input; 64];
    worker.process_offline(&mut left, &mut right).unwrap();
    assert_eq!(right[0], -left[0]);
    left[0]
}
/// Waits until the plugin's gain is `gain`. `queue_state` only queues the
/// preset (it must not block the engine lock), and the worker applies commands
/// in order, so the first `process_offline` that sees the new gain proves the
/// preset landed.
fn settles(worker: &PluginWorker, gain: f32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if (processed(worker, 0.25) - gain * 0.25).abs() < 1e-6 {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("the plugin never reached gain {gain}: {}", worker.error());
}
#[test]
fn identical_plugin_paths_have_independent_audio_presets_and_addresses() {
    let pool = pool().for_offline();
    let a = pool
        .load(Some(address(0, 0, 0)), &spec(0.5, 0), 48_000.0)
        .unwrap();
    let b = pool
        .load(Some(address(1, 0, 0)), &spec(2.0, 0), 48_000.0)
        .unwrap();
    let c = pool
        .load(Some(address(0, 0, 1)), &spec(3.0, 0), 48_000.0)
        .unwrap();
    let d = pool
        .load(Some(address(0, 1, 0)), &spec(4.0, 0), 48_000.0)
        .unwrap();
    assert!(!Arc::ptr_eq(&a, &b));
    assert!(!Arc::ptr_eq(&a, &c));
    assert_eq!(processed(&a, 0.25), 0.125);
    assert_eq!(processed(&b, 0.25), 0.5);
    assert_eq!(processed(&c, 0.25), 0.75);
    assert_eq!(processed(&d, 0.25), 1.0);
    a.queue_state(spec(0.25, 0).state).unwrap();
    settles(&a, 0.25);
    assert_eq!(processed(&b, 0.25), 0.5);
    assert!(Arc::ptr_eq(
        &b,
        &pool.find(address(1, 0, 0), &spec(2.0, 0)).unwrap()
    ));
    assert_eq!(&a.save_state().unwrap()[..4], &0.25f32.to_le_bytes());
    assert_eq!(a.latency_samples(), 0);
    // An empty state restores the plugin's own default preset.
    a.queue_state(Vec::new()).unwrap();
    settles(&a, 1.0);
}
#[test]
fn disabling_existing_instances_bypasses_them_and_reenabling_restores_them() {
    let pool = pool();
    let worker = pool.load(None, &spec(2.0, 0), 48_000.0).unwrap();
    assert_eq!(processed(&worker, 0.25), 0.5);
    pool.set_enabled(false);
    assert_eq!(processed(&worker, 0.25), 0.25);
    worker.push(&[0.5; 64], &[0.5; 64]);
    let mut seen = 0;
    assert!(!worker.take_into(&mut seen, &mut [0.0; 64], &mut [0.0; 64]));
    pool.set_enabled(true);
    assert_eq!(processed(&worker, 0.25), 0.5);
}
#[test]
fn dropping_the_last_block_releases_its_worker() {
    let pool = pool();
    let worker = pool
        .load(Some(address(0, 0, 0)), &spec(1.0, 3), 48_000.0)
        .unwrap();
    // Give the loader time to enter its slow initialization, then remove
    // the final owner while startup is still pending.
    std::thread::sleep(Duration::from_millis(50));
    let weak = Arc::downgrade(&worker);
    drop(worker);
    let deadline = Instant::now() + Duration::from_millis(250);
    while weak.strong_count() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        weak.upgrade().is_none(),
        "worker retained itself after its final block was removed"
    );
    assert!(pool.find(address(0, 0, 0), &spec(1.0, 3)).is_none());
}
#[test]
fn callbacks_do_not_allocate() {
    let pool = pool();
    let worker = pool.load(None, &spec(2.0, 0), 48_000.0).unwrap();
    // The engine never hands over more than one block (`BLOCK` frames, 64 at
    // 48 kHz), which is what a handover slot holds.
    let samples = [0.25; 65];
    let mut left = [0.0; 64];
    let mut right = [0.0; 64];
    ALLOCATIONS.with(|n| n.set(Some(0)));
    for frames in [1, 32, 64, 65, 64] {
        let mut seen = 0;
        worker.push(&samples[..frames], &samples[..frames]);
        worker.take_into(&mut seen, &mut left, &mut right);
    }
    let count = ALLOCATIONS.with(|n| n.replace(None).unwrap());
    assert_eq!(
        count, 0,
        "the audio handover allocated on the calling thread"
    );
}
#[test]
fn a_crashing_or_hung_plugin_cannot_block_callbacks_and_recovers() {
    for mode in [1, 2] {
        let pool = pool();
        let worker = pool.load(None, &spec(0.5, mode), 48_000.0).unwrap();
        worker.save_state().unwrap(); // Start the fault only after loading.
        worker.push(&[0.25; 64], &[0.25; 64]);
        std::thread::sleep(Duration::from_millis(30));
        let start = Instant::now();
        for _ in 0..500 {
            worker.push(&[0.25; 64], &[0.25; 64]);
            let mut seen = 0;
            worker.take_into(&mut seen, &mut [0.0; 64], &mut [0.0; 64]);
        }
        assert!(start.elapsed() < Duration::from_secs(1));
        worker.queue_state(spec(0.75, 0).state).unwrap();
        settles(&worker, 0.75);
        assert!(
            worker.alive(),
            "mode {mode} recovered but still reports: {}",
            worker.error()
        );
    }
}
#[test]
fn exports_do_not_reuse_live_instances() {
    let live_pool = pool();
    let live = live_pool
        .load(Some(address(0, 0, 0)), &spec(2.0, 0), 48_000.0)
        .unwrap();
    let export_pool = live_pool.for_offline();
    let export = export_pool
        .load(Some(address(0, 0, 0)), &spec(0.5, 0), 44_100.0)
        .unwrap();
    assert!(!Arc::ptr_eq(&live, &export));
    assert_eq!(processed(&live, 0.25), 0.5);
    assert_eq!(processed(&export, 0.25), 0.125);
    live_pool.set_enabled(false);
    assert_eq!(
        processed(&export, 0.25),
        0.125,
        "live toggles must not change an export snapshot"
    );
    live_pool.set_enabled(true);
    // Each instance was activated at the rate its chain asked for.
    let saved = live.save_state().unwrap();
    assert_eq!(
        f64::from_bits(u64::from_le_bytes(saved[9..17].try_into().unwrap())),
        48_000.0
    );
    assert!(Arc::ptr_eq(
        &live,
        &live_pool.find(address(0, 0, 0), &spec(2.0, 0)).unwrap()
    ));
}
#[test]
fn two_blocks_in_one_chain_use_independent_plugin_instances() {
    use base64::Engine;
    let pool = pool().for_offline();
    let slot = |gain| EffectSlot {
        enabled: true,
        effect: EffectConfig::Plugin {
            format: PluginFormat::Clap,
            path: spec(gain, 0).path,
            name: "Gain".into(),
            state: base64::engine::general_purpose::STANDARD.encode(spec(gain, 0).state),
        },
    };
    let mut chain = Chain::build_for(
        &[slot(0.5), slot(3.0)],
        MAX_TRACK_EFFECTS,
        48_000.0,
        64,
        &NoAssets,
        &pool,
        Some((Some(PluginTarget::Track(0)), 0)),
    );
    assert!(chain.problems.is_empty(), "{:?}", chain.problems);
    let mut left = [0.25; 64];
    let mut right = [-0.25; 64];
    chain.process(&mut left, &mut right);
    assert_eq!(left, [0.375; 64]);
    assert_eq!(right, [-0.375; 64]);
    assert_eq!(
        chain.latency_samples(),
        0,
        "offline exports add no handover latency"
    );
}
#[test]
fn a_dropped_input_does_not_wait_for_a_ring_wrap() {
    let pool = pool();
    let worker = pool.load(None, &spec(0.5, 0), 48_000.0).unwrap();
    worker.save_state().unwrap(); // Measure handover after asynchronous startup.
    worker.push(&[1.0; 65], &[1.0; 65]); // Too large: no answer can arrive.
    worker.push(&[2.0; 64], &[2.0; 64]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = 0;
    let mut left = [0.0; 64];
    loop {
        if worker.take_into(&mut seen, &mut left, &mut [0.0; 64]) {
            assert_eq!(seen, 2);
            assert_eq!(left, [1.0; 64]);
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a dropped input stranded block 2"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn rejected_presets_remain_visible_while_audio_keeps_processing() {
    let pool = pool();
    let worker = pool.load(None, &spec(0.5, 0), 48_000.0).unwrap();
    worker.queue_state(f32::NAN.to_le_bytes().to_vec()).unwrap();
    // A synchronous command is a barrier behind the queued preset attempt.
    worker.save_state().unwrap();
    assert!(
        !worker.error().is_empty(),
        "the rejected preset must be reported"
    );
    assert!(worker.state_rejected());
    let error = worker.error();
    worker.push(&[1.0; 64], &[1.0; 64]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = 0;
    let mut left = [0.0; 64];
    while !worker.take_into(&mut seen, &mut left, &mut [0.0; 64]) {
        assert!(Instant::now() < deadline, "audio did not resume");
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(left, [0.5; 64], "the last accepted preset still processes");
    assert!(worker.alive());
    assert_eq!(
        worker.error(),
        error,
        "processing must not hide preset errors"
    );
    worker.queue_state(spec(0.75, 0).state).unwrap();
    worker.save_state().unwrap();
    assert!(
        worker.error().is_empty(),
        "an accepted preset clears the error"
    );
    assert!(!worker.state_rejected());
}

/// The engine renders a device callback in `BLOCK`-sized (64 frame) chunks, so
/// a 512-frame buffer arrives as eight blocks back to back. Every one
/// of them must come back wet: with the previous handover only the first block
/// of each callback was, which chopped the plugin's output audibly (seven of
/// eight blocks played dry, so this test saw about 8 % wet). The floor allows a
/// contended test machine to miss the odd block, nothing more.
#[test]
fn every_block_of_a_render_callback_gets_plugin_output() {
    use base64::Engine;
    const CALLBACKS: usize = 30;
    const BLOCKS: usize = 8;
    let pool = pool();
    let slot = EffectSlot {
        enabled: true,
        effect: EffectConfig::Plugin {
            format: PluginFormat::Clap,
            path: spec(0.5, 0).path,
            name: "Gain".into(),
            state: base64::engine::general_purpose::STANDARD.encode(spec(0.5, 0).state),
        },
    };
    let mut chain = Chain::build_for(
        &[slot],
        MAX_TRACK_EFFECTS,
        48_000.0,
        64,
        &NoAssets,
        &pool,
        Some((Some(PluginTarget::Track(0)), 0)),
    );
    assert!(chain.problems.is_empty(), "{:?}", chain.problems);
    pool.find(address(0, 0, 0), &spec(0.5, 0))
        .unwrap()
        .save_state()
        .unwrap(); // Measure steady state after asynchronous initialization.
    let mut dry_after_warmup = 0;
    let mut wet = 0;
    let mut last_wet = 0.0;
    for callback in 0..CALLBACKS {
        chain.begin_render(BLOCKS * 64);
        for block in 0..BLOCKS {
            // Number each block, so duplicate or reordered output cannot pass
            // merely by having the expected gain on a constant input.
            let input = (callback * BLOCKS + block + 1) as f32;
            let mut left = [input; 64];
            let mut right = [-1.0f32; 64];
            chain.process(&mut left, &mut right);
            if (right[0] + 0.5).abs() < 1e-6 {
                assert!(left[0] > last_wet, "wet blocks must not repeat or reorder");
                assert!(left[0] <= input * 0.5, "output cannot precede its input");
                assert!(left.iter().all(|sample| *sample == left[0]));
                last_wet = left[0];
                wet += 1;
            } else if callback > 0 {
                dry_after_warmup += 1;
            }
        }
        // Give the fixture scheduling headroom on loaded CI hosts. The unit
        // tests assert the queue's sample-age bound without wall-clock timing;
        // this integration test checks IPC preserves every block in a burst.
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(
        wet >= CALLBACKS * BLOCKS * 9 / 10,
        "wet blocks: {wet} of {} ({dry_after_warmup} dry after the first callback)",
        CALLBACKS * BLOCKS
    );
}

#[test]
fn monitor_track_and_master_plugins_do_not_share_presets_or_workers() {
    use smart_beat_lib::audio::plugin::MONITOR_TARGET;
    let pool = pool().for_offline();
    let preset = spec(0.5, 0);
    let monitor = PluginInstance {
        track: MONITOR_TARGET,
        sound: 0,
        index: 0,
    };
    let master = PluginInstance {
        track: None,
        sound: 0,
        index: 0,
    };
    let track = address(0, 0, 0);
    let monitor_worker = pool.load(Some(monitor), &preset, 48_000.0).unwrap();
    let master_worker = pool.load(Some(master), &preset, 48_000.0).unwrap();
    let track_worker = pool.load(Some(track), &preset, 48_000.0).unwrap();
    monitor_worker.queue_state(spec(2.0, 0).state).unwrap();
    let mut left = [0.25; 64];
    let mut right = left;
    monitor_worker
        .process_offline(&mut left, &mut right)
        .unwrap();
    assert_eq!(left, [0.5; 64]);
    for worker in [&master_worker, &track_worker] {
        left.fill(0.25);
        right.fill(0.25);
        worker.process_offline(&mut left, &mut right).unwrap();
        assert_eq!(left, [0.125; 64]);
    }
    assert!(Arc::ptr_eq(
        &monitor_worker,
        &pool.find(monitor, &preset).unwrap()
    ));
    assert!(Arc::ptr_eq(
        &master_worker,
        &pool.find(master, &preset).unwrap()
    ));
    drop(monitor_worker);
    let deadline = Instant::now() + Duration::from_secs(2);
    while pool.find(monitor, &preset).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(pool.find(monitor, &preset).is_none());
    assert!(pool.find(master, &preset).is_some());
    assert!(pool.find(track, &preset).is_some());
}

/// A manual probe against the installed amp, paced like a 256-frame device.
/// Sequence numbers measure host queue age independently of the plugin's DSP.
#[test]
#[ignore = "requires the installed TONE3000 VST3"]
fn installed_vst_keeps_up_with_small_device_callbacks() {
    const FRAMES: usize = 256;
    const BLOCKS: usize = FRAMES / 64;
    const CALLBACKS: usize = 200;
    let path = "/Library/Audio/Plug-Ins/VST3/TONE3000.vst3";
    assert!(std::path::Path::new(path).exists());
    let pool = pool();
    let worker = pool
        .load(
            None,
            &PluginSpec {
                format: PluginFormat::Vst3,
                path: path.into(),
                state: Vec::new(),
            },
            48_000.0,
        )
        .unwrap();
    worker.save_state().unwrap(); // Initialization is asynchronous.
    let mut seen = 0;
    let mut wet = 0;
    let mut worst_age = 0;
    let start = Instant::now();
    for callback in 0..CALLBACKS {
        worker.begin_render(FRAMES);
        for block in 0..BLOCKS {
            let mut left = std::array::from_fn::<_, 64, _>(|sample| {
                let frame = (callback * BLOCKS + block) * 64 + sample;
                0.1 * (std::f32::consts::TAU * 220.0 * frame as f32 / 48_000.0).sin()
            });
            let mut right = left;
            worker.push(&left, &right);
            if worker.take_into(&mut seen, &mut left, &mut right) && callback > 4 {
                wet += 1;
                worst_age = worst_age.max(worker.in_seq() - seen);
                assert!(left.iter().chain(&right).all(|sample| sample.is_finite()));
            }
        }
        let due = start + Duration::from_secs_f64((callback + 1) as f64 * FRAMES as f64 / 48_000.0);
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
    }
    eprintln!(
        "TONE3000: {wet} wet blocks; maximum host age {:.2} ms; plugin DSP {} samples",
        worst_age as f64 * 64.0 / 48.0,
        worker.latency_samples()
    );
    assert!(worker.alive(), "{}", worker.error());
    assert!(
        wet >= (CALLBACKS - 5) * BLOCKS * 9 / 10,
        "only {wet} wet blocks"
    );
    assert!(worst_age <= (BLOCKS + 2) as u64, "unbounded host delay");
}

#[test]
fn offline_processing_failures_are_reported_and_latched_for_unaddressed_workers() {
    for mode in [1, 2] {
        let pool = pool().for_offline();
        let worker = pool.load(None, &spec(0.5, mode), 48_000.0).unwrap();
        let mut left = [0.25; 64];
        let mut right = [-0.25; 64];
        let error = worker.process_offline(&mut left, &mut right).unwrap_err();
        assert!(
            !error.is_empty(),
            "mode {mode} swallowed its processing failure"
        );
        assert_eq!(pool.processing_error(), Some(error.clone()));
        // Later blocks in the same render must retain the original failure;
        // they cannot make an export appear successful after a recovery.
        assert_eq!(worker.process_offline(&mut left, &mut right), Err(error));
        assert_eq!(left, [0.25; 64]);
    }
}

#[test]
fn loading_is_async_and_presets_queued_during_loading_keep_their_order() {
    let slow_spec = spec(0.5, 3);
    let pool = pool().for_offline();
    let started = Instant::now();
    let worker = pool.load(None, &slow_spec, 48_000.0).unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "load waited for the helper's 500ms initialization"
    );
    assert!(worker.loading());
    worker.queue_state(spec(0.75, 0).state).unwrap();
    assert_eq!(processed(&worker, 0.25), 0.1875);
    assert!(!worker.loading());
    assert!(worker.alive());
    assert_eq!(pool.processing_error(), None);
}

#[test]
fn asynchronous_load_failures_reach_worker_and_export_status() {
    let pool = pool().for_offline();
    let worker = pool.load(None, &spec(f32::NAN, 0), 48_000.0).unwrap();
    // A command waits behind loading, then observes that the failed loader
    // disconnected; the actual load error remains available in pool status.
    assert!(worker.save_state().is_err());
    assert!(!worker.alive());
    assert!(!worker.error().is_empty());
    assert!(pool.processing_error().is_some());
    assert!(
        worker
            .process_offline(&mut [0.25; 64], &mut [0.25; 64])
            .is_err()
    );
}

#[test]
fn export_aborts_instead_of_returning_dry_audio_after_plugin_failure() {
    use base64::Engine as _;
    use smart_beat_lib::audio::engine::Engine;
    use smart_beat_lib::audio::song::{Song, SongData};
    let font = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf3"),
    )
    .unwrap();
    let font = Arc::new(smart_beat_lib::audio::parse_sound_font(&font).unwrap());
    for mode in [1, 2] {
        let pool = pool().for_offline();
        let mut engine = Engine::new(font.clone(), 48_000.0);
        let song = Song::from_data(&SongData {
            division: 960,
            events: vec![[0, 0x90, 60, 100], [960, 0x80, 60, 0]],
            tempos: vec![(0, 120.0)],
            metronome: vec![],
            tracks: vec![vec![0]],
            end_tick: 1920,
        })
        .unwrap();
        engine.load(Arc::new(song)).unwrap();
        let spec = spec(0.5, mode);
        let chain = Chain::build(
            &[EffectSlot {
                enabled: true,
                effect: EffectConfig::Plugin {
                    format: spec.format,
                    path: spec.path,
                    name: "Broken export fixture".into(),
                    state: base64::engine::general_purpose::STANDARD.encode(spec.state),
                },
            }],
            MAX_TRACK_EFFECTS,
            48_000.0,
            64,
            &NoAssets,
            &pool,
        );
        assert!(chain.problems.is_empty());
        engine.set_master_chain(chain);
        let error = smart_beat_lib::audio::render_offline(&mut engine, 48_000, &pool).unwrap_err();
        assert!(
            error.contains("export stopped because a plugin failed"),
            "{error}"
        );
    }
}

#[test]
fn status_polling_does_not_allocate_or_decode_large_plugin_presets() {
    use smart_beat_lib::audio::{AudioState, audio_plugin_info, audio_set_chain};
    use tauri::Manager;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(AudioState::new(dir.path().into()))
        .build(mock_context(noop_assets()))
        .unwrap();
    let preset = "A".repeat(3 * 1024 * 1024);
    audio_set_chain(
        None,
        vec![EffectSlot {
            enabled: true,
            effect: EffectConfig::Plugin {
                format: PluginFormat::Vst3,
                path: "/missing/large-state.vst3".into(),
                name: "Large preset".into(),
                state: preset,
            },
        }],
        None,
        app.state(),
    )
    .unwrap();
    MAX_ALLOCATION.with(|n| n.set(Some(0)));
    let info = audio_plugin_info(None, None, app.state()).unwrap();
    let largest = MAX_ALLOCATION.with(|n| n.replace(None).unwrap());
    assert_eq!(info.len(), 1);
    assert!(
        largest < 64 * 1024,
        "status polling allocated {largest} bytes for a stored preset"
    );
}

#[test]
fn an_identical_chain_update_retries_a_rejected_preset() {
    use base64::Engine as _;
    let pool = pool().for_offline();
    let slot = |gain, mode| {
        let spec = spec(gain, mode);
        EffectSlot {
            enabled: true,
            effect: EffectConfig::Plugin {
                format: spec.format,
                path: spec.path,
                name: "Transient preset failure".into(),
                state: base64::engine::general_purpose::STANDARD.encode(spec.state),
            },
        }
    };
    let mut chain = Chain::build_for(
        &[slot(0.5, 0)],
        MAX_TRACK_EFFECTS,
        48_000.0,
        64,
        &NoAssets,
        &pool,
        Some((Some(PluginTarget::Track(0)), 0)),
    );
    assert!(chain.problems.is_empty());
    let worker = pool.find(address(0, 0, 0), &spec(0.5, 0)).unwrap();
    worker.save_state().unwrap(); // Wait for asynchronous loading.
    let requested = vec![slot(0.75, 4)];
    assert!(chain.update(&requested, MAX_TRACK_EFFECTS));
    worker.save_state().unwrap();
    assert!(worker.state_rejected(), "first preset attempt should fail");
    assert_eq!(processed(&worker, 0.25), 0.125);
    assert!(
        chain.update(&requested, MAX_TRACK_EFFECTS),
        "same requested layout retries its rejected preset"
    );
    worker.save_state().unwrap();
    assert!(
        !worker.state_rejected(),
        "the second attempt must reach the helper"
    );
    assert!(worker.error().is_empty());
    assert_eq!(processed(&worker, 0.25), 0.1875);
    assert!(Arc::ptr_eq(
        &worker,
        &pool.find(address(0, 0, 0), &spec(0.75, 4)).unwrap()
    ));
}
