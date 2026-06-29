import numpy as np
from config import VortexConfig
from solver import vortex_ring_velocity, compute_vorticity
from isosurface import extract_isosurface
from plotter import plot_vortex_surface

def main():
    # Set random seed for reproducibility (not used strongly, but good practice)
    np.random.seed(42)

    cfg = VortexConfig()

    # Create 3D grid
    x = np.linspace(cfg.x_min, cfg.x_max, cfg.nx)
    y = np.linspace(cfg.y_min, cfg.y_max, cfg.ny)
    z = np.linspace(cfg.z_min, cfg.z_max, cfg.nz)
    dx = x[1] - x[0]
    dy = y[1] - y[0]
    dz = z[1] - z[0]
    Y, X, Z = np.meshgrid(y, x, z, indexing='ij')  # shape (ny, nx, nz) but we want (nx, ny, nz) standard
    # To keep consistent with numpy shape (nx, ny, nz), use indexing='ij' with meshgrid? Let's produce arrays of shape (nx, ny, nz):
    X, Y, Z = np.meshgrid(x, y, z, indexing='ij')  # X is (nx, ny, nz), etc.
    points = np.stack([X.ravel(), Y.ravel(), Z.ravel()], axis=1)  # (N,3)

    # Compute velocity field
    print("Computing velocity field via Biot-Savart...")
    uvw = vortex_ring_velocity(points, cfg.ring_center, cfg.ring_radius,
                               cfg.ring_circulation, cfg.core_radius,
                               cfg.n_segments)
    Vx = uvw[:, 0].reshape(cfg.nx, cfg.ny, cfg.nz)
    Vy = uvw[:, 1].reshape(cfg.nx, cfg.ny, cfg.nz)
    Vz = uvw[:, 2].reshape(cfg.nx, cfg.ny, cfg.nz)

    # Compute vorticity
    print("Computing vorticity (curl of velocity)...")
    wx, wy, wz = compute_vorticity(Vx, Vy, Vz, dx, dy, dz)
    vort_mag = np.sqrt(wx**2 + wy**2 + wz**2)

    # Isosurface
    level = cfg.isovalue_fraction * vort_mag.max()
    spacing = (dx, dy, dz)
    print(f"Extracting isosurface at level {level:.4f}...")
    verts, faces, values = extract_isosurface(vort_mag, level, spacing)

    if len(verts) == 0:
        print("No surface found at this isovalue. Try different parameters.")
        return

    # Plot
    print(f"Surface has {len(verts)} vertices and {len(faces)} faces.")
    plot_vortex_surface(verts, faces, values,
                        title=cfg.plot_title,
                        save_path=cfg.save_fig)
    print("Done.")

if __name__ == "__main__":
    main()
