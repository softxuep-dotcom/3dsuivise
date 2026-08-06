import bpy
import json
import math
import random
from pathlib import Path
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "authoring" / "terrain"
BLUEPRINT_PATH = ROOT / "src" / "game" / "content" / "mapBlueprint.json"
BLEND_PATH = SOURCE_DIR / "ember_ridge_map.blend"
OVERVIEW_PATH = SOURCE_DIR / "preview_overview.png"
START_PATH = SOURCE_DIR / "preview_start_camp.png"

with BLUEPRINT_PATH.open("r", encoding="utf-8") as handle:
    BLUEPRINT = json.load(handle)


def clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def lerp(a, b, amount):
    return a + (b - a) * amount


def smoothstep(edge0, edge1, value):
    amount = clamp((value - edge0) / max(0.0001, edge1 - edge0), 0.0, 1.0)
    return amount * amount * (3.0 - 2.0 * amount)


def imul(a, b):
    return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF


def hash2(x, y, seed):
    value = (imul(x, 374761393) + imul(y, 668265263) + imul(seed, 1442695041)) & 0xFFFFFFFF
    value = imul(value ^ (value >> 13), 1274126177)
    return ((value ^ (value >> 16)) & 0xFFFFFFFF) / 4294967295.0


def value_noise(x, y, seed):
    ix = math.floor(x)
    iy = math.floor(y)
    fx = x - ix
    fy = y - iy
    sx = fx * fx * (3.0 - 2.0 * fx)
    sy = fy * fy * (3.0 - 2.0 * fy)
    a = lerp(hash2(ix, iy, seed), hash2(ix + 1, iy, seed), sx)
    b = lerp(hash2(ix, iy + 1, seed), hash2(ix + 1, iy + 1, seed), sx)
    return lerp(a, b, sy) * 2.0 - 1.0


def base_height(x, y):
    seed = BLUEPRINT["seed"]
    height = value_noise(x / 34.0, y / 34.0, seed) * 0.72
    height += value_noise(x / 16.0, y / 16.0, seed + 31) * 0.28
    height += value_noise(x / 7.5, y / 7.5, seed + 79) * 0.08
    for ridge in BLUEPRINT["ridges"]:
        dx = x - ridge["x"]
        dy = y - ridge["z"]
        cosine = math.cos(-ridge["rotation"])
        sine = math.sin(-ridge["rotation"])
        local_x = dx * cosine - dy * sine
        local_y = dx * sine + dy * cosine
        q = local_x * local_x / (ridge["scaleX"] ** 2) + local_y * local_y / (ridge["scaleZ"] ** 2)
        if q < 1.0:
            height += ridge["height"] * ((1.0 - q) ** 2)
    return height


def shape_camp(height, camp, camp_id, x, y):
    dx = x - camp["x"]
    dy = y - camp["z"]
    radius = 11.0
    distance = math.hypot(dx, dy)
    plateau = 1.0 - smoothstep(radius - 1.8, radius + 5.8, distance)
    detail = math.sin((x + camp_id * 13) * 0.42) * math.cos((y - camp_id * 7) * 0.37) * 0.035
    result = lerp(height, camp["elevation"] + detail, plateau)
    angle = math.atan2(dy, dx)
    angle_difference = abs((angle - camp["entranceAngle"] + math.pi) % math.tau - math.pi)
    gap_edge = (0.19 if camp["kind"] == "deep-cave" else 0.32 if camp["kind"] == "windy-ridge" else 0.25) + (0.3 if camp["kind"] == "deep-cave" else 0.42)
    entrance_width = 0.19 if camp["kind"] == "deep-cave" else 0.32 if camp["kind"] == "windy-ridge" else 0.25
    closed_side = smoothstep(entrance_width * 0.72, gap_edge, angle_difference)
    inner_ring = smoothstep(radius - 4.8, radius - 0.2, distance)
    outer_ring = 1.0 - smoothstep(radius + 1.3, radius + 7.2, distance)
    ring = inner_ring * outer_ring
    back_facing = smoothstep(0.25, 1.0, (1.0 - math.cos(angle_difference)) * 0.5)
    wall_height = 5.2 if camp["kind"] == "deep-cave" else 2.4 if camp["kind"] == "windy-ridge" else 2.75
    enclosure = 0.48 + back_facing * 0.52 if camp["kind"] == "abandoned-camp" else 1.0
    result += ring * closed_side * enclosure * wall_height
    forward_x = math.cos(camp["entranceAngle"])
    forward_y = math.sin(camp["entranceAngle"])
    along = dx * forward_x + dy * forward_y
    across = abs(-dx * forward_y + dy * forward_x)
    if radius - 4.0 < along < radius + 22.0 and across < 6.2:
        lane = 1.0 - smoothstep(3.4, 6.2, across)
        start = smoothstep(radius - 4.0, radius + 1.0, along)
        end = 1.0 - smoothstep(radius + 15.0, radius + 22.0, along)
        ramp_t = smoothstep(radius - 1.0, radius + 19.0, along)
        target = lerp(camp["elevation"], height, ramp_t)
        result = lerp(result, target, lane * start * end)
    return result


def terrain_height(x, y):
    height = base_height(x, y)
    for camp_id, camp in enumerate(BLUEPRINT["camps"]):
        height = shape_camp(height, camp, camp_id, x, y)
    return height


def terrain_slope(x, y, distance=0.9):
    dx = (terrain_height(x + distance, y) - terrain_height(x - distance, y)) / (distance * 2.0)
    dy = (terrain_height(x, y + distance) - terrain_height(x, y - distance)) / (distance * 2.0)
    return math.hypot(dx, dy)


def terrain_snow(x, y):
    height = terrain_height(x, y)
    slope = terrain_slope(x, y, 1.1)
    drift = value_noise(x / 11.0, y / 11.0, BLUEPRINT["seed"] + 503) * 0.5 + 0.5
    altitude = smoothstep(3.4, 6.2, height)
    return clamp(altitude * (1.0 - smoothstep(0.38, 0.9, slope)) * smoothstep(0.46, 0.76, drift), 0.0, 1.0)


def make_material(name, color, roughness=1.0, emission=None):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    if emission:
        principled.inputs["Emission Color"].default_value = (*emission, 1.0)
        principled.inputs["Emission Strength"].default_value = 2.5
    return material


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    base = bpy.data.collections.get("Collection")
    base.name = "TERRAIN"
    return {
        "terrain": base,
        "camps": bpy.data.collections.new("CAMPS"),
        "landmarks": bpy.data.collections.new("LANDMARKS"),
        "markers": bpy.data.collections.new("GAMEPLAY_MARKERS"),
    }


COLLECTIONS = clear_scene()
for key in ("camps", "landmarks", "markers"):
    bpy.context.scene.collection.children.link(COLLECTIONS[key])

MAT_GRASS = make_material("Ground_DryGrass", (0.34, 0.38, 0.25))
MAT_SOIL = make_material("Ground_Soil", (0.38, 0.31, 0.23))
MAT_ROCK = make_material("Ground_Rock", (0.31, 0.34, 0.32))
MAT_SNOW = make_material("Ground_SparseSnow", (0.68, 0.75, 0.72))
MAT_WALL = make_material("Camp_Rock", (0.28, 0.31, 0.29))
MAT_WOOD = make_material("Old_Wood", (0.28, 0.19, 0.12))
MAT_FIRE = make_material("Fire_Marker", (1.0, 0.21, 0.03), 0.6, (1.0, 0.08, 0.01))
MAT_FLAG = make_material("Wind_Flag", (0.43, 0.18, 0.10))
MAT_PATH = make_material("Ground_WornPath", (0.42, 0.31, 0.19))
MAT_COVER = make_material("Ground_DryCover", (0.28, 0.34, 0.19))


def move_to_collection(obj, collection):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)


def add_rock(name, x, y, z, scale=(1.0, 1.0, 1.0), rotation=(0.0, 0.0, 0.0), material=MAT_WALL, collection=None):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.0, location=(x, y, z), rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(material)
    move_to_collection(obj, collection or COLLECTIONS["landmarks"])
    return obj


size = BLUEPRINT["size"] + 8.0
segments = BLUEPRINT["resolution"]
vertices = []
faces = []
for row in range(segments + 1):
    y = -size / 2.0 + size * row / segments
    for column in range(segments + 1):
        x = -size / 2.0 + size * column / segments
        vertices.append((x, y, terrain_height(x, y)))
for row in range(segments):
    for column in range(segments):
        a = row * (segments + 1) + column
        faces.append((a, a + 1, a + segments + 2, a + segments + 1))

mesh = bpy.data.meshes.new("EmberRidge_Heightfield")
mesh.from_pydata(vertices, [], faces)
mesh.materials.clear()
for material in (MAT_GRASS, MAT_SOIL, MAT_ROCK, MAT_SNOW):
    mesh.materials.append(material)
terrain = bpy.data.objects.new("TERRAIN_Heightfield", mesh)
COLLECTIONS["terrain"].objects.link(terrain)
for polygon in mesh.polygons:
    center = terrain.data.vertices[polygon.vertices[0]].co
    x, y = center.x, center.y
    slope = terrain_slope(x, y)
    snow = terrain_snow(x, y)
    in_camp = any(math.hypot(x - camp["x"], y - camp["z"]) < 10.5 for camp in BLUEPRINT["camps"])
    polygon.material_index = 3 if snow > 0.28 else 2 if slope > 0.5 else 1 if in_camp else 0

trail_vertices = []
trail_faces = []
for camp_id, camp in enumerate(BLUEPRINT["camps"]):
    forward_x = math.cos(camp["entranceAngle"])
    forward_y = math.sin(camp["entranceAngle"])
    side_x, side_y = -forward_y, forward_x
    start_vertex = len(trail_vertices)
    for step in range(19):
        amount = step / 18.0
        along = 8.0 + amount * 29.0
        bend = math.sin(amount * math.pi) * math.sin(camp_id * 2.17) * 2.1
        center_x = camp["x"] + forward_x * along + side_x * bend
        center_y = camp["z"] + forward_y * along + side_y * bend
        width = 1.55 * (0.18 + math.sin(amount * math.pi) * 0.82)
        for direction in (-1.0, 1.0):
            x = center_x + side_x * width * direction
            y = center_y + side_y * width * direction
            trail_vertices.append((x, y, terrain_height(x, y) + 0.045))
        if step < 18:
            row = start_vertex + step * 2
            trail_faces.append((row, row + 1, row + 3, row + 2))
trail_mesh = bpy.data.meshes.new("Camp_Trail_Ribbons")
trail_mesh.from_pydata(trail_vertices, [], trail_faces)
trail_mesh.materials.append(MAT_PATH)
trails = bpy.data.objects.new("TERRAIN_WornTrails", trail_mesh)
COLLECTIONS["terrain"].objects.link(trails)

cover_vertices = []
cover_faces = []
cover_random = random.Random(BLUEPRINT["seed"] + 4403)
cover_count = 0
cover_attempts = 0
while cover_count < 520 and cover_attempts < 9000:
    cover_attempts += 1
    x = cover_random.uniform(-105, 105)
    y = cover_random.uniform(-105, 105)
    if terrain_slope(x, y) > 0.5:
        continue
    if any(math.hypot(x - camp["x"], y - camp["z"]) < 10.0 for camp in BLUEPRINT["camps"]):
        continue
    base = len(cover_vertices)
    scale = cover_random.uniform(0.35, 0.82)
    angle = cover_random.uniform(0.0, math.tau)
    side_x = math.cos(angle) * 0.18 * scale
    side_y = math.sin(angle) * 0.18 * scale
    height = terrain_height(x, y) + 0.02
    cover_vertices.extend([
        (x - side_x, y - side_y, height),
        (x + side_x, y + side_y, height),
        (x + math.sin(angle) * 0.06, y + math.cos(angle) * 0.06, height + 0.68 * scale),
    ])
    cover_faces.append((base, base + 1, base + 2))
    cover_count += 1
cover_mesh = bpy.data.meshes.new("Ground_Cover_Tufts")
cover_mesh.from_pydata(cover_vertices, [], cover_faces)
cover_mesh.materials.append(MAT_COVER)
cover = bpy.data.objects.new("LANDMARKS_DryGroundCover", cover_mesh)
COLLECTIONS["landmarks"].objects.link(cover)

for ridge_id, ridge in enumerate(BLUEPRINT["ridges"]):
    for rock_id in range(3):
        along = (rock_id - 1) * ridge["scaleX"] * 0.18
        x = ridge["x"] + math.cos(ridge["rotation"]) * along + math.sin(ridge["rotation"]) * (1.1 if rock_id % 2 else -0.8)
        y = ridge["z"] + math.sin(ridge["rotation"]) * along - math.cos(ridge["rotation"]) * (1.1 if rock_id % 2 else -0.8)
        rock_height = 0.9 + (ridge_id % 4) * 0.28 + rock_id * 0.16
        add_rock(
            f"RIDGE_{ridge_id:02d}_Outcrop_{rock_id}", x, y, terrain_height(x, y) + rock_height * 0.42,
            (1.2 + rock_id * 0.32, 0.9 + (ridge_id % 3) * 0.22, rock_height),
            (rock_id * 0.34, 0.0, ridge["rotation"] + rock_id * 0.8),
        )

for camp_id, camp in enumerate(BLUEPRINT["camps"]):
    cx, cy = camp["x"], camp["z"]
    elevation = terrain_height(cx, cy)
    marker = bpy.data.objects.new(f"CAMP_{camp_id:02d}_{camp['kind']}_CENTER", None)
    marker.location = (cx, cy, elevation + 0.2)
    marker.empty_display_type = "CIRCLE"
    marker.empty_display_size = 2.0
    COLLECTIONS["markers"].objects.link(marker)
    entrance_x = cx + math.cos(camp["entranceAngle"]) * 13.0
    entrance_y = cy + math.sin(camp["entranceAngle"]) * 13.0
    entrance = bpy.data.objects.new(f"CAMP_{camp_id:02d}_ENTRANCE", None)
    entrance.location = (entrance_x, entrance_y, terrain_height(entrance_x, entrance_y) + 0.2)
    entrance.empty_display_type = "ARROWS"
    entrance.rotation_euler[2] = camp["entranceAngle"]
    COLLECTIONS["markers"].objects.link(entrance)

    width = 0.19 if camp["kind"] == "deep-cave" else 0.32 if camp["kind"] == "windy-ridge" else 0.25
    segments = 18 if camp["kind"] == "deep-cave" else 15 if camp["kind"] == "abandoned-camp" else 13
    for segment in range(segments):
        angle = segment / float(segments) * math.tau
        difference = abs((angle - camp["entranceAngle"] + math.pi) % math.tau - math.pi)
        if difference < width:
            continue
        x = cx + math.cos(angle) * 11.0
        y = cy + math.sin(angle) * 11.0
        add_rock(
            f"CAMP_{camp_id:02d}_Wall_{segment:02d}", x, y, terrain_height(x, y) + 0.7,
            (1.45 + (segment % 3) * 0.14, 1.18 + (segment % 2) * 0.12, 1.65 + (segment % 4) * 0.18),
            (segment * 0.13, segment * 0.07, angle), MAT_WALL, COLLECTIONS["camps"],
        )

    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.72, depth=1.0, location=(cx, cy, elevation + 0.5))
    fire = bpy.context.object
    fire.name = f"CAMP_{camp_id:02d}_Fire"
    fire.data.materials.append(MAT_FIRE)
    move_to_collection(fire, COLLECTIONS["camps"])

    inward = 8.9
    stone_x = cx + math.cos(camp["entranceAngle"]) * inward
    stone_y = cy + math.sin(camp["entranceAngle"]) * inward
    add_rock(
        f"CAMP_{camp_id:02d}_MovableBoulder", stone_x, stone_y, terrain_height(stone_x, stone_y) + 0.8,
        (1.55, 1.3, 1.1), (0.1, 0.22, camp["entranceAngle"]), MAT_WALL, COLLECTIONS["camps"],
    )

    back = camp["entranceAngle"] + math.pi
    if camp["kind"] == "deep-cave":
        for offset in (-1, 0, 1):
            angle = back + offset * 0.16
            x = cx + math.cos(angle) * 8.2
            y = cy + math.sin(angle) * 8.2
            scale = (2.1, 1.7, 2.8 if offset == 0 else 2.0)
            add_rock(f"CAMP_{camp_id:02d}_CaveArch_{offset+1}", x, y, terrain_height(x, y) + scale[2] * 0.42, scale, material=MAT_WALL, collection=COLLECTIONS["camps"])
    elif camp["kind"] == "windy-ridge":
        x = cx + math.cos(back) * 5.8
        y = cy + math.sin(back) * 5.8
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.1, depth=5.2, location=(x, y, elevation + 2.6))
        pole = bpy.context.object
        pole.name = f"CAMP_{camp_id:02d}_WindMast"
        pole.data.materials.append(MAT_WOOD)
        move_to_collection(pole, COLLECTIONS["camps"])
        bpy.ops.mesh.primitive_cube_add(location=(x + 0.8, y, elevation + 4.1), scale=(0.85, 0.05, 0.38))
        flag = bpy.context.object
        flag.name = f"CAMP_{camp_id:02d}_WindFlag"
        flag.data.materials.append(MAT_FLAG)
        move_to_collection(flag, COLLECTIONS["camps"])
    else:
        for crate_id in range(3):
            angle = back + 0.35
            radius = 4.8 + crate_id * 1.15
            x = cx + math.cos(angle) * radius
            y = cy + math.sin(angle) * radius
            bpy.ops.mesh.primitive_cube_add(location=(x, y, terrain_height(x, y) + 0.45), scale=(0.62, 0.52, 0.45))
            crate = bpy.context.object
            crate.name = f"CAMP_{camp_id:02d}_RuinedCrate_{crate_id}"
            crate.rotation_euler[2] = back + crate_id * 0.4
            crate.data.materials.append(MAT_WOOD)
            move_to_collection(crate, COLLECTIONS["camps"])
        shelter_angle = back - 0.55
        shelter_x = cx + math.cos(shelter_angle) * 5.4
        shelter_y = cy + math.sin(shelter_angle) * 5.4
        bpy.ops.mesh.primitive_plane_add(size=2.0, location=(shelter_x, shelter_y, elevation + 1.55))
        lean_to = bpy.context.object
        lean_to.name = f"CAMP_{camp_id:02d}_TornLeanTo"
        lean_to.scale = (1.85, 1.3, 1.0)
        lean_to.rotation_euler = (0.52, 0.0, shelter_angle)
        lean_to.data.materials.append(MAT_SOIL)
        move_to_collection(lean_to, COLLECTIONS["camps"])
        fence_angle = back + 1.1
        fence_x = cx + math.cos(fence_angle) * 6.5
        fence_y = cy + math.sin(fence_angle) * 6.5
        bpy.ops.mesh.primitive_cube_add(location=(fence_x, fence_y, elevation + 0.72), scale=(2.4, 0.11, 0.08))
        fence = bpy.context.object
        fence.name = f"CAMP_{camp_id:02d}_BrokenFence"
        fence.rotation_euler = (0.0, -0.18, back - 0.35)
        fence.data.materials.append(MAT_WOOD)
        move_to_collection(fence, COLLECTIONS["camps"])

random.seed(BLUEPRINT["seed"] + 2026)
tree_count = 0
attempts = 0
while tree_count < 34 and attempts < 1200:
    attempts += 1
    x = random.uniform(-103, 103)
    y = random.uniform(-103, 103)
    if terrain_slope(x, y) > 0.42:
        continue
    if any(math.hypot(x - camp["x"], y - camp["z"]) < 14.0 for camp in BLUEPRINT["camps"]):
        continue
    height = terrain_height(x, y)
    bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=1.15, radius2=0.08, depth=3.8, location=(x, y, height + 2.7))
    tree = bpy.context.object
    tree.name = f"TREE_{tree_count:03d}"
    tree.scale = (random.uniform(0.65, 1.1), random.uniform(0.65, 1.1), random.uniform(0.8, 1.3))
    tree.data.materials.append(MAT_GRASS)
    move_to_collection(tree, COLLECTIONS["landmarks"])
    tree_count += 1


def point_camera(camera, target):
    direction = Vector(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


bpy.ops.object.light_add(type="SUN", location=(-45, -55, 80))
sun = bpy.context.object
sun.name = "Preview_Sun"
sun.data.energy = 3.2
sun.rotation_euler = (math.radians(28), math.radians(-24), math.radians(-32))
sun.data.color = (1.0, 0.84, 0.66)

bpy.ops.object.light_add(type="AREA", location=(25, -20, 55))
fill = bpy.context.object
fill.name = "Preview_SkyFill"
fill.data.energy = 1600
fill.data.shape = "DISK"
fill.data.size = 85

bpy.ops.object.camera_add(location=(126, -146, 166))
camera = bpy.context.object
camera.name = "Preview_Camera"
camera.data.lens = 56
point_camera(camera, (0, 0, 0))
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1280
scene.render.resolution_y = 820
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False
scene.world.color = (0.055, 0.075, 0.08)
scene.view_settings.look = "AgX - Medium High Contrast"

scene.render.filepath = str(OVERVIEW_PATH)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
bpy.ops.render.render(write_still=True)

camera.location = (-3, -67, 39)
camera.data.lens = 52
point_camera(camera, (-30, -30, 1.0))
scene.render.filepath = str(START_PATH)
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))

print(f"Saved {BLEND_PATH}")
print(f"Rendered {OVERVIEW_PATH}")
print(f"Rendered {START_PATH}")
