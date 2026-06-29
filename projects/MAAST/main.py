import random
import numpy as np
import torch

from data.mast_api import fetch_mast_cutout
from utils.plotting import render_image_with_metadata
from models.net import Net  # included to demonstrate absolute import; unused

def main():
    # Set deterministic seeds (data is real, but for reproducibility of layout)
    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)

    # Fetch a real MAST cutout image (target M51, 256x256)
    print("Fetching real MAST cutout of M51...")
    image = fetch_mast_cutout(target="M51", size=256)
    print(f"Image size: {image.size}, mode: {image.mode}")

    # Render with metadata overlay
    out_file = render_image_with_metadata(image, title="M51 – Whirlpool Galaxy (HST/MAST)")
    print(f"Rendered image saved as {out_file}")

if __name__ == "__main__":
    main()