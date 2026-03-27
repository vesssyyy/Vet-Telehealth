import os
import copy
import time
import random
import numpy as np
from tqdm import tqdm
from PIL import Image

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torchvision import datasets, transforms
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights

from sklearn.metrics import classification_report, confusion_matrix

# ----------------------------
# Config
# ----------------------------
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
DATA_DIR = os.path.join(BASE_DIR, "dataset", "cat")
TRAIN_DIR = os.path.join(DATA_DIR, "train")
VAL_DIR = os.path.join(DATA_DIR, "val")
TEST_DIR = os.path.join(DATA_DIR, "test")

BATCH_SIZE = 32
EPOCHS = 20
LR = 1e-4
WEIGHT_DECAY = 1e-4
IMG_SIZE = 224
NUM_WORKERS = 0
PATIENCE = 5
SEED = 42

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
PIN_MEMORY = True if DEVICE == "cuda" else False
SAVE_PATH = os.path.join(CURRENT_DIR, "cat_skin_effb0.pth")

# ----------------------------
# Reproducibility
# ----------------------------
def set_seed(seed=42):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)

set_seed(SEED)

# ----------------------------
# Transforms
# ----------------------------
train_tfms = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.RandomHorizontalFlip(p=0.5),
    transforms.RandomRotation(15),
    transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2, hue=0.1),
    transforms.ToTensor(),
    transforms.Normalize(
        [0.485, 0.456, 0.406],
        [0.229, 0.224, 0.225]
    )
])

val_tfms = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(
        [0.485, 0.456, 0.406],
        [0.229, 0.224, 0.225]
    )
])

predict_tfms = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(
        [0.485, 0.456, 0.406],
        [0.229, 0.224, 0.225]
    )
])

# ----------------------------
# Check folders
# ----------------------------
print("DATA_DIR:", DATA_DIR)
print("TRAIN_DIR:", TRAIN_DIR)
print("VAL_DIR:", VAL_DIR)
print("TEST_DIR:", TEST_DIR)
print("DATA_DIR exists:", os.path.exists(DATA_DIR))
print("TRAIN_DIR exists:", os.path.exists(TRAIN_DIR))
print("VAL_DIR exists:", os.path.exists(VAL_DIR))
print("TEST_DIR exists:", os.path.exists(TEST_DIR))

# ----------------------------
# Dataset / Loaders
# ----------------------------
train_ds = datasets.ImageFolder(TRAIN_DIR, transform=train_tfms)
val_ds = datasets.ImageFolder(VAL_DIR, transform=val_tfms)
test_ds = datasets.ImageFolder(TEST_DIR, transform=val_tfms)

class_names = train_ds.classes
num_classes = len(class_names)

print("Classes (from folders):", class_names)

expected_classes = {
    "Healthy",
    "Flea_Allergy_Dermatitis",
    "Ringworm",
    "Scabies"
}

assert set(class_names) == expected_classes, "Train folder names don't match expected classes."
assert set(val_ds.classes) == expected_classes, "Validation folder names don't match expected classes."
assert set(test_ds.classes) == expected_classes, "Test folder names don't match expected classes."

train_loader = DataLoader(
    train_ds,
    batch_size=BATCH_SIZE,
    shuffle=True,
    num_workers=NUM_WORKERS,
    pin_memory=PIN_MEMORY
)

val_loader = DataLoader(
    val_ds,
    batch_size=BATCH_SIZE,
    shuffle=False,
    num_workers=NUM_WORKERS,
    pin_memory=PIN_MEMORY
)

test_loader = DataLoader(
    test_ds,
    batch_size=BATCH_SIZE,
    shuffle=False,
    num_workers=NUM_WORKERS,
    pin_memory=PIN_MEMORY
)

print(f"Train images: {len(train_ds)}")
print(f"Val images: {len(val_ds)}")
print(f"Test images: {len(test_ds)}")

# ----------------------------
# Model
# ----------------------------
weights = EfficientNet_B0_Weights.DEFAULT
model = efficientnet_b0(weights=weights)

in_features = model.classifier[1].in_features
model.classifier[1] = nn.Linear(in_features, num_classes)

model = model.to(DEVICE)

criterion = nn.CrossEntropyLoss()
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=LR,
    weight_decay=WEIGHT_DECAY
)

scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
    optimizer,
    mode="min",
    patience=2,
    factor=0.5
)

# ----------------------------
# Train / Validation Function
# ----------------------------
def run_epoch(loader, train=True):
    if train:
        model.train()
    else:
        model.eval()

    running_loss = 0.0
    running_correct = 0
    total = 0

    for imgs, labels in tqdm(loader, leave=False):
        imgs = imgs.to(DEVICE, non_blocking=True)
        labels = labels.to(DEVICE, non_blocking=True)

        with torch.set_grad_enabled(train):
            outputs = model(imgs)
            loss = criterion(outputs, labels)

            if train:
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()

        preds = outputs.argmax(dim=1)
        running_loss += loss.item() * imgs.size(0)
        running_correct += (preds == labels).sum().item()
        total += imgs.size(0)

    epoch_loss = running_loss / total
    epoch_acc = running_correct / total
    return epoch_loss, epoch_acc

# ----------------------------
# Training Loop with Early Stopping
# ----------------------------
best_acc = 0.0
best_state = copy.deepcopy(model.state_dict())
best_epoch = 0
epochs_no_improve = 0
start = time.time()

for epoch in range(EPOCHS):
    train_loss, train_acc = run_epoch(train_loader, train=True)
    val_loss, val_acc = run_epoch(val_loader, train=False)

    scheduler.step(val_loss)

    current_lr = optimizer.param_groups[0]["lr"]

    print(
        f"Epoch {epoch + 1}/{EPOCHS} | "
        f"LR {current_lr:.6f} | "
        f"Train Loss {train_loss:.4f} Acc {train_acc:.4f} | "
        f"Val Loss {val_loss:.4f} Acc {val_acc:.4f}"
    )

    if val_acc > best_acc:
        best_acc = val_acc
        best_epoch = epoch + 1
        epochs_no_improve = 0
        best_state = copy.deepcopy(model.state_dict())

        torch.save({
            "model_state_dict": best_state,
            "class_names": class_names,
            "img_size": IMG_SIZE,
            "num_classes": num_classes,
            "best_val_acc": best_acc,
            "best_epoch": best_epoch
        }, SAVE_PATH)

    else:
        epochs_no_improve += 1

    if epochs_no_improve >= PATIENCE:
        print(f"\nEarly stopping triggered at epoch {epoch + 1}")
        break

print("\nBest Val Acc:", round(best_acc, 4))
print("Best Epoch:", best_epoch)
print("Saved:", SAVE_PATH)
print("Time (s):", round(time.time() - start, 2))

# ----------------------------
# Load Trained Model
# ----------------------------
def load_trained_model(model_path):
    checkpoint = torch.load(model_path, map_location=DEVICE)

    loaded_class_names = checkpoint["class_names"]
    num_loaded_classes = checkpoint["num_classes"]

    loaded_model = efficientnet_b0(weights=None)
    in_features = loaded_model.classifier[1].in_features
    loaded_model.classifier[1] = nn.Linear(in_features, num_loaded_classes)

    loaded_model.load_state_dict(checkpoint["model_state_dict"])
    loaded_model = loaded_model.to(DEVICE)
    loaded_model.eval()

    return loaded_model, loaded_class_names, checkpoint

# ----------------------------
# Final Test Evaluation
# ----------------------------
def evaluate_test(loader, eval_model, class_names):
    eval_model.eval()
    running_loss = 0.0
    running_correct = 0
    total = 0

    all_labels = []
    all_preds = []

    with torch.no_grad():
        for imgs, labels in tqdm(loader, leave=False):
            imgs = imgs.to(DEVICE, non_blocking=True)
            labels = labels.to(DEVICE, non_blocking=True)

            outputs = eval_model(imgs)
            loss = criterion(outputs, labels)

            preds = outputs.argmax(dim=1)

            running_loss += loss.item() * imgs.size(0)
            running_correct += (preds == labels).sum().item()
            total += imgs.size(0)

            all_labels.extend(labels.cpu().numpy())
            all_preds.extend(preds.cpu().numpy())

    test_loss = running_loss / total
    test_acc = running_correct / total

    print("\nClassification Report:")
    print(classification_report(all_labels, all_preds, target_names=class_names, digits=4))

    print("Confusion Matrix:")
    print(confusion_matrix(all_labels, all_preds))

    return test_loss, test_acc

best_model, best_class_names, checkpoint = load_trained_model(SAVE_PATH)
test_loss, test_acc = evaluate_test(test_loader, best_model, best_class_names)

print("\nFinal Test Results")
print(f"Test Loss: {test_loss:.4f}")
print(f"Test Accuracy: {test_acc:.4f}")

# ----------------------------
# Preprocess Uploaded / Captured Image
# ----------------------------
def preprocess_image(image_path):
    img = Image.open(image_path).convert("RGB")
    img = predict_tfms(img)
    img = img.unsqueeze(0)
    return img.to(DEVICE)

# ----------------------------
# Predict Uploaded / Captured Image
# ----------------------------
def predict_image(image_path, loaded_model=None, loaded_class_names=None, model_path=SAVE_PATH):
    if loaded_model is None or loaded_class_names is None:
        loaded_model, loaded_class_names, _ = load_trained_model(model_path)

    img_tensor = preprocess_image(image_path)

    with torch.no_grad():
        outputs = loaded_model(img_tensor)
        probs = torch.softmax(outputs, dim=1)
        pred_idx = torch.argmax(probs, dim=1).item()
        confidence = probs[0][pred_idx].item()

    predicted_class = loaded_class_names[pred_idx]
    return predicted_class, confidence

# Example:
# loaded_model, loaded_class_names, _ = load_trained_model(SAVE_PATH)
# test_image = os.path.join(BASE_DIR, "sample_cat.jpg")
# predicted_class, confidence = predict_image(
#     test_image,
#     loaded_model=loaded_model,
#     loaded_class_names=loaded_class_names
# )
# print(f"Prediction: {predicted_class}")
# print(f"Confidence: {confidence:.4f}")