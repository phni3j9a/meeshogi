FROM ubuntu:24.04

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DRIVER_PORT=8080 \
    ENGINE_PATH=/opt/engine/engine \
    WEIGHT_PATH=/opt/engine/nn.bin \
    ENGINE_OPTIONS_PATH=/opt/engine/engine_options.txt \
    ARTIFACT_MANIFEST_PATH=/opt/app/artifact-manifest.json \
    CONDITIONS_MANIFEST_PATH=/opt/app/conditions.json \
    JOB_PROFILES_PATH=/opt/app/job-profiles.json \
    BUILD_INFO_PATH=/opt/app/build-info.json

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      coreutils grep passwd python3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin analysis \
    && install -d -o analysis -g analysis -m 0750 /opt/app /opt/engine

COPY --chown=analysis:analysis driver.py /opt/app/driver.py
COPY --chown=analysis:analysis artifact-manifest.json /opt/app/artifact-manifest.json
COPY --chown=analysis:analysis conditions.json /opt/app/conditions.json
COPY --chown=analysis:analysis job-profiles.json /opt/app/job-profiles.json
COPY --chown=analysis:analysis build-info.json /opt/app/build-info.json
COPY --chown=analysis:analysis engine /opt/engine/engine
COPY --chown=analysis:analysis nn.bin /opt/engine/nn.bin
COPY --chown=analysis:analysis engine_options.txt /opt/engine/engine_options.txt

RUN chmod 0550 /opt/app/driver.py /opt/engine/engine \
    && chmod 0440 /opt/app/artifact-manifest.json /opt/app/conditions.json /opt/app/job-profiles.json /opt/app/build-info.json /opt/engine/nn.bin /opt/engine/engine_options.txt

USER analysis
WORKDIR /opt/engine
RUN output="$(printf '%s\n' \
      'usi' \
      'setoption name Threads value 1' \
      'setoption name USI_Hash value 64' \
      'setoption name MultiPV value 3' \
      'setoption name EvalDir value /opt/engine' \
      'setoption name FV_SCALE value 40' \
      'setoption name USI_Ponder value false' \
      'setoption name USI_OwnBook value false' \
      'setoption name BookFile value no_book' \
      'setoption name GenerateAllLegalMoves value true' \
      'isready' \
      'quit' \
    | timeout 20 /opt/engine/engine)" \
    && printf '%s\n' "$output" | grep -qx 'usiok' \
    && printf '%s\n' "$output" | grep -qx 'readyok'
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/app/driver.py"]
