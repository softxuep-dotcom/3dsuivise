import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * 把一个组里"建好之后不再单独动"的子网格按材质合并成一个。
 *
 * ## 为什么
 *
 * 这张图上的静态散物是**用很多很小的网格拼出来的**：一株仙人掌 9 个网格
 * （主干 + 两条手臂 + 两个肘 + 一朵花 + 三根刺），一个铁矿点 8 个，一个油桶 4 个。
 * 实测全场静态散物共 640 个网格，加起来才 24,374 个三角形 ——
 * 平均每个网格 38 个三角，而每个网格都要一次独立的绘制调用。
 *
 * 手机 GPU 上真正贵的是**调用次数**，不是三角数。实测一帧 299 次绘制调用里，
 * 地形只占 1 次（它自己就有 73,728 个三角形），剩下 298 次几乎全是这些碎网格；
 * 其中 86 次还是阴影 pass 把它们再画一遍。
 *
 * 合并之后几何完全一样、材质完全一样、世界坐标完全一样 —— **画出来一个像素都不变**，
 * 只是提交次数少了。
 *
 * ## 为什么保留组本身
 *
 * 因为所有的每帧同步都只碰**组级别**的属性：
 *
 *   syncCacti       view.visible
 *   syncIronNodes   view.visible + view.scale
 *   syncBarrels     view.visible + view.position + view.rotation
 *   syncWells       view.scale（水位点另算，见下）
 *
 * 没有一处伸进组里去动某个具体的子网格。所以把子网格合并掉，这些同步一行都不用改。
 * 反过来说：**给某个类别加"单独动它的某个零件"的逻辑之前，先来这里看一眼**，
 * 那个零件必须走 keep 排除掉。
 *
 * ## castShadow 必须分桶
 *
 * 同一株仙人掌里，主干和手臂投影、肘和花和刺不投影。把它们并进同一个网格就得
 * 二选一：让肘也投影（多出影子）或让主干不投影（少了影子）—— 两个都是可见的改变。
 * 所以分桶的键里带上 castShadow / receiveShadow，宁可多留一个网格。
 */

/**
 * 这个组当前的几何指纹：每个三角形在**世界空间**的质心，排序后拼成一串。
 *
 * 用质心而不是顶点：合并会把索引几何展开成非索引（共享顶点被拆开），
 * 顶点数一定会变，但**三角形一个不多一个不少**，质心集合必须逐字相同。
 * 只在 DEV 下算，用来证明"合并没有改变画出来的东西"——这是这个优化的全部前提。
 */
function geometryFingerprint(group: THREE.Object3D): string {
  group.updateMatrixWorld(true);
  const rows: string[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (!position) return;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld);
      /*
       * 取到厘米就够。合并把"组 → 子网格 → 顶点"两级变换烘成一级，
       * 而顶点是 float32：在世界坐标九十多米的地方，这个往返会有 1e-5 量级的抖动。
       * 卡到 1e-4 会把这点浮点噪声报成"几何变了"，而 1 厘米的差别在屏幕上根本不存在。
       */
      rows.push(
        `${((a.x + b.x + c.x) / 3).toFixed(2)},`
        + `${((a.y + b.y + c.y) / 3).toFixed(2)},`
        + `${((a.z + b.z + c.z) / 3).toFixed(2)}`,
      );
    }
  });
  rows.sort();
  return rows.join(";");
}

/** 分桶的键：同材质、同阴影行为、同渲染顺序的才能并到一起。 */
function bucketKey(mesh: THREE.Mesh): string | null {
  // 多材质网格自己内部就有分组，再并进来只会更乱，直接跳过。
  if (Array.isArray(mesh.material)) return null;
  const material = mesh.material as THREE.Material;
  return [
    material.uuid,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    mesh.renderOrder,
    mesh.frustumCulled ? 1 : 0,
  ].join("|");
}

/**
 * @param group 要合并的组。合并后的网格挂回这个组，原来的子网格摘掉。
 * @param keep  这些子节点不参与合并 —— 它们在别处被单独引用、单独控制。
 *              井口那三个水位点就是这样（wellPips 按存量逐个显隐、逐个浮动）。
 * @returns 少掉的网格数量。
 */
export function mergeStaticMeshes(group: THREE.Object3D, keep?: ReadonlySet<THREE.Object3D>): number {
  const before = import.meta.env.DEV ? geometryFingerprint(group) : "";
  group.updateMatrixWorld(true);
  const toLocal = group.matrixWorld.clone().invert();

  const buckets = new Map<string, THREE.Mesh[]>();
  const skipped = new Set<THREE.Object3D>();
  group.traverse((node) => {
    if (node === group) return;
    if (keep?.has(node)) { skipped.add(node); return; }
    // 被保留节点的祖先也不能拆（拆了保留节点就掉出场景了）。
    for (let parent = node.parent; parent && parent !== group; parent = parent.parent) {
      if (skipped.has(parent)) { skipped.add(node); return; }
    }
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const key = bucketKey(mesh);
    if (key === null) return;
    const list = buckets.get(key);
    if (list) list.push(mesh);
    else buckets.set(key, [mesh]);
  });

  let removed = 0;
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    /*
     * 索引与否必须整桶统一，否则 mergeGeometries 直接返回 null。
     *
     * **整桶都是索引的就保持索引**（three 的基本体全是索引的，这是常态）。
     * 早先无脑 toNonIndexed 会把共享顶点全部拆开：顶点数翻两三倍，
     * 合并本身也慢一截。只有真的混着索引和非索引时才统一降级。
     */
    const mixed = meshes.some((m) => !m.geometry.index) && meshes.some((m) => m.geometry.index);
    const baked: THREE.BufferGeometry[] = [];
    const local = new THREE.Matrix4();
    let ok = true;
    for (const mesh of meshes) {
      // toNonIndexed 本身就返回新几何，不必先 clone —— 早先那次 clone 是纯浪费。
      const geometry = mixed && mesh.geometry.index
        ? mesh.geometry.toNonIndexed()
        : mesh.geometry.clone();
      baked.push(geometry);
      // 把子网格相对组的变换烘进顶点里 —— 合并后只剩组自己的变换。
      geometry.applyMatrix4(local.copy(toLocal).multiply(mesh.matrixWorld));
      // 属性对不齐（有的带 uv、有的不带）也会让合并失败，先统一裁到公共属性。
      if (baked.length > 1) {
        const first = baked[0];
        for (const name of Object.keys(geometry.attributes)) {
          if (!first.attributes[name]) geometry.deleteAttribute(name);
        }
        for (const name of Object.keys(first.attributes)) {
          if (!geometry.attributes[name]) { ok = false; break; }
        }
      }
      if (!ok) break;
    }
    if (!ok) { for (const g of baked) g.dispose(); continue; }

    const merged = mergeGeometries(baked, false);
    for (const g of baked) g.dispose();
    // 合并失败就原样留着。少一次优化好过画错。
    if (!merged) continue;

    const sample = meshes[0];
    const mesh = new THREE.Mesh(merged, sample.material);
    mesh.castShadow = sample.castShadow;
    mesh.receiveShadow = sample.receiveShadow;
    mesh.renderOrder = sample.renderOrder;
    mesh.frustumCulled = sample.frustumCulled;
    // 合并出来的东西不会再动，省掉 three 每帧的矩阵重算。
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    for (const old of meshes) {
      /*
       * **不要 dispose 原几何。**
       *
       * CACTUS_ELBOW_GEOMETRY / IRON_SHARD_GEOMETRIES 这些是模块级共享常量，
       * 一株仙人掌用完就释放，剩下三十一株的肘会一起消失 —— 而且是在
       * 第一次上传 GPU 的时候才炸，离这里很远。
       *
       * 不释放的代价接近零：这些几何体本来就只有几十个三角形，而且合并发生在
       * 第一次渲染之前，它们连 GPU 缓冲都还没分配。
       */
      old.removeFromParent();
      removed += 1;
    }
    group.add(mesh);
    removed -= 1;
  }

  /*
   * 合并的全部前提是"画出来一个像素都不变"。这里当场证明它：
   * 三角形质心集合必须逐字相同。不同就直接抛 —— 与其偷偷画错，不如开发时就炸掉。
   */
  if (import.meta.env.DEV && geometryFingerprint(group) !== before) {
    throw new Error(`mergeStaticMeshes 改变了几何：${group.name || group.type}`);
  }
  return removed;
}
