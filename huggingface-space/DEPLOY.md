# Deploy this API to Hugging Face Spaces (step-by-step)

Use this when your **Telehealth** project lives in GitHub/your PC, but the **skin model API** must run on Hugging Face because it is Python + PyTorch.

---

## What you are deploying

- A **Docker** Space that runs **Flask + Gunicorn**.
- Endpoints (same as local `model/app.py`):
  - `GET /health` — JSON status and class names
  - `POST /predict-cat` — form field **`image`** (file upload)
  - `POST /predict-dog` — form field **`image`** (file upload)

Your **Firebase** site only needs the Space’s **public base URL** in `public/scripts/core/config/skin-disease-api-base.js` (see section 7).

---

## 0. Install tools (once per computer)

1. **Git** — [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. **Git LFS** — [https://git-lfs.com](https://git-lfs.com) (needed for large `.pth` files)
3. In PowerShell, run once:
   ```powershell
   git lfs install
   ```

You do **not** need Docker on your PC. Hugging Face builds the image in the cloud.

---

## 1. Prepare files on your PC

1. Open PowerShell.
2. Go to the folder that already contains `Dockerfile` and `app.py`:
   ```powershell
   cd D:\Thesis\Telehealth-System\huggingface-space
   ```
3. Copy the latest app and weights from your thesis `model` folder:
   ```powershell
   .\sync-from-model.ps1
   ```
4. Confirm these files exist **in this folder** (same level as `Dockerfile`):
   - `app.py`
   - `cat_skin_effb0.pth`
   - `dog_skin_effb0.pth`
   - `Dockerfile`
   - `requirements.txt`
   - `README.md`

If `sync-from-model.ps1` warns about missing `.pth` files, copy them manually from `D:\Thesis\Telehealth-System\model\` into `huggingface-space\`.

---

## 2. Create a new Space on Hugging Face

1. Log in at [https://huggingface.co](https://huggingface.co).
2. Open [https://huggingface.co/new-space](https://huggingface.co/new-space).
3. Fill in:
   - **Space name** — e.g. `telehealth-skin-api` (letters, numbers, hyphens).
   - **License** — pick one (e.g. MIT) if asked.
   - **SDK** — choose **Docker** (not Gradio, not Streamlit).
4. Click **Create Space**.

You now have an empty Space and a **Git repository** owned by Hugging Face.

---

## 3. Get a token so `git push` works

1. Go to [https://huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
2. **Create new token** → type **Write** (or fine-grained with write to that Space).
3. Copy the token and store it somewhere safe. You will use it as the **password** when Git asks (username can be your HF username or literally `user` — HF accepts token as password).

---

## 4. Push this folder to the Space with Git

Replace `YOUR_USERNAME` and `YOUR_SPACE_NAME` with your real values (Space name from step 2).

**Option A — helper script** (clones to `D:\Thesis\hf-space-YOUR_SPACE_NAME`, copies files, runs `git add`):

```powershell
cd D:\Thesis\Telehealth-System\huggingface-space
.\prepare-hf-repo.ps1 -HfUser YOUR_USERNAME -SpaceName YOUR_SPACE_NAME
cd D:\Thesis\hf-space-YOUR_SPACE_NAME
git commit -m "Add Docker Flask skin disease API"
git push
```

**Option B — manual**

```powershell
# 4a. Clone the empty Space (pick any empty folder, NOT inside your thesis .git)
cd D:\Thesis
git clone https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME hf-skin-space
cd hf-skin-space
```

```powershell
# 4b. Copy everything from huggingface-space into this clone (overwrite README if asked)
Copy-Item -Path D:\Thesis\Telehealth-System\huggingface-space\* -Destination . -Recurse -Force
```

```powershell
# 4c. Track large weights with Git LFS (important — push will fail without this if files are big)
git lfs install
git lfs track "*.pth"
git add .gitattributes
```

```powershell
# 4d. Commit and push
git add .
git commit -m "Add Docker Flask skin disease API"
git push
```

When prompted for credentials:

- **Username:** your Hugging Face username  
- **Password:** the **token** from section 3 (not your HF login password)

---

## 5. Wait for the build

1. Open your Space page: `https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME`
2. Open the **Build** (or **Logs**) tab and wait until the Docker build finishes (**Running** / green).
3. First build can take **many minutes** (downloads PyTorch, etc.).

If the build **fails**, read the red log lines. Typical issues:

- Missing `cat_skin_effb0.pth` / `dog_skin_effb0.pth` in the repo.
- File too large pushed **without** Git LFS (re-do section 4c and push again).

---

## 6. Find the correct base URL for your website

1. On the Space page, open the **App** tab so the service is running.
2. Use the URL in the browser when the app is shown. It usually looks like:
   - `https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space`  
   or you may stay on `huggingface.co/spaces/...` — **use the origin that actually loads the API**.

3. Test in the browser (replace with your real base, **no trailing slash**):

   - `https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space/health`  
   You should see JSON with `"status": "ok"`.

If `/health` works here, that **full origin** (scheme + host, no path) is what you set in the config file below.

---

## 7. Point your Firebase site at the Space

Edit **`public/scripts/core/config/skin-disease-api-base.js`** and set (example):

```javascript
window.TELEHEALTH_SKIN_API_BASE = 'https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space';
```

Use the same origin you tested for `/health` (**no trailing slash**). Leave it `''` for local development; the skin pages still use `data-api-base="http://localhost:5000"` as fallback.

Then deploy hosting:

```powershell
cd D:\Thesis\Telehealth-System
firebase deploy --only hosting
```

---

## 8. When you change the model or `app.py` later

1. Edit `model\app.py` (or retrain and replace `.pth` in `model\`).
2. Run `sync-from-model.ps1` again inside `huggingface-space\`.
3. Copy updated files into your `hf-skin-space` clone (or whatever folder you use to push to HF), then:

   ```powershell
   git add .
   git commit -m "Update model or API"
   git push
   ```

---

## Quick checklist

| Step | Done? |
|------|--------|
| `sync-from-model.ps1` run; both `.pth` present in folder | ☐ |
| Space created with **Docker** SDK | ☐ |
| Write token created | ☐ |
| `git lfs track "*.pth"` before first push of weights | ☐ |
| Build succeeded on HF | ☐ |
| `/health` returns JSON in browser | ☐ |
| `skin-disease-api-base.js` updated + `firebase deploy --only hosting` | ☐ |
