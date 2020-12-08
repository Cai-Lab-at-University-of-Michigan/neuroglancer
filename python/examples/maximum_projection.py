import argparse
import time

import neuroglancer
import neuroglancer.cli
import numpy as np
import scipy.ndimage
import webbrowser
import tifffile
import copy

class ProjectionArray(np.ndarray):
    def __new__(cls, img, layers):
        img = np.asarray(img).view(cls)
        return img
    def __init__(self, originalArr, numLayers):
        self.originalArr = originalArr
        self.numLayers = numLayers
    def __getitem__(self, key):
        # Get max Z for bounds
        zSize = len(self.originalArr[0])

        # Copy current slice to not alter the original
        sliceCopy = copy.deepcopy(self.originalArr[key])

        # Loop needed for each specific Z stack, and store projection into sliceCopy
        for i in range(key[1].start, key[1].stop):
            currentTuple = (key[0], slice(max(i-self.numLayers, 0), min(i+self.numLayers, zSize), None), key[2], key[3])
            currentMax = np.amax(self.originalArr[currentTuple], axis=1)
            sliceCopy[:, i-key[1].start, :, :] = currentMax

        return sliceCopy

class MaximumProjection:
    def __init__(self):
        # Address
        # neuroglancer.set_server_bind_address('127.0.0.1')
        # neuroglancer.set_static_content_source(url='http://localhost:8080')

        # Data
        img = tifffile.imread('sample.tif')
        img = img * 10 / 256
        img = img.astype('uint8')
        img = np.transpose(img, (1, 0, 2, 3))
        self.img = img

        # Same viewer every function call
        viewer = self.viewer = neuroglancer.Viewer()

    def useLayer(self, numLayers):
        # Store as ProjectionArray
        self.img2 = ProjectionArray(self.img, numLayers)

        dimensions = neuroglancer.CoordinateSpace(
            names=['z', 'y', 'x'],
            units='nm',
            scales=[10, 10, 10])

        with self.viewer.txn() as s:
            s.dimensions = dimensions
            s.layers.clear()
            s.layers.append(
                name='Original Image',
                layer=neuroglancer.LocalVolume(
                    data=self.img,
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
                name='Z-Projection Image',
                layer=neuroglancer.LocalVolume(
                    data=self.img2,
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
            s.layers['Original Image'] = s.layers[0]
            s.layers['Z-Projection Image'] = s.layers[1]
            s.layout = neuroglancer.row_layout([
                    neuroglancer.LayerGroupViewer(layers=['Original Image']),
                    neuroglancer.LayerGroupViewer(layers=['Z-Projection Image']),
            ])

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    neuroglancer.cli.add_server_arguments(ap)
    args = ap.parse_args()
    neuroglancer.cli.handle_server_arguments(args)

    projection = MaximumProjection()
    print(projection.viewer)
    webbrowser.open_new(projection.viewer.get_viewer_url())