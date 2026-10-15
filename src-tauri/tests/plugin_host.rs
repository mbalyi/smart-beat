//! Real helper + original CLAP fixture. Runs in CI without installed plugins.
use smart_beat_lib::audio::plugin::{PluginFormat, PluginInstance, PluginPool, PluginSpec};
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
        track: Some(track),
        sound,
        index,
    }
}
fn processed(worker: &smart_beat_lib::audio::plugin::PluginWorker, input: f32) -> f32 {
    let mut left = [input; 64];
    let mut right = [-input; 64];
    worker.process_offline(&mut left, &mut right);
    assert_eq!(right[0], -left[0]);
    left[0]
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
    a.apply_state(&spec(0.25, 0).state).unwrap();
    assert_eq!(processed(&a, 0.25), 0.0625);
    assert_eq!(processed(&b, 0.25), 0.5);
    assert!(Arc::ptr_eq(
        &b,
        &pool.find(address(1, 0, 0), &spec(2.0, 0)).unwrap()
    ));
    assert_eq!(&a.save_state().unwrap()[..4], &0.25f32.to_le_bytes());
    assert_eq!(a.latency_samples(), 0);
    a.apply_state(&[]).unwrap();
    assert_eq!(
        processed(&a, 0.25),
        0.25,
        "empty state restores the default preset"
    );
}
#[test]
fn disabling_existing_instances_bypasses_them_and_reenabling_restores_them() {
    let pool = pool();
    let worker = pool.load(None, &spec(2.0, 0), 48_000.0).unwrap();
    assert_eq!(processed(&worker, 0.25), 0.5);
    pool.set_enabled(false);
    assert_eq!(processed(&worker, 0.25), 0.25);
    worker.push(&[0.5; 64], &[0.5; 64]);
    assert_eq!(worker.take_into(0, &mut [0.0; 64], &mut [0.0; 64]), None);
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
fn callbacks_do_not_allocate_even_on_the_first_or_larger_block() {
    let pool = pool();
    let worker = pool.load(None, &spec(2.0, 0), 48_000.0).unwrap();
    let samples = [0.25; 4097];
    let mut left = [0.0; 64];
    let mut right = [0.0; 64];
    ALLOCATIONS.with(|n| n.set(Some(0)));
    for frames in [1, 64, 512, 4096, 4097, 64] {
        worker.push(&samples[..frames], &samples[..frames]);
        worker.take_into(0, &mut left, &mut right);
    }
    let count = ALLOCATIONS.with(|n| n.replace(None).unwrap());
    assert_eq!(count, 0, "audio handover allocated on the calling thread");
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
            worker.take_into(0, &mut [0.0; 64], &mut [0.0; 64]);
        }
        assert!(start.elapsed() < Duration::from_secs(1));
        worker.apply_state(&spec(0.75, 0).state).unwrap();
        assert_eq!(processed(&worker, 0.25), 0.1875);
        worker.ensure_rate(44_100.0).unwrap();
        let state = worker.save_state().unwrap();
        assert_eq!(
            f64::from_bits(u64::from_le_bytes(state[9..17].try_into().unwrap())),
            44_100.0
        );
    }
}

#[test]
fn exports_do_not_reconfigure_or_reuse_live_instances() {
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
    use smart_beat_lib::audio::chain::{
        Chain, EffectConfig, EffectSlot, MAX_TRACK_EFFECTS, NoAssets,
    };
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
        Some((Some(0), 0)),
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
        "offline exports add no handover block"
    );
}
