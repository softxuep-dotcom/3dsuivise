/**
 * 剥掉 GLB 里没人播的动画。
 *
 * 这些 rig 是**整包下载、整包解码**的：GameRenderer.loadPlayerAsset 把三个
 * Rig_Medium_*.glb 全量 loadAsync 下来，再把 `[...movement, ...general, ...combat]`
 * 的 animations 按 clip.name 灌进一张 Map。播不到的 clip 一样过网络、一样进解码器，
 * 只是永远不会被 get 到 —— 纯粹的净损耗。
 *
 * 用法：
 *   node tools/strip-clips.mjs <glb> <要保留的 clip 名...>
 *
 * 例（当前唯一的用武之地）：
 *   node tools/strip-clips.mjs public/assets/characters/kaykit/Rig_Medium_CombatMelee.glb Melee_1H_Attack_Chop
 *
 * **就地改写**。原件在 git 里，改坏了 `git checkout -- <glb>` 就回来了。
 * 素材如果哪天从 KayKit 重新下载，这一步要重跑一遍 —— 它不是构建步骤，
 * 是对素材本身的一次性编辑。
 *
 * 怎么知道该保留哪些：clip 全部按名字取，没有任何按下标或"取第一个"的路径，
 * 所以 `grep -rhoE '(playPlayerAnimation|playerActions\.get)\("[^"]+"' src/` 加上
 * syncPlayerAnimation 里那个 attackName 常量就是完整清单。
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
const present = doc.getRoot().listAnimations().map((a) => a.getName());

/*
 * 先把名字对齐了再动手。
 *
 * 原版直接 `keep.includes(name)` 就开剥 —— 保留名打错一个字母，条件对每一条都不成立，
 * 于是**全部剥光、然后照样写盘**。剥空的 rig 不会报错，只会让人物在游戏里僵在 T-Pose，
 * 而那时候文件已经覆盖掉了。这一关就是为了让打错字停在这里。
 */
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
  // dispose() 只摘 animation 节点；它独占的 sampler/accessor 要靠 prune 收走。
  for (const sampler of animation.listSamplers()) sampler.dispose();
  animation.dispose();
  console.log(`  剥掉 ${name}（${gone.keyframes} 关键帧，${gone.duration.toFixed(3)}s）`);
}

await doc.transform(prune());
await io.write(file, doc);

// 回读一遍成品，而不是相信内存里的 doc：真正要保证的是"写出去的那个文件还能用"。
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
  console.error("× 保留下来的 clip 和剥之前对不上。用 git checkout 还原这个文件。");
  process.exit(1);
}
