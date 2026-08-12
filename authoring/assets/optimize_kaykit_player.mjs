import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, resample } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) {
  throw new Error("Usage: node optimize_kaykit_player.mjs <raw-source-directory> <output-directory>");
}

const sourceDirectory = path.resolve(sourceArgument);
const outputDirectory = path.resolve(outputArgument);
if (sourceDirectory === outputDirectory) throw new Error("Source and output directories must be different.");
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
await MeshoptEncoder.ready;

const animationFiles = new Map([
  ["Rig_Medium_MovementBasic.glb", new Set(["Running_A"])],
  ["Rig_Medium_General.glb", new Set(["Idle_A", "Idle_B", "Hit_A"])],
  // 突刺（Melee_2H_Attack_Stab）已弃用：武器统一成刀与剑之后没有长柄武器，
  // 全线共用劈砍。下次拿原始素材重跑本脚本时它就会被剔出产物。
  ["Rig_Medium_CombatMelee.glb", new Set(["Melee_1H_Attack_Chop"])],
]);

await mkdir(outputDirectory, { recursive: true });

const formatSize = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

async function optimizeCharacter() {
  const filename = "Rogue_Hooded.glb";
  const inputPath = path.join(sourceDirectory, filename);
  const outputPath = path.join(outputDirectory, filename);
  const document = await io.read(inputPath);

  await document.transform(
    dedup(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
  await io.write(outputPath, document);
  return report(filename, inputPath, outputPath, "character mesh");
}

async function optimizeAnimations(filename, keptNames) {
  const inputPath = path.join(sourceDirectory, filename);
  const outputPath = path.join(outputDirectory, filename);
  const document = await io.read(inputPath);
  const animations = document.getRoot().listAnimations();
  const sourceCount = animations.length;

  // Animation GLBs contain a complete mannequin mesh. Runtime only needs their
  // named bone tracks, so detach render data while preserving the rig hierarchy.
  for (const node of document.getRoot().listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
    node.setCamera(null);
  }

  for (const animation of animations) {
    if (!keptNames.has(animation.getName())) animation.dispose();
  }

  const keptAnimations = document.getRoot().listAnimations();
  const missing = [...keptNames].filter((name) => !keptAnimations.some((clip) => clip.getName() === name));
  if (missing.length) throw new Error(`${filename}: missing clips ${missing.join(", ")}`);

  await document.transform(
    resample({ tolerance: 1e-4 }),
    dedup(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
  await io.write(outputPath, document);
  return report(filename, inputPath, outputPath, `${keptAnimations.length}/${sourceCount} clips`);
}

async function report(filename, inputPath, outputPath, detail) {
  const [input, output] = await Promise.all([stat(inputPath), stat(outputPath)]);
  const reduction = (1 - output.size / input.size) * 100;
  return `${filename}: ${formatSize(input.size)} -> ${formatSize(output.size)} (${reduction.toFixed(1)}% smaller, ${detail})`;
}

const reports = [await optimizeCharacter()];
for (const [filename, keptNames] of animationFiles) {
  reports.push(await optimizeAnimations(filename, keptNames));
}

console.log(reports.join("\n"));
