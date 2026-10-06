//! Synthetic assets shared by the integration tests. Nothing here is a real
//! amp capture or a recorded cabinet: they are made up for the tests.
#![allow(dead_code)]

/// A tiny but valid Neural Amp Modeler file: one WaveNet layer with eight
/// weights and no memory, so its output follows its input sample by sample.
pub fn tiny_nam(sample_rate: Option<f64>, loudness: Option<f32>, name: &str) -> String {
    let rate = sample_rate.map_or(String::new(), |r| format!(r#""sample_rate": {r},"#));
    let metadata = loudness.map_or(String::new(), |l| {
        format!(r#""metadata": {{ "name": "{name}", "loudness": {l} }},"#)
    });
    format!(
        r#"{{
            "version": "0.5.4", "architecture": "WaveNet",
            {rate} {metadata}
            "config": {{ "layers": [{{
                "input_size": 1, "condition_size": 1, "channels": 1, "head_size": 1,
                "kernel_size": 1, "dilations": [1], "activation": "ReLU",
                "gated": false, "head_bias": false
            }}], "head": null, "head_scale": 10.0 }},
            "weights": [1.0, 2.0, 0.5, 1.0, 3.0, 0.1, 0.5, 10.0]
        }}"#
    )
}

/// A mono 24-bit WAV that rings like a short, dark cabinet impulse response.
pub fn tiny_ir(sample_rate: u32, samples: usize) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut out, spec).unwrap();
    for i in 0..samples {
        let decay = (-(i as f32) / (samples as f32 / 6.0)).exp();
        let value = if i == 0 {
            1.0
        } else {
            0.4 * decay * (i as f32 * 0.7).sin()
        };
        writer.write_sample((value * 8_000_000.0) as i32).unwrap();
    }
    writer.finalize().unwrap();
    out.into_inner()
}
