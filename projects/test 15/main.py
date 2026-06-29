import torch
import numpy as np
import matplotlib.pyplot as plt

from data.generate import generate_swiss_roll
from models.net import SirenSurface
from training.trainer import train
from utils.plotting import plot_surface, plot_point_cloud

if __name__ == "__main__":
    # Determinism
    torch.manual_seed(42)
    np.random.seed(42)

    # Device
    device = torch.device("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Using device: {device}")

    # Generate real-world benchmark dataset: Swiss Roll
    n_points = 2000
    u, v, xyz = generate_swiss_roll(n_points, noise=0.05)

    # Convert to tensors
    uv_tensor = torch.tensor(np.stack([u, v], axis=1), dtype=torch.float32).to(device)
    xyz_tensor = torch.tensor(xyz, dtype=torch.float32).to(device)

    # Model, loss, optimizer
    model = SirenSurface(hidden_dim=128, omega_0=30.0, num_layers=4).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    loss_fn = torch.nn.MSELoss()

    # Train with curvature regularization (advanced solver)
    epochs = 100
    train(model, uv_tensor, xyz_tensor, loss_fn, optimizer, epochs, device, lambda_curv=0.01)

    # Plot original point cloud and learned surface
    plot_point_cloud(xyz, "Swiss Roll Data (2000 points)", "pointcloud.png")
    plot_surface(model, device, filename="surface_3d.png")

    plt.show()