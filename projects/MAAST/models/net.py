import torch.nn as nn

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Conv2d(3, 1, kernel_size=1)

    def forward(self, x):
        return self.conv(x)
