# WC3 地图数据解析脚本

用于从解密后的《荒漠幸存者 v1.1》地图（`extracted/extracted/`）提取数值。
分析结论见 [`docs/荒漠幸存者-数值分析.md`](../../../docs/荒漠幸存者-数值分析.md)，
原始输出见 [`docs/data/`](../../../docs/data/)。

## 用法

所有脚本默认读取 `C:\Works\1\3dsuviuos\3dsuivise\extracted\extracted`（在各脚本顶部的 `M` 变量里改路径）。

**Windows 下必须设置 `PYTHONIOENCODING=utf-8`**，否则中文会被控制台的 GBK 编码破坏：

```bash
PYTHONIOENCODING=utf-8 python units.py > units.tsv
```

| 脚本 | 输出 | 说明 |
| --- | --- | --- |
| `slk.py` | — | 通用 SLK 解析库，被其它脚本 import；单独运行可 dump 任意 SLK |
| `units.py` | `units.tsv` | 联结 UnitBalance/UnitData/UnitUI/UnitWeapons/UnitAbilities，输出 51 个自定义单位 |
| `items.py` | `items.txt` | 144 个自定义物品 + tooltip |
| `abils.py` | `abil_all.txt` | 244 个自定义技能的 DataA1~DataI1 / 冷却 / 消耗；可传技能 ID 只看指定几个 |
| `itemuse.py` | `itemuse.txt` | 配对「使用物品」触发器 → 生存轴增减 |
| `drops.py` | `drops.txt` | 击杀掉落表 + 合成触发器原文 |
| `recipes.py` | `recipes.txt` | 解析 `Trig_hc` / `Trig_hc3` 的物品栏比对，还原配方 |
| `index.py` | `trigindex.txt` | 194 个触发器的事件 / 条件 / 动作摘要索引 |
| `dump.py` | stdout | 按函数名正则从 `war3map.j` 里 dump 函数原文，用于逐个深挖 |

`dump.py` 的两个参数分别是「函数名正则」和「函数体正则」（可选）：

```bash
PYTHONIOENCODING=utf-8 python dump.py '_041'                    # 所有名字含 _041 的函数
PYTHONIOENCODING=utf-8 python dump.py '.' 'AdjustPlayerStateBJ' # 所有改玩家资源的函数
```

## 编码备忘

- `.wts` 和所有 `.txt` 对象数据都是 **UTF-8**。
- `war3map.j` 混合编码：库代码注释是 GBK，其余是 UTF-8 —— 统一用 `utf-8 + errors='replace'` 读即可，
  被替换掉的只有库注释，不影响数值。
- SLK（`.text`）是纯 ASCII 骨架，中文只出现在 `.txt` 里，两者靠 rawcode 关联。
