from dataclasses import dataclass

@dataclass(frozen=True)
class VortexConfig:
    # Grid parameters
    x_min: float = -2.0
    x_max: float = 2.0
    y_min: float = -2.0
    y_max: float = 2.0
    z_min: float = -2.0
    z_max: float = 2.0
    nx: int = 50   # resolution along x
    ny: int = 50
    nz: int = 50

    # Vortex ring parameters (Biot-Savart discretisation)
    ring_center: tuple = (0.0, 0.0, 0.0)
    ring_radius: float = 1.0
    ring_circulation: float = 1.0
    core_radius: float = 0.1          # regularisation length
    n_segments: int = 200             # number of ring segments

    # Isosurface parameter
    isovalue_fraction: float = 0.5    # fraction of max vorticity magnitude

    # Plot
    plot_title: str = "Vortex Ring – Vorticity Magnitude Isosurface"
    save_fig: str = "vortex_ring.png"
