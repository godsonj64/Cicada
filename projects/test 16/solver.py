import numpy as np

def _biot_savart_segment(p, a, b, gamma, core_radius):
    """Induced velocity at point p from a straight vortex segment a->b
       with circulation gamma and Gaussian core regularisation.
    """
    r1 = p - a
    r2 = p - b
    r1_norm = np.linalg.norm(r1, axis=-1, keepdims=True)
    r2_norm = np.linalg.norm(r2, axis=-1, keepdims=True)

    # direction of segment
    d = b - a
    L = np.linalg.norm(d)
    if L < 1e-12:
        return np.zeros_like(p)
    d_hat = d / L

    # Biot-Savart law with Gaussian cutoff (regularised)
    # velocity = (gamma/(4π)) * (r1/|r1|^3 - r2/|r2|^3) × d_hat
    # with a Gaussian smoothing: multiply by erf(|r|/(√2*σ)) or use a core model
    # Here we use a simple approximation: replace 1/r^2 with 1/(r^2 + δ^2) inside cross product
    delta = core_radius
    r1_sq = r1_norm ** 2 + delta ** 2
    r2_sq = r2_norm ** 2 + delta ** 2

    cross_factor = (r1 / r1_sq) - (r2 / r2_sq)
    # cross product with d_hat
    v = np.cross(cross_factor, d_hat) * (gamma / (4.0 * np.pi))
    return v

def vortex_ring_velocity(points, ring_center, ring_radius, circulation,
                         core_radius, n_segments=200):
    """Velocity field induced by a thin vortex ring.

    points : (N,3) array of query points.
    Returns (N,3) array of velocity vectors.
    """
    theta = np.linspace(0, 2*np.pi, n_segments, endpoint=False)
    # ring points
    cx, cy, cz = ring_center
    ring_x = cx + ring_radius * np.cos(theta)
    ring_y = cy + ring_radius * np.sin(theta)
    ring_z = cz + np.zeros_like(theta)
    ring_pts = np.stack([ring_x, ring_y, ring_z], axis=1)  # (M,3)

    # segment endpoints (a = ring_pts[i], b = ring_pts[(i+1)%M])
    M = n_segments
    a = ring_pts
    b = np.roll(ring_pts, -1, axis=0)

    # accumulate velocity from each segment
    v_total = np.zeros_like(points)  # (N,3)
    for i in range(M):
        v_seg = _biot_savart_segment(points, a[i], b[i], circulation, core_radius)
        v_total += v_seg
    return v_total

def compute_vorticity(vx, vy, vz, dx, dy, dz):
    """Compute vorticity (curl of velocity) using central finite differences.

    vx, vy, vz : 3D arrays (nx, ny, nz)
    dx, dy, dz : grid spacings
    Returns (wx, wy, wz) each 3D array.
    """
    # Use numpy gradient (second-order central differences)
    dvx_dy, dvx_dz = np.gradient(vx, dy, dz, axis=(1, 2))
    dvy_dx, dvy_dz = np.gradient(vy, dx, dz, axis=(0, 2))
    dvz_dx, dvz_dy = np.gradient(vz, dx, dy, axis=(0, 1))

    # dvx_dy is gradient along y? gradient returns list of arrays:
    # gradient(vx, dx, dy, dz) returns (partial_vx/partial_x, partial_vx/partial_y, partial_vx/partial_z)
    # But we passed dy, dz as separate? Let's use consistent call:
    grad_vx = np.gradient(vx, dx, dy, dz)
    grad_vy = np.gradient(vy, dx, dy, dz)
    grad_vz = np.gradient(vz, dx, dy, dz)

    # grad_vx[0] = dvx/dx, grad_vx[1] = dvx/dy, grad_vx[2] = dvx/dz
    dvx_dy = grad_vx[1]
    dvx_dz = grad_vx[2]
    dvy_dx = grad_vy[0]
    dvy_dz = grad_vy[2]
    dvz_dx = grad_vz[0]
    dvz_dy = grad_vz[1]

    wx = dvy_dz - dvz_dy
    wy = dvz_dx - dvx_dz
    wz = dvx_dy - dvy_dx
    return wx, wy, wz
