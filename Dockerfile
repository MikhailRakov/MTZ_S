# === Stage 1: Сборка Go-приложения ===
FROM golang:1.24-bookworm AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o server ./cmd/main/

# === Stage 2: Финальный образ ===
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# Обновляем CA-сертификаты (решает проблему с Firebase)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && update-ca-certificates --fresh \
    && rm -rf /var/lib/apt/lists/*

# Создаём пользователя и директории
RUN useradd -m appuser && \
    mkdir -p /app/logs /app/front && \
    chown -R appuser:appuser /app

# Копируем бинарник
COPY --from=builder --chown=appuser:appuser /app/server /app/server

# Копируем фронтенд
COPY --chown=appuser:appuser front/ /app/front/

WORKDIR /app
USER appuser
EXPOSE 8080
CMD ["./server"]