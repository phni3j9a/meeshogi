#!/usr/bin/env python3
"""Generate reproducible v2 benchmark outcomes through AnalysisService and a fake USI engine."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver  # noqa: E402


FAKE_USI = r'''#!/usr/bin/env python3
import os
import signal
import sys
import time
scenario = os.environ.get("DRIVER_FIXTURE_SCENARIO", "success")
multi_pv = 2
for line in sys.stdin:
    command = line.strip()
    if command == "usi":
        print("id name Other Engine" if scenario == "identity_mismatch" else "id name Fake USI Engine", flush=True)
        for name in ("Threads", "USI_Hash", "MultiPV", "EvalDir", "FV_SCALE", "USI_Ponder", "USI_OwnBook", "BookFile", "GenerateAllLegalMoves"):
            print(f"option name {name} type spin default 1 min 1 max 128", flush=True)
        print("usiok", flush=True)
    elif command.startswith("setoption name MultiPV value "):
        multi_pv = int(command.rsplit(" ", 1)[1])
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go "):
        moves = ("7g7f", "2g2f", "6g6f")
        if scenario in {"unexpected_exit_code", "unexpected_signal"}:
            print("info depth 1 multipv 1 score cp 39 nodes 1200 time 100 nps 12000 pv 7g7f", flush=True)
            if scenario == "unexpected_exit_code":
                os._exit(23)
            os.kill(os.getpid(), signal.SIGTERM)
        if scenario == "timeout":
            print("info depth 1 multipv 1 score cp 39 nodes 1200 time 10 nps 120000 pv 7g7f", flush=True)
            while True:
                time.sleep(1)
        selected = moves[:1] if scenario == "incomplete" else moves[:multi_pv]
        for rank, move in enumerate(selected, 1):
            print(f"info depth 1 multipv {rank} score cp {40 - rank} nodes 1200 time 100 nps 12000 pv {move}", flush=True)
        print("bestmove bogus" if scenario == "engine_error" else "bestmove resign" if scenario == "resign" else "bestmove 7g7f", flush=True)
    elif command == "quit":
        break
'''


def main() -> None:
    scenario = sys.argv[1] if len(sys.argv) > 1 else "success"
    supported = {
        "success", "incomplete", "resign", "busy", "instance_mismatch", "timeout", "identity_mismatch", "engine_error",
        "unexpected_exit_code", "unexpected_signal",
    }
    if scenario not in supported:
        raise SystemExit(f"unsupported benchmark fixture scenario: {scenario}")
    with tempfile.TemporaryDirectory(prefix="meeshogi-fake-usi-") as directory:
        engine = Path(directory) / "fake-usi"
        engine.write_text(FAKE_USI, encoding="utf-8")
        engine.chmod(0o755)
        digest = "a" * 64
        manifest = {
            "engineName": "Fake USI Engine",
            "engineUsiNameContains": "Fake USI Engine",
            "engineSha256": digest,
            "modelId": "fixture-model",
            "weightSha256": "b" * 64,
            "optionsSha256": "c" * 64,
            "optionsText": "fixture options",
            "sourceArchive": "fixture.tar",
            "sourceArchiveSha256": "d" * 64,
            "sourceTreeSha256": "e" * 64,
            "buildInfo": "test fixture",
            "driverVersion": "usi-driver-v1",
            "contractVersion": "analysis-json-v1",
        }
        expected_instance_type = "standard-3" if scenario == "instance_mismatch" else "standard-2"
        expected_cpu = 2 if expected_instance_type == "standard-3" else 1
        expected_memory = (8 if expected_instance_type == "standard-3" else 6) * driver.GIB
        runtime = {
            "driverBootId": driver.DRIVER_BOOT_ID,
            "expectedInstanceType": expected_instance_type,
            "osCpuCount": expected_cpu,
            "affinityCpuCount": expected_cpu,
            "cpuMax": None,
            "cpuQuota": None,
            "memoryMaxBytes": None,
            "memTotalBytes": expected_memory - driver.GIB // 2,
            "rootDiskTotalBytes": 32 * driver.GIB,
        }
        with patch.dict(os.environ, {
            "ANALYSIS_BENCHMARK_ENABLED": "1",
            "ANALYSIS_EXPECTED_INSTANCE_TYPE": expected_instance_type,
            "DRIVER_FIXTURE_SCENARIO": scenario,
        }), patch.object(
            driver, "runtime_facts", lambda _expected: runtime
        ):
            service = driver.AnalysisService(
                engine_path=engine,
                expected_manifest=manifest,
                conditions_manifest_path=Path(__file__).resolve().parents[1] / "bench" / "conditions.json",
                settings={
                    "handshakeTimeoutSeconds": 2, "readyTimeoutSeconds": 2, "searchGraceMs": 20,
                    "termGraceSeconds": 0.05, "stopResponseGraceSeconds": 0.05, "killGraceSeconds": 0.1,
                },
                build_info={"buildId": "9" * 32, "gitCommit": "a" * 40},
            )
            if scenario == "busy":
                service.busy.acquire()
            try:
                status, response = service.benchmark_response({
                    "sfen": "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
                    "legalMoveCount": 30,
                    "conditionId": "standard-2-t1-100ms-mpv2",
                })
            finally:
                if scenario == "busy":
                    service.busy.release()
        if len(sys.argv) > 1:
            print(json.dumps({"httpStatus": status, "response": response}, separators=(",", ":")))
        else:
            if status != 200 or response.get("status") != "success":
                raise RuntimeError(f"fake USI driver fixture did not succeed: status={status} response={response}")
            print(json.dumps(response, separators=(",", ":")))


if __name__ == "__main__":
    main()
