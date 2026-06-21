FROM golang:1.24-bookworm AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o server ./cmd/main/

FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN useradd -m appuser && \
    mkdir -p /app/logs /app/front && \
    chown -R appuser:appuser /app

COPY --from=builder --chown=appuser:appuser /app/server /app/server
COPY --chown=appuser:appuser front/ /app/front/


WORKDIR /app
USER appuser
EXPOSE 8080
CMD ["./server"]