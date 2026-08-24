/**
 * 静态装饰的合批：把一堆参数相同的材质认成同一种，然后把网格合成少数几次绘制。
 *
 * 从 GameRenderer.ts 拆出来。它只跟 Three.js 的对象打交道，一条游戏规则都不知道。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** 材质的"看起来一样吗"指纹。**按参数比，不按对象比** —— 理由见 mergeStaticGroup。 */
interface MaterialProbe {
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
  map?: THREE.Texture | null;
}

const materialSignature = (material: THREE.Material): string => {
  const probe = material as THREE.Material & MaterialProbe;
  return [
    material.type,
    probe.color?.getHexString() ?? "-",
    probe.emissive?.getHexString() ?? "-",
    probe.emissiveIntensity ?? "-",
    probe.roughness ?? "-",
    probe.metalness ?? "-",
    probe.flatShading ?? "-",
    probe.map?.uuid ?? "-",
    material.side,
    material.transparent,
    material.opacity,
    material.depthWrite,
    material.depthTest,
  ].join("|");
};

/**
 * 把一组"零件之间不动"的装饰按材质压成整块，一种材质一个网格。
 *
 * ## 为什么值得做
 *
 * 巢、地标、营地、铁矿、油桶、井、卡车车体，写法都一样：一个 Group 里塞十几二十个
 * 小 Mesh，每个几十到一百个顶点。它们彼此之间从建好到这一局结束不会动、不会换色、
 * 不会单独显隐 —— 也就是说这些 Mesh 之间**没有一条信息是运行时才知道的**，
 * 完全可以在建的时候就烤成一块。
 *
 * ## 关键：烤的是**组的局部坐标**
 *
 * 所以"整个组会不会动"完全无所谓。铁矿按储量整体缩放、油桶被扛走、卡车通关时开走 ——
 * 这些都写在 Group 上，合批之后照样生效。只要零件**彼此之间**不动就能合。
 *
 * ## 为什么逐个对象合，不跨对象合
 *
 * 跨对象会把整张图的巢连成一个横跨全图的网格，包围球覆盖所有地方，于是**永远进不了
 * 视锥剔除** —— 玩家在空旷沙漠里也要提交全图的装饰。逐个合两头都占：簇内的十几条塌成
 * 两三条，而"这座营地在不在画面里"仍然由 three 逐个剔除。
 *
 * ## 两个必须按参数分桶的地方
 *
 * **材质按指纹分桶，不按对象。** 石碑的三道刻痕、井口的黑面都是在循环里
 * `makeMaterial(...)` 现造的，参数完全相同却是不同对象；按对象分桶等于没合。
 *
 * **castShadow / receiveShadow 也进桶键。** 同一个 deadwood 材质，树干投影、车辕不投影，
 * 合到一起就只能二选一，画面会变。
 *
 * @param keep 这些对象（连同其子树）原样留下 —— 营火的火苗、井上的水珠这些每帧都在动。
 */
export const mergeStaticGroup = (group: THREE.Object3D, keep: ReadonlySet<THREE.Object3D> = new Set()): void => {
  interface Bucket {
    material: THREE.Material;
    cast: boolean;
    receive: boolean;
    /** 合并前可能被整桶换成非索引版本，所以不是 readonly。 */
    parts: THREE.BufferGeometry[];
    sources: THREE.Mesh[];
  }
  group.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const buckets = new Map<string, Bucket>();

  const walk = (object: THREE.Object3D): void => {
    if (keep.has(object)) return;
    for (const child of [...object.children]) walk(child);
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const key = `${materialSignature(object.material)}|${object.castShadow}|${object.receiveShadow}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: object.material, cast: object.castShadow, receive: object.receiveShadow, parts: [], sources: [] };
      buckets.set(key, bucket);
    }
    // applyMatrix4 会连法线一起按法线矩阵变换，所以巢那些 scale(1.5, 0.5, 1) 的
    // 土脊不会因为非等比缩放而错光。
    const baked = object.geometry.clone();
    baked.applyMatrix4(local.multiplyMatrices(toLocal, object.matrixWorld));
    bucket.parts.push(baked);
    bucket.sources.push(object);
  };
  walk(group);

  for (const bucket of buckets.values()) {
    /*
     * 索引要先统一。
     *
     * mergeGeometries 要求一桶里的几何**要么全带 index、要么全不带**，否则返回 null
     * 并往控制台刷一行错。而 three 的多面体（Dodecahedron / Octahedron / Icosahedron，
     * 也就是这里的火圈石、石堆、洞穴巨石、矿石）是**非索引**的，圆柱方块球环面则都带索引 ——
     * 营地那种一个材质下既有石头又有木头的桶正好踩中。
     *
     * 混了就整桶转成非索引。这些都是 flatShading 的低模，本来就几乎没有共享顶点，
     * 展开的代价可以忽略；换来的是这些桶真的能合上。
     */
    const indexed = bucket.parts.filter((part) => part.index !== null).length;
    if (indexed > 0 && indexed < bucket.parts.length) {
      bucket.parts = bucket.parts.map((part) => {
        if (part.index === null) return part;
        const flat = part.toNonIndexed();
        part.dispose();
        return flat;
      });
    }
    // 只有一件的桶合了还是它自己，白搭一次拷贝，留原样。
    const geometry = bucket.parts.length > 1 ? mergeGeometries(bucket.parts, false) : null;
    for (const part of bucket.parts) part.dispose();
    // 万一还是合不上就放弃这一桶、保持原样 —— 宁可多几条 draw call，也不能把装饰弄丢。
    if (!geometry) continue;
    for (const source of bucket.sources) source.removeFromParent();
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.receive;
    group.add(mesh);
  }
};
