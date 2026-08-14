# 动物模型

来源：**Quaternius — Ultimate Animated Animal Pack**（2021-07）
<https://quaternius.com/packs/ultimateanimatedanimals.html>

许可：**CC0 1.0**（<https://creativecommons.org/publicdomain/zero/1.0/>）—— 公有领域，
无需署名、可商用。这份说明留在这里是为了记住**东西是从哪来的**，不是许可要求。

## 这里只有两个文件，是刻意的

原包有 12 只动物、每只 12~13 个动画，整包 40 MB 级。我们只取用得到的：

| 文件 | 用途 | 保留的片段 |
| --- | --- | --- |
| `Wolf.glb` | 全部三档狗（野狗 / 壮犬 / 头犬，靠高度和毛色分档） | Idle, Walk, Gallop, Attack, Death |
| `Deer.glb` | 长角羚 | Walk, Gallop, Death |

其余十只动物**连下载都没有下载**。片段也只留模拟层真的会进入的状态 ——
鹿没有 `Idle`（猎物在模拟层里永远在动，吃草也有 1.4 的移速），也没有 `Attack`（猎物不打人）。

狼的 `Idle` 是个例外，留着有两个理由，第二个是实测出来的：它是 `syncWolfAnimation` 的
兜底分支；而且**删掉它反而更大**（331 → 351 KiB）—— `Idle` 有 3.33 秒但几乎全是常量通道，
留着它 `dedup()` 能把这些常量和别的片段合并，删掉之后反倒没得合并了。
"少一个片段 = 小一点"在这条流水线上不成立，得实测。

## 怎么重新生成

从上面的链接下载 glTF 目录（原始文件是自带 base64 缓冲的单文件 `.gltf`，每只 3 MB 出头），
然后：

```bash
node authoring/assets/optimize_quaternius_animals.mjs <原始 gltf 目录> public/assets/animals
```

脚本干三件事：删掉没列进白名单的动画、删掉**恒定且等于静止姿势**的动画通道、meshopt 压缩。
第二条是大头 —— Blender 给每根骨头的每个片段都写满 T/R/S 三条轨道，
狼有 765 条通道里 593 条是常量。实测：

| | 原始 | 产物 |
| --- | ---: | ---: |
| Wolf | 3101 KiB / 12 片段 | **331 KiB** / 5 片段 |
| Deer | 3212 KiB / 13 片段 | **363 KiB** / 3 片段 |

> 试过不用 meshopt（JSON 头会小很多），结果反而涨到 1.2~1.6 MB —— meshopt 对动画轨道的
> 压缩率远超它带来的 bufferView 膨胀。也试过把重采样容差放宽 50 倍，只省 1%。
