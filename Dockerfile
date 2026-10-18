# ====== Build stage ======
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Кеш зависимостей
COPY go.mod go.sum ./
RUN go mod download

# Копируем код
COPY . .

# Собираем статический бинарник
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o /server ./cmd/main

# ====== Runtime stage ====== 
FROM alpine:3.19

# Нестандартный пользователь для безопасности
RUN adduser -D -u 1000 appuser

WORKDIR /app

# Копируем только бинарник
COPY --from=builder /server /app/server

# Копируем фронтенд
COPY front/ /app/front/

# Создаём папку для логов с правильными правами
RUN mkdir -p /app/logs && chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

CMD ["./server"]