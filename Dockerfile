FROM python:3.12-slim

# bluez + build deps needed by bleak/dbus on Linux, plus udev for serial device rules
RUN apt-get update && apt-get install -y --no-install-recommends \
    bluez \
    dbus \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
