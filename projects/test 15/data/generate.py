import numpy as np
from sklearn.datasets import make_swiss_roll

def generate_swiss_roll(n_points=2000, noise=0.0):
    """Generate Swiss Roll dataset (3D points). Returns (u, v) as 2D parametric coordinates
    from the original manifold, and (x, y, z) as 3D coordinates."""
    # make_swiss_roll returns (X, t) where X is (n,3) and t is (n,) unrolled coordinate
    X, t = make_swiss_roll(n_samples=n_points, noise=noise, random_state=42)
    # Use t as one parametric direction, and the azimuth as another.
    # Normalize t to [0, 2π] approximately.
    t_norm = (t - t.min()) / (t.max() - t.min()) * 2 * np.pi
    # Azimuth from x,y
    phi = np.arctan2(X[:, 1], X[:, 0])
    # Return u=phi, v=t_norm, and 3D points
    u = phi
    v = t_norm
    return u, v, X

def generate_noisy_torus(n_points=2000, noise_std=0.05):
    """Kept for backward compatibility – not used in the advanced version."""
    R = 2.0
    r = 1.0
    u = np.random.uniform(0, 2*np.pi, n_points)
    v = np.random.uniform(0, 2*np.pi, n_points)
    x = (R + r * np.cos(v)) * np.cos(u)
    y = (R + r * np.cos(v)) * np.sin(u)
    z = r * np.sin(v)
    if noise_std > 0:
        x += np.random.normal(0, noise_std, n_points)
        y += np.random.normal(0, noise_std, n_points)
        z += np.random.normal(0, noise_std, n_points)
    return u, v, np.stack([x, y, z], axis=1)
