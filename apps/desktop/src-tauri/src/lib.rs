mod accent;
mod ai_apps;
mod backdrop;
mod bridge;
mod crash;
mod docstream;
pub mod mcp;
mod open_with;
mod project;
mod store;
mod undo;
mod window;

pub use store::StoreState;
pub use undo::UndoState;
pub use window::{close_window, open_context_window, open_project_window};

/// Start every window minimized.
///
/// Set `REDBEAM_START_MINIMIZED=1` for automated runs. An agent driving the app
/// for verification should not steal focus or cover what someone is working on,
/// and a window that keeps raising itself makes the machine unusable while a
/// long test runs. Off by default, so a real launch behaves normally.
fn start_minimized() -> bool {
    std::env::var("REDBEAM_START_MINIMIZED")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "no")
        })
        .unwrap_or(false)
}

/// Is the automation bridge switched on?
///
/// Off by default. The bridge exposes the open project over a local socket, so
/// it is something you turn on to drive the app, not something every launch
/// carries.
fn bridge_enabled() -> bool {
    // Switched on in Settings > Claude and ChatGPT, remembered on disk.
    if ai_apps::enabled_on_disk() {
        return true;
    }
    std::env::var("REDBEAM_BRIDGE")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "no")
        })
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A PDF double-clicked in Explorer, or chosen in Open with, arrives as
    // the first argument (open_with.rs).
    let launched_with = std::env::current_dir()
        .ok()
        .and_then(|cwd| open_with::pdf_from_args(std::env::args(), &cwd));
    tauri::Builder::default()
        // FIRST, as the plugin requires: a second REDBEAM.exe hands its
        // arguments to this process and exits, so opening a PDF while the
        // app is running opens it here instead of starting a second copy
        // with its own windows and its own connections.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            open_with::on_second_launch(app, argv, cwd);
        }))
        .manage(open_with::LaunchState::new(launched_with))
        // One SQLite connection for the whole process. Windows are views over
        // it — a per-window connection would reintroduce exactly the divergence
        // this design exists to prevent.
        .plugin(tauri_plugin_dialog::init())
        // Updates (plan TH.7). An installed copy has no other way to change:
        // the alternative is emailing a 95MB installer and asking an estimator
        // to run it, which is a thing that happens once and then stops
        // happening while the fixes pile up.
        //
        // `process` is here because it is what an update is FOR — the updater
        // stages the new binary and the app has to restart into it. Without a
        // relaunch the user is told an update installed and keeps running the
        // old one until they notice.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(store::StoreState::new())
        // The undo stack belongs to the project, not to a window (D1). It lives
        // here for the same reason the connection does: several windows share it.
        .manage(undo::UndoState::new())
        // Drawings are read a byte range at a time (docstream.rs), so a 500 MB
        // set opens without the whole file crossing into the window.
        .manage(docstream::DocStreams::default())
        .register_asynchronous_uri_scheme_protocol(docstream::SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                use tauri::Manager;
                let streams = app.state::<docstream::DocStreams>();
                responder.respond(docstream::respond(&streams, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            // `#[tauri::command]` emits a helper macro beside each function, so
            // these must be pathed to the defining module, not a re-export.
            store::commands::db_open,
            store::commands::db_exec,
            store::commands::db_all,
            store::commands::db_run,
            store::commands::db_batch,
            store::commands::db_close,
            undo::commands::undo_record,
            undo::commands::undo_apply,
            undo::commands::undo_redo,
            undo::commands::undo_state,
            undo::commands::undo_clear,
            project::project_pick_folder,
            project::project_pick_drawing,
            project::project_pick_file,
            project::project_locate_file,
            project::project_nesting,
            project::project_open,
            project::project_recents,
            project::project_forget_recent,
            project::project_clear_recents,
            project::project_rename_recent,
            project::project_remove_data,
            project::project_old_data,
            project::project_supersede_data,
            project::project_reveal,
            project::project_scan,
            project::project_read_document,
            docstream::project_stream_document,
            docstream::project_stream_release,
            docstream::project_stream_fingerprint,
            docstream::project_stream_copy,
            project::project_write_document,
            project::project_create_document,
            project::write_export_file,
            project::project_append_document,
            project::project_save_file,
            window::open_project_window,
            window::open_context_window,
            window::close_window,
            bridge::ui::bridge_reply,
            crash::crash_report,
            crash::crash_reports,
            crash::crash_dir,
            backdrop::backdrop_active,
            accent::system_accent,
            open_with::launch_take_file,
            open_with::launch_showing,
            open_with::launch_open,
            open_with::pdf_handler_status,
            open_with::pdf_handler_choose,
            open_with::open_web_link,
            ai_apps::ai_apps_status,
            ai_apps::ai_apps_set_enabled,
            ai_apps::ai_apps_install,
            ai_apps::ai_apps_remove,
        ])
        .setup(|app| {
            /*
             * FIRST, before anything else here can fail.
             *
             * There is exactly one `setup` on this builder on purpose: Tauri
             * keeps the last closure passed and silently discards any earlier
             * one, so a second `.setup(...)` added for a new concern would
             * disable this one without a compile error.
             */
            crash::init(&app.handle().clone());

            /*
             * The first window is built here rather than by tauri.conf.json
             * (`"create": false` there), because how it opens depends on who
             * started the app. A person starting REDBEAM gets its window in
             * front, as ever. An AI app's server starting it (mcp.rs passes
             * `--from-ai-app`) gets it shown without being activated: the
             * person is working in something else, and Aaron's rule is that
             * "agent actions should NEVER steal focus, from other apps or even
             * within the app" (2026-11-24). It is on the taskbar and behind
             * what they are doing, there to look at when they choose.
             */
            {
                let quiet = std::env::args().any(|a| a == open_with::FROM_AI_APP);
                if let Some(config) = app.config().app.windows.first().cloned() {
                    let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
                    let builder = if quiet { builder.focused(false) } else { builder };
                    builder.build()?;
                }
            }

            // Before the window is shown, so it never paints once opaque
            // and then again with the backdrop behind it.
            backdrop::apply(&app.handle().clone());

            if start_minimized() {
                use tauri::Manager;
                for (_, window) in app.webview_windows() {
                    // Minimize rather than hide: a hidden window is invisible in
                    // the taskbar too, which makes an automated run look like a
                    // crashed one.
                    let _ = window.minimize();
                }
            }
            // The automation bridge is opt-in. It is a local socket that can
            // read the open project, so it should exist when an agent is
            // driving the app and not otherwise. REDBEAM_BRIDGE=1 turns it on;
            // a driven run sets it alongside REDBEAM_START_MINIMIZED.
            if bridge_enabled() {
                match bridge::start(app.handle().clone()) {
                    Ok(info) => eprintln!(
                        "redbeam bridge on 127.0.0.1:{} (discovery: {})",
                        info.port,
                        bridge::discovery_path().display()
                    ),
                    // Never fatal: an estimator with a takeoff open does not
                    // care that a debug socket could not bind.
                    Err(e) => eprintln!("redbeam bridge did not start: {e}"),
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building REDBEAM")
        .run(|app, event| {
            // Tauri exits the process without dropping managed state, so the
            // project connections are closed here or never: an unclosed
            // connection leaves the newest writes in redbeam.db-wal.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                // So an AI app finds no stale port and starts REDBEAM afresh.
                bridge::stop();
                app.state::<store::StoreState>().close_all();
            }
        });
}
