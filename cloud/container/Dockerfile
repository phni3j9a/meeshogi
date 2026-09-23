ARG RUST_BUILDER_IMAGE=rust:1.96.0-slim-bookworm
ARG BASE_IMAGE=ubuntu:24.04
FROM --platform=linux/amd64 ${RUST_BUILDER_IMAGE} AS helper-builder

WORKDIR /build
COPY helper-src/ /build/helper-src/
RUN cargo build --release --locked \
    --manifest-path /build/helper-src/Cargo.toml \
    --target x86_64-unknown-linux-gnu

FROM --platform=linux/amd64 ${BASE_IMAGE} AS runtime

ARG EXPECTED_ENGINE_SHA256=0cb27c8302f6eb357cd360372defe172401519c06fb4bf28eb2bf72ee0f39d80
ARG EXPECTED_WEIGHT_SHA256=a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829
ENV EXPECTED_ENGINE_SHA256=${EXPECTED_ENGINE_SHA256} \
    EXPECTED_WEIGHT_SHA256=${EXPECTED_WEIGHT_SHA256} \
    ENGINE_PATH=/opt/engine/engine \
    WEIGHT_PATH=/opt/engine/nn.bin \
    HELPER_PATH=/opt/app/helper-sekirei \
    ENGINE_OPTIONS_PATH=/opt/engine/engine_options.txt \
    DRIVER_PORT=8080

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 meeshogi \
    && useradd --system --uid 10001 --gid meeshogi --home-dir /nonexistent --shell /usr/sbin/nologin meeshogi \
    && install -d --owner=meeshogi --group=meeshogi --mode=0750 /opt/engine /opt/app

COPY engine /opt/engine/engine
COPY nn.bin /opt/engine/nn.bin
COPY engine_options.txt /opt/engine/engine_options.txt
COPY driver.py /opt/app/driver.py
COPY --from=helper-builder /build/helper-src/target/x86_64-unknown-linux-gnu/release/helper-sekirei /opt/app/helper-sekirei

RUN chown root:meeshogi /opt/engine/engine /opt/engine/nn.bin /opt/engine/engine_options.txt \
    && chmod 0550 /opt/engine/engine \
    && chmod 0440 /opt/engine/nn.bin /opt/engine/engine_options.txt \
    && chown root:meeshogi /opt/app/driver.py /opt/app/helper-sekirei \
    && chmod 0440 /opt/app/driver.py \
    && chmod 0550 /opt/app/helper-sekirei

WORKDIR /opt/engine
USER 10001:10001
EXPOSE 8080
CMD ["python3", "/opt/app/driver.py"]
