from __future__ import print_function

import numpy as np

import neuroglancer
from tifffile import imread
from skimage import io

import webbrowser
import time
import os
import matplotlib.pyplot as plt
import PIL as pil
import copy


# Address
neuroglancer.set_server_bind_address('127.0.0.1')
neuroglancer.set_static_content_source(url='http://localhost:8080')

# Data
img = imread('sample.tif')
img = img * 10 / 256
img = img.astype('uint8')
img = np.transpose(img, (1, 0, 2, 3))

img2 = copy.deepcopy(img)

# Maximum projection
# All Layers, axis = 0 for z-axis since tiff file is Z x X x Y for each RGB channel
img2[0][:] = np.max(img2[0], axis=0)
img2[1][:] = np.max(img2[1], axis=0)
img2[2][:] = np.max(img2[2], axis=0)
# +/- five layers
img3 = copy.deepcopy(img)
zSize = len(img3[0]) - 1
numLayers = 5 # Constant, can change to select the number of layers to calculate z-projection
# Red Channel
for i in range(0, 136):
    layerList = [] 
    for j in range(0, numLayers):
        layerList.append(img[0][max(0, i-numLayers+j)])
    layerList.append(img[0][i])
    for j in range(1, numLayers+1):
        layerList.append(img[0][min(zSize, i+j)])
    img3[0][i] = np.maximum.reduce(layerList)
# Green Channel
for i in range(0, 136):
    layerList = [] 
    for j in range(0, numLayers):
        layerList.append(img[1][max(0, i-numLayers+j)])
    layerList.append(img[1][i])
    for j in range(1, numLayers+1):
        layerList.append(img[1][min(zSize, i+j)])
    img3[1][i] = np.maximum.reduce(layerList)
# Blue Channel
for i in range(0, 136):
    layerList = [] 
    for j in range(0, numLayers):
        layerList.append(img[2][max(0, i-numLayers+j)])
    layerList.append(img[2][i])
    for j in range(1, numLayers+1):
        layerList.append(img[2][min(zSize, i+j)])
    img3[2][i] = np.maximum.reduce(layerList)

# Viewer
viewer = neuroglancer.Viewer()
dimensions = neuroglancer.CoordinateSpace(
    names=['x', 'y', 'z'],
    units='nm',
    scales=[10, 10, 10])

with viewer.txn() as s:
    s.dimensions = dimensions
    s.layers.append(
        name='image',
        layer=neuroglancer.LocalVolume(
            data=img,
            dimensions=neuroglancer.CoordinateSpace(
                names=['c^', 'x', 'y', 'z'],
                units=['', 'nm', 'nm', 'nm'],
                scales=[1, 10, 10, 10]),
            voxel_offset=(0, 0, 0, 0),
        ),
        shader='''
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}        
''')
    s.layers.append(
        name='image',
        layer=neuroglancer.LocalVolume(
            data=img3,
            dimensions=neuroglancer.CoordinateSpace(
                names=['c^', 'x', 'y', 'z'],
                units=['', 'nm', 'nm', 'nm'],
                scales=[1, 10, 10, 10]),
            voxel_offset=(0, 0, 0, 0),
        ),
        shader='''
void main() {
  emitRGB(vec3(toNormalized(getDataValue(0)),
               toNormalized(getDataValue(1)),
               toNormalized(getDataValue(2))));
}        
''')

print(viewer)
