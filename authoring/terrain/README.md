# Ember Ridge terrain source

`ember_ridge_map.blend` is generated from the same map blueprint used by the browser runtime.

- Blueprint: `src/game/content/mapBlueprint.json`
- Generator: `authoring/terrain/build_map.py`
- Blender: 5.2 LTS
- Horizontal axes: Blender X/Y map to game X/Z
- Vertical axis: Blender Z maps to game Y

Collections in the source file:

- `TERRAIN`: the authored height mesh and terrain materials
- `CAMPS`: camp walls, fire markers, entrance boulders, and biome silhouettes
- `LANDMARKS`: ridge outcrops and sparse trees
- `GAMEPLAY_MARKERS`: named camp centers and entrances

Regenerate from the repository root:

```powershell
& '.tools\blender-5.2.0-windows-x64\blender.exe' --background --factory-startup --python 'authoring\terrain\build_map.py'
```

The browser generates its runtime mesh from the blueprint instead of shipping the `.blend` file. This keeps the first download small while preserving an editable source scene.
