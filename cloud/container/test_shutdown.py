"""Real HTTP server/process tests; synthetic engine only, no private artifacts."""
from __future__ import annotations

import http.client
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path

import test_driver as fixtures


LAUNCH = """
import json, sys
from pathlib import Path
import driver
import test_driver as fixtures
root = Path(sys.argv[1])
service = driver.AnalysisService(
    engine_path=root / 'fake-engine',
    expected_manifest=json.loads((root / 'artifact-manifest.json').read_text()),
    settings={'moveTimeMs': 60000, 'searchGraceMs': 60000, 'termGraceSeconds': 0.1},
)
service.expected_instance_type = 'standard-2'
driver.runtime_facts = lambda expected: fixtures.benchmark_runtime(expected or 'standard-2')
raise SystemExit(driver.serve(service, ('127.0.0.1', 0)))
"""


class ShutdownTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = fixtures.DriverTests()
        self.fixture.setUp()
        self.process: subprocess.Popen[str] | None = None

    def tearDown(self) -> None:
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
            self.process.communicate(timeout=5)
        # Failed assertions must not leave a synthetic hung engine behind.
        if self.fixture.pids_path.exists():
            for value in self.fixture.pids_path.read_text().splitlines():
                pid = int(value)
                try:
                    command = Path(f'/proc/{pid}/cmdline').read_bytes()
                    if str(self.fixture.engine_path).encode() in command:
                        os.kill(pid, signal.SIGKILL)
                except (FileNotFoundError, ProcessLookupError):
                    pass
        self.fixture.tearDown()

    def launch(self, scenario: str = 'normal') -> int:
        self.fixture.service(scenario)  # Supplies the fixture's isolated engine environment.
        self.process = subprocess.Popen(
            [sys.executable, '-u', '-c', LAUNCH, str(self.fixture.root)],
            cwd=Path(__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=5), 'driver did not open its listener')
        started = json.loads(self.process.stdout.readline())
        self.assertEqual(started['event'], 'driver_started')
        return started['port']

    def stop(self) -> list[dict]:
        assert self.process is not None
        self.process.send_signal(signal.SIGTERM)
        stdout, stderr = self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 0, stderr)
        events = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual(events[-1]['event'], 'driver_stopped')
        self.assertTrue(events[-1]['engineReaped'])
        return events

    def test_sigterm_stops_idle_server_with_keepalive_and_partial_request(self) -> None:
        port = self.launch()
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        partial = socket.create_connection(('127.0.0.1', port), timeout=3)
        try:
            connection.request('GET', '/ping')
            self.assertEqual(connection.getresponse().read(), b'{"status":"ready"}')
            partial.sendall(b'POST /analyze HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{')
            self.stop()
        finally:
            connection.close()
            partial.close()

    def test_sigterm_reaps_hung_engine_during_session(self) -> None:
        port = self.launch('hang-once')
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        profiles = json.loads((Path(__file__).parents[1] / 'config/job-profiles.json').read_text())
        profile = profiles['profiles']['free']
        body = {
            'contract': 'analysis-session-v1', 'profileId': 'free',
            'conditions': {key: profile[key] for key in ('threads', 'hashMb', 'moveTimeMs', 'multiPV')},
            'positions': [{'ply': 0, 'sfen': fixtures.STARTPOS, 'legalMoveCount': 30}],
            'deadlineMs': 700000,
        }
        try:
            connection.request('POST', '/session', json.dumps(body), {'content-type': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                self.fail(f'session rejected: {response.status} {response.read().decode()}')
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if self.fixture.commands_path.exists() and 'go movetime' in self.fixture.commands_path.read_text():
                    break
                time.sleep(0.02)
            else:
                self.fail('engine did not start searching')
            self.stop()
            pids = self.fixture.pids_path.read_text().splitlines()
            self.assertEqual(len(pids), 1)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pids[0]), 0)
        finally:
            connection.close()


if __name__ == '__main__':
    unittest.main()
