import torch
import torch.nn as nn
import numpy as np

class SirenLayer(nn.Module):
    """Fully connected layer with sine activation, using frequency initialization."""
    def __init__(self, in_features, out_features, omega_0=30.0, is_first=False):
        super().__init__()
        self.omega_0 = omega_0
        self.linear = nn.Linear(in_features, out_features)
        self.init_weights(is_first)

    def init_weights(self, is_first):
        with torch.no_grad():
            if is_first:
                bound = 1.0 / self.linear.in_features
            else:
                bound = np.sqrt(6.0 / self.linear.in_features) / self.omega_0
            nn.init.uniform_(self.linear.weight, -bound, bound)

    def forward(self, x):
        return torch.sin(self.omega_0 * self.linear(x))

class SirenSurface(nn.Module):
    """SIREN network mapping (u,v) -> (x,y,z) for representing a 3D surface."""
    def __init__(self, hidden_dim=256, omega_0=30.0, num_layers=4):
        super().__init__()
        layers = [SirenLayer(2, hidden_dim, omega_0=omega_0, is_first=True)]
        for _ in range(num_layers - 2):
            layers.append(SirenLayer(hidden_dim, hidden_dim, omega_0=omega_0))
        layers.append(nn.Linear(hidden_dim, 3))
        self.net = nn.Sequential(*layers)

    def forward(self, uv):
        return self.net(uv)
