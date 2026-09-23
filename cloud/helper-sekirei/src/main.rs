use std::env;
use std::process;

use sekirei_core::board::Board;
use sekirei_core::color::Color;
use sekirei_core::movegen::{generate_legal_moves, is_in_check};
use sekirei_core::mv::Move;
use sekirei_core::piece::PieceKind;
use sekirei_core::sfen::{move_from_usi, move_to_usi};
use sekirei_core::square::Square;
use serde_json::{Value, json};

const BUDGET_VERSION: &str = "sekirei-proof-ops-v1";
const MAX_BUDGET: u64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProofResult {
    Proven(u8),
    NotMate,
    BudgetExceeded,
}

struct Budget {
    limit: u64,
    used: u64,
}

impl Budget {
    fn tick(&mut self) -> Result<(), ()> {
        if self.used >= self.limit {
            return Err(());
        }
        self.used += 1;
        Ok(())
    }
}

fn checked_board(sfen: &str) -> Result<Board, String> {
    Board::from_sfen_rules_only(sfen).map_err(|error| format!("invalid SFEN: {error}"))
}

fn legal_info(sfen: &str) -> Result<Value, String> {
    let mut board = checked_board(sfen)?;
    let in_check = is_in_check(&board, board.side_to_move);
    let moves = generate_legal_moves(&mut board);
    let legal_moves: Vec<String> = moves.into_iter().map(move_to_usi).collect();
    let declaration_win = can_declare_win(&board);
    Ok(json!({
        "legalMoveCount": legal_moves.len(),
        "legalMoves": legal_moves,
        "inCheck": in_check,
        "declarationWin": declaration_win,
    }))
}

fn validate_pv(sfen: &str, moves: &str) -> Result<Value, String> {
    let mut board = checked_board(sfen)?;
    for token in moves.split_whitespace() {
        let Ok(mv) = move_from_usi(token, &board) else {
            return Ok(json!({ "legal": false }));
        };
        board.do_move(mv);
    }
    Ok(json!({ "legal": true }))
}

fn piece_points(kind: PieceKind) -> u32 {
    match kind {
        PieceKind::Ou => 0,
        PieceKind::Kaku | PieceKind::Hisha | PieceKind::Uma | PieceKind::Ryu => 5,
        _ => 1,
    }
}

fn in_enemy_camp(color: Color, rank: u8) -> bool {
    match color {
        Color::Black => rank <= 3,
        Color::White => rank >= 7,
    }
}

/// Checks the board-state requirements for an entering-king declaration.
/// Clock availability cannot be represented by SFEN and is intentionally not inferred.
fn can_declare_win(board: &Board) -> bool {
    let color = board.side_to_move;
    if is_in_check(board, color) {
        return false;
    }
    let Some(king) = board.king_square(color) else {
        return false;
    };
    if !in_enemy_camp(color, king.rank()) {
        return false;
    }

    let mut camp_pieces = 0u32;
    let mut points = 0u32;
    for index in 0..Square::NUM as u8 {
        let square = Square::from_index(index);
        if let Some(piece) = board.piece_at(square)
            && piece.color == color
            && in_enemy_camp(color, square.rank())
        {
            if piece.kind != PieceKind::Ou {
                camp_pieces += 1;
            }
            points += piece_points(piece.kind);
        }
    }
    for kind in [
        PieceKind::Fu,
        PieceKind::Kyou,
        PieceKind::Kei,
        PieceKind::Gin,
        PieceKind::Kin,
        PieceKind::Kaku,
        PieceKind::Hisha,
    ] {
        points += u32::from(board.hand(color).get(kind)) * piece_points(kind);
    }
    let threshold = match color {
        Color::Black => 28,
        Color::White => 27,
    };
    camp_pieces >= 10 && points >= threshold
}

fn is_checkmate_after(
    board: &mut Board,
    move_to_play: Move,
    budget: &mut Budget,
) -> Result<bool, ()> {
    budget.tick()?;
    let legal = generate_legal_moves(board);
    if !legal.contains(&move_to_play) {
        return Ok(false);
    }
    let token = board.do_move(move_to_play);
    let checked = is_in_check(board, board.side_to_move);
    let replies = if checked {
        if budget.tick().is_err() {
            board.undo_move(token);
            return Err(());
        }
        generate_legal_moves(board)
    } else {
        Vec::new()
    };
    board.undo_move(token);
    Ok(checked && replies.is_empty())
}

fn prove_short_mate(board: &Board, plies: u8, limit: u64) -> (ProofResult, u64) {
    if is_in_check(board, board.side_to_move) {
        return (ProofResult::NotMate, 0);
    }
    let mut budget = Budget { limit, used: 0 };
    let mut position = board.clone();
    let first_moves = match budget.tick().map(|_| generate_legal_moves(&mut position)) {
        Ok(moves) => moves,
        Err(()) => return (ProofResult::BudgetExceeded, budget.used),
    };

    for first in first_moves.iter().copied() {
        match is_checkmate_after(&mut position, first, &mut budget) {
            Ok(true) => return (ProofResult::Proven(1), budget.used),
            Ok(false) => {}
            Err(()) => return (ProofResult::BudgetExceeded, budget.used),
        }
    }
    if plies == 1 {
        return (ProofResult::NotMate, budget.used);
    }

    // The attacker must check on ply one, and every legal reply must have a
    // checking mate in one. The representative PV is not used as the proof.
    for first in first_moves {
        if budget.tick().is_err() {
            return (ProofResult::BudgetExceeded, budget.used);
        }
        let first_token = position.do_move(first);
        if !is_in_check(&position, position.side_to_move) {
            position.undo_move(first_token);
            continue;
        }
        let replies = match budget.tick().map(|_| generate_legal_moves(&mut position)) {
            Ok(moves) => moves,
            Err(()) => {
                position.undo_move(first_token);
                return (ProofResult::BudgetExceeded, budget.used);
            }
        };
        if replies.is_empty() {
            position.undo_move(first_token);
            continue;
        }
        let mut representative = None;
        let mut forced = true;
        for reply in replies {
            if budget.tick().is_err() {
                position.undo_move(first_token);
                return (ProofResult::BudgetExceeded, budget.used);
            }
            let reply_token = position.do_move(reply);
            let candidate_mates = generate_legal_moves(&mut position);
            let mut finisher = None;
            for candidate in candidate_mates {
                match is_checkmate_after(&mut position, candidate, &mut budget) {
                    Ok(true) => {
                        finisher = Some(candidate);
                        break;
                    }
                    Ok(false) => {}
                    Err(()) => {
                        position.undo_move(reply_token);
                        position.undo_move(first_token);
                        return (ProofResult::BudgetExceeded, budget.used);
                    }
                }
            }
            position.undo_move(reply_token);
            let Some(finisher) = finisher else {
                forced = false;
                break;
            };
            if representative.is_none() {
                representative = Some((reply, finisher));
            }
        }
        position.undo_move(first_token);
        if forced && representative.is_some() {
            return (ProofResult::Proven(3), budget.used);
        }
    }
    (ProofResult::NotMate, budget.used)
}

fn mate_proof(sfen: &str, plies: u8, limit: u64) -> Result<Value, String> {
    if !matches!(plies, 1 | 3) {
        return Err("plies must be 1 or 3".to_string());
    }
    if limit > MAX_BUDGET {
        return Err(format!("budget must be at most {MAX_BUDGET}"));
    }
    let board = checked_board(sfen)?;
    if is_in_check(&board, board.side_to_move) {
        return Ok(json!({
            "result": "in-check-invalid",
            "plies": null,
            "nodesUsed": 0,
            "budget": limit,
            "budgetVersion": BUDGET_VERSION,
        }));
    }
    let (result, used) = prove_short_mate(&board, plies, limit);
    let (label, found_plies) = match result {
        ProofResult::Proven(found) => ("proven", Some(found)),
        ProofResult::NotMate => ("not-mate", None),
        ProofResult::BudgetExceeded => ("budget-exceeded", None),
    };
    Ok(json!({
        "result": label,
        "plies": found_plies,
        "nodesUsed": used,
        "budget": limit,
        "budgetVersion": BUDGET_VERSION,
    }))
}

fn parse_flag(args: &[String], flag: &str) -> Result<String, String> {
    let mut matches = args.windows(2).filter(|pair| pair[0] == flag);
    let value = matches
        .next()
        .ok_or_else(|| format!("missing required {flag}"))?[1]
        .clone();
    if matches.next().is_some() {
        return Err(format!("{flag} may only be specified once"));
    }
    Ok(value)
}

fn run(args: &[String]) -> Result<Value, String> {
    let command = args
        .first()
        .ok_or_else(|| "expected legal or mate-proof".to_string())?;
    let sfen = parse_flag(args, "--sfen")?;
    let allowed = match command.as_str() {
        "legal" | "pv-legal" => ["--sfen"].as_slice(),
        "mate-proof" => ["--sfen", "--plies", "--budget"].as_slice(),
        _ => return Err("expected legal or mate-proof".to_string()),
    };
    let (allowed, expected_arguments) = if command == "pv-legal" {
        (&["--sfen", "--moves"][..], 4)
    } else {
        (allowed, if command == "legal" { 2 } else { 6 })
    };
    if args[1..]
        .iter()
        .step_by(2)
        .any(|flag| !allowed.contains(&flag.as_str()))
        || args[1..].len() != expected_arguments
        || args[1..].len() % 2 != 0
    {
        return Err("unknown or malformed argument".to_string());
    }
    match command.as_str() {
        "legal" => legal_info(&sfen),
        "pv-legal" => validate_pv(&sfen, &parse_flag(args, "--moves")?),
        "mate-proof" => {
            let plies = parse_flag(args, "--plies")?
                .parse::<u8>()
                .map_err(|_| "plies must be 1 or 3".to_string())?;
            let budget = parse_flag(args, "--budget")?
                .parse::<u64>()
                .map_err(|_| "budget must be an integer".to_string())?;
            mate_proof(&sfen, plies, budget)
        }
        _ => unreachable!(),
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(result) => println!("{result}"),
        Err(error) => {
            eprintln!("helper-sekirei: {error}");
            process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeMap;

    const MATE_IN_ONE: &str = "4k4/9/4G4/9/9/9/9/9/K8 b G 1";
    const NON_MATE: &str = "4k4/9/9/9/9/9/9/5R3/4K4 b - 1";
    const IN_CHECK: &str = "4r3k/9/9/9/9/9/9/9/4K4 b - 1";

    #[test]
    fn fixture_legal_move_counts_match_verified_values() {
        let fixtures: Value = serde_json::from_str(include_str!("../../bench/fixtures.json"))
            .expect("benchmark fixtures JSON");
        let fixtures = fixtures.as_array().expect("fixture array");
        assert_eq!(fixtures.len(), 12);
        let expected: BTreeMap<&str, usize> = [
            // Values are verified with sekirei-core 7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac.
            ("initial-position", 30),
            ("quiet-no-mate", 46),
            ("sente-middlegame", 70),
            ("gote-middlegame", 31),
            ("middlegame-60", 32),
            ("middlegame-80", 38),
            ("hand-piece-rich", 63),
            ("middlegame-120", 55),
            ("middlegame-150", 126),
            ("mate-in-one", 108),
            ("single-legal-move", 1),
            ("sparse-endgame", 96),
        ]
        .into_iter()
        .collect();
        for fixture in fixtures {
            let id = fixture["id"].as_str().expect("fixture id");
            let sfen = fixture["sfen"].as_str().expect("fixture SFEN");
            let result = legal_info(sfen).expect("fixture SFEN should parse");
            assert_eq!(
                result["legalMoveCount"].as_u64().unwrap() as usize,
                expected[id],
                "{id}"
            );
            assert_eq!(
                result["legalMoves"].as_array().unwrap().len(),
                expected[id],
                "{id}"
            );
        }
    }

    #[test]
    fn finds_mate_in_one_and_reports_a_representative_line() {
        let result = mate_proof(MATE_IN_ONE, 1, 10_000).expect("proof query");
        assert_eq!(result["result"], "proven");
        assert_eq!(result["plies"], 1);
        assert!(result["nodesUsed"].as_u64().unwrap() <= 10_000);
    }

    #[test]
    fn finds_mate_in_three_only_after_all_legal_replies_are_covered() {
        let sfen = "4k4/6S2/1N1BB4/9/9/9/9/2L6/4K4 b LP 1";
        let result = mate_proof(sfen, 3, 10_000).expect("proof query");
        assert_eq!(result["result"], "proven");
        assert_eq!(result["plies"], 3);
    }

    #[test]
    fn non_mate_is_not_reported_as_a_proof() {
        let result = mate_proof(NON_MATE, 3, 10_000).expect("proof query");
        assert_eq!(result["result"], "not-mate");
        assert!(result["plies"].is_null());
    }

    #[test]
    fn zero_budget_is_a_distinct_budget_exceeded_result() {
        let result = mate_proof(MATE_IN_ONE, 3, 0).expect("proof query");
        assert_eq!(result["result"], "budget-exceeded");
        assert_eq!(result["budgetVersion"], BUDGET_VERSION);
        assert_eq!(result["nodesUsed"], 0);
    }

    #[test]
    fn mate_proof_rejects_a_side_already_in_check() {
        let result = mate_proof(IN_CHECK, 3, 10_000).expect("proof query");
        assert_eq!(result["result"], "in-check-invalid");
    }

    #[test]
    fn legal_generation_excludes_pawn_drop_mate() {
        let sfen = "3lkl3/3p1p3/4G4/9/9/9/9/9/K8 b P 1";
        let result = legal_info(sfen).expect("uchi-fu-zume fixture");
        assert!(
            !result["legalMoves"]
                .as_array()
                .unwrap()
                .iter()
                .any(|mv| mv == "P*5b")
        );
    }

    #[test]
    fn pv_replay_rejects_an_illegal_continuation() {
        assert_eq!(
            validate_pv(
                "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
                "7g7f 3c3d"
            )
            .unwrap()["legal"],
            true
        );
        assert_eq!(
            validate_pv(
                "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
                "7g7f 7g7f"
            )
            .unwrap()["legal"],
            false
        );
    }

    #[test]
    fn declaration_win_requires_zone_points_piece_count_and_no_check() {
        let eligible = checked_board("3K5/RBRBRBRBR/4G4/9/9/9/9/9/4k4 b 3P 1").unwrap();
        assert!(can_declare_win(&eligible));
        assert!(!is_in_check(&eligible, eligible.side_to_move));
    }

    #[test]
    fn cli_requires_budget_for_mate_proof() {
        let args = vec![
            "mate-proof".to_string(),
            "--sfen".to_string(),
            MATE_IN_ONE.to_string(),
            "--plies".to_string(),
            "1".to_string(),
        ];
        assert!(run(&args).is_err());
    }
}
