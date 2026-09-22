//! Diagnostic-only A/B/C/D runner.
//!
//! The shell harness supplies a path dependency containing exactly one
//! Sekirei core revision. Variant D additionally includes the product bridge
//! from the candidate worktree so its model initialization and evaluation-mode
//! selection are compiled and executed before the controlled core probe.

use serde::{Deserialize, Serialize};
use sekirei_core::{
    board::Board,
    color::Color,
    eval,
    movegen::{generate_legal_moves, is_in_check},
    mv::Move,
    nnue,
    search::{MATE_SCORE, SearchConfig, SpeculativeSearcher},
    sfen::move_to_usi,
    tt::Tt,
};
use std::{env, fs, path::Path};

#[cfg(feature = "product_bridge")]
#[path = "product_bridge.rs"]
mod product_bridge;

const MODEL_ID: &str =
    "c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab";
const MODEL_SHA256: &str = "807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab";
const MAX_DEPTH: u32 = 8;
const TT_SIZE_MB: usize = 16;
const SPEC_TOP_N: usize = 0;
const THREADS: u32 = 1;
const MAX_PV_PLIES: usize = 64;
const MATE_THRESHOLD: i32 = MATE_SCORE - 1_000;

const A_ENGINE_ID: &str =
    "sekirei-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8+diagnostic-nnue-only";
const B_ENGINE_ID: &str =
    "sekirei-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8+diagnostic-single-root-search";
const C_ENGINE_ID: &str =
    "sekirei-v0.3.37@7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac+diagnostic-absolute";

#[derive(Debug, Deserialize)]
struct FixtureFile {
    positions: Vec<FixturePosition>,
}

#[derive(Debug, Deserialize)]
struct FixturePosition {
    id: String,
    sfen: String,
    #[serde(default)]
    expected: FixtureExpected,
}

#[derive(Debug, Default, Deserialize)]
struct FixtureExpected {
    #[serde(rename = "requestedMultiPV")]
    requested_multi_pv: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CandidateRecord {
    usi: String,
    pv: Vec<String>,
    pv_legal: bool,
    engine_score: i32,
    score_kind: &'static str,
    sente_score: i32,
    depth: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema: u32,
    variant: String,
    variant_kind: &'static str,
    source_revision: &'static str,
    eval_mode: &'static str,
    engine_id: String,
    model_id: &'static str,
    model_sha256: &'static str,
    bridge_initialized: bool,
    fixture_id: String,
    sfen: String,
    side_to_move: &'static str,
    in_check: bool,
    legal_moves: usize,
    requested_nodes: u64,
    actual_nodes: u64,
    max_depth: u32,
    completed_depth: u32,
    #[serde(rename = "requestedMultiPV")]
    requested_multi_pv: u32,
    candidate_count: usize,
    candidates: Vec<CandidateRecord>,
    sente_score_kind: Option<&'static str>,
    sente_score_value: Option<i32>,
    static_sente_score: Option<i32>,
    status: &'static str,
    terminal: Option<&'static str>,
    fallback: bool,
    budget_reached: bool,
    cancelled: bool,
    pv_legal: bool,
    threads: u32,
    spec_top_n: usize,
    tt_size_mb: usize,
}

fn side_name(side: Color) -> &'static str {
    if side == Color::Black {
        "black"
    } else {
        "white"
    }
}

fn sente_score(score: i32, side: Color) -> i32 {
    if side == Color::Black {
        score
    } else {
        -score
    }
}

fn score_kind_value(score: i32, side: Color) -> (&'static str, i32) {
    let black_score = sente_score(score, side);
    if score.abs() >= MATE_THRESHOLD {
        let distance = (MATE_SCORE - black_score.abs()).max(1);
        if black_score >= 0 {
            ("mate", distance)
        } else {
            ("mate", -distance)
        }
    } else {
        ("cp", black_score)
    }
}

fn terminal_kind(board: &mut Board, legal_count: usize) -> Option<&'static str> {
    if legal_count != 0 {
        return None;
    }
    if is_in_check(board, board.side_to_move) {
        Some("checkmate")
    } else {
        Some("no-legal-moves")
    }
}

fn is_legal_move(legal_moves: &[Move], candidate: Move) -> bool {
    legal_moves.contains(&candidate)
}

fn extract_pv(searcher: &SpeculativeSearcher, initial: &Board, first: Move) -> Vec<String> {
    let mut board = initial.clone();
    let mut result = Vec::with_capacity(MAX_PV_PLIES);
    let mut next = Some(first);
    for _ in 0..MAX_PV_PLIES {
        let Some(candidate) = next else { break };
        let legal = generate_legal_moves(&mut board);
        if !legal.contains(&candidate) {
            break;
        }
        result.push(move_to_usi(candidate));
        board.do_move(candidate);
        next = searcher.probe_tt(board.hash());
    }
    result
}

fn identity(variant: &str) -> String {
    #[cfg(feature = "product_bridge")]
    if variant == "D" {
        return product_bridge::ENGINE_ID.to_string();
    }
    match variant {
        "A" => A_ENGINE_ID.to_string(),
        "B" => B_ENGINE_ID.to_string(),
        "C" => C_ENGINE_ID.to_string(),
        other => panic!("unknown variant: {other}"),
    }
}

fn variant_kind(variant: &str) -> &'static str {
    match variant {
        "A" => "baseline",
        "B" => "single-root-diagnostic",
        "C" => "v037-absolute",
        "D" => "product-residual-material",
        other => panic!("unknown variant: {other}"),
    }
}

fn source_revision(variant: &str) -> &'static str {
    match variant {
        "A" | "B" => "sekirei-core-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8",
        "C" | "D" => "sekirei-core-v0.3.37@7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac",
        other => panic!("unknown variant: {other}"),
    }
}

fn eval_mode(variant: &str) -> &'static str {
    match variant {
        "A" | "B" => "nnue-only",
        "C" => "absolute",
        "D" => "residual-material",
        other => panic!("unknown variant: {other}"),
    }
}

#[allow(unused_variables)]
fn initialize_model(variant: &str, model_path: &Path) {
    #[cfg(feature = "product_bridge")]
    if variant == "D" {
        product_bridge::initialize_model_path(
            model_path
                .to_str()
                .expect("model path must be valid UTF-8"),
        )
        .expect("product bridge model initialization");
        return;
    }
    nnue::load_weights(model_path).expect("diagnostic model load");
}

fn budgets_for(fixture_id: &str, include_deep: bool) -> Vec<u64> {
    let mut budgets = vec![1, 10_000];
    if include_deep
        && matches!(
            fixture_id,
            "sequence-start"
                | "sequence-after-first"
                | "sequence-after-reply"
                | "sequence-terminal"
        )
    {
        budgets.extend([100_000, 1_000_000]);
    }
    budgets
}

fn analyze(
    variant: &str,
    fixture: &FixturePosition,
    requested_nodes: u64,
    requested_multi_pv: u32,
) -> Record {
    let mut initial = Board::from_sfen(&fixture.sfen).expect("fixture SFEN must parse");
    let side = initial.side_to_move;
    let mut legal_board = initial.clone();
    let legal_moves = generate_legal_moves(&mut legal_board);
    let legal_count = legal_moves.len();
    let in_check = is_in_check(&mut initial.clone(), side);
    let terminal = terminal_kind(&mut legal_board, legal_count);
    let static_sente_score = (!terminal.is_some()).then(|| sente_score(eval::evaluate(&initial), side));
    let expected_candidates = (requested_multi_pv as usize).min(legal_count);

    if let Some(terminal) = terminal {
        return Record {
            schema: 1,
            variant: variant.to_string(),
            variant_kind: variant_kind(variant),
            source_revision: source_revision(variant),
            eval_mode: eval_mode(variant),
            engine_id: identity(variant),
            model_id: MODEL_ID,
            model_sha256: MODEL_SHA256,
            bridge_initialized: cfg!(feature = "product_bridge"),
            fixture_id: fixture.id.clone(),
            sfen: fixture.sfen.clone(),
            side_to_move: side_name(side),
            in_check,
            legal_moves: legal_count,
            requested_nodes,
            actual_nodes: 0,
            max_depth: MAX_DEPTH,
            completed_depth: 0,
            requested_multi_pv,
            candidate_count: 0,
            candidates: Vec::new(),
            sente_score_kind: None,
            sente_score_value: None,
            static_sente_score,
            status: "complete",
            terminal: Some(terminal),
            fallback: false,
            budget_reached: false,
            cancelled: false,
            pv_legal: true,
            threads: THREADS,
            spec_top_n: SPEC_TOP_N,
            tt_size_mb: TT_SIZE_MB,
        };
    }

    let searcher = SpeculativeSearcher::new(Tt::new(TT_SIZE_MB), SPEC_TOP_N);
    let result = searcher.search(
        &mut initial,
        SearchConfig {
            max_depth: MAX_DEPTH,
            time_limit: None,
            node_limit: Some(requested_nodes),
            soft_limit: None,
            multi_pv: requested_multi_pv,
        },
    );

    let mut lines = result.pv_list.clone();
    if lines.is_empty() {
        if let Some(best_move) = result.best_move.filter(|candidate| is_legal_move(&legal_moves, *candidate)) {
            lines.push((best_move, result.score));
        }
    }
    lines.retain(|(candidate, _)| is_legal_move(&legal_moves, *candidate));
    let mut seen = Vec::with_capacity(lines.len());
    lines.retain(|(candidate, _)| {
        if seen.contains(candidate) {
            false
        } else {
            seen.push(*candidate);
            true
        }
    });
    lines.truncate(expected_candidates);

    let mut candidates = Vec::with_capacity(lines.len());
    for (candidate, score) in lines {
        let (score_kind, sente_value) = score_kind_value(score, side);
        candidates.push(CandidateRecord {
            usi: move_to_usi(candidate),
            pv: extract_pv(&searcher, &initial, candidate),
            pv_legal: true,
            engine_score: score,
            score_kind,
            sente_score: sente_value,
            depth: result.depth,
        });
    }

    let fallback = result.depth == 0 && !candidates.is_empty();
    let complete = result.depth > 0 && candidates.len() == expected_candidates;
    let status = if complete { "complete" } else { "incomplete" };
    let (sente_score_kind, sente_score_value) = candidates
        .first()
        .map(|candidate| (Some(candidate.score_kind), Some(candidate.sente_score)))
        .unwrap_or((None, None));

    Record {
        schema: 1,
        variant: variant.to_string(),
        variant_kind: variant_kind(variant),
        source_revision: source_revision(variant),
        eval_mode: eval_mode(variant),
        engine_id: identity(variant),
        model_id: MODEL_ID,
        model_sha256: MODEL_SHA256,
        bridge_initialized: cfg!(feature = "product_bridge"),
        fixture_id: fixture.id.clone(),
        sfen: fixture.sfen.clone(),
        side_to_move: side_name(side),
        in_check,
        legal_moves: legal_count,
        requested_nodes,
        actual_nodes: result.nodes,
        max_depth: MAX_DEPTH,
        completed_depth: result.depth,
        requested_multi_pv,
        candidate_count: candidates.len(),
        candidates,
        sente_score_kind,
        sente_score_value,
        static_sente_score,
        status,
        terminal: None,
        fallback,
        budget_reached: result.nodes >= requested_nodes,
        cancelled: false,
        pv_legal: true,
        threads: THREADS,
        spec_top_n: SPEC_TOP_N,
        tt_size_mb: TT_SIZE_MB,
    }
}

fn main() {
    let mut args = env::args().skip(1);
    let variant = args.next().expect("usage: runner VARIANT MODEL FIXTURE");
    let model_path = args.next().expect("missing model path");
    let fixture_path = args.next().expect("missing fixture path");
    let fixture_text = fs::read_to_string(&fixture_path).expect("read fixture file");
    let fixture: FixtureFile = serde_json::from_str(&fixture_text).expect("parse fixture JSON");
    let include_deep = env::var_os("MEESHOGI_DIAGNOSTIC_DEEP").is_some();

    rayon::ThreadPoolBuilder::new()
        .num_threads(THREADS as usize)
        .build_global()
        .expect("single diagnostic rayon pool");
    initialize_model(&variant, Path::new(&model_path));

    for position in fixture.positions {
        let requested_multi_pv = position.expected.requested_multi_pv.unwrap_or(1);
        for requested_nodes in budgets_for(&position.id, include_deep) {
            let record = analyze(&variant, &position, requested_nodes, requested_multi_pv);
            println!(
                "{}",
                serde_json::to_string(&record).expect("serialize diagnostic record")
            );
        }
    }
}
