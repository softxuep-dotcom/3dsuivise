import * as THREE from "three";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

/**
 * Quaternius《Ultimate Animated Animal Pack》(CC0) 的运行时装载层。
 *
 * 整包 12 只动物我们只用两只 —— 狼当所有的狗，鹿当长角羚。
 * 打包侧的取舍见 `authoring/assets/optimize_quaternius_animals.mjs`。
 *
 * 这一层只解决三件事：
 *   1. **归一化**：素材的朝向、体量、脚底高度各不相同，游戏里要能像放积木一样摆；
 *   2. **克隆**：蒙皮网格不能用 `Object3D.clone()`（骨骼引用会串台），必须走 SkeletonUtils；
 *   3. **按名字放动画**：调用方说"跑"，不关心片段叫 Gallop 还是 Run。
 */

export interface AnimalAsset {
  /** 原始 glTF 场景，只作模板用，不进场景图。 */
  readonly source: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  /** 绕 Y 转多少弧度能让鼻子朝 +X（游戏逻辑的正面）。 */
  readonly yaw: number;
  /**
   * 缩放到"站立高度 = 1 个世界单位"，之后调用方给的就是**世界高度**。
   *
   * 按高度而不是按体长归一，是因为这两只素材的比例差得远：狼的高/长是 0.51，
   * 鹿是 0.97（头抬得高）。按体长归一的话，同样是"3.8 长"，狼一米九、鹿三米七。
   * 而玩家自己是 2.6 高 —— 高度才是这个游戏里唯一能横向比较的尺子。
   */
  readonly scale: number;
  /** 抬多高能让四只脚正好踩在 y = 0。 */
  readonly lift: number;
}

export interface AnimalInstance {
  /** 挂进场景的节点。外部只应该动它的 position / rotation.y / scale。 */
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  /** 按材质名索引的克隆材质，用来给不同等级染色。 */
  readonly materials: Map<string, THREE.MeshStandardMaterial>;
  /** 当前正在播的片段名，`null` 表示还没播过。 */
  current: string | null;
  play(name: string, options?: { loop?: boolean; timeScale?: number; fade?: number }): void;
  dispose(): void;
}

/**
 * 从骨架里读出模型朝哪边。
 *
 * 不写死"Quaternius 的动物朝 −Z"这种经验值：**头骨和尾骨的世界坐标之差**是自明的，
 * 换一只动物、换一个作者都照样成立，而写死的常量会在下次换素材时静默地把模型转反。
 */
function measureForward(source: THREE.Object3D): THREE.Vector3 {
  source.updateMatrixWorld(true);
  const head = source.getObjectByName("Head");
  const tail = source.getObjectByName("Tail1") ?? source.getObjectByName("Spine");
  const forward = new THREE.Vector3(0, 0, -1);
  if (head && tail) {
    const headPosition = head.getWorldPosition(new THREE.Vector3());
    const tailPosition = tail.getWorldPosition(new THREE.Vector3());
    forward.copy(headPosition).sub(tailPosition);
  }
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  return forward.normalize();
}

export async function loadAnimal(loader: GLTFLoader, url: string): Promise<AnimalAsset> {
  const gltf = await loader.loadAsync(url);
  const source = gltf.scene;

  const forward = measureForward(source);
  // three 的绕 Y 旋转把 atan2(z, x) 意义下的角度 φ 映射到 φ − a，
  // 所以让 forward 落到 +X（φ = 0）需要 a = atan2(forward.z, forward.x)。
  const yaw = Math.atan2(forward.z, forward.x);

  // 量体积要在**转正之后**：转正会改变包围盒，脚底偏移也得跟着转正后的结果算。
  const probe = new THREE.Group();
  probe.rotation.y = yaw;
  probe.add(source);
  probe.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(probe);
  const height = Math.max(0.001, bounds.max.y - bounds.min.y);
  const scale = 1 / height;
  const lift = -bounds.min.y * scale;
  probe.remove(source);

  source.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    // 蒙皮网格的包围盒不会跟着动画走，开剔除会在动作幅度大的时候整只消失。
    object.frustumCulled = false;
    /*
     * flatShading 在**源材质**上设一次，让后面每只的 clone 直接继承。
     *
     * 原先是在每一份 clone 上设 flatShading + needsUpdate —— 那等于每生成一只狗
     * 就让它的每份材质翻一次版本。夜里一口气刷 30 只，这个开销集中在入夜那几秒，
     * 正好是帧数最紧的时候。源材质设好之后 clone 自带该属性，无需再翻版本。
     */
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material instanceof THREE.MeshStandardMaterial) material.flatShading = true;
    }
  });

  return { source, clips: gltf.animations, yaw, scale, lift };
}

export function instantiateAnimal(asset: AnimalAsset): AnimalInstance {
  const root = new THREE.Group();
  const model = cloneSkinned(asset.source);
  model.rotation.y = asset.yaw;
  model.scale.setScalar(asset.scale);
  model.position.y = asset.lift;
  root.add(model);

  /*
   * 一个实例只留**一副**骨架。
   *
   * 素材那边本来就是一副：狼 4 个 SkinnedMesh（鹿 7 个、主角 8 个）共用同一个
   * Skeleton。但 SkeletonUtils.clone 是逐 mesh 处理的 —— `clonedMesh.skeleton =
   * sourceMesh.skeleton.clone()` 每个 mesh 各克隆一副，于是一只狗身上出现四副。
   * 四副的 bones 数组是同一批克隆骨头、boneInverses 也逐个相同，纯属重复。
   *
   * 代价全在**每帧**：three 为每副骨架各算一遍 51 根骨头的世界矩阵、各传一张
   * 16×16 的 bone texture，同一件事做四遍。实测把它们并成一副之后，
   * 夜里那一帧的渲染时间掉 10%（2.79 → 2.53 ms）。
   *
   * 顺带堵掉一个泄漏：bone texture 是三方在**第一次真正画到**这只动物时才建的，
   * 而原先没有任何地方销毁它 —— 每只被画出来过的狗永久留下 4 张贴图，
   * 实测一夜下来纹理计数只增不减（13 → 37，正好 6 只可见狗 ×4）。
   * 现在多余的那几副当场 dispose，剩下的一副交给下面的 dispose() 收。
   */
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) skinnedMeshes.push(object);
  });
  const skeleton = skinnedMeshes.length > 0 ? skinnedMeshes[0].skeleton : null;
  if (skeleton) {
    for (const mesh of skinnedMeshes) {
      if (mesh.skeleton === skeleton) continue;
      const duplicate = mesh.skeleton;
      // bindMatrix 是逐 mesh 的，必须原样传回去，不能让 bind() 拿 matrixWorld 现推。
      mesh.bind(skeleton, mesh.bindMatrix);
      duplicate.dispose();
    }
  }

  /*
   * 材质必须每只一份，**不能共享** —— syncWolves 每帧都按各自的状态染色：
   * 受击闪红、撤退转灰、追击时加自发光、大小狗底色不同。共享会让全场一起闪。
   * （flatShading 已经在源材质上设过，这里不再逐个翻版本。）
   */
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const owned: THREE.Material[] = [];
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    const cloned = list.map((material) => {
      const copy = material.clone();
      owned.push(copy);
      if (copy instanceof THREE.MeshStandardMaterial && copy.name && !materials.has(copy.name)) {
        materials.set(copy.name, copy);
      }
      return copy;
    });
    object.material = Array.isArray(object.material) ? cloned : cloned[0];
  });

  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of asset.clips) actions.set(clip.name, mixer.clipAction(clip));

  let currentAction: THREE.AnimationAction | null = null;
  const instance: AnimalInstance = {
    root,
    mixer,
    materials,
    current: null,
    play(name, options = {}) {
      const action = actions.get(name);
      if (!action) return;
      const loop = options.loop ?? true;
      const timeScale = options.timeScale ?? 1;
      if (instance.current === name) {
        // 同一个片段只调速，不重播 —— 否则狼每帧都在从第 0 帧起步，看着像抽搐。
        action.setEffectiveTimeScale(timeScale);
        return;
      }
      const fade = options.fade ?? 0.16;
      currentAction?.fadeOut(fade);
      action.reset();
      action.enabled = true;
      action.clampWhenFinished = !loop;
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.setEffectiveTimeScale(timeScale);
      action.setEffectiveWeight(1);
      action.fadeIn(fade).play();
      currentAction = action;
      instance.current = name;
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      for (const material of owned) material.dispose();
      // 骨架自带一张 bone texture，材质的 dispose() 不会顺带收它。
      skeleton?.dispose();
    },
  };
  return instance;
}
