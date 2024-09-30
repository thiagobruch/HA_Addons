# FROM ${BUILD_FROM} --platform=$BUILDPLATFORM golang:alpine AS builder
ARG BUILD_FROM TARGETOS TARGETARCH
FROM ${BUILD_FROM}
# FROM 
USER root



WORKDIR /app

COPY go.mod go.sum ./
# RUN go mod download
COPY *.go ./
COPY cmd ./cmd
COPY internal ./internal

# Build

#RUN CGO_ENABLED=0 GOGC=75 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags "-w -s" -o /agent ./cmd/agent
RUN CGO_ENABLED=0 GOGC=75 GOARCH=amd64 go build -ldflags "-w -s" -o /agent ./cmd/agent

# ? -------------------------
FROM scratch

COPY --from=builder /agent /agent

ENTRYPOINT ["/agent"]
