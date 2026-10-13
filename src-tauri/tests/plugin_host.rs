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

thread_local! { static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) }; }
struct CountingAllocator;
fn count_allocation() {
    let _ = ALLOCATIONS.try_with(|n| {
        if let Some(count) = n.get() {
            n.set(Some(count + 1));
        }
    });
}
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count_allocation();
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
    worker.process_offline(&mut left, &mut right);
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
        .load(Some(address(0, 0, 0)), &spec(1.0, 0), 48_000.0)
        .unwrap();
    let weak = Arc::downgrade(&worker);
    drop(worker);
    let deadline = Instant::now() + Duration::from_secs(2);
    while weak.strong_count() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        weak.upgrade().is_none(),
        "worker retained itself after its final block was removed"
    );
    assert!(pool.find(address(0, 0, 0), &spec(1.0, 0)).is_none());
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
}

/// The engine renders a device callback in `BLOCK`-sized (64 frame) chunks, so
/// the default 512-frame buffer arrives as eight blocks back to back. Every one
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
    let mut dry_after_warmup = 0;
    let mut wet = 0;
    let mut last_wet = 0.0;
    for callback in 0..CALLBACKS {
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
        // One render callback's worth of wall time for the helper to keep up.
        std::thread::sleep(Duration::from_millis(10));
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
    monitor_worker.process_offline(&mut left, &mut right);
    assert_eq!(left, [0.5; 64]);
    for worker in [&master_worker, &track_worker] {
        left.fill(0.25);
        right.fill(0.25);
        worker.process_offline(&mut left, &mut right);
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
