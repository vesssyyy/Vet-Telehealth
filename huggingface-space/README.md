---
title: Telehealth skin disease API
emoji: 🐾
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
---

Flask API for cat/dog skin image classification (`/health`, `/predict-cat`, `/predict-dog`). Keep `cat_skin_effb0.pth` and `dog_skin_effb0.pth` in this repo (use Git LFS for large checkpoints).

**Full deployment:** follow [DEPLOY.md](./DEPLOY.md) (clone Space repo → copy files → `git lfs` → push → test `/health` → set `data-api-base` on Firebase).
