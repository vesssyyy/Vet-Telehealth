FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# CPU wheels keep the image smaller on free-tier Spaces
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY cat_skin_effb0.pth dog_skin_effb0.pth ./

ENV PORT=7860
EXPOSE 7860

CMD exec gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 2 --timeout 180 app:app
