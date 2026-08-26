import { nearest } from "./nearest";
import {
  FUEL_PICKUP_REACH, TREE_REACH, TRUCK_BOARD_REACH, TRUCK_LOAD_REACH, WELL_REACH,
} from "../../balance/world";
import { FUEL_REQUIRED } from "../types";
import type {
  CactusPatch, CarryKind, CritterState, FuelBarrelState, GroundItem, IronNode,
  PlacedStructure, TreeState, Vec2, WellState, WolfState, WorldDefinition,
} from "../types";

/**
 * 「玩家这一下点的是什么」。
 *
 * 键鼠玩家点一下地面就走过去 —— 这条一直都在。这里加的是：点在**某个东西**上时，
 * 记住那个东西，走到够得着，然后自动做一次（采集或挥一刀）。
 *
 * ## 为什么走 2D 扫描而不是 three 的射线
 *
 * 实测（桌面端，场上 249 个可选中实体）：
 *
 *   对整个场景递归射线   9.570 ms      904 个网格，全是三角形求交
 *   只对地形网格射线     4.905 ms      73,728 个三角形，three 没有 BVH
 *   本文件这套 2D 扫描   0.0023 ms     一次完整模拟 tick 的 1/70
 *
 * 差了三个数量级。原因很简单：这个游戏的玩法是**平面的** —— 所有东西都贴地，
 * 有没有点中只跟 xz 平面上的距离有关，把它当三维问题去解是白付钱。
 *
 * 世界坐标仍然要靠现有的 `screenToWorld` 拿（那一下 4.9 ms 的地形射线还在，
 * 是点击移动本来就在付的成本，不是这个功能引入的）。
 *
 * ## 手机端一行都不跑
 *
 * `screenToWorld` 全仓只有一个调用点，而它前面就是
 * `if (event.pointerType === "touch") { ...; return; }` —— 触屏按下直接进摇杆。
 * 所以这套东西按定义是键鼠独占的，触屏的帧预算完全不受影响。
 */

/** 到位之后发哪个动作。 */
export type ClickIntent = "interact" | "attack";

export interface ClickPick {
  /**
   * 走到哪。是**实体本身的引用**，不是玩家点的那个像素对应的地面点 ——
   * 玩家点的是"那棵树"，不是"树旁边那块沙地"。
   *
   * 保留引用而不是拷贝一份坐标，是为了让会跑的目标能被跟上：点一只拾骨鸦，
   * 它一边逃玩家一边追（逃速 3.6 对 8.2，追得上）。拷贝坐标的话人会走到
   * 它**刚才**站的地方，然后对着空气挥一刀。
   *
   * 代价是目标可能在半路死掉或消失，那时玩家会走过去空挥一次。轻微、且自愈。
   */
  target: Vec2;
  /** 走到多近就够得着。到位之前不发动作。 */
  reach: number;
  intent: ClickIntent;
}

/**
 * 离视线那条地面直线多远算"点中了它"。
 *
 * 注意量的是**垂距**，不是"离命中点多远" —— 为什么，看下面那段。
 * 2.0 米：比最小的可交互物（仙人掌、铁矿约 0.5 米）宽出不少，手抖点偏一点也认；
 * 又明显窄于营地里物件之间的间距，所以点空地仍然稳定地是"走过去"。
 */
const PICK_RADIUS = 2.0;

/*
 * ## 为什么要沿视线分解，而不是直接量"离命中点多远"
 *
 * 玩家点的是一棵树**画出来的那几个像素**，而那些像素在地面以上一两米。
 * 射线穿过去，打在树**后面**的地上 —— 命中点并不在树脚下。
 *
 * 实测（把实体投到屏幕再打回地面）这个偏移是 **0.8 ~ 13.4 米**，
 * 树越高、身后的坡越陡就偏得越多。拿它当"点中判定"的距离，点树会经常无声落空 ——
 * 而"点了没反应"是最难被玩家理解的一类失败。
 *
 * 但同一批实测还给出了解法：**垂直于视线的那个分量恰好是 0**，
 * 偏移百分之百沿视线方向。所以把「命中点 → 实体」这个向量沿视线拆开：
 *
 *   垂距（perp）   ——  真正的"点没点偏"，卡 PICK_RADIUS
 *   沿视线（along）——  几乎全是物体高度带来的，只需要卡一个宽松的窗口
 *
 * along 一定是负的（实体在相机和命中点之间）。
 *
 * ## 窗口为什么给到 −16 米这么宽
 *
 * 因为收紧只会变差。实测（对着每个实体在屏幕上的位置点一下，看选中了谁）：
 *
 *   窗口/垂距     选中了瞄的   选中了旁边的   什么都没选中
 *   −16 / 2.0        46             1            14
 *   −9  / 2.0        36             2            23
 *   −6  / 1.5        30             1            30
 *
 * "选中了旁边的"几乎不随窗口变（一直是 1~2 个），而"什么都没选中"从 23% 一路涨到 49%。
 * 也就是说收紧并不能换来更准，只换来更多的**点了没反应** —— 而那是最难被玩家
 * 理解的一类失败：他不知道是没点中、还是这东西本来就不能点。
 *
 * 宽窗口的代价是点空地时偶尔会抓到东西。但落在窗口里的位置等于
 * "屏幕上这个物件正上方那一竖条"，那本来就是它画出来的地方 —— 玩家多半确实在瞄它。
 *
 * 要更准得换一套做法：把候选投到屏幕，按**画出来的范围**判定命中。
 * 那需要选中判定知道相机和每个物件的视觉高度，是另一件事，值得单独做。
 */
/**
 * 粗筛半径：先按世界距离把明显不相干的排除掉，再交给 offer 做精确的垂距判定。
 *
 * 必须覆盖"沿视线的最大偏移"（16 米）加上垂距余量，否则精筛还没跑，
 * 候选就已经被粗筛丢掉了 —— 那正是这一版之前点树落空的原因。
 */
const PREFILTER_RADIUS = 18;

const ALONG_MIN = -16;
const ALONG_MAX = 2;

/**
 * 卡车的点击半径大一圈。
 *
 * 它是全图最大的实体（碰撞半径 2.4，车斗更长），中心点离车身边缘就有两米多 ——
 * 用通用的 2.0 米量，玩家点在车厢上却算没点中，那说不过去。
 */
const TRUCK_PICK_RADIUS = 4.2;

/**
 * 这套查询要读的世界。全部只读 —— 它不改任何东西，只回答"点到了什么"。
 *
 * GameSimulation 结构上就满足这个形状，所以调用处直接 `pickAt(this, point)`。
 */
export interface PickContext {
  readonly world: WorldDefinition;
  readonly wells: readonly WellState[];
  readonly trees: readonly TreeState[];
  readonly cacti: readonly CactusPatch[];
  readonly ironNodes: readonly IronNode[];
  readonly items: readonly GroundItem[];
  readonly structures: readonly PlacedStructure[];
  readonly barrels: readonly FuelBarrelState[];
  readonly critters: readonly CritterState[];
  readonly wolves: readonly WolfState[];
  readonly truck: Vec2 & { readonly loaded: number };
  /** 当前武器的攻击距离。刀 3.1~3.8 不等，见 balance/equipment。 */
  readonly attackRange: number;
  readonly carrying: CarryKind | null;
}

/** 一个候选。命中判定用 perp/along（见上），到位判定用 reach。 */
interface Candidate {
  target: Vec2;
  reach: number;
  intent: ClickIntent;
  /** 离视线地面直线的垂距。越小越"点得准"。 */
  perp: number;
  /** 沿视线的位移。用来在垂距打平时挑离命中点更近的那个。 */
  along: number;
}

/**
 * @param point   射线打到地面的点（`screenToGround().point`）
 * @param forward 这条射线在地面上的前进方向（`screenToGround().forward`）
 */
export function pickAt(context: PickContext, point: Vec2, forward: Vec2): ClickPick | null {
  const candidates: Candidate[] = [];
  /*
   * `radius` 一定要过：走 nearest() 来的候选它自己已经卡过 PICK_RADIUS，
   * 但卡车是直接递进来的。漏掉这一道的后果是**扛着油桶点地图任何一处，
   * 人都会掉头往卡车走** —— 玩家连"往这边挪两步"都做不到。
   */
  const offer = (
    target: Vec2 | null | undefined,
    reach: number,
    intent: ClickIntent,
    radius = PICK_RADIUS,
  ): void => {
    if (!target) return;
    const vx = target.x - point.x;
    const vz = target.z - point.z;
    const along = vx * forward.x + vz * forward.z;
    if (along < ALONG_MIN || along > ALONG_MAX) return;
    // 垂距：把向量减掉沿视线的分量，剩下的长度。等价于叉积的绝对值（forward 是单位向量）。
    const perp = Math.abs(vx * -forward.z + vz * forward.x);
    if (perp > radius) return;
    candidates.push({ target, reach, intent, perp, along });
  };

  /*
   * 扛着东西时能做的事只有两件：装车，或者放下。
   *
   * 放下是"就地"动作，没有可点的目标；所以扛着油桶时唯一有意义的点击目标是卡车。
   * 扛着别的东西（石头、木桩）时干脆不给任何选中 —— 点击退回纯移动，
   * 和现在的行为一模一样。攻击这条路也是断的：hasAttackTargetInRange
   * 在 carrying 非空时直接返回 false，手上占着东西挥不动刀。
   */
  if (context.carrying) {
    if (context.carrying === "fuel") offer(context.truck, TRUCK_LOAD_REACH, "interact", TRUCK_PICK_RADIUS);
  } else {
    // 油满了，卡车本身就是"上车走人"这个动作的目标。
    if (context.truck.loaded >= FUEL_REQUIRED) offer(context.truck, TRUCK_BOARD_REACH, "interact", TRUCK_PICK_RADIUS);

    // accept 的判定和 getInteractionHint 那张优先级表逐条对齐：
    // 砍空的树桩、提干的井、挖空的矿、已经装车的桶，都不该还能被点中。
    offer(nearest(context.barrels, point, PREFILTER_RADIUS,
      { accept: (barrel) => barrel.placement === "ground" }), FUEL_PICKUP_REACH, "interact");
    offer(nearest(context.items, point, PREFILTER_RADIUS,
      { accept: (item) => item.active }), 2.5, "interact");
    offer(nearest(context.structures, point, PREFILTER_RADIUS,
      { accept: (structure) => structure.active }), 2.7, "interact");
    offer(nearest(context.cacti, point, PREFILTER_RADIUS,
      { accept: (patch) => patch.juice > 0 }), 2.7, "interact");
    offer(nearest(context.ironNodes, point, PREFILTER_RADIUS,
      { accept: (node) => node.ore > 0 }), 2.8, "interact");
    offer(nearest(context.trees, point, PREFILTER_RADIUS,
      { accept: (tree) => tree.wood > 0 }), TREE_REACH, "interact");

    const well = nearest(context.wells, point, PREFILTER_RADIUS, {
      accept: (state) => state.charges > 0,
      positionOf: (state) => context.world.wells[state.id],
    });
    if (well) offer(context.world.wells[well.id], WELL_REACH, "interact");

    offer(nearest(context.wolves, point, PREFILTER_RADIUS,
      { accept: (wolf) => wolf.mode !== "dead" }), context.attackRange, "attack");
    offer(nearest(context.critters, point, PREFILTER_RADIUS,
      { accept: (critter) => critter.mode !== "dead" }), context.attackRange, "attack");
  }

  /*
   * 离点击点最近的那个赢，不按种类排优先级。
   *
   * 玩家看着屏幕点的是**某个具体的东西**，那一下的意思就是"离我光标最近的这个"。
   * 引入种类优先级（比如"狼永远优先"）会造出一种很难解释的失败：
   * 明明点的是树，人却朝旁边的狗冲过去了。
   */
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (!best) { best = candidate; continue; }
    // 先比垂距（点得准不准），打平再比谁离命中点近（|along| 小的那个脚就在这儿）。
    if (candidate.perp < best.perp - 0.01) { best = candidate; continue; }
    if (candidate.perp < best.perp + 0.01 && Math.abs(candidate.along) < Math.abs(best.along)) best = candidate;
  }
  return best ? { target: best.target, reach: best.reach, intent: best.intent } : null;
}
