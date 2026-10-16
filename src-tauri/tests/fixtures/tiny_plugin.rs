//! Original synthetic CLAP gain plugin. No GUI, samples, or third-party plugin code.
//! State: f32 gain, u8 failure mode, u32 PID, f64 sample rate. Mode 1 crashes;
//! mode 2 hangs; mode 3 delays state loading. These exercise process isolation.
#![allow(unsafe_op_in_unsafe_fn)]
use clap_sys::{
    entry::*,
    ext::{audio_ports::*, latency::*, state::*},
    factory::plugin_factory::*,
    host::*,
    plugin::*,
    process::*,
    stream::*,
    version::CLAP_VERSION,
};
use std::ffi::{CStr, c_char, c_void};
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};

static DESCRIPTOR: clap_plugin_descriptor = clap_plugin_descriptor {
    clap_version: CLAP_VERSION,
    id: c"smart-beat.synthetic-gain".as_ptr(),
    name: c"Synthetic gain".as_ptr(),
    vendor: c"Smart Beat".as_ptr(),
    url: c"".as_ptr(),
    manual_url: c"".as_ptr(),
    support_url: c"".as_ptr(),
    version: c"1.0".as_ptr(),
    description: c"Original host regression fixture".as_ptr(),
    features: std::ptr::null(),
};
struct Data {
    gain: AtomicU32,
    mode: AtomicU8,
    rate: AtomicU64,
    rejected_once: AtomicU8,
}
unsafe fn data<'a>(p: *const clap_plugin) -> &'a Data {
    &*((*p).plugin_data as *const Data)
}
unsafe extern "C" fn init(_: *const clap_plugin) -> bool {
    true
}
unsafe extern "C" fn destroy(p: *const clap_plugin) {
    drop(Box::from_raw((*p).plugin_data as *mut Data));
    drop(Box::from_raw(p.cast_mut()));
}
unsafe extern "C" fn activate(p: *const clap_plugin, rate: f64, _: u32, _: u32) -> bool {
    data(p).rate.store(rate.to_bits(), Ordering::Relaxed);
    true
}
unsafe extern "C" fn noop(_: *const clap_plugin) {}
unsafe extern "C" fn process(
    p: *const clap_plugin,
    block: *const clap_process,
) -> clap_process_status {
    match data(p).mode.load(Ordering::Relaxed) {
        1 => std::process::abort(),
        2 => std::thread::sleep(std::time::Duration::from_secs(10)),
        _ => {}
    }
    let block = &*block;
    if block.audio_inputs_count != 1 || block.audio_outputs_count != 1 {
        return CLAP_PROCESS_ERROR;
    }
    let input = &*block.audio_inputs;
    let output = &mut *block.audio_outputs;
    let gain = f32::from_bits(data(p).gain.load(Ordering::Relaxed));
    for channel in 0..2 {
        let src =
            std::slice::from_raw_parts(*input.data32.add(channel), block.frames_count as usize);
        let dst = std::slice::from_raw_parts_mut(
            *output.data32.add(channel),
            block.frames_count as usize,
        );
        for (dst, src) in dst.iter_mut().zip(src) {
            *dst = *src * gain;
        }
    }
    CLAP_PROCESS_CONTINUE
}
unsafe extern "C" fn count(_: *const clap_plugin, _: bool) -> u32 {
    1
}
unsafe extern "C" fn port(
    _: *const clap_plugin,
    index: u32,
    _: bool,
    info: *mut clap_audio_port_info,
) -> bool {
    if index != 0 {
        return false;
    }
    *info = clap_audio_port_info {
        id: 0,
        name: [0; 256],
        flags: CLAP_AUDIO_PORT_IS_MAIN,
        channel_count: 2,
        port_type: CLAP_PORT_STEREO.as_ptr(),
        in_place_pair: 0,
    };
    true
}
unsafe extern "C" fn latency(_: *const clap_plugin) -> u32 {
    0
}
unsafe extern "C" fn save(p: *const clap_plugin, stream: *const clap_ostream) -> bool {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&data(p).gain.load(Ordering::Relaxed).to_le_bytes());
    bytes.push(data(p).mode.load(Ordering::Relaxed));
    bytes.extend_from_slice(&std::process::id().to_le_bytes());
    bytes.extend_from_slice(&data(p).rate.load(Ordering::Relaxed).to_le_bytes());
    let mut written = 0;
    while written < bytes.len() {
        let count = ((*stream).write.unwrap())(
            stream,
            bytes[written..].as_ptr().cast(),
            (bytes.len() - written) as u64,
        );
        if count <= 0 {
            return false;
        }
        written += count as usize;
    }
    true
}
unsafe extern "C" fn load(p: *const clap_plugin, stream: *const clap_istream) -> bool {
    let mut bytes = [0u8; 5];
    let mut read = 0;
    while read < bytes.len() {
        let count = ((*stream).read.unwrap())(
            stream,
            bytes[read..].as_mut_ptr().cast(),
            (bytes.len() - read) as u64,
        );
        if count < 0 {
            return false;
        }
        if count == 0 {
            break;
        }
        read += count as usize;
    }
    if read < 4 {
        return false;
    }
    let gain = f32::from_le_bytes(bytes[..4].try_into().unwrap());
    if !gain.is_finite() {
        return false;
    }
    if bytes[4] == 4 && data(p).rejected_once.swap(1, Ordering::Relaxed) == 0 {
        return false;
    }
    if bytes[4] == 3 {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    data(p).gain.store(gain.to_bits(), Ordering::Relaxed);
    data(p).mode.store(bytes[4], Ordering::Relaxed);
    true
}
static PORTS: clap_plugin_audio_ports = clap_plugin_audio_ports {
    count: Some(count),
    get: Some(port),
};
static STATE: clap_plugin_state = clap_plugin_state {
    save: Some(save),
    load: Some(load),
};
static LATENCY: clap_plugin_latency = clap_plugin_latency { get: Some(latency) };
unsafe extern "C" fn extension(_: *const clap_plugin, id: *const c_char) -> *const c_void {
    let id = CStr::from_ptr(id);
    if id == CLAP_EXT_AUDIO_PORTS {
        (&PORTS as *const clap_plugin_audio_ports).cast()
    } else if id == CLAP_EXT_STATE {
        (&STATE as *const clap_plugin_state).cast()
    } else if id == CLAP_EXT_LATENCY {
        (&LATENCY as *const clap_plugin_latency).cast()
    } else {
        std::ptr::null()
    }
}
unsafe extern "C" fn plugin_count(_: *const clap_plugin_factory) -> u32 {
    1
}
unsafe extern "C" fn descriptor(
    _: *const clap_plugin_factory,
    index: u32,
) -> *const clap_plugin_descriptor {
    if index == 0 {
        &DESCRIPTOR
    } else {
        std::ptr::null()
    }
}
unsafe extern "C" fn create(
    _: *const clap_plugin_factory,
    _: *const clap_host,
    id: *const c_char,
) -> *const clap_plugin {
    if CStr::from_ptr(id) != CStr::from_ptr(DESCRIPTOR.id) {
        return std::ptr::null();
    }
    let state = Box::into_raw(Box::new(Data {
        gain: AtomicU32::new(1.0f32.to_bits()),
        mode: AtomicU8::new(0),
        rate: AtomicU64::new(0),
        rejected_once: AtomicU8::new(0),
    }));
    Box::into_raw(Box::new(clap_plugin {
        desc: &DESCRIPTOR,
        plugin_data: state.cast(),
        init: Some(init),
        destroy: Some(destroy),
        activate: Some(activate),
        deactivate: Some(noop),
        start_processing: Some(init),
        stop_processing: Some(noop),
        reset: Some(noop),
        process: Some(process),
        get_extension: Some(extension),
        on_main_thread: Some(noop),
    }))
}
static FACTORY: clap_plugin_factory = clap_plugin_factory {
    get_plugin_count: Some(plugin_count),
    get_plugin_descriptor: Some(descriptor),
    create_plugin: Some(create),
};
unsafe extern "C" fn entry_init(_: *const c_char) -> bool {
    true
}
unsafe extern "C" fn entry_deinit() {}
unsafe extern "C" fn factory(id: *const c_char) -> *const c_void {
    if CStr::from_ptr(id) == CLAP_PLUGIN_FACTORY_ID {
        (&FACTORY as *const clap_plugin_factory).cast()
    } else {
        std::ptr::null()
    }
}
#[unsafe(no_mangle)]
pub static clap_entry: clap_plugin_entry = clap_plugin_entry {
    clap_version: CLAP_VERSION,
    init: Some(entry_init),
    deinit: Some(entry_deinit),
    get_factory: Some(factory),
};
