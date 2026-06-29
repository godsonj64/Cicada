import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # needed for 3D projection
from matplotlib import cm

def plot_vortex_surface(verts, faces, values, title="", save_path=None):
    """3D plot of the vortex surface coloured by vorticity magnitude."""
    fig = plt.figure(figsize=(10, 8))
    ax = fig.add_subplot(111, projection='3d')

    # Normalise values for colour map
    norm = plt.Normalize(values.min(), values.max())
    colours = cm.viridis(norm(values))

    # Create mesh from faces
    mesh = ax.plot_trisurf(verts[:, 0], verts[:, 1], verts[:, 2],
                           triangles=faces,
                           cmap=cm.viridis,
                           norm=norm,
                           linewidth=0, antialiased=False)
    # Set colour array
    mesh.set_array(values)

    ax.set_xlabel('X')
    ax.set_ylabel('Y')
    ax.set_zlabel('Z')
    ax.set_title(title)
    fig.colorbar(mesh, ax=ax, shrink=0.5, aspect=20, label='Vorticity magnitude')

    if save_path:
        plt.savefig(save_path, dpi=150, bbox_inches='tight')
        print(f"Figure saved to {save_path}")
    plt.show()
