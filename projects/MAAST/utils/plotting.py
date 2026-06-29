import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

def render_image_with_metadata(image: Image.Image, title: str = "MAST Image") -> str:
    """
    Render the image with overlay metadata using matplotlib, save to a PNG file,
    and return the filename.
    """
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.imshow(np.array(image))
    ax.set_title(title, fontsize=12, color='white', backgroundcolor='black')
    ax.axis('off')
    plt.tight_layout()
    out_path = "mast_render.png"
    plt.savefig(out_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    return out_path
