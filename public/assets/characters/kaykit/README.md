# KayKit player assets

Runtime files used by the player renderer:

- `Rogue_Hooded.glb` — KayKit Adventurers Character Pack 2.0.
- `Rig_Medium_MovementBasic.glb` — walking and running animations.
- `Rig_Medium_General.glb` — idle and hit animations.
- `Rig_Medium_CombatMelee.glb` — the one-handed chop attack animation.

The shipping GLBs are trimmed and Meshopt-compressed by
`authoring/assets/optimize_kaykit_player.mjs`. Only the clips used by the game
are retained; the three animation mannequin meshes are removed. The four runtime
files total about 647 KiB. Three.js loads them with its Meshopt decoder.

**Pending regeneration.** Every weapon is now a blade sharing one chop, so
`Melee_2H_Attack_Stab` was dropped from the optimizer's keep-set but is still
present in the committed `Rig_Medium_CombatMelee.glb` — the raw KayKit downloads
are not in this repo, so the file cannot be rebuilt here. Re-run the optimizer
against a local copy of the raw packs to shed the unused clip:

```
node authoring/assets/optimize_kaykit_player.mjs <raw-kaykit-dir> public/assets/characters/kaykit
```

Nothing breaks until then; the extra clip is simply never played.

Source: Kay Lousberg's KayKit packs on itch.io.

- https://kaylousberg.itch.io/kaykit-adventurers
- https://kaylousberg.itch.io/kaykit-character-animations

Both packs are released under CC0 and may be used commercially. The original
license notices are preserved beside the assets.
