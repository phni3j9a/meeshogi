#!/usr/bin/env python3
"""Turn diagnostic JSONL into stable per-variant and A/B/C/D artifacts."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


VARIANTS = ("A", "B", "C", "D")
RAW_FIELDS = (
    "actualNodes",
    "completedDepth",
    "candidateCount",
    "senteScoreKind",
    "senteScoreValue",
    "staticSenteScore",
    "status",
    "terminal",
    "fallback",
    "budgetReached",
    "cancelled",
    "pvLegal",
    "engineId",
    "modelId",
    "evalMode",
    "candidates",
)
TSV_FIELDS = (
    "variant",
    "fixtureId",
    "sfen",
    "sideToMove",
    "inCheck",
    "legalMoves",
    "requestedNodes",
    "actualNodes",
    "maxDepth",
    "completedDepth",
    "requestedMultiPV",
    "candidateCount",
    "candidates",
    "senteScoreKind",
    "senteScoreValue",
    "staticSenteScore",
    "status",
    "terminal",
    "fallback",
    "budgetReached",
    "cancelled",
    "pvLegal",
    "threads",
    "specTopN",
    "ttSizeMb",
    "evalMode",
    "engineId",
    "modelId",
    "modelSha256",
    "bridgeInitialized",
    "sourceRevision",
)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: expected an object")
        records.append(value)
    if not records:
        raise ValueError(f"{path}: no diagnostic records")
    return records


def key(record: dict[str, Any]) -> tuple[str, int, int]:
    return (
        str(record["fixtureId"]),
        int(record["requestedNodes"]),
        int(record["requestedMultiPV"]),
    )


def json_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def write_variant(records: list[dict[str, Any]], output: Path, variant: str) -> None:
    records = sorted(records, key=key)
    (output / f"{variant}.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n"
    )
    with (output / f"{variant}.tsv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=TSV_FIELDS, delimiter="\t")
        writer.writeheader()
        for record in records:
            writer.writerow({field: json_cell(record.get(field)) for field in TSV_FIELDS})


def pair(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_score = before.get("senteScoreValue")
    after_score = after.get("senteScoreValue")
    same_kind = before.get("senteScoreKind") == after.get("senteScoreKind")
    return {
        "from": before["variant"],
        "to": after["variant"],
        "actualNodesDelta": after["actualNodes"] - before["actualNodes"],
        "completedDepthDelta": after["completedDepth"] - before["completedDepth"],
        "candidateCountDelta": after["candidateCount"] - before["candidateCount"],
        "scoreKindFrom": before.get("senteScoreKind"),
        "scoreValueFrom": before_score,
        "scoreKindTo": after.get("senteScoreKind"),
        "scoreValueTo": after_score,
        "sameScoreKindDelta": (
            after_score - before_score
            if same_kind and before_score is not None and after_score is not None
            else None
        ),
        "statusFrom": before.get("status"),
        "statusTo": after.get("status"),
        "terminalFrom": before.get("terminal"),
        "terminalTo": after.get("terminal"),
        "fallbackFrom": before.get("fallback"),
        "fallbackTo": after.get("fallback"),
        "budgetReachedFrom": before.get("budgetReached"),
        "budgetReachedTo": after.get("budgetReached"),
    }


def raw_columns(record: dict[str, Any], prefix: str) -> dict[str, Any]:
    return {f"{prefix}_{field}": json_cell(record.get(field)) for field in RAW_FIELDS}


def combined_table(records_by_variant: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    indexed = {
        variant: {key(record): record for record in records}
        for variant, records in records_by_variant.items()
    }
    keys = sorted(set().union(*(set(rows) for rows in indexed.values())))
    rows = []
    for record_key in keys:
        rows_by_variant = {variant: indexed[variant].get(record_key) for variant in VARIANTS}
        missing = [variant for variant, record in rows_by_variant.items() if record is None]
        if missing:
            raise ValueError(f"missing {missing} for comparison key {record_key}")
        first = rows_by_variant["A"]
        assert first is not None
        row: dict[str, Any] = {
            "fixtureId": first["fixtureId"],
            "sfen": first["sfen"],
            "sideToMove": first["sideToMove"],
            "inCheck": first["inCheck"],
            "legalMoves": first["legalMoves"],
            "requestedNodes": first["requestedNodes"],
            "maxDepth": first["maxDepth"],
            "requestedMultiPV": first["requestedMultiPV"],
        }
        for variant in VARIANTS:
            record = rows_by_variant[variant]
            assert record is not None
            row.update(raw_columns(record, variant))
        for before_name, after_name in (("A", "B"), ("B", "C"), ("C", "D")):
            before = rows_by_variant[before_name]
            after = rows_by_variant[after_name]
            assert before is not None and after is not None
            contribution = pair(before, after)
            prefix = f"{before_name}_to_{after_name}"
            row[f"{prefix}_actualNodesDelta"] = contribution["actualNodesDelta"]
            row[f"{prefix}_completedDepthDelta"] = contribution["completedDepthDelta"]
            row[f"{prefix}_candidateCountDelta"] = contribution["candidateCountDelta"]
            row[f"{prefix}_scoreTransition"] = (
                f"{contribution['scoreKindFrom']}:{contribution['scoreValueFrom']}->"
                f"{contribution['scoreKindTo']}:{contribution['scoreValueTo']}"
            )
            row[f"{prefix}_sameScoreKindDelta"] = contribution["sameScoreKindDelta"]
            row[f"{prefix}_statusTransition"] = (
                f"{contribution['statusFrom']}->{contribution['statusTo']}"
            )
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    records_by_variant = {
        variant: read_jsonl(args.input_dir / f"{variant}.jsonl") for variant in VARIANTS
    }
    for variant, records in records_by_variant.items():
        write_variant(records, args.output_dir, variant)

    rows = combined_table(records_by_variant)
    first = records_by_variant["A"][0]
    conditions = {
        "fixture": "fixtures/analysis/positions.json",
        "threads": first["threads"],
        "specTopN": first["specTopN"],
        "ttSizeMb": first["ttSizeMb"],
        "maxDepth": first["maxDepth"],
        "modelId": first["modelId"],
        "modelSha256": first["modelSha256"],
        "budgets": sorted({record["requestedNodes"] for record in records_by_variant["A"]}),
    }
    combined = {
        "schema": 1,
        "conditions": conditions,
        "variants": {variant: records_by_variant[variant] for variant in VARIANTS},
        "comparisons": rows,
    }
    (args.output_dir / "combined.json").write_text(
        json.dumps(combined, ensure_ascii=False, indent=2) + "\n"
    )
    tsv_fields = list(rows[0])
    with (args.output_dir / "combined.tsv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=tsv_fields, delimiter="\t")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: json_cell(row.get(field)) for field in tsv_fields})
    print(f"wrote {len(rows)} combined rows to {args.output_dir}")


if __name__ == "__main__":
    main()
