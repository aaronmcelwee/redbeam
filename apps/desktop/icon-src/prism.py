# REDBEAM icon: glass prism splitting a white beam into a red beam. Blender 4.x/5.x, Cycles.
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix
argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(os.getcwd(), "prism_render.png")
SAMPLES = int(argv[1]) if len(argv) > 1 else 64
RES = int(argv[2]) if len(argv) > 2 else 1024
DEVICE = argv[3] if len(argv) > 3 else "CPU"
VT = argv[4] if len(argv) > 4 else "AgX"
SMALL = len(argv) > 5 and argv[5] == "small"
BK = 2.6 if SMALL else 1.0

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
cy = sc.cycles
cy.samples = SAMPLES
cy.use_denoising = True
cy.max_bounces = 24; cy.transmission_bounces = 24; cy.glossy_bounces = 12; cy.transparent_max_bounces = 16
cy.caustics_reflective = True; cy.caustics_refractive = True
if DEVICE != "CPU":
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for t in (DEVICE, 'OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
        try:
            prefs.compute_device_type = t; prefs.get_devices()
            if any(d.type == t for d in prefs.devices):
                for d in prefs.devices: d.use = (d.type == t)
                cy.device = 'GPU'; print("GPU:", t); break
        except Exception: pass
sc.render.resolution_x = sc.render.resolution_y = RES
sc.render.film_transparent = True
sc.view_settings.view_transform = VT
try: sc.view_settings.look = 'AgX - Punchy'
except Exception: pass
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
sc.render.image_settings.color_depth = '16'

def mat_emit(name, rgb, strength):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*rgb, 1); e.inputs[1].default_value = strength
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o.inputs[0]); return m

# --- world: near-black with a faint cool tone
w = bpy.data.worlds.new("W"); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes.get('Background'); bg.inputs[0].default_value = (0.012, 0.014, 0.02, 1); bg.inputs[1].default_value = 1.0

# --- prism (equilateral, apex up), extruded along Y (depth away from camera)
R, L = 1.55, 1.7
bm = bmesh.new()
pts = [(R*math.cos(math.pi/2 + i*2*math.pi/3), R*math.sin(math.pi/2 + i*2*math.pi/3)) for i in range(3)]
front = [bm.verts.new((x, -L/2, z)) for x, z in pts]
back = [bm.verts.new((x, L/2, z)) for x, z in pts]
bm.faces.new(front[::-1]); bm.faces.new(back)
for i in range(3):
    j = (i+1) % 3; bm.faces.new((front[i], front[j], back[j], back[i]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("Prism"); bm.to_mesh(me); bm.free()
prism = bpy.data.objects.new("Prism", me); sc.collection.objects.link(prism)
bev = prism.modifiers.new("Bevel", 'BEVEL'); bev.width = 0.045; bev.segments = 6; bev.limit_method = 'ANGLE'
for p in me.polygons: p.use_smooth = True
try: prism.modifiers.new("WN", 'WEIGHTED_NORMAL')
except Exception: pass
g = bpy.data.materials.new("Glass"); g.use_nodes = True
pb = g.node_tree.nodes.get('Principled BSDF')
pb.inputs['Base Color'].default_value = (0.97, 0.985, 1.0, 1)
pb.inputs['Roughness'].default_value = 0.0
pb.inputs['IOR'].default_value = 1.52
pb.inputs['Transmission Weight'].default_value = 1.0
prism.data.materials.append(g)
pz = -1.3 + R*0.5      # base sits on floor
prism.location = (0, 0, pz)
prism.rotation_euler = (0, 0, math.radians(8 if SMALL else 18))

# --- floor: glossy black
bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, -1.3))
fl = bpy.context.object
fm = bpy.data.materials.new("Floor"); fm.use_nodes = True
nt = fm.node_tree
fp = nt.nodes.get('Principled BSDF')
fp.inputs['Base Color'].default_value = (0.004, 0.004, 0.005, 1)
fp.inputs['Roughness'].default_value = 0.2
tc = nt.nodes.new('ShaderNodeTexCoord'); mp = nt.nodes.new('ShaderNodeMapping')
mp.inputs['Location'].default_value = (-1, -1, 0); mp.inputs['Scale'].default_value = (2, 2, 1)
gt = nt.nodes.new('ShaderNodeTexGradient'); gt.gradient_type = 'SPHERICAL'
cr = nt.nodes.new('ShaderNodeValToRGB'); cr.color_ramp.elements[0].position = 0.0; cr.color_ramp.elements[1].position = 0.55
tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mx = nt.nodes.new('ShaderNodeMixShader')
out = nt.nodes.get('Material Output')
nt.links.new(tc.outputs['Generated'], mp.inputs['Vector']); nt.links.new(mp.outputs[0], gt.inputs[0]); nt.links.new(gt.outputs['Fac'], cr.inputs[0])
nt.links.new(cr.outputs[0], mx.inputs[0]); nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(fp.outputs[0], mx.inputs[2]); nt.links.new(mx.outputs[0], out.inputs[0])
fl.data.materials.append(fm)
if len(argv) > 6 and argv[6] == 'nofloor': fl.hide_render = True

# --- beams (emissive cylinders), in prism-local frame then parented
def beam(a, b, r0, r1, rgb, strength, name):
    a, b = Vector(a), Vector(b); d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r0, radius2=r1, depth=d.length, end_fill_type='NOTHING')
    o = bpy.context.object; o.name = name
    o.location = (a + b) / 2
    o.rotation_mode = 'QUATERNION'; o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.data.materials.append(mat_emit(name+"M", rgb, strength))
    for p in o.data.polygons: p.use_smooth = True
    o.parent = prism; o.matrix_parent_inverse = prism.matrix_world.inverted()
    # beams shouldn't cast shadows / show as solid in glass reflections too strongly
    return o
bpy.context.view_layer.update()
M = prism.matrix_world
def P(x, z, y=-0.15): return M @ Vector((x, y, z))
ent = P(-0.66, 0.39); ex = P(0.80, 0.16)
beam(P(-9, -0.55), ent, 0.028*BK, 0.028*BK, (1, 1, 1), 20, "BeamIn")
beam(ent, ex, 0.02*BK, 0.026*BK, (1.0, 0.25, 0.2), 4, "BeamInside")
beam(ex, P(9, -0.75), 0.03*BK, 0.42*(1.6 if SMALL else 1), (1.0, 0.0, 0.0), 6, "BeamOut")
beam(ex, P(9, -0.75), 0.012*BK, 0.09*BK, (1.0, 0.06, 0.03), 9, "BeamOutCore")

# --- lights: studio softboxes
def area(name, loc, rot, size, sizey, energy, rgb=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA'); l.shape = 'RECTANGLE'; l.size = size; l.size_y = sizey; l.energy = energy; l.color = rgb
    o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.location = loc; o.rotation_euler = [math.radians(v) for v in rot]
    return o
area("Top", (0, 0.5, 6), (0, 0, 0), 5, 2.5, 900)
area("LeftStrip", (-5, -3, 2.5), (90, 0, -55), 0.6, 4, 300)
area("RightRim", (5, 4, 2), (90, 0, 140), 0.8, 6, 700, (0.85, 0.9, 1.0))
area("BackHalo", (0, 9, 3.5), (90, 0, 180), 9, 4, 250, (0.75, 0.8, 1.0))

# --- camera
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 125 if SMALL else 100
cam.location = (0, -12.5, 0.9)
tgt = Vector((0, 0, -0.45 if SMALL else -0.3)); cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.dof.use_dof = False

sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("WROTE", OUT)
