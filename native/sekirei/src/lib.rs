//! Stable C ABI used by the Android and iOS Expo adapters.
//!
//! The bridge deliberately owns the threading boundary. Sekirei itself uses
//! Rayon internally, while this crate serializes requests and exposes one
//! process-wide abort flag. JavaScript never receives a `Board`, `Move`, TT,
//! or Rust pointer; it receives a small JSON value that is safe to copy over
//! the native-module boundary.

use std::ffi::{CStr, CString, c_char};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use sekirei_core::board::Board;
use sekirei_core::color::Color;
use sekirei_core::movegen::{generate_legal_moves, is_in_check};
use sekirei_core::mv::Move;
use sekirei_core::nnue;
use sekirei_core::search::{MATE_SCORE, SearchConfig, SpeculativeSearcher};
use sekirei_core::sfen::move_to_usi;
use sekirei_core::tt::Tt;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const ENGINE_ID: &str = "sekirei-v0.3.36@aeb6ea30d58f93cad84ffe98bc13441feb807fa8";
pub const MODEL_ID: &str =
    "c-leaf-wrm-seed42@807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab";
const MODEL_SHA256: &str = "807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab";
const MODEL_MAGIC: &[u8; 8] = b"SEKIRW01";
const MODEL_SIZE: usize = 1_305_356;
const MAX_MULTI_PV: u32 = 3;
const MAX_NODES: u64 = 10_000_000;
const TT_SIZE_MB: usize = 16;
const MAX_PV_PLIES: usize = 64;
const MATE_THRESHOLD: i32 = MATE_SCORE - 1_000;

static SEARCH_MUTEX: Mutex<()> = Mutex::new(());
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static CANCELLED_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static ACTIVE_ABORT: OnceLock<Mutex<Option<ActiveSearch>>> = OnceLock::new();
static MODEL_STATE: OnceLock<Mutex<Option<ModelIdentity>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
struct ModelIdentity {
    path: PathBuf,
    sha256: String,
}

#[derive(Clone, Debug)]
struct ActiveSearch {
    request_id: u64,
    abort: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnalysis {
    status: &'static str,
    sfen: String,
    engine_id: &'static str,
    model_id: &'static str,
    nodes: u64,
    depth: u32,
    candidates: Vec<NativeCandidate>,
    terminal: Option<&'static str>,
    mate_proof: Option<MateProofOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCandidate {
    usi: String,
    pv: Vec<String>,
    score_cp: Option<i32>,
    mate: Option<i32>,
    depth: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MateProofOutput {
    status: &'static str,
    plies: Option<u8>,
    side: &'static str,
    pv: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProofStatus {
    Proven(u8),
    NotFound,
    Incomplete,
}

#[derive(Debug)]
struct ProofResult {
    status: ProofStatus,
    pv: Vec<Move>,
}

struct ProofBudget<'a> {
    limit: u64,
    used: u64,
    cancelled: &'a AtomicBool,
}

impl<'a> ProofBudget<'a> {
    fn new(limit: u64, cancelled: &'a AtomicBool) -> Self {
        Self {
            limit,
            used: 0,
            cancelled,
        }
    }

    fn tick(&mut self) -> Result<(), ()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(());
        }
        if self.used >= self.limit {
            return Err(());
        }
        self.used += 1;
        Ok(())
    }
}

fn active_abort() -> &'static Mutex<Option<ActiveSearch>> {
    ACTIVE_ABORT.get_or_init(|| Mutex::new(None))
}

fn model_state() -> &'static Mutex<Option<ModelIdentity>> {
    MODEL_STATE.get_or_init(|| Mutex::new(None))
}

fn set_active_abort(request_id: u64, flag: Option<Arc<AtomicBool>>) {
    if let Ok(mut active) = active_abort().lock() {
        *active = flag.map(|abort| ActiveSearch { request_id, abort });
    }
}

/// Allocate a monotonic request identity before enqueueing a native search.
pub fn prepare_request() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

fn request_was_cancelled(request_id: u64) -> bool {
    request_id != 0 && CANCELLED_REQUEST_ID.load(Ordering::Relaxed) == request_id
}

/// Request cancellation of one search, including a request that has not yet
/// registered its active abort flag after waiting for the serial mutex.
pub fn cancel(request_id: u64) {
    if request_id == 0 {
        return;
    }
    CANCELLED_REQUEST_ID.store(request_id, Ordering::Relaxed);
    if let Ok(active) = active_abort().lock()
        && let Some(search) = active.as_ref()
        && search.request_id == request_id
    {
        CANCEL_REQUESTED.store(true, Ordering::Relaxed);
        search.abort.store(true, Ordering::Relaxed);
    }
}

fn validate_model_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() != MODEL_SIZE {
        return Err(format!(
            "model size mismatch: expected {MODEL_SIZE}, got {}",
            bytes.len()
        ));
    }
    if bytes.get(..8) != Some(MODEL_MAGIC) {
        return Err("model magic mismatch: expected SEKIRW01".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    if digest != MODEL_SHA256 {
        return Err(format!(
            "model SHA-256 mismatch: expected {MODEL_SHA256}, got {digest}"
        ));
    }
    Ok(digest)
}

fn validate_model_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("cannot read model: {error}"))?;
    let digest = validate_model_bytes(&bytes)?;
    // read_weights checks the complete architecture and all floating-point
    // payloads before load_weights mutates Sekirei's process-global OnceLock.
    nnue::read_weights(path).map_err(|error| format!("model format is invalid: {error}"))?;
    Ok(digest)
}

fn validate_sfen_shape(sfen: &str) -> Result<(), String> {
    let fields: Vec<&str> = sfen.split_whitespace().collect();
    if fields.len() != 4 {
        return Err("invalid SFEN: expected board, side, hand, and move fields".to_string());
    }
    if fields[1] != "b" && fields[1] != "w" {
        return Err("invalid SFEN: side must be b or w".to_string());
    }

    let ranks: Vec<&str> = fields[0].split('/').collect();
    if ranks.len() != 9 {
        return Err("invalid SFEN: board must contain nine ranks".to_string());
    }

    let mut black_kings = 0;
    let mut white_kings = 0;
    for rank in ranks {
        let mut files = 0;
        let mut characters = rank.chars();
        while let Some(character) = characters.next() {
            match character {
                '1'..='9' => files += character.to_digit(10).unwrap() as usize,
                '+' => {
                    let promoted = characters
                        .next()
                        .ok_or_else(|| "invalid SFEN: promotion marker has no piece".to_string())?;
                    if !matches!(
                        promoted,
                        'P' | 'L' | 'N' | 'S' | 'B' | 'R' | 'p' | 'l' | 'n' | 's' | 'b' | 'r'
                    ) {
                        return Err("invalid SFEN: promoted piece is not valid".to_string());
                    }
                    files += 1;
                }
                'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R' => {
                    files += 1;
                }
                'p' | 'l' | 'n' | 's' | 'g' | 'b' | 'r' => {
                    files += 1;
                }
                'K' => {
                    black_kings += 1;
                    files += 1;
                }
                'k' => {
                    white_kings += 1;
                    files += 1;
                }
                _ => return Err("invalid SFEN: board contains an unknown piece".to_string()),
            }
        }
        if files != 9 {
            return Err("invalid SFEN: every rank must contain nine files".to_string());
        }
    }
    if black_kings != 1 || white_kings != 1 {
        return Err("invalid SFEN: board must contain exactly one king per side".to_string());
    }
    Ok(())
}

/// Load and validate the one model this app was built against.
pub fn initialize_model(path: &Path) -> Result<(), String> {
    let digest = validate_model_file(path)?;
    let mut state = model_state()
        .lock()
        .map_err(|_| "model lock poisoned".to_string())?;
    if let Some(existing) = state.as_ref() {
        if existing.sha256 == digest {
            return Ok(());
        }
        return Err("a different Sekirei model is already loaded in this process".to_string());
    }

    // The process-global loader is intentional. It prevents a background
    // position from changing evaluation weights while a foreground search is
    // still using them.
    nnue::load_weights(path).map_err(|error| format!("cannot activate model: {error}"))?;
    state.replace(ModelIdentity {
        path: path.to_path_buf(),
        sha256: digest,
    });
    Ok(())
}

fn ensure_model_loaded() -> Result<(), String> {
    let loaded = model_state()
        .lock()
        .map_err(|_| "model lock poisoned".to_string())?
        .is_some();
    if loaded {
        return Ok(());
    }
    Err("Sekirei model is not initialized".to_string())
}

fn normalize_score(score: i32, side_to_move: Color) -> i32 {
    if side_to_move == Color::Black {
        score
    } else {
        -score
    }
}

fn mate_distance(score: i32, side_to_move: Color) -> i32 {
    let black_score = normalize_score(score, side_to_move);
    let distance = (MATE_SCORE - black_score.abs()).max(1);
    if black_score >= 0 {
        distance
    } else {
        -distance
    }
}

fn legal_move(board: &mut Board, candidate: Move) -> bool {
    generate_legal_moves(board)
        .into_iter()
        .any(|m| m == candidate)
}

fn is_checkmate_after(
    board: &mut Board,
    move_to_play: Move,
    budget: &mut ProofBudget<'_>,
) -> Result<bool, ()> {
    budget.tick()?;
    if !legal_move(board, move_to_play) {
        return Ok(false);
    }
    let token = board.do_move(move_to_play);
    let checked = is_in_check(board, board.side_to_move);
    let replies = if checked {
        // `do_move` must always be paired with `undo_move`, including when
        // the proof budget expires while counting the checking side's legal
        // replies. Callers may continue trying sibling moves after this
        // result, so leaking the pushed position would corrupt the proof.
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

fn prove_short_mate(initial: &Board, budget_limit: u64, cancelled: &AtomicBool) -> ProofResult {
    let mut board = initial.clone();
    let mut budget = ProofBudget::new(budget_limit, cancelled);
    let first_moves = match budget
        .tick()
        .and_then(|_| Ok(generate_legal_moves(&mut board)))
    {
        Ok(moves) => moves,
        Err(()) => {
            return ProofResult {
                status: ProofStatus::Incomplete,
                pv: Vec::new(),
            };
        }
    };

    // First search for an immediate mate. This also ensures a position that is
    // mate in one is never reported as a weaker mate-in-three line.
    for first in first_moves.iter().copied() {
        match is_checkmate_after(&mut board, first, &mut budget) {
            Ok(true) => {
                return ProofResult {
                    status: ProofStatus::Proven(1),
                    pv: vec![first],
                };
            }
            Ok(false) => {}
            Err(()) => {
                return ProofResult {
                    status: ProofStatus::Incomplete,
                    pv: Vec::new(),
                };
            }
        }
    }

    // Product rule: the first move must give check, and every legal reply must
    // have at least one checking mate. The returned PV is representative; the
    // status is based on the exhaustive response check.
    for first in first_moves {
        if budget.tick().is_err() {
            return ProofResult {
                status: ProofStatus::Incomplete,
                pv: Vec::new(),
            };
        }
        let first_token = board.do_move(first);
        let checking = is_in_check(&board, board.side_to_move);
        if !checking {
            board.undo_move(first_token);
            continue;
        }
        let replies = match budget.tick().map(|_| generate_legal_moves(&mut board)) {
            Ok(moves) => moves,
            Err(()) => {
                board.undo_move(first_token);
                return ProofResult {
                    status: ProofStatus::Incomplete,
                    pv: Vec::new(),
                };
            }
        };
        if replies.is_empty() {
            board.undo_move(first_token);
            continue;
        }

        let mut representative = None;
        let mut forced = true;
        for reply in replies {
            if budget.tick().is_err() {
                board.undo_move(first_token);
                return ProofResult {
                    status: ProofStatus::Incomplete,
                    pv: Vec::new(),
                };
            }
            let reply_token = board.do_move(reply);
            let replies_to_find = generate_legal_moves(&mut board);
            let mut finisher = None;
            for candidate in replies_to_find {
                match is_checkmate_after(&mut board, candidate, &mut budget) {
                    Ok(true) => {
                        finisher = Some(candidate);
                        break;
                    }
                    Ok(false) => {}
                    Err(()) => {
                        board.undo_move(reply_token);
                        board.undo_move(first_token);
                        return ProofResult {
                            status: ProofStatus::Incomplete,
                            pv: Vec::new(),
                        };
                    }
                }
            }
            board.undo_move(reply_token);
            let Some(finisher) = finisher else {
                forced = false;
                break;
            };
            if representative.is_none() {
                representative = Some((reply, finisher));
            }
        }
        board.undo_move(first_token);
        if forced && let Some((reply, finisher)) = representative {
            return ProofResult {
                status: ProofStatus::Proven(3),
                pv: vec![first, reply, finisher],
            };
        }
    }

    ProofResult {
        status: ProofStatus::NotFound,
        pv: Vec::new(),
    }
}

fn extract_pv(searcher: &SpeculativeSearcher, initial: &Board, first: Move) -> Vec<String> {
    let mut board = initial.clone();
    let mut result = Vec::with_capacity(MAX_PV_PLIES);
    let mut next = Some(first);
    for _ in 0..MAX_PV_PLIES {
        let Some(candidate) = next else { break };
        if !legal_move(&mut board, candidate) {
            break;
        }
        result.push(move_to_usi(candidate));
        board.do_move(candidate);
        next = searcher.probe_tt(board.hash());
    }
    result
}

fn proof_output(result: ProofResult, side: Color) -> MateProofOutput {
    let (status, plies) = match result.status {
        ProofStatus::Proven(plies) => ("proven", Some(plies)),
        ProofStatus::NotFound => ("not-found", None),
        ProofStatus::Incomplete => ("incomplete", None),
    };
    let pv = result.pv.into_iter().map(move_to_usi).collect();
    MateProofOutput {
        status,
        plies,
        side: if side == Color::Black {
            "black"
        } else {
            "white"
        },
        pv,
    }
}

fn analyze_position(
    sfen: &str,
    nodes: u64,
    multi_pv: u32,
    request_id: u64,
) -> Result<NativeAnalysis, String> {
    if request_id == 0 {
        return Err("request id must be non-zero".to_string());
    }
    ensure_model_loaded()?;
    if request_was_cancelled(request_id) {
        return Err("analysis cancelled".to_string());
    }
    if nodes == 0 || nodes > MAX_NODES {
        return Err(format!("nodes must be between 1 and {MAX_NODES}"));
    }
    if !(1..=MAX_MULTI_PV).contains(&multi_pv) {
        return Err(format!("multiPV must be between 1 and {MAX_MULTI_PV}"));
    }
    validate_sfen_shape(sfen)?;
    let initial = Board::from_sfen(sfen).map_err(|error| format!("invalid SFEN: {error}"))?;
    let _serial = SEARCH_MUTEX
        .lock()
        .map_err(|_| "search lock poisoned".to_string())?;
    if request_was_cancelled(request_id) {
        return Err("analysis cancelled".to_string());
    }
    // A cancel request only applies to an active request. Reset it after
    // taking the serial lock so a cancelled request cannot poison the next
    // position queued by the app.
    CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    // The app intentionally runs one Rayon worker and disables speculative
    // prefetch (top_n=0). It keeps memory and scheduling deterministic on both
    // mobile platforms while retaining the core's MultiPV implementation.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build_global();
    let searcher = SpeculativeSearcher::new(Tt::new(TT_SIZE_MB), 0);
    searcher.reset_abort_flag();
    let abort = searcher.abort_flag();
    set_active_abort(request_id, Some(abort.clone()));
    // Cancellation may arrive after the mutex check but before this request
    // publishes its active abort flag. Re-check the request identity after
    // registration so it cannot run to the node limit in that window.
    if request_was_cancelled(request_id) {
        set_active_abort(request_id, None);
        CANCEL_REQUESTED.store(false, Ordering::Relaxed);
        return Err("analysis cancelled".to_string());
    }

    let mut board = initial.clone();
    let info = searcher.search(
        &mut board,
        SearchConfig {
            max_depth: 64,
            time_limit: None,
            node_limit: Some(nodes),
            soft_limit: None,
            multi_pv,
        },
    );
    let cancelled = abort.load(Ordering::Relaxed)
        || request_was_cancelled(request_id)
        || CANCEL_REQUESTED.load(Ordering::Relaxed);
    if cancelled {
        set_active_abort(request_id, None);
        CANCEL_REQUESTED.store(false, Ordering::Relaxed);
        return Err("analysis cancelled".to_string());
    }

    let mut candidates = Vec::with_capacity(info.pv_list.len());
    let lines = if info.pv_list.is_empty() {
        info.best_move
            .map(|mv| vec![(mv, info.score)])
            .unwrap_or_default()
    } else {
        info.pv_list.clone()
    };
    for (mv, score) in lines {
        let score_cp = if score.abs() >= MATE_THRESHOLD {
            None
        } else {
            Some(normalize_score(score, initial.side_to_move))
        };
        let mate =
            (score.abs() >= MATE_THRESHOLD).then(|| mate_distance(score, initial.side_to_move));
        candidates.push(NativeCandidate {
            usi: move_to_usi(mv),
            pv: extract_pv(&searcher, &initial, mv),
            score_cp,
            mate,
            depth: info.depth,
        });
    }

    let mate_proof = if !candidates.is_empty() {
        let proof = prove_short_mate(&initial, nodes, &CANCEL_REQUESTED);
        // A user cancellation that arrives while the proof is running must
        // invalidate the entire position result. An `incomplete` proof caused
        // only by the ordinary node budget remains a valid analysis result;
        // the caller can distinguish that state from this explicit error.
        if request_was_cancelled(request_id) || CANCEL_REQUESTED.load(Ordering::Relaxed) {
            set_active_abort(request_id, None);
            CANCEL_REQUESTED.store(false, Ordering::Relaxed);
            return Err("analysis cancelled".to_string());
        }
        Some(proof_output(proof, initial.side_to_move))
    } else {
        None
    };
    let terminal = if candidates.is_empty() {
        let mut terminal_board = initial.clone();
        let no_legal_moves = generate_legal_moves(&mut terminal_board).is_empty();
        if no_legal_moves {
            let side_to_move = terminal_board.side_to_move;
            Some(if is_in_check(&mut terminal_board, side_to_move) {
                "checkmate"
            } else {
                "no-legal-moves"
            })
        } else {
            None
        }
    } else {
        None
    };
    // The proof path above checks cancellation while it runs, but terminal
    // positions do not need a proof. Check once more before publishing any
    // result so a request arriving during PV/terminal assembly is never saved.
    if request_was_cancelled(request_id) || CANCEL_REQUESTED.load(Ordering::Relaxed) {
        set_active_abort(request_id, None);
        CANCEL_REQUESTED.store(false, Ordering::Relaxed);
        return Err("analysis cancelled".to_string());
    }
    set_active_abort(request_id, None);
    let output = NativeAnalysis {
        status: "complete",
        sfen: sfen.to_string(),
        engine_id: ENGINE_ID,
        model_id: MODEL_ID,
        nodes: info.nodes,
        depth: info.depth,
        candidates,
        terminal,
        mate_proof,
    };
    CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    Ok(output)
}

fn error_json(message: impl Into<String>) -> *mut c_char {
    let value = serde_json::json!({ "error": message.into() });
    CString::new(value.to_string())
        .unwrap_or_else(|_| CString::new("{\"error\":\"native error\"}").unwrap())
        .into_raw()
}

fn c_string(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("null C string".to_string());
    }
    // SAFETY: callers of this C ABI must provide a valid NUL-terminated UTF-8
    // string for the duration of the call.
    let value = unsafe { CStr::from_ptr(ptr) };
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "C string is not UTF-8".to_string())
}

#[cfg(test)]
fn default_model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/model/c-leaf-wrm-seed42.bin")
}

/// Initialize from an absolute path to the bundled model.
pub fn initialize_model_path(path: &str) -> Result<(), String> {
    initialize_model(Path::new(path))
}

/// C ABI initializer. Returns 0 on success and a negative error code on failure.
#[unsafe(no_mangle)]
pub extern "C" fn meeshogi_sekirei_init(model_path: *const c_char) -> i32 {
    match c_string(model_path).and_then(|path| initialize_model_path(&path)) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/// Allocate a request identity before dispatching an asynchronous search.
#[unsafe(no_mangle)]
pub extern "C" fn meeshogi_sekirei_prepare_request() -> u64 {
    prepare_request()
}

/// Analyze one SFEN position. The returned string is owned by Rust and must be
/// released with `meeshogi_sekirei_free_string`.
#[unsafe(no_mangle)]
pub extern "C" fn meeshogi_sekirei_analyze(
    sfen: *const c_char,
    nodes: u64,
    multi_pv: u32,
    request_id: u64,
) -> *mut c_char {
    let result = c_string(sfen).and_then(|sfen| {
        analyze_position(&sfen, nodes, multi_pv, request_id).and_then(|analysis| {
            serde_json::to_string(&analysis).map_err(|error| error.to_string())
        })
    });
    match result {
        Ok(json) => CString::new(json)
            .map(CString::into_raw)
            .unwrap_or_else(|_| error_json("JSON contains NUL")),
        Err(error) => error_json(error),
    }
}

/// Request cancellation of one analysis, even if it is waiting to register as active.
#[unsafe(no_mangle)]
pub extern "C" fn meeshogi_sekirei_cancel(request_id: u64) {
    cancel(request_id);
}

/// Free a string returned by this crate.
#[unsafe(no_mangle)]
pub extern "C" fn meeshogi_sekirei_free_string(value: *mut c_char) {
    if value.is_null() {
        return;
    }
    // SAFETY: pointer must originate from CString::into_raw in this crate.
    unsafe {
        drop(CString::from_raw(value));
    }
}

#[cfg(target_os = "android")]
mod android_jni {
    use super::*;
    use jni::JNIEnv;
    use jni::objects::{JClass, JString};
    use jni::sys::{jint, jlong, jstring};
    use std::ptr;

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_sekirei_SekireiModule_nativeInit(
        mut env: JNIEnv,
        _class: JClass,
        path: JString,
    ) -> jint {
        match env.get_string(&path) {
            Ok(value) => match initialize_model_path(value.to_str().unwrap_or_default()) {
                Ok(()) => 0,
                Err(_) => -1,
            },
            Err(_) => -2,
        }
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_sekirei_SekireiModule_nativePrepareRequest(
        _env: JNIEnv,
        _class: JClass,
    ) -> jlong {
        prepare_request() as jlong
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_sekirei_SekireiModule_nativeAnalyze(
        mut env: JNIEnv,
        _class: JClass,
        sfen: JString,
        nodes: jlong,
        multi_pv: jint,
        request_id: jlong,
    ) -> jstring {
        let Ok(sfen) = env.get_string(&sfen) else {
            return ptr::null_mut();
        };
        let result = c_string_to_jstring(
            &mut env,
            &sfen.to_string_lossy(),
            nodes.max(0) as u64,
            multi_pv.max(0) as u32,
            request_id.max(0) as u64,
        );
        result.unwrap_or(ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_sekirei_SekireiModule_nativeCancel(
        _env: JNIEnv,
        _class: JClass,
        request_id: jlong,
    ) {
        cancel(request_id.max(0) as u64);
    }

    fn c_string_to_jstring(
        env: &mut JNIEnv,
        sfen: &str,
        nodes: u64,
        multi_pv: u32,
        request_id: u64,
    ) -> jni::errors::Result<jstring> {
        let result = analyze_position(sfen, nodes, multi_pv, request_id)
            .and_then(|analysis| {
                serde_json::to_string(&analysis).map_err(|error| error.to_string())
            })
            .unwrap_or_else(|error| serde_json::json!({ "error": error }).to_string());
        env.new_string(result).map(|value| value.into_raw())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as TestMutex;
    use std::thread;
    use std::time::Duration;

    static ANALYSIS_TEST_MUTEX: TestMutex<()> = TestMutex::new(());

    fn model_path() -> PathBuf {
        default_model_path()
    }

    #[test]
    fn model_manifest_is_exact_when_present() {
        let path = model_path();
        if !path.exists() {
            return;
        }
        let digest = validate_model_file(&path).expect("the bundled model must be valid");
        assert_eq!(digest, MODEL_SHA256);
    }

    #[test]
    fn score_normalization_flips_only_white_to_move() {
        assert_eq!(normalize_score(123, Color::Black), 123);
        assert_eq!(normalize_score(123, Color::White), -123);
    }

    #[test]
    fn proof_budget_reports_incomplete_before_searching() {
        let board = Board::startpos();
        let result = prove_short_mate(&board, 0, &AtomicBool::new(false));
        assert_eq!(result.status, ProofStatus::Incomplete);
    }

    #[test]
    fn proof_budget_expiry_after_checking_move_restores_board() {
        let mut board = Board::from_sfen("4k4/9/9/9/9/9/9/4R4/K8 b - 1").expect("test SFEN");
        let candidate = generate_legal_moves(&mut board)
            .into_iter()
            .find(|candidate| {
                let token = board.do_move(*candidate);
                let side_to_move = board.side_to_move;
                let gives_check = is_in_check(&mut board, side_to_move);
                board.undo_move(token);
                gives_check
            })
            .expect("position has a checking move");
        let before = board.hash();
        let cancelled = AtomicBool::new(false);
        let mut budget = ProofBudget::new(1, &cancelled);
        assert_eq!(
            is_checkmate_after(&mut board, candidate, &mut budget),
            Err(())
        );
        assert_eq!(board.hash(), before, "budget failure must undo the move");
    }

    #[test]
    fn sfen_shape_rejects_extra_files_and_missing_king() {
        let _guard = ANALYSIS_TEST_MUTEX.lock().expect("analysis test lock");
        initialize_model(&model_path()).expect("load local model");
        for sfen in ["4k5/9/9/9/9/9/9/9/4K4 b - 1", "4k4/9/9/9/9/9/9/9/9 b - 1"] {
            let result = analyze_position(sfen, 1, 1, prepare_request());
            assert!(matches!(result, Err(error) if error.starts_with("invalid SFEN:")));
        }
    }

    #[test]
    fn proof_finds_one_ply_mate() {
        let board = Board::from_sfen("4k4/9/4G4/9/9/9/9/9/K8 b G 1").expect("one-ply mate SFEN");
        assert!(!is_in_check(&mut board.clone(), Color::White));
        let result = prove_short_mate(&board, 10_000, &AtomicBool::new(false));
        assert_eq!(result.status, ProofStatus::Proven(1));
        assert_eq!(result.pv.len(), 1);
    }

    #[test]
    fn proof_finds_three_ply_mate_across_all_replies() {
        let board =
            Board::from_sfen("4k4/6S2/1N1BB4/9/9/9/9/2L6/4K4 b LP 1").expect("three-ply mate SFEN");
        assert!(!is_in_check(&mut board.clone(), Color::White));
        let result = prove_short_mate(&board, 10_000, &AtomicBool::new(false));
        assert_eq!(result.status, ProofStatus::Proven(3));
        assert_eq!(result.pv.len(), 3);
    }

    #[test]
    fn proof_rejects_a_check_with_a_legal_escape() {
        let board = Board::from_sfen("4k4/9/9/9/9/9/9/5R3/4K4 b - 1").expect("escape SFEN");
        assert!(!is_in_check(&mut board.clone(), Color::White));
        let result = prove_short_mate(&board, 10_000, &AtomicBool::new(false));
        assert_eq!(result.status, ProofStatus::NotFound);
    }

    #[test]
    fn proof_respects_a_side_already_in_check() {
        let board = Board::from_sfen("4r3k/9/9/9/9/9/9/9/4K4 b - 1").expect("in-check SFEN");
        assert!(is_in_check(&mut board.clone(), Color::Black));
        let result = prove_short_mate(&board, 10_000, &AtomicBool::new(false));
        assert_eq!(result.status, ProofStatus::NotFound);
    }

    #[test]
    fn legal_moves_reject_pawn_drop_mate() {
        let mut board =
            Board::from_sfen("3lkl3/3p1p3/4G4/9/9/9/9/9/K8 b P 1").expect("pawn-drop mate SFEN");
        assert!(!is_in_check(&mut board.clone(), Color::White));
        let legal = generate_legal_moves(&mut board);
        assert!(
            !legal
                .iter()
                .copied()
                .map(move_to_usi)
                .any(|usi| usi == "P*5b")
        );
    }

    #[test]
    fn cancellation_is_honored_before_active_registration() {
        let _guard = ANALYSIS_TEST_MUTEX.lock().expect("analysis test lock");
        initialize_model(&model_path()).expect("load local model");
        let request_id = prepare_request();
        cancel(request_id);
        let result = analyze_position(
            "lnsgkgsnl/1r5b1/p1ppppp1p/9/9/9/P1PPPPPP1/1B5R1/LNSGKGSNL b - 1",
            256,
            1,
            request_id,
        );
        assert!(matches!(result, Err(error) if error == "analysis cancelled"));
    }

    #[test]
    fn cancellation_stops_an_active_model_search() {
        let _guard = ANALYSIS_TEST_MUTEX.lock().expect("analysis test lock");
        initialize_model(&model_path()).expect("load local model");
        let request_id = prepare_request();
        let search = thread::spawn(move || {
            analyze_position(
                "lnsgkgsnl/1r5b1/p1ppppp1p/9/9/9/P1PPPPPP1/1B5R1/LNSGKGSNL b - 1",
                MAX_NODES,
                3,
                request_id,
            )
        });
        let mut registered = false;
        for _ in 0..1_000 {
            if active_abort()
                .lock()
                .expect("active search lock")
                .as_ref()
                .is_some_and(|active| active.request_id == request_id)
            {
                registered = true;
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert!(registered, "search did not register its active request");
        cancel(request_id);
        let result = search.join().expect("search thread");
        assert!(matches!(result, Err(error) if error == "analysis cancelled"));
    }

    #[test]
    fn model_search_returns_black_perspective_candidates() {
        let _guard = ANALYSIS_TEST_MUTEX.lock().expect("analysis test lock");
        initialize_model(&model_path()).expect("load local model");
        let request_id = prepare_request();
        let result = analyze_position(
            "lnsgkgsnl/1r5b1/p1ppppp1p/9/9/9/P1PPPPPP1/1B5R1/LNSGKGSNL b - 1",
            256,
            2,
            request_id,
        )
        .expect("search start position");
        assert_eq!(result.engine_id, ENGINE_ID);
        assert_eq!(result.model_id, MODEL_ID);
        assert!(!result.candidates.is_empty());
        assert!(
            result
                .candidates
                .iter()
                .all(|candidate| !candidate.usi.is_empty())
        );
    }
}
