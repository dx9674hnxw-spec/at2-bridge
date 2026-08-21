FROM python:3.12-slim

# bluez + build deps needed by bleak/dbus on Linux, udev for serial device
# rules, and libopencore-amrnb0 for real-time PTT voice encode/decode
# (the same open-source AMR-NB codec the official app uses via JNI).
RUN apt-get update && apt-get install -y --no-install-recommends \
    bluez \
    dbus \
    libopencore-amrnb0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /srv/data
ENV AT2_BRIDGE_DATA_DIR=/srv/data

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
