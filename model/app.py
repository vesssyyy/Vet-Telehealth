import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
import torch
import torch.nn as nns
from torchvision import transforms
from torchvision.models import efficientnet_b0
from torchvision.transforms import InterpolationMode

app = Flask(__name__)

CORS(app, resources={r"/*": {"origins": "*"}})

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CAT_MODEL_PATH = os.path.join(_BASE_DIR, "cat_skin_effb0.pth")
DOG_MODEL_PATH = os.path.join(_BASE_DIR, "dog_skin_effb0.pth")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def load_checkpoint_model(model_path):
    """Load EfficientNet-B0 weights, class names, and matching image transform from a .pth file."""
    try:
        ckpt = torch.load(model_path, map_location=DEVICE, weights_only=False)
    except TypeError:
        ckpt = torch.load(model_path, map_location=DEVICE)

    class_names = ckpt.get("class_names", [])
    img_size = int(ckpt.get("img_size", 224))

    if not class_names:
        raise RuntimeError(f"Checkpoint '{model_path}' missing 'class_names'.")

    model = efficientnet_b0(weights=None)
    in_features = model.classifier[1].in_features
    model.classifier[1] = nns.Linear(in_features, len(class_names))

    if "model_state_dict" not in ckpt:
        raise RuntimeError(f"Checkpoint '{model_path}' missing 'model_state_dict'.")

    model.load_state_dict(ckpt["model_state_dict"], strict=True)
    model.to(DEVICE)
    model.eval()

    transform = transforms.Compose([
        transforms.Resize((img_size, img_size), interpolation=InterpolationMode.BILINEAR),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225]
        ),
    ])

    return {
        "model": model,
        "class_names": class_names,
        "img_size": img_size,
        "transform": transform,
    }


cat_data = load_checkpoint_model(CAT_MODEL_PATH)
dog_data = load_checkpoint_model(DOG_MODEL_PATH)


def predict_image(file, model_data):
    """Run one forward pass on an uploaded image; returns label + confidence or an error tuple."""
    try:
        img = Image.open(file.stream).convert("RGB")
    except Exception:
        return None, jsonify({"error": "Invalid image file."}), 400

    x = model_data["transform"](img).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        logits = model_data["model"](x)
        probs = torch.softmax(logits, dim=1)[0]
        conf, idx = torch.max(probs, dim=0)

    result = {
        "label": model_data["class_names"][int(idx)],
        "confidence": float(conf.item())
    }
    return result, None, None


@app.get("/")
def root():
    # HF Spaces "App" tab loads `/`; without this route the UI shows "Not Found".
    return jsonify({
        "service": "telehealth-skin-api",
        "health": "/health",
        "predict_cat": "/predict-cat (POST, multipart form field: image)",
        "predict_dog": "/predict-dog (POST, multipart form field: image)",
    })


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "device": DEVICE,
        "cat_classes": cat_data["class_names"],
        "cat_img_size": cat_data["img_size"],
        "dog_classes": dog_data["class_names"],
        "dog_img_size": dog_data["img_size"],
    })


@app.post("/predict-cat")
def predict_cat():
    if "image" not in request.files:
        return jsonify({"error": "No file found. Use form-data key 'image'."}), 400

    file = request.files["image"]
    result, error_response, status_code = predict_image(file, cat_data)

    if error_response:
        return error_response, status_code

    return jsonify(result)


@app.post("/predict-dog")
def predict_dog():
    if "image" not in request.files:
        return jsonify({"error": "No file found. Use form-data key 'image'."}), 400

    file = request.files["image"]
    result, error_response, status_code = predict_image(file, dog_data)

    if error_response:
        return error_response, status_code

    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
