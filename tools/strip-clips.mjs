/**
 * 剥掉 GLB 里没人播的动画。
 *
 * 用法：
 *   node tools/strip-clips.mjs <glb> <要保留的 clip 名...>
 *
 * 例：
 *   node tools/strip-clips.mjs public/assets/characters/kaykit/Rig_Medium_CombatMelee.glb Melee_1H_Attack_Chop
 *
 * 脚本就地改写文件。保留名会在写盘前校验，写盘后还会重新读取并核对关键帧与时长。
 */
import { readFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.encoder": MeshoptEncoder,
});

const [file, ...keep] = process.argv.slice(2);
if (!file || keep.length === 0) {
  console.error("用法：node tools/strip-clips.mjs <glb> <要保留的 clip 名...>");
  process.exit(1);
}

/** 逐 sampler 汇总，用来在剥之前/之后对同一条 clip 打出可比对的指纹。 */
const fingerprint = (animation) => {
  let keyframes = 0;
  let duration = 0;
  for (const sampler of animation.listSamplers()) {
    const input = sampler.getInput();
    keyframes += input.getCount();
    duration = Math.max(duration, input.getMax([])[0]);
  }
  return { keyframes, duration };
};

const before = readFileSync(file).length;
const doc = await io.read(file);
const present = doc.getRoot().listAnimations().map((animation) => animation.getName());

/* 保留名写错时必须在改动文件之前失败，避免把所有动画都剥光。 */
const missing = keep.filter((name) => !present.includes(name));
if (missing.length > 0) {
  console.error(`× 这些 clip 在 ${file} 里不存在：${missing.join(", ")}`);
  console.error(`  文件里现有：${present.join(", ")}`);
  console.error("  没有改动任何东西。");
  process.exit(1);
}

const kept = new Map();
for (const animation of doc.getRoot().listAnimations()) {
  const name = animation.getName();
  if (keep.includes(name)) {
    kept.set(name, fingerprint(animation));
    continue;
  }
  const gone = fingerprint(animation);
  for (const sampler of animation.listSamplers()) sampler.dispose();
  animation.dispose();
  console.log(`  剥掉 ${name}（${gone.keyframes} 关键帧，${gone.duration.toFixed(3)}s）`);
}

await doc.transform(prune());
await io.write(file, doc);

/* 回读成品，保证真正写出去的文件仍可解码且保留动画没有变化。 */
const after = readFileSync(file).length;
const reread = await io.read(file);
const survivors = reread.getRoot().listAnimations();
let ok = survivors.length === keep.length;
for (const animation of survivors) {
  const was = kept.get(animation.getName());
  const now = fingerprint(animation);
  const same = was && was.keyframes === now.keyframes
    && Math.abs(was.duration - now.duration) < 1e-6;
  if (!same) ok = false;
  console.log(`  保留 ${animation.getName()}（${now.keyframes} 关键帧，${now.duration.toFixed(3)}s）${same ? "" : "  ← 与剥前不一致！"}`);
}

const pct = ((1 - after / before) * 100).toFixed(0);
console.log(`  ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB，省 ${((before - after) / 1024).toFixed(0)} KB（${pct}%）`);
if (!ok) {
  console.error("× 保留下来的 clip 和剥之前对不上。请从版本控制还原文件。");
  process.exit(1);
}
