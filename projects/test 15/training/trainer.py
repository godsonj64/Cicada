import torch

def train(model, uv, xyz, loss_fn, optimizer, epochs, device, lambda_curv=0.01):
    """Train with optional gradient penalty (first-derivative regularization)."""
    model.train()
    for epoch in range(epochs):
        optimizer.zero_grad()
        pred = model(uv)
        mse_loss = loss_fn(pred, xyz)

        # Gradient penalty: penalize large first derivatives w.r.t. uv
        if lambda_curv > 0:
            batch_size = uv.size(0)
            idx = torch.randperm(batch_size)[:256]  # subsample for speed
            uv_sub = uv[idx].detach().requires_grad_(True)
            out_sub = model(uv_sub)
            # Compute gradient of sum of outputs (scalar) w.r.t. uv
            grad_sum = torch.autograd.grad(
                out_sub.sum(), uv_sub,
                create_graph=True,
                retain_graph=True
            )[0]  # shape (batch, 2)
            curv_loss = (grad_sum ** 2).sum(dim=1).mean()
            loss = mse_loss + lambda_curv * curv_loss
        else:
            curv_loss = torch.tensor(0.0)

        loss.backward()
        optimizer.step()
        if (epoch + 1) % 20 == 0:
            msg = f"Epoch {epoch+1:3d}/{epochs}, MSE: {mse_loss.item():.6f}"
            if lambda_curv > 0:
                msg += f", GradPenalty: {curv_loss.item():.6f}"
            print(msg)
