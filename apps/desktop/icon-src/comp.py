# composite: gradient background + render + bloom + grain -> square art
import sys, numpy as np
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA'); W = im.width
a = np.asarray(im).astype(np.float32)/255.0
y, x = np.mgrid[0:W, 0:W]/W
top = np.array([0.16,0.18,0.23]); mid = np.array([0.07,0.075,0.095]); bot = np.array([0.02,0.02,0.025])
t = y[...,None]
bg = np.where(t<0.55, top+(mid-top)*(t/0.55), mid+(bot-mid)*((t-0.55)/0.45))
halo = np.exp(-(((x-0.5)/0.32)**2+((y-0.38)/0.26)**2))[...,None]
bg = bg + halo*np.array([0.09,0.10,0.13])
rgb = a[...,:3]*a[...,3:4] + bg*(1-a[...,3:4])
# bloom from bright pixels
br = np.clip(rgb.max(-1,keepdims=True)-0.6,0,1)/0.4 * rgb
bimg = Image.fromarray((np.clip(br,0,1)*255).astype(np.uint8))
bl = sum(np.asarray(bimg.filter(ImageFilter.GaussianBlur(W*r))).astype(np.float32)/255*w for r,w in ((0.006,0.5),(0.02,0.5),(0.06,0.6)))
rgb = 1-(1-rgb)*(1-np.clip(bl,0,1))   # screen
rgb += (np.random.default_rng(1).random(rgb.shape)-0.5)/255*2
Image.fromarray((np.clip(rgb,0,1)*255).astype(np.uint8)).save(out)
