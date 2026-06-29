import numpy as np
from skimage.measure import marching_cubes  # requires scikit-image

def extract_isosurface(vorticity_magnitude, level, spacing):
    """Triangulate an isosurface of the 3D scalar field.

    vorticity_magnitude : 3D array
    level              : isovalue
    spacing            : tuple (dx, dy, dz)

    Returns vertices (N,3), faces (M,3), values (N,) of the scalar field at vertices.
    """
    verts, faces, normals, values = marching_cubes(
        vorticity_magnitude, level=level, spacing=spacing,
        gradient_direction='ascent', allow_degenerate=False
    )
    return verts, faces, values
