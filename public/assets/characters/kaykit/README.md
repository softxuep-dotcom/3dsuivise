# KayKit player assets

Runtime files used by the player renderer:

- `Rogue_Hooded.glb` — KayKit Adventurers Character Pack 2.0.
- `Rig_Medium_MovementBasic.glb` — walking and running animations.
- `Rig_Medium_General.glb` — idle and hit animations.
- `Rig_Medium_CombatMelee.glb` — club and spear attack animations.

The shipping GLBs are trimmed and Meshopt-compressed by
`authoring/assets/optimize_kaykit_player.mjs`. Only the six clips used by the
game are retained; the three animation mannequin meshes are removed. The four
runtime files total about 647 KiB. Three.js loads them with its Meshopt decoder.

Source: Kay Lousberg's KayKit packs on itch.io.

- https://kaylousberg.itch.io/kaykit-adventurers
- https://kaylousberg.itch.io/kaykit-character-animations

Both packs are released under CC0 and may be used commercially. The original
license notices are preserved beside the assets.
