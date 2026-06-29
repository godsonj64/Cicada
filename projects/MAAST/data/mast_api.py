import requests
from PIL import Image
from io import BytesIO

def fetch_mast_cutout(target: str = "M51", size: int = 256, fmt: str = "jpg") -> Image.Image:
    """
    Fetch a real cutout image from the MAST API v0 synchronous download service.
    Returns a PIL Image.
    """
    base = "https://mast.stsci.edu/api/v0/download/sync"
    params = {
        "objectname": target,
        "width": size,
        "height": size,
        "format": fmt,
    }
    resp = requests.get(base, params=params, timeout=60)
    resp.raise_for_status()
    return Image.open(BytesIO(resp.content))
