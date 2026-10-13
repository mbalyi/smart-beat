"""Exports Transkun 2.0 (MIT) for the Rust runner: two ONNX graphs and one constants file.

Run in a venv with transkun, torch 2.2, onnx, onnxruntime and numpy<2:
    python export_transkun.py OUT_DIR

Writes:
- transkun-net.onnx    mel features [1, T, 229, 6] -> ctx [1, 90, T, 256], q, k [1, 90, T, 256], diag [1, 90, T]
- transkun-heads.onnx  interval features [N, 768] -> velocity logits [N, 128], offsets and presence [N, 4]
- transkun-front.bin   f32 little endian: 6 windows of 4096, then the mel filter bank [2049, 229]
It checks each graph against PyTorch with ONNX Runtime before it finishes.
"""

import math
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pkg_resources
import torch
import moduleconf

SEGMENT_FRAMES = 691  # 16 s at 44.1 kHz with a hop of 1024, as the model's own segments


def load():
    conf_path = pkg_resources.resource_filename("transkun", "pretrained/2.0.conf")
    weight = pkg_resources.resource_filename("transkun", "pretrained/2.0.pt")
    manager = moduleconf.parseFromFile(conf_path)
    model = manager["Model"].module.TransKun(conf=manager["Model"].config)
    checkpoint = torch.load(weight, map_location="cpu")
    state = checkpoint["state_dict"] if "best_state_dict" not in checkpoint else checkpoint["best_state_dict"]
    model.load_state_dict(state, strict=False)
    model.backbone.useGradientCheckpoint = False  # the graph must not use torch.utils.checkpoint
    return model.eval()


class Net(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.register_buffer("pitches", torch.tensor(model.targetMIDIPitch))

    def forward(self, features):
        ctx = self.model.backbone(features, outputIndices=self.pitches)
        size = self.model.scorer.size
        q, k, diag = self.model.scorer.map(ctx).split([size, size, 1], dim=-1)
        q = q / math.sqrt(q.shape[-1])
        return ctx, q, k, diag.squeeze(-1)


class Heads(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, x):
        velocity = self.model.velocityPredictor(x)
        value, presence = self.model.refinedOFPredictor(x).chunk(2, dim=-1)
        # The mean of torch's ContinuousBernoulli(logits), written out (its own code does not export).
        probs = torch.sigmoid(value)
        unstable = (probs <= 0.499) | (probs >= 0.501)
        cut = torch.where(unstable, probs, torch.full_like(probs, 0.499))
        mus = cut / (2.0 * cut - 1.0) + 1.0 / (torch.log(1.0 - cut) - torch.log(cut))
        mean = torch.where(unstable, mus, 0.5 + (probs - 0.5) / 3.0)
        value = torch.clamp((mean - 0.5) / 0.99, -0.5, 0.5)
        return velocity, torch.cat([value, presence], dim=-1)


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    model = load()
    torch.set_grad_enabled(False)

    # Front end constants: the model's windows and mel filter bank.
    spectrum = model.framewiseFeatureExtractor.spectrogramExtractor
    wins = torch.cat([spectrum.win.unsqueeze(0), spectrum.winGen.get().t()], dim=0)
    bank = model.framewiseFeatureExtractor.freq2mels
    with open(out / "transkun-front.bin", "wb") as handle:
        handle.write(wins.numpy().astype("<f4").tobytes())
        handle.write(bank.numpy().astype("<f4").tobytes())
    print("windows", tuple(wins.shape), "bank", tuple(bank.shape))

    # The backbone graph.
    net = Net(model).eval()
    frames = torch.randn(1, 1, SEGMENT_FRAMES, model.windowSize)
    mean = frames.mean(dim=[1, 2, 3], keepdim=True)
    std = frames.std(dim=[1, 2, 3], keepdim=True)
    features = model.framewiseFeatureExtractor((frames - mean) / (std + 1e-8)).contiguous()
    features = features.view(1, *features.shape[-3:])
    print("features", tuple(features.shape))
    reference = net(features)
    torch.onnx.export(
        net,
        (features,),
        out / "transkun-net.onnx",
        input_names=["features"],
        output_names=["ctx", "q", "k", "diag"],
        opset_version=17,
        do_constant_folding=True,
    )
    session = ort.InferenceSession(str(out / "transkun-net.onnx"), providers=["CPUExecutionProvider"])
    got = session.run(None, {"features": features.numpy()})
    for name, a, b in zip(["ctx", "q", "k", "diag"], reference, got):
        print(name, tuple(b.shape), "max abs diff", float(np.abs(a.numpy() - b).max()))

    # The heads graph.
    heads = Heads(model).eval()
    x = torch.randn(7, 768)
    ref = heads(x)
    torch.onnx.export(
        heads,
        (x,),
        out / "transkun-heads.onnx",
        input_names=["x"],
        output_names=["velocity", "offsets"],
        dynamic_axes={"x": {0: "n"}, "velocity": {0: "n"}, "offsets": {0: "n"}},
        opset_version=17,
    )
    session = ort.InferenceSession(str(out / "transkun-heads.onnx"), providers=["CPUExecutionProvider"])
    got = session.run(None, {"x": x.numpy()})
    for name, a, b in zip(["velocity", "offsets"], ref, got):
        print(name, tuple(b.shape), "max abs diff", float(np.abs(a.numpy() - b).max()))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
