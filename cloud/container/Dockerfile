FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DRIVER_PORT=8080 \
    ENGINE_PATH=/opt/engine/engine \
    WEIGHT_PATH=/opt/engine/nn.bin \
    ENGINE_OPTIONS_PATH=/opt/engine/engine_options.txt \
    ARTIFACT_MANIFEST_PATH=/opt/app/artifact-manifest.json

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin analysis \
    && install -d -o analysis -g analysis -m 0750 /opt/app /opt/engine

COPY --chown=analysis:analysis driver.py /opt/app/driver.py
COPY --chown=analysis:analysis artifact-manifest.json /opt/app/artifact-manifest.json
COPY --chown=analysis:analysis engine /opt/engine/engine
COPY --chown=analysis:analysis nn.bin /opt/engine/nn.bin
COPY --chown=analysis:analysis engine_options.txt /opt/engine/engine_options.txt

RUN chmod 0550 /opt/app/driver.py /opt/engine/engine \
    && chmod 0440 /opt/app/artifact-manifest.json /opt/engine/nn.bin /opt/engine/engine_options.txt

USER analysis
WORKDIR /opt/engine
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/app/driver.py"]
