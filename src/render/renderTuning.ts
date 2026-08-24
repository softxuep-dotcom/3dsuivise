/**
 * 画面的**可调数字**：相机距离、阴影策略、一次性画质上调的判据、昼夜配色。
 *
 * 从 GameRenderer.ts 拆出来。这几组各自都有一段"为什么是这个值"的账
 * （阴影那三个数是配套的、画质上调的两个判据必须同时成立、昼夜配色改这里
 * 就是改整个游戏的气质）—— 摊开放在一处，改参数时不必翻四千行实现。
 */
import * as THREE from "three";
import { clamp } from "../game/simulation/geometry";

/** 相机距离系数。竖屏拉远补视野，横屏拉近补可读性 —— 见 updateCamera。 */
export const PORTRAIT_CAMERA_SCALE = 1.08;
export const LANDSCAPE_CAMERA_SCALE = 0.64;

/** 动物素材下载的重试退避（毫秒）。长度 = 重试次数，所以一共尝试 3 次。 */
export const ANIMAL_ASSET_RETRY_BACKOFF: readonly number[] = [700, 1800];

/**
 * 角色的贴地阴影（blob shadow）。
 *
 * 低功耗档不再让玩家、狼、猎物投真阴影，改成脚下贴一片圆形暗斑。
 *
 * 换掉的理由是**这档阴影本来就读不出形状**：阴影图 512²、阴影相机覆盖 ±32
 * 世界单位，也就是每米 8 texel；一只狼身长 1.5 米，落在阴影图上只有 12 texel。
 * 为这 12 个像素，深度 pass 要把 13 个骨骼网格（45 米剔除后的数量）**再蒙皮一遍** ——
 * 主 pass 一遍、阴影 pass 一遍。拿一坨读不出形状的斑点换一坨故意画的斑点，
 * 视觉上几乎不损失，省下的是整个动态深度 pass。
 *
 * 用 DataTexture 而不是 CanvasTexture，理由同 createGroundTexture：
 * 移动端 Chrome 会在后台回收游离 canvas 的后备存储，回前台重传就是一片全黑。
 */
/**
 * 低功耗档的阴影缓存。
 *
 * 角色改用贴地圆斑之后（见 createBlobShadowTexture），阴影图里**只剩静态几何** ——
 * 墙、树、地形、营地、卡车。静态的东西不需要每帧重画，只需要在阴影相机
 * 移出覆盖余量时重画一次。
 *
 * 三个数是配套的，不能单独改：
 *
 *   覆盖 ±44（原 ±32）—— 买出余量。原值是照着可视地面纵深约 60 单位定的，
 *     几乎没有富余；锚点一旦滞后就会在画面里出现一条"影子到此为止"的硬线。
 *     ±44 配 10 米的漂移余量，最坏情况下逆行方向仍覆盖 34 单位 > 30。
 *   768²（原 512²）—— 覆盖变大后维持精度。88 单位 / 768 = 每米 8.7 texel，
 *     比原来的 64/512 = 8 还略高。
 *   漂移余量 10 米 —— 玩家 8.2 米/秒，约 1.2 秒重锚一次（26fps 下约 32 帧）。
 *
 * 净账：原来每 2 帧光栅化 26 万 texel（13 万/帧摊销），现在每约 30 帧
 * 光栅化 59 万（约 2 万/帧摊销）—— **少 6 倍多，而且精度还高了一点**。
 *
 * 30 帧的强制上限是**兜底**：树被砍倒、结构物落地、卡车启动这些改变投影体的
 * 事件我都挂了钩子，但漏一个就会留下一片不该存在的影子。30 帧把任何漏网之鱼的
 * 存活时间压到 1 秒出头，而它对摊销成本几乎没有影响。
 */
export const SHADOW_ANCHOR_MARGIN = 10;
export const SHADOW_MAX_STALE_FRAMES = 30;
export const LOW_POWER_SHADOW_EXTENT = 44;
export const LOW_POWER_SHADOW_MAP = 768;

/*
 * ═══ 一次性画质上调 ═══  （要调参数的话，改这一块就够了）
 *
 * ## 它解决的是"好手机被一刀切压住"
 *
 * 移动档把 pixelRatio 钉死在 1.0。而现代旗舰手机的 devicePixelRatio 普遍是 2.5~3.5，
 * 所以 3D 画面实际是按原生 **1/9 的像素数**渲染再拉满屏 —— 屏幕最好的那批设备
 * 挨刀最狠。而它们的富余本来就浪费掉了：帧率撞在刷新率上限上，多出来的性能不产生
 * 任何收益。
 *
 * ## 为什么是"一次性、只向上"，而不是自适应梯子
 *
 * 梯子要调一堆阈值，而这些阈值只能在真机上验证 —— 手上只有一台旗舰机的话，
 * 下面那些降级档一次都跑不到，等于把一套没人验证过的机制推给最弱的那批玩家。
 *
 * 只允许**升一次、不许降**就没有这个问题：判据不满足时什么都不发生，
 * 弱机的行为和现在逐字相同；满足时也只动一次，玩家不会看见画质来回变。
 *
 * ## 两个判据必须同时成立
 *
 * 只看出帧间隔是不够的：帧率撞在 vsync 上限时，间隔恒等于刷新间隔，**读不出富余**——
 * 一台 120Hz 手机轻松跑满和勉强跑满，间隔都是 8.33ms。所以再加一条渲染耗时。
 *
 *   出帧间隔贴着刷新率  → GPU 跟得上，一帧没掉
 *   渲染耗时远低于刷新间隔 → CPU 侧确实有富余
 *
 * 两条都成立才升。前者管 GPU，后者管 CPU，缺一条都可能升错。
 */
/** 玩家真正开始玩之后先跳过这么久：着色器编译和 GLB 解析都挤在这一段。 */
export const UPGRADE_WARMUP_MS = 3000;
/** 采样窗口。攒满这么久才做判断，判断完就永久收工。 */
export const UPGRADE_WINDOW_MS = 3000;
/** 样本不够就不升 —— 宁可不动，也不能拿几帧下结论。 */
export const UPGRADE_MIN_SAMPLES = 60;
/** 出帧间隔中位数不得超过刷新间隔的这个倍数（1.15 ≈ 允许偶尔掉一帧）。 */
export const UPGRADE_MAX_INTERVAL_RATIO = 1.15;
/** 渲染耗时中位数不得超过刷新间隔的这个比例。留的余量要够 pixelRatio 抬上去之后的开销。 */
export const UPGRADE_MAX_WORK_RATIO = 0.4;
/** 达标后 pixelRatio 抬到这里（仍受 devicePixelRatio 封顶）。 */
export const UPGRADE_PIXEL_RATIO = 1.5;
/** 达标后阴影图抬到这里。范围 ±44 不动，所以每米 texel 数从 8.7 涨到 11.6。 */
export const UPGRADE_SHADOW_MAP = 1024;

const BLOB_SHADOW_TEXTURE_SIZE = 64;
/** 同屏最多画几片。玩家 1 + 45 米内的狼与猎物，实测远不到这个数。 */
export const BLOB_SHADOW_CAPACITY = 48;
/** 抬离地面多少，避免与地面 z-fighting。 */
export const BLOB_SHADOW_LIFT = 0.04;
/** 估地形法线时左右各采样多远。 */
export const BLOB_SHADOW_NORMAL_STEP = 0.5;
export const BLOB_SHADOW_UP = new THREE.Vector3(0, 1, 0);
export const BLOB_SHADOW_NORMAL = new THREE.Vector3();

export const createBlobShadowTexture = (): THREE.DataTexture => {
  const size = BLOB_SHADOW_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const spread = Math.hypot(x - centre, y - centre) / centre;
      // (1 - r²)^1.6：中心实、边缘平滑归零。指数比 1 大是为了让边缘收得比线性快，
      // 免得斑点看起来像一块糊在地上的圆形污渍。
      const alpha = spread >= 1 ? 0 : Math.pow(1 - spread * spread, 1.6);
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
};

export const smoothTerrainBlend = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/*
 * 昼夜光照配色表。**改这里就是改整个游戏的气质**，所以摊开写成常量而不是散在函数里。
 *
 * 白天走"暖主光 + 冷填充"，夜晚走"冷到底 + 一盏篝火"。见 syncDayNight 里那段。
 * 想回到 1.0.14 的全暖白天：DAY_SKY=d8bf8d、DAY_HEMI_SKY=ffeec4、
 * DAY_HEMI_GROUND=8a6a44、DAY_HEMI_INTENSITY=2.2、DAY_SUN_INTENSITY=3.2。
 */
export const DAY_SKY = new THREE.Color(0xc9c3b4);
export const DAY_HEMI_SKY = new THREE.Color(0xcdd8e6);
export const DAY_HEMI_GROUND = new THREE.Color(0x8a7250);
export const DAY_SUN = new THREE.Color(0xfff0cc);
export const DAY_HEMI_INTENSITY = 1.15;
export const DAY_SUN_INTENSITY = 4.1;

export const NIGHT_SKY = new THREE.Color(0x2c3d5c);
export const NIGHT_HEMI_SKY = new THREE.Color(0x8fa6cf);
export const NIGHT_HEMI_GROUND = new THREE.Color(0x3a4356);
export const NIGHT_SUN = new THREE.Color(0xa8bce0);
