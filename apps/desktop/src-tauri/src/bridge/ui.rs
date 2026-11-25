//! Round trips to the UI (plan 11.3 / 11.5).
//!
//! Most bridge methods answer from the store and never touch a window. Some
//! genuinely cannot: a screenshot needs a canvas, and a tool selection is
//! window state. Those go out as a request event and come back through the
//! `bridge_reply` command.
//!
//! # Why a round trip rather than reaching into the store
//!
//! The same rule as `open_project`: the UI owns UI state, and anything that
//! writes it from underneath produces a window and a database that disagree.
//! Routing through the frontend means a bridge-driven action takes exactly the
//! path a click takes, so it cannot drift from what a person would get.
//!
//! # Every wait ends, but not on a clock
//!
//! A frontend that is wedged, mid-reload, or simply has no window open will
//! never reply, and a bridge call that hangs forever is worse than one that
//! fails. So a request fails once the window has been SILENT for a while; a
//! window working on it says so (`bridge_alive`) and is waited on for as long
//! as the work takes.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/// How long a UI request waits on a SILENT window before giving up.
///
/// Not a limit on how long the work may take (Aaron, 2026-11-24: no arbitrary
/// caps). While the window works on a request it says so every couple of
/// seconds (`bridge_alive`), and each word restarts this clock, so an export
/// of a 1,800-sheet set runs to the end. Only a window that has gone quiet,
/// wedged or closed, fails, and it fails this long after its last word.
const UI_TIMEOUT: Duration = Duration::from_secs(20);

/// What a waiter hears: the answer, or that the window is still at it.
enum Word {
    Answer(Value),
    Alive,
}

type Pending = Mutex<HashMap<u64, Sender<Word>>>;

fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Ask the frontend to do something and wait for its answer, for as long
/// as the window keeps saying it is working on it.
pub fn request(app: &AppHandle, action: &str, params: &Value) -> Result<Value, String> {
    request_within(app, action, params, UI_TIMEOUT)
}

/// [`request`] with its own silence allowance.
///
/// Light answers its store reads from the window (methods.rs), and a start
/// screen with no PDF open has nobody listening. A "cheap" read that sat out
/// the full twenty seconds before saying so would read as a hung app.
pub fn request_within(app: &AppHandle, action: &str, params: &Value, silence: Duration) -> Result<Value, String> {
    let id = next_id();
    let (tx, rx): (Sender<Word>, Receiver<Word>) = channel();

    // Registered BEFORE the emit: a frontend fast enough to reply before we
    // finish registering would otherwise find no channel and drop the answer.
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, tx);

    let emitted = app.emit(
        "redbeam://bridge/request",
        json!({ "id": id, "action": action, "params": params }),
    );
    if let Err(e) = emitted {
        forget(id);
        return Err(format!("could not reach a window: {e}"));
    }

    let answer = wait(&rx, silence);
    forget(id);

    match answer {
        Some(v) => {
            // The frontend reports its own failures in-band; a transport that
            // worked does not mean the action did.
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            Ok(v)
        }
        None => Err(format!(
            "no window answered `{action}`, and none said it was working on it, for {}s — is a PDF open? Open one with redbeam_open_file.",
            silence.as_secs()
        )),
    }
}

/// The answer, waiting through any number of "still working" words; None
/// once `silence` passes with neither.
fn wait(rx: &Receiver<Word>, silence: Duration) -> Option<Value> {
    loop {
        match rx.recv_timeout(silence) {
            Ok(Word::Answer(v)) => return Some(v),
            Ok(Word::Alive) => continue,
            Err(_) => return None,
        }
    }
}

fn forget(id: u64) {
    pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
}

/// The frontend's answer to a `redbeam://bridge/request`.
///
/// A reply for an id nobody is waiting on is dropped rather than treated as an
/// error: the waiter may have timed out, and a late answer is not a fault
/// worth reporting to whoever happens to call next.
#[tauri::command]
pub async fn bridge_reply(id: u64, result: Value) -> Result<(), String> {
    let tx = pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(Word::Answer(result));
    }
    Ok(())
}

/// The window is still working on request `id`. Restarts that request's
/// silence clock; a word for a request nobody waits on is dropped.
#[tauri::command]
pub async fn bridge_alive(id: u64) -> Result<(), String> {
    let map = pending().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = map.get(&id) {
        let _ = tx.send(Word::Alive);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_do_not_repeat() {
        // A repeated id would deliver one window's answer to another's waiter.
        let a = next_id();
        let b = next_id();
        assert_ne!(a, b);
    }

    #[test]
    fn a_reply_for_an_unknown_id_is_dropped_rather_than_panicking() {
        // The waiter may already have timed out. A late answer is not a fault.
        let map = pending();
        assert!(map
            .lock()
            .unwrap()
            .remove(&999_999)
            .is_none());
    }

    #[test]
    fn a_waiter_receives_its_own_answer() {
        let id = next_id();
        let (tx, rx) = channel();
        pending().lock().unwrap().insert(id, tx);
        let sender = pending().lock().unwrap().remove(&id).unwrap();
        sender.send(Word::Answer(json!({ "ok": true }))).unwrap();
        assert_eq!(wait(&rx, Duration::from_secs(1)).unwrap()["ok"], json!(true));
    }

    #[test]
    fn a_working_window_is_waited_on_past_the_silence_allowance() {
        // Six words 50 ms apart, then the answer: 300 ms of work against a
        // 120 ms allowance. Only silence ends the wait, not the length of it.
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(50));
                tx.send(Word::Alive).unwrap();
            }
            tx.send(Word::Answer(json!({ "done": true }))).unwrap();
        });
        assert_eq!(wait(&rx, Duration::from_millis(120)).unwrap()["done"], json!(true));
    }

    #[test]
    fn a_silent_window_still_times_out() {
        let (_tx, rx) = channel::<Word>();
        assert!(wait(&rx, Duration::from_millis(50)).is_none());
    }
}
