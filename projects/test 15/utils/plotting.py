import numpy as np
import torch
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

def plot_surface(model, device, n_grid=50, filename="surface_3d.png"):
    """Plot the learned surface as a mesh. Uses uniform grid in (u,v) ∈ [-π, π] for Swiss roll."""
    u = np.linspace(-np.pi, np.pi, n_grid)
    v = np.linspace(0, 2*np.pi, n_grid)
    U, V = np.meshgrid(u, v)
    uv_grid = np.stack([U.ravel(), V.ravel()], axis=1)
    uv_tensor = torch.tensor(uv_grid, dtype=torch.float32).to(device)

    model.eval()
    with torch.no_grad():
        surf = model(uv_tensor).cpu().numpy()

    # Reshape
    X = surf[:, 0].reshape(n_grid, n_grid)
    Y = surf[:, 1].reshape(n_grid, n_grid)
    Z = surf[:, 2].reshape(n_grid, n_grid)

    fig = plt.figure(figsize=(8, 6))
    ax = fig.add_subplot(111, projection='3d')
    ax.plot_surface(X, Y, Z, cmap='viridis', alpha=0.8, edgecolor='none')
    ax.set_xlabel('X')
    ax.set_ylabel('Y')
    ax.set_zlabel('Z')
    ax.set_title('Learned 3D Surface (Swiss Roll)')
    plt.savefig(filename, dpi=150)
    print(f"Surface plot saved as {filename}")

def plot_point_cloud(xyz, title="Data points", filename="pointcloud.png"):
    """Plot the original point cloud."""
    fig = plt.figure(figsize=(8, 6))
    ax = fig.add_subplot(111, projection='3d')
    ax.scatter(xyz[:, 0], xyz[:, 1], xyz[:, 2], s=2, alpha=0.6)
    ax.set_xlabel('X')
    ax.set_ylabel('Y')
    ax.set_zlabel('Z')
    ax.set_title(title)
    plt.savefig(filename, dpi=150)
    print(f"Point cloud saved as {filename}")
