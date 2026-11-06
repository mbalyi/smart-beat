"""Open-Unmix UMX-HQ inference for the stem separation spike (issue #186).

Measurement tooling only: it reads the four UMX-HQ weight files (Zenodo record 3370489, not part of
this repository and never shipped) and writes drums/bass/vocals/other as float32 WAV. Run it in a
container without network access; see docs/stem-separation-spike.md.

    python umx_run.py --weights /w --in /in/silly/mix.wav --out /out/silly

Deviations from the reference implementation (sigsep/open-unmix-pytorch):
  * The model is re-written here (the package is not installed in the container).
  * The final step is a soft power-ratio mask from the four magnitude estimates, not the iterative
    Wiener filter (norbert) the reference uses. It is slightly worse than the reference.
"""

import argparse
import os
import time

import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
import torch.nn.functional as F

N_FFT, HOP = 4096, 1024
TARGETS = {
    "vocals": "vocals-b62c91ce.pth",
    "drums": "drums-9619578f.pth",
    "bass": "bass-8d85a5bd.pth",
    "other": "other-b52fbbf7.pth",
}


class Umx(nn.Module):
    def __init__(self, state):
        super().__init__()
        self.nb_bins = state["input_mean"].shape[0]  # 1487: bandwidth limited to 16 kHz
        self.nb_out = state["output_mean"].shape[0]  # 2049
        hidden = state["fc1.weight"].shape[0]
        self.fc1 = nn.Linear(2 * self.nb_bins, hidden, bias=False)
        self.bn1 = nn.BatchNorm1d(hidden)
        self.lstm = nn.LSTM(hidden, hidden // 2, num_layers=3, bidirectional=True)
        self.fc2 = nn.Linear(hidden * 2, hidden, bias=False)
        self.bn2 = nn.BatchNorm1d(hidden)
        self.fc3 = nn.Linear(hidden, 2 * self.nb_out, bias=False)
        self.bn3 = nn.BatchNorm1d(2 * self.nb_out)
        for name in ("input_mean", "input_scale", "output_mean", "output_scale"):
            self.register_buffer(name, torch.zeros(state[name].shape))
        own = {
            k: v
            for k, v in state.items()
            if k != "sample_rate" and not k.startswith(("stft.", "transform."))
        }
        missing = self.load_state_dict(own, strict=False)
        assert not missing.missing_keys and not missing.unexpected_keys, missing
        self.eval()

    @torch.no_grad()
    def forward(self, mag):
        """mag: (frames, 2 channels, bins=2049) -> estimate of this target's magnitude."""
        frames = mag.shape[0]
        x = mag[..., : self.nb_bins].clone()
        x = (x + self.input_mean) * self.input_scale
        x = self.bn1(self.fc1(x.reshape(frames, -1)))
        x = torch.tanh(x).reshape(frames, 1, -1)
        out, _ = self.lstm(x)
        x = torch.cat([x, out], dim=-1).reshape(frames, -1)
        x = F.relu(self.bn2(self.fc2(x)))
        x = self.bn3(self.fc3(x)).reshape(frames, 2, self.nb_out)
        x = x * self.output_scale + self.output_mean
        return F.relu(x) * mag


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    audio, rate = sf.read(args.inp, dtype="float32", always_2d=True)
    assert rate == 44100, f"UMX-HQ expects 44.1 kHz, got {rate}"
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    length = audio.shape[0]
    wave = torch.from_numpy(audio.T.copy())  # (2, samples)
    window = torch.hann_window(N_FFT)
    start = time.time()
    spec = torch.stft(
        wave, N_FFT, HOP, window=window, center=True, return_complex=True, pad_mode="reflect"
    )  # (2, bins, frames)
    mix = spec.permute(2, 0, 1)  # (frames, 2, bins)
    mag = mix.abs()

    estimates = {}
    for name, file in TARGETS.items():
        state = torch.load(os.path.join(args.weights, file), map_location="cpu", weights_only=True)
        estimates[name] = Umx(state)(mag)
        print(f"{name}: {time.time() - start:.1f} s", flush=True)

    power = sum(e**2 for e in estimates.values()) + 1e-10
    os.makedirs(args.out, exist_ok=True)
    for name, est in estimates.items():
        masked = mix * (est**2 / power)
        wav = torch.istft(
            masked.permute(1, 2, 0), N_FFT, HOP, window=window, center=True, length=length
        )
        sf.write(os.path.join(args.out, f"{name}.wav"), wav.T.numpy(), rate, subtype="FLOAT")
    print(f"done in {time.time() - start:.1f} s for {length / rate:.1f} s of audio")


if __name__ == "__main__":
    main()
