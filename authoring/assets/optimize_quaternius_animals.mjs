/**
 * 把 Quaternius《Ultimate Animated Animal Pack》里我们**用得到的两只**动物
 * 压成运行时用的 .glb。
 *
 * 素材：https://quaternius.com/packs/ultimateanimatedanimals.html （CC0）
 * 原始文件是自带 base64 缓冲的单文件 .gltf，每只 3 MB 出头，各带 12~13 个动画。
 *
 * 这个脚本只干两件事，但两件都是为了**别把没用的东西拉进包里**：
 *
 *   1. 整包 12 只动物只取 Wolf 和 Deer —— 其余十只连下都不下载；
 *   2. 每只只留下游戏真正会播的那几个片段，其余全部 dispose。
 *      一个动画片段在这类模型里就是体积的大头：Wolf 的 12 个片段我们只用 5 个。
 *
 * 用法：
 *   node authoring/assets/optimize_quaternius_animals.mjs <原始 gltf 目录> <输出目录>
 *   node authoring/assets/optimize_quaternius_animals.mjs ./raw public/assets/animals
 */

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) {
  throw new Error("Usage: node optimize_quaternius_animals.mjs <raw-gltf-directory> <output-directory>");
}

const sourceDirectory = path.resolve(sourceArgument);
const outputDirectory = path.resolve(outputArgument);
if (sourceDirectory === outputDirectory) throw new Error("Source and output directories must be different.");

/**
 * 保留哪些片段，是按**模拟层真的存在这个状态**挑的，不是按"看起来有用"挑的：
 *
 *   狗有 patrol / chase / raid / retreating / dead 五种 mode，外加一个咬击窗口
 *   → Walk（巡逻与入场）、Gallop（追击与撤离）、Attack（咬）、Death（倒地）。
 *
 *   猎物只有 graze / flee / dead 三种 → Walk、Gallop、Death。
 *
 * **鹿没有 Idle**：模拟层里的猎物永远在走（吃草也有 1.4 的移速），那条分支到不了。
 *
 * **狼留了 Idle**，两个理由，第二个是实测出来的：
 *   1. 它是 syncWolfAnimation 的兜底分支 —— 以后加新的 WolfMode 时，
 *      狗会站着而不是原地滑步；
 *   2. **删掉它反而更大**（331 → 351 KiB）。Idle 有 3.33 秒但几乎全是常量通道，
 *      留着它，dedup 能把这些常量和别的片段合并；删掉之后反倒没得合并了。
 *      "少一个片段 = 小一点"在这条流水线上不成立，得实测。
 *
 * 被丢掉的：Eating、Gallop_Jump、Idle_2、Idle_2_HeadLow、Idle_HitReact1/2、
 * Jump_ToIdle，以及鹿的两种 Attack（猎物不会攻击玩家）。
 */
const models = new Map([
  ["Wolf.gltf", { output: "Wolf.glb", clips: ["Idle", "Walk", "Gallop", "Attack", "Death"] }],
  ["Deer.gltf", { output: "Deer.glb", clips: ["Walk", "Gallop", "Death"] }],
]);

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
await MeshoptEncoder.ready;
await mkdir(outputDirectory, { recursive: true });

const formatSize = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * 丢掉**恒定且等于静止姿势**的动画通道。
 *
 * Blender 导出时给每根骨头的每个片段都写满 translation / rotation / scale 三条轨道，
 * 哪怕那根骨头整段只是在原地旋转。实测狼有 53 个节点 × 3 条轨道 × 5 个片段
 * ≈ 795 个采样器、1746 个 accessor —— 而**体积的大头就在这里**，
 * 不是网格（4000 个顶点）也不是关键帧密度（把重采样容差放宽 50 倍只省 1%）。
 *
 * 判据必须是"恒定 **且** 等于节点的静止值"两条同时成立：只判恒定的话，
 * 某个片段把骨头摆到一个固定的新位置（比如死亡姿势里塌下去的胯）也会被误删。
 */
function dropConstantChannels(document, epsilon = 1e-4) {
  let removed = 0;
  let kept = 0;
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler();
      const node = channel.getTargetNode();
      const output = sampler?.getOutput();
      if (!sampler || !node || !output) continue;
      const array = output.getArray();
      const stride = output.getElementSize();
      const count = output.getCount();
      if (!array || count < 1) continue;

      const path = channel.getTargetPath();
      const rest = path === "translation" ? node.getTranslation()
        : path === "rotation" ? node.getRotation()
          : path === "scale" ? node.getScale()
            : null;
      if (!rest || rest.length !== stride) { kept += 1; continue; }

      let constant = true;
      for (let frame = 0; frame < count && constant; frame += 1) {
        for (let component = 0; component < stride; component += 1) {
          if (Math.abs(array[frame * stride + component] - rest[component]) > epsilon) {
            constant = false;
            break;
          }
        }
      }
      if (!constant) { kept += 1; continue; }
      channel.dispose();
      sampler.dispose();
      removed += 1;
    }
  }
  return { removed, kept };
}

async function optimizeAnimal(filename, { output, clips }) {
  const inputPath = path.join(sourceDirectory, filename);
  const outputPath = path.join(outputDirectory, output);
  const document = await io.read(inputPath);

  const kept = new Set(clips);
  const animations = document.getRoot().listAnimations();
  const sourceCount = animations.length;
  for (const animation of animations) {
    if (!kept.has(animation.getName())) animation.dispose();
  }

  const remaining = document.getRoot().listAnimations().map((clip) => clip.getName());
  const missing = clips.filter((name) => !remaining.includes(name));
  if (missing.length) throw new Error(`${filename}: missing clips ${missing.join(", ")}`);

  // 先重采样再删恒定通道：重采样会把"几乎恒定"的轨道压成真正恒定的两帧，
  // 反过来做的话那些轨道判不出常量，会被留下来。
  await document.transform(resample({ tolerance: 1e-4 }));
  const channels = dropConstantChannels(document);
  await document.transform(
    dedup(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
  await io.write(outputPath, document);

  const [input, outputStat] = await Promise.all([stat(inputPath), stat(outputPath)]);
  const reduction = (1 - outputStat.size / input.size) * 100;
  return `${filename} -> ${output}: ${formatSize(input.size)} -> ${formatSize(outputStat.size)}`
    + ` (${reduction.toFixed(1)}% smaller, ${remaining.length}/${sourceCount} clips: ${remaining.join(", ")}`
    + `, 恒定通道 ${channels.removed} 删 / ${channels.kept} 留)`;
}

const reports = [];
for (const [filename, config] of models) reports.push(await optimizeAnimal(filename, config));
console.log(reports.join("\n"));
