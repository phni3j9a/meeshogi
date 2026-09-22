//! Test-only static-evaluation probe.
//!
//! This example is a diagnostic target, not an app target. It exposes the
//! integer material value, raw NNUE output, residual-material combination, and
//! sente-perspective value used by `scripts/engine/static-eval-cross-check.sh`.

use std::path::Path;

use sekirei_core::board::Board;
use sekirei_core::color::Color;
use sekirei_core::eval::{self, NnueOutputMode};
use sekirei_core::nnue;

const CASES: [(&str, &str); 4] = [
    (
        "startpos",
        "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    ),
    ("single-reply", "4k+S3/9/1N1BB4/9/9/9/9/2L6/4K4 w LP 2"),
    ("sequence-start", "4k4/6S2/1N1BB4/9/9/9/9/2L6/4K4 b LP 1"),
    (
        "sequence-after-reply",
        "3k1+S3/9/1N1BB4/9/9/9/9/2L6/4K4 b LP 3",
    ),
];

fn main() {
    let model_path = std::env::args()
        .nth(1)
        .expect("usage: static_eval_probe <model-path>");
    let model = Path::new(&model_path);

    // Match the bridge initialization order and the product evaluation mode.
    eval::set_nnue_output_mode(NnueOutputMode::ResidualMaterial);
    let weights = nnue::read_weights(model).expect("model must be readable");
    nnue::load_weights(model).expect("model must load");

    for (name, sfen) in CASES {
        let board = Board::from_sfen(sfen).expect("probe SFEN must parse");
        let material = eval::material_score(&board);
        let raw_nnue = eval::evaluate_with_weights(&board, &weights);
        let combined =
            eval::evaluate_with_weights_mode(&board, &weights, NnueOutputMode::ResidualMaterial);
        let sente = if board.side_to_move == Color::Black {
            combined
        } else {
            -combined
        };
        println!("{name}\t{material}\t{raw_nnue}\t{combined}\t{sente}");
    }
}
