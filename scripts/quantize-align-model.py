# 把对齐模型的 fp32 权重量化成 4-bit（MatMulNBits），给**浏览器**用。
#
# 为什么要自己量化：模型作者只发了 fp32 那一份（1204 MiB），而浏览器里跑不动它 ——
# 桌面那条路要的是 230MB 左右的 4-bit 版本，HF 上不存在。服务器用的仍然是 fp32。
#
# 为什么是 MatMulNBits 而不是 int8：int8 那份（302 MiB）在 wasm 后端上**加载即被系统
# 杀掉**（2026-09-02 实测，32GB 的机器上也一样），而 4-bit 走的是 ORT 自己的
# MatMulNBits 算子，WebGPU 和 wasm 两个 EP 都有实现。参数与 transformers.js 官方的
# 转换脚本一致（block_size=32、对称量化），这样产出的文件和 onnx-community 那些
# `model_q4.onnx` 是同一种东西，出问题时可查的东西多得多。
#
# 用法（在仓库根）：
#   python -m pip install onnx onnxruntime
#   curl -L https://huggingface.co/<modelId>/resolve/main/onnx/model.onnx -o .cache/align/<modelId>/onnx/model.onnx
#   python scripts/quantize-align-model.py
#
# 默认在 **.cache/align/** 下读写（那是 .gitignore 里的目录，和词典的源文件同一条理由）。
# **不要放进 public/**：那 1.2GB 的 fp32 会被 vite build 原样抄进 dist。
# 产出之后有两个去处：
#   ① 上线：scp 到那台服务器的 ~/deutsch-sync/data/models/<同样的目录结构>/
#      —— 权重站按这个布局对外提供（server/src/align/weights.ts），浏览器从那里取
#   ② 本机/Android 打包：`npm run stage:align` 会把它搬进 public/models/

import argparse
import os
import sys
import time

# Windows 的控制台默认是 cp1252，print 一句中文就 UnicodeEncodeError —— 而这个脚本
# 唯一的输出就是中文进度。放在最前面，早于任何 print。
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MODEL_ID = "oliverguhr/wav2vec2-large-xlsr-53-german-cv9"

parser = argparse.ArgumentParser()
parser.add_argument(
    "--dir",
    default=os.path.join(".cache", "align", *MODEL_ID.split("/"), "onnx"),
    help="模型的 onnx/ 目录",
)
parser.add_argument("--block-size", type=int, default=32)
args = parser.parse_args()

src = os.path.join(args.dir, "model.onnx")
dst = os.path.join(args.dir, "model_q4.onnx")

if not os.path.exists(src):
    sys.exit(
        f"{src} 不在 —— 先下 fp32 那一份：\n"
        f"  curl -L https://huggingface.co/{MODEL_ID}/resolve/main/onnx/model.onnx -o {src}"
    )

import onnx  # noqa: E402  （放在参数检查之后：import 它本身要几秒）
from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer  # noqa: E402


def mib(path):
    return f"{os.path.getsize(path) / 1024 / 1024:.1f} MiB"


started = time.time()
print(f"读 {src}（{mib(src)}）…")
model = onnx.load(src)

print(f"量化：4-bit，block_size={args.block_size}，对称…")
quantizer = MatMul4BitsQuantizer(
    model=model,
    block_size=args.block_size,
    is_symmetric=True,
    nodes_to_exclude=[],
)
quantizer.process()

# use_external_data_format=False：量化之后只有 230MB，一个文件放得下。
# 拆成 .onnx + .onnx_data 会让 transformers.js 多取一次件，也让「随包/权重站」
# 那两条路各多一个可能缺的文件。
print(f"写 {dst}…")
quantizer.model.save_model_to_file(dst, use_external_data_format=False)

print(f"完成：{mib(src)} → {mib(dst)}，用时 {time.time() - started:.0f} 秒")
