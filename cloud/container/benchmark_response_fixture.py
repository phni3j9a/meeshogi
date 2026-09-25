#!/usr/bin/env python3
"""Emit one successful v2 response from AnalysisService using a tiny fake USI engine."""

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
import sys
multi_pv = 2
for line in sys.stdin:
    command = line.strip()
    if command == "usi":
        print("id name Fake USI Engine", flush=True)
        for name in ("Threads", "USI_Hash", "MultiPV", "EvalDir", "FV_SCALE", "USI_Ponder", "USI_OwnBook", "BookFile", "GenerateAllLegalMoves"):
            print(f"option name {name} type spin default 1 min 1 max 128", flush=True)
        print("usiok", flush=True)
    elif command.startswith("setoption name MultiPV value "):
        multi_pv = int(command.rsplit(" ", 1)[1])
    elif command == "isready":
        print("readyok", flush=True)
    elif command.startswith("go "):
        moves = ("7g7f", "2g2f", "6g6f")
        for rank, move in enumerate(moves[:multi_pv], 1):
            print(f"info depth 1 multipv {rank} score cp {40 - rank} nodes 1200 time 100 nps 12000 pv {move}", flush=True)
        print("bestmove 7g7f", flush=True)
    elif command == "quit":
        break
'''


def main() -> None:
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
        runtime = {
            "driverBootId": driver.DRIVER_BOOT_ID,
            "expectedInstanceType": "standard-2",
            "osCpuCount": 1,
            "affinityCpuCount": 1,
            "cpuMax": None,
            "cpuQuota": None,
            "memoryMaxBytes": None,
            "memTotalBytes": 6 * driver.GIB - driver.GIB // 2,
            "rootDiskTotalBytes": 32 * driver.GIB,
        }
        with patch.dict(os.environ, {"ANALYSIS_BENCHMARK_ENABLED": "1", "ANALYSIS_EXPECTED_INSTANCE_TYPE": "standard-2"}), patch.object(
            driver, "runtime_facts", lambda _expected: runtime
        ):
            service = driver.AnalysisService(
                engine_path=engine,
                expected_manifest=manifest,
                conditions_manifest_path=Path(__file__).resolve().parents[1] / "bench" / "conditions.json",
                settings={"handshakeTimeoutSeconds": 2, "readyTimeoutSeconds": 2, "termGraceSeconds": 0.1},
            )
            status, response = service.benchmark_response({
                "sfen": "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
                "legalMoveCount": 30,
                "conditionId": "standard-2-t1-100ms-mpv2",
            })
        if status != 200 or response.get("status") != "success":
            raise RuntimeError(f"fake USI driver fixture did not succeed: status={status} response={response}")
        print(json.dumps(response, separators=(",", ":")))


if __name__ == "__main__":
    main()
